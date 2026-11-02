<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ChevronDown, ChevronUp, X } from "lucide-vue-next"
import { closeFind, findFocusRequest } from "@/stores/find"

/**
 * Find bar for the open conversation (Ctrl+F).
 *
 * Matching happens against the rendered thread, which keeps it identical to what
 * the reader sees: only text that is actually on screen is searched, including
 * code blocks and reasoning, exactly as a browser's find would. Matches are
 * painted with the CSS Custom Highlight API, so the conversation's own DOM is
 * never modified — no wrappers to fight Vue's rendering or the streaming agent.
 *
 * Enter and Shift+Enter walk the matches; Escape closes the bar.
 */

/** Registry keys for the two highlight layers. */
const ALL = "studio-find"
const CURRENT = "studio-find-current"

/** The Custom Highlight API is a Chromium feature; fall back to counting only. */
const canHighlight = typeof CSS !== "undefined" && "highlights" in CSS

const input = ref<HTMLInputElement | null>(null)
const query = ref("")
const matches = ref<Range[]>([])
const index = ref(0)

/** The scrolling conversation; the search is scoped to whatever it holds. */
function thread(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".thread")
}

/** True for elements whose text is not part of the readable conversation. */
function isSkipped(element: Element | null): boolean {
  return Boolean(element?.closest("script, style, noscript, textarea"))
}

/**
 * Whether a match is hidden because it sits outside a scrolling window it lives
 * in. Reasoning, tool, file and compose panes are fixed-height views onto longer
 * text (`max-height` + `overflow-y: auto`), so a match below their fold still has
 * a layout rectangle but is clipped away — scrolling to it would centre a spot
 * that shows nothing. The thread is excluded: it is the scroller the find bar
 * drives, so a match outside *it* is exactly what we scroll to.
 *
 * `clips` caches the per-element overflow test, since a big search walks the
 * same ancestors for every match.
 */
function isClipped(node: Text, rect: DOMRect, clips: WeakMap<Element, boolean>): boolean {
  const root = thread()
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    let hidden = clips.get(el)
    if (hidden === undefined) {
      hidden = getComputedStyle(el).overflowY !== "visible"
      clips.set(el, hidden)
    }
    if (!hidden) continue
    const box = el.getBoundingClientRect()
    if (rect.bottom <= box.top || rect.top >= box.bottom) return true
  }
  return false
}

