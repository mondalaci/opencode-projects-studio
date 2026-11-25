<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { Check, ChevronDown, Folder, FolderPlus, Search } from "lucide-vue-next"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import ShortcutBadge from "./ShortcutBadge.vue"
import type { ProjectEntry } from "@/stores/projects"
import { useApp } from "@/stores/app"
import { clearNotice, showNotice } from "@/stores/notice"
import { openRequests } from "@/stores/shortcuts"
import { fuzzyMatch } from "@/utils/fuzzy"

/**
 * The sidebar header's project switcher.
 *
 * The sidebar lists conversations rather than projects, so the project a chat
 * belongs to is chosen here — the same set of projects the old project list
 * held, including ones with no recent chat to show in the all-projects list.
 * Hidden projects stay out: the Hidden section is where they come back from.
 *
 * It searches as it is typed, with the same subsequence matching the sidebar
 * filters use: `opcpro` finds `opencode-projects-studio`, and a match in the
 * folder name sorts above one buried in the path. Adding a directory is the
 * list's last row, because a project is a thing the switcher manages.
 *
 * `Alt`+`P` opens it, which is also what the badge on the label says.
 */
const app = useApp()

/** Whether the popover is open, so the shortcut can open it too. */
const open = ref(false)

/** The incremental search term. */
const query = ref("")
/** Index into `rows` that Enter activates. */
const cursor = ref(0)

const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

/** The projects that can be opened from here. */
const projects = computed(() => app.projects.entries.value)

/** The open project's row, when it is one the picker lists. */
const current = computed(
  () => projects.value.find((entry) => entry.directory === app.server.directory.value) ?? null,
)

const label = computed(() => current.value?.name ?? "No project")

/**
 * The part of a directory a search looks at: the project's own folder and the two
 * above it.
 *
 * Searching the whole path would make every query match every project, since
 * they all live under the same parents (`/home/laci/projects/…`): `mon` spells
 * m-o-n through `/home` + `opencode`. From the family folder down, a query like
 * `uhk` still finds everything living under `projects/uhk`, which is the useful
 * part of the path.
 */
function searchablePath(directory: string): string {
  return directory.replace(/\/+$/, "").split("/").slice(-3).join("/")
}

/**
 * Projects matching the query: the name first, then the path from the family
 * folder down, so a folder search adds its projects behind the ones actually
 * named for the query.
 */
const matches = computed<ProjectEntry[]>(() => {
  const raw = query.value.trim()
  if (!raw) return projects.value

  const hits: Array<{ entry: ProjectEntry; score: number }> = []
  for (const entry of projects.value) {
    const byName = fuzzyMatch(raw, entry.name)
    if (byName) {
      hits.push({ entry, score: byName.score })
      continue
    }
    const byPath = fuzzyMatch(raw, searchablePath(entry.directory))
    if (byPath) hits.push({ entry, score: byPath.score - 40 })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.map((hit) => hit.entry)
})

/** What the keyboard walks: the matches, then the Add project row. */
type Row = { kind: "project"; entry: ProjectEntry } | { kind: "add" }
const rows = computed<Row[]>(() => [
  ...matches.value.map((entry) => ({ kind: "project" as const, entry })),
  { kind: "add" },
])

// A new query re-opens the cursor on the best match.
watch(query, () => {
  cursor.value = 0
})

/** Put the caret in the search field, which is where every open starts. */
function focusInput(event?: Event) {
  event?.preventDefault()
  inputEl.value?.focus()
}

// Opening starts a fresh search; closing forgets it, so the next open lists
// every project again.
watch(open, async (value) => {
  if (value) {
    query.value = ""
    cursor.value = 0
    await nextTick()
    focusInput()
    return
  }
  query.value = ""
})

// Alt+P: open the switcher (or close it again, since the key repeats while the
// popover holds the focus).
watch(
  () => openRequests.project,
  () => {
    open.value = !open.value
  },
)

function scrollCursorIntoView() {
  const items = listEl.value?.querySelectorAll<HTMLElement>(".picker-row")
  items?.[cursor.value]?.scrollIntoView({ block: "nearest" })
}

function move(delta: number) {
  cursor.value = Math.min(rows.value.length - 1, Math.max(0, cursor.value + delta))
  void nextTick(scrollCursorIntoView)
}

/** Open a project, or start the Add project flow, for the cursor's row. */
function activate() {
  const row = rows.value[cursor.value]
  if (!row) return
  if (row.kind === "add") {
    void addProject()
    return
  }
  choose(row.entry)
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault()
      move(1)
      break
    case "ArrowUp":
      event.preventDefault()
      move(-1)
      break
    case "Home":
      event.preventDefault()
      cursor.value = 0
      void nextTick(scrollCursorIntoView)
      break
    case "End":
      event.preventDefault()
      cursor.value = rows.value.length - 1
      void nextTick(scrollCursorIntoView)
      break
    case "Enter":
      event.preventDefault()
      activate()
      break
    case "Escape":
      // A query is cleared first; the popover closes on the next Escape.
      if (query.value) {
        event.preventDefault()
        event.stopPropagation()
        query.value = ""
        cursor.value = 0
      }
      break
    default:
      break
  }
}

function choose(entry: ProjectEntry) {
  if (entry.archived) return
  open.value = false
  void app.openProject(entry.directory)
}

/** Whether an "Add project" pick is running, so the row cannot be double-fired. */
const adding = ref(false)

