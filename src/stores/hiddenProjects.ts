import { computed, ref } from "vue"
import { configWritable } from "@/api/desktop"
import { isProjectHidden, loadHiddenProjects, saveHiddenProjects } from "./runtimeConfig"

/**
 * The projects the sidebar keeps out of the way.
 *
 * The list is the runtime config's `hideProjects`, which has always been a set of
 * patterns: a bare name hides that folder anywhere, a path hides one project. The
 * sidebar's Hide action appends a project's canonical directory, which matches
 * exactly one project, while an entry written by hand (`"scratch"`) keeps hiding
 * every folder of that name. Unhiding removes whichever entries match the
 * project, so both kinds come back.
 *
 * Writing needs the desktop app; a browser still honours the served file but
 * reports that it cannot change it.
 */
const patterns = ref<string[]>([])
const loaded = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

export function useHiddenProjects() {
  /** Whether Hide/Unhide can be saved (the desktop app, not a browser). */
  const writable = computed(() => configWritable())

  /** Whether a project directory is currently kept out of the sidebar. */
  function isHidden(path: string | null | undefined): boolean {
    if (!path) return false
    return isProjectHidden(path, patterns.value)
  }

  /** Read the stored list. Safe to call again; the last read wins. */
  async function load() {
    try {
      patterns.value = await loadHiddenProjects()
      error.value = null
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loaded.value = true
    }
  }

  /** Write `next`, keeping the in-memory list only when the file took it. */
  async function persist(next: string[]): Promise<{ ok: boolean; error?: string }> {
    saving.value = true
    try {
      const result = await saveHiddenProjects(next)
      if (!result.ok) {
        error.value = result.error ?? "Could not save the hidden projects."
        return result
      }
      patterns.value = next
      error.value = null
      return { ok: true }
    } finally {
      saving.value = false
    }
  }

  /** Hide one project. A no-op when a pattern already covers it. */
  async function hide(path: string): Promise<{ ok: boolean; error?: string }> {
    if (isHidden(path)) return { ok: true }
    return persist([...patterns.value, path])
  }

  /** Show a hidden project again, dropping whichever patterns matched it. */
  async function unhide(path: string): Promise<{ ok: boolean; error?: string }> {
    const next = patterns.value.filter((pattern) => !isProjectHidden(path, [pattern]))
    if (next.length === patterns.value.length) return { ok: true }
    return persist(next)
  }

  function reset() {
    patterns.value = []
    loaded.value = false
    saving.value = false
    error.value = null
  }

  return { patterns, loaded, saving, error, writable, isHidden, load, hide, unhide, reset }
}
