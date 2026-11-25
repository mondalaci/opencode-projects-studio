<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { X } from "lucide-vue-next"
import { filterRequest } from "@/stores/filter"

/**
 * Incremental filter bar for the source-control list (Ctrl+P).
 *
 * The list is narrowed in place rather than in an overlay, and the list itself
 * stays in charge of what matches — the bar only reports the query and the
 * keyboard intent (move the cursor, open the current row, close).
 */
const props = defineProps<{
  placeholder: string
  /** Items currently shown, and how many the list holds before filtering. */
  shown: number
  total: number
}>()

const emit = defineEmits<{
  (event: "update:query", query: string): void
  (event: "move", delta: number): void
  (event: "open"): void
  (event: "close"): void
}>()

const input = ref<HTMLInputElement | null>(null)
const query = ref("")

// The bar is mounted *because* the filter was requested (the v-if matches), so
// focus on mount as well as on later changes.
onMounted(() => {
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
})

// Ctrl+P focuses the bar and selects whatever is there, so typing starts a new
// filter rather than appending to the old one. Watching the request counter
// rather than the open flag means a repeat press re-focuses the input even
// though the bar is already up.
watch(
  () => filterRequest.value,
  async () => {
    await nextTick()
    input.value?.focus()
    input.value?.select()
    if (!query.value) emit("update:query", "")
  },
)

watch(query, (value) => emit("update:query", value))

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "Escape":
      event.preventDefault()
      event.stopPropagation()
      query.value = ""
      emit("close")
      break
    case "Enter":
      event.preventDefault()
      emit("open")
      break
    case "ArrowDown":
      event.preventDefault()
      emit("move", 1)
      break
    case "ArrowUp":
      event.preventDefault()
      emit("move", -1)
      break
    default:
      break
  }
}

function clear() {
  query.value = ""
  emit("close")
}

defineExpose({
  reset: () => {
    query.value = ""
  },
})

/** Whether the list currently hides anything, for the "n of m" readout. */
const filtered = computed(() => props.shown !== props.total)
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar-clip">
      <div class="filter-bar-inner">
        <input
          ref="input"
          v-model="query"
          class="filter-input"
          type="text"
          :placeholder="placeholder"
          spellcheck="false"
          autocomplete="off"
          @keydown="onKeydown"
        />
        <span v-if="filtered" class="filter-count">{{ shown }}/{{ total }}</span>
        <button class="editor-icon" title="Clear filter (Esc)" @click="clear"><X :size="14" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  flex: none;
  /* A single grid row that grows from 0 so the bar's height can animate, which
     is what pushes the list below it down smoothly instead of jumping. */
  display: grid;
  grid-template-rows: 1fr;
  /* The bars sit outside the drag regions, but never opt into them. */
  -webkit-app-region: no-drag;
}
.filter-bar-clip {
  /* Collapses with the row and clips the padded content while it does, so the
     bar reaches zero height rather than stopping at its padding. */
  min-height: 0;
  overflow: hidden;
}
.filter-bar-inner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
/* Ctrl+R / Ctrl+P reveal the bar: fade it in and drop it while its row grows
   from 0, so the list below is pushed down rather than snapping. The classes
   land on this component's root, so they live here and serve both the projects
   and source-control bars. Deliberately not gated on `prefers-reduced-motion`,
   matching the app's other reveal animations. */
.filter-bar-enter-active,
.filter-bar-leave-active {
  transition: grid-template-rows 0.18s ease, opacity 0.18s ease, transform 0.18s ease;
}
.filter-bar-enter-from,
.filter-bar-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(-6px);
}
.filter-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}
.filter-input:focus {
  border-color: var(--accent);
}
.filter-input::placeholder {
  color: var(--text-faint);
}
.filter-count {
  flex: none;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
</style>
