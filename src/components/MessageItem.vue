<script setup lang="ts">
import { computed, ref } from "vue"
import { ChevronRight, User } from "lucide-vue-next"
import type { AssistantBlock, AssistantReasoningBlock, AssistantToolBlock, SessionMessage } from "@/api/types"
import { formatCost, formatDateTime, formatTokens } from "@/utils/format"
import { endedAtOutputLimit } from "@/utils/truncation"
import { composedMessage } from "@/utils/compose"
import { linkify } from "@/utils/linkify"
import { isStop } from "@/utils/stop"
import { heldModifier } from "@/stores/shortcuts"
import { useServer } from "@/stores/server"
import { useApp } from "@/stores/app"
import { useChat } from "@/stores/chat"
import Caret from "./Caret.vue"
import Markdown from "./Markdown.vue"
import PartFile from "./PartFile.vue"
import PartMessageCompose from "./PartMessageCompose.vue"
import PartReasoning from "./PartReasoning.vue"
import PartTool from "./PartTool.vue"

const props = defineProps<{
  message: SessionMessage
  streaming?: boolean
  caret?: boolean
  /** The newest assistant message, the only one a "Continue" makes sense on. */
  latest?: boolean
}>()

/** The model list, for naming the model a message ran on. */
const { models } = useServer()
const app = useApp()
const { messages } = useChat()

const isUser = computed(() => props.message.type === "user")
const isAssistant = computed(() => props.message.type === "assistant")

/**
 * What the reader wrote, as HTML.
 *
 * A prompt is quoted rather than interpreted: it is drawn verbatim, not rendered
 * as markdown, so the words stay the reader's own. The one thing done to it is
 * the one thing a reader expects of a URL in it — a link. `linkify` escapes
 * everything it is handed, so the text is still theirs and cannot become markup.
 */
const userHtml = computed(() => (props.message.type === "user" && props.message.text ? linkify(props.message.text) : ""))

/**
 * The assistant's blocks, as the thread draws them.
 *
 * A block with no text in it is dropped rather than drawn. An empty text block is
 * a streamed blank first frame; an empty reasoning block is worse, because the
 * only thing it has to show is the border beside a message's thinking — so it
 * lands as a stub above what follows, and one that sits in front of the reasoning
 * of the same step leaves that border looking cut in two. The store writes both
 * (`session.reasoning.started` opens a block before any of it has arrived, and a
 * step's reasoning can end with nothing in it), so the filter is on what is drawn
 * and the message behind it is left alone.
 *
 * The reasoning that survives is joined into one block, for the same reason: the
 * bar beside a message's thinking is meant to read as one piece, and the pieces
 * the server sends — it does split a step's reasoning around an empty one —
 * would otherwise be drawn with the collapsed margin's gap between them.
 */
const content = computed<AssistantBlock[]>(() => {
  if (props.message.type !== "assistant") return []
  const filled = props.message.content.filter((part) =>
    part.type === "text" || part.type === "reasoning" ? part.text.trim() !== "" : true,
  )
  const drawn: AssistantBlock[] = []
  for (const part of filled) {
    const previous = drawn[drawn.length - 1]
    if (part.type === "reasoning" && previous?.type === "reasoning") {
      drawn[drawn.length - 1] = {
        ...previous,
        // Joined where the words meet: the blank line between them is the seam,
        // and any the pieces carried on their own would only be height.
        text: `${previous.text.trimEnd()}\n\n${part.text.trimStart()}`,
        // The join is as settled as the block it ends on, which is what decides
        // whether the bar is still being written to.
        time: part.time ?? previous.time,
      }
      continue
    }
    drawn.push(part)
  }
  return drawn
})

/**
 * A failed turn's reason, when the server recorded one as an idle message.
 *
 * A failed turn ends with an idle message that carries the error. It is the
 * server's own record of a turn that ended with no reply, and the only place the
 * reason survives a reload — so it is rendered as an error row rather than
 * skipped like the other idle records. It stays hidden when the turn's own reply
 * already shows the same error, so a step failure is not printed twice.
 */
const turnFailure = computed(() => {
  const message = props.message
  if (message.type !== "idle" || message.outcome !== "failed") return null
  const text = message.error?.message || "The turn failed."
  const list = messages.value
  const index = list.findIndex((item) => item.id === message.id)
  for (let i = index - 1; i >= 0; i--) {
    const item = list[i]
    if (item.type === "user") break
    if (item.type === "assistant" && item.error) {
      // The reply's own error block already says why this turn failed.
      if ((item.error.message || "The model returned an error.") === text) return null
      break
    }
  }
  return text
})

