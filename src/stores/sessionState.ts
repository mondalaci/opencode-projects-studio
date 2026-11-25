import { computed, ref } from "vue"
import type { ServerClient } from "@/api/client"
import { sessionDirectory, type FormInfo, type PermissionRequest, type ServerEvent, type SessionInfo } from "@/api/types"
import { useProjects, RECENT_WINDOW_MS } from "./projects"
import { useRecentChats } from "./recentChats"
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

/**
 * How often the app re-reads the conversation it has marked unread, to notice a
 * view posted by another client (the panel's tile click). Nothing broadcasts a
 * view, so this is a poll - but a slow one, and only over the unread set.
 */
const VIEWED_SWEEP_MS = 5000

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

/** A conversation a project's tray entry lists. */
export interface VisibleConversation {
  id: string
  title: string
  state: ConversationState
  reason: string
  /** When it last changed, for ordering newest first. */
  time: number
}

const signals = ref<Record<string, SessionSignals>>({})
const unread = ref<Set<string>>(loadUnread())
const globalLive = ref(false)

/**
 * Conversation id → title and directory, for conversations the recent list does
 * not hold.
 *
 * The tray shows every conversation that is recent *or* wants attention, and a
 * conversation that has been waiting since before
 * the window is exactly the one the recent list drops — so its name has to come
 * from somewhere. Anything this app has cached is read from the projects store;
 * the rest is fetched once and remembered here.
 */
const info = ref<Record<string, { title: string; directory: string; time: number }>>({})

/** Conversations whose info fetch is already in flight. */
const resolving = new Set<string>()

/** The last whole minute, so the recent window can age rows out on its own. */
let lastMinute = Math.floor(Date.now() / 60000)
/** A ticking clock for the recent window, so a row folds away without an event. */
const now = ref(Date.now())

/** Request id → session id, so a reply can clear the right conversation. */
const requestSession = new Map<string, string>()

let sweepTimer: ReturnType<typeof setInterval> | null = null
let viewedTimer: ReturnType<typeof setInterval> | null = null
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

const LAST_RUN_KEY = "opencode-projects-studio.last-run"

/**
 * When the previous run of the app ended, read once at startup.
 *
 * A finish that happened after this stamp was never seen by anybody: the app was
 * not running, so no window could have watched it. Such a finish must not be
 * reported to the server as "viewed" — doing so clears the Cinnamon applet's dot
 * and the studio's own dot for a conversation nobody opened. The stamp is frozen
 * at load: updating it as the app runs would make every new finish look old.
 */
const bootCutoff = readLastRun()

/**
 * When this run began, frozen at load.
 *
 * Adoption is only for a finish that happened while the app was not running. A
 * finish after this instant belongs to this run, which has the event stream for
 * it — and the cached project record never learns about the `viewed` stamp the
 * app posts for a turn it watched, so adopting one again would announce the
 * same turn on every sweep.
 */
const runStartedAt = Date.now()

/**
 * Conversations whose closed-app finish has already been adopted this run.
 *
 * `projects.latest` holds each session as it was last read, so its `viewed`
 * stamp stays older than a finish the app has since watched or the user has
 * opened. Without this set, every sweep would adopt the same finish again and
 * the chime would repeat as soon as the user cleared it.
 */
const adopted = new Set<string>()

