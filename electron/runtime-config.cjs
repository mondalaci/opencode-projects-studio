/**
 * The studio's runtime config file, `opencode-projects-studio.json`.
 *
 * The file is served at the site root, so the renderer reads it over HTTP; the
 * sidebar's Hide and Unhide actions are the only writers, and they live here
 * because a browser page cannot write the file a static server is reading. It is
 * small on purpose — one key today — and every write preserves the keys it does
 * not own, so hand-written settings survive.
 */
const fs = require("node:fs")
const path = require("node:path")

/** Parse the file, treating a missing or malformed one as empty. */
function read(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Keep only the strings we understand, in order, without duplicates. */
function normalizePatterns(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "") seen.add(entry)
  }
  return [...seen]
}

/** The `hideProjects` list as stored, or `[]`. */
function hiddenProjects(file) {
  return normalizePatterns(read(file).hideProjects)
}

/**
 * Replace `hideProjects`, keeping every other key in the file.
 *
 * A pretty-printed file is written so the result stays hand-editable, matching
 * the committed example.
 */
function setHiddenProjects(file, patterns) {
  const list = normalizePatterns(patterns)
  try {
    const config = { ...read(file) }
    if (list.length) config.hideProjects = list
    else delete config.hideProjects

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

module.exports = { read, hiddenProjects, setHiddenProjects }