/** Bookkeeping messages with no user-facing content. */
const hidden = computed(() => {
  const type = props.message.type
  if (type === "idle") return turnFailure.value === null
  return ["model-switched", "agent-switched", "location-switched"].includes(type)
})

/** Notes that are not part of the conversation flow (switches, idle, shell). */
const note = computed<string | null>(() => {
  const message = props.message
  if (message.type === "skill") return `Skill: ${message.name}`
  if (message.type === "shell") return `$ ${message.command}`
  if (message.type === "compaction") return message.status === "running" ? "Compacting…" : `Compaction (${message.reason})`
  return null
})

/**
 * A server-authored notice: a `system` or `synthetic` message.
 *
 * Most of them are one line. The harness also delivers whole documents this way,
 * though — an instruction update such as the Code Mode tool catalog arrives as a
 * `system` message of several kilobytes — and printing one in the note's single
 * line turns the conversation into a wall of raw markdown. A long one folds into
 * a labelled block that opens on demand; a short one still reads as it always did.
 */
const notice = computed(() => {
  const message = props.message
  if (message.type !== "system" && message.type !== "synthetic") return null
  const text = message.text ?? ""
  return {
    text,
    label: message.description || "System notice",
    preview: text.split("\n")[0]?.trim() ?? "",
    foldable: text.length > 140 || text.includes("\n"),
  }
})

/** A folded notice stays closed until it is asked for. */
const noticeOpen = ref(false)

const errorMessage = computed(() => {
  if (props.message.type !== "assistant" || !props.message.error) return null
  return props.message.error.message ?? "The model returned an error."
})

/**
 * A step that was stopped rather than failed. Interrupting a turn — the stop
 * button, or dismissing the question that was holding it — records an `aborted`
 * step error, which the alarm tone would read as a crash.
 */
const stoppedStep = computed(() => props.message.type === "assistant" && isStop(props.message.error))

/** A turn waiting to try again after a failed step. */
const retryNote = computed(() => {
  if (props.message.type !== "assistant" || !props.message.retry) return null
  return `Retrying (attempt ${props.message.retry.attempt})…`
})

/**
 * Whether this is the newest assistant message and its step ended on an output
 * limit, so what the reader sees is the model being cut off rather than the
 * model stopping. A fresh turn is the only way to get the rest of the text, so
 * the bar is shown only where that makes sense: the last reply, settled, with no
 * error of its own and no turn already running.
 */
const truncated = computed(() => {
  if (props.message.type !== "assistant") return false
  if (!props.latest || props.streaming || errorMessage.value) return false
  if (app.chat.isBusy.value || app.chat.awaitingUser.value) return false
  return endedAtOutputLimit(props.message.finish, props.message.rawFinish)
})

/** Ask the model to carry on; the composer's own send path, on the same model. */
async function continueReply(): Promise<void> {
  if (props.message.type !== "assistant") return
  await app.continueReply(props.message)
}

/**
 * The model a message ran on, as the picker named it, with the effort beside it.
 *
 * A message records only the model's id, which reads as a slug rather than as the
 * name the picker showed. This is plain text — `model: effort` — to sit with the
 * token and cost lines; the id stays available in the tooltip, and as the fallback
 * for a model the server no longer offers. "default" is the model's own neutral
 * effort, so it is left out.
 */
const modelLabel = computed(() => {
  if (props.message.type !== "assistant") return null
  const ref_ = props.message.model
  const info = models.value.find((item) => item.providerID === ref_.providerID && item.id === ref_.id)
  const name = info?.name || ref_.id
  const effort = ref_.variant && ref_.variant !== "default" ? ref_.variant : null
  return { text: effort ? `${name}: ${effort}` : name, reference: ref_.id }
})

/**
 * What holding `Alt` reveals over a message.
 *
 * The two sides are not symmetric: a model, a token count and a cost belong to
 * the step that answered a prompt, so an assistant message is the only one that
 * records them, while a prompt has the date it was sent. Each block says what
 * its own message carries rather than repeating the reply's figures.
 */
const meta = computed(() => {
  const message = props.message
  if (message.type === "user") {
    return { created: message.time?.created, model: "", reference: "", tokens: 0, cost: 0 }
  }
  if (message.type !== "assistant") return null
  const tokens = message.tokens
  const total = tokens ? tokens.input + tokens.output + tokens.reasoning : 0
  return {
    model: modelLabel.value?.text ?? "",
    reference: modelLabel.value?.reference ?? "",
    tokens: total,
    cost: message.cost ?? 0,
    created: message.time?.created,
  }
})

