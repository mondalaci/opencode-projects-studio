/**
 * The system tray.
 *
 * The renderer decides what the badge looks like and what the menu contains
 * (it holds the session state), so this module is the thin native half: it owns
 * the Tray, turns a serialized menu description into a real Menu, shows the
 * notifications and asks the window to come forward.
 *
 * Platform note: on Linux the tray is an AppIndicator, which only really
 * supports a menu — a left click opens it rather than toggling the window, and
 * `click` events may never fire. The menu therefore repeats the window actions
 * ("Open OpenCode Projects Studio") so nothing is unreachable there.
 */
const { Notification, Menu, Tray, app, nativeImage, shell } = require("electron")

/** Show the window, raising it if it exists but is hidden or minimised. */
function raiseWindow(window) {
  if (!window || window.isDestroyed()) return
  if (!window.isVisible()) window.show()
  if (window.isMinimized()) window.restore()
  window.focus()
}

/** Toggle the window: hide it when it is already in front, otherwise raise it. */
function toggleWindow(window) {
  if (!window || window.isDestroyed()) return
  if (window.isVisible() && window.isFocused()) window.hide()
  else raiseWindow(window)
}

function createTrayManager({ iconPath, getWindow }) {
  let tray = null
  /** Set from the renderer's pushes; the only source of truth for muting. */
  let muted = false
  /** Logged once, so the output stays readable while the badge changes. */
  let lastBadgeSize = 0
  let lastSummary = ""

  /** Turn the renderer's menu description into native menu items. */
  function buildMenu(items) {
    return Menu.buildFromTemplate(
      (items || []).map((item) => {
        if (item.type === "separator") return { type: "separator" }
        const entry = { label: item.label ?? "", enabled: item.enabled !== false }
        if (item.submenu?.length) entry.submenu = buildMenu(item.submenu)
        else if (item.sessionID) {
          entry.click = () => {
            raiseWindow(getWindow())
            const window = getWindow()
            if (window && !window.isDestroyed()) window.webContents.send("tray:focus-session", item.sessionID)
          }
        } else if (item.url) {
          // A conversation that lives in the web chat app: the browser owns it, so
          // the entry opens it there rather than raising this window.
          entry.click = () => {
            if (/^https?:\/\//i.test(item.url)) void shell.openExternal(item.url)
          }
        } else if (item.action === "open") {
          entry.click = () => raiseWindow(getWindow())
        } else if (item.action === "mute") {
          // The renderer owns the flag: it flips it, persists it and pushes a new
          // menu back, which is what keeps this in step with the app's own state.
          entry.click = () => {
            const window = getWindow()
            if (window && !window.isDestroyed()) window.webContents.send("tray:action", "mute")
          }
        } else if (item.action === "quit") {
          entry.click = () => app.quit()
        }
        return entry
      }),
    )
  }

  function ensure() {
    if (tray) return tray
    const image = nativeImage.createFromPath(iconPath)
    const size = image.getSize()
    if (image.isEmpty()) console.warn(`[tray] could not read ${iconPath}`)
    else console.log(`[tray] base icon ${size.width}x${size.height} from ${iconPath}`)
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip("OpenCode Projects Studio")
    // Where the platform delivers them, these make the tray a fast switcher.
    tray.on("click", () => toggleWindow(getWindow()))
    // The window already shows the last conversation that was active, so raising
    // it is all a double click needs to do.
    tray.on("double-click", () => raiseWindow(getWindow()))
    return tray
  }

  return {
    /** Create the tray icon, if it does not exist yet. */
    ensure,

    /** Apply a renderer push: badge bitmap, tooltip and menu. */
    update(payload) {
      const instance = ensure()
      if (!instance || instance.isDestroyed?.()) return
      if (payload?.dataURL) {
        const image = nativeImage.createFromDataURL(payload.dataURL)
        if (image.isEmpty()) {
          console.warn("[tray] badge bitmap could not be decoded; keeping the previous icon")
        } else {
          const size = image.getSize()
          if (size.width !== lastBadgeSize) {
            console.log(`[tray] badge icon ${size.width}x${size.height}`)
            lastBadgeSize = size.width
          }
          instance.setImage(image)
        }
      }
      if (payload?.tooltip) instance.setToolTip(payload.tooltip)
      if (Array.isArray(payload?.menu)) instance.setContextMenu(buildMenu(payload.menu))
      muted = Boolean(payload?.muted)

      const summary = `${payload?.tooltip ?? ""}|${payload?.menu?.length ?? 0}|${muted}`
      if (summary !== lastSummary) {
        lastSummary = summary
        console.log(`[tray] ${(payload?.tooltip ?? "").split("\n")[0]}`)
      }
    },

    /** Show a notification, unless muted, and open its conversation on click. */
    notify(payload) {
      if (muted || !Notification.isSupported()) return
      const notification = new Notification({
        title: payload?.title ?? "OpenCode Projects Studio",
        body: payload?.body ?? "",
        silent: false,
      })
      notification.on("click", () => {
        // A conversation in the web chat app belongs to the browser, so the click
        // opens it there rather than raising a window that does not hold it.
        if (payload?.url && /^https?:\/\//i.test(payload.url)) {
          void shell.openExternal(payload.url)
          return
        }
        raiseWindow(getWindow())
        const window = getWindow()
        if (payload?.sessionID && window && !window.isDestroyed()) {
          window.webContents.send("tray:focus-session", payload.sessionID)
        }
      })
      notification.show()
    },

    destroy() {
      if (tray && !tray.isDestroyed()) tray.destroy()
      tray = null
    },
  }
}

module.exports = { createTrayManager, raiseWindow }
