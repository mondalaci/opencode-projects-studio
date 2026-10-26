/**
 * Optional runtime configuration, loaded from `opencode-projects-studio.json` served at
 * the site root (i.e. `public/opencode-projects-studio.json`, copied into the build).
 *
 * It is a plain static file, so it can be edited on a running deployment and
 * picked up on the next reload — no rebuild or restart needed. A missing or
 * invalid file is treated as an empty config, so the app keeps its defaults.
 *
 * Currently it carries `hideProjects`, the pattern list that keeps projects out
 * of the sidebar. The sidebar's Hide/Unhide actions write that list through the
 * desktop bridge, since a browser cannot write the served file.
 */
import { desktopBridge } from "@/api/desktop"

export interface RuntimeConfig {
  /**
   * Projects to omit from the sidebar. Each entry matches either the project's
   * folder name (when it has no `/`) or its absolute canonical directory (when
   * it does). `*` matches any run of characters except `/`, and `**` matches
   * any run including `/`.
   *
   * Examples:
   *   "scratch"                    the folder named `scratch`, anywhere
   *   "sandbox-*"                  folders named `sandbox-…`
   *   "/home/me/repo"              exactly that project
   *   "/home/me/archive/**"        everything under that directory
   *   "root"                       the root project (canonical "/")
   */
  hideProjects?: string[]
}

const CONFIG_URL = `${import.meta.env.BASE_URL}opencode-projects-studio.json`

/** Compile one `hideProjects` entry: `*` = any run, `**` = any run including `/`. */
function compilePattern(pattern: string): RegExp {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*"
        i++
      } else {
        source += "[^/]*"
      }
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Whether a project's canonical directory is excluded by the configured
 * patterns. A pattern with no `/` is matched against the folder name, so it
 * hides that name anywhere; one with a `/` is matched against the whole path.
 */
export function isProjectHidden(path: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length) return false
  // A `/` project has no folder name; the UI calls it "root", so match that.
  const basename = path === "/" ? "root" : (path.split("/").filter(Boolean).pop() ?? path)
  return patterns.some(
    (pattern) => pattern !== "" && compilePattern(pattern).test(pattern.includes("/") ? path : basename),
  )
}

let pending: Promise<RuntimeConfig> | null = null

/** Keep only the settings we understand, so a malformed file cannot break us. */
function normalizeConfig(data: unknown): RuntimeConfig {
  if (!data || typeof data !== "object") return {}
  const raw = (data as { hideProjects?: unknown }).hideProjects
  if (!Array.isArray(raw)) return {}
  const hideProjects = raw.filter((entry): entry is string => typeof entry === "string" && entry !== "")
  return hideProjects.length ? { hideProjects } : {}
}

/** Fetch the runtime config once; resolves to `{}` when absent or invalid. */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (!pending) {
    pending = fetch(CONFIG_URL, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}))
      .then(normalizeConfig)
  }
  return pending
}

/**
 * The `hideProjects` list, from wherever it can actually be read.
 *
 * The desktop app reads the file itself, so what it wrote is what it sees; a
 * browser falls back to the copy served at the site root, which is read-only.
 */
export async function loadHiddenProjects(): Promise<string[]> {
  const bridge = desktopBridge()
  if (bridge?.config) {
    try {
      return await bridge.config.hiddenProjects()
    } catch {
      /* fall through to the served file */
    }
  }
  const config = await loadRuntimeConfig()
  return config.hideProjects ?? []
}

/**
 * Replace the `hideProjects` list in the config file.
 *
 * Only the desktop app can write the file the static server is reading, so a
 * browser reports the failure instead of pretending the change stuck.
 */
export async function saveHiddenProjects(patterns: string[]): Promise<{ ok: boolean; error?: string }> {
  const bridge = desktopBridge()
  if (!bridge?.config) return { ok: false, error: "Hiding projects needs the desktop app." }
  return bridge.config.setHiddenProjects(patterns)
}