/**
 * Whether holding `Alt` would add anything to a message's block: the model, the
 * tokens and the cost, which only a reply records. A prompt's block is the date
 * alone, and an empty one should not draw the card the figures hang in.
 */
const metaRest = computed(() => Boolean(meta.value?.model || meta.value?.tokens || meta.value?.cost))

function isCompose(block: AssistantToolBlock): boolean {
  return composedMessage(block) !== null
}
</script>

<template>
  <template v-if="!hidden">
    <div v-if="note" class="message note-row"><div class="note">{{ note }}</div></div>

    <template v-else-if="notice">
      <!-- A note is part of the conversation, so it sits in the row a message
           does: same column, and past the gutter the avatars reserve. -->
      <div v-if="!notice.foldable" class="message note-row"><div class="note">{{ notice.text }}</div></div>
      <div v-else class="message note-row">
        <div class="notice">
          <button class="notice-head" :aria-expanded="noticeOpen" @click="noticeOpen = !noticeOpen">
            <ChevronRight :size="13" class="notice-chevron" :class="{ open: noticeOpen }" />
            <span class="notice-label">{{ notice.label }}</span>
            <span class="notice-preview">{{ notice.preview }}</span>
          </button>
          <!-- Shown as it arrived: this is the text the model was handed, down to
               its markdown furniture. -->
          <div v-if="noticeOpen" class="notice-body">{{ notice.text }}</div>
        </div>
      </div>
    </template>

    <div v-else-if="turnFailure" class="message note-row" role="alert">
      <div class="turn-failure">
        <span class="turn-failure-label">The turn failed</span>
        <span class="turn-failure-text">{{ turnFailure }}</span>
      </div>
    </div>

    <div v-else class="message" :class="isUser ? 'user' : 'assistant'" :data-message-id="message.id">
    <div v-if="!isUser" class="avatar" aria-hidden="true">
      <!-- A robot, drawn here rather than imported: a rounded head with a stub
           antenna and side ears, and two eyes knocked out of the fill so they
           take the tile's own colour. -->
      <svg class="robot" viewBox="0 0 24 24">
        <g class="robot-body">
          <rect x="5" y="6" width="14" height="14" rx="3.5" />
          <rect x="11.1" y="4" width="1.8" height="2.8" rx="0.9" />
          <rect x="2.2" y="11" width="3" height="6" rx="1.3" />
          <rect x="18.8" y="11" width="3" height="6" rx="1.3" />
        </g>
        <g class="robot-eyes">
          <circle cx="9.4" cy="13" r="1.9" />
          <circle cx="14.6" cy="13" r="1.9" />
        </g>
      </svg>
    </div>
    <div class="body">
      <!-- The date is always here, hung beside the avatar; what the message cost
           arrives with the modifier, so nothing is spent on the figures until
           they are asked for. -->
      <div v-if="meta" class="meta" :title="meta.reference || undefined">
        <div class="meta-inner">
          <div v-if="meta.created" class="meta-row meta-datetime">{{ formatDateTime(meta.created) }}</div>
          <div v-if="metaRest && !streaming && heldModifier === 'alt'" class="meta-rest">
            <div v-if="meta.model" class="meta-model">{{ meta.model }}</div>
            <div v-if="meta.tokens" class="meta-row">{{ formatTokens(meta.tokens) }} tokens</div>
            <div v-if="meta.cost" class="meta-row">{{ formatCost(meta.cost) }}</div>
          </div>
        </div>
      </div>
      <div class="bubble" :class="isUser ? 'user-bubble' : 'assistant-bubble'">
        <template v-if="isUser">
          <p v-if="userHtml" class="user-text" v-html="userHtml"></p>
          <PartFile
            v-for="(file, index) in (message.type === 'user' ? message.files : undefined) ?? []"
            :key="index"
            :data="file.data"
            :mime="file.mime"
            :filename="file.name"
          />
        </template>

        <template v-else-if="isAssistant">
          <template v-for="(part, index) in content" :key="index">
            <Markdown v-if="part.type === 'text'" :text="part.text" :streaming="streaming" />
            <PartReasoning v-else-if="part.type === 'reasoning'" :block="part as AssistantReasoningBlock" />
            <template v-else-if="part.type === 'tool'">
              <PartMessageCompose v-if="isCompose(part)" :block="part" />
              <PartTool v-else :block="part" />
            </template>
          </template>
        </template>

        <!-- The caret tracks the *turn*, not this message's text: a step ends when
             its generation does, while its tools are still running, so keying it
             off `time.completed` left the whole tool phase with no sign of
             progress at all. The parent withholds it while the turn waits on the
             reader. -->
        <Caret v-if="caret" />

        <div v-if="errorMessage" class="error" :class="{ stopped: stoppedStep }">{{ errorMessage }}</div>
        <div v-if="retryNote" class="retry">{{ retryNote }}</div>
        <div v-if="truncated" class="truncated">
          <span>This reply stopped at the model's output limit.</span>
          <button type="button" class="truncated-continue" @click="continueReply">Continue</button>
        </div>
      </div>
    </div>
    <div v-if="isUser" class="avatar" aria-hidden="true"><User :size="15" /></div>
    </div>
  </template>
