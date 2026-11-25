import { computed, ref } from "vue"
import type { ServerClient } from "@/api/client"
import { ROOT_DIRECTORY, type ProjectInfo, type SessionInfo } from "@/api/types"
import { useHiddenProjects } from "./hiddenProjects"
import { useServer } from "./server"

/**
 * Per-project state for the sidebar.
 *
 * The project picker lists every project the server knows about, and opening one
 * needs a conversation to land on, so this store keeps one "latest session" per
 * project directory plus the ones that changed recently (which the tray rolls
 * up). Session events feed `applyEvent` so the state keeps tracking without a
 * refetch.
 */

const latest = ref<Record<string, SessionInfo | null>>({})
const loading = ref(false)

/**
 * How recently a conversation must have changed to stay on a project's recent
 * list, which is what the tray rolls up. Older conversations are still listed —
 * and still announced — when they want attention; the window is only what makes
 * an *idle* conversation old enough to drop out of the tray's rollup.
 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Conversations read per project when the project list is filled.
 *
 * One bounded page per project is all the sidebar needs — the newest
 * conversation it opens on and the recent ones the tray rolls up — so a project
 * with years of history costs no more than a fresh one. The size matches the
 * conversation list the app loads for the open project, so the tray and the
 * sidebar never disagree about which conversations are recent.
 */
const LATEST_PAGE_SIZE = 50

/**
 * Root conversations of a project that changed recently, newest first.
 *
 * The tray lists these alongside the project's newest conversation, so a
 * conversation that got a notification does not disappear from view the moment a
 * newer one supersedes it. Bounded by `RECENT_WINDOW_MS`, which is what keeps an
 * idle conversation from standing in the rollup forever.
 */
const recent = ref<Record<string, SessionInfo[]>>({})

/**
 * Project directories this client has itself found to be gone.
 *
 * opencode archives a project when its folder disappears, but a stale twin row
 * for the same directory can be left behind without that mark — and the sidebar
 * collapses the twins into whichever one looks live. Finding it out from the
 * `LocationNotFoundError` a switch answers with is what puts the badge on the row
 * the server would have let look healthy.
 */
const missing = ref<Record<string, true>>({})

/** A project together with the conversation the sidebar shows for it. */
export interface ProjectEntry {
  directory: string
  name: string
  project: ProjectInfo
  session: SessionInfo | null
  /**
   * The project is archived: its folder no longer exists, so opencode swept it
   * out of the active list. Past conversations stay readable, but nothing new can
   * run in it.
   *
   * True when the server says so *and* when this client has found the folder gone
   * itself: a stale row can outlive the server's mark, so either word is enough.
   */
  archived: boolean
}

/** The display name of a project: its registered name, else the folder name. */
export function projectName(project: ProjectInfo): string {
  if (project.name) return project.name
  const path = project.canonical
  if (!path || path === "/") return "root"
  return path.split("/").filter(Boolean).pop() ?? path
}

/**
 * Whether `a` is the better row to show for a directory that has more than one.
 *
 * opencode can hold several project rows for the same canonical directory (a
 * stale twin is left behind when a project is re-created), and the sidebar keys
 * rows by directory, so they have to collapse to one. A live row beats an
 * archived one; otherwise the most recently active wins.
 */
function preferProject(a: ProjectInfo, b: ProjectInfo): boolean {
  const aArchived = Boolean(a.time?.archived)
  const bArchived = Boolean(b.time?.archived)
  if (aArchived !== bArchived) return !aArchived
  return (a.time?.active ?? 0) > (b.time?.active ?? 0)
}

/** Root conversations (no subagents), newest first. */
function rootsByNewest(list: SessionInfo[]): SessionInfo[] {
  return list
    .filter((session) => !session.parentID)
    .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
}

/** When a conversation last changed, for the recent window and for ordering. */
function updatedAt(session: { time?: SessionInfo["time"] }): number {
  return session.time?.updated ?? session.time?.created ?? 0
}

/** Whether a conversation changed recently enough to stay on the recent list. */
function withinWindow(session: { time?: SessionInfo["time"] }, now = Date.now()): boolean {
  return now - updatedAt(session) < RECENT_WINDOW_MS
}

/**
 * A project's newest conversations, newest first — one bounded page, no cursor
 * followed.
 *
 * The list only has to name the conversation a project opens on and the ones
 * that changed recently, so reading a project's whole history would be paying
 * for rows nothing shows. Everything older stays reachable through the search
 * over conversations.
 */
