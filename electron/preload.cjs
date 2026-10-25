/**
 * Preload bridge.
 *
 * Exposes a deliberately small, promise-based surface on `window.opencodeDesktop`.
 * The renderer never sees `ipcRenderer`, `require`, or the filesystem: it can
 * only ask the main process for git data and let it open things externally.
 */
const { contextBridge, ipcRenderer } = require("electron")

const git = {
  /** Repository that contains `directory`, or `{ isRepo: false }`. */
  repo: (directory) => ipcRenderer.invoke("git:repo", directory),
  /** Uncommitted changes in the repository that contains `directory`. */
  status: (directory) => ipcRenderer.invoke("git:status", directory),
  /** Unified patch for one file: `{ dir, path, scope }` where scope is
   *  "staged", "worktree" or "untracked". */
  diff: (request) => ipcRenderer.invoke("git:diff", request),
  stage: (request) => ipcRenderer.invoke("git:stage", request),
  unstage: (request) => ipcRenderer.invoke("git:unstage", request),
}

const shellApi = {
  /** Show a file in the OS file manager. */
  reveal: (target) => ipcRenderer.invoke("shell:reveal", target),
  /** Open an http(s) URL in the OS browser. */
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  /** Open a path with the OS default application. */
  openPath: (target) => ipcRenderer.invoke("shell:open-path", target),
  info: () => ipcRenderer.invoke("app:info"),
}

/** Workspace files, so the renderer can offer an incremental file search. */
const filesApi = {
  /** Sorted project-relative paths, ignoring whatever git ignores. */
  list: (directory) => ipcRenderer.invoke("files:list", directory),
  /** Read one file for the read-only viewer. */
  read: (request) => ipcRenderer.invoke("files:read", request),
}

/** Window controls, since the frame is chromeless and draws its own. */
const windowApi = {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  /** Toggles maximize/restore; observe `onMaximizedChange` for the result. */
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  /** Current geometry plus the minimum size, for the renderer's resize grips. */
  bounds: () => ipcRenderer.invoke("window:bounds"),
  setBounds: (bounds) => ipcRenderer.invoke("window:set-bounds", bounds),
  /** Cursor position in window-bounds coordinates, for resize drags. */
  cursorPoint: () => ipcRenderer.invoke("window:cursor-point"),
  /** Subscribe to maximize/unmaximize; returns an unsubscribe function. */
  onMaximizedChange: (listener) => {
    const wrapped = (_event, value) => listener(Boolean(value))
    ipcRenderer.on("window:maximized-changed", wrapped)
    return () => ipcRenderer.removeListener("window:maximized-changed", wrapped)
  },
}

/**
 * Tray bridge. The renderer draws the badge bitmap and describes the menu; the
 * main process owns the tray, the notifications and the window actions.
 */
const trayApi = {
  update: (payload) => ipcRenderer.invoke("tray:update", payload),
  notify: (payload) => ipcRenderer.invoke("tray:notify", payload),
  onFocusSession: (listener) => {
    const wrapped = (_event, sessionID) => listener(sessionID)
    ipcRenderer.on("tray:focus-session", wrapped)
    return () => ipcRenderer.removeListener("tray:focus-session", wrapped)
  },
  onAction: (listener) => {
    const wrapped = (_event, action) => listener(action)
    ipcRenderer.on("tray:action", wrapped)
    return () => ipcRenderer.removeListener("tray:action", wrapped)
  },
}

/**
 * Web chat presence: the conversation states the browser app reports to this
 * process's loopback endpoint. The main process owns the endpoint and the
 * freshness rule; the renderer only draws what it is handed.
 *
 * `current()` is for a renderer that has just started: pushes made before it
 * existed are gone, and without them a reload would blank the dot until the
 * next heartbeat.
 */
const webchatApi = {
  current: () => ipcRenderer.invoke("webchat:status-current"),
  onStatus: (listener) => {
    const wrapped = (_event, picture) => listener(picture)
    ipcRenderer.on("webchat:status", wrapped)
    return () => ipcRenderer.removeListener("webchat:status", wrapped)
  },
}

contextBridge.exposeInMainWorld("opencodeDesktop", {
  desktop: true,
  platform: process.platform,
  git,
  files: filesApi,
  tray: trayApi,
  webchat: webchatApi,
  shell: shellApi,
  window: windowApi,
})