</template>

<style scoped>
.note {
  flex: 1;
  min-width: 0;
  max-width: none;
  width: auto;
  margin: 0 0 0 var(--avatar-gutter);
  color: var(--text-faint);
  font-size: 12px;
  font-family: var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* A failed turn's reason, in the danger tone so it reads as a stop rather than
   as part of the conversation. */
.turn-failure {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 2px auto;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-radius: var(--radius-sm);
  color: var(--danger);
  font-size: 12.5px;
}
.turn-failure-label {
  flex: none;
  font-weight: 600;
}
.turn-failure-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
/* A notice long enough to be a document: one line that opens onto the whole
   text, so an instruction update does not push the conversation off screen. */
.notice {
  flex: 1;
  min-width: 0;
  max-width: none;
  width: auto;
  margin: 0 0 0 var(--avatar-gutter);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}
.notice-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-faint);
  /* Clipped at its own padding box: the label fits and the preview ellipsises,
     so this is what keeps anything that would not from crossing the border. */
  overflow: hidden;
}
.notice-head:hover {
  color: var(--text-muted);
}
.notice-chevron {
  flex: none;
  transition: transform 0.15s ease;
}
.notice-chevron.open {
  transform: rotate(90deg);
}
.notice-label {
  /* Normally a word or two, but the server authors this string, and it can
     arrive as a whole command: shrinkable and clipped like the preview, so a long
     one is ellipsised inside the notice instead of being drawn out of it. */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}
.notice-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.notice-body {
  max-height: 260px;
  overflow: auto;
  padding: 8px 12px 9px;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.message {
  position: relative;
  display: flex;
  gap: 12px;
  /* The padding the row is drawn with, named because the metadata block hangs
     outside it and has to add it back to land on the avatar's line. */
  --message-pad: 10px;
  padding: var(--message-pad) 0;
  max-width: var(--content-width);
  margin: 0 auto;
  width: 100%;
  /* The gutter an avatar needs: its own width plus the flex gap. Both rows
     reserve one, so the avatars hang outside the same content width. */
  --avatar-gutter: calc(28px + 12px);
  /* How far the avatar sits below the message's top edge. A block that opens an
     assistant message takes the same offset, so its top border lines up with the
     avatar instead of hanging below it. */
  --avatar-top: 2px;
}
.message.user {
  justify-content: flex-end;
}
.message.assistant {
  justify-content: flex-start;
}
/* A row without a bubble — a note or a notice — lays out from the left, in the
   same column a message's content uses. */
.message.note-row {
  justify-content: flex-start;
}
.avatar {
  /* Both sides of the conversation wear the same tile; only the glyph differs. */
  --avatar-tile: var(--bg-active);
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--avatar-tile);
  color: var(--text-muted);
  margin-top: var(--avatar-top);
}
.robot {
  display: block;
  width: 18px;
  height: 18px;
}
.robot-body {
  fill: currentColor;
}
/* The eyes are the tile showing through, hence the tile's own colour. */
.robot-eyes {
  fill: var(--avatar-tile);
}
/* The message's own column: the metadata line, then the bubble. In a window wide
   enough to hang the metadata in the gutter it is out of flow there, so the
   column is just the bubble and its width is the width it always had. */
.body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.message.assistant .body {
  flex: 1;
  /* Stop one gutter short of the column edge, where the user's bubble stops, so
     the assistant's content and the user's share one width and both avatars
     protrude past it. */
  margin-right: var(--avatar-gutter);
}
.message.user .body {
  flex: 1;
  /* Hug the avatar: the bubble is as wide as its text allows, and the metadata
     line above it follows the same edge. `80%` is the cap the bubble itself
     carried, moved here so the line is measured by the same width. */
  align-items: flex-end;
  max-width: 80%;
}
.bubble {
  min-width: 0;
  max-width: 100%;
  /* The browser's own windowing, and the reason a long conversation opens at
     once: a message's contents are laid out and painted only while the message
     is near the viewport, so a thread of thousands no longer lays all of them
     out to show the last screenful. The rows themselves stay in the document —
     they are what the scrollbar's marks, the find bar and the scroll position
     are read from — and only their interiors are skipped.
     
     On the bubble rather than on the whole row: `content-visibility` implies
     paint containment, and a message's own metadata hangs *outside* the row's
     box, in the gutter, where it would be clipped away.
     
     `contain-intrinsic-size` is the size a message is taken to have until it has
     been laid out once, after which the browser remembers the real one (`auto`).
     It is the average of a long conversation's rows, measured on the thread this
     was written for; it only decides how far the scrollbar and its marks are out
     before the reader has been past them, and the height is what matters — the
     width is only used for a prompt bubble's shrink-to-fit box. */
  content-visibility: auto;
  contain-intrinsic-size: auto 420px 520px;
}
/* A bordered block that opens a message is level with the avatar beside it: both
   are boxes, so their top edges meet. Text is left alone — its line box already
   starts at the message's top, and the avatar is set to sit just below it. */
