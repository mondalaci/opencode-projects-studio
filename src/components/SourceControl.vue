<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { ArrowUp, LogOut, Minus, Plus } from "lucide-vue-next"
import FilterBar from "./FilterBar.vue"
import ShortcutBadge from "./ShortcutBadge.vue"
import WindowControls from "./WindowControls.vue"
import { filterOpen, stopFilter } from "@/stores/filter"
import { useApp } from "@/stores/app"
import { useGit, type GitRow } from "@/stores/git"
import { useServer } from "@/stores/server"
import { fuzzyMatch } from "@/utils/fuzzy"
import { splitPath } from "@/utils/diff"

const app = useApp()
const git = useGit()
const { repo, stagedRows, changeRows, total, loading, error, selection, available, unpushed } = git
const { locationInfo } = useServer()

/** Incremental filter over the changed files (Ctrl+P). */
const query = ref("")
/** Index into the file list that Enter opens. */
const cursor = ref(0)

/** Rows matching the query, by path. */
function matching(rows: GitRow[]): GitRow[] {
  const raw = query.value.trim()
  if (!raw) return rows
  const hits: Array<{ row: GitRow; score: number }> = []
  for (const row of rows) {
    const match = fuzzyMatch(raw, row.path)
    if (match) hits.push({ row, score: match.score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.map((hit) => hit.row)
}

const stagedFiltered = computed(() => matching(stagedRows.value))
const changeFiltered = computed(() => matching(changeRows.value))

/** The flat list, in render order: what the filter cursor walks. */
const fileOrder = computed<GitRow[]>(() => [...stagedFiltered.value, ...changeFiltered.value])

// A new query puts the cursor back on the best match.
watch(query, () => {
  cursor.value = 0
})

function moveCursor(delta: number) {
  cursor.value = Math.min(fileOrder.value.length - 1, Math.max(0, cursor.value + delta))
}

/** Enter: open the selected file for good and end the filter session. */
function openCursor() {
  const row = fileOrder.value[cursor.value]
  if (row) void git.open(row)
  keepPreview = true
  query.value = ""
  stopFilter()
}

/** Escape (or the clear button): end the session and drop the preview. */
function closeFilter() {
  keepPreview = false
  query.value = ""
  stopFilter()
}

/** Kept when the session ends through Enter, dropped when it ends through Escape. */
let keepPreview = false
/** Whether the filter session put a file in the centre pane. */
let previewing = false

/**
 * While the filter is open, the centre pane always shows the selected file, so
 * typing or arrowing through matches previews them without pressing Enter. The
 * preview is dropped when the session ends without a choice, which is what makes
 * Escape restore the conversation.
 */
watch(
  [filterOpen, () => cursor.value, fileOrder],
  () => {
    if (!filterOpen.value) {
      if (previewing && !keepPreview) git.closeDiff()
      previewing = false
      keepPreview = false
      return
    }
    const row = fileOrder.value[cursor.value]
    if (!row) return
    previewing = true
    void git.open(row)
  },
  { immediate: true },
)

/** Whether a file row is the one the filter cursor points at. */
function isCursor(row: GitRow) {
  const target = fileOrder.value[cursor.value]
  return Boolean(filterOpen.value && target && target.path === row.path && target.scope === row.scope)
}

/** Where diffs are read from: the repository root, or the project folder. */
const rootLabel = computed(() => repo.value.root ?? locationInfo.value?.directory ?? "")

/** Tooltip for the unpushed badge: how many commits, and where they are going. */
const unpushedTitle = computed(() => {
  const count = unpushed.value.count
  if (!count) return ""
  const where = unpushed.value.upstream ? `to ${unpushed.value.upstream}` : "to any remote"
  return `${count} ${count === 1 ? "commit" : "commits"} not pushed ${where}`
})

const emptyMessage = computed(() => {
  if (!available.value) return "Git integration is available in the desktop app."
  if (repo.value.reason === "git-not-installed") return "The git executable was not found on this system."
  if (repo.value.root && repo.value.reason === "not-a-repository") return "This project is not inside a git repository."
  return "Not inside a git repository."
})

const statusTitle: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Untracked",
  T: "Type changed",
}

function statusClass(status: string) {
  return {
    added: status === "A" || status === "U",
    deleted: status === "D",
    renamed: status === "R" || status === "C",
    modified: status === "M" || status === "T",
  }
}

function isSelected(row: GitRow) {
  return selection.value?.path === row.path && selection.value?.scope === row.scope
}

function toggle(row: GitRow) {
  if (row.group === "staged") void git.unstage(row)
  else void git.stage(row)
}

function reveal(row: GitRow) {
  const root = repo.value.root
  if (!root) return
  void window.opencodeDesktop?.shell.reveal(`${root}/${row.path}`)
}

/** Split a path for display: the directory dims and gives way to the file name. */
function parts(path: string) {
  return splitPath(path)
}
</script>

<template>
  <aside class="scm">
    <header class="scm-head drag-region">
      <span class="scm-title">Diff<ShortcutBadge placement="below" modifier="ctrl" key-label="P" /></span>
      <span
        v-if="repo.isRepo"
        class="count-pill"
        :title="`${total} uncommitted ${total === 1 ? 'change' : 'changes'}`"
      >{{ total }}</span>
      <span v-if="repo.isRepo && repo.branch" class="branch" :title="rootLabel ?? ''">{{ repo.branch }}</span>
      <!-- Committed but unpushed: invisible to the file list, so it gets its own
           badge — otherwise a clean tree looks identical to a fully pushed one. -->
      <span v-if="repo.isRepo && unpushed.count" class="unpushed-pill" :title="unpushedTitle">
        <ArrowUp :size="11" />{{ unpushed.count }}
      </span>
      <span class="head-spacer"></span>
      <!-- The panel cannot be hidden, so its header is always the rightmost
           strip of the window: that is where the window buttons live. -->
      <WindowControls />
    </header>

    <Transition name="filter-bar">
      <FilterBar
        v-if="filterOpen && (stagedRows.length || changeRows.length)"
        placeholder="Filter changed files…"
        :shown="stagedFiltered.length + changeFiltered.length"
        :total="total"
        @update:query="query = $event"
        @move="moveCursor"
        @open="openCursor"
        @close="closeFilter"
      />
    </Transition>

    <div v-if="!available || !repo.isRepo" class="notice">
      <p>{{ emptyMessage }}</p>
      <p v-if="available && !repo.isRepo && locationInfo" class="notice-path">{{ locationInfo.directory }}</p>
    </div>

    <div v-else class="body">
      <p v-if="error" class="error">{{ error }}</p>

      <section v-if="stagedFiltered.length" class="group">
        <div class="group-head">
          <span class="group-name">Staged Changes</span>
          <span class="group-count">{{ stagedFiltered.length }}</span>
        </div>
        <ul class="files">
          <li v-for="row in stagedFiltered" :key="`s:${row.path}`" class="file-row">
            <button
              class="file"
              :class="{ active: isSelected(row), cursor: isCursor(row) }"
              :title="`${statusTitle[row.status] ?? row.status}: ${row.path}`"
              @click="git.open(row)"
              @dblclick="reveal(row)"
            >
              <span class="status" :class="statusClass(row.status)">{{ row.status }}</span>
              <span class="file-path">
                <span v-if="parts(row.path).dir" class="file-dir">{{ parts(row.path).dir }}/</span>
                <span class="file-name">{{ parts(row.path).base }}</span>
              </span>
            </button>
            <button class="row-action" title="Unstage change" @click.stop="toggle(row)"><Minus :size="13" /></button>
          </li>
        </ul>
      </section>

      <section v-if="changeFiltered.length" class="group">
        <ul class="files" :class="{ 'files-first': !stagedFiltered.length }">
          <li v-for="row in changeFiltered" :key="`c:${row.path}`" class="file-row">
            <button
              class="file"
              :class="{ active: isSelected(row), cursor: isCursor(row) }"
              :title="`${statusTitle[row.status] ?? row.status}: ${row.path}`"
              @click="git.open(row)"
              @dblclick="reveal(row)"
            >
              <span class="status" :class="statusClass(row.status)">{{ row.status }}</span>
              <span class="file-path">
                <span v-if="parts(row.path).dir" class="file-dir">{{ parts(row.path).dir }}/</span>
                <span class="file-name">{{ parts(row.path).base }}</span>
              </span>
            </button>
            <button class="row-action" title="Stage change" @click.stop="toggle(row)"><Plus :size="13" /></button>
          </li>
        </ul>
      </section>

      <p v-if="!total && !loading" class="empty">No uncommitted changes.</p>
      <p v-else-if="filterOpen && !fileOrder.length" class="empty">Nothing matches “{{ query }}”.</p>
    </div>

    <footer class="scm-foot">
      <span v-if="repo.isRepo">
        {{ total }} {{ total === 1 ? "change" : "changes" }}
        <span v-if="repo.head" class="head">· {{ repo.head }}</span>
      </span>
      <button class="editor-icon" title="Disconnect" aria-label="Disconnect" @click="app.disconnect()">
        <LogOut :size="14" />
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.scm {
  width: var(--scm-width);
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
}
.scm-head {
  /* Above the list below it, so a key badge hanging past the header's edge stays
     visible instead of being painted over by the rows. */
  position: relative;
  z-index: 1;
  flex: none;
  /* Matches the conversation header height so the top strip is one band. */
  height: var(--header-height);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--border);
}
.scm-title {
  position: relative;
  /* The pills belong against the title, so it takes its own width and the space
     before the window controls is left to the spacer. */
  flex: none;
  min-width: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  /* No clipping: the key badge hangs below the label, and `overflow: hidden` would
     cut it off — which it did, invisibly, since the badge was still in the DOM. */
  overflow: visible;
  white-space: nowrap;
}
/* The change count, beside the title: what the removed group header used to say. */
.count-pill {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-active);
  border-radius: 999px;
  padding: 1px 7px;
  /* Like .unpushed-pill: the header is a drag region, which receives no hover. */
  -webkit-app-region: no-drag;
}
.head-spacer {
  flex: 1;
  min-width: 0;
}
.branch {
  flex: none;
  max-width: 40%;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-faint);
  background: var(--bg-hover);
  border-radius: 999px;
  padding: 1px 7px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Like .unpushed-pill: the header is a drag region, which receives no hover. */
  -webkit-app-region: no-drag;
}
/* Unpushed commits, beside the branch they belong to. Accent-tinted so it reads
   as "something to do" rather than as another piece of branch metadata. */
