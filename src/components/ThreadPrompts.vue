<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { ArrowDown, ArrowUp, User } from "lucide-vue-next"
import ShortcutBadge from "./ShortcutBadge.vue"
import { useChat } from "@/stores/chat"
import { promptSteps } from "@/stores/shortcuts"

/**
 * The user's own messages as a way through a long conversation, hung off the
 * thread's scrollbar: a tick at the height each prompt sits at, and a button at
 * the thread's top and bottom right that steps to the prompt above or below the
 * reader. `Alt` + the arrow each carries does the same, except that `Alt`+`↓`
 * with no prompt below it goes all the way to the end of the conversation, where
 * the last reply leaves off.
 *
 * The ticks are placed on the scrollbar's own scale — the fraction of the
 * scrollable content a message occupies, as the drawn thumb is — and are drawn in
 * the lane the scrollbar is drawn in, the gutter the thread reserves for it, so
 * they land on the thumb's track rather than reaching over the text. The lane
 * stays the scrollbar's: the ticks take no pointer events, and a click on them
 * scrolls the conversation the way a click on the track does. The buttons do
 * take clicks, and sit clear of that lane, over the thread's own padding.
 *
 * The way back to the end of the conversation is not here: it belongs to the
 * whole pane rather than to the thread, so it hangs in the composer's row, at the
 * bottom of the window. `ChatShell` draws it, on the `contentBelow` the thread
 * publishes.
 */
const props = defineProps<{
  /** The scrolling thread the prompts belong to, once it exists. */
  body: HTMLElement | null
  /** The element holding the whole conversation inside that thread. */
  content: HTMLElement | null
  /** The messages to mark and step through, in conversation order. */
  ids: string[]
}>()

const { requestScrollToBottom } = useChat()

/** Each prompt's top in the thread's content, and how tall that content is. */
const offsets = ref<number[]>([])
const total = ref(0)

/** Ticks and buttons are for a conversation that scrolls; a thread that fits
 *  has nothing below the fold to jump to. */
const scrollable = ref(false)

/** The prompt a step would land on, or null when there is none that way. */
const above = ref<number | null>(null)
const below = ref<number | null>(null)

/** How far off the top edge a prompt still counts as level with it. */
const EDGE = 4

/** How far inside the top edge a prompt lands when it is stepped to, so the
 *  reply to it is what the reader is looking at. */
const LAND = 12

/** The scroll position and the frame, for placing the drawn thumb. */
const scrolled = ref(0)
const viewport = ref(0)

/** The shortest a thumb is drawn, or a long conversation's would be a sliver
 *  rather than something to read against. */
const MIN_THUMB = 12

/**
 * The lane's scale: how far down the lane a pixel of content sits.
 *
 * The marks and the thumb are placed on this one scale, which is what keeps a
 * mark level with the thumb that reads it. It is *not* simply the content's
 * fraction: a thumb clamped to a minimum length has less lane to travel, so the
 * two would part company by half a thumb — a mark sitting in the middle of the
 * band the reader is looking at instead of at its edge.
 */
const scale = computed(() => {
  const visible = viewport.value
  const total_ = total.value
  if (!total_ || total_ - visible <= 1) return 0
  const height = Math.max((visible / total_) * visible, MIN_THUMB)
  return Math.max(visible - height, 0) / (total_ - visible)
})

/** Where the ticks go, as a distance down the lane. */
const tops = computed(() => offsets.value.map((offset) => offset * scale.value))

/** The thumb, drawn rather than left to the browser. */
const thumb = computed(() => {
  const visible = viewport.value
  if (!total.value) return { top: 0, height: 0 }
  const height = Math.max((visible / total.value) * visible, MIN_THUMB)
  const travel = Math.max(visible - height, 0)
  return { top: Math.min(scrolled.value * scale.value, travel), height }
})

