<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import MessageItem from "./MessageItem.vue"
import Spinner from "./Spinner.vue"
import { useChat } from "@/stores/chat"

const { messages, loading, currentSessionID, scrollToBottomRequest, pendingForms, pendingPermissions, isBusy } = useChat()

const viewport = ref<HTMLElement | null>(null)
const pinned = ref(true)

// Distance (px) from the bottom that still counts as "at the bottom".
const BOTTOM_EPSILON = 8

// A scroll event produced by our own scrollToBottom must not be mistaken for a
// user decision to detach from the bottom.
let programmatic = false
let touchY = 0

const lastAssistantID = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].type === "assistant") return messages.value[i].id
  }
  return null
})

/** The newest message, which is the one a live turn is still appending to. */
const lastID = computed(() => messages.value[messages.value.length - 1]?.id ?? null)

function onScroll() {
  const el = viewport.value
  if (!el) return
  if (programmatic) {
    programmatic = false
    return
  }
  // Any non-programmatic scroll that leaves the bottom detaches immediately, so
  // even a small scroll-up during streaming sticks instead of being pulled back.
  // Re-attach only when the user returns to (near) the bottom themselves.
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON
}

function detach() {
  pinned.value = false
}

function onWheel(event: WheelEvent) {
  if (event.deltaY < 0) detach()
}

function onTouchStart(event: TouchEvent) {
  touchY = event.touches[0]?.clientY ?? 0
}

function onTouchMove(event: TouchEvent) {
  if ((event.touches[0]?.clientY ?? 0) > touchY + 4) detach()
}

async function scrollToBottom() {
  if (!pinned.value) return
  await nextTick()
  const el = viewport.value
  if (!el || !pinned.value) return
  programmatic = true
  el.scrollTop = el.scrollHeight
  // The scroll event fires before animation-frame callbacks; clear here too in
  // case setting scrollTop produced no event (already at the bottom).
  requestAnimationFrame(() => {
    programmatic = false
  })
}

watch(messages, () => {
  if (pinned.value) void scrollToBottom()
}, { deep: true })

watch(loading, (value) => {
  if (!value) void scrollToBottom()
})

watch(scrollToBottomRequest, () => {
  pinned.value = true
  void scrollToBottom()
})

watch(currentSessionID, () => {
  pinned.value = true
  programmatic = false
}, { flush: "post" })

/**
 * A question or a permission card is appended to the conversation, which grows
 * the thread without touching `messages`. Follow it the way a new message is
 * followed, so an ask that arrives while the view is pinned does not end up
 * below the fold. `scrollToBottom` is a no-op while the reader has scrolled up.
 */
watch(
  [() => pendingForms.value.length, () => pendingPermissions.value.length],
  ([forms, permissions], [wasForms, wasPermissions]) => {
    if (forms > wasForms || permissions > wasPermissions) void scrollToBottom()
  },
)

/**
 * Opening the thread — first load, a session switch, or coming back from the
 * diff view, which unmounts it — must show where the conversation got to rather
 * than start at the first message. The frame after covers content that takes a
 * moment to lay out, such as images and highlighted code.
 */
onMounted(() => {
  pinned.value = true
  void scrollToBottom()
  requestAnimationFrame(() => void scrollToBottom())
})
</script>

<template>
  <div
    ref="viewport"
    class="thread"
    @scroll="onScroll"
    @wheel="onWheel"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
  >
    <div v-if="loading" class="loading"><Spinner :size="18" /></div>

    <template v-else>
      <MessageItem
        v-for="message in messages"
        :key="message.id"
        :message="message"
        :streaming="message.id === lastAssistantID && message.type === 'assistant' && !message.time?.completed"
        :caret="isBusy && message.type === 'assistant' && message.id === lastID"
      />
    </template>

    <!-- Turn-level widgets the app weaves into the conversation: questions and
         permission cards sit after the last message, above the composer. -->
    <slot />

    <div class="spacer"></div>
  </div>
</template>

<style scoped>
.thread {
  flex: 1;
  overflow-y: auto;
  /* A conversation never scrolls sideways. Parts that are genuinely wider than
     the column — a code block, a table, a diagram — carry their own scrollbar,
     so anything left over is a line that failed to wrap: it should be clipped
     rather than drag the whole conversation out of view. */
  overflow-x: hidden;
  padding: 20px 20px 0;
  /* No `scroll-behavior: smooth`: the animation fires intermediate scroll
     events that re-pin the view to the bottom mid-follow, fighting a user who
     is scrolling up. Programmatic follows are instant instead. */
  /* Reserve a symmetric gutter so a scrollbar does not shift the centered
     content column off the composer's center. */
  scrollbar-gutter: stable both-edges;
}
.loading {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--text-muted);
}
.spacer {
  height: 12px;
}
</style>