<script setup lang="ts">
import ShortcutBadge from "./ShortcutBadge.vue"
import { computed, nextTick, ref, watch } from "vue"
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "reka-ui"
import { Brain, Check, ChevronDown, Search, Star } from "lucide-vue-next"
import type { ModelCost, ModelCostTier, ModelInfo } from "@/api/types"
import { useApp } from "@/stores/app"
import { modelProviderFilter, openRequests } from "@/stores/shortcuts"
import { modelKey, parseModelKey, useStarredModels } from "@/stores/starredModels"

const app = useApp()
const { providerGroups, models, selectedModel } = app.server
const { keys: starredKeys, isStarred, toggle: toggleStar } = useStarredModels()

/**
 * Inside a control group the surrounding pill supplies the border, so a segment
 * only draws its own contents and a hover fill. The value says which end of the
 * group it sits on, since a rounded pill has to close at both ends — and the
 * group cannot clip its segments, because the Alt-key badges float above them.
 */
const props = defineProps<{ grouped?: "start" | "end" | "both" }>()

const open = ref(false)
const query = ref("")
const showAll = ref(false)
const inputRef = ref<unknown>(null)

const selectedKey = computed<string>({
  get: () => (selectedModel.value ? modelKey(selectedModel.value.providerID, selectedModel.value.id) : ""),
  set: (key) => {
    const parsed = parseModelKey(key)
    if (!parsed) return
    void app.setModel({ providerID: parsed.providerID, id: parsed.modelID })
    open.value = false
  },
})

function displayValue(key: string) {
  const parsed = parseModelKey(key)
  if (!parsed) return ""
  const model = models.value.find((item) => item.providerID === parsed.providerID && item.id === parsed.modelID)
  return model?.name ?? parsed.modelID
}

// The combobox input is uncontrolled: its displayed text is either the selected
// model name (via `displayValue`) or the user's typed search term. We only track
// the typed term separately for our own filtering.
function onInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value
}

function inputNode(): HTMLInputElement | null {
  const value = inputRef.value as { $el?: unknown } | HTMLInputElement | null
  return ((value && "$el" in value ? value.$el : value) ?? null) as HTMLInputElement | null
}

/**
 * When the input still shows the selected model name (no search term typed
 * yet), selecting it makes the first keystroke replace the name instead of
 * being inserted at the caret. Once the user is searching, editing stays normal.
 */
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
    modelProviderFilter.value = null
  }
})

// Opened by the Alt+M shortcut.
watch(
  () => openRequests.model,
  () => {
    open.value = true
  },
)

// Keep the (uncontrolled) input showing the friendly model name. This matters
// on first load, when the input renders its raw id before providers arrive.
watch([models, selectedModel], () => {
  if (open.value || query.value) return
  const node = inputNode()
  const name = displayValue(selectedKey.value)
  if (node && node.value !== name) node.value = name
})

/**
 * The starred models this server offers, in the order they were starred. Keys
 * that name a model this server does not have are skipped here but stay stored,
 * so switching servers does not forget them.
 */
const starredModels = computed<ModelInfo[]>(() => {
  const out: ModelInfo[] = []
  for (const key of starredKeys.value) {
    const parsed = parseModelKey(key)
    if (!parsed) continue
    const model = models.value.find(
      (item) => item.providerID === parsed.providerID && item.id === parsed.modelID,
    )
    if (model) out.push(model)
  }
  return out
})

/** The synthetic group that holds the starred models above the providers. */
const STARRED_GROUP = "__starred"

