/**
 * Unified-diff parsing and split-view alignment.
 *
 * The patch text comes from `git diff`, so it is already in unified format; the
 * job here is to turn it into rows a viewer can render with line numbers, both
 * as a single column ("unified") and as old/new columns ("split"). The last
 * piece is the word-level diff of a replaced pair, which is what lets the viewer
 * mark the characters that changed inside the lines.
 */

export type DiffLineType = "context" | "add" | "del" | "note" | "gap"

export interface DiffLine {
  type: DiffLineType
  /** Line content without the leading +/-/space marker. */
  text: string
  /** 1-based line number in the old file, or null for added lines. */
  oldNo: number | null
  /** 1-based line number in the new file, or null for deleted lines. */
  newNo: number | null
}

export interface DiffHunk {
  header: string
  /** The trailing function/section name git prints after the range. */
  section?: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface ParsedDiff {
  oldPath?: string
  newPath?: string
  /** `--git a/x b/y`, `new file mode`, … in order, for the meta strip. */
  meta: string[]
  hunks: DiffHunk[]
  additions: number
  deletions: number
  binary: boolean
  /** A mode-only change produces a patch with no hunks. */
  modeOnly: boolean
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Parse a single-file unified diff. */
export function parseDiff(patch: string): ParsedDiff {
  const result: ParsedDiff = { meta: [], hunks: [], additions: 0, deletions: 0, binary: false, modeOnly: false }
  if (!patch) return result

  const lines = patch.split("\n")
  // `split` leaves a trailing empty string for a patch ending in a newline.
  if (lines.length && lines[lines.length - 1] === "") lines.pop()

  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of lines) {
    if (raw.startsWith("GIT binary patch") || /^Binary files .* differ$/.test(raw)) {
      result.binary = true
      hunk = null
      continue
    }

    const match = HUNK_RE.exec(raw)
    if (match) {
      hunk = {
        header: raw,
        section: match[5].trim() || undefined,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      result.hunks.push(hunk)
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      continue
    }

    if (hunk) {
      const marker = raw[0]
      if (marker === "+") {
        hunk.lines.push({ type: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ })
        result.additions++
      } else if (marker === "-") {
        hunk.lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null })
        result.deletions++
      } else if (marker === "\\") {
        hunk.lines.push({ type: "note", text: raw.slice(1).trim(), oldNo: null, newNo: null })
      } else if (marker === " " || raw === "") {
        hunk.lines.push({ type: "context", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
      } else {
        // Anything else ends the hunk body (e.g. a trailing diff header).
        hunk = null
      }
      continue
    }

    if (raw.startsWith("--- ")) {
      const value = raw.slice(4)
      result.oldPath = value === "/dev/null" ? undefined : stripPrefix(value)
      continue
    }
    if (raw.startsWith("+++ ")) {
      const value = raw.slice(4)
      result.newPath = value === "/dev/null" ? undefined : stripPrefix(value)
      continue
    }
    if (raw.startsWith("diff --git ")) {
      // Paths in this header may be quoted when they contain spaces.
      const rest = raw.slice("diff --git ".length)
      const parts = rest.match(/^(".*?"|\S+)\s+(".*?"|\S+)$/)
      if (parts) {
        result.oldPath = stripPrefix(parts[1].replace(/^"|"$/g, ""))
        result.newPath = stripPrefix(parts[2].replace(/^"|"$/g, ""))
      }
      continue
    }
    if (raw.trim()) result.meta.push(raw.trim())
  }

  if (result.binary) {
    result.hunks = []
    result.modeOnly = false
  } else if (!result.hunks.length) {
    result.modeOnly = patch.trim().length > 0
  }
  return result
}

/** Drop the a/ or b/ prefix git puts on diff paths. */
function stripPrefix(value: string): string {
  return value.replace(/^[ab]\//, "")
}

/** One renderable row of the split (side-by-side) view. */
/** One row of the split view: a pair of cells, or a full-width note. */
export type SplitRow =
  | { kind: "line"; left: DiffLine | null; right: DiffLine | null }
  | { kind: "note"; text: string }

/** A row of the split view, as the viewer consumes it. */
export type FileRow = SplitRow

/**
 * Pair a hunk's lines into old/new columns: deletions and the additions that
 * replace them share a row, and context lines appear on both sides.
 */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.type === "context") {
      rows.push({ kind: "line", left: line, right: line })
      index++
      continue
    }
    if (line.type === "note") {
      rows.push({ kind: "note", text: line.text })
      index++
      continue
    }

    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (index < lines.length && lines[index].type === "del") removed.push(lines[index++])
    while (index < lines.length && lines[index].type === "add") added.push(lines[index++])

    if (!removed.length && !added.length) {
      index++
      continue
    }
    const height = Math.max(removed.length, added.length)
    for (let i = 0; i < height; i++) {
      rows.push({ kind: "line", left: removed[i] ?? null, right: added[i] ?? null })
    }
  }

