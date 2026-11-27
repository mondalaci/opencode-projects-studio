import { ref } from "vue"

/**
 * Layout state for the source-control panel.
 *
 * The panel is always visible — it is part of the studio's identity — so only its
 * width is a preference worth remembering.
 */

const WIDTH_KEY = "opencode-projects-studio.scm-width"

export const SCM_MIN_WIDTH = 240
export const SCM_MAX_WIDTH = 720
/** Wide enough for the header to hold its label, branch and window buttons. */
export const SCM_DEFAULT_WIDTH = 340

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(value) && value >= SCM_MIN_WIDTH && value <= SCM_MAX_WIDTH) return value
  } catch {
    /* storage unavailable */
  }
  return SCM_DEFAULT_WIDTH
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

/** The source-control panel width in pixels. */
export const scmWidth = ref(readWidth())

export function setScmWidth(value: number) {
  scmWidth.value = Math.min(SCM_MAX_WIDTH, Math.max(SCM_MIN_WIDTH, Math.round(value)))
  persist(WIDTH_KEY, String(scmWidth.value))
  applyScmWidth()
}

/** Apply the stored panel width to the document's CSS custom properties. */
export function applyScmWidth() {
  document.documentElement.style.setProperty("--scm-width", `${scmWidth.value}px`)
}
