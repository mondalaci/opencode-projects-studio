<script setup lang="ts">
import ShortcutBadge from "./ShortcutBadge.vue"
import { computed, nextTick, ref, watch } from "vue"
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from "reka-ui"
import { Check, ChevronDown, Gauge } from "lucide-vue-next"
import { useApp } from "@/stores/app"
import { openRequests } from "@/stores/shortcuts"

const app = useApp()
const { selectedModelVariants, selectedVariant } = app.server

/** Inside a control group the surrounding pill supplies the border; this is the
 *  closing end of it. */
const props = defineProps<{ grouped?: boolean }>()

const open = ref(false)
const query = ref("")
const inputRef = ref<unknown>(null)

function label(name: string) {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Default"
}

const selectedKey = computed<string>({
  get: () => selectedVariant.value ?? "",
  set: (value) => {
    if (!value) return
    void app.setVariant(value)
    open.value = false
  },
})

function displayValue(value: string) {
  return value ? label(value) : ""
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return selectedModelVariants.value
  return selectedModelVariants.value.filter((name) => name.toLowerCase().includes(q))
})

function inputNode(): HTMLInputElement | null {
  const value = inputRef.value as { $el?: unknown } | HTMLInputElement | null
  return ((value && "$el" in value ? value.$el : value) ?? null) as HTMLInputElement | null
}

function onInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value
}

function selectDisplayValue() {
  if (query.value) return
  requestAnimationFrame(() => inputNode()?.select())
}

watch(open, async (value) => {
  if (value) {
    await nextTick()
    const node = inputNode()
    node?.focus()
    if (!query.value) node?.select()
  } else {
    query.value = ""
  }
})

// Opened by the Alt+E shortcut.
watch(
  () => openRequests.effort,
  () => {
    open.value = true
  },
)
</script>

<template>
  <ComboboxRoot
    v-model="selectedKey"
    v-model:open="open"
    :ignore-filter="true"
    :open-on-click="true"
    :open-on-focus="true"
    class="opencode-variant-root"
  >
    <ComboboxAnchor
      class="opencode-variant-anchor"
      :class="{ 'is-grouped': props.grouped }"
      title="Reasoning effort / variant (Alt+E)"
    >
      <Gauge v-if="!props.grouped" :size="14" class="opencode-variant-icon" />
      <ComboboxInput
        ref="inputRef"
        class="opencode-variant-input"
        :display-value="displayValue"
        placeholder="Default"
        spellcheck="false"
        @input="onInput"
        @focus="selectDisplayValue"
        @click="selectDisplayValue"
      />
      <ComboboxTrigger class="opencode-variant-chevron" aria-label="Select variant (Alt+E)">
        <ChevronDown :size="14" />
      </ComboboxTrigger>
      <ShortcutBadge modifier="alt" key-label="E" />
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent class="opencode-menu opencode-variant-menu" position="popper" side="top" :side-offset="8" align="start">
        <ComboboxViewport class="opencode-variant-scroll">
          <ComboboxEmpty class="opencode-variant-empty">No variants.</ComboboxEmpty>
          <ComboboxItem
            v-for="name in filtered"
            :key="name"
            :value="name"
            :text-value="label(name)"
            class="opencode-variant-option"
            :class="{ 'is-active': name === selectedVariant }"
          >
            <span class="opencode-variant-name">{{ label(name) }}</span>
            <ComboboxItemIndicator class="opencode-variant-check"><Check :size="15" /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<!-- Unscoped: Reka's teleported content does not receive scoped-style attributes. -->
<style>
.opencode-variant-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text);
  transition: border-color 0.12s, background 0.12s;
}
.opencode-variant-anchor:hover {
  background: var(--bg-hover);
}
.opencode-variant-anchor:focus-within {
  border-color: var(--accent);
}
/* Grouped: the group owns the pill, the segment owns its contents. */
.opencode-variant-anchor.is-grouped {
  height: 100%;
  padding: 0 6px;
  border: none;
  border-radius: 0 999px 999px 0;
  background: transparent;
}
.opencode-variant-anchor.is-grouped:hover {
  background: var(--bg-hover);
}
.opencode-variant-anchor.is-grouped .opencode-variant-input {
  /* "Default" is the common value; the segment only needs room for a name. */
  min-width: 40px;
  max-width: 90px;
}
.opencode-variant-icon {
  color: var(--accent);
  flex: none;
}
.opencode-variant-input {
  width: auto;
  min-width: 56px;
  max-width: 140px;
  field-sizing: content;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-overflow: ellipsis;
}
.opencode-variant-input::placeholder {
  color: var(--text-muted);
}
.opencode-variant-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  background: transparent;
  border: none;
  padding: 2px;
  flex: none;
}
.opencode-variant-chevron:hover {
  color: var(--text);
}
.opencode-variant-menu {
  width: 200px;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.opencode-variant-scroll {
  max-height: min(50vh, 320px);
  overflow: auto;
  padding: 6px;
}
.opencode-variant-option {
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
.opencode-variant-option[data-highlighted] {
  background: var(--bg-hover);
}
.opencode-variant-option.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.opencode-variant-name {
  grid-column: 1;
  font-size: 13.5px;
  color: var(--text);
  text-transform: capitalize;
}
.opencode-variant-check {
  grid-column: 2;
  justify-self: center;
  color: var(--accent);
  display: inline-flex;
}
.opencode-variant-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 24px;
}
</style>