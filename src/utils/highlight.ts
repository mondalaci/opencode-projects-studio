import hljs from "highlight.js/lib/common"
import type { ChangeRange } from "./diff"

/**
 * Syntax highlighting for the diff and file views.
 *
 * Highlighting happens over a whole side of a hunk, not line by line: a block
 * comment or a template string spans lines, and highlighting each line in
 * isolation would colour it as plain code. The highlighted HTML is then split
 * back into lines — with the tags that straddle a line break closed and reopened,
 * so every line is a self-contained fragment that can be rendered on its own.
 *
 * The module also wraps that HTML (or plain escaped text) in the spans the diff
 * uses to mark the characters that changed inside a line.
 */

/** Beyond this, highlighting costs more than it is worth. */
const MAX_LINES = 3000

/**
 * The start of a here-document, e.g. `<<'EOF'` or `<<-DELIM`. The delimiter is
 * the part that ends the body.
 */
const HEREDOC_START = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g

/**
 * A run of a command: either shell to highlight, or a here-document body, which
 * is data and is left alone.
 */
interface Segment {
  code: boolean
  text: string
}

/**
 * Split a command into the runs of shell and the here-document bodies it feeds.
 *
 * The bash grammar has no notion of a here-document, so it reads the body as
 * more script — which paints `for`, `in` and `then` inside a commit message as
 * keywords, in the middle of ordinary prose. Cutting the bodies out keeps the
 * grammar on the code that really is code.
 *
 * A `<<` that never gets its delimiter line (one inside a quoted string, say) is
 * no here-document at all, so the rest of the command goes back to being code.
 * The runs join back with newlines into the command exactly as it was given.
 */
function commandSegments(code: string): Segment[] {
  const segments: Segment[] = []
  const codeLines: string[] = []
  let bodyLines: string[] | null = null
  const delimiters: string[] = []

  const endCode = () => {
    if (!codeLines.length) return
    segments.push({ code: true, text: codeLines.join("\n") })
    codeLines.length = 0
  }
  const endBody = () => {
    if (!bodyLines?.length) {
      bodyLines = null
      return
    }
    segments.push({ code: false, text: bodyLines.join("\n") })
    bodyLines = null
  }

  for (const line of code.split("\n")) {
    if (bodyLines) {
      if (line.trim() !== delimiters[0]) {
        bodyLines.push(line)
        continue
      }
      // The delimiter line is shell again, and ends the body.
      delimiters.shift()
      endBody()
      codeLines.push(line)
      // A command can open several here-documents at once; their bodies follow
      // one after the other.
      if (delimiters.length) {
        endCode()
        bodyLines = []
      }
      continue
    }

    codeLines.push(line)
    const starts = [...line.matchAll(HEREDOC_START)]
    if (starts.length) {
      delimiters.push(...starts.map((match) => match[1]))
      endCode()
      bodyLines = []
    }
  }

  // A body that was never closed is not one; its lines were shell all along.
  if (bodyLines) codeLines.push(...bodyLines)
  endCode()
  return segments
}

/**
 * Extensions we can name outright. highlight.js has a filename resolver, but it
 * only knows a few names, and the app needs to cover its own stack.
 */
const EXTENSIONS: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cfg: "ini",
  clj: "clojure",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  diff: "diff",
  dockerfile: "dockerfile",
  env: "bash",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  hs: "haskell",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  mm: "objectivec",
  mts: "typescript",
  patch: "diff",
  php: "php",
  pl: "perl",
  plist: "xml",
  proto: "protobuf",
  ps1: "powershell",
  py: "python",
  pyi: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsv: "plaintext",
  tsx: "typescript",
  txt: "plaintext",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
}

/** Languages without an extension worth recognising. */
const FILENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  gemfile: "ruby",
  makefile: "makefile",
  procfile: "bash",
  ".bashrc": "bash",
  ".env": "bash",
  ".gitignore": "bash",
  ".npmrc": "ini",
  ".zshrc": "bash",
}

/** The highlight.js language for a repository-relative path, if we know one. */
export function languageForPath(path: string): string | null {
  const lower = path.toLowerCase()
  const name = lower.split("/").pop() ?? lower
  const byName = FILENAMES[name]
  if (byName) return byName

  const dot = name.lastIndexOf(".")
  if (dot === -1) return null
  const extension = name.slice(dot + 1)
  const language = EXTENSIONS[extension]
  if (!language || language === "plaintext") return null
  return hljs.getLanguage(language) ? language : null
}

/**
 * Split highlighted HTML into one fragment per source line.
 *
 * The tags highlight.js opens can span line breaks, so each fragment gets the
 * open tags re-emitted after the break and the corresponding closers before it,
 * which is what makes the fragments independently renderable.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let current = ""

  const close = () => open.map(() => "</span>").join("")
  const reopen = () => open.join("")

  for (let index = 0; index < html.length; ) {
    const char = html[index]

    if (char === "\n") {
      lines.push(current + close())
      current = reopen()
      index++
      continue
    }

    if (char === "<") {
      const end = html.indexOf(">", index)
      if (end === -1) {
        current += html.slice(index)
        break
      }
      const tag = html.slice(index, end + 1)
      if (tag.startsWith("<span")) open.push(tag)
      else if (tag.startsWith("</span")) open.pop()
      current += tag
      index = end + 1
      continue
    }

    current += char
    index++
  }

  lines.push(current + close())
  return lines
}

/**
 * One highlighted HTML fragment per line of `code`, or null when the language is
 * unknown or the text is too large to bother with.
 */
