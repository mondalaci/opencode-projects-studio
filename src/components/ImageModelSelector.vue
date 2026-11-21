<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from "reka-ui"
import { Check, ChevronDown, ImageIcon, Search } from "lucide-vue-next"
import { useServer } from "@/stores/server"

/**
 * The image model `generate_image` runs on.
 *
 * Separate from the session's model on purpose: the chat model writes the code,
 * the image model draws the picture, and picking one never changes the other.
 * The choice rides along with each prompt as admission metadata, which is how the
 * plugin that owns the tool learns it.
 *
 * The pill stays an icon until a model is picked, so a setting used only now and
 * then does not take a row of its own in the composer. The search box lives in
 * the popup for the same reason.
 */
const { imageModels, selectedImageModel, setImageModel } = useServer()

/** The unset option. Reka reserves the empty string for "cleared", so the
 *  "leave it to the tool" choice needs a value of its own. */
const DEFAULT = "__default__"

const open = ref(false)
const query = ref("")
const inputRef = ref<HTMLInputElement | null>(null)

const selectedKey = computed<string>({
  get: () => selectedImageModel.value ?? DEFAULT,
  set: (value) => {
    const next = value === DEFAULT ? null : value
    if (next === selectedImageModel.value) return
    setImageModel(next)
    open.value = false
  },
})

const selectedLabel = computed(() => {
  const id = selectedImageModel.value
  if (!id) return ""
  return imageModels.value.find((model) => model.id === id)?.name ?? id
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return imageModels.value
  return imageModels.value.filter(
    (model) =>
      model.id.toLowerCase().includes(q) ||
      (model.name ?? "").toLowerCase().includes(q) ||
      model.providerID.toLowerCase().includes(q),
  )
})

function inputNode(): HTMLInputElement | null {
  return inputRef.value
}

watch(open, async (value) => {
  if (!value) {
    query.value = ""
    return
  }
  await nextTick()
  inputNode()?.focus()
})
</script>

<template>
  <ComboboxRoot v-model="selectedKey" v-model:open="open" :ignore-filter="true" class="opencode-image-root">
    <ComboboxAnchor
      class="opencode-image-anchor"
      :class="{ 'is-set': !!selectedImageModel, 'is-open': open }"
      :title="selectedImageModel ? `Image model: ${selectedLabel}` : 'Image model: default'"
    >
      <!-- The trigger fills the pill, so the whole button opens the menu; the
           chevron is only an affordance, not the sole click target. -->
      <ComboboxTrigger class="opencode-image-trigger" aria-label="Select image model">
        <ImageIcon :size="14" class="opencode-image-icon" />
        <span v-if="selectedImageModel" class="opencode-image-label">{{ selectedLabel }}</span>
        <ChevronDown :size="14" class="opencode-image-chevron" />
      </ComboboxTrigger>
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent
        class="opencode-menu opencode-image-menu"
        position="popper"
        side="top"
        :side-offset="8"
        align="start"
      >
        <div class="opencode-image-search">
          <Search :size="13" />
          <!-- A plain input: the filtering is ours (the root ignores Reka's), and
               Reka's own input would write the selection back into the query. -->
          <input
            ref="inputRef"
            v-model="query"
            class="opencode-image-input"
            placeholder="Search image models…"
            spellcheck="false"
          />
        </div>
        <ComboboxViewport class="opencode-image-scroll">
          <ComboboxEmpty class="opencode-image-empty">
            {{ query ? `No image models match “${query}”.` : "No image models available." }}
          </ComboboxEmpty>
          <ComboboxItem :value="DEFAULT" text-value="Default" class="opencode-image-option">
            <span class="opencode-image-name">Default</span>
            <span class="opencode-image-desc">Whatever the image plugin is configured with</span>
            <ComboboxItemIndicator class="opencode-image-check"><Check :size="15" /></ComboboxItemIndicator>
          </ComboboxItem>
          <ComboboxItem
            v-for="model in filtered"
            :key="model.id"
            :value="model.id"
            :text-value="model.name"
            class="opencode-image-option"
            :class="{ 'is-active': model.id === selectedImageModel }"
          >
            <span class="opencode-image-name">{{ model.name || model.id }}</span>
            <span class="opencode-image-desc">{{ model.providerID }} · {{ model.id }}</span>
            <ComboboxItemIndicator class="opencode-image-check"><Check :size="15" /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<!-- Unscoped: Reka's teleported content does not receive scoped-style attributes. -->
<style>
.opencode-image-anchor {
  position: relative;
  display: inline-flex;
  height: 32px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  transition: border-color 0.12s, background 0.12s, color 0.12s;
  /* Shrink with the bar rather than overflow it: the label yields first. */
  min-width: 0;
}
.opencode-image-anchor:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.opencode-image-anchor:focus-within,
.opencode-image-anchor.is-open {
  border-color: var(--accent);
}
/* A chosen model is a setting worth showing; the unset state is just the icon. */
.opencode-image-anchor.is-set {
  color: var(--text);
}
.opencode-image-anchor.is-set .opencode-image-icon {
  color: var(--accent);
}
.opencode-image-icon {
  flex: none;
}
.opencode-image-label {
  /* The full name shows while the bar has room; past that the label yields
     toward its floor and ellipsizes, with the tooltip still naming the model. */
  max-width: 360px;
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
/* Fills the anchor so a click anywhere on the pill toggles the menu. */
.opencode-image-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 6px;
  border: none;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  /* A button's automatic minimum is its whole content, which would stop the
     label from ever yielding; let the trigger follow the pill instead. */
  min-width: 0;
}
.opencode-image-trigger:focus-visible {
  outline: none;
}
.opencode-image-chevron {
  flex: none;
  color: inherit;
}
.opencode-image-menu {
  width: 460px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.opencode-image-search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  flex: none;
}
.opencode-image-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
}
.opencode-image-input::placeholder {
  color: var(--text-muted);
}
.opencode-image-scroll {
  max-height: min(60vh, 420px);
  overflow: auto;
  padding: 6px;
}
.opencode-image-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px;
  align-items: center;
  column-gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  outline: none;
  user-select: none;
}
.opencode-image-option[data-highlighted] {
  background: var(--bg-hover);
}
.opencode-image-option.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.opencode-image-name {
  grid-column: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.opencode-image-desc {
  grid-column: 1;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.opencode-image-check {
  grid-column: 2;
  grid-row: 1 / span 2;
  justify-self: center;
  color: var(--accent);
  display: inline-flex;
}
.opencode-image-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 24px;
}
</style>
