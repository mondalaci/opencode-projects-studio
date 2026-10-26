/**
 * Direct access to the opencode server's own database.
 *
 * The v2 HTTP API exposes `GET /api/project` and `PATCH /api/project/{id}` and
 * nothing else: there is no delete, and opencode only archives a project by
 * itself once its folder has been gone for a while (`Project.sweep`). Removing a
 * project therefore has to happen at the database, which is what this module
 * does — one transaction per project, with foreign keys on, so the schema's
 * `ON DELETE CASCADE` rules take the project's directories, sessions, messages,
 * parts, todos, permissions, inbox and instruction rows with it.
 *
 * The database lives beside the server, so this only ever works in the desktop
 * app talking to a server on the same machine.
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

/** Where opencode keeps its data: `$XDG_DATA_HOME/opencode`, else `~/.local/share`. */
function dataDirectory() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode")
}

/**
 * The placeholder project opencode falls back to for a directory it cannot
 * identify (a repository with no remote, say). It is never really "removed" —
 * the next resolve recreates it — so deleting it would only throw away the
 * conversations collected under it.
 */
const GLOBAL_PROJECT_ID = "global"

/**
 * The database file to open.
 *
 * `OPENCODE_DB` wins when it names an absolute path. Otherwise the default
 * `opencode.db` is used, falling back to the single `opencode-<channel>.db` a
 * channel build leaves behind.
 */
function databaseFile() {
  const override = process.env.OPENCODE_DB
  if (override && path.isAbsolute(override)) return override

  const directory = dataDirectory()
  const preferred = path.join(directory, "opencode.db")
  if (fs.existsSync(preferred)) return preferred

  let candidates = []
  try {
    candidates = fs.readdirSync(directory).filter((name) => /^opencode(-[^/]+)?\.db$/.test(name))
  } catch {
    /* no data directory: report the default path below */
  }
  return candidates.length === 1 ? path.join(directory, candidates[0]) : preferred
}

/**
 * Delete a project and everything that belongs to it.
 *
 * The server reads `project.list` straight from the database, so the row is gone
 * from `GET /api/project` as soon as this returns — no restart needed. Its
 * in-memory caches elsewhere (the TUI's, for one) still name the project until
 * they reload, and any later request scoped to the project's directory would
 * make the server resolve — and so recreate — it. Callers must stop using the
 * directory before calling this.
 *
 * Returns `{ ok }` or `{ ok: false, error }`; it never throws at the IPC
 * boundary.
 */
function deleteProject(projectID) {
  if (typeof projectID !== "string" || !projectID) {
    return { ok: false, error: "A project id is required." }
  }
  if (projectID === GLOBAL_PROJECT_ID) {
    return { ok: false, error: "The global project cannot be deleted." }
  }

  const file = databaseFile()
  if (!fs.existsSync(file)) {
    return { ok: false, error: `The opencode database was not found at ${file}.` }
  }

  let DatabaseSync
  try {
    ;({ DatabaseSync } = require("node:sqlite"))
  } catch {
    return { ok: false, error: "This build of the app has no SQLite support." }
  }

  let db
  try {
    db = new DatabaseSync(file)
  } catch (error) {
    return { ok: false, error: `Could not open ${file}: ${error?.message ?? error}` }
  }

  try {
    // Cascades only fire when foreign keys are enforced, and the pragma is a
    // no-op inside a transaction, so both come first. The busy timeout lets a
    // short write wait out the server's own writers rather than failing.
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")

    if (!db.prepare("SELECT 1 FROM project WHERE id = ?").get(projectID)) {
      return { ok: false, error: "That project is no longer in opencode's database." }
    }

    db.exec("BEGIN IMMEDIATE")
    try {
      // Event aggregates are keyed by the project id and by each session id and
      // carry no foreign key of their own, so they are cleared by hand before
      // the rows that name them disappear.
      db.prepare(
        `DELETE FROM event_sequence
          WHERE aggregate_id = ?
             OR aggregate_id IN (SELECT id FROM session WHERE project_id = ?)
             OR aggregate_id IN (SELECT id FROM session_v2 WHERE project_id = ?)`,
      ).run(projectID, projectID, projectID)
      db.prepare("DELETE FROM project WHERE id = ?").run(projectID)
      db.exec("COMMIT")
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {
        /* the transaction is already gone */
      }
      throw error
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  } finally {
    try {
      db.close()
    } catch {
      /* nothing left to close */
    }
  }
}

module.exports = { deleteProject, databaseFile, dataDirectory }