const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  // `/connect` opens the picker on the provider it just connected. If that
  // provider is not in the catalogue (yet), the filter would leave an empty
  // menu, so it only applies when there is something to narrow.
  const providerFilter =
    modelProviderFilter.value && providerGroups.value.some((group) => group.providerID === modelProviderFilter.value)
      ? modelProviderFilter.value
      : null
  const groups = providerGroups.value
    .filter((group) => !providerFilter || group.providerID === providerFilter)
    .filter((group) => (q || providerFilter ? true : showAll.value || group.connected))
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => {
        if (!q) return true
        return (
          model.name.toLowerCase().includes(q) ||
          model.id.toLowerCase().includes(q) ||
          group.providerName.toLowerCase().includes(q)
        )
      }),
    }))
    .filter((group) => group.models.length > 0)

  if (q || !starredModels.value.length) return groups

  // Lift the starred models into a group of their own, first, so switching to
  // one needs neither a search nor scrolling. A model appears in exactly one
  // place, so it leaves its provider's group while browsing. Searching shows
  // the plain provider list, where the same models still match normally.
  const starred = new Set(starredModels.value.map((model) => modelKey(model.providerID, model.id)))
  return [
    { providerID: STARRED_GROUP, providerName: "Starred", connected: true, models: starredModels.value },
    ...groups.map((group) => ({
      ...group,
      models: group.models.filter((model) => !starred.has(modelKey(model.providerID, model.id))),
    })),
  ].filter((group) => group.models.length > 0)
})

/**
 * Bound the number of rendered options so huge provider lists stay fast. Sized
 * for a full gateway catalogue (AnonRouter alone ships ~265 chat models), which
 * still renders fine; only absurd lists get cut.
 */
const BROWSE_PER_GROUP = 500
const SEARCH_LIMIT = 150
const visibleGroups = computed(() => {
  if (!query.value.trim()) {
    return filteredGroups.value.map((group) => ({ ...group, models: group.models.slice(0, BROWSE_PER_GROUP) }))
  }
  let remaining = SEARCH_LIMIT
  const out: typeof filteredGroups.value = []
  for (const group of filteredGroups.value) {
    if (remaining <= 0) break
    const models = group.models.slice(0, remaining)
    remaining -= models.length
    out.push({ ...group, models })
  }
  return out
})

const totalMatches = computed(() => filteredGroups.value.reduce((total, group) => total + group.models.length, 0))
const resultCount = computed(() => visibleGroups.value.reduce((total, group) => total + group.models.length, 0))

function isSelected(model: ModelInfo) {
  return selectedModel.value?.providerID === model.providerID && selectedModel.value?.id === model.id
}

function starLabel(model: ModelInfo) {
  return isStarred(model.providerID, model.id)
    ? `Unstar ${model.name}`
    : `Star ${model.name} to offer it first`
}

/** v2 model cost is either a flat cost or a tiered list; flatten to the base. */
function baseCost(model: ModelInfo): ModelCost | undefined {
  if (!model.cost) return undefined
  if (Array.isArray(model.cost)) {
    const first = model.cost[0] as ModelCostTier | undefined
    return first ? { input: first.input, output: first.output, cache: first.cache } : undefined
  }
  return model.cost
}

function isFree(model: ModelInfo): boolean {
  const cost = baseCost(model)
  return cost ? !cost.input && !cost.output : false
}

/** Compact USD-per-1M-token price: `$3/$15`. */
function price(value: number) {
  if (!value) return "0"
  if (value >= 1) return value.toFixed(2).replace(/\.00$/, "")
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}
function costLabel(model: ModelInfo) {
  if (isFree(model)) return "free"
  const cost = baseCost(model)
  if (!cost || (!cost.input && !cost.output)) return ""
  return `$${price(cost.input)}/$${price(cost.output)}`
}
function costTitle(model: ModelInfo) {
  if (isFree(model)) return "Free"
  const cost = baseCost(model)
  if (!cost) return ""
  return `Input $${cost.input} / 1M tokens · Output $${cost.output} / 1M tokens`
}

/**
 * Colour the price by value on a log scale so cheaper models trend green and
 * expensive ones trend red. Uses the higher of input/output cost.
 */
function costColor(model: ModelInfo): string | undefined {
  const free = "hsl(142 60% 45%)"
  if (isFree(model)) return free
  const cost = baseCost(model)
  if (!cost) return undefined
  const value = Math.max(cost.input || 0, cost.output || 0)
  if (value <= 0) return free
  const min = Math.log10(0.05)
  const max = Math.log10(60)
  const t = Math.min(1, Math.max(0, (Math.log10(value) - min) / (max - min)))
  const hue = 142 - 142 * t
  return `hsl(${Math.round(hue)} 70% 48%)`
}
</script>

