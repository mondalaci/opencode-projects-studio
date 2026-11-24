/**
 * Workspace file listing and reading, for quick open (Ctrl+P).
 *
 * Inside a git repository the list comes from `git ls-files`, so it is both fast
 * and already filtered by the repository's ignore rules. Everywhere else a
 * bounded directory walk stands in, skipping the usual noise directories.
 */
const fs = require("node:fs/promises")
const path = require("node:path")

const { git, repoInfo } = require("./git.cjs")

/** Hard caps so a huge or unusual tree cannot stall the app. */
const MAX_FILES = 40_000
const MAX_DEPTH = 12
/** A glance view, not an editor: read enough to be useful, never the whole file. */
const MAX_FILE_BYTES = 256 * 1024
/** An inline image travels as a data URL, so it has to stay worth a message. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** The image formats a reply may point at, by extension. */
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
}

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".gradle",
  "target",
  "vendor",
])

function toPosix(value) {
  return value.split(path.sep).join("/")
}

/** Tracked plus untracked-but-not-ignored files, relative to the repo root. */
async function listFromGit(root) {
  const result = await git(["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    timeoutMs: 30_000,
  })
  if (!result.ok) return null
  return result.stdout.split("\0").filter(Boolean)
}

/** Bounded walk used outside a repository. */
async function listFromWalk(root) {
  const files = []
  let truncated = false

  async function walk(directory, depth) {
    if (files.length >= MAX_FILES) {
      truncated = true
      return
    }
    if (depth > MAX_DEPTH) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      if (entry.name.startsWith(".") && entry.name !== ".github") continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        files.push(toPosix(path.relative(root, full)))
      }
    }
  }

  await walk(root, 0)
  return { files, truncated }
}

/** Sorted workspace file list for a project directory. */
async function list(dir) {
  if (typeof dir !== "string" || !dir.trim()) return { ok: false, error: "No directory", files: [] }

  const repo = await repoInfo(dir)
  const root = repo.isRepo ? repo.root : dir

  let files = null
  let truncated = false
  if (repo.isRepo) files = await listFromGit(root)
  if (!files) {
    const walked = await listFromWalk(root)
    files = walked.files
    truncated = walked.truncated
  }
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES)
    truncated = true
  }

  files.sort((a, b) => a.localeCompare(b))
  return { ok: true, root, files, truncated, isRepo: repo.isRepo }
}

/** Read one file for the read-only viewer. */
async function read(dir, relative) {
  if (typeof dir !== "string" || typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    return { ok: false, error: "Invalid path" }
  }
  const repo = await repoInfo(dir)
  const root = repo.isRepo ? repo.root : dir
  const full = path.resolve(root, relative)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (full !== root && !full.startsWith(prefix)) return { ok: false, error: "Path is outside the project" }

  let stat
  try {
    stat = await fs.stat(full)
  } catch {
    return { ok: false, error: "File not found" }
  }
  if (stat.isDirectory()) return { ok: false, error: "That path is a directory" }

  // Only the head of an oversized file is shown, since this is a glance, not an
  // editor.
  const handle = await fs.open(full, "r")
  try {
    const length = Math.min(stat.size, MAX_FILE_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    const binary = buffer.includes(0)
    if (binary) {
      return { ok: true, binary: true, size: stat.size, bytes: length, truncated: stat.size > length, text: "" }
    }
    return {
      ok: true,
      binary: false,
      size: stat.size,
      bytes: length,
      truncated: stat.size > length,
      text: buffer.toString("utf8"),
    }
  } finally {
    await handle.close()
  }
}

/**
 * An image named by an absolute path, as a data URL the renderer can show.
 *
 * A reply's markdown points at files the thread does not own — the artifacts
 * tree sits outside every project — and the page cannot fetch them: it is served
 * over loopback HTTP, so `/home/laci/...` is a path on the app's own origin and
 * the static server answers it with the app shell, which is not an image. The
 * bytes travel through here instead, base64-encoded, which is the same shape an
 * attachment from a tool call arrives in.
 *
 * Unlike `read`, this is not scoped to a project, because the file being outside
 * one is the whole point. It is narrowed instead to what an image can be — a
 * known extension, a regular file, and a size a message can carry — so that a
 * reply pointing at some other file cannot have it turned into a data URL.
 */
async function image(absolute) {
  if (typeof absolute !== "string" || !path.isAbsolute(absolute)) return { ok: false, error: "Invalid path" }
  const mime = IMAGE_MIME[path.extname(absolute).toLowerCase()]
  if (!mime) return { ok: false, error: "Not an image" }
  let stat
  try {
    stat = await fs.stat(absolute)
  } catch {
    return { ok: false, error: "File not found" }
  }
  if (!stat.isFile()) return { ok: false, error: "Not a file" }
  if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: "Image is too large" }
  try {
    const buffer = await fs.readFile(absolute)
    return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, size: stat.size }
  } catch {
    return { ok: false, error: "Could not read the file" }
  }
}

module.exports = { list, read, image, MAX_FILE_BYTES, MAX_IMAGE_BYTES }