function measure() {
  const body = props.body
  const height = body?.scrollHeight ?? 0
  if (!body || height - body.clientHeight <= 1) {
    scrollable.value = false
    return
  }
  const box = body.getBoundingClientRect()
  const scrollTop = body.scrollTop
  // A message's place in the content, read off its rect without caring where
  // the thread is scrolled to, then compared with that scroll to see which way
  // there is to go.
  const rows = props.ids
    .map((id) => body.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`))
    .filter((element): element is HTMLElement => element !== null)
  offsets.value = rows.map((element) => element.getBoundingClientRect().top - box.top + scrollTop)
  total.value = height

  // The two directions are not symmetric about the top edge. Going up, the edge
  // itself is the boundary, so a prompt level with it is the one being read and
  // a step leaves it behind. Going down, the prompt a step just landed there has
  // to be stepped over — otherwise the button would land on it again and again —
  // which is why that side clears the landing offset as well as the edge. A
  // prompt in the last screenful cannot be brought to the top at all, so it is
  // not a step either: landing it is what the bottom of the thread already is.
  const maxScroll = height - body.clientHeight
  let up: number | null = null
  let down: number | null = null
  const land = scrollTop + LAND + EDGE
  for (const offset of offsets.value) {
    if (offset < scrollTop - EDGE) up = offset
    else if (offset > land && down === null && landing(offset, maxScroll) > scrollTop) down = offset
  }
  above.value = up
  below.value = down
  scrolled.value = scrollTop
  viewport.value = body.clientHeight
  scrollable.value = true
}

/** Where a step to `offset` comes to rest: the top edge, as far as the thread
 *  can scroll. */
function landing(offset: number, maxScroll: number): number {
  return Math.min(Math.max(offset - LAND, 0), maxScroll)
}

/** Step to a prompt, landing it just inside the top edge. The measure that
 *  follows is immediate rather than waiting for the scroll event, so a second
 *  click steps on from where the first one landed. The scroll and the button
 *  states are computed from the same landing, so a click that cannot move
 *  cannot leave the button looking as though it could. */
function jump(offset: number | null) {
  const body = props.body
  if (!body || offset === null) return
  const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight)
  body.scrollTop = landing(offset, maxScroll)
  measure()
}

let observer: ResizeObserver | null = null
let detach: (() => void) | null = null
let frame = 0

/**
 * Scrolling moves nothing on its own — a message's place in the content is
 * measured from the content, not from the viewport — but it is what decides
 * which way the buttons can step, so the state is refreshed as the reader moves.
 */
function onScroll() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    measure()
  })
}

watch(
  () => [props.body, props.content] as const,
  ([body, content]) => {
    detach?.()
    detach = null
    if (!body) {
      scrollable.value = false
      return
    }
    const onResize = () => measure()
    body.addEventListener("scroll", onScroll, { passive: true })
    observer = new ResizeObserver(onResize)
    observer.observe(body)
    // The conversation's own height, as well as the frame's: a reply streaming
    // in while the reader is scrolled up — the case where the thread does not
    // scroll and no prompt arrives — is a change to this and to nothing else,
    // and without it the marks keep the heights they were measured at and drift
    // up the scrollbar as the conversation grows under them.
    if (content) observer.observe(content)
    detach = () => {
      body.removeEventListener("scroll", onScroll)
      observer?.disconnect()
      observer = null
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }
    measure()
  },
  // Post-flush, so the messages are in the DOM before they are measured; the
  // first call has no body yet and no-ops, then the watcher fires once it
  // appears.
  { immediate: true, flush: "post" },
)

watch(
  () => props.ids,
  () => measure(),
  { flush: "post" },
)

/**
 * The same step, from the keyboard: `Alt` + the arrow each button carries. The
 * keys are handled where the rest of the app's shortcuts are, and arrive here as
 * a count, so a press while this component is not mounted is a step nobody
 * takes rather than a stale one that fires on the next mount.
 *
 * Going up, a step with nothing above it does nothing, exactly as its button
 * does. Going down, there is always something below unless the conversation is
 * already at its end — the tail of the last reply is as much "down" as the next
 * prompt — so the key finishes the journey the way the button at the bottom of
 * the window does. That is what a reader parked on the last prompt is asking
 * for, and it is why the key is not simply the disabled button's equal.
 */
watch(() => promptSteps.up, () => jump(above.value))
watch(() => promptSteps.down, () => (below.value === null ? requestScrollToBottom() : jump(below.value)))

onBeforeUnmount(() => detach?.())
</script>

<template>
  <template v-if="scrollable">
    <div class="ticks" aria-hidden="true">
      <span class="thumb" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }"></span>
      <span v-for="(top, index) in tops" :key="index" class="tick" :style="{ top: `${top}px` }"></span>
    </div>

    <div class="steps top">
      <button
        type="button"
        class="step float-pill"
        :disabled="above === null"
        title="Jump to your previous message (Alt+↑)"
        aria-label="Jump to your previous message"
        @click="jump(above)"
      >
        <User :size="13" />
        <ArrowUp :size="12" />
        <ShortcutBadge placement="inside" modifier="alt" key-label="↑" />
      </button>
    </div>

    <div class="steps bottom">
      <button
        type="button"
        class="step float-pill"
        :disabled="below === null"
        title="Jump to your next message (Alt+↓)"
        aria-label="Jump to your next message"
        @click="jump(below)"
      >
        <User :size="13" />
        <ArrowDown :size="12" />
        <ShortcutBadge placement="inside" modifier="alt" key-label="↓" />
      </button>
    </div>
  </template>
</template>

<style scoped>
/* The lane the app draws its scrollbars in, at the thread's right edge, where
   the bar itself sits. */
.ticks {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 10px;
  pointer-events: none;
}
/* Inside the thumb's own inset, so a tick reads as a mark on the bar rather
   than as something beside it. */
.tick {
  position: absolute;
  right: 3px;
  width: 4px;
  height: 3px;
  border-radius: 1.5px;
  background: var(--text-muted);
}
/* The bar itself, on the marks' scale rather than the theme's: same lane, same
   inset, same rounding, so a mark and the thumb it belongs to line up. */
.thumb {
  position: absolute;
  right: 3px;
  width: 4px;
  border-radius: 2px;
  background: var(--scroll-thumb);
}
/* At the thread's ends, clear of the scrollbar lane: over the thread's own
   padding, not over the text column it keeps a gutter for. */
.steps {
  position: absolute;
  right: 12px;
  display: flex;
  gap: 6px;
}
.steps.top {
  top: 8px;
}
.steps.bottom {
  bottom: 8px;
}
/* The pill is the shared floating-control look; what is left here is the button
   being its own containing block, for the held-Alt badge. */
.step {
  position: relative;
}
</style>
