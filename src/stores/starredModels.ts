import { ref } from "vue"

/**
 * The models the user has starred, so the picker can offer them first.
 *
 * The list is kept in `localStorage` and the two apps do not share it: studio
 * and the web chat each have their own idea of which models are worth keeping
 * within reach, and neither has to be running for the other to work.
 *
 * A key is `providerID::modelID`, the same identity the picker uses as a
 * combobox value, so a starred model survives restarts and provider reordering.
 * Keys this server does not offer are kept: switching servers must not forget
 * them.
 */

const STORAGE_KEY = "opencode-projects-studio.starred-models"

const SEP = "::"

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}${SEP}${modelID}`
}

export function parseModelKey(key: string): { providerID: string; modelID: string } | null {
  const index = key.indexOf(SEP)
  if (index === -1) return null
  return { providerID: key.slice(0, index), modelID: key.slice(index + SEP.length) }
}

function load(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((key): key is string => typeof key === "string")
  } catch {
    return []
  }
}

/** Starred keys in the order they were starred; that is the order offered. */
const keys = ref<string[]>(load())

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys.value))
  } catch {
    /* ignore: storing is a convenience, not a requirement */
  }
}

export function useStarredModels() {
  function isStarred(providerID: string, modelID: string): boolean {
    return keys.value.includes(modelKey(providerID, modelID))
  }

  /** Star an unstarred model, or unstar it. */
  function toggle(providerID: string, modelID: string) {
    const key = modelKey(providerID, modelID)
    keys.value = keys.value.includes(key)
      ? keys.value.filter((item) => item !== key)
      : [...keys.value, key]
    persist()
  }

  return { keys, isStarred, toggle }
}
