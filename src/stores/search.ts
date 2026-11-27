import { ref } from "vue"

/** Whether the dedicated conversation search page is open. */
export const searchOpen = ref(false)

export function openSearch() {
  searchOpen.value = true
}

export function closeSearch() {
  searchOpen.value = false
}

/**
 * Which conversations a search covers: the open project's only, or every
 * project's.
 *
 * The choice is remembered in `localStorage` so reopening search keeps the
 * scope the reader last chose. Narrowing a search to one project is a
 * deliberate act, and silently resetting it would hide the conversations the
 * reader was looking for.
 */
export type SearchScope = "project" | "all"

const STORAGE_KEY = "opencode-projects-studio.search-scope"

function loadScope(): SearchScope {
  try {
    return localStorage.getItem(STORAGE_KEY) === "all" ? "all" : "project"
  } catch {
    return "project"
  }
}

export const searchScope = ref<SearchScope>(loadScope())

/** Choose the scope, and remember it for the next search. */
export function setSearchScope(scope: SearchScope) {
  searchScope.value = scope
  try {
    localStorage.setItem(STORAGE_KEY, scope)
  } catch {
    /* ignore: storing is a convenience, not a requirement */
  }
}

/** Flip between the two scopes. */
export function toggleSearchScope() {
  setSearchScope(searchScope.value === "project" ? "all" : "project")
}
