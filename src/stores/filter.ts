import { ref } from "vue"

/**
 * Which sidebar Ctrl+R and Ctrl+P are filtering.
 *
 * A single value, because only one sidebar can hold the keyboard focus at a
 * time, and the filter bars are otherwise identical.
 */
export type FilterTarget = "chats" | "changes" | null

const target = ref<FilterTarget>(null)

/**
 * Bumped by every startFilter call, even when the target does not change.
 *
 * A repeated Ctrl+R on the sidebar already being filtered leaves `target` the
 * same, so a watcher on it never fires; the bar watches this instead, which
 * lets each request re-focus and re-select its input.
 */
const request = ref(0)

export const filterTarget = target
export const filterRequest = request

export function startFilter(next: Exclude<FilterTarget, null>) {
  target.value = next
  request.value++
}

export function stopFilter() {
  target.value = null
}
