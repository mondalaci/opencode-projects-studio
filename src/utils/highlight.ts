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
