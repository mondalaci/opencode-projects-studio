/** A "created/updated" pair, matching both `Session.Info.time` and v1 ranges. */
export interface TimeRange {
  created: number
  updated?: number
}

/** A sortable local calendar-day key (year*10000 + month*100 + day). */
function calendarDay(timestamp: number): number {
  const date = new Date(timestamp)
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
}

/** A single timestamp as a short date, with the clock time when `withTime`. */
function formatStamp(timestamp: number, withTime: boolean): string {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  if (new Date(timestamp).getFullYear() !== new Date().getFullYear()) options.year = "numeric"
  if (withTime) {
    options.hour = "numeric"
    options.minute = "2-digit"
  }
  return new Date(timestamp).toLocaleString(undefined, options)
}

/**
 * Format a conversation's time span. A single date is shown unless the span
 * covers more than one calendar day, in which case the date range is shown.
 * When `withTime` is set the clock time is included.
 */
export function formatConversationDate(range?: TimeRange, withTime = false): string {
  const start = range?.created
  if (!start) return ""
  const end = range?.updated ?? start
  if (calendarDay(start) !== calendarDay(end)) return `${formatStamp(start, withTime)} – ${formatStamp(end, withTime)}`
  return formatStamp(end, withTime)
}

/** The full date-time span of a conversation, always including clock times. */
export function formatConversationDateTime(range?: TimeRange): string {
  const start = range?.created
  if (!start) return ""
  const end = range?.updated ?? start
  return end !== start ? `${formatStamp(start, true)} – ${formatStamp(end, true)}` : formatStamp(start, true)
}

/** A single timestamp as a short date and clock time. */
export function formatDateTime(timestamp?: number): string {
  return timestamp ? formatStamp(timestamp, true) : ""
}

export function relativeTime(timestamp?: number): string {
  if (!timestamp) return ""
  const delta = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return "just now"
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`
  if (delta < day) return `${Math.floor(delta / hour)}h ago`
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`
  const date = new Date(timestamp)
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric"
  return date.toLocaleDateString(undefined, options)
}

export function formatTokens(value?: number): string {
  if (!value) return "0"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** Generated tokens per second, e.g. `42.5 tok/s`; `—` when there is no rate. */
export function formatTokensPerSecond(value?: number): string {
  if (!value || value <= 0) return "—"
  return value >= 100 ? `${Math.round(value)} tok/s` : `${value.toFixed(1)} tok/s`
}

export function formatCost(value?: number): string {
  if (!value) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/**
 * A compact cost for the sidebar rows, where the figure shares a narrow line
 * with the project name: whole dollars once the amount is large enough for
 * cents to be noise, and a shorter tail for the sub-cent spends. The exact
 * figure belongs in the caller's tooltip, via `formatCost`.
 */
export function formatCostCompact(value?: number): string {
  if (!value) return "$0"
  if (value >= 10) return `$${Math.round(value)}`
  if (value >= 0.01) return `$${value.toFixed(2)}`
  return `$${value.toFixed(3)}`
}

/**
 * The arguments a tool's summary is read from, most specific first. A tool that
 * is not listed falls back to the first string argument it has.
 */
const SUMMARY_FIELDS: Record<string, readonly string[]> = {
  shell: ["command"],
  bash: ["command"],
  read: ["filePath", "path"],
  write: ["filePath", "path"],
  edit: ["filePath", "path"],
  patch: ["filePath", "path"],
  apply_patch: ["filePath", "path"],
  list: ["filePath", "path"],
  glob: ["pattern", "query"],
  grep: ["pattern", "query"],
  webfetch: ["url"],
  task: ["description", "prompt"],
  question: ["question", "header"],
}

/** A short human summary for a tool call, used in tool headers. */
export function toolSummary(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const fields = SUMMARY_FIELDS[tool]
  if (fields) {
    for (const field of fields) {
      const value = input[field]
      if (typeof value === "string") return value
    }
    return ""
  }
  const first = Object.values(input).find((item) => typeof item === "string")
  return (first as string) ?? ""
}

/** JSON escape sequences, as a string carries them. A lone `\"` is the quote. */
const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}

/**
 * The text of a JSON string that starts just past its opening quote, decoded as
 * far as the text has arrived. A cut escape or code point is dropped: showing
 * half of one is worse than showing the string a character short.
 */
function readJsonString(raw: string, start: number): string {
  let text = ""
  for (let at = start; at < raw.length; at++) {
    const char = raw[at]
    if (char === '"') break
    if (char !== "\\") {
      text += char
      continue
    }
    const escape = raw[at + 1]
    if (escape === undefined) break
    if (escape === "u") {
      const hex = raw.slice(at + 2, at + 6)
      if (hex.length < 4) break
      text += String.fromCharCode(parseInt(hex, 16))
      at += 5
      continue
    }
    text += JSON_ESCAPES[escape] ?? escape
    at++
  }
  return text
}

/** Where the summary's string starts in a tool's JSON, or null if it has not arrived. */
function summaryMatch(raw: string, fields: readonly string[] | undefined): RegExpExecArray | null {
  if (!fields) return /"[A-Za-z_][\w.-]*"\s*:\s*"/.exec(raw)
  for (const field of fields) {
    const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw)
    if (match) return match
  }
  return null
}

/**
 * The summary of a tool call whose arguments are still arriving.
 *
 * The arguments stream as JSON text, so they do not parse yet, but the summary's
 * own string is readable as far as it has got — which is what lets a running
 * call say what it is doing instead of showing a bare tool name. The same
 * reader covers a call whose arguments never parsed.
 */
export function partialToolSummary(tool: string, raw: string): string {
  if (!raw) return ""
  const match = summaryMatch(raw, SUMMARY_FIELDS[tool])
  if (!match) return ""
  return readJsonString(raw, match.index + match[0].length)
}

/** Pretty-print a tool output that is a JSON object/array; leave other text as-is. */
export function prettyJson(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return value
  }
}