.unpushed-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 999px;
  padding: 1px 7px;
  /* The header is a window drag region, and a drag region receives no hover
     events — which is what a native `title` tooltip needs. Opting the pill out
     is what makes its tooltip appear. */
  -webkit-app-region: no-drag;
}
.notice {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px 16px;
  color: var(--text-muted);
  font-size: 12.5px;
}
.notice-path {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-faint);
  word-break: break-all;
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 10px;
}
.error {
  margin: 4px 12px 8px;
  font-size: 12px;
  color: var(--danger);
}
.group + .group {
  margin-top: 4px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px 4px 12px;
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-count {
  flex: none;
  font-variant-numeric: tabular-nums;
  background: var(--bg-active);
  color: var(--text-muted);
  border-radius: 999px;
  padding: 0 6px;
  font-size: 10.5px;
}
/* Without a group header above it, the list keeps its own top spacing. */
.files-first {
  padding-top: 6px;
}
.files {
  list-style: none;
  margin: 0;
  padding: 0 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.file-row {
  position: relative;
  display: flex;
  align-items: center;
}
.file {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: 12.5px;
}
.file:hover {
  background: var(--bg-hover);
}
.file.active {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
}
.file.cursor {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
}
.status {
  flex: none;
  width: 13px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}
.status.modified {
  color: var(--git-modified);
}
.status.added {
  color: var(--git-added);
}
.status.deleted {
  color: var(--git-deleted);
}
.status.renamed {
  color: var(--git-renamed);
}
/* The path keeps its own two-tone scheme — a dimmer directory leading to a bright
   file name — and the status is carried by the letter beside it. Colouring the
   name by status instead was tried and taken back out: it flattened the path and
   left every modified file the same shade. */
/* One row per file, showing its whole path. The parts share a single span so no
   flex gap falls inside the path, and the directory gives way first so the file
   name stays readable in a narrow panel. */
.file-path {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: baseline;
}
.file-dir {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 11.5px;
  /* The muted step: present, but clearly behind the file name it leads to. */
  color: var(--path-dir);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-name {
  flex: 0 0 auto;
  white-space: nowrap;
  /* White in the dark theme, black in the light one. */
  color: var(--path-name);
}
.row-action {
  position: absolute;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: var(--bg-active);
  color: var(--text-muted);
  opacity: 0;
}
.file-row:hover .row-action {
  opacity: 1;
}
.row-action:hover {
  color: var(--text);
}
.empty {
  padding: 26px 14px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-faint);
}
.scm-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px 4px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
}
.head {
  font-family: var(--font-mono);
}
</style>
