<script setup lang="ts">
import { computed, ref } from "vue"
import { ChevronRight, User } from "lucide-vue-next"
import type { AssistantBlock, AssistantReasoningBlock, AssistantToolBlock, SessionMessage } from "@/api/types"
import { formatCost, formatDateTime, formatTokens } from "@/utils/format"
import { endedAtOutputLimit } from "@/utils/truncation"
import { composedMessage } from "@/utils/compose"
import { heldModifier } from "@/stores/shortcuts"
import { useServer } from "@/stores/server"
import { useApp } from "@/stores/app"
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

const isUser = computed(() => props.message.type === "user")
const isAssistant = computed(() => props.message.type === "assistant")

const content = computed<AssistantBlock[]>(() => (props.message.type === "assistant" ? props.message.content : []))

/** Bookkeeping messages with no user-facing content. */
const hidden = computed(() =>
  ["idle", "model-switched", "agent-switched", "location-switched"].includes(props.message.type),
)

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

const meta = computed(() => {
  if (props.message.type !== "assistant") return null
  const message = props.message
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

function isCompose(block: AssistantToolBlock): boolean {
  return composedMessage(block) !== null
}
</script>

<template>
  <template v-if="!hidden">
    <div v-if="note" class="note">{{ note }}</div>

    <template v-else-if="notice">
      <div v-if="!notice.foldable" class="note">{{ notice.text }}</div>
      <div v-else class="notice">
        <button class="notice-head" :aria-expanded="noticeOpen" @click="noticeOpen = !noticeOpen">
          <ChevronRight :size="13" class="notice-chevron" :class="{ open: noticeOpen }" />
          <span class="notice-label">{{ notice.label }}</span>
          <span class="notice-preview">{{ notice.preview }}</span>
        </button>
        <!-- Shown as it arrived: this is the text the model was handed, down to
             its markdown furniture. -->
        <div v-if="noticeOpen" class="notice-body">{{ notice.text }}</div>
      </div>
    </template>

    <div v-else class="message" :class="isUser ? 'user' : 'assistant'">
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
    <div class="bubble" :class="isUser ? 'user-bubble' : 'assistant-bubble'">
      <template v-if="isUser">
        <p v-if="message.type === 'user' && message.text" class="user-text">{{ message.text }}</p>
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

      <!-- The caret is the cursor of arriving prose. The parent shows it only
           while this message's trailing part is streaming text: a running tool
           spins on its own row, and a turn blocked on a question is waiting for
           the reader, not the model. -->
      <div v-if="caret" class="caret"></div>

      <div v-if="errorMessage" class="error">{{ errorMessage }}</div>
      <div v-if="retryNote" class="retry">{{ retryNote }}</div>
      <div v-if="truncated" class="truncated">
        <span>This reply stopped at the model's output limit.</span>
        <button type="button" class="truncated-continue" @click="continueReply">Continue</button>
      </div>
    </div>
    <div v-if="isUser" class="avatar" aria-hidden="true"><User :size="15" /></div>
    <div v-if="meta && !streaming && heldModifier === 'alt'" class="meta" :title="meta.reference || meta.model">
      <div class="meta-inner">
        <div v-if="meta.created" class="meta-row meta-datetime">{{ formatDateTime(meta.created) }}</div>
        <div class="meta-model">{{ meta.model }}</div>
        <div v-if="meta.tokens" class="meta-row">{{ formatTokens(meta.tokens) }} tokens</div>
        <div v-if="meta.cost" class="meta-row">{{ formatCost(meta.cost) }}</div>
      </div>
    </div>
    </div>
  </template>
</template>

<style scoped>
.note {
  max-width: var(--content-width);
  margin: 6px auto;
  width: 100%;
  color: var(--text-faint);
  font-size: 12px;
  font-family: var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* A notice long enough to be a document: one line that opens onto the whole
   text, so an instruction update does not push the conversation off screen. */
.notice {
  max-width: var(--content-width);
  margin: 6px auto;
  width: 100%;
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
  padding: 10px 0;
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
.bubble {
  min-width: 0;
  max-width: 100%;
}
.assistant-bubble {
  flex: 1;
  /* Stop one gutter short of the column edge, where the user's bubble stops, so
     the assistant's content and the user's share one width and both avatars
     protrude past it. */
  margin-right: var(--avatar-gutter);
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
  max-width: 80%;
}
.user-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.caret {
  display: inline-block;
  width: 8px;
  height: 15px;
  background: var(--text);
  vertical-align: text-bottom;
  animation: opencode-blink 1s step-start infinite;
}
@keyframes opencode-blink {
  50% {
    opacity: 0;
  }
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
.meta {
  position: absolute;
  top: 0;
  left: calc(100% + 14px);
  height: 100%;
  width: max-content;
  max-width: min(360px, calc(50vw - var(--content-width) / 2 - 40px));
  pointer-events: none;
}
.meta-inner {
  position: sticky;
  top: -10px;
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
}
.meta-row {
  white-space: nowrap;
}
.meta-datetime {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1360px) {
  .meta {
    top: 6px;
    left: auto;
    right: 4px;
    height: auto;
    width: auto;
    max-width: none;
  }
  .meta-inner {
    position: static;
    padding: 4px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow);
  }
}
</style>
