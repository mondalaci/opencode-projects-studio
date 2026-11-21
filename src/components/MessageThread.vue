<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import MessageItem from "./MessageItem.vue"
import Caret from "./Caret.vue"
import Spinner from "./Spinner.vue"
import ThreadPrompts from "./ThreadPrompts.vue"
import { useChat } from "@/stores/chat"
import { findOpen } from "@/stores/find"

const { messages, conversation, loading, currentSessionID, scrollToBottomRequest, contentBelow, pendingForms, pendingPermissions, isBusy, awaitingUser, turnAnchor } = useChat()

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
 * Which side of the conversation the reader is looking at last, past the
 * bookkeeping messages woven between them — a skill, a shell command, a
 * compaction — which are drawn as notes and belong to neither.
 *
 * A prompt is in the conversation from the moment it is sent, while the reply it
 * asks for arrives with the first part of the model's own step. In the moment
 * between, the newest side is the prompt and the last assistant message is still
 * the *previous* turn's answer.
 */
const newest = computed<"user" | "assistant" | null>(() => {
  for (let i = conversation.value.length - 1; i >= 0; i--) {
    const type = conversation.value[i].type
    if (type === "assistant" || type === "user") return type
  }
  return null
})

/**
 * The reply the running turn is writing, if it has started one — the caret's only
 * home.
 *
 * The caret is the turn's heartbeat, so it blinks for as long as the turn runs —
 * while prose streams and while a tool call outlives the step that started it —
 * but only on a reply of *this* turn. The two are told apart by the mark the
 * store leaves where the turn began: a reply after the mark is this turn's,
 * while one at or before it belongs to a turn that has already ended, and a caret
 * left there blinks on the previous answer. That is what a rule reading only "the
 * newest assistant message" did — for a prompt just sent, whose own reply does
 * not exist yet, and for a slash command, which starts a turn without adding a
 * message at all.
 *
 * A turn this view did not start — a session opened while it is already running —
 * carries no mark, and falls back to the unfinished message: a reply that was
 * never completed is one still being written.
 *
 * A turn parked on a question or a permission is waiting for the reader, not the
 * model, so no reply of its own carries the caret yet: a cursor above the card
 * would promise something nothing is keeping.
 */
const turnReply = computed(() => {
  if (!isBusy.value || awaitingUser.value) return null
  const list = conversation.value
  let at = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === "assistant") {
      at = i
      break
    }
  }
  const reply = at < 0 ? null : list[at]
  if (!reply || reply.type !== "assistant") return null
  const anchor = list.findIndex((message) => message.id === turnAnchor.value)
  if (anchor >= 0) return at > anchor ? reply : null
  return reply.time?.completed ? null : reply
})

/**
 * A running turn that has not begun to answer: the caret waits under the prompt,
 * in the column the reply's text will fill, instead of blinking on the reply that
 * came before it.
 *
 * Only when the turn has no reply of its own, though. A prompt sent while a turn
 * is still writing lands *after* the reply it is adding to, and so does a
 * question's typed answer, which the conversation weaves in where the tool asked.
 * The newest side then reads as the reader's while the reply above it keeps its
 * caret, and waiting here would put a second one below it — two hearts for one
 * turn, the lower one promising a reply that is already being written above.
 */
const waiting = computed(
  () => isBusy.value && !awaitingUser.value && !turnReply.value && newest.value === "user",
)

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

/**
 * Follow the conversation as it changes.
 *
 * Not a deep watcher: every update in the store replaces the array — a streamed
 * token, a tool's state, a new prompt — so watching the ref is enough, while
 * `deep` walked every message, every block and every tool's whole output on
 * every token, which on a long conversation is megabytes per delta.
 */
watch(messages, () => {
  if (pinned.value) void scrollToBottom()
})

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
            :caret="message.id === turnReply?.id"
            :latest="message.id === lastAssistantID"
          />

          <!-- The caret of a turn that has not begun to answer: it hangs below the
               prompt, where the reply it is waiting for will be drawn. -->
          <div v-if="waiting" class="caret-row"><Caret /></div>

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
/* The caret of a turn whose reply has not started. It stands in the column the
   reply's text will fill — past the avatar gutter every reply leaves — so it
   blinks where the answer is about to appear, under the prompt that asked for
   it. The row is the height a message's own row is, so the prompt and the cursor
   keep the spacing they would have had. */
.caret-row {
  max-width: var(--content-width);
  margin: 0 auto;
  width: 100%;
  padding: 10px 0 10px calc(28px + 12px);
}
.spacer {
  height: 12px;
}
</style>