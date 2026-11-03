import { computed, ref } from "vue"
import type { ServerClient } from "@/api/client"
import { ROOT_DIRECTORY, sessionDirectory, type ProjectInfo, type SessionInfo } from "@/api/types"
import { useHiddenProjects } from "./hiddenProjects"
import { useServer } from "./server"

/**
 * Per-project state for the sidebar.
 *
 * The sidebar lists every project the server knows about with a single
 * conversation each — the newest one — so this store keeps one "latest session"
 * per project directory. Session events feed `applyEvent` so the row keeps
 * tracking the newest conversation without a refetch.
 */

const latest = ref<Record<string, SessionInfo | null>>({})
const loading = ref(false)
const loaded = ref(false)
/** How many projects still need their newest conversation fetched. */
const pending = ref(0)

/** Conversations fetched per page when an expanded project row loads. */
const CHATS_PAGE_SIZE = 100
/**
 * Guard against a cursor that never terminates, not a limit on the project: at
 * the server's page size this covers thousands of conversations.
 */
const CHATS_MAX_PAGES = 50

/** Project directories whose full conversation list is expanded in the sidebar. */
const expanded = ref<Record<string, true>>({})
/** Every conversation of a project, once its row has been expanded. */
const chats = ref<Record<string, SessionInfo[]>>({})
/** Projects whose conversation list is currently being fetched. */
const chatsPending = ref<Record<string, true>>({})
/** How many conversations each project holds, once it has been counted. */
const counts = ref<Record<string, number>>({})