/** Pick a directory and register it as a project, then open it. */
async function addProject() {
  if (adding.value) return
  open.value = false
  adding.value = true
  clearNotice()
  try {
    const result = await app.addProject()
    // A cancelled picker reports no error: there is nothing to say about it.
    if (!result.ok && result.error) showNotice(result.error)
  } catch (cause) {
    showNotice(cause instanceof Error ? cause.message : String(cause))
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child>
      <button
        class="picker"
        :title="app.server.directory.value ? `${label} — ${app.server.directory.value}` : 'Choose a project'"
      >
        <span class="picker-name">
          <span class="picker-label">{{ label }}</span>
          <ShortcutBadge placement="below" modifier="alt" key-label="P" />
        </span>
        <ChevronDown :size="13" class="picker-arrow" />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent class="picker-pop" :side-offset="6" align="start" @open-auto-focus="focusInput">
        <div class="picker-search">
          <Search :size="13" class="picker-search-icon" />
          <input
            ref="inputEl"
            v-model="query"
            class="picker-input"
            type="text"
            placeholder="Search projects…"
            spellcheck="false"
            autocomplete="off"
            aria-label="Search projects"
            @keydown="onKeydown"
          />
          <span class="picker-total" :title="`${matches.length} of ${projects.length} projects`">
            {{ matches.length }}/{{ projects.length }}
          </span>
        </div>

        <div ref="listEl" class="picker-list">
          <button
            v-for="(entry, index) in matches"
            :key="entry.directory"
            class="picker-row"
            :class="{
              'is-current': entry.directory === app.server.directory.value,
              'is-cursor': index === cursor,
              archived: entry.archived,
            }"
            :disabled="entry.archived"
            :title="entry.archived ? `${entry.directory} — its folder no longer exists` : entry.directory"
            @click="choose(entry)"
            @mouseenter="cursor = index"
          >
            <Folder :size="13" class="picker-row-icon" />
            <span class="picker-row-text">
              <span class="picker-row-name">{{ entry.name }}</span>
              <span class="picker-row-path">{{ entry.directory }}</span>
            </span>
            <span v-if="entry.archived" class="picker-archived">archived</span>
            <Check v-if="entry.directory === app.server.directory.value" :size="13" class="picker-check" />
          </button>

          <p v-if="!matches.length" class="picker-empty">
            {{ query.trim() ? `Nothing matches “${query.trim()}”.` : "No projects." }}
          </p>
        </div>

        <!-- Outside the scrolling list: adding a directory is the panel's other
             action, so it keeps its place however long the matches run. -->
        <button
          class="picker-row picker-add"
          :class="{ 'is-cursor': cursor === matches.length }"
          :disabled="adding"
          title="Register a directory as a project"
          @click="addProject"
          @mouseenter="cursor = matches.length"
        >
          <FolderPlus :size="13" class="picker-row-icon" />
          <span class="picker-row-name">Add project…</span>
        </button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<!-- Unscoped on purpose, like the model picker's: the popover is portalled to the
     body, so the scoped attribute never reaches it. Every class here is prefixed
     `picker-`, so nothing else can collide with it. -->
<style>
/* The header's subject is the project on screen, so the switcher takes the space
   the app name used to. */
.picker {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
}
.picker:hover {
  background: var(--bg-hover);
}
/* The label clips its own text; the badge below it must not be clipped with it,
   which is why the ellipsis lives on the inner span. */
.picker-name {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.picker-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.picker-arrow {
  flex: none;
  color: var(--text-faint);
}
/* The searchable list: the header's control, opened as a panel wide enough for
   the project paths the rows carry. */
.picker-pop {
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: min(320px, 90vw);
  padding: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  outline: none;
  animation: opencode-pop 0.12s ease;
}
.picker-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 7px;
  margin-bottom: 4px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}
.picker-search:focus-within {
  border-color: var(--accent);
}
.picker-search-icon {
  flex: none;
  color: var(--text-muted);
}
.picker-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
}
.picker-input::placeholder {
  color: var(--text-faint);
}
.picker-total {
  flex: none;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.picker-list {
  flex: 1;
  min-height: 0;
  max-height: min(55vh, 380px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.picker-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 5px 7px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
}
.picker-row:hover {
  background: var(--bg-hover);
}
/* The keyboard's row, so the arrows and the pointer show the same thing. */
.picker-row.is-cursor {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
.picker-row-icon {
  flex: none;
  color: var(--text-muted);
}
.picker-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.picker-row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
/* The path, because a project's folder name can be shared by several projects
   (`firmware` lives under two of the UHK ones). */
.picker-row-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-faint);
}
.picker-row.is-current .picker-row-name {
  color: var(--accent);
  font-weight: 600;
}
.picker-row.is-current .picker-row-icon,
.picker-check {
  color: var(--accent);
}
.picker-check {
  flex: none;
}
.picker-row.archived {
  opacity: 0.55;
}
.picker-archived {
  flex: none;
  padding: 0 5px;
  font-size: 9.5px;
  line-height: 14px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  background: var(--bg-active);
  border-radius: 7px;
}
/* Adding a directory is an action, not a project, so it sits under a rule below
   the list and keeps its place however the search narrows the list above it. */
.picker-add {
  flex: none;
  margin-top: 4px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  color: var(--text-muted);
}
.picker-add:hover {
  color: var(--text);
}
.picker-empty {
  margin: 0;
  padding: 8px 7px;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
