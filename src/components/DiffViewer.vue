<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { Columns2, RefreshCw, Rows3 } from "lucide-vue-next"
import DiffOverview from "./DiffOverview.vue"
import EditorHeader from "./EditorHeader.vue"
import Spinner from "./Spinner.vue"
import { useGit } from "@/stores/git"
import { changedRanges, expandToFullFile, hunksToRows, splitPath, toSplitRows, type ChangeRange, type DiffLine, type FileRow } from "@/utils/diff"
import { escapeHtml, highlightLines, languageForPath, wrapHtmlRanges } from "@/utils/highlight"

const git = useGit()
const { openDiff, selection } = git

/** Split (side-by-side) is the default, matching an editor's diff tab. */
const view = ref<"split" | "unified">("split")
const bodyEl = ref<HTMLElement | null>(null)

const diff = computed(() => openDiff.value)
const parsed = computed(() => diff.value?.parsed ?? null)
const hunks = computed(() => parsed.value?.hunks ?? [])
const path = computed(() => diff.value?.request.path ?? "")
const base = computed(() => splitPath(path.value).base)
const dir = computed(() => splitPath(path.value).dir)

const scopeLabel = computed(() => {
  switch (diff.value?.request.scope) {
    case "staged":
      return "Staged"
    case "untracked":
      return "Untracked"
    default:
      return "Unstaged"
  }
})

const hasContent = computed(() => Boolean(parsed.value && parsed.value.hunks.length))
const emptyNote = computed(() => {
  if (parsed.value?.binary) return "Binary file — no textual diff."
  if (parsed.value?.modeOnly) return "No textual changes (file mode changed only)."
  return "This file has no changes in this group."
})

/**
 * The whole file, both sides, wherever the main process could send both. An
 * editor's diff shows the file with the changes marked inside it rather than the
 * hunks alone, and so does this: the unchanged stretches between hunks come from
 * the file itself.
 *
 * When a side is too large or missing, the viewer falls back to the hunks with a
 * gap marker standing in for what is elided.
 */
const fileRows = computed(() => {
  const current = diff.value
  if (!current?.complete || typeof current.oldText !== "string" || typeof current.newText !== "string") return null
  return expandToFullFile(hunks.value, current.oldText, current.newText)
})

const rows = computed(() => fileRows.value ?? hunksToRows(hunks.value))
const showsWholeFile = computed(() => fileRows.value !== null)

/**
 * Highlighting runs over each side's whole text, indexed by line number. Doing it
 * per hunk instead would colour a block comment that spans a hunk boundary as
 * plain code.
 */
const highlighted = computed(() => {
  const current = diff.value
  const language = languageForPath(path.value)
  if (!language || !current?.complete) return null
  if (typeof current.oldText !== "string" || typeof current.newText !== "string") return null
  const old = highlightLines(current.oldText, language)
  const next = highlightLines(current.newText, language)
  if (!old || !next) return null
  return { old, new: next }
})

/**
 * The characters that changed inside each replaced row — the word-level half of
 * the change, on top of the row tint the whole line already carries. Every row
 * pairs a deletion with the addition that replaced it, which is the pairing the
 * split view stacks side by side and the unified view shows one above the other.
 */
const intra = computed(() => {
  const ranges = new Map<DiffLine, ChangeRange[]>()
  const shown = view.value === "split" ? rows.value.split : toSplitRows(rows.value.unified)
  for (const row of shown) {
    if (row.kind !== "line" || row.left?.type !== "del" || row.right?.type !== "add") continue
    const change = changedRanges(row.left.text, row.right.text)
    if (change.old.length) ranges.set(row.left, change.old)
    if (change.new.length) ranges.set(row.right, change.new)
  }
  return ranges
})

/**
 * The fragment for one cell, or null to render plain text. Syntax highlighting
 * comes first and the changed characters are marked inside it; a line the
 * highlighter passed over is escaped instead, so the marks can still go in. The
 * side matters: a deleted line only exists on the old side, an added one on the
 * new.
 */
function lineHtml(line: DiffLine | null | undefined, side: "old" | "new"): string | null {
  if (!line || line.type === "note" || line.type === "gap") return null

  const maps = highlighted.value
  const number = side === "old" ? line.oldNo : line.newNo
  const base =
    maps && number !== null && number !== undefined ? (side === "old" ? maps.old : maps.new)[number - 1] ?? null : null

  const ranges = intra.value.get(line)
  if (!ranges?.length) return base
  return wrapHtmlRanges(base ?? escapeHtml(line.text), ranges)
}

/** The cell class for a line, which is also what tints its line-number gutter. */
function cellClass(line: DiffLine | null | undefined): string {
  if (!line) return "line-empty"
  return line.type === "note" ? "line-note" : `line-${line.type}`
}