.assistant-bubble > :first-child:not(.markdown) {
  margin-top: var(--avatar-top);
}
.user-bubble {
  background: var(--bubble-user);
  border-radius: var(--radius-lg);
  padding: 9px 14px;
}
.user-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.error {
  margin-top: 8px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-radius: var(--radius-sm);
  color: var(--danger);
  font-size: 13px;
}
/* A stop, not a failure: the same note in the quiet tone, so an interrupted
   step does not read as something going wrong. */
.error.stopped {
  border-color: var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
}
.retry {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-faint);
  font-family: var(--font-mono);
}
/* A reply the model was cut off on: a warning toned with the accent rather than
   the error red, since nothing failed — there is just more to say. */
.truncated {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12.5px;
}
.truncated-continue {
  flex: none;
  padding: 3px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.truncated-continue:hover {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
/* The metadata hangs beside the avatar — in the gutter outside the content
   column, on the side that avatar hangs on — so it reads as the message's own
   rather than as something floating in the column. The date is always there; the
   model, the tokens and the cost are the part the modifier reveals. The lines are
   flush to the avatar, which is why the assistant's, hung to its left, are
   right-aligned. */
.meta {
  position: absolute;
  top: 0;
  height: 100%;
  width: max-content;
  /* The gutter the row leaves outside the content column — half of the thread's
     own width less the column — less the gap that keeps the block off the row,
     and never more than a readable measure. */
  max-width: min(360px, calc((100cqw - var(--content-width)) / 2 - 14px));
  pointer-events: none;
}
.message.assistant .meta {
  right: calc(100% + 14px);
  text-align: right;
}
.message.user .meta {
  left: calc(100% + 14px);
  text-align: left;
}
.meta-inner {
  position: sticky;
  top: -10px;
  /* Level with the avatar: the row's own padding, which absolute positioning
     measures from, plus the avatar's offset below it. */
  margin-top: calc(var(--message-pad) + var(--avatar-top));
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}
.meta-model {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Left-aligned within the block, unlike the rows under it: a name too long
     for the gutter then loses its tail behind the ellipsis rather than its
     head, and reads as the same name the picker showed. */
  text-align: left;
}
.meta-row {
  white-space: nowrap;
}
.meta-datetime {
  font-variant-numeric: tabular-nums;
}
/* A thread too narrow to hang the metadata in: the gutter is gone, and there is
   nowhere beside the text for something that is always on screen. The date takes
   a line of the message's own column instead — the byline over the bubble it
   belongs to, level with the avatar — and what the modifier adds keeps out of
   the flow, hanging under the date as a card, so revealing it never pushes the
   conversation around.
 *
 * Measured on the thread rather than the window: the sidebar and the
 * source-control panel are what really decide whether a gutter is there. The
 * breakpoint is the content column (46rem) plus the 120px of gutter each side
 * that the date needs to fit beside the avatar, less a few pixels of slack —
 * a condition cannot read the variable, so it carries the sum in its own words.
 */
@container thread (max-width: 975px) {
  .meta {
    position: static;
    height: auto;
    width: auto;
    max-width: none;
    padding-bottom: 2px;
  }
  .meta-inner {
    position: relative;
    margin-top: 0;
  }
  /* The byline follows the text it labels: left of an assistant's, right of a
     user's. */
  .message.assistant .meta {
    text-align: left;
  }
  .message.user .meta {
    text-align: right;
  }
  .meta-model {
    text-align: inherit;
  }
  .meta-rest {
    position: absolute;
    top: 100%;
    left: 0;
    padding: 4px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow);
    text-align: left;
    /* One line each rather than a wrap: the card is as wide as its longest row,
       which is what keeps it from running off the edge it hangs from. */
    width: max-content;
  }
  .message.user .meta-rest {
    left: auto;
    right: 0;
  }
}
</style>
