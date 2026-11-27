<script setup lang="ts">
import { computed, ref } from "vue"

/**
 * A draggable separator between two panes, in either orientation.
 *
 * Both axes share one look and one set of affordances: a quiet band that fills
 * with the accent while it is hovered, dragged or focused, so a vertical divider
 * never reads as a different kind of control from a horizontal one. The
 * component only reports a value; the owner keeps it in whatever unit suits:
 * pixels for a panel's width, a fraction for a split of one height.
 */
const props = withDefaults(
  defineProps<{
    /** The size the separator reports, owned by the parent. */
    modelValue: number
    min: number
    max: number
    /** How much one arrow key press changes the value. */
    step?: number
    /** What a double-click — or Home — restores. */
    resetTo?: number
    /**
     * A panel on the right grows as the separator moves left, so the drag and the
     * arrow keys both invert. The default is a panel on the left or top, which
     * grows with the pointer and the forward arrow.
     */
    invert?: boolean
    orientation?: "vertical" | "horizontal"
    /**
     * The unit the value is kept in. A fraction is a share of the separator's
     * parent — a pane's height, for one that splits a single box — so the drag
     * divides the pointer's travel by the space it is dividing.
     */
    unit?: "px" | "fraction"
    /** A multiplier for the aria values, for a split kept as a fraction. */
    scale?: number
    label: string
  }>(),
  { step: 16, orientation: "vertical", unit: "px", scale: 1 },
)

const emit = defineEmits<{
  "update:modelValue": [value: number]
  /** The drag or a keyboard change ended, which is when the value is worth saving. */
  commit: [value: number]
}>()

/** Whether the separator is being dragged, for its highlight. */
const dragging = ref(false)

function clamp(value: number): number {
  return Math.min(props.max, Math.max(props.min, value))
}

/**
 * Drag the separator to give either pane more room.
 *
 * The value is measured from where the drag started rather than from the
 * separator's own position on screen: the pane's far edge stays put, so the
 * pointer's travel is exactly the size change, and only a fraction split needs
 * a layout read — the span it is a fraction of.
 */
function start(event: PointerEvent) {
  if (event.button !== 0) return
  const handle = event.currentTarget as HTMLElement
  event.preventDefault()
  handle.setPointerCapture(event.pointerId)
  dragging.value = true
  const along = props.orientation === "vertical" ? "clientX" : "clientY"
  const origin = event[along]
  const from = props.modelValue
  let latest = from
  // A pixel value is its own unit; a fraction has to be told what whole it is a
  // share of — the panes' span, which is the parent less the band this separator
  // itself takes out of it.
  let span = 1
  if (props.unit === "fraction") {
    const rect = handle.parentElement?.getBoundingClientRect()
    const size = rect ? (props.orientation === "vertical" ? rect.width : rect.height) : 0
    const band = props.orientation === "vertical" ? handle.offsetWidth : handle.offsetHeight
    span = size - band || 1
  }
  const onMove = (move: PointerEvent) => {
    const delta = ((move[along] - origin) * (props.invert ? -1 : 1)) / span
    latest = clamp(from + delta)
    emit("update:modelValue", latest)
  }
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove)
    handle.removeEventListener("pointerup", onUp)
    handle.removeEventListener("pointercancel", onUp)
    dragging.value = false
    // The parent's prop may not have come back around yet, so report the value
    // this drag last asked for rather than the one it started with.
    emit("commit", latest)
  }
  handle.addEventListener("pointermove", onMove)
  handle.addEventListener("pointerup", onUp)
  handle.addEventListener("pointercancel", onUp)
}

/** The same adjustment from the keyboard, for a focused separator. */
function onKey(event: KeyboardEvent) {
  const back = props.orientation === "vertical" ? "ArrowLeft" : "ArrowUp"
  const forward = props.orientation === "vertical" ? "ArrowRight" : "ArrowDown"
  // The arrow moves the separator, and an inverted one grows as it moves back,
  // so its value follows the pointer's travel rather than the key's direction.
  const towards = props.invert ? -props.step : props.step
  let value: number
  if (event.key === back) value = props.modelValue - towards
  else if (event.key === forward) value = props.modelValue + towards
  else if (event.key === "Home" && props.resetTo !== undefined) value = props.resetTo
  else return
  event.preventDefault()
  value = clamp(value)
  emit("update:modelValue", value)
  emit("commit", value)
}

function reset() {
  if (props.resetTo === undefined) return
  emit("update:modelValue", props.resetTo)
  emit("commit", props.resetTo)
}

const title = computed(() =>
  props.resetTo === undefined ? "Drag to resize" : "Drag to resize (double-click to reset)",
)
</script>

<template>
  <div
    class="splitter"
    :class="[orientation, { dragging }]"
    role="separator"
    :aria-orientation="orientation"
    :aria-label="label"
    :aria-valuenow="Math.round(modelValue * scale)"
    :aria-valuemin="Math.round(min * scale)"
    :aria-valuemax="Math.round(max * scale)"
    tabindex="0"
    :title="title"
    @pointerdown="start"
    @dblclick="reset"
    @keydown="onKey"
  />
</template>

<style scoped>
/* The band is quiet at rest — the panes' own edges draw the line — and fills
   with the accent while the pointer is on it or a drag is in progress, so it
   reads as a handle only when it is one. */
.splitter {
  flex: none;
  outline: none;
  touch-action: none;
  background: transparent;
  transition:
    background 0.12s,
    opacity 0.12s;
}
.splitter.vertical {
  width: 5px;
  cursor: col-resize;
}
.splitter.horizontal {
  height: 5px;
  cursor: row-resize;
}
.splitter:hover,
.splitter.dragging,
.splitter:focus-visible {
  background: var(--accent);
  opacity: 0.5;
}
</style>
