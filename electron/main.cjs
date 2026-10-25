/**
 * Electron main process.
 *
 * The renderer is the studio UI (Vue + Vite), descended from the kilo-web-chat
 * renderer. Its only Electron-specific dependency is the git bridge, so
 * everything else keeps working when the same build is opened in a plain
 * browser (that bridge is simply unavailable there).
 */
const path = require("node:path")
const fs = require("node:fs")
const electron = require("electron")

const git = require("./git.cjs")
const files = require("./files.cjs")
const { createTrayManager } = require("./tray.cjs")
const { startStaticServer } = require("./static-server.cjs")
const { createStatusServer } = require("./status-server.cjs")

// With ELECTRON_RUN_AS_NODE=1 in the environment the Electron binary behaves as
// plain Node and `require("electron")` hands back a path string instead of the
// API. Fail loudly instead of with an "undefined is not an object" further down.
if (!electron?.app) {
  console.error(
    "[main] Electron APIs are unavailable. This happens when ELECTRON_RUN_AS_NODE is set in the\n" +
      "       environment; unset it and launch through the packaged Electron binary.",
  )
  process.exit(1)
}

const { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell } = electron

const ROOT = path.join(__dirname, "..")
const DIST = path.join(ROOT, "dist")
/** The app icon: the "OCP studio" lockup, cut from build/icon-source.png. */
const ICON = path.join(ROOT, "build", "icon.png")
/**
 * Tray-sized version of the mark — the icon's cog alone. Linux panels expect
 * roughly 16-24px and some hosts (Cinnamon's tray applet among them) show
 * nothing at all for a full-size window icon.
 */
const TRAY_ICON = path.join(ROOT, "build", "tray.png")
const DEV_URL = process.env.KPS_DEV_URL || ""
/** Optional path: render a screenshot of the first window and exit. */
const CAPTURE_PATH = process.env.KPS_CAPTURE || ""
const CAPTURE_DELAY_MS = Number(process.env.KPS_CAPTURE_DELAY ?? 4000)

const BACKGROUND = "#1e1e1e"

/** Default geometry, used the first time (and if a saved state is unusable). */
const DEFAULT_WIDTH = 1480
const DEFAULT_HEIGHT = 940

/** The tray, once the app is ready. */
let tray = null

/**
 * The endpoint the web chat app reports to, and the subscription that forwards
 * its picture to the renderer.
 */
let statusServer = null
let detachStatus = null

/**
 * The renderer holds the tray rollup, so the web chat's picture is pushed to it
 * rather than kept here. A renderer that has just loaded has missed every earlier
 * push — reloading the UI would otherwise blank the dot until the next heartbeat
 * — so it also pulls the current picture when it starts (see the
 * `webchat:status-current` handler below).
 */
function broadcastStatus(picture) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("webchat:status", picture)
  }
}

/**
 * Saved window geometry lives beside the other per-user data so the window
 * reopens where the user left it. The renderer drives its own resize drags
 * through `window:set-bounds`, which the main process sees as ordinary
 * resize/move events, so a single listener here covers every path that can
 * change the geometry.
 */
function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json")
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"))
    return state && typeof state === "object" ? state : null
  } catch {
    // Missing or unreadable state is the normal first-run case, not an error.
    return null
  }
}

function saveWindowState(state) {
  try {
    fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true })
    fs.writeFileSync(windowStateFile(), JSON.stringify(state))
  } catch (error) {
    console.warn("[main] could not save window state:", error?.message ?? error)
  }
}

/**
 * Keep only a geometry that is finite and still overlaps a connected display.
 * A window restored onto a monitor that is no longer attached would otherwise
 * open off-screen, out of reach.
 */
function usableBounds(state) {
  if (!state) return null
  const { x, y, width, height } = state
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null
  if (width < 1 || height < 1) return null
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      x < area.x + area.width &&
      x + width > area.x &&
      y < area.y + area.height &&
      y + height > area.y
    )
  })
  return onScreen ? { x, y, width, height } : null
}

/** Persist geometry on every change, debounced so a drag writes once. */
function trackWindowState(window) {
  let timer = null
  const persist = () => {
    if (window.isDestroyed()) return
    // `getNormalBounds` reports the restored geometry even while maximized, so
    // the maximized flag and the size to fall back to are both preserved.
    saveWindowState({ ...window.getNormalBounds(), maximized: window.isMaximized() })
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(persist, 400)
  }
  for (const event of ["resize", "move", "maximize", "unmaximize"]) {
    window.on(event, schedule)
  }
  window.on("close", () => {
    clearTimeout(timer)
    persist()
  })
}

