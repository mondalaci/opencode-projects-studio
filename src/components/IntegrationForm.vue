<script setup lang="ts">
import { computed, reactive, ref } from "vue"
import { Check, ExternalLink } from "lucide-vue-next"
import type { IntegrationFormField } from "@/api/types"
import {
  integrationAnswer,
  integrationFieldDefault,
  normalizeIntegrationValue,
  visibleIntegrationFields,
} from "@/stores/integrations"

/**
 * The form an integration method asks for before it starts.
 *
 * A provider may need a resource name, a deployment type, or the URL of a
 * self-hosted instance before it can build its sign-in. The fields are the
 * server's own, so the conditional ones appear only when their `when` says so,
 * and a hidden field only contributes its default.
 */

const props = defineProps<{
  fields: IntegrationFormField[]
  submitLabel?: string
  busy?: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  submit: [answer: Record<string, unknown>]
  cancel: []
}>()

const values = reactive<Record<string, unknown>>({})
for (const field of props.fields) values[field.key] = integrationFieldDefault(field)

/** A submit has been pressed, so a required field may now say it is empty. */
const attempted = ref(false)

const shown = computed(() => visibleIntegrationFields(props.fields, values))

function valueOf(field: IntegrationFormField): unknown {
  return values[field.key]
}

function setValue(field: IntegrationFormField, value: unknown) {
  values[field.key] = value
}

function pick(field: IntegrationFormField, value: string) {
  setValue(field, valueOf(field) === value ? "" : value)
}

function toggled(field: IntegrationFormField, value: string): boolean {
  const current = valueOf(field)
  return Array.isArray(current) && current.includes(value)
}

function toggle(field: IntegrationFormField, value: string) {
  const current = valueOf(field)
  const list = Array.isArray(current) ? [...current] : []
  const index = list.indexOf(value)
  if (index === -1) list.push(value)
  else list.splice(index, 1)
  setValue(field, list)
}

function optionValues(field: IntegrationFormField): string[] {
  return (field.options ?? []).map((option) => option.value)
}

function customText(field: IntegrationFormField): string {
  const current = valueOf(field)
  const options = optionValues(field)
  if (Array.isArray(current)) return current.find((item) => !options.includes(item)) ?? ""
  return typeof current === "string" && current && !options.includes(current) ? current : ""
}

/** A typed answer replaces a single choice, or joins the checked ones. */
function setCustom(field: IntegrationFormField, value: string) {
  const options = optionValues(field)
  const current = valueOf(field)
  if (Array.isArray(current)) {
    const kept = current.filter((item) => options.includes(item))
    setValue(field, value ? [...kept, value] : kept)
  } else {
    setValue(field, value)
  }
}

function textOf(field: IntegrationFormField): string {
  const current = valueOf(field)
  return typeof current === "string" ? current : typeof current === "number" ? String(current) : ""
}

function setText(field: IntegrationFormField, value: string) {
  setValue(field, value)
}

/** Keep the typed text until the form is sent, so a lone minus sign is not "NaN". */
function setNumber(field: IntegrationFormField, value: string) {
  setValue(field, value)
}

function isDone(field: IntegrationFormField): boolean {
  return valueOf(field) === true
}

/** Why a field cannot be sent yet, or null when it can. */
function invalid(field: IntegrationFormField): string | null {
  const value = valueOf(field)
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)
  // An external step is the form's own browser round trip: the server will not
  // finish the sign-in until it is done, so the form waits for the tick.
  if (field.type === "external") return value === true || !attempted.value ? null : "Finish this step first"
  if (field.required && empty) return attempted.value ? "This field is required" : null
  if (empty) return null
  if (field.type === "string") {
    const text = String(value)
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(text)) return "This does not look right"
      } catch {
        /* an unusable pattern is the server's problem, not a reason to refuse */
      }
    }
    if (field.minLength !== undefined && text.length < field.minLength) return `At least ${field.minLength} characters`
    if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "Expected an email address"
    if (field.format === "uri") {
      try {
        new URL(text)
      } catch {
        return "Expected a URL"
      }
    }
    if (field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return "Expected a date"
    if (field.format === "date-time" && Number.isNaN(Date.parse(text))) return "Expected a date and time"
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(value)
    if (!Number.isFinite(number)) return "Expected a number"
    if (field.type === "integer" && !Number.isInteger(number)) return "Expected an integer"
    if (field.minimum !== undefined && number < field.minimum) return `At least ${field.minimum}`
    if (field.maximum !== undefined && number > field.maximum) return `At most ${field.maximum}`
  }
  if (field.type === "multiselect") {
    const list = Array.isArray(value) ? value : []
    if (field.minItems !== undefined && list.length < field.minItems) return `Choose at least ${field.minItems}`
    if (field.maxItems !== undefined && list.length > field.maxItems) return `Choose at most ${field.maxItems}`
  }
  return null
}

