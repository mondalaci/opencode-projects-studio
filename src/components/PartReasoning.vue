<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import type { AssistantReasoningBlock } from "@/api/types"

const props = defineProps<{ block: AssistantReasoningBlock }>()
const streaming = computed(() => !props.block.time?.completed)

/**
 * The reasoning as it is read.
 *
 * A streamed block leads and trails with blank lines — the paragraph breaks the
 * model writes — and in a pre-wrapped body those are line boxes like any other:
 * they hold the box open past the last word, with the border hanging over the gap
 * beside them. The box is a window onto the reasoning, so it should end with it,
 * and the whitespace at its two ends goes.
 */
const text = computed(() => props.block.text.trim())

const body = ref<HTMLElement | null>(null)

/**
 * Keep the newest reasoning in view while it streams. The block is a fixed-height
 * window onto a growing text, so without this the reader watches a frozen
 * paragraph while the rest arrives below the fold.
 *
 * There is deliberately no spinner here: the text itself is the progress
 * indicator, and the copy that used to sit in the right gutter was positioned
 * outside the content column, where it collided with the scrollbar and was
 * clipped by the window edge.
 */
watch(
  () => props.block.text,
  async () => {
    if (!streaming.value) return
    await nextTick()
    const el = body.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div class="reasoning">
    <div ref="body" class="body">{{ text }}</div>
  </div>
</template>

<style scoped>
.reasoning {
  margin: 6px 0;
  border-left: 2px solid var(--border);
  /* The space above the body is padding, not the body's own margin: a child's top
     margin collapses out of this box, which left the accent bar starting below the
     block's top edge and pushed the whole box out of line with the avatar. */
  padding: 6px 0 0 10px;
}
.body {
  margin-top: 0;
  color: var(--text-muted);
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 100px;
  overflow-y: auto;
}
</style>