function readLastRun(): number {
  try {
    const raw = localStorage.getItem(LAST_RUN_KEY)
    const value = raw ? Number(raw) : 0
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** Remember when this run last touched the app, for the next run's cutoff. */
function touchLastRun() {
  try {
    localStorage.setItem(LAST_RUN_KEY, String(Date.now()))
  } catch {
    /* storage unavailable */
  }
}

export function useSessionState() {
  const server = useServer()
  const sessions = useSessions()
  const projects = useProjects()
  const recentChats = useRecentChats()

  function unfocused() {
    if (typeof document === "undefined") return false
    return document.hidden || !document.hasFocus()
  }

  function patch(sessionID: string, next: Partial<SessionSignals>) {
    const current = signals.value[sessionID] ?? {}
    signals.value = { ...signals.value, [sessionID]: { ...current, ...next } }
  }

  /** Remember a conversation's title and directory, so its row can name it. */
  function remember(session: SessionInfo | null | undefined) {
    if (!session?.id || session.parentID) return
    const directory = sessionDirectory(session)
    if (!directory) return
    const title = session.title || "Untitled"
    const time = session.time?.updated ?? session.time?.created ?? 0
    const current = info.value[session.id]
    if (current && current.title === title && current.directory === directory && current.time === time) return
    info.value = { ...info.value, [session.id]: { title, directory, time } }
  }

  /**
   * Resolve a conversation that wants attention to a name, reading what the app
   * already has and falling back to one `getSession` when it has nothing.
   */
  async function resolveInfo(sessionID: string, directory?: string) {
    if (info.value[sessionID]) return
    const cached = projects.findSession(sessionID)
    if (cached) {
      remember(cached)
      return
    }
    const client = activeClient
    if (!client || resolving.has(sessionID)) return
    resolving.add(sessionID)
    try {
      remember(await client.getSession(sessionID, directory ? { directory } : {}))
    } catch {
      /* best effort: the row falls back to an unnamed line */
    } finally {
      resolving.delete(sessionID)
    }
  }

  /**
   * Forget conversations that no longer need a name of their own: once one has
   * no news it is shown, if at all, from the recent list, which carries its
   * title. Without this the cache would keep every conversation the app has ever
   * had to look up.
   */
  function pruneInfo() {
    let changed = false
    const next: typeof info.value = {}
    for (const [id, entry] of Object.entries(info.value)) {
      if (hasNews(id)) next[id] = entry
      else changed = true
    }
    if (changed) info.value = next
  }

  function setBlocked(sessionID: string, reason: string | undefined, directory?: string) {
    if (reason === undefined) {
      patch(sessionID, { blockedReason: undefined, blockedDirectory: undefined })
      return
    }
    // Keep the directory we already recorded when the event does not carry one.
    const current = signals.value[sessionID]?.blockedDirectory
    patch(sessionID, { blockedReason: reason, blockedDirectory: directory ?? current })
    void resolveInfo(sessionID, directory)
  }

  function markUnreadIfUnwatched(sessionID: string) {
    if (
      countsAsUnread({ isCurrent: sessions.currentID.value === sessionID, focused: !unfocused() }) &&
      !unread.value.has(sessionID)
    ) {
      unread.value = new Set(unread.value).add(sessionID)
      persistUnread()
      void resolveInfo(sessionID)
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
        if (countsAsUnread({ isCurrent: sessions.currentID.value === sessionID, focused: !unfocused() })) {
          markUnreadIfUnwatched(sessionID)
        } else {
          // This window watched it finish, so its row shows no green dot -
          // publish that, or the panel would light one up.
          void publishViewed(sessionID)
        }
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

    // A conversation working now has activity now, so it earns a row even when
    // its own record has aged out of the recent window; the lookup gives it a
    // name, and `hasNews` is what keeps it listed until it settles.
    if (sessionID && isWorking(sessionID)) void resolveInfo(sessionID, directory)

    // The same events also keep every project's newest conversation current.
    // `session.renamed` is how an auto-generated title reaches the sidebar, so a
    // project that is not the open one updates its row without a refetch too.
    if (type === "session.created" || type === "session.updated" || type === "session.renamed") {
      if (directory && directory !== server.directory.value) projects.applyEvent(type, data, directory)
    }
    // This store follows the stream independently of `live`, so the all-projects
    // chat list hears about a change once from either subscriber — the merges are
    // idempotent.
    recentChats.applyEvent(type, data, directory)
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
      void resolveInfo(sessionID, entry.directory)
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
   * Repair pass for (re)connect: re-read the pending lists of the project on
   * screen, of every directory already known to hold a block, and of every
   * location the server already has loaded, so a request that arrived while the
   * stream was down is picked up and one answered meanwhile is cleared.
   *
   * Deliberately *not* every known project. A pending-list request is scoped to
   * a `location`, and materializing a location starts that project's whole MCP
   * fleet — so asking all ~40 projects at connect booted ~40 MCP fleets and tens
   * of GiB of server processes at once, which is what froze the machine.
   *
   * The loaded set is the key: a permission or question exists only while a turn
   * is live, and a live turn pins its location, so a project that can possibly
   * show a block is *already* loaded — and repairing those boots nothing new.
   * That gives every project its badge without paying for a fleet to discover it.
   * (`/api/debug/location` is the server's debug endpoint, so a failure is
   * tolerated: the two known sets still cover the project on screen and anything
   * already flagged.)
   */
  async function sweepOnConnect(client: ServerClient) {
    let loaded: string[] = []
    try {
      loaded = await client.loadedLocations()
    } catch {
      /* debug endpoint unavailable: fall back to the sets we already know */
    }
    const directories = [server.directory.value, ...loaded, ...blockedDirectories()]
    await reconcile(directories)
  }

  /**
   * Re-read one project's pending lists, for when it becomes the one on screen.
   *
   * Switching to a project already materializes its location (the scoped
   * `server.load` does), so this adds one permission/form query to a fleet that
   * is booting anyway — it is what keeps the opened project's blocked dot
   * correct without sweeping every project at connect.
   */
  async function reconcileProject(directory: string | null | undefined) {
    if (!directory) return
    await reconcile([directory])
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
              void sweepOnConnect(client)
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
    void sweepOnConnect(client)
    // Unread conversations persisted from a previous run have no title in cache
    // yet; one lookup each fills their rows in without waiting for the timer.
    for (const sessionID of unread.value) void resolveInfo(sessionID)
    sweepTimer = setInterval(() => {
      const minute = Math.floor(Date.now() / 60000)
      if (minute !== lastMinute) {
        lastMinute = minute
        now.value = Date.now()
      }
      void sweep()
    }, SWEEP_MS)
    viewedTimer = setInterval(() => {
      const client = activeClient
      if (!client) return
      adoptUnreadRows()
      if (unread.value.size) void reconcileViewed(client)
      pruneInfo()
      touchLastRun()
    }, VIEWED_SWEEP_MS)
    // The stamp is what the next run uses to tell "finished while the app was
    // closed" from "finished long ago and already read". Record it on the way
    // out as well as on the timer, so a quick quit does not lose the last gap.
    window.addEventListener("pagehide", touchLastRun)
    window.addEventListener("beforeunload", touchLastRun)
  }

  function stop() {
    touchLastRun()
    controller?.abort()
    controller = null
    activeClient = null
    detachAttention?.()
    globalLive.value = false
    window.removeEventListener("pagehide", touchLastRun)
    window.removeEventListener("beforeunload", touchLastRun)
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
    if (viewedTimer) clearInterval(viewedTimer)
    viewedTimer = null
  }

  function reset() {
    stop()
    signals.value = {}
    info.value = {}
    resolving.clear()
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
    if (!sessionID) return
    if (unread.value.has(sessionID)) {
      const next = new Set(unread.value)
      next.delete(sessionID)
      unread.value = next
      persistUnread()
    }
    // Opening a conversation is the user saying they have seen it, whether or
    // not *this* window ever flagged it. The panel's dot reads the server's
    // marker, so a finish this window was closed for - never marked unread here -
    // still has to be told, or the panel keeps its green dot for a conversation
    // the studio already shows grey.
    void publishViewed(sessionID)
  }

  /**
   * Publish "I have seen this finish" to the server.
   *
   * The studio's own unread set is what tells a finish that was watched from one
   * that was not, but it is private to this window. Posting the idle transition
   * to `time.viewed` is what lets the panel clear the same conversation's green
   * dot, so the two stay in step.
   *
   * The stamp has to be the conversation's *current* idle, read fresh. Nothing in
   * this app advances a cached record's `time` - not the session list, not the
   * event stream, whose `session.idle` frame carries only an id - so a cached
   * stamp is whatever the load that filled it last saw. Posting one marks an
   * older finish seen and leaves the panel's dot lit for the newer one, and the
   * server only ever moves `viewed` forward, so it cannot repair that by itself.
   *
   * Best effort: the app does not need it to work.
   */
  async function publishViewed(sessionID: string) {
    const client = activeClient
    if (!client) return
    try {
      const session = await client.getSession(sessionID)
      remember(session)
      const idle = session?.time?.idle
      if (idle) await client.viewSession(sessionID, idle)
    } catch {
      /* the marker is best effort */
    }
  }

  /**
   * Adopt the finishes that happened while the app was not running.
   *
   * A finish from after the previous run ended was never watched by anyone: the
   * app was closed. Its server marker is still unset, so the panel keeps its
   * tile — and the studio's own row has to agree, or the two lists disagree
   * about the same conversation. That is all this pass does.
   *
   * It never posts a "viewed" marker. Marking a conversation read is the user's
   * act (opening it) or the app's (watching it finish), never a side effect of
   * walking the list: a backfill that stamped every row on screen used to clear
   * the Cinnamon applet's tile and the studio's dot for finishes nobody opened.
   *
   * The pass runs on every viewed sweep, because a project list can finish
   * loading after the first one, but what it may adopt is bounded twice: the
   * finish must be old enough to predate this run, and a conversation already
   * adopted is skipped for the rest of the run. Otherwise a finish the app
   * watched — whose `viewed` stamp the cached record never sees — would come
   * back as unread every five seconds, chiming each time.
   */
  function adoptUnreadRows() {
    // No previous run on record: there is no way to tell a finish from before
    // the app was installed from one during the last shutdown, so adopt nothing.
    if (!bootCutoff) return
    for (const session of Object.values(projects.latest.value)) {
      if (!session) continue
      const idle = session.time?.idle
      if (!idle) continue
      if (session.time?.viewed && session.time.viewed >= idle) continue
      // A finish at or after this run's start is the stream's to report.
      if (idle > runStartedAt) continue
      if (unread.value.has(session.id)) continue
      if (idle <= bootCutoff) continue
      if (adopted.has(session.id)) continue
      adopted.add(session.id)
      markUnreadIfUnwatched(session.id)
    }
  }

  /**
   * Drop conversations the server says somebody has already looked at.
   *
   * The panel posts the same marker when its tile is acknowledged, so this is
   * how a click in the panel clears the studio's dot. Nothing broadcasts a view,
   * so it is read back on a slow timer (see `start`).
   */
  async function reconcileViewed(client: ServerClient) {
    const ids = [...unread.value]
    if (!ids.length) return
    const viewed = new Set<string>()
    await mapLimit(ids.slice(0, 40), 4, async (sessionID) => {
      try {
        const session = await client.getSession(sessionID)
        remember(session)
        const idle = session?.time?.idle
        if (idle && session?.time?.viewed && session.time.viewed >= idle) viewed.add(sessionID)
      } catch {
        /* unread: leave that one alone */
      }
    })
    if (!viewed.size) return
    const next = new Set(unread.value)
    for (const sessionID of viewed) next.delete(sessionID)
    unread.value = next
    persistUnread()
  }

  /** Whether a conversation wants a human right now: blocked, or done and unread. */
  function wantsAttention(sessionID: string): boolean {
    return Boolean(signals.value[sessionID]?.blockedReason) || unread.value.has(sessionID)
  }

  /** Whether a conversation is working right now, which is activity in itself. */
  function isWorking(sessionID: string): boolean {
    const status = signals.value[sessionID]?.status
    return status === "busy" || status === "retry"
  }

  /**
   * Whether a conversation has news worth a line on its project's row, beyond
   * the recent list: it wants a human, or it is working now.
   */
  function hasNews(sessionID: string): boolean {
    return wantsAttention(sessionID) || isWorking(sessionID)
  }

  /**
   * The conversations a project's tray entry lists, newest first: the ones that
   * changed recently, the project's newest, and anything that wants attention
   * however long it has been waiting.
   *
   * The recent list is bounded and the newest is one row, so the only unbounded
   * part is the attention set — which is exactly what must not be lost, since a
   * blocked conversation that has sat for a day is the one most in need of a row.
   */
  const visibleByDirectory = computed<Record<string, VisibleConversation[]>>(() => {
    const map: Record<string, VisibleConversation[]> = {}
    const cutoff = now.value - RECENT_WINDOW_MS
    for (const entry of projects.entries.value) {
      const directory = entry.directory
      const found = new Map<string, { id: string; title: string; time: number }>()

      for (const session of projects.recentFor(directory)) {
        const time = session.time?.updated ?? session.time?.created ?? 0
        if (time < cutoff) continue
        found.set(session.id, { id: session.id, title: session.title || "Untitled", time })
      }
      // The project's newest conversation is always the row's summary.
      if (entry.session) {
        const time = entry.session.time?.updated ?? entry.session.time?.created ?? 0
        found.set(entry.session.id, { id: entry.session.id, title: entry.session.title || "Untitled", time })
      }
      // Anything with news, even once it has aged out of the window — blocked,
      // done-and-unopened, or working now — named from the cache the lookups
      // above keep filled. Only resolved conversations land here, and the
      // resolver drops subagents, so a child's own permission can never put a
      // line on its parent's row.
      for (const [id, cached] of Object.entries(info.value)) {
        if (cached.directory !== directory) continue
        if (!hasNews(id)) continue
        if (found.has(id)) continue
        found.set(id, { id, title: cached.title, time: cached.time })
      }

      map[directory] = [...found.values()]
        .sort((a, b) => b.time - a.time)
        .map((item) => ({ ...item, state: stateFor(item.id), reason: reasonFor(item.id) }))
    }
    return map
  })

  /** The conversations a project's tray entry lists, newest first. */
  function visibleFor(directory: string | null | undefined): VisibleConversation[] {
    if (!directory) return []
    return visibleByDirectory.value[directory] ?? []
  }

  /** One rollup entry per project, for the tray. */
  const projectRollup = computed<ProjectRollup[]>(() =>
    rollupProjects(
      projects.entries.value.map((entry) => ({
        id: entry.directory,
        name: entry.name,
        conversations:
          visibleByDirectory.value[entry.directory]?.map((conversation) => ({
            id: conversation.id,
            title: conversation.title,
            state: conversation.state,
            reason: conversation.reason,
          })) ?? [],
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
    visibleFor,
    stateFor,
    reasonFor,
    markSeen,
    reconcileProject,
    start,
    stop,
    reset,
  }
}
