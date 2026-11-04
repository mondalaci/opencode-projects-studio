import { computed, ref } from "vue"
import type { ServerClient } from "@/api/client"
import type { ModelRef, SessionInfo } from "@/api/types"

const DEFAULT_LIMIT = 50

const sessions = ref<SessionInfo[]>([])
const currentID = ref<string | null>(null)
const loading = ref(false)

function upsert(session: SessionInfo) {
  const index = sessions.value.findIndex((item) => item.id === session.id)
  if (index === -1) {
    sessions.value = [session, ...sessions.value]
  } else {
    const next = sessions.value.slice()
    next[index] = { ...next[index], ...session }
    sessions.value = next
  }
}

export function useSessions() {
  const current = computed(() => sessions.value.find((item) => item.id === currentID.value) ?? null)

  const sorted = computed(() =>
    [...sessions.value].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0)),
  )

  async function load(client: ServerClient, directory?: string, limit = DEFAULT_LIMIT) {
    loading.value = true
    try {
      const res = await client.listSessions({ directory, limit })
      sessions.value = res.data.filter((session) => !session.parentID)
    } finally {
      loading.value = false
    }
  }

  /** Query conversations without mutating the sidebar (used by the search page). */
  async function query(
    client: ServerClient,
    opts: { directory?: string; search?: string; limit?: number } = {},
  ) {
    const res = await client.listSessions({
      directory: opts.directory,
      limit: opts.limit ?? DEFAULT_LIMIT,
      search: opts.search,
    })
    return res.data.filter((session) => !session.parentID)
  }

  async function create(
    client: ServerClient,
    body: { title?: string; agent?: string; model?: ModelRef },
    directory?: string,
  ) {
    // v2 scopes creation through the body's `location`, not the query parameter.
    const session = await client.createSession({ ...body, location: directory ? { directory } : undefined }, { directory })
    if (!session) throw new Error("Session was not created")
    upsert(session)
    currentID.value = session.id
    return session
  }

  /** Drop a deleted conversation from the active list. */
  function forget(sessionID: string) {
    sessions.value = sessions.value.filter((item) => item.id !== sessionID)
    if (currentID.value === sessionID) currentID.value = null
  }

  async function rename(client: ServerClient, sessionID: string, title: string, directory?: string) {
    const session = await client.updateSession(sessionID, { title }, { directory })
    if (session) upsert(session)
    return session
  }

  /**
   * Apply a v2 session event. `session.created`/`session.updated` carry only a
   * partial session (id, title, location, projectID), so the existing row is
   * merged rather than replaced; a full row arrives from the list/get endpoints.
   * `session.renamed` is the event an auto-generated title arrives on, so the
   * open conversation's header picks it up without a `getSession` refetch.
   */
  function applyEvent(type: string, data: Record<string, unknown> | undefined) {
    if (!data) return
    if (type === "session.created" || type === "session.updated" || type === "session.renamed") {
      const id = data.sessionID as string | undefined
      if (!id) return
      const existing = sessions.value.find((item) => item.id === id)
      const directory = (data.location as { directory?: string } | undefined)?.directory
      // `session.renamed` is how an auto-generated title arrives; it carries only
      // the id and the title, so nothing is seeded from it here.
      const title = (data.title as string) ?? undefined
      if (existing) {
        if (title && title !== existing.title) upsert({ ...existing, title })
      } else if (type !== "session.renamed" && data.parentID === undefined) {
        // A brand-new root session: seed a minimal row; the list/get fills it in.
        sessions.value = [
          {
            id,
            projectID: data.projectID as string | undefined,
            title: data.title as string | undefined,
            agent: data.agent as string | undefined,
            location: { directory: directory ?? "" },
            time: { created: Date.now(), updated: Date.now() },
          },
          ...sessions.value,
        ]
      }
    } else if (type === "session.deleted") {
      const id = (data.sessionID as string) ?? (data.info as { id?: string } | undefined)?.id
      if (id) {
        sessions.value = sessions.value.filter((item) => item.id !== id)
        if (currentID.value === id) currentID.value = null
      }
    }
  }

  function reset() {
    sessions.value = []
    currentID.value = null
  }

  return {
    sessions,
    sorted,
    current,
    currentID,
    loading,
    load,
    query,
    create,
    forget,
    rename,
    applyEvent,
    reset,
    upsert,
  }
}