<template>
  <ComboboxRoot
    v-model="selectedKey"
    v-model:open="open"
    :ignore-filter="true"
    :open-on-click="true"
    :open-on-focus="true"
    class="opencode-model-root"
  >
    <ComboboxAnchor
      class="opencode-model-anchor"
      :class="props.grouped ? ['is-grouped', `is-grouped-${props.grouped}`] : undefined"
    >
      <Brain :size="14" class="opencode-model-anchor-icon" />
      <ComboboxInput
        ref="inputRef"
        class="opencode-model-input"
        :display-value="displayValue"
        placeholder="Search models…"
        spellcheck="false"
        @input="onInput"
        @focus="selectDisplayValue"
        @click="selectDisplayValue"
      />
      <ComboboxTrigger class="opencode-model-chevron" aria-label="Toggle models (Alt+M)">
        <ChevronDown :size="14" />
      </ComboboxTrigger>
      <ShortcutBadge modifier="alt" key-label="M" />
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent class="opencode-menu opencode-model-menu" position="popper" side="top" :side-offset="8" align="start">
        <div class="opencode-model-head">
          <Search :size="13" />
          <span>Type to search all providers</span>
          <label class="opencode-model-show-all">
            <input v-model="showAll" type="checkbox" />
            All
          </label>
        </div>
        <ComboboxViewport class="opencode-model-viewport">
          <ScrollAreaRoot class="opencode-model-scroll-root" type="auto">
            <ScrollAreaViewport class="opencode-model-scroll">
              <ComboboxGroup v-for="group in visibleGroups" :key="group.providerID" class="opencode-model-group">
                <ComboboxLabel class="opencode-model-group-head">
                  <span>{{ group.providerName }}</span>
                  <span v-if="group.connected" class="opencode-model-dot" title="Connected"></span>
                </ComboboxLabel>
                <ComboboxItem
                  v-for="model in group.models"
                  :key="modelKey(group.providerID, model.id)"
                  :value="modelKey(group.providerID, model.id)"
                  :text-value="model.name"
                  class="opencode-model-option"
                  :class="{ 'is-active': isSelected(model) }"
                >
                  <button
                    type="button"
                    class="opencode-model-star"
                    :class="{ 'is-starred': isStarred(model.providerID, model.id) }"
                    :title="starLabel(model)"
                    aria-hidden="true"
                    tabindex="-1"
                    @click.stop.prevent="toggleStar(model.providerID, model.id)"
                    @keydown.stop
                  >
                    <Star :size="13" :fill="isStarred(model.providerID, model.id) ? 'currentColor' : 'none'" />
                  </button>
                  <span class="opencode-model-name">{{ model.name }}</span>
                  <span
                    v-if="costLabel(model)"
                    class="opencode-model-cost"
                    :style="{ color: costColor(model) }"
                    :title="costTitle(model)"
                    >{{ costLabel(model) }}</span
                  >
                  <span class="opencode-model-badges">
                    <span v-if="(model.variants?.length ?? 0) > 0" class="opencode-model-tag is-reasoning">variants</span>
                  </span>
                  <ComboboxItemIndicator class="opencode-model-check"><Check :size="15" /></ComboboxItemIndicator>
                </ComboboxItem>
              </ComboboxGroup>
              <ComboboxEmpty class="opencode-model-empty">
                {{ query ? `No models match “${query}”.` : "No models available." }}
              </ComboboxEmpty>
              <p v-if="!query && !showAll && resultCount" class="opencode-model-hint">Showing connected providers only</p>
              <p v-else-if="totalMatches > resultCount" class="opencode-model-hint">
                Showing {{ resultCount }} of {{ totalMatches }} matches · refine your search
              </p>
            </ScrollAreaViewport>
            <ScrollAreaScrollbar class="opencode-model-scrollbar" orientation="vertical">
              <ScrollAreaThumb class="opencode-model-thumb" />
            </ScrollAreaScrollbar>
            <ScrollAreaCorner class="opencode-model-scrollbar-corner" />
          </ScrollAreaRoot>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<!-- Unscoped: Reka's teleported content does not receive scoped-style attributes. -->
