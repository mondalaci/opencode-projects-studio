<script setup lang="ts">
import { computed, ref } from "vue"
import { Check, ChevronRight, CircleAlert, CircleSlash } from "lucide-vue-next"
import type { AssistantToolBlock, ToolFileContent } from "@/api/types"
import { prettyJson, partialToolSummary, toolSummary } from "@/utils/format"
import { toolOutputText } from "@/utils/compose"
import { isStop } from "@/utils/stop"
import { isDataUrl } from "@/utils/file"
import { highlightLines, highlightCodeSummary, type SummaryLanguage } from "@/utils/highlight"
import { openImage } from "@/stores/lightbox"
import Spinner from "./Spinner.vue"

const props = defineProps<{ block: AssistantToolBlock }>()
const open = ref(false)

const state = computed(() => props.block.state)
const running = computed(() => state.value.status === "running" || state.value.status === "streaming")
/**
 * A tool that was stopped rather than failed. Dismissing the question that was
 * holding a turn aborts its tool call, which arrives as an `error`; painting
 * that red reads as a crash where nothing actually went wrong.
 */
const stopped = computed(() => state.value.status === "error" && isStop(state.value.error))
const input = computed<Record<string, unknown>>(() => (state.value.status === "streaming" ? {} : state.value.input))
/**
 * The summary: the command, path or pattern the call is about.
 *
 * The arguments stream in as JSON text rather than as an object, so while they
 * arrive the summary is read out of that text. That is what makes a running call
 * readable from its first token instead of showing a bare tool name until the
 * call is over.
 */
const summary = computed(() => {
  const current = state.value
  if (current.status === "streaming") return partialToolSummary(props.block.name, current.input)
  return toolSummary(props.block.name, input.value)
})
const inputText = computed(() =>
  state.value.status === "streaming" ? state.value.input : JSON.stringify(state.value.input ?? {}, null, 2),
)
const output = computed(() => {
  if (state.value.status === "completed") return toolOutputText(props.block)
  if (state.value.status === "error") return JSON.stringify(state.value.error, null, 2)
  return ""
})
const outputText = computed(() => prettyJson(output.value))

/**
 * Images a tool returned as content.
 *
 * Image tools and `read` report a picture as inline bytes — a `data:` URI — so
 * that is what is rendered here. The saved path is already part of the tool's
 * text output, and travels in its metadata for later turns to reuse.
 */
const images = computed(() => {
  const content = state.value.status === "completed" || state.value.status === "error" ? state.value.content : undefined
  return (content ?? [])
    .filter((item): item is ToolFileContent => item.type === "file" && item.mime.startsWith("image/"))
    .filter((item) => isDataUrl(item.uri) || /^https?:/.test(item.uri))
    .map((item) => ({ src: item.uri, label: item.name || "generated image" }))
})

/**
 * Highlighted HTML for a tool block, or null to render the text as it is.
 *
 * A tool's input is an object, so it is JSON by construction; an output is only
 * highlighted when it parses as JSON, since most tools report plain text.
 */
function highlightJson(code: string): string | null {
  const lines = highlightLines(code, "json")
  return lines ? lines.join("\n") : null
}

/**
 * Tools whose summary is code, and the grammar that code reads best as. A shell
 * command and a script are worth highlighting; a file path or a search pattern
 * has no tokens to colour and would just pick up noise from a grammar.
 */
const SUMMARY_LANGUAGES: Partial<Record<string, SummaryLanguage>> = {
  shell: "bash",
  bash: "bash",
  execute: "javascript",
}

/**
 * The summary as highlighted HTML, or null to render it as plain text.
 *
 * Nothing half-written is highlighted: the arguments arrive token by token, and
 * a here-document has no closing delimiter until the command is complete, so the
 * grammar would briefly read its body as code.
 */
const summaryHtml = computed(() => {
  const text = summary.value
  const language = SUMMARY_LANGUAGES[props.block.name]
  if (!text || !language || state.value.status === "streaming") return null
  return highlightCodeSummary(text, language)
})

