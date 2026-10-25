/**
 * The loopback status endpoint the web chat app reports to.
 *
 * A browser tab cannot be reached, so it pushes: it POSTs a small JSON report
 * whenever its conversations change, on a heartbeat, and once more as a beacon
 * as it unloads. This server is the receiving half — it validates what arrives,
 * remembers the newest report per tab and hands the whole picture to whoever is
 * listening (the main process, which forwards it to the renderer).
 *
 * Freshness is decided here rather than in the renderer: a tab that crashes
 * never sends its beacon, so a report older than `EXPIRY_MS` is dropped. The
 * heartbeat is throttled by browsers to about once a minute in a hidden tab, so
 * the expiry is comfortably longer than that — otherwise a background turn would
 * lose its dot.
 *
 * The port is fixed and part of the agreement with the web app, which hard-codes
 * it (`src/stores/studio.ts` there). If it is taken, the endpoint is simply
 * unavailable: falling back to an ephemeral port would leave the web app posting
 * into nothing, which is harder to notice than a logged warning.
 */
const http = require("node:http")

/** Must match `ENDPOINT` in the web app's `src/stores/studio.ts`. */
const PREFERRED_PORT = 45998

/**
 * How long a tab's report stays live without an update. Browsers throttle a
 * hidden tab's timers to roughly once a minute, so this is several heartbeats:
 * long enough that a background turn never flickers, short enough that a killed
 * tab does not leave a dot standing for minutes.
 */
const EXPIRY_MS = 150_000

/** How often stale tabs are swept out, with no report needed to trigger it. */
const SWEEP_MS = 15_000

/** A report larger than this is not one of ours; refuse it rather than read it. */
const MAX_BYTES = 64 * 1024

/** How many conversations one tab may report, and how long its strings may be. */
const MAX_CONVERSATIONS = 40
const MAX_TITLE = 200
const MAX_REASON = 80
const MAX_URL = 500

const STATE_ORDER = ["blocked", "working", "done", "idle"]

function isState(value) {
  return typeof value === "string" && STATE_ORDER.includes(value)
}

/** A string off the wire, trimmed to length, or undefined when unusable. */
function text(value, limit) {
  return typeof value === "string" && value ? value.slice(0, limit) : undefined
}

/**
 * Keep the newest report per client, rejecting anything that is not shaped like
 * one. The endpoint is reachable by any process on this machine, so nothing that
 * arrives is trusted: a malformed report is dropped, and the fields that do
 * survive are bounded before they reach the tray.
 */