<style>
.opencode-model-anchor {
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
.opencode-model-anchor:hover {
  background: var(--bg-hover);
}
.opencode-model-anchor:focus-within {
  border-color: var(--accent);
}
/* Grouped: the group owns the pill, the segment owns its contents. */
.opencode-model-anchor.is-grouped {
  height: 100%;
  padding: 0 6px;
  border: none;
  background: transparent;
}
.opencode-model-anchor.is-grouped-start {
  border-radius: 999px 0 0 999px;
}
.opencode-model-anchor.is-grouped-both {
  border-radius: 999px;
}
.opencode-model-anchor.is-grouped:hover {
  background: var(--bg-hover);
}
.opencode-model-anchor-icon {
  color: var(--accent);
  flex: none;
}
.opencode-model-input {
  width: auto;
  min-width: 96px;
  /* Room for the longest names the providers hand out. Anything longer is
     capped here rather than allowed to stretch the pill; inside a group the
     input still shrinks (see the flex chain in Composer) when the bar is out
     of room, so a name the bar can hold is never ellipsized. */
  max-width: 360px;
  field-sizing: content;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-overflow: ellipsis;
}
.opencode-model-input::placeholder {
  color: var(--text-muted);
}
.opencode-model-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  background: transparent;
  border: none;
  padding: 2px;
  flex: none;
}
.opencode-model-chevron:hover {
  color: var(--text);
}
.opencode-model-menu {
  /* Fit the longest model name instead of clipping it to a fixed 460px: the
     menu grows to its content, and only the popper's available width (the
     window, less whatever the collision middleware leaves) caps it. The
     minimum keeps the menu from jumping narrower as a search filters the
     list. */
  width: max-content;
  min-width: min(460px, var(--reka-popper-available-width, 460px));
  max-width: var(--reka-popper-available-width, 100vw);
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.opencode-model-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11.5px;
  flex: none;
}
.opencode-model-head > span {
  flex: 1;
}
.opencode-model-show-all {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.opencode-model-viewport {
  overflow: visible !important;
  flex: none !important;
  min-height: 0;
}
.opencode-model-scroll-root {
  position: relative;
  max-height: min(62vh, 520px);
}
.opencode-model-scroll {
  max-height: min(62vh, 520px);
  overflow-x: hidden !important;
  /* Keep keyboard-highlighted rows clear of the sticky group header. */
  scroll-padding-top: 34px;
  padding-right: 12px;
}
.opencode-model-scrollbar {
  display: flex;
  width: 10px;
  padding: 2px;
  user-select: none;
  touch-action: none;
  background: var(--bg-elevated);
}
.opencode-model-thumb {
  flex: 1;
  position: relative;
  border-radius: 6px;
  background: var(--text-muted);
}
.opencode-model-thumb:hover {
  background: var(--text);
}
.opencode-model-scrollbar-corner {
  background: var(--bg-elevated);
}
.opencode-model-group {
  padding-bottom: 4px;
}
.opencode-model-group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px 5px;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  z-index: 1;
}
.opencode-model-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4ade80;
}
.opencode-model-option {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 78px 88px 18px;
  align-items: center;
  column-gap: 8px;
  margin: 0 6px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 13.5px;
  color: var(--text);
  cursor: pointer;
  outline: none;
  user-select: none;
}
.opencode-model-option[data-highlighted] {
  background: var(--bg-hover);
}
.opencode-model-option.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
/* The star toggles without choosing the model, so the menu stays open. It is
   always drawn, faint when unstarred, so the column does not shift on hover. */
.opencode-model-star {
  grid-column: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-faint);
  opacity: 0.55;
  cursor: pointer;
  transition: color 0.12s, opacity 0.12s;
}
.opencode-model-option:hover .opencode-model-star,
.opencode-model-option[data-highlighted] .opencode-model-star {
  opacity: 1;
}
.opencode-model-star:hover {
  color: var(--text);
}
.opencode-model-star.is-starred {
  color: var(--accent);
  opacity: 1;
}
.opencode-model-name {
  grid-column: 2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.opencode-model-cost {
  grid-column: 3;
  justify-self: end;
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.opencode-model-badges {
  grid-column: 4;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.opencode-model-check {
  grid-column: 5;
  justify-self: center;
  color: var(--accent);
  display: inline-flex;
}
.opencode-model-tag {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  flex: none;
}
.opencode-model-tag.is-reasoning {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.opencode-model-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 24px;
}
.opencode-model-hint {
  text-align: center;
  color: var(--text-faint);
  font-size: 11.5px;
  margin: 4px 0 2px;
}
</style>