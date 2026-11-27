<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { Folder, Globe, Search, X } from "lucide-vue-next"
import { searchContent, searchHealth, listAllSessions, listSessionsPage } from "@/api/search"
import { sessionDirectory } from "@/api/types"
import { useApp } from "@/stores/app"
import { closeSearch, searchScope, toggleSearchScope } from "@/stores/search"
import { relativeTime } from "@/utils/format"

const app = useApp()
const client = app.connection.client
const directory = app.server.directory

/** Unified result row, whether it came from content search or title search. */
interface Hit {
  id: string
  title: string
  updated?: number
  snippet?: string
  /** The project the conversation lives in, shown when the search spans all of them. */
  directory?: string
}

/**
 * The scope the search actually runs in.
 *
 * "Project" needs a project to point at; with none open (the server has no
 * directory) there is nothing to narrow to, so the search covers everything
 * rather than pretending to be scoped.
 */
const scope = computed(() => (searchScope.value === "project" && directory.value ? "project" : "all"))

/** The directory to narrow to, or `undefined` when the search covers every project. */
function scopedDirectory(): string | undefined {
  return scope.value === "project" ? directory.value || undefined : undefined
}

/** The project's display name for a result row. */
function projectLabel(path: string | undefined): string {
  return app.projects.displayName(path)
}

const query = ref("")
const hits = ref<Hit[]>([])
const loading = ref(false)
/** Which backend answered the last (or an initial probe) search. */
const mode = ref<"unknown" | "content" | "fallback">("unknown")
/** Total conversations known to the search service. */
const total = ref<number | null>(null)
/** When true, the list shows every conversation instead of search results. */
const all = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const resultsEl = ref<HTMLElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)
/** Index of the keyboard-highlighted result, or -1. */
const navIndex = ref(-1)

let debounce: ReturnType<typeof setTimeout> | null = null
/** Guards against out-of-order responses from rapid typing. */
let requestSeq = 0

function titleHits(list: Awaited<ReturnType<typeof app.sessions.query>>): Hit[] {
  return list.map((session) => ({
    id: session.id,
    title: session.title || "Untitled",
    updated: session.time?.updated ?? session.time?.created,
    directory: sessionDirectory(session),
  }))
}

/** How many conversations the service holds for the current scope. */
async function scopedTotal(): Promise<number | null> {
  try {
    return (await listSessionsPage(0, 1, 5000, scopedDirectory())).total
  } catch {
    return null
  }
}

/** The conversations shown before anything is typed. */
async function recent(active: typeof client.value): Promise<Hit[]> {
  if (scope.value === "project") {
    return active ? titleHits(await app.sessions.query(active, { directory: directory.value, limit: 100 })) : []
  }
  // Every project's newest conversations, straight from the service when it is
  // up — the same list "List all" pages through.
  try {
    const page = await listSessionsPage(0, 100)
    return page.results.map((hit) => ({
      id: hit.sessionID,
      title: hit.title || "Untitled",
      updated: hit.updated,
      directory: hit.directory,
    }))
  } catch {
    return active ? titleHits(await app.sessions.query(active, { limit: 100 })) : []
  }
}