  return rows
}

/** A half-open `[start, end)` span of characters within a line. */
export interface ChangeRange {
  start: number
  end: number
}

/** A word, a run of whitespace, or a single other character. */
const TOKEN_RE = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g

/** Past this many token pairs, the quadratic walk costs more than it is worth. */
const MAX_TOKEN_PRODUCT = 60_000

/** Past this share on both sides, the row's own tint says as much as marks would. */
const MAX_CHANGED_RATIO = 0.6

interface Token {
  text: string
  start: number
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  TOKEN_RE.lastIndex = 0
  for (let match = TOKEN_RE.exec(text); match; match = TOKEN_RE.exec(text)) {
    tokens.push({ text: match[0], start: match.index })
  }
  return tokens
}

/** The span the tokens cover, which is contiguous because they are in order. */
function spanOf(tokens: Token[]): ChangeRange | null {
  if (!tokens.length) return null
  const first = tokens[0]
  const last = tokens[tokens.length - 1]
  return { start: first.start, end: last.start + last.text.length }
}

/**
 * Where the two lines of a replaced pair differ, as character ranges on each
 * side.
 *
 * A character diff of the pair would mark everything between the first change
 * and the last, so the sides are diffed as tokens instead — a word, a run of
 * whitespace or a single other character each — and only the tokens that did not
 * survive are marked. Each run of those is then narrowed to the characters it
 * does not share with the run that replaced it, so `count` → `counts` marks the
 * `s` alone.
 *
 * Nothing is marked when the lines are mostly different, where marks would only
 * repeat what the row's tint already says, or when the lines are too long for
 * the token diff to be worth running.
 */
export function changedRanges(oldText: string, newText: string): { old: ChangeRange[]; new: ChangeRange[] } {
  const none = { old: [] as ChangeRange[], new: [] as ChangeRange[] }
  if (!oldText || !newText || oldText === newText) return none

  const oldTokens = tokenize(oldText)
  const newTokens = tokenize(newText)
  if (!oldTokens.length || !newTokens.length) return none
  if (oldTokens.length * newTokens.length > MAX_TOKEN_PRODUCT) return none

  // The longest common subsequence of the tokens, so the marks land on the
  // tokens that changed rather than on every token between them.
  const width = newTokens.length + 1
  const lcs = new Uint32Array((oldTokens.length + 1) * width)
  for (let i = oldTokens.length - 1; i >= 0; i--) {
    for (let j = newTokens.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        oldTokens[i].text === newTokens[j].text
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  type Op = { kind: "equal" | "del" | "ins"; index: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i].text === newTokens[j].text) {
      ops.push({ kind: "equal", index: i })
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      ops.push({ kind: "del", index: i })
      i++
    } else {
      ops.push({ kind: "ins", index: j })
      j++
    }
  }
  while (i < oldTokens.length) ops.push({ kind: "del", index: i++ })
  while (j < newTokens.length) ops.push({ kind: "ins", index: j++ })

  const oldRanges: ChangeRange[] = []
  const newRanges: ChangeRange[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k].kind === "equal") {
      k++
      continue
    }

    // A run only one side has, next to the run that replaced it: the two are
    // compared together so their shared characters can be trimmed off.
    const removed: Token[] = []
    const added: Token[] = []
    while (k < ops.length && ops[k].kind !== "equal") {
      if (ops[k].kind === "del") removed.push(oldTokens[ops[k].index])
      else added.push(newTokens[ops[k].index])
      k++
    }

    let oldSpan = spanOf(removed)
    let newSpan = spanOf(added)
    if (oldSpan && newSpan) {
      const oldEnd = oldSpan.end
      const newEnd = newSpan.end
      let prefix = 0
      while (
        oldSpan.start + prefix < oldEnd &&
        newSpan.start + prefix < newEnd &&
        oldText[oldSpan.start + prefix] === newText[newSpan.start + prefix]
      ) {
        prefix++
      }
      let suffix = 0
      while (
        oldEnd - suffix - 1 >= oldSpan.start + prefix &&
        newEnd - suffix - 1 >= newSpan.start + prefix &&
        oldText[oldEnd - suffix - 1] === newText[newEnd - suffix - 1]
      ) {
        suffix++
      }
      oldSpan = { start: oldSpan.start + prefix, end: oldEnd - suffix }
      newSpan = { start: newSpan.start + prefix, end: newEnd - suffix }
    }

    if (oldSpan && oldSpan.end > oldSpan.start) oldRanges.push(oldSpan)
    if (newSpan && newSpan.end > newSpan.start) newRanges.push(newSpan)
  }

  const oldChanged = oldRanges.reduce((total, range) => total + (range.end - range.start), 0)
  const newChanged = newRanges.reduce((total, range) => total + (range.end - range.start), 0)
  if (oldChanged > oldText.length * MAX_CHANGED_RATIO && newChanged > newText.length * MAX_CHANGED_RATIO) return none

  return { old: oldRanges, new: newRanges }
}