/** Every rendered text node in the thread, in reading order. */
function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT
      if (isSkipped(node.parentElement)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

/**
 * Recompute the match list. `keep` is the index to hold onto when the thread
 * changes underneath (a streaming reply appending text), so the reader stays on
 * the match they are looking at rather than snapping back to the first.
 */
function compute(keep: number, scroll: boolean) {
  const root = thread()
  // Matched verbatim: a trailing space is meaningful, so "now " finds "now "
  // rather than every "know". Only an all-whitespace query counts as empty.
  const needle = query.value
  const found: Range[] = []
  if (root && needle.trim()) {
    const haystackNeedle = needle.toLowerCase()
    const clips = new WeakMap<Element, boolean>()
    for (const node of collectTextNodes(root)) {
      const text = node.nodeValue ?? ""
      const haystack = text.toLowerCase()
      let from = 0
      for (;;) {
        const at = haystack.indexOf(haystackNeedle, from)
        if (at === -1) break
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        // Only count what is actually visible: text that is not painted, or that
        // is scrolled out of a fixed-height pane, is skipped so the count and the
        // scroll both point at a match the reader can see.
        const rects = range.getClientRects()
        if (rects.length > 0 && !isClipped(node, rects[0], clips)) found.push(range)
        from = at + needle.length
      }
    }
  }
  matches.value = found
  index.value = found.length ? Math.min(Math.max(keep, 0), found.length - 1) : 0
  paint()
  if (scroll && found.length) reveal()
}

/** Push the ranges into the highlight registry. */
function paint() {
  if (!canHighlight) return
  if (matches.value.length) CSS.highlights.set(ALL, new Highlight(...matches.value))
  else CSS.highlights.delete(ALL)
  const current = matches.value[index.value]
  // Registered after ALL, so it wins where the two overlap.
  if (current) CSS.highlights.set(CURRENT, new Highlight(current))
  else CSS.highlights.delete(CURRENT)
}

/** Monotonic token so a superseded reveal stops animating. */
let revealToken = 0
let scrollFrame: number | null = null

/** Gap below which a match already sits close enough to centre not to move. */
const CENTRE_DEAD_ZONE = 24

/** Scroll the active match to the middle of the thread. */
function reveal() {
  // Any reveal supersedes a pending debounced one, so typing then pressing
  // Enter does not move twice.
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  const root = thread()
  const range = matches.value[index.value]
  if (!root || !range) return

  const token = ++revealToken
  const start = root.scrollTop
  const target = targetScroll(root, range)
  if (Math.abs(target - start) < CENTRE_DEAD_ZONE) return
  animateScroll(root, start, target, token)
}

/** The scrollTop that centres the match vertically in the thread. */
function targetScroll(root: HTMLElement, range: Range): number {
  const box = root.getBoundingClientRect()
  const rect = range.getBoundingClientRect()
  // Where the match sits in the thread's content, independent of scroll.
  const contentTop = rect.top - box.top + root.scrollTop
  const max = Math.max(0, root.scrollHeight - root.clientHeight)
  const centred = contentTop - (root.clientHeight - rect.height) / 2
  return Math.min(Math.max(centred, 0), max)
}

/**
 * Ease the thread to `target` over a distance-scaled duration. Driving scrollTop
 * ourselves keeps the motion identical everywhere: Chromium's own
 * `scrollIntoView({ behavior: "smooth" })` is silently downgraded to a jump in
 * some environments (notably under reduced-motion or without compositor smooth
 * scrolling), which reads as no animation at all.
 */
function animateScroll(root: HTMLElement, start: number, target: number, token: number) {
  if (scrollFrame != null) cancelAnimationFrame(scrollFrame)
  const distance = target - start
  const duration = Math.min(650, Math.max(220, Math.abs(distance) * 0.4))
  const began = performance.now()
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const step = (now: number) => {
    if (token !== revealToken) return
    const t = Math.min(1, (now - began) / duration)
    root.scrollTop = start + distance * ease(t)
    scrollFrame = t < 1 ? requestAnimationFrame(step) : null
  }
  scrollFrame = requestAnimationFrame(step)
}

function clearHighlights() {
  if (!canHighlight) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

function move(delta: number) {
  const count = matches.value.length
  if (!count) return
  index.value = (index.value + delta + count) % count
  paint()
  reveal()
}

// Typing updates the highlights at once, but the scroll waits for a pause.
// Searching on every keystroke scrolled for each intermediate prefix — "i",
// "in", "int" — so a retype jumped around before settling on the final match.
let revealTimer: ReturnType<typeof setTimeout> | null = null

watch(query, () => {
  compute(0, false)
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = setTimeout(reveal, 250)
})

// The thread grows while the agent streams and while images or code finish
// laying out; re-run so the count and the highlights stay correct. Debounced,
// and it never steals the scroll position.
let observer: MutationObserver | null = null
let pending: ReturnType<typeof setTimeout> | null = null

function scheduleRecompute() {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => compute(index.value, false), 200)
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "Escape":
      event.preventDefault()
      closeFind()
      break
    case "Enter":
      event.preventDefault()
      move(event.shiftKey ? -1 : 1)
      break
    default:
      break
  }
}

onMounted(() => {
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
  const root = thread()
  if (root) {
    observer = new MutationObserver(scheduleRecompute)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (pending) clearTimeout(pending)
  if (revealTimer) clearTimeout(revealTimer)
  if (scrollFrame != null) cancelAnimationFrame(scrollFrame)
  clearHighlights()
})

// Ctrl+F pressed while the bar is already open re-focuses and selects, so the
// next word replaces the current one.
watch(findFocusRequest, () => {
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
})

const count = computed(() => matches.value.length)
const position = computed(() => (count.value ? index.value + 1 : 0))
</script>

<template>
  <div class="find-bar" role="search" aria-label="Find in conversation">
    <div class="find-field">
      <input
        ref="input"
        v-model="query"
        class="find-input"
        type="text"
        placeholder="Find in conversation…"
        spellcheck="false"
        autocomplete="off"
        @keydown="onKeydown"
      />
      <span class="find-count" :class="{ empty: query.trim() && !count }">
        {{ query.trim() ? `${position} / ${count}` : "" }}
      </span>
      <button class="find-btn" title="Previous match (Shift+Enter)" :disabled="!count" @click="move(-1)">
        <ChevronUp :size="15" />
      </button>
      <button class="find-btn" title="Next match (Enter)" :disabled="!count" @click="move(1)">
        <ChevronDown :size="15" />
      </button>
      <button class="find-btn" title="Close (Esc)" @click="closeFind()">
        <X :size="15" />
      </button>
    </div>
    <p v-if="query.trim() && !count" class="find-empty">No matches</p>
  </div>
</template>

<style scoped>
.find-bar {
  position: absolute;
  top: calc(var(--header-height) + 8px);
  right: 16px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.find-field {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 5px 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
}
.find-field:focus-within {
  border-color: var(--accent);
}
.find-input {
  width: 200px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
}
.find-count {
  flex: none;
  min-width: 44px;
  text-align: right;
  font-size: 11.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.find-count.empty {
  color: var(--danger);
}
.find-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
}
.find-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.find-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.find-empty {
  margin: 0;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
  color: var(--text-muted);
  font-size: 11.5px;
}
</style>
