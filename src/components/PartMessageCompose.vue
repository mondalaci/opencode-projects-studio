<script setup lang="ts">
import { computed, ref } from "vue"
import { Check, Copy } from "lucide-vue-next"
import type { AssistantToolBlock } from "@/api/types"
import { composedMessage } from "@/utils/compose"

const props = defineProps<{ block: AssistantToolBlock }>()

const variants = computed(() => composedMessage(props.block)?.variants ?? [])
const copied = ref<string | null>(null)

async function copy(text: string, key: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
    setTimeout(() => {
      if (copied.value === key) copied.value = null
    }, 1500)
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<template>
  <div class="compose">
    <div v-for="(variant, index) in variants" :key="index" class="compose-card">
      <div class="compose-head">
        <span class="compose-head-label">Subject:</span>
        <span class="compose-subject">{{ variant.subject || "No subject" }}</span>
        <span v-if="variants.length > 1 && variant.label" class="compose-variant">{{ variant.label }}</span>
        <button
          type="button"
          class="copy-btn"
          :aria-label="`Copy subject`"
          :title="`Copy subject`"
          @click="copy(variant.subject ?? '', `${index}:subject`)"
        >
          <Check v-if="copied === `${index}:subject`" :size="14" />
          <Copy v-else :size="14" />
        </button>
      </div>
      <div class="compose-body-wrap">
        <div class="compose-body">{{ variant.body }}</div>
        <button
          type="button"
          class="copy-btn body-copy"
          aria-label="Copy body"
          title="Copy body"
          @click="copy(variant.body, `${index}:body`)"
        >
          <Check v-if="copied === `${index}:body`" :size="14" />
          <Copy v-else :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compose {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 8px 0;
}
.compose-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  overflow: hidden;
}
.compose-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.compose-head-label {
  flex: none;
  font-size: 12.5px;
  color: var(--text-faint);
}
.compose-subject {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}
.compose-variant {
  flex: none;
  font-size: 11px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
}
.compose-body-wrap {
  position: relative;
}
.compose-body {
  padding: 12px 14px;
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text);
}
/* The same reasoning as the code block's copy button: a control beside the text
   must not be swept into a triple-click selection, or the copy carries its icon. */
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}
.compose-head:hover .copy-btn,
.compose-head:focus-within .copy-btn,
.compose-body-wrap:hover .body-copy,
.compose-body-wrap:focus-within .body-copy {
  opacity: 1;
}
.copy-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.body-copy {
  position: absolute;
  top: 8px;
  right: 8px;
}
</style>