const problems = computed(() => {
  const out: Record<string, string> = {}
  for (const field of shown.value) {
    const problem = invalid(field)
    if (problem) out[field.key] = problem
  }
  return out
})

const blocked = computed(() => Object.keys(problems.value).length > 0)

function submit() {
  attempted.value = true
  if (blocked.value) return
  emit("submit", integrationAnswer(props.fields, values))
}
</script>

<template>
  <form class="integration-form" @submit.prevent="submit">
    <div v-for="field in shown" :key="field.key" class="field">
      <p class="field-title">
        {{ field.title || field.key }}
        <span v-if="field.required" class="required">*</span>
      </p>
      <p v-if="field.description" class="field-desc">{{ field.description }}</p>

      <!-- single choice -->
      <div v-if="field.type === 'string' && field.options?.length" class="options">
        <button
          v-for="option in field.options"
          :key="option.value"
          type="button"
          class="option"
          :class="{ picked: valueOf(field) === option.value }"
          @click="pick(field, option.value)"
        >
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.description" class="option-desc">{{ option.description }}</span>
        </button>
      </div>

      <!-- multiple choice -->
      <div v-else-if="field.type === 'multiselect'" class="options">
        <button
          v-for="option in field.options ?? []"
          :key="option.value"
          type="button"
          class="option"
          :class="{ picked: toggled(field, option.value) }"
          @click="toggle(field, option.value)"
        >
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.description" class="option-desc">{{ option.description }}</span>
        </button>
      </div>

      <!-- yes / no -->
      <div v-else-if="field.type === 'boolean'" class="options row">
        <button
          type="button"
          class="option"
          :class="{ picked: valueOf(field) === true }"
          @click="setValue(field, true)"
        >
          <span class="option-label">Yes</span>
        </button>
        <button
          type="button"
          class="option"
          :class="{ picked: valueOf(field) === false }"
          @click="setValue(field, false)"
        >
          <span class="option-label">No</span>
        </button>
      </div>

      <!-- a step finished outside this window -->
      <div v-else-if="field.type === 'external'" class="external">
        <a :href="field.url" target="_blank" rel="noreferrer" class="link">
          <ExternalLink :size="13" /> Open
        </a>
        <button type="button" class="done" :class="{ picked: isDone(field) }" @click="setValue(field, !isDone(field))">
          <Check v-if="isDone(field)" :size="13" />
          {{ isDone(field) ? "Done" : "Mark done" }}
        </button>
      </div>

      <!-- number / integer -->
      <input
        v-else-if="field.type === 'number' || field.type === 'integer'"
        :value="textOf(field)"
        class="input"
        type="number"
        :step="field.type === 'integer' ? 1 : 'any'"
        :placeholder="field.placeholder || field.title || field.key"
        @input="setNumber(field, ($event.target as HTMLInputElement).value)"
      />

      <!-- plain text -->
      <input
        v-else
        :value="textOf(field)"
        class="input"
        :type="field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'"
        :placeholder="field.placeholder || 'Type an answer…'"
        @input="setText(field, ($event.target as HTMLInputElement).value)"
      />

      <input
        v-if="(field.type === 'string' || field.type === 'multiselect') && field.options?.length && field.custom"
        :value="customText(field)"
        class="input custom"
        placeholder="Or type your own answer…"
        @input="setCustom(field, ($event.target as HTMLInputElement).value)"
      />

      <p v-if="problems[field.key]" class="problem">{{ problems[field.key] }}</p>
    </div>

    <p v-if="error" class="problem">{{ error }}</p>

    <div class="actions">
      <button type="submit" class="primary" :disabled="busy">
        {{ submitLabel || "Continue" }}
      </button>
      <button type="button" class="ghost" :disabled="busy" @click="emit('cancel')">Back</button>
    </div>
  </form>
</template>

<style scoped>
.integration-form {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.field {
  margin-bottom: 12px;
}
.field-title {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--text);
}
.field-desc {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted);
}
.required {
  color: var(--accent);
}
.options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.options.row {
  flex-direction: row;
}
.option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  text-align: left;
  font-size: 12.5px;
}
.option:hover {
  background: var(--bg-hover);
}
.option.picked {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.option-label {
  font-size: 12.5px;
}
.option-desc {
  font-size: 11.5px;
  color: var(--text-muted);
}
.input {
  width: 100%;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.input:focus {
  border-color: var(--accent);
}
.input.custom {
  margin-top: 6px;
}
.external {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--accent);
  font-size: 12.5px;
}
.link:hover {
  text-decoration: underline;
}
.done {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
}
.done.picked {
  border-color: var(--accent);
  color: var(--accent);
}
.problem {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger);
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.primary {
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-text);
  font-size: 12.5px;
}
.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.primary:disabled {
  opacity: 0.45;
  cursor: default;
}
.ghost {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 12.5px;
}
.ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.ghost:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
