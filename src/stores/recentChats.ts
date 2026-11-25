import { computed, ref } from "vue"
import type { ServerClient } from "@/api/client"
import { isRootDirectory, sessionDirectory, type SessionInfo } from "@/api/types"
import { useHiddenProjects } from "./hiddenProjects"

/**
 * The sidebar's all-projects conversation list.
 *
 * One request fills it: the session endpoint is newest first and goes unscoped
 * when no directory is given, so the whole list costs a single bounded page
 * rather than a pass over every project's history. Live events keep it current,
 * so switching projects or coming back to the window never re-reads it.
 */

/** How many conversations the list holds. Older ones stay reachable through search. */
export const RECENT_LIMIT = 50

/** Turn endings, after which a conversation has had activity worth moving up for. */
const ACTIVITY_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

const chats = ref<SessionInfo[]>([])

/** When a conversation last changed, for the newest-first order. */
function updatedAt(session: { time?: SessionInfo["time"] }): number {
  return session.time?.updated ?? session.time?.created ?? 0
}

/**
 * The rows the list can show: root conversations of a real project, newest
 * first.
 *
 * A subagent is no one's chat, and a conversation in the root placeholder cannot
 * be opened — pointing the app at `/` is exactly what recreates opencode's
 * placeholder project — so neither belongs in a list whose rows are clicked.
 */
function listed(list: SessionInfo[]): SessionInfo[] {
  return list
    .filter((session) => {
      if (session.parentID) return false
      const directory = sessionDirectory(session)
      return Boolean(directory) && !isRootDirectory(directory)
    })
    .sort((a, b) => updatedAt(b) - updatedAt(a))
}

const loading = ref(false)

export function useRecentChats() {
  const hidden = useHiddenProjects()

  /** The list the sidebar renders — hidden projects' conversations stay out. */
  const visible = computed<SessionInfo[]>(() =>
    chats.value.filter((session) => !hidden.isHidden(sessionDirectory(session))),
  )

  /**
   * Read the newest conversations of every project in one request.
   *
   * `parentID: "null"` asks the server for root conversations only, so the page
   * is not spent on subagents.
   */
  async function load(client: ServerClient, limit = RECENT_LIMIT) {
    loading.value = true
    try {
      const res = await client.listSessions({ limit, parentID: "null" })
      chats.value = listed(res.data)
    } catch {
      /* keep whatever is already listed; the next event or reconnect retries */
    } finally {
      loading.value = false
    }
  }

  /**
   * Fold a full record this client has in hand into the list — a created chat, a
   * rename, or one just opened.
   *
   * An unknown conversation is placed by its own timestamp and the oldest row
   * falls off the end, so the list stays the newest `RECENT_LIMIT` conversations
   * however it was reached.
   */
  function merge(session: SessionInfo | null | undefined) {
    if (!session?.id || session.parentID) return
    const index = chats.value.findIndex((item) => item.id === session.id)
    if (index === -1) {
      const directory = sessionDirectory(session)
      if (!directory || isRootDirectory(directory)) return
      chats.value = listed([...chats.value, session]).slice(0, RECENT_LIMIT)
      return
    }
    chats.value = chats.value.map((item, i) => (i === index ? { ...item, ...session } : item))
  }

  /** Drop a deleted conversation. */
  function forget(sessionID: string) {
    const next = chats.value.filter((item) => item.id !== sessionID)
    if (next.length !== chats.value.length) chats.value = next
  }

  /** Drop every conversation of a project that no longer exists. */
  function forgetProject(directory: string) {
    const next = chats.value.filter((item) => sessionDirectory(item) !== directory)
    if (next.length !== chats.value.length) chats.value = next
  }

  /**
   * Fold a live event into the list.
   *
   * A new conversation is by definition the newest, a rename only changes a
   * label, and a finished turn is activity — which is what moves a conversation
   * back to the top while the reader is looking at the list, exactly as it would
   * read on the next load.
   */
  function applyEvent(type: string, data: Record<string, unknown> | undefined, directory?: string) {
    if (!data) return
    const id = data.sessionID as string | undefined
    if (!id) return
    const dir = directory ?? (data.location as { directory?: string } | undefined)?.directory

    if (type === "session.created") {
      if (data.parentID || !dir || isRootDirectory(dir)) return
      const now = Date.now()
      const existing = chats.value.find((item) => item.id === id)
      const entry: SessionInfo = {
        ...existing,
        id,
        projectID: (data.projectID as SessionInfo["projectID"]) ?? existing?.projectID,
        title: (data.title as string | undefined) ?? existing?.title,
        location: existing?.location ?? { directory: dir },
        time: existing?.time ?? { created: now, updated: now },
      }
      chats.value = listed([entry, ...chats.value.filter((item) => item.id !== id)])
      return
    }

    if (type === "session.updated" || type === "session.renamed") {
      const title = data.title as string | undefined
      if (!title) return
      if (!chats.value.some((item) => item.id === id)) return
      chats.value = chats.value.map((item) => (item.id === id ? { ...item, title } : item))
      return
    }

    if (type === "session.deleted") {
      forget(id)
      return
    }

    if (ACTIVITY_EVENTS.has(type) && chats.value.some((item) => item.id === id)) {
      const now = Date.now()
      chats.value = listed(
        chats.value.map((item) =>
          item.id === id ? { ...item, time: { ...item.time, updated: now } } : item,
        ),
      )
    }
  }

  function reset() {
    chats.value = []
    loading.value = false
  }

  return { chats: visible, loading, load, merge, forget, forgetProject, applyEvent, reset }
}
