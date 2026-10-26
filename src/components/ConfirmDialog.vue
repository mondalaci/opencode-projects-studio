<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue"
import Spinner from "./Spinner.vue"

/**
 * A small modal confirmation, for an action that cannot be undone.
 *
 * The caller owns the outcome: `busy` disables both buttons while the work runs,
 * `error` shows why it failed and leaves the dialog open, and the dialog only
 * closes when the caller stops passing `open`.
 */
const props = defineProps<{
  open: boolean
  title: string
  message: string
  /** The confirm button's label; defaults to "Confirm". */
  confirmLabel?: string
  /** Style the confirm button as destructive. */
  danger?: boolean
  busy?: boolean
  error?: string | null
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const confirmEl = ref<HTMLButtonElement | null>(null)

watch(
  () => props.open,
  (open) => {
    if (!open) {
      window.removeEventListener("keydown", onKeydown)
      return
    }
    window.addEventListener("keydown", onKeydown)
    void nextTick(() => confirmEl.value?.focus())
  },
)

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && !props.busy) {
    event.preventDefault()
    emit("cancel")
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="!busy && emit('cancel')">
    <div class="dialog" role="alertdialog" aria-modal="true" :aria-label="title">
      <h2 class="title">{{ title }}</h2>
      <p class="message">{{ message }}</p>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button type="button" class="ghost" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button
          ref="confirmEl"
          type="button"
          class="confirm"
          :class="{ danger }"
          :disabled="busy"
          @click="emit('confirm')"
        >
          <Spinner v-if="busy" :size="12" />
          <template v-else>{{ confirmLabel ?? "Confirm" }}</template>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
}
.dialog {
  width: min(400px, 100%);
  padding: 16px 18px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.message {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-muted);
  word-break: break-word;
}
.error {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--danger);
  word-break: break-word;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.ghost,
.confirm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 72px;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}
.ghost {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
}
.ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.confirm {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-text);
}
.confirm:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.confirm.danger {
  border-color: var(--git-deleted);
  background: var(--git-deleted);
  color: #fff;
}
.confirm.danger:hover:not(:disabled) {
  filter: brightness(1.1);
}
.ghost:disabled,
.confirm:disabled {
  opacity: 0.6;
}
</style>
