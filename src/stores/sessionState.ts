import { computed, ref } from "vue"
import type { ServerClient } from "@/api/client"
import type { FormInfo, PermissionRequest, ServerEvent } from "@/api/types"
import { useProjects } from "./projects"
import { useServer } from "./server"
import { useSessions } from "./sessions"
import {
  QUESTION_REASON,
  conversationState,
  countsAsUnread,
  rollupProjects,
  rollupTray,
  stateLabel,
  type ConversationState,
  type ProjectRollup,
} from "@/utils/sessionState"

/**
 * Live state for every conversation in every project.
 *
 * The v2 global event stream carries the events of all projects, tagged with
 * their location, so a single subscription keeps the sidebar dots and the tray
 * rollup current. The stream only reports changes, so a bounded poll re-reads
 * the global permission/form lists to repair anything missed while offline.
 */

const UNREAD_KEY = "opencode-projects-studio.unread-sessions"

/** How often the sweep reconciles the directories holding a blocked conversation. */
const SWEEP_MS = 2000

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

interface SessionSignals {
  status?: string
  /** Pending request that needs the user, with a short reason. */
  blockedReason?: string
  /**
   * Directory of the pending request, so the sweep can re-read that project's
   * list. The pending lists are per-location, so without this the sweep cannot
   * tell a missing entry from one it never asked for.
   */
  blockedDirectory?: string
}

const signals = ref<Record<string, SessionSignals>>({})
const unread = ref<Set<string>>(loadUnread())
const globalLive = ref(false)

/** Request id → session id, so a reply can clear the right conversation. */
const requestSession = new Map<string, string>()

let sweepTimer: ReturnType<typeof setInterval> | null = null
let detachAttention: (() => void) | null = null
let controller: AbortController | null = null
let activeClient: ServerClient | null = null

function loadUnread(): Set<string> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    return new Set()
  }
}

function persistUnread() {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...unread.value]))
  } catch {
    /* storage unavailable */
  }
}

