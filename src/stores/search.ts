import { ref } from "vue"

/** Whether the dedicated conversation search page is open. */
export const searchOpen = ref(false)

export function openSearch() {
  searchOpen.value = true
}

export function closeSearch() {
  searchOpen.value = false
}
