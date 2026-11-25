import { ref } from "vue"

/**
 * The project switcher at the top of the bottom sidebar half.
 *
 * Its open state lives here rather than in the component because two shortcuts
 * reach it from the shell: `Ctrl`+`R` opens it, and `Alt`+`P` toggles it. Keeping
 * the state in a store lets both mean the same popover without one component
 * watching a request counter for the other.
 */
const open = ref(false)

/**
 * Bumped by every openProjectPicker call, even while the switcher is already up.
 *
 * A repeated `Ctrl`+`R` leaves `open` true, so a watcher on it never fires; the
 * component watches this instead, which lets each press put the caret back in the
 * search field and select what is there — the way the old chat filter did.
 */
const focusRequest = ref(0)

export const projectPickerOpen = open
export const projectPickerFocusRequest = focusRequest

/** Open the switcher, and ask for the search field's focus even if it is open. */
export function openProjectPicker() {
  open.value = true
  focusRequest.value++
}

/** `Alt`+`P`: open the switcher, or close it when it is already up. */
export function toggleProjectPicker() {
  if (open.value) open.value = false
  else openProjectPicker()
}

export function closeProjectPicker() {
  open.value = false
}