function createStatusServer({ port = PREFERRED_PORT, host = "127.0.0.1" } = {}) {
  /** client id → the last accepted report. */
  const clients = new Map()
  const listeners = new Set()
  let server = null
  let sweepTimer = null

  /** Every live tab, newest first, as one payload. */
  function snapshot() {
    const now = Date.now()
    const live = [...clients.values()]
      .filter((report) => now - report.at <= EXPIRY_MS)
      .sort((a, b) => b.at - a.at)
    return { at: now, clients: live }
  }

  function emit() {
    const next = snapshot()
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (error) {
        console.warn("[status] listener failed:", error?.message ?? error)
      }
    }
  }

  /** Fold a raw payload into the shape the tray consumes, or null when unusable. */
  function normalize(raw) {
    if (!raw || typeof raw !== "object") return null
    const client = text(raw.client, 64)
    if (!client) return null

    const url = text(raw.url, MAX_URL)
    const conversations = Array.isArray(raw.conversations) ? raw.conversations : []
    const cleaned = []
    for (const entry of conversations.slice(0, MAX_CONVERSATIONS)) {
      if (!entry || typeof entry !== "object") continue
      const id = text(entry.id, 128)
      if (!id || !isState(entry.state)) continue
      cleaned.push({
        id,
        title: text(entry.title, MAX_TITLE) ?? "Untitled",
        project: text(entry.project, MAX_URL) ?? "",
        state: entry.state,
        reason: text(entry.reason, MAX_REASON) ?? entry.state,
      })
    }

    return {
      client,
      url: url && /^https?:\/\//i.test(url) ? url : "",
      at: Date.now(),
      // The number of conversations the tab has open, with news or without, so
      // the tray can say how much of the window it is describing.
      open: Number.isFinite(raw.open) && raw.open > 0 ? Math.min(Math.floor(raw.open), 999) : cleaned.length,
      // The state of the tab as a whole is recomputed here rather than trusted:
      // it must agree with the conversations the tab actually sent.
      state: worst(cleaned.map((conversation) => conversation.state)),
      conversations: cleaned,
    }
  }

  function worst(states) {
    let best = "idle"
    for (const state of states) {
      if (STATE_ORDER.indexOf(state) < STATE_ORDER.indexOf(best)) best = state
    }
    return best
  }

  function accept(raw) {
    const report = normalize(raw)
    if (!report) return false
    clients.set(report.client, report)
    emit()
    return true
  }

  /** Drop the tabs that stopped reporting, and the one that said goodbye. */
  function forget(client) {
    if (!clients.delete(client)) return
    emit()
  }

  function sweep() {
    const now = Date.now()
    let changed = false
    for (const [client, report] of clients) {
      if (now - report.at > EXPIRY_MS) {
        clients.delete(client)
        changed = true
      }
    }
    if (changed) emit()
  }

  function send(res, code, body, headers = {}) {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      // The report comes from another origin (the web app's own), so the reply
      // has to say so. The body is text/plain on the way in, which keeps the
      // request simple, but a stricter client would preflight — answer that too.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      // Chrome asks before letting a public page reach loopback; both apps are
      // local, but saying yes costs nothing and keeps a proxied deployment working.
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-store",
      ...headers,
    })
    res.end(body)
  }

  function handle(req, res) {
    const url = new URL(req.url || "/", `http://${host}`)

    if (req.method === "OPTIONS") {
      send(res, 204, "")
      return
    }
    if (url.pathname !== "/status") {
      send(res, 404, JSON.stringify({ error: "not found" }))
      return
    }
    if (req.method === "GET") {
      send(res, 200, JSON.stringify(snapshot()))
      return
    }
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ error: "method not allowed" }))
      return
    }

    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BYTES) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      let raw = null
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        send(res, 400, JSON.stringify({ error: "invalid json" }))
        return
      }
      if (raw?.gone) {
        forget(text(raw.client, 64) ?? "")
        send(res, 204, "")
        return
      }
      if (!accept(raw)) {
        send(res, 400, JSON.stringify({ error: "unusable report" }))
        return
      }
      send(res, 204, "")
    })
    req.on("error", () => {
      /* the sender went away; nothing to answer */
    })
  }

  return {
    port,

    /** Bind the endpoint. Resolves to the port, or null when it is unavailable. */
    start() {
      return new Promise((resolve) => {
        if (server) {
          resolve(port)
          return
        }
        const instance = http.createServer(handle)
        instance.on("error", (error) => {
          if (error?.code === "EADDRINUSE") {
            console.warn(
              `[status] port ${port} is in use, so the web chat app cannot report to this window`,
            )
          } else {
            console.warn("[status] endpoint unavailable:", error?.message ?? error)
          }
          server = null
          resolve(null)
        })
        instance.listen(port, host, () => {
          server = instance
          sweepTimer = setInterval(sweep, SWEEP_MS)
          // A sweep must not keep the process alive on its own.
          sweepTimer.unref?.()
          console.log(`[status] listening on http://${host}:${port}/status`)
          resolve(port)
        })
      })
    },

    stop() {
      if (sweepTimer) clearInterval(sweepTimer)
      sweepTimer = null
      server?.close()
      server = null
      clients.clear()
    },

    /** The live picture, for the renderer's first paint and for a manual look. */
    snapshot,

    /** Subscribe to changes; returns an unsubscribe function. Fires immediately. */
    onChange(listener) {
      listeners.add(listener)
      listener(snapshot())
      return () => listeners.delete(listener)
    },
  }
}

module.exports = { createStatusServer, PREFERRED_PORT, EXPIRY_MS }