async function fetchRecent(client: ServerClient, directory: string): Promise<SessionInfo[]> {
  const res = await client.listSessions({
    directory,
    limit: LATEST_PAGE_SIZE,
    parentID: "null",
  })
  return rootsByNewest(res.data)
}

/** Run `worker` over `items` with at most `limit` concurrent calls. */
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

export function useProjects() {
  const { projects, directory } = useServer()
  const hidden = useHiddenProjects()

  /** Every known project, sorted by activity, each with its newest conversation. */
  const allEntries = computed<ProjectEntry[]>(() => {
    // The root (`/`) is opencode's own placeholder, not a real project. The
    // server hands it back (as the built-in `global` and, once anything is
    // scoped to `/`, a second ordinary project), and any request aimed at `/`
    // makes it resolve — and so recreate — that second project. Keeping it out
    // of the sidebar means the app never points at `/` and it stays gone.
    const byDirectory = new Map<string, ProjectInfo>()
    for (const project of projects.value) {
      if (project.canonical === ROOT_DIRECTORY) continue
      const current = byDirectory.get(project.canonical)
      if (!current || preferProject(project, current)) byDirectory.set(project.canonical, project)
    }
    return [...byDirectory.values()]
      .map((project) => ({
        directory: project.canonical,
        name: projectName(project),
        project,
        session: latest.value[project.canonical] ?? null,
        archived: Boolean(project.time?.archived) || missing.value[project.canonical] === true,
      }))
      .sort((a, b) => {
        const aTime = a.session?.time?.updated ?? a.session?.time?.created ?? 0
        const bTime = b.session?.time?.updated ?? b.session?.time?.created ?? 0
        if (aTime !== bTime) return bTime - aTime
        return a.name.localeCompare(b.name)
      })
  })

  /** The projects the sidebar lists — every known project but the hidden ones. */
  const entries = computed<ProjectEntry[]>(() =>
    allEntries.value.filter((entry) => !hidden.isHidden(entry.directory)),
  )

  /** The projects the sidebar keeps out of the way, for the Hidden section. */
  const hiddenEntries = computed<ProjectEntry[]>(() =>
    allEntries.value.filter((entry) => hidden.isHidden(entry.directory)),
  )

  /**
   * Directory → the name the sidebar shows for it.
   *
   * A chat row names the project it belongs to, and the chat list is filled from
   * the server's global session list, which carries a directory rather than a
   * name. Unknown directories — one that has no project row, or an archived
   * twin — fall back to their folder name so a row never reads as anonymous.
   */
  const nameByDirectory = computed(() => {
    const map = new Map<string, string>()
    for (const entry of allEntries.value) map.set(entry.directory, entry.name)
    return map
  })

  /** The display name of a project directory, known or not. */
  function displayName(target: string | null | undefined): string {
    if (!target) return ""
    const known = nameByDirectory.value.get(target)
    if (known) return known
    const folder = target.replace(/\/+$/, "").split("/").filter(Boolean).pop()
    return folder || target
  }

  /** The entry whose conversation changed most recently, if any. */
  const mostRecent = computed<ProjectEntry | null>(() => {
    let best: ProjectEntry | null = null
    let bestTime = -1
    for (const entry of entries.value) {
      // An archived project's folder is gone, so it is never the one to open.
      if (entry.archived) continue
      const time = entry.session?.time?.updated ?? entry.session?.time?.created ?? 0
      if (entry.session && time > bestTime) {
        best = entry
        bestTime = time
      }
    }
    return best
  })

  /**
   * Whether a project is archived — the server's mark, or this client's own
   * finding that the folder is gone.
   */
  function isArchived(target: string | null | undefined): boolean {
    if (!target) return false
    return allEntries.value.some((entry) => entry.directory === target && entry.archived)
  }

  /** Record that a project's folder is gone, so its row says so from now on. */
  function markMissing(directory: string) {
    if (missing.value[directory]) return
    missing.value = { ...missing.value, [directory]: true }
  }

  /** Forget that mark, once the directory resolves again. */
  function clearMissing(directory: string) {
    if (!missing.value[directory]) return
    const next = { ...missing.value }
    delete next[directory]
    missing.value = next
  }

  /** Conversation shown for a project, if one is known. */
  function latestFor(target: string | null | undefined): SessionInfo | null {
    if (!target) return null
    return latest.value[target] ?? null
  }

  /** Register a freshly created or updated conversation as a project's newest. */
  function setLatest(target: string | null | undefined, session: SessionInfo) {
    if (!target || session.parentID) return
    rememberRecent(target, session)
    const current = latest.value[target]
    const next = session.time?.updated ?? session.time?.created ?? 0
    const existing = current?.time?.updated ?? current?.time?.created ?? 0
    if (!current || next >= existing) latest.value = { ...latest.value, [target]: session }
  }

  /**
   * Keep a conversation on its project's recent list, which is what the tray
   * shows beyond the newest conversation.
   *
   * A conversation already listed is always merged in place — an event for it is
   * news whatever its age. One that is new to the list is only added when it
   * changed recently, so a rename cannot drag a long-idle conversation back onto
   * the list.
   */
  function rememberRecent(directory: string, session: Partial<SessionInfo> & { id: string }) {
    if (session.parentID) return
    const list = recent.value[directory] ?? []
    const index = list.findIndex((item) => item.id === session.id)
    if (index !== -1) {
      recent.value = {
        ...recent.value,
        [directory]: rootsByNewest(list.map((item, i) => (i === index ? { ...item, ...session } : item))),
      }
      return
    }
    const updated = session.time?.updated ?? session.time?.created
    // A conversation new to the list needs a known, recent change time to earn
    // its place; a payload that only carries a title merges into an existing line.
    if (updated === undefined || !withinWindow(session)) return
    const now = Date.now()
    const entry: SessionInfo = {
      ...session,
      id: session.id,
      time: session.time ?? { created: now, updated: now },
      location: session.location ?? { directory },
    }
    recent.value = { ...recent.value, [directory]: rootsByNewest([entry, ...list]) }
  }


  /** A project's recently changed conversations, newest first. */
  function recentFor(directory: string | null | undefined): SessionInfo[] {
    if (!directory) return []
    return recent.value[directory] ?? []
  }

  /** A conversation this client has cached anywhere, so its title can be found. */
  function findSession(sessionID: string): SessionInfo | undefined {
    for (const session of Object.values(latest.value)) {
      if (session?.id === sessionID) return session
    }
    for (const list of Object.values(recent.value)) {
      const hit = list.find((item) => item.id === sessionID)
      if (hit) return hit
    }
    return undefined
  }

  /** Drop a deleted conversation from its project's recent list. */
  function forgetChat(sessionID: string) {
    let changed = false
    const next: Record<string, SessionInfo[]> = {}
    for (const [directory, list] of Object.entries(recent.value)) {
      if (list.some((item) => item.id === sessionID)) {
        next[directory] = list.filter((item) => item.id !== sessionID)
        changed = true
      } else {
        next[directory] = list
      }
    }
    if (changed) recent.value = next
  }

  /** Forget everything cached for a project that no longer exists. */
  function forgetProject(directory: string) {
    if (directory in latest.value) {
      const next = { ...latest.value }
      delete next[directory]
      latest.value = next
    }
    if (directory in recent.value) {
      const next = { ...recent.value }
      delete next[directory]
      recent.value = next
    }
    clearMissing(directory)
  }

  /**
   * Fetch every project's newest conversations, so each project knows the
   * conversation opening it lands on and the recent ones the tray rolls up.
   *
   * The session endpoint is scoped by `directory`, so this is one bounded
   * request per project, capped to a handful in flight.
   */
  async function load(client: ServerClient) {
    loading.value = true
    // The root placeholder is not a project the sidebar shows, so it is not
    // fetched for either — and nothing ends up pointing the app at `/`.
    const list = projects.value.filter((project) => project.canonical !== ROOT_DIRECTORY)
    try {
      const results = await mapLimit(list, 6, async (project) => {
        try {
          return [project.canonical, await fetchRecent(client, project.canonical)] as const
        } catch {
          return [project.canonical, [] as SessionInfo[]] as const
        }
      })
      const next: Record<string, SessionInfo | null> = {}
      const nextRecent: Record<string, SessionInfo[]> = {}
      for (const [worktree, roots] of results) {
        next[worktree] = roots[0] ?? null
        nextRecent[worktree] = roots.filter((session) => withinWindow(session))
      }
      latest.value = next
      recent.value = nextRecent
    } finally {
      loading.value = false
    }
  }

  /** Re-read one project's newest conversations. */
  async function refreshOne(client: ServerClient, target: string) {
    if (target === ROOT_DIRECTORY) return
    try {
      const roots = await fetchRecent(client, target)
      latest.value = { ...latest.value, [target]: roots[0] ?? null }
      recent.value = { ...recent.value, [target]: roots.filter((session) => withinWindow(session)) }
    } catch {
      /* leave the previous value in place */
    }
  }

  /**
   * Record a new title for a conversation everywhere it is cached, without a
   * refetch: the project that holds it as newest, and its recent list.
   *
   * The directory is preferred, but the v2 `session.renamed` frame carries it on
   * the envelope rather than the payload, so a caller that did not resolve one
   * still gets the title applied by matching the id across the cache.
   */
  function renameCached(directory: string | undefined, sessionID: string, title: string) {
    if (directory) {
      const existing = latest.value[directory]
      if (existing?.id === sessionID && existing.title !== title) {
        latest.value = { ...latest.value, [directory]: { ...existing, title } }
      }
      const list2 = recent.value[directory]
      if (list2?.some((item) => item.id === sessionID)) {
        recent.value = {
          ...recent.value,
          [directory]: list2.map((item) => (item.id === sessionID ? { ...item, title } : item)),
        }
      }
      return
    }
    for (const [key, session] of Object.entries(latest.value)) {
      if (session?.id === sessionID && session.title !== title) {
        latest.value = { ...latest.value, [key]: { ...session, title } }
      }
    }
    for (const [key, list] of Object.entries(recent.value)) {
      if (list.some((item) => item.id === sessionID)) {
        recent.value = {
          ...recent.value,
          [key]: list.map((item) => (item.id === sessionID ? { ...item, title } : item)),
        }
      }
    }
  }

  /**
   * Keep a project row on its newest conversation as session events arrive.
   *
   * `directory` is the frame's own `location`, which the caller reads off the
   * envelope. The payload alone is not enough: `session.created` carries its
   * location inside the payload, but `session.renamed`/`session.deleted` carry
   * it only on the frame.
   */
  function applyEvent(type: string, data: Record<string, unknown> | undefined, directory?: string) {
    if (!data) return
    const dir = directory ?? (data.location as { directory?: string } | undefined)?.directory
    if (type === "session.created" || type === "session.updated") {
      if (dir && !data.parentID) {
        const id = data.sessionID as string | undefined
        const existing = latest.value[dir]
        // Only track the newest; the event's partial info is enough to update
        // the row's title/time without a refetch.
        if (id && existing && existing.id === id) {
          latest.value = {
            ...latest.value,
            [dir]: { ...existing, title: (data.title as string) ?? existing.title },
          }
        }
        // A brand-new conversation is by definition recent, so it takes a
        // timestamp of its own; an update merges into a line only if it is
        // already listed, which keeps a stale conversation off the row.
        if (id) {
          const now = Date.now()
          rememberRecent(
            dir,
            type === "session.created"
              ? {
                  id,
                  title: data.title as string | undefined,
                  projectID: data.projectID as SessionInfo["projectID"],
                  time: { created: now, updated: now },
                }
              : { id, title: data.title as string | undefined },
          )
        }
      }
    } else if (type === "session.renamed") {
      // An auto-generated title arrives as its own event, not a `session.updated`.
      // Without this the sidebar keeps showing "Untitled" until the row is opened,
      // which is what refetches the session.
      const id = data.sessionID as string | undefined
      const title = data.title as string | undefined
      if (id && title) renameCached(dir, id, title)
    } else if (type === "session.deleted") {
      const id = data.sessionID as string | undefined
      if (id) {
        forgetChat(id)
        // The project's newest conversation takes the deleted one's place when
        // the recent list still knows a newer candidate.
        if (dir && latest.value[dir]?.id === id) {
          latest.value = { ...latest.value, [dir]: recent.value[dir]?.[0] ?? null }
        }
      }
    }
  }

  function reset() {
    latest.value = {}
    recent.value = {}
    loading.value = false
    missing.value = {}
  }

  return {
    entries,
    hiddenEntries,
    mostRecent,
    latest,
    recent,
    loading,
    /** The project the conversation pane is currently scoped to. */
    current: computed(() => directory.value ?? null),
    projectName,
    displayName,
    latestFor,
    recentFor,
    findSession,
    setLatest,
    forgetChat,
    forgetProject,
    isArchived,
    markMissing,
    clearMissing,
    load,
    refreshOne,
    applyEvent,
    reset,
  }
}