/** The sign that marks a row: `+`, `−`, or a space for context. */
function sign(line: DiffLine | null | undefined): string {
  if (!line || line.type === "note" || line.type === "gap") return " "
  if (line.type === "add") return "+"
  if (line.type === "del") return "−"
  return " "
}

/** A row of the split view carries a left and a right cell. */
function leftOf(row: FileRow): DiffLine | null {
  return row.kind === "line" ? row.left : null
}

function rightOf(row: FileRow): DiffLine | null {
  return row.kind === "line" ? row.right : null
}

/**
 * One mark per rendered row, for the change map: which rows removed lines, which
 * added them. Paired rows mark both, so a replaced line shows red and green.
 */
const marks = computed(() => {
  if (view.value === "split") {
    return rows.value.split.map((row) =>
      row.kind === "line"
        ? { del: leftOf(row)?.type === "del", add: rightOf(row)?.type === "add" }
        : { del: false, add: false },
    )
  }
  return rows.value.unified.map((line) => ({ del: line.type === "del", add: line.type === "add" }))
})

function close() {
  git.closeDiff()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && openDiff.value) {
    event.stopPropagation()
    close()
  }
}

// Reset the scroll only when a different file is shown; the periodic re-read of
// the open diff (which is what keeps it live) must not move the viewport.
watch(
  () => `${openDiff.value?.request.path ?? ""}\u0000${openDiff.value?.request.scope ?? ""}`,
  () => {
    bodyEl.value?.scrollTo({ top: 0 })
  },
)

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div v-if="diff" class="diff-view editor-code">
    <EditorHeader :path="path" @close="close">
      <template #path-extra>
        <span class="scope" :class="diff.request.scope">{{ scopeLabel }}</span>
        <span v-if="!showsWholeFile" class="elided" title="The file was too large to show in full">hunks only</span>
      </template>
      <template #actions>
        <div v-if="parsed" class="stat" :title="`${parsed.additions} added, ${parsed.deletions} removed`">
          <span class="add">+{{ parsed.additions }}</span>
          <span class="del">−{{ parsed.deletions }}</span>
        </div>
        <button
          class="editor-icon"
          :title="view === 'split' ? 'Switch to unified view' : 'Switch to split view'"
          @click="view = view === 'split' ? 'unified' : 'split'"
        >
          <Rows3 v-if="view === 'split'" :size="15" />
          <Columns2 v-else :size="15" />
        </button>
        <button class="editor-icon" title="Reload diff" @click="git.reloadDiff()"><RefreshCw :size="15" /></button>
      </template>
    </EditorHeader>

    <div v-if="diff.loading" class="state"><Spinner :size="18" /></div>
    <div v-else-if="diff.error" class="state error">{{ diff.error }}</div>
    <div v-else-if="!hasContent" class="state">{{ emptyNote }}</div>

    <div v-else class="diff-pane">
      <div ref="bodyEl" class="diff-body">
        <p v-if="diff.truncated" class="notice">Patch truncated — the diff is larger than the viewer shows.</p>

        <!-- Split: the two versions side by side, each half a gutter and its code. -->
        <table v-if="view === 'split'" class="grid split">
          <tbody>
            <tr v-for="(row, index) in rows.split" :key="index">
              <td v-if="row.kind !== 'line'" class="band" colspan="4">{{ row.text }}</td>
              <template v-else>
                <td class="num" :class="cellClass(leftOf(row))">{{ leftOf(row)?.oldNo ?? "" }}</td>
                <td :class="cellClass(leftOf(row))">
                  <span class="sign">{{ sign(leftOf(row)) }}</span><span
                    v-if="lineHtml(leftOf(row), 'old')"
                    v-html="lineHtml(leftOf(row), 'old')"
                  ></span><template v-else>{{ leftOf(row)?.text ?? "" }}</template>
                </td>
                <td class="num" :class="cellClass(rightOf(row))">{{ rightOf(row)?.newNo ?? "" }}</td>
                <td :class="cellClass(rightOf(row))">
                  <span class="sign">{{ sign(rightOf(row)) }}</span><span
                    v-if="lineHtml(rightOf(row), 'new')"
                    v-html="lineHtml(rightOf(row), 'new')"
                  ></span><template v-else>{{ rightOf(row)?.text ?? "" }}</template>
                </td>
              </template>
            </tr>
          </tbody>
        </table>

        <!-- Unified: one column, with both numbers in the gutter. -->
        <table v-else class="grid unified">
          <tbody>
            <tr v-for="(line, index) in rows.unified" :key="index">
              <td v-if="line.type === 'note' || line.type === 'gap'" class="band" colspan="3">{{ line.text }}</td>
              <template v-else>
                <td class="num" :class="cellClass(line)">{{ line.oldNo ?? "" }}</td>
                <td class="num" :class="cellClass(line)">{{ line.newNo ?? "" }}</td>
                <td :class="cellClass(line)">
                  <span class="sign">{{ sign(line) }}</span><span
                    v-if="lineHtml(line, line.type === 'del' ? 'old' : 'new')"
                    v-html="lineHtml(line, line.type === 'del' ? 'old' : 'new')"
                  ></span><template v-else>{{ line.text }}</template>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <DiffOverview :marks="marks" :body="bodyEl" />
    </div>

    <footer v-if="selection" class="diff-foot">
      <span class="foot-path" :title="selection.path">{{ selection.path }}</span>
      <span v-if="selection.origPath" class="foot-rename">renamed from {{ selection.origPath }}</span>
    </footer>
  </div>
