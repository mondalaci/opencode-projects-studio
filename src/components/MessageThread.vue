<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import MessageItem from "./MessageItem.vue"
import Spinner from "./Spinner.vue"
import ThreadPrompts from "./ThreadPrompts.vue"
import { useChat } from "@/stores/chat"
import { findOpen } from "@/stores/find"

const { messages, conversation, loading, currentSessionID, scrollToBottomRequest, contentBelow, pendingForms, pendingPermissions, isBusy, awaitingUser } = useChat()

const viewport = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const pinned = ref(true)

/** What the scrollbar's ticks mark: the prompts, in the order they were asked. */
const promptIDs = computed(() => conversation.value.filter((message) => message.type === "user").map((message) => message.id))

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

/**
 * The caret's owner: the caret is the turn's heartbeat, so it blinks for as long
 * as the turn runs — while prose streams and while a tool call outlives the step
 * that started it. A turn blocked on a question or a permission is waiting for
 * the reader, not the model, so the caret rests there: a blinking cursor above
 * the card would promise something nothing is keeping.
 */
const caretID = computed(() => {
  if (!isBusy.value || awaitingUser.value) return null
  return lastAssistantID.value
})

function onScroll() {
  const el = viewport.value
  if (!el) return
  if (programmatic) {
    programmatic = false
    return
  }
  // While the thread is loading, the spinner stands in for the conversation and
  // the area is shorter than it was: the offset is clamped, and the viewport then
  // reports itself at the bottom from anywhere. That is the reload talking, not
  // the reader returning, and re-pinning on it would drag a long conversation to
  // its end as soon as the messages came back.
  if (loading.value) return
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

async function scrollToBottom(explicit = false) {
  // While the find bar is open the reader is searching, not following the
  // reply: pinning to the bottom would yank the view off whatever they jumped
  // to. Resume following once the bar closes. An explicit request — a prompt
  // just sent, a view returning, the button at the end of the window — is the
  // reader asking, not the follow doing it, so it goes through.
  if (!explicit && (!pinned.value || findOpen.value)) return
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
  void scrollToBottom(true)
})

/**
 * Publish the one thing the chrome outside the thread cannot see: whether the
 * conversation continues below the fold. The button that answers it hangs at the
 * bottom of the window, in the composer's row, and only this element's scroll
 * geometry knows the answer.
 */
watch(pinned, (value) => { contentBelow.value = !value }, { immediate: true })

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
  <div class="thread-host">
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
        <!-- One element for the whole conversation, so that a reply growing
             while the reader is somewhere else still moves what hangs off the
             scrollbar: the marks are placed by the height of this, and a message
             arriving above them is not the only thing that changes it. -->
        <div ref="content" class="content">
          <MessageItem
            v-for="message in conversation"
            :key="message.id"
            :message="message"
            :streaming="message.id === lastAssistantID && message.type === 'assistant' && !message.time?.completed"
            :caret="message.id === caretID"
            :latest="message.id === lastAssistantID"
          />

          <!-- Turn-level widgets the app weaves into the conversation: questions
               and permission cards sit after the last message, above the
               composer. -->
          <slot />

          <div class="spacer"></div>
        </div>
      </template>
    </div>

    <ThreadPrompts :body="viewport" :content="content" :ids="promptIDs" />
  </div>
</template>

<style scoped>
/* A frame around the scrolling thread for the ticks to be positioned in: they
   belong on the scrollbar, which is a child's furniture and not the thread's. */
.thread-host {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.thread {
  flex: 1;
  overflow-y: auto;
  /* A conversation never scrolls sideways. Parts that are genuinely wider than
     the column — a code block, a table, a diagram — carry their own scrollbar,
     so anything left over is a line that failed to wrap: it should be clipped
     rather than drag the whole conversation out of view. */
  overflow-x: hidden;
  padding: 20px 20px 0;
  /* Message metadata hangs in the gutter outside the content column, and how
     much gutter there is depends on this element's width — not the window's,
     which the sidebar and the source-control panel also eat into. So the thread
     is a query container, and `MessageItem` asks it whether there is room. */
  container: thread / inline-size;
  /* No `scroll-behavior: smooth`: the animation fires intermediate scroll
     events that re-pin the view to the bottom mid-follow, fighting a user who
     is scrolling up. Programmatic follows are instant instead. */
  /* Reserve a symmetric gutter so a scrollbar does not shift the centered
     content column off the composer's center. */
  scrollbar-gutter: stable both-edges;
  /* The bar is still here — it keeps its width, and dragging it still scrolls —
     but it is not painted: the theme pads a scrollbar's painted thumb inside the
     track, and that padding is several times the height of the marks hanging off
     this thread, so the browser's thumb and the marks could never line up.
     `ThreadPrompts` draws the thumb instead, from the same arithmetic the marks
     use. */
  scrollbar-color: transparent transparent;
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