/** Whether a tool block's text parses as JSON. */
function isJson(code: string): boolean {
  const trimmed = code.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

const inputHtml = computed(() => highlightJson(inputText.value))
const outputHtml = computed(() => (isJson(outputText.value) ? highlightJson(outputText.value) : null))
</script>

<template>
  <div class="tool" :class="stopped ? 'stopped' : state.status">
    <button class="head" @click="open = !open">
      <!-- The chevron and the text are one flowing line: a long argument wraps
           at the row's own left edge, under the chevron, instead of in a column
           indented past it. -->
      <span class="tool-text">
        <ChevronRight :size="14" class="chev" :class="{ open }" />
        <span class="tool-name">{{ block.name }}</span>
        <!-- A rule, not a space: the name and the summary are different things,
             and a monospace run reads them as one sentence without it. A shell
             command or a script is highlighted; every other summary stays as it
             is. -->
        <span v-if="summary" class="name-sep" aria-hidden="true"></span>
        <span v-if="summary" class="tool-title">
          <template v-if="summaryHtml"><span class="hljs-themed" v-html="summaryHtml" /></template>
          <template v-else>{{ summary }}</template>
        </span>
      </span>
      <span class="status">
        <Spinner v-if="running" :size="12" />
        <Check v-else-if="state.status === 'completed'" :size="14" class="ok" />
        <CircleSlash v-else-if="stopped" :size="14" class="stop" />
        <CircleAlert v-else :size="14" class="err" />
      </span>
    </button>
    <div v-if="images.length" class="images">
      <img
        v-for="(image, index) in images"
        :key="index"
        :src="image.src"
        :alt="image.label"
        :title="`${image.label} — click to enlarge`"
        class="zoomable"
        loading="lazy"
        @click="openImage(image.src, image.label)"
      />
    </div>
    <div v-show="open" class="body">
      <div class="section">
        <div class="label">Input</div>
        <pre v-if="inputHtml" v-html="inputHtml"></pre>
        <pre v-else>{{ inputText }}</pre>
      </div>
      <div v-if="output" class="section">
        <div class="label">Output</div>
        <pre v-if="outputHtml" v-html="outputHtml"></pre>
        <pre v-else>{{ outputText }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool {
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  overflow: hidden;
}
.head {
  display: flex;
  /* The status sits on the first line of the text, not on the centre of a
     summary that has wrapped to several. */
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 8px 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-muted);
  /* The row's content is clipped at its own padding box, so a summary can never
     be drawn across the card's border — it wraps, and this is the guarantee for
     anything that would not. */
  overflow: hidden;
}
.head:hover {
  background: var(--bg-hover);
}
/* A picture a tool produced is the point of the call, so it shows without the
   body being expanded; the JSON behind it stays folded away. */
.images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 12px 10px;
}
.images img {
  max-width: 100%;
  max-height: 360px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}
.images img.zoomable {
  cursor: zoom-in;
}
/* The chevron and the terminal are the first glyphs of the text run, so a
   wrapped summary continues at the left edge instead of past the icons. */
.chev {
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
  transition: transform 0.15s;
}
.chev.open {
  transform: rotate(90deg);
}
/* The name and its summary: one text run, so the summary wraps under the name
   instead of being laid out as a second column beside it. */
.tool-text {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--text-faint);
  /* A long command wraps. An ellipsis would keep the row to one line, but it
     hides the very thing worth reading, and letting the line run on gives the
     conversation a horizontal scrollbar instead. */
  overflow-wrap: anywhere;
}
.tool-name {
  color: var(--text);
}
/* Separates the tool's name from its summary. Inline, so a wrapped summary still
   continues at the row's left edge rather than past the icons. */
.name-sep {
  display: inline-block;
  width: 1px;
  height: 12px;
  margin: 0 8px;
  vertical-align: middle;
  background: var(--border-strong);
}
/* The summary is the command as it was written: its newlines are part of it, so
   a call that spans lines — a here-document, say — shows the lines it has
   instead of being reflowed into one paragraph. Leading indentation survives for
   the same reason, and a line still wraps when it is wider than the row. */
.tool-title {
  white-space: pre-wrap;
}
.status {
  flex: none;
  display: inline-flex;
  margin-top: 2px;
}
.ok {
  color: #4ade80;
}
.stop {
  color: var(--text-faint);
}
.err {
  color: var(--danger);
}
.body {
  border-top: 1px solid var(--border);
  padding: 8px 12px 10px;
}
.section + .section {
  margin-top: 8px;
}
.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  margin-bottom: 4px;
}
pre {
  margin: 0;
  padding: 10px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  overflow: auto;
  max-height: 320px;
  color: #d6deeb;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