/**
 * Read the app icon, reporting a missing or unreadable asset instead of
 * quietly starting with no icon.
 */
function loadIcon() {
  if (!fs.existsSync(ICON)) {
    console.warn(`[main] app icon not found at ${ICON}; run "npm run icon"`)
    return null
  }
  const image = nativeImage.createFromPath(ICON)
  if (image.isEmpty()) {
    console.warn(`[main] could not read the app icon at ${ICON}`)
    return null
  }
  const { width, height } = image.getSize()
  console.log(`[main] app icon ${width}×${height} from ${ICON}`)
  return image
}

const ICON_IMAGE = loadIcon()

/** The window a renderer message came from. */
function senderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * Install the application menu.
 *
 * The window is chromeless, so there is no menu bar to show: on Linux and
 * Windows the menu is removed outright, which is also what stops a bare Alt
 * press from pulling a menu bar down over the UI. macOS keeps a minimal menu
 * because its system menu bar carries the standard editing and window
 * shortcuts — without it Cmd+C/V/W/Q would stop working.
 */
function setupMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  )
}

/** Register the git IPC surface consumed by the preload bridge. */
function registerIpc() {
  ipcMain.handle("git:repo", (_event, dir) => git.repoInfo(dir))
  ipcMain.handle("git:status", (_event, dir) => git.status(dir))
  ipcMain.handle("git:diff", (_event, payload) => git.diff(payload?.dir, payload ?? {}))
  ipcMain.handle("git:stage", (_event, payload) => git.stage(payload?.dir, payload?.path))
  ipcMain.handle("git:unstage", (_event, payload) => git.unstage(payload?.dir, payload?.path))

  // Workspace files, for the file quick-open.
  ipcMain.handle("files:list", (_event, dir) => files.list(dir))
  ipcMain.handle("files:read", (_event, payload) => files.read(payload?.dir, payload?.path))

  // Window controls for the chromeless frame.
  ipcMain.handle("window:minimize", (event) => {
    senderWindow(event)?.minimize()
  })
  ipcMain.handle("window:toggle-maximize", (event) => {
    const window = senderWindow(event)
    if (!window) return
    // The window manager applies maximize/unmaximize asynchronously, so
    // `isMaximized()` read straight afterwards is stale. The renderer follows
    // the maximize/unmaximize events instead of a return value.
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle("window:close", (event) => {
    senderWindow(event)?.close()
  })
  ipcMain.handle("window:is-maximized", (event) => senderWindow(event)?.isMaximized() ?? false)
  ipcMain.handle("window:bounds", (event) => {
    const window = senderWindow(event)
    if (!window) return null
    const [minWidth, minHeight] = window.getMinimumSize()
    return { ...window.getBounds(), minWidth, minHeight }
  })
  /**
   * Cursor position in the same DIP space as `getBounds()`, for the renderer's
   * resize grips. The renderer cannot use `MouseEvent.screenX` for this: when a
   * drag moves the window, the window-relative coordinate system moves with it,
   * so the deltas feed back and the resize runs away.
   */
  ipcMain.handle("window:cursor-point", () => screen.getCursorScreenPoint())
  // Used by the renderer's own resize grips: a frameless window has no frame for
  // the window manager to grab on Linux, so the renderer drives the geometry.
  ipcMain.handle("window:set-bounds", (event, bounds) => {
    const window = senderWindow(event)
    if (!window || window.isDestroyed() || !bounds) return
    const [minWidth, minHeight] = window.getMinimumSize()
    window.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(minWidth, Math.round(bounds.width)),
      height: Math.max(minHeight, Math.round(bounds.height)),
    })
  })

  ipcMain.handle("shell:reveal", (_event, target) => {
    if (typeof target === "string" && target) shell.showItemInFolder(target)
  })
  ipcMain.handle("shell:open-external", (_event, url) => {
    // Only ever hand http(s) URLs to the OS browser.
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return shell.openExternal(url)
  })
  ipcMain.handle("shell:open-path", (_event, target) => {
    if (typeof target === "string" && target) return shell.openPath(target)
  })

  // The renderer draws the badge and describes the menu; the tray is native.
  ipcMain.handle("tray:update", (_event, payload) => tray?.update(payload))
  ipcMain.handle("tray:notify", (_event, payload) => tray?.notify(payload))

  // A renderer that has just started asks for the web chat picture, so a reload
  // does not blank the dot until the next heartbeat. The push and the pull use
  // different channels: an `invoke` reply is not something `on` can hear.
  ipcMain.handle("webchat:status-current", () => statusServer?.snapshot() ?? { clients: [] })

  ipcMain.handle("app:info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    gitAvailable: true,
    /** False on the chromeless platforms, where the menu is removed outright. */
    menu: Boolean(Menu.getApplicationMenu()),
    desktop: true,
  }))
}

