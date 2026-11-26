<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { X } from "lucide-vue-next"
import { closeImage, lightboxImage } from "@/stores/lightbox"

/**
 * The enlarged view of an image from a conversation.
 *
 * It covers the whole window — sidebars included, since "full size in the
 * window" means the largest the screen allows — and dismisses on a click
 * anywhere or Escape, which puts the thread's own size back on screen.
 *
 * The fitted view is the default, but a 1:1 toggle shows one image pixel per
 * screen pixel for reading text or judging detail without interpolation. The
 * screen's pixel ratio has to be divided out: an intrinsic size in CSS pixels
 * is doubled on a HiDPI display, which is the opposite of 1:1. A 1:1 image
 * larger than the window scrolls, and dragging pans it; the image itself no
 * longer closes the overlay in that mode, so it can be studied.
 */
const actualSize = ref(false)
const stage = ref<HTMLElement | null>(null)
const naturalSize = ref({ width: 0, height: 0 })
const pixelRatio = ref(window.devicePixelRatio || 1)

/** The intrinsic size in screen pixels, not the doubled CSS pixels of HiDPI. */
const actualSizeStyle = computed(() => {
  if (!actualSize.value || !naturalSize.value.width || !naturalSize.value.height) return undefined
  return {
    width: `${naturalSize.value.width / pixelRatio.value}px`,
    height: `${naturalSize.value.height / pixelRatio.value}px`,
  }
})

function onImageLoad(event: Event) {
  const image = event.target as HTMLImageElement
  naturalSize.value = { width: image.naturalWidth, height: image.naturalHeight }
}

// A move to a display with a different scale must not resize the 1:1 image.
let ratioQuery: MediaQueryList | null = null
function watchPixelRatio() {
  ratioQuery?.removeEventListener("change", onRatioChange)
  ratioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  ratioQuery.addEventListener("change", onRatioChange)
}
function syncPixelRatio() {
  const next = window.devicePixelRatio || 1
  if (next === pixelRatio.value) return
  pixelRatio.value = next
  watchPixelRatio()
}
function onRatioChange() {
  syncPixelRatio()
}

// Every image starts fitted, so opening one keeps the lightbox's old behaviour.
watch(lightboxImage, () => {
  actualSize.value = false
  naturalSize.value = { width: 0, height: 0 }
})

function toggleActualSize() {
  actualSize.value = !actualSize.value
  // Land in the middle of a large image rather than its top-left corner.
  nextTick(() => {
    const element = stage.value
    if (!element) return
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
  })
}

/** Drag-to-pan for a 1:1 image that is larger than the window. */
function startPan(event: PointerEvent) {
  if (!actualSize.value || event.button !== 0) return
  // Only the image pans; the ground around it stays a way out of the overlay.
  if ((event.target as HTMLElement | null)?.tagName !== "IMG") return
  const element = stage.value
  if (!element) return
  if (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startY = event.clientY
  const left = element.scrollLeft
  const top = element.scrollTop
  handle.setPointerCapture(event.pointerId)
  const onMove = (move: PointerEvent) => {
    element.scrollLeft = left - (move.clientX - startX)
    element.scrollTop = top - (move.clientY - startY)
  }
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove)
    handle.removeEventListener("pointerup", onUp)
  }
  handle.addEventListener("pointermove", onMove)
  handle.addEventListener("pointerup", onUp)
}

function onClick(event: MouseEvent) {
  // At 1:1 the image is what is being studied, so only the ground around it
  // returns to the conversation.
  if (actualSize.value && (event.target as HTMLElement | null)?.tagName === "IMG") return
  closeImage()
}

function onKeydown(event: KeyboardEvent) {
  if (!lightboxImage.value) return
  if (event.key === "Escape") {
    event.stopPropagation()
    closeImage()
  } else if (event.key === "1") {
    event.preventDefault()
    toggleActualSize()
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown)
  window.addEventListener("resize", syncPixelRatio)
  watchPixelRatio()
})
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown)
  window.removeEventListener("resize", syncPixelRatio)
  ratioQuery?.removeEventListener("change", onRatioChange)
})
</script>

<template>
  <div
    v-if="lightboxImage"
    class="lightbox"
    role="dialog"
    aria-modal="true"
    :aria-label="lightboxImage.alt || 'Image'"
    :title="actualSize ? undefined : 'Click to return to the conversation'"
    @click="onClick"
  >
    <div class="tools">
      <button
        class="tool"
        type="button"
        :aria-pressed="actualSize"
        :title="actualSize ? 'Fit to window (1)' : 'Actual size, 1:1 (1)'"
        @click.stop="toggleActualSize()"
      >
        {{ actualSize ? "Fit" : "1:1" }}
      </button>
      <button class="close" type="button" title="Close (Esc)" @click.stop="closeImage()"><X :size="18" /></button>
    </div>
    <div ref="stage" class="stage" :class="{ actual: actualSize }" @pointerdown="startPan">
      <img
        :src="lightboxImage.src"
        :alt="lightboxImage.alt"
        :style="actualSizeStyle"
        :draggable="false"
        @load="onImageLoad"
      />
    </div>
    <p v-if="lightboxImage.alt" class="caption">{{ lightboxImage.alt }}</p>
  </div>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  /* Above the panels and the window controls, since it covers them. */
  z-index: 200;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, #000 78%, transparent);
}
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  padding: 24px;
  overflow: hidden;
}
/* A 1:1 image can be wider or taller than the window; the stage scrolls and a
   drag pans it, so no part of it is out of reach. */
.stage.actual {
  overflow: auto;
  overscroll-behavior: contain;
  cursor: grab;
}
.stage.actual:active {
  cursor: grabbing;
}
.stage img {
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  cursor: zoom-out;
  user-select: none;
  -webkit-user-drag: none;
}
.stage.actual img {
  max-width: none;
  max-height: none;
  cursor: inherit;
}
.tools {
  position: absolute;
  top: 10px;
  right: 12px;
  display: flex;
  gap: 6px;
  z-index: 1;
}
.tool,
.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}
.tool {
  padding: 0 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
}
.close {
  width: 30px;
}
.tool:hover,
.close:hover {
  background: rgba(255, 255, 255, 0.24);
}
.caption {
  max-width: 90%;
  margin: 0 auto 12px;
  font-size: 12px;
  color: #e6e6e6;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
