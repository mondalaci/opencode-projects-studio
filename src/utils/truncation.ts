/**
 * Finish reasons that mean a step was stopped by an output limit rather than by
 * the model choosing to stop. Providers spell it differently — the AI SDK
 * normalises most providers to `length`, Anthropic says `max_tokens`, Google
 * `MAX_TOKENS` — and the v2 message keeps both `finish` and the provider's own
 * string, so both are accepted.
 *
 * Only limits are listed. `content_filter` is a refusal, not a continuation
 * waiting to happen, and an `error` has its own message and retry path; neither
 * should offer "Continue".
 */
const LIMIT_FINISHES = new Set([
  "length",
  "maxtokens",
  "maxoutputtokens",
  "maxcompletiontokens",
])

/**
 * Whether any of a step's finish reasons says it hit an output limit. Punctuation
 * and case are ignored, so `max_tokens`, `MAX_TOKENS` and `max-tokens` all read
 * as the same answer.
 */
export function endedAtOutputLimit(...finishes: Array<string | null | undefined>): boolean {
  return finishes.some((finish) => {
    if (!finish) return false
    return LIMIT_FINISHES.has(finish.toLowerCase().replace(/[^a-z]/g, ""))
  })
}

/**
 * Whether a settled assistant message carries its answer only in the reasoning
 * channel: at least one non-empty reasoning block, no visible text, and no tool
 * call.
 *
 * Some models — DeepSeek V4.1 Flash among them — occasionally emit the whole
 * reply as reasoning and finish with `stop`. The harness records that as a
 * successful turn, so the reader sees a thinking block and no answer. The shape
 * is structurally detectable, which is what lets the chat ask for the answer
 * again instead of leaving the turn looking interrupted.
 */
export function answeredOnlyInReasoning(message: {
  error?: unknown
  finish?: string | null
  content: ReadonlyArray<{ type: string; text?: string }>
}): boolean {
  if (message.error) return false
  if (message.finish && message.finish !== "stop") return false
  let reasoning = false
  for (const block of message.content) {
    if (block.type === "tool") return false
    if (block.type === "text" && block.text?.trim()) return false
    if (block.type === "reasoning" && block.text?.trim()) reasoning = true
  }
  return reasoning
}
