import type { StructuredError } from "@/api/types"

/**
 * Whether an error is really a stop.
 *
 * A turn stopped on purpose — the reader pressed stop, or dismissed the question
 * that was holding it — reports an `aborted` (or, once settled locally, an
 * `interrupted`) error, the same shape a real failure arrives in. Nothing went
 * wrong, so the view shows it quietly instead of in the alarming error tone.
 */
export function isStop(error?: StructuredError): boolean {
  return error?.type === "aborted" || error?.type === "interrupted"
}
