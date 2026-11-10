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

/** A short human summary for a tool call, used in tool headers. */
export function toolSummary(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const value = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)
  switch (tool) {
    case "bash":
      return value("command") ?? ""
    case "read":
    case "write":
    case "edit":
    case "patch":
      return value("filePath") ?? value("path") ?? ""
    case "glob":
    case "grep":
      return value("pattern") ?? ""
    case "webfetch":
      return value("url") ?? ""
    case "task":
      return value("description") ?? ""
    default: {
      const first = Object.values(input).find((item) => typeof item === "string")
      return (first as string) ?? ""
    }
  }
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