export function highlightLines(code: string, language: string | null): string[] | null {
  if (!language) return null
  const lineCount = code.length ? code.split("\n").length : 0
  if (lineCount > MAX_LINES) return null
  try {
    const result = hljs.highlight(code, { language, ignoreIllegals: true })
    return splitHighlightedLines(result.value)
  } catch {
    return null
  }
}

/**
 * Tokens the bash grammar leaves plain, mostly flags, URLs and numbers.
 *
 * The grammar only colours the command name and its strings, which reads as
 * monochrome in a summary row. These patterns are applied to the text the
 * grammar left uncoloured, in order, so a URL's digits stay part of the URL and
 * a number inside a flag stays part of the flag.
 */
const EXTRA_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bhttps?:\/\/[^\s"'<>]+/g, "hljs-link"],
  [/(?<![\w-])--?[A-Za-z][\w-]*/g, "hljs-flag"],
  [/\b\d+(?:\.\d+)*\b/g, "hljs-number"],
]

/** Wrap the extra tokens in a single text node, leaving the markup intact. */
function decorateTextNode(node: Text): void {
  const text = node.textContent ?? ""
  const ranges: Array<{ start: number; end: number; cls: string }> = []

  for (const [pattern, cls] of EXTRA_TOKENS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (ranges.some((range) => start < range.end && end > range.start)) continue
      ranges.push({ start, end, cls })
    }
  }

  if (!ranges.length) return
  ranges.sort((a, b) => a.start - b.start)

  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) fragment.append(text.slice(cursor, range.start))
    const span = document.createElement("span")
    span.className = range.cls
    span.textContent = text.slice(range.start, range.end)
    fragment.append(span)
    cursor = range.end
  }
  if (cursor < text.length) fragment.append(text.slice(cursor))
  node.replaceWith(fragment)
}

/** Highlight a run of shell, then colour the tokens the grammar left plain. */
function highlightShell(text: string): string {
  const template = document.createElement("template")
  template.innerHTML = hljs.highlight(text, { language: "bash", ignoreIllegals: true }).value

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  for (const node of textNodes) {
    // The grammar's own spans already carry a colour; only plain text is ours.
    if (node.parentElement?.closest("span[class^='hljs-']")) continue
    decorateTextNode(node)
  }
  return template.innerHTML
}

/** The grammars a tool summary can be read as. */
export type SummaryLanguage = "bash" | "javascript"

/**
 * Highlight a tool summary that is code — a shell command or a script — adding
 * the tokens the bash grammar leaves plain so the row reads as colourfully as a
 * code block, and leaving the body of a here-document uncoloured: it is prose
 * handed to a command, not the command itself.
 *
 * Unlike `highlightLines`, the result is not split per line: a summary is one
 * row of text, and the browser wraps it — while keeping the code's own newlines,
 * so a call that spans lines is not reflowed into one paragraph. Returns null
 * when the code is too long to bother with.
 */
export function highlightCodeSummary(code: string, language: SummaryLanguage): string | null {
  const lineCount = code.length ? code.split("\n").length : 0
  if (lineCount > MAX_LINES) return null

  try {
    if (language !== "bash") return hljs.highlight(code, { language, ignoreIllegals: true }).value
    return commandSegments(code)
      .map((segment) => (segment.code ? highlightShell(segment.text) : escapeHtml(segment.text)))
      .join("\n")
  } catch {
    return null
  }
}

/** Escape text so it can be handed to `v-html` exactly as it stands. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** An entity highlight.js writes, or one of ours: `&amp;`, `&quot;`, `&#x27;`. */
const ENTITY_RE = /^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);$/

/**
 * Wrap the given character ranges of an HTML fragment in
 * `<span class="intra">`, which is how the diff marks the characters that
 * changed inside a line.
 *
 * The fragment is highlighted — or escaped — code, so the ranges are counted
 * over the text it renders as, not over the markup: tags pass through untouched
 * and an entity counts as the single character it stands for. A range that runs
 * from one highlight span into the next is closed at that boundary and reopened
 * on the other side, because a mark straddling the two would not nest.
 */
export function wrapHtmlRanges(html: string, ranges: ChangeRange[], className = "intra"): string {
  const spans = ranges.filter((range) => range.end > range.start)
  if (!spans.length) return html

  const openTag = `<span class="${className}">`
  let out = ""
  let offset = 0
  let index = 0
  let marked = false

  const setMark = (want: boolean) => {
    if (want === marked) return
    out += want ? openTag : "</span>"
    marked = want
  }

  for (let position = 0; position < html.length; ) {
    const char = html[position]

    if (char === "<") {
      const end = html.indexOf(">", position)
      if (end === -1) {
        out += html.slice(position)
        break
      }
      // Never leave the mark open across a tag; the next character reopens it if
      // the range reaches that far.
      if (html[position + 1] === "/") setMark(false)
      out += html.slice(position, end + 1)
      position = end + 1
      continue
    }

    let text = char
    if (char === "&") {
      const end = html.indexOf(";", position)
      const entity = end === -1 ? "" : html.slice(position, end + 1)
      if (ENTITY_RE.test(entity)) {
        text = entity
        position = end + 1
      } else {
        position++
      }
    } else {
      position++
    }

    while (index < spans.length && offset >= spans[index].end) index++
    setMark(index < spans.length && offset >= spans[index].start)
    out += text
    offset++
  }

  setMark(false)
  return out
}
