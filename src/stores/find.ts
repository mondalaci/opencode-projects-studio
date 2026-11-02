import { ref } from "vue"

/**
 * In-conversation find (Ctrl+F).
 *
 * This searches the conversation on screen, the way a browser's find bar
 * searches a page: Ctrl+F opens a bar over the thread, every occurrence is
 * highlighted, and Enter / Shift+Enter walk them. It is deliberately separate
 * from the conversation search on Alt+F, which searches *across* conversations
 * through the search service.
 */
export const findOpen = ref(false)

/**
 * Bumped whenever Ctrl+F is pressed, including while the bar is already open, so
 * the field can take focus and select its text — the browser's own find bar does
 * the same, letting the next word replace the previous one.
 */
export const findFocusRequest = ref(0)

export function openFind() {
  findOpen.value = true
  findFocusRequest.value += 1
}

export function closeFind() {
  findOpen.value = false
}
