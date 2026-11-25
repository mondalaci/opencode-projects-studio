import { ref } from "vue"

/**
 * The source-control panel's incremental filter (Ctrl+P).
 *
 * Only one list filters at a time and only one panel holds the keyboard focus, so
 * a single flag is enough: the panel mounts its bar while this is true.
 */
const open = ref(false)

/**
 * Bumped by every startFilter call, even when the filter is already open.
 *
 * A repeated Ctrl+P leaves `open` true, so a watcher on it never fires; the bar
 * watches this instead, which lets each request re-focus and re-select its input.
 */
const request = ref(0)

export const filterOpen = open
export const filterRequest = request

export function startFilter() {
  open.value = true
  request.value++
}

export function stopFilter() {
  open.value = false
}