async function capture(window) {
  try {
    const image = await window.webContents.capturePage()
    fs.mkdirSync(path.dirname(CAPTURE_PATH), { recursive: true })
    fs.writeFileSync(CAPTURE_PATH, image.toPNG())
    console.log(`[main] screenshot written to ${CAPTURE_PATH}`)
  } catch (error) {
    console.error("[main] capture failed:", error)
  }
  app.quit()
}

function createWindow(url) {
  const saved = CAPTURE_PATH ? null : loadWindowState()
  const bounds = usableBounds(saved)
  const window = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_WIDTH,
    height: bounds?.height ?? DEFAULT_HEIGHT,
    // Only restore the position once it is known to sit on a live display.
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 560,
    backgroundColor: BACKGROUND,
    title: "OpenCode Projects Studio",
    show: !CAPTURE_PATH,
    // Chromeless: no OS title bar, so the app's own header is the top of the
    // window. The renderer draws the window controls and marks the header
    // strips as drag regions.
    frame: false,
    // Window and taskbar icon (Windows/Linux). macOS takes the dock icon below,
    // since `icon` is ignored there.
    icon: ICON_IMAGE ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The attention chime must be able to sound without a click first: this is
      // a desktop app, not a page that has to earn playback.
      autoplayPolicy: "no-user-gesture-required",
    },
  })

  // Links the app cannot render itself (share URLs, docs) go to the OS browser.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    return { action: "deny" }
  })

  window.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
    console.error(`[main] failed to load ${validatedURL}: ${description} (${code})`)
  })

  // The renderer's maximize button needs to know which way the window is going,
  // because a frameless window has no system control to observe.
  for (const event of ["maximize", "unmaximize"]) {
    window.on(event, () => {
      if (!window.isDestroyed()) window.webContents.send("window:maximized-changed", window.isMaximized())
    })
  }

  if (CAPTURE_PATH) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(() => void capture(window), CAPTURE_DELAY_MS)
    })
  } else {
    // Restore the maximized state only after `show`, so the window does not
    // flash at its normal size first.
    trackWindowState(window)
    if (saved?.maximized) window.maximize()
  }

  void window.loadURL(url)
  return window
}

app.setName("OpenCode Projects Studio")

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock() && !CAPTURE_PATH) {
  // The running instance brings its window forward through its `second-instance`
  // handler. Say so out loud: quitting here silently makes a launch look like it
  // did nothing at all.
  console.log("[main] another instance is already running; asking it to come forward and exiting")
  app.quit()
} else {
  registerIpc()

  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  app.whenReady().then(async () => {
    setupMenu()

    // The web chat app reports here, and the renderer decides what its dot looks
    // like, so the two are joined by a push in one direction and a pull in the
    // other.
    statusServer = createStatusServer()
    detachStatus = statusServer.onChange((picture) => broadcastStatus(picture))
    await statusServer.start()

    let url = DEV_URL
    if (!url) {
      if (!fs.existsSync(path.join(DIST, "index.html"))) {
        console.error(`[main] no build found at ${DIST}. Run "npm run build" first.`)
        app.exit(1)
        return
      }
      const port = await startStaticServer(DIST)
      url = `http://127.0.0.1:${port}/`
    }
    console.log(`[main] loading ${url}`)

    // macOS ignores the window `icon` option; the dock icon is set separately.
    if (process.platform === "darwin" && app.dock && ICON_IMAGE) app.dock.setIcon(ICON_IMAGE)

    const window = createWindow(url)

    // The tray mirrors the renderer's state; it starts from the app icon and is
    // replaced by the first badge update as soon as a project is connected.
    try {
      // The renderer replaces this with the badge bitmap once it is connected;
      // until then the plain mark stands in.
      const base = fs.existsSync(TRAY_ICON) ? TRAY_ICON : ICON
      tray = createTrayManager({ iconPath: base, getWindow: () => window })
      tray.ensure()
      console.log(`[main] tray created from ${base}`)
    } catch (error) {
      // Some desktops have no tray host (no StatusNotifier/KDE/AppIndicator); the
      // app itself must still work there.
      console.warn("[main] tray unavailable:", error?.message ?? error)
      tray = null
    }

    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow(url)
    })
  })

  app.on("window-all-closed", () => {
    tray?.destroy()
    tray = null
    if (process.platform !== "darwin") app.quit()
  })

  app.on("will-quit", () => {
    detachStatus?.()
    detachStatus = null
    statusServer?.stop()
    statusServer = null
  })
}