/** `+3 −1`-style counts for a parsed patch. */
export function diffStat(diff: ParsedDiff): { additions: number; deletions: number } {
  return { additions: diff.additions, deletions: diff.deletions }
}

/**
 * The basename and directory of a repository-relative path, for compact rows.
 */
export function splitPath(path: string): { base: string; dir: string } {
  const index = path.lastIndexOf("/")
  if (index === -1) return { base: path, dir: "" }
  return { base: path.slice(index + 1), dir: path.slice(0, index) }
}

/** Split file text into lines, without a phantom empty last line. */
function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Whole-file rows, ready for either view. */
export interface FullFileRows {
  unified: DiffLine[]
  split: SplitRow[]
}

/**
 * Expand hunks into the whole file, so the viewer shows the same thing an
 * editor's side-by-side diff does: both files in full, with the changes marked
 * inside them, and no `@@` headers.
 *
 * Unchanged regions between hunks become context rows taken from the new file,
 * where both sides agree line for line. The cursor arithmetic has to respect
 * git's convention for empty hunks: a pure insertion reports the line *before*
 * the insertion as its start, a pure deletion the line before the gap it leaves.
 */
export function expandToFullFile(hunks: DiffHunk[], oldText: string, newText: string): FullFileRows {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const unified: DiffLine[] = []
  const split: SplitRow[] = []

  let oldCursor = 1
  let newCursor = 1

  const pushContext = (text: string) => {
    const line: DiffLine = { type: "context", text, oldNo: oldCursor, newNo: newCursor }
    unified.push(line)
    split.push({ kind: "line", left: line, right: line })
    oldCursor++
    newCursor++
  }

  for (const hunk of hunks) {
    const oldGapEnd = hunk.oldCount > 0 ? hunk.oldStart - 1 : hunk.oldStart
    const newGapEnd = hunk.newCount > 0 ? hunk.newStart - 1 : hunk.newStart
    while (oldCursor <= oldGapEnd && newCursor <= newGapEnd) pushContext(newLines[newCursor - 1] ?? "")

    unified.push(...hunk.lines)
    split.push(...toSplitRows(hunk.lines))

    oldCursor = hunk.oldCount > 0 ? hunk.oldStart + hunk.oldCount : hunk.oldStart + 1
    newCursor = hunk.newCount > 0 ? hunk.newStart + hunk.newCount : hunk.newStart + 1
  }

  // Whatever is left of the file after the last hunk.
  while (oldCursor <= oldLines.length && newCursor <= newLines.length) pushContext(newLines[newCursor - 1] ?? "")

  return { unified, split }
}

/**
 * Rows for the fallback view: the hunks alone, with a marker where the file is
 * elided between them. Used when a side was too large to send, so the viewer
 * cannot show the whole file.
 */
export function hunksToRows(hunks: DiffHunk[]): FullFileRows {
  const unified: DiffLine[] = []
  const split: SplitRow[] = []

  hunks.forEach((hunk, index) => {
    if (index > 0) {
      // The header names the range that is missing, which is the useful thing to
      // show in a gap.
      unified.push({ type: "gap", text: hunk.header, oldNo: null, newNo: null })
      split.push({ kind: "note", text: hunk.header })
    }
    unified.push(...hunk.lines)
    split.push(...toSplitRows(hunk.lines))
  })

  return { unified, split }
}
