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