export function useSessionState() {
  const server = useServer()
  const sessions = useSessions()
  const projects = useProjects()

  function unfocused() {
    if (typeof document === "undefined") return false
    return document.hidden || !document.hasFocus()
  }

  function patch(sessionID: string, next: Partial<SessionSignals>) {
    const current = signals.value[sessionID] ?? {}
    signals.value = { ...signals.value, [sessionID]: { ...current, ...next } }
  }

  function setBlocked(sessionID: string, reason: string | undefined, directory?: string) {
    if (reason === undefined) {
      patch(sessionID, { blockedReason: undefined, blockedDirectory: undefined })
      return
    }
    // Keep the directory we already recorded when the event does not carry one.
    const current = signals.value[sessionID]?.blockedDirectory
    patch(sessionID, { blockedReason: reason, blockedDirectory: directory ?? current })
  }

  function markUnreadIfUnwatched(sessionID: string) {
    if (
      countsAsUnread({ isCurrent: sessions.currentID.value === sessionID, focused: !unfocused() }) &&
      !unread.value.has(sessionID)
    ) {
      unread.value = new Set(unread.value).add(sessionID)
      persistUnread()
    }
  }

  /** Fold one event from the global stream into the state. */
  function applyEvent(event: ServerEvent) {
    const type = event.type
    const data = event.data
    if (!data) return
    const sessionID = data.sessionID as string | undefined
    // Every frame is tagged with its project, which is what scopes the sweep's
    // follow-up query (the pending lists are per-location).
    const directory =
      event.location?.directory ?? (data.location as { directory?: string } | undefined)?.directory

    switch (type) {
      case "session.execution.started":
      case "session.step.started":
        if (sessionID) patch(sessionID, { status: "busy" })
        break
      case "session.status": {
        const status = (data.status as { type?: string } | undefined)?.type
        if (sessionID && status) patch(sessionID, { status })
        break
      }
      case "session.idle":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (!sessionID) break
        patch(sessionID, { status: "idle" })
        markUnreadIfUnwatched(sessionID)
        break
      }
      case "session.tool.called":
      case "session.tool.input.started":
        if (sessionID) patch(sessionID, { status: "busy" })
        break
      case "permission.asked": {
        const request = data as unknown as PermissionRequest
        if (request?.id && request.sessionID) {
          requestSession.set(request.id, request.sessionID)
          setBlocked(request.sessionID, `permission: ${request.action}`, directory)
        }
        break
      }
      case "permission.replied":
      case "permission.rejected": {
        const requestID = data.requestID as string | undefined
        const target = (requestID && requestSession.get(requestID)) || sessionID
        if (requestID) requestSession.delete(requestID)
        if (target) setBlocked(target, undefined)
        break
      }
      // As in the chat store, `form.created` nests the form under `data.form`.
      case "form.created": {
        const form = (data.form ?? data) as unknown as FormInfo
        if (form?.id && form.sessionID) {
          requestSession.set(form.id, form.sessionID)
          setBlocked(form.sessionID, QUESTION_REASON, directory)
        }
        break
      }
      case "form.replied":
      case "form.cancelled": {
        const requestID = (data.id as string | undefined) ?? (data.formID as string | undefined)
        const target = (requestID && requestSession.get(requestID)) || sessionID
        if (requestID) requestSession.delete(requestID)
        if (target) setBlocked(target, undefined)
        break
      }
      default:
        break
    }

    // The same events also keep every project's newest conversation current.
    if (type === "session.created" || type === "session.updated") {
      if (directory && directory !== server.directory.value) projects.applyEvent(type, data)
    }
  }

  /**
   * The pending permission/question blocks for one project directory.
   *
   * The lists are per-`location`, so the directory decides which conversations
   * the answer covers — a request against the wrong directory looks like "no
   * pending request at all", which is what used to wipe live blocked dots.
   */
  async function pendingBlocked(client: ServerClient, directory: string) {
    const [permissions, forms] = await Promise.all([
      client.listPermissions({ directory }),
      client.listForms({ directory }),
    ])
    const blocked = new Map<string, string>()
    for (const request of permissions) {
      if (!request?.id || !request.sessionID) continue
      requestSession.set(request.id, request.sessionID)
      blocked.set(request.sessionID, `permission: ${request.action}`)
    }
    for (const form of forms) {
      if (!form?.id || !form.sessionID) continue
      requestSession.set(form.id, form.sessionID)
      blocked.set(form.sessionID, QUESTION_REASON)
    }
    return blocked
  }

  /**
   * Reconcile the blocked flags against the pending lists of `directories`.
   *
   * A directory is only trusted once its query has succeeded: a failed request
   * says nothing about whether its requests are still pending, so it must not
   * clear anything. Only a block whose own directory was read, and that is no
   * longer in that directory's list, is cleared.
   */
  async function reconcile(directories: Array<string | undefined>) {
    const client = activeClient
    if (!client) return
    const unique = [...new Set(directories.filter((directory): directory is string => Boolean(directory)))]
    const found = new Map<string, { reason: string; directory: string }>()
    const read = new Set<string>()
    await mapLimit(unique, 4, async (directory) => {
      try {
        const blocked = await pendingBlocked(client, directory)
        read.add(directory)
        for (const [sessionID, reason] of blocked) found.set(sessionID, { reason, directory })
      } catch {
        /* unread: leave that directory's blocks alone */
      }
    })
    const next = { ...signals.value }
    for (const [sessionID, signal] of Object.entries(next)) {
      const directory = signal.blockedDirectory
      if (signal.blockedReason && directory && read.has(directory) && !found.has(sessionID)) {
        next[sessionID] = { ...signal, blockedReason: undefined, blockedDirectory: undefined }
      }
    }
    for (const [sessionID, entry] of found) {
      next[sessionID] = { ...next[sessionID], blockedReason: entry.reason, blockedDirectory: entry.directory }
    }
    signals.value = next
  }

  /** Directories that currently hold a blocked conversation. */
  function blockedDirectories(): string[] {
    const directories = new Set<string>()
    for (const signal of Object.values(signals.value)) {
      if (signal.blockedReason && signal.blockedDirectory) directories.add(signal.blockedDirectory)
    }
    return [...directories]
  }

  /**
   * Repair pass: re-read every project's pending lists, so a block that arrived
   * while the stream was down is picked up and one answered meanwhile is cleared.
   * Runs on (re)connect, when the whole picture is worth rebuilding.
   */
  async function sweepAll() {
    const directories = [
      ...projects.entries.value.map((entry) => entry.directory),
      server.directory.value,
      ...blockedDirectories(),
    ]
    await reconcile(directories)
  }

  /**
   * Cheap repair pass: only the directories that already hold a blocked
   * conversation, so the timer does not fan out one query per project. This is
   * what keeps a live question or permission red — its directory is read and its
   * entry is still there. With nothing blocked there is nothing to reconcile.
   */
  async function sweep() {
    const directories = blockedDirectories()
    if (!directories.length) return
    await reconcile(directories)
  }

  /** Subscribe to the global stream, reconnecting until stopped. */
  async function follow(client: ServerClient) {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal

    void (async () => {
      while (!signal.aborted) {
        try {
          await client.subscribe((event) => applyEvent(event), {
            signal,
            onOpen: () => {
              globalLive.value = true
              void sweepAll()
            },
          })
        } catch {
          /* dropped: retry below */
        }
        globalLive.value = false
        if (signal.aborted) break
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    })()
  }

  function watchWindow() {
    const acknowledge = () => markSeen(sessions.currentID.value)
    const onVisibility = () => {
      if (!document.hidden) acknowledge()
    }
    window.addEventListener("focus", acknowledge)
    document.addEventListener("visibilitychange", onVisibility)
    detachAttention = () => {
      window.removeEventListener("focus", acknowledge)
      document.removeEventListener("visibilitychange", onVisibility)
      detachAttention = null
    }
  }

  function start(client: ServerClient) {
    stop()
    activeClient = client
    watchWindow()
    void follow(client)
    void sweepAll()
    sweepTimer = setInterval(() => void sweep(), SWEEP_MS)
  }

  function stop() {
    controller?.abort()
    controller = null
    activeClient = null
    detachAttention?.()
    globalLive.value = false
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
  }

  function reset() {
    stop()
    signals.value = {}
    requestSession.clear()
    unread.value = new Set()
    persistUnread()
  }

  function stateFor(sessionID: string | null | undefined): ConversationState {
    if (!sessionID) return "idle"
    const signal = signals.value[sessionID]
    return conversationState({
      blocked: Boolean(signal?.blockedReason),
      status: signal?.status,
      unread: unread.value.has(sessionID),
    })
  }

  function reasonFor(sessionID: string | null | undefined): string {
    if (!sessionID) return "idle"
    const signal = signals.value[sessionID]
    if (signal?.blockedReason) return signal.blockedReason
    return stateLabel(
      conversationState({ status: signal?.status, unread: unread.value.has(sessionID) }),
      { status: signal?.status },
    )
  }

  function markSeen(sessionID: string | null | undefined) {
    if (!sessionID || !unread.value.has(sessionID)) return
    const next = new Set(unread.value)
    next.delete(sessionID)
    unread.value = next
    persistUnread()
  }

  /** One rollup entry per project, for the sidebar and the tray. */
  const projectRollup = computed<ProjectRollup[]>(() =>
    rollupProjects(
      projects.entries.value.map((entry) => ({
        id: entry.directory,
        name: entry.name,
        conversations: entry.session
          ? [
              {
                id: entry.session.id,
                title: entry.session.title || "Untitled",
                state: stateFor(entry.session.id),
                reason: reasonFor(entry.session.id),
              },
            ]
          : [],
      })),
    ),
  )

  const trayRollup = computed(() => rollupTray(projectRollup.value))

  return {
    signals,
    unread,
    globalLive,
    projectRollup,
    trayRollup,
    stateFor,
    reasonFor,
    markSeen,
    start,
    stop,
    reset,
  }
}