</template>

<style scoped>
.diff-view {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.scope {
  flex: none;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
}
.scope.staged {
  color: var(--git-added);
  border-color: color-mix(in srgb, var(--git-added) 45%, transparent);
}
.elided {
  flex: none;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.stat {
  flex: none;
  display: flex;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.stat .add {
  color: var(--git-added);
}
.stat .del {
  color: var(--git-deleted);
}
.state {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 24px;
}
.state.error {
  color: var(--danger);
}
/* The pane holds the scrolling diff and the change map over its right edge. */
.diff-pane {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.diff-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 0 0 24px;
  /* Room for the change map, which is opaque and would otherwise sit on the code. */
  padding-right: 11px;
}
.notice {
  margin: 10px 14px;
  font-size: 12px;
  color: var(--accent);
}
table.grid {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
}
/* Equal halves, like an editor's side-by-side diff: a gutter and a code column
   per side, with the two code columns sharing what is left evenly. */
table.split {
  table-layout: fixed;
}
/* Only the gutters are fixed. The rule that used to sit here set `width: auto` on
   every cell, which out-specifies `td.num`, and with a fixed layout four auto
   columns take a quarter each — so the two gutters ate half the width. Leaving the
   code cells auto lets them share what the gutters do not use, evenly. */
table.split td.num {
  position: relative;
  width: 52px;
}
table.split tr > td:nth-child(2) {
  border-right: 1px solid var(--border);
}
table.grid td {
  padding: 0 8px 0 4px;
  vertical-align: top;
  border: none;
  /* Long lines wrap inside their own half rather than being cut off. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* The gutter carries the change colour more strongly than the code, which is
   what makes a changed row read as one band across the pair. */
td.num {
  width: 52px;
  padding-right: 8px;
  text-align: right;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  user-select: none;
  background: var(--bg);
  border-right: 1px solid var(--border);
}
td.num.line-add {
  background: rgba(53, 192, 106, 0.34);
}
td.num.line-del {
  background: rgba(239, 107, 107, 0.34);
}
/* The change bar: a saturated stripe on the outer edge of the gutter, so the
   changed region is legible even where the row's tint is faint. */
td.num.line-add::before,
td.num.line-del::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
}
td.num.line-add::before {
  background: var(--git-added);
}
td.num.line-del::before {
  background: var(--git-deleted);
}
td.line-context {
  color: var(--text);
}
td.line-add {
  background: rgba(53, 192, 106, 0.13);
  color: var(--text);
}
td.line-del {
  background: rgba(239, 107, 107, 0.13);
  color: var(--text);
}
/*
 * The characters that changed inside a replaced line, a step deeper than the
 * row's tint so the edit itself stands out from the rest of the line. The spans
 * come from injected `v-html`, so the rule has to pierce the scope attribute the
 * component's own elements carry.
 */
.diff-view :deep(.intra) {
  background: rgba(53, 192, 106, 0.42);
}
.diff-view :deep(td.line-del .intra) {
  background: rgba(239, 107, 107, 0.42);
}
td.line-empty {
  background: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 6px,
    color-mix(in srgb, var(--border) 45%, transparent) 6px,
    color-mix(in srgb, var(--border) 45%, transparent) 7px
  );
}
td.line-note {
  color: var(--text-faint);
  font-style: italic;
}
td.band {
  padding: 2px 12px;
  font-size: 11px;
  color: var(--text-faint);
  background: color-mix(in srgb, var(--bg) 88%, var(--accent));
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  white-space: pre;
}
.sign {
  display: inline-block;
  width: 1ch;
  color: var(--text-faint);
  user-select: none;
}
td.line-add .sign {
  color: var(--git-added);
}
td.line-del .sign {
  color: var(--git-deleted);
}
td.line-note .sign,
td.line-empty .sign {
  color: transparent;
}
.diff-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 11px;
  color: var(--text-faint);
}
.foot-path {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.foot-rename {
  flex: none;
  color: var(--accent);
}
</style>
