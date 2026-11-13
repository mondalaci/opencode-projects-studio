/**
 * The change map's drawing, kept pure so its geometry can be checked without a
 * browser: which rows are marked, where the half-width blocks land, and that a
 * change in a very long file still gets at least a hairline.
 */

export interface ChangeMark {
  /** The row removed lines. */
  del: boolean
  /** The row added lines. */
  add: boolean
}

/**
 * Where one marked row sits in the strip, as fractions of the file's full
 * height — the same fractions the viewport block is positioned in, so the two
 * agree even though a row that wraps to three lines takes three lines' worth of
 * height rather than one slot.
 */
export interface ChangeSpan {
  /** The row's top, as a fraction of the file's height. */
  top: number
  /** The row's height, as a fraction of the file's height. */
  height: number
}

export interface ChangePalette {
  del: string
  add: string
}

/** The subset of the 2D context this needs, so a test can stand in for it. */
export interface ChangeMapTarget {
  // Widened to match the real context, which also accepts a gradient or pattern.
  fillStyle: string | CanvasGradient | CanvasPattern
  clearRect(x: number, y: number, width: number, height: number): void
  fillRect(x: number, y: number, width: number, height: number): void
}

/**
 * Draw `marks` scaled into a `width` × `height` strip: removals on the left half,
 * additions on the right, so a line that replaced another shows both.
 *
 * `spans` runs parallel to `marks` and says where each row sits. The strip is on
 * the scrollbar's scale, not one slot per row, so the marks land under the
 * viewport block that covers them: a wrapped row is as tall here as it is in the
 * diff, and a change in a very long file still gets at least a hairline.
 */
export function drawChangeMap(
  ctx: ChangeMapTarget,
  width: number,
  height: number,
  marks: readonly ChangeMark[],
  spans: readonly ChangeSpan[],
  palette: ChangePalette,
): void {
  ctx.clearRect(0, 0, width, height)
  if (!marks.length || width <= 0 || height <= 0) return

  for (let index = 0; index < marks.length; index++) {
    const mark = marks[index]
    if (!mark.del && !mark.add) continue
    const span = spans[index]
    const y = span.top * height
    const rowHeight = Math.max(1, span.height * height)
    if (mark.del) {
      ctx.fillStyle = palette.del
      ctx.fillRect(0, y, width / 2, rowHeight)
    }
    if (mark.add) {
      ctx.fillStyle = palette.add
      ctx.fillRect(width / 2, y, width / 2, rowHeight)
    }
  }
}