/** A project together with the conversation the sidebar shows for it. */
export interface ProjectEntry {
  directory: string
  name: string
  project: ProjectInfo
  session: SessionInfo | null
  /**
   * The project is archived on the server: its folder no longer exists, so
   * opencode swept it out of the active list. Past conversations stay readable,
   * but nothing new can run in it.
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

/**
 * Every root conversation of a project, newest first.
 *
 * A directory can hold more conversations than one page, so the cursor is
 * followed to the end. Subagents are excluded at the server with
 * `parentID=null`, so the pages carry only the conversations the sidebar lists
 * and counts.
 */
async function fetchRoots(client: ServerClient, directory: string): Promise<SessionInfo[]> {
  const all = new Map<string, SessionInfo>()
  let cursor: string | undefined
  for (let page = 0; page < CHATS_MAX_PAGES; page++) {
    const res = await client.listSessions({
      directory,
      limit: CHATS_PAGE_SIZE,
      archived: false,
      parentID: "null",
      cursor,
    })
    for (const session of res.data) {
      if (!session.parentID) all.set(session.id, session)
    }
    const next = res.cursor?.next
    if (!next || res.data.length === 0) break
    cursor = next
  }
  return rootsByNewest([...all.values()])
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
        archived: Boolean(project.time?.archived),
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

  /** Whether a project is archived (its folder no longer exists on the server). */
  function isArchived(target: string | null | undefined): boolean {
    if (!target) return false
    return allEntries.value.some((entry) => entry.directory === target && entry.archived)
  }

  /** Conversation shown for a project, if one is known. */
  function latestFor(target: string | null | undefined): SessionInfo | null {
    if (!target) return null
    return latest.value[target] ?? null
  }

  /** Register a freshly created or updated conversation as a project's newest. */
  function setLatest(target: string | null | undefined, session: SessionInfo) {
    if (!target || session.parentID) return
    upsertChat(target, session)
    const current = latest.value[target]
    const next = session.time?.updated ?? session.time?.created ?? 0
    const existing = current?.time?.updated ?? current?.time?.created ?? 0
    if (!current || next >= existing) latest.value = { ...latest.value, [target]: session }
  }

  /**
   * Keep an expanded project's conversation list current. A no-op until the
   * list has actually been fetched, so only expanded rows pay for it.
   */
  function upsertChat(directory: string, session: SessionInfo) {
    const list = chats.value[directory]
    if (!list) return
    const index = list.findIndex((item) => item.id === session.id)
    const next =
      index === -1 ? [session, ...list] : list.map((item, i) => (i === index ? { ...item, ...session } : item))
    chats.value = { ...chats.value, [directory]: rootsByNewest(next) }
  }

  /** Drop a deleted conversation from every expanded list. */
  function forgetChat(sessionID: string) {
    let changed = false
    const next: Record<string, SessionInfo[]> = {}
    for (const [directory, list] of Object.entries(chats.value)) {
      if (list.some((item) => item.id === sessionID)) {
        next[directory] = list.filter((item) => item.id !== sessionID)
        changed = true
      } else {
        next[directory] = list
      }
    }
    if (changed) chats.value = next
  }

  /** Forget everything cached for a project that no longer exists. */
  function forgetProject(directory: string) {
    if (directory in latest.value) {
      const next = { ...latest.value }
      delete next[directory]
      latest.value = next
    }
    if (directory in chats.value) {
      const next = { ...chats.value }
      delete next[directory]
      chats.value = next
    }
    if (directory in counts.value) {
      const next = { ...counts.value }
      delete next[directory]
      counts.value = next
    }
    collapse(directory)
  }

  /** How many conversations a project holds, or `undefined` until it is counted. */
  function countFor(directory: string): number | undefined {
    return counts.value[directory]
  }

  /** Record a conversation this client just created, without a refetch. */
  function recordCreated(directory: string | null | undefined) {
    if (!directory) return
    const current = counts.value[directory]
    if (current === undefined) return
    counts.value = { ...counts.value, [directory]: current + 1 }
  }

  /** Whether a project row is showing its conversation list. */
  function isExpanded(directory: string) {
    return expanded.value[directory] === true
  }

  /** The conversations loaded for an expanded project, newest first. */
  function chatsFor(directory: string) {
    return chats.value[directory] ?? []
  }

  /** Whether an expanded project's conversation list is still loading. */
  function isChatsLoading(directory: string) {
    return chatsPending.value[directory] === true
  }

  /** Fetch a project's whole conversation list (once) for its expanded row. */
  async function loadChats(client: ServerClient, directory: string) {
    if (chatsPending.value[directory]) return
    chatsPending.value = { ...chatsPending.value, [directory]: true }
    try {
      const roots = await fetchRoots(client, directory)
      chats.value = { ...chats.value, [directory]: roots }
      counts.value = { ...counts.value, [directory]: roots.length }
    } catch {
      /* leave whatever was there (usually nothing) in place */
    } finally {
      const next = { ...chatsPending.value }
      delete next[directory]
      chatsPending.value = next
    }
  }

  /** Collapse a project row (its loaded list is kept for the next expand). */
  function collapse(directory: string) {
    if (!(directory in expanded.value)) return
    const next = { ...expanded.value }
    delete next[directory]
    expanded.value = next
  }

  /** Expand or collapse a project row, fetching its conversations on expand. */
  async function toggleExpanded(client: ServerClient, directory: string) {
    if (isExpanded(directory)) {
      collapse(directory)
      return
    }
    expanded.value = { ...expanded.value, [directory]: true }
    if (!chats.value[directory]) await loadChats(client, directory)
  }

  /**
   * Fetch every project's conversations, so each row knows both its newest
   * conversation and how many it holds.
   *
   * The session endpoint is scoped by `directory`, so this is one (paginated)
   * request per project, capped to a handful in flight.
   */
  async function load(client: ServerClient) {
    loading.value = true
    // The root placeholder is not a project the sidebar shows, so it is not
    // fetched for either — and nothing ends up pointing the app at `/`.
    const list = projects.value.filter((project) => project.canonical !== ROOT_DIRECTORY)
    pending.value = list.length
    try {
      const results = await mapLimit(list, 6, async (project) => {
        try {
          // The whole list is read, not just the newest page, because the row
          // carries the project's conversation count as well as its newest one.
          const roots = await fetchRoots(client, project.canonical)
          return [project.canonical, roots] as const
        } catch {
          return [project.canonical, [] as SessionInfo[]] as const
        } finally {
          pending.value = Math.max(0, pending.value - 1)
        }
      })
      const next: Record<string, SessionInfo | null> = {}
      const nextCounts: Record<string, number> = {}
      for (const [worktree, roots] of results) {
        next[worktree] = roots[0] ?? null
        nextCounts[worktree] = roots.length
      }
      latest.value = next
      counts.value = nextCounts
      loaded.value = true
    } finally {
      loading.value = false
      pending.value = 0
    }
  }

  /** Re-read one project's newest conversation and count (after a change, say). */
  async function refreshOne(client: ServerClient, target: string) {
    if (target === ROOT_DIRECTORY) return
    try {
      const roots = await fetchRoots(client, target)
      latest.value = { ...latest.value, [target]: roots[0] ?? null }
      counts.value = { ...counts.value, [target]: roots.length }
    } catch {
      /* leave the previous value in place */
    }
  }

  /** Keep a project row on its newest conversation as session events arrive. */
  function applyEvent(type: string, data: Record<string, unknown> | undefined) {
    if (!data) return
    if (type === "session.created" || type === "session.updated") {
      const directory = (data.location as { directory?: string } | undefined)?.directory
      if (directory && !data.parentID) {
        const existing = latest.value[directory]
        // Only track the newest; the event's partial info is enough to update
        // the row's title/time without a refetch.
        if (existing && existing.id === (data.sessionID as string)) {
          latest.value = {
            ...latest.value,
            [directory]: { ...existing, title: (data.title as string) ?? existing.title },
          }
        }
      }
    } else if (type === "session.deleted" || type === "session.archived") {
      const id = data.sessionID as string | undefined
      const directory = (data.location as { directory?: string } | undefined)?.directory
      if (id) {
        forgetChat(id)
        if (directory && latest.value[directory]?.id === id) {
          const remaining = chats.value[directory]
          latest.value = {
            ...latest.value,
            [directory]: remaining?.length ? rootsByNewest(remaining)[0] : null,
          }
        }
      }
    }
  }

  function reset() {
    latest.value = {}
    loaded.value = false
    pending.value = 0
    loading.value = false
    expanded.value = {}
    chats.value = {}
    chatsPending.value = {}
    counts.value = {}
  }

  return {
    entries,
    hiddenEntries,
    mostRecent,
    latest,
    loading,
    loaded,
    pending,
    /** The project the conversation pane is currently scoped to. */
    current: computed(() => directory.value ?? null),
    projectName,
    latestFor,
    setLatest,
    forgetChat,
    forgetProject,
    isExpanded,
    chatsFor,
    isChatsLoading,
    countFor,
    isArchived,
    recordCreated,
    loadChats,
    collapse,
    toggleExpanded,
    load,
    refreshOne,
    applyEvent,
    reset,
    sessionDirectory,
  }
}