async function run(raw: string) {
  const active = client.value
  const search = raw.trim()
  const seq = ++requestSeq
  all.value = false
  loading.value = true
  try {
    if (!search) {
      hits.value = await recent(active)
    } else {
      let done = false
      try {
        const results = await searchContent(search, 30, scopedDirectory())
        if (seq !== requestSeq) return
        hits.value = results.map((hit) => ({
          id: hit.sessionID,
          title: hit.title || "Untitled",
          updated: hit.updated,
          snippet: hit.snippet,
          directory: hit.directory,
        }))
        mode.value = "content"
        done = true
      } catch {
        // Service offline: fall back to server title search below.
        mode.value = "fallback"
      }
      if (!done) {
        const list = active
          ? await app.sessions.query(active, { directory: scopedDirectory(), search, limit: 100000 })
          : []
        if (seq !== requestSeq) return
        hits.value = titleHits(list)
      }
    }
    navIndex.value = hits.value.length ? 0 : -1
    void nextTick(() => resultsEl.value?.scrollTo({ top: 0 }))
  } catch {
    if (seq === requestSeq) hits.value = []
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/** Load and display every conversation in the current scope, newest first. */
async function showAll() {
  const active = client.value
  const seq = ++requestSeq
  all.value = true
  query.value = ""
  loading.value = true
  try {
    let list: Hit[] = []
    try {
      const page = await listAllSessions(2000, scopedDirectory())
      list = page.results.map((hit) => ({
        id: hit.sessionID,
        title: hit.title || "Untitled",
        updated: hit.updated,
        directory: hit.directory,
      }))
      total.value = page.total
      mode.value = "content"
    } catch {
      mode.value = "fallback"
      if (active) list = titleHits(await app.sessions.query(active, { directory: scopedDirectory(), limit: 100000 }))
      total.value = list.length
    }
    if (seq !== requestSeq) return
    hits.value = list
    navIndex.value = list.length ? 0 : -1
    void nextTick(() => resultsEl.value?.scrollTo({ top: 0 }))
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(query, (value) => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void run(value), 200)
})

// A scope switch re-answers the question on screen: the list the reader is
// looking at either narrows to this project or widens to every project.
watch(scope, () => {
  if (all.value) void showAll()
  else void run(query.value)
  void scopedTotal().then((count) => {
    if (count != null) total.value = count
  })
})

onMounted(() => {
  inputEl.value?.focus()
  window.addEventListener("keydown", onWindowKeydown)
  void searchHealth().then(async (health) => {
    if (health) {
      mode.value = "content"
      total.value = await scopedTotal()
    } else {
      mode.value = "fallback"
    }
  })
  void run("")
})

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown)
  if (debounce) clearTimeout(debounce)
  requestSeq++
})

const heading = computed(() => {
  const base = all.value ? "All conversations" : query.value.trim() ? "Results" : "Recent conversations"
  return all.value || scope.value === "project" ? base : `${base} · all projects`
})

const scopeTitle = computed(() => {
  if (!directory.value) return "No project is open — searching every project"
  return scope.value === "project"
    ? "Searching this project — click to search every project"
    : "Searching every project — click to search only this project"
})

const modeLabel = computed(() =>
  mode.value === "content" ? "Content search" : mode.value === "fallback" ? "Fallback · titles" : "Checking…",
)
const modeTitle = computed(() =>
  mode.value === "content"
    ? "Using the local content-search service (FTS5/BM25 over message text)"
    : mode.value === "fallback"
      ? "The content-search service is unreachable — matching conversation titles on the server"
      : "Checking the local content-search service…",
)

async function open(hit: Hit) {
  // Keep the results open: the session loads in the main pane behind the
  // sidebar, and search closes only when the user explicitly closes it.
  await app.openSessionByID(hit.id)
  // Restore focus to the field so arrow-key navigation keeps working.
  await nextTick()
  inputEl.value?.focus()
}

function scrollNavIntoView() {
  const items = resultsEl.value?.querySelectorAll<HTMLElement>(".result")
  items?.[navIndex.value]?.scrollIntoView({ block: "nearest" })
}

function move(delta: number) {
  navIndex.value = Math.min(hits.value.length - 1, Math.max(0, navIndex.value + delta))
  void nextTick(scrollNavIntoView)
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "Escape":
      event.preventDefault()
      closeSearch()
      break
    case "ArrowDown":
      event.preventDefault()
      move(1)
      break
    case "ArrowUp":
      event.preventDefault()
      move(-1)
      break
    case "Enter": {
      // A focused button (the scope chip, a result row, "List all") activates
      // itself on Enter; only the input's Enter opens the highlighted result.
      const active = document.activeElement
      if (active instanceof HTMLElement && active.tagName === "BUTTON") return
      event.preventDefault()
      const hit = hits.value[navIndex.value]
      if (hit) void open(hit)
      break
    }
    default:
      break
  }
}

/**
 * Keyboard navigation is bound at the window level (guarded) so arrow keys keep
 * working even after focus leaves the search subtree, e.g. after clicking a
 * result. Keys are ignored while another input/editable element holds focus.
 */
function onWindowKeydown(event: KeyboardEvent) {
  const active = document.activeElement
  const inside = active != null && rootEl.value?.contains(active)
  const onBody = active == null || active === document.body
  if (!inside && !onBody) return
  onKeydown(event)
}
</script>

