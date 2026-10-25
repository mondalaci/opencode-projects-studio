import iconUrl from "../../build/icon.png"
import type { ConversationState } from "./sessionState"

/**
 * Tray icon rendering.
 *
 * Trays have no numeric-badge API, so the badge is part of the bitmap: the app
 * icon with a state dot in the corner, and the attention count drawn into the
 * dot. The icon is the same file the window and the dock use, scaled down — a
 * panel's slot is small, but the app's mark is the app's mark.
 *
 * Drawing happens in the renderer (a canvas is right there) and the PNG is handed
 * to the main process through IPC. `build/tray.png` is a plain resize of the same
 * icon, and is what the tray shows until the renderer sends its first frame.
 */

/**
 * Dot colour per state: the traffic light from the sidebar. The idle grey is a
 * light one on purpose — against a dark panel the muted grey the sidebar uses is
 * invisible at tray size.
 */
const DOT_COLOURS: Record<ConversationState, string> = {
  blocked: "#e5484d",
  working: "#f5a623",
  done: "#35c06a",
  idle: "#c2c2c2",
}

/**
 * Drawn at 64px. The panel slot is about 30 logical pixels, so on a 2× display
 * this maps close to one image pixel per device pixel and stays crisp, where a
 * 32px bitmap had to be upscaled and looked soft next to other apps' icons.
 */
const SIZE = 64

/**
 * The dot radius, as a fraction of the icon, for a dot that carries no number.
 *
 * Both corners use it, so the two dots are the same size; only the badge grows
 * the right one, because only it has text to fit.
 */
const DOT_RADIUS = 0.15

/**
 * Which corner a dot sits in. Studio's own conversations take the right one; the
 * web chat app's take the left, so one icon carries both without either hiding
 * the other.
 */
type Corner = "left" | "right"

let cache = new Map<string, string>()
let icon: HTMLImageElement | null = null

/** The app icon, once the browser has decoded it. */
function loadIcon(): Promise<HTMLImageElement> {
  if (icon) return Promise.resolve(icon)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      icon = image
      resolve(image)
    }
    image.onerror = () => reject(new Error(`could not load ${iconUrl}`))
    image.src = iconUrl
  })
}

function drawDot(
  ctx: CanvasRenderingContext2D,
  state: ConversationState,
  count: number,
  corner: Corner = "right",
) {
  const badge = count > 0
  const offset = SIZE / 32
  // Two characters ("9+") need a wider dot, or the text overflows it.
  const radius = badge ? (count > 9 ? SIZE * 0.28 : SIZE * 0.22) : SIZE * DOT_RADIUS
  const cx = corner === "left" ? radius + offset / 2 : SIZE - radius - offset / 2
  const cy = SIZE - radius - offset / 2

  ctx.beginPath()
  ctx.arc(cx, cy, radius + offset, 0, Math.PI * 2)
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)"
  ctx.fill()

  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = DOT_COLOURS[state]
  ctx.fill()

  if (!badge) return
  const text = count > 9 ? "9+" : String(count)
  ctx.fillStyle = "#ffffff"
  ctx.font = `700 ${Math.round(text.length > 1 ? SIZE * 0.24 : SIZE * 0.28)}px system-ui, -apple-system, 'Segoe UI', Roboto, 'DejaVu Sans', sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(text, cx, cy + 0.5)
}

/**
 * A PNG data URL for the tray: the app icon with a state dot in each bottom
 * corner — studio's own conversations on the right, the web chat app's on the
 * left. Both are always drawn and both use the same base size; only the number
 * grows the right one, because only it carries text. A grey dot therefore means
 * the same thing in either corner: nothing to report.
 *
 * Results are cached per combination, since the panel is redrawn rarely.
 */
export async function trayIconDataURL(
  state: ConversationState,
  count: number,
  webchat: ConversationState,
): Promise<string> {
  const key = `${state}:${count}:${webchat}`
  const cached = cache.get(key)
  if (cached) return cached

  const image = await loadIcon()
  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext("2d")
  if (!ctx) return ""

  // With a badge the icon shifts left and shrinks a little, so the larger dot
  // clears it.
  const badge = count > 0
  const side = SIZE * (badge ? 0.84 : 0.96)
  ctx.drawImage(image, badge ? SIZE * 0.04 : (SIZE - side) / 2, (SIZE - side) / 2, side, side)

  drawDot(ctx, state, count)
  drawDot(ctx, webchat, 0, "left")

  const url = canvas.toDataURL("image/png")
  cache.set(key, url)
  // The cache is keyed by the states, so it stays tiny; bound it anyway.
  if (cache.size > 40) cache = new Map(cache)
  return url
}