<template>
  <div ref="rootEl" class="sidebar-search" role="search" aria-label="Search conversations">
    <header class="search-head">
      <div class="search-field" :title="modeTitle">
        <Search :size="15" class="search-icon" />
        <input
          ref="inputEl"
          v-model="query"
          class="search-input"
          type="search"
          placeholder="Search conversations…"
          spellcheck="false"
          autocomplete="off"
        />
        <button v-if="query" class="clear" title="Clear" @click="query = ''"><X :size="14" /></button>
      </div>
      <button class="scope" :class="scope" :title="scopeTitle" :disabled="!directory" @click="toggleSearchScope()">
        <Folder v-if="scope === 'project'" :size="13" />
        <Globe v-else :size="13" />
        <span>{{ scope === "project" ? "Project" : "All" }}</span>
      </button>
      <button class="close" title="Close search (Esc)" @click="closeSearch()"><X :size="16" /></button>
    </header>

    <div class="results-head">
      <span class="mode-dot" :class="mode" :title="modeTitle"></span>
      <span class="heading">{{ heading }}</span>
      <span class="mode-label" :class="mode" :title="modeTitle">{{ modeLabel }}</span>
      <span v-if="loading" class="loading">searching…</span>
      <span v-else-if="hits.length" class="count">{{ hits.length }}</span>
    </div>

    <div ref="resultsEl" class="results">
      <button
        v-for="(hit, index) in hits"
        :key="hit.id"
        class="result"
        :class="{ active: index === navIndex, current: hit.id === app.sessions.currentID.value }"
        @click="open(hit)"
        @mouseenter="navIndex = index"
      >
        <span class="result-line">
          <span class="result-title">{{ hit.title }}</span>
          <span class="result-time">{{ relativeTime(hit.updated) }}</span>
        </span>
        <span v-if="hit.snippet || (scope === 'all' && hit.directory)" class="result-sub">
          <span v-if="scope === 'all' && hit.directory" class="result-project" :title="hit.directory">
            {{ projectLabel(hit.directory) }}
          </span>
          <span v-if="hit.snippet" class="result-snippet">{{ hit.snippet }}</span>
        </span>
      </button>

      <p v-if="!loading && !hits.length" class="empty">
        {{
          query.trim()
            ? `No conversations match “${query.trim()}”${scope === "project" ? " in this project" : " in any project"}.`
            : "No conversations yet."
        }}
      </p>
    </div>

    <footer class="search-foot">
      <span class="total">{{ total == null ? "—" : `${total.toLocaleString()} conversations` }}</span>
      <button class="browse" :disabled="loading || all" @click="showAll">List all</button>
    </footer>
  </div>
</template>

<style scoped>
.sidebar-search {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.search-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 10px 6px;
}
.search-field {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}
.search-field:focus-within {
  border-color: var(--accent);
}
.search-icon {
  flex: none;
  color: var(--text-muted);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
}
.search-input::-webkit-search-cancel-button {
  display: none;
}
.clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 3px;
  border-radius: 5px;
}
.clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 6px;
  border-radius: var(--radius-sm);
}
.close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
/* The scope toggle: which projects the search covers. */
.scope {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 11.5px;
  white-space: nowrap;
}
.scope:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.scope:disabled {
  color: var(--text-faint);
  cursor: default;
}
.scope:disabled:hover {
  background: transparent;
}
.scope.all {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--accent);
}
.results-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 12px 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.results-head .loading,
.results-head .count {
  text-transform: none;
  letter-spacing: 0;
}
.results-head .heading {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mode-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.mode-dot.content {
  background: #35c06a;
}
.mode-dot.fallback {
  background: var(--accent);
}
.mode-label {
  flex: none;
  text-transform: none;
  letter-spacing: 0;
  font-size: 10.5px;
  color: var(--text-faint);
}
.mode-label.content {
  color: #35c06a;
}
.mode-label.fallback {
  color: var(--accent);
}
.results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px 12px;
}
.result {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  padding: 7px 9px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
}
.result:hover {
  background: var(--bg-hover);
}
.result.active,
.result.active:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
/* The open session is marked on its title, not with an outline. */
.result.current .result-title {
  color: var(--accent);
  font-weight: 600;
}
.result-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.result-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result-time {
  flex: none;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.result-sub {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
/* The project a result belongs to, shown only when the search spans projects. */
.result-project {
  flex: none;
  max-width: 45%;
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result-snippet {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 12.5px;
  padding: 28px 6px;
}
.search-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-faint);
}
.browse {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11.5px;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
}
.browse:hover:not(:disabled) {
  background: var(--bg-hover);
}
.browse:disabled {
  color: var(--text-faint);
  cursor: default;
}
</style>
