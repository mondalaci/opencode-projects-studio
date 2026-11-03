import type { FormDetail, FormField } from "@/api/types"

/**
 * Helpers shared by the question card and the composer.
 *
 * A question is delivered as a v2 form. The card owns everything that is
 * *chosen* — options, a Yes/No — while anything free-form is typed into the
 * usual composer, so a question never grows a second input area.
 */

/** The fields a person actually sees; hidden ones only contribute their default. */
export function visibleFields(form: FormDetail): FormField[] {
  return form.fields.filter((field) => !field.hidden)
}

/** The value a field starts from when nothing has been picked or typed. */
export function fieldDefault(field: FormField): unknown {
  return field.default ?? (field.type === "multiselect" ? [] : field.type === "boolean" ? false : "")
}

/** Coerce a raw value to the shape the field's type expects. */
export function normalizeValue(field: FormField, value: unknown): unknown {
  if (field.type === "multiselect") return Array.isArray(value) ? value : []
  if (field.type === "boolean") return value === true || value === "true"
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "string") return value
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  return value
}

/**
 * Whether a line typed in the composer can answer this field.
 *
 * A field that offers options only takes one of them — unless it also invites a
 * custom answer — while a Yes/No or an external link has nothing a typed line
 * could fill. A multiselect is no different once it invites a custom answer: the
 * line becomes the list's one entry, rather than the field being turned away
 * because a list usually arrives as clicks.
 */
export function acceptsText(field: FormField): boolean {
  if (field.type === "boolean" || field.type === "external") return false
  if (field.options?.length) return field.custom === true
  return true
}

/**
 * Whether the card should answer this form on its own.
 *
 * True once every control it drew has an answer, so the click that lands the
 * last choice sends the form instead of waiting for a Submit press.
 */
export function answersSettle(form: FormDetail, valueOf: (field: FormField) => unknown): boolean {
  const fields = visibleFields(form)
  return fields.length > 0 && fields.every((field) => settled(field, valueOf(field)))
}

/**
 * Whether one field is done with, for a card that answers only what is chosen.
 *
 * A field offering options or a Yes/No waits for that pick; anything merely
 * typed belongs to the composer, which is not the card's to wait on.
 */
function settled(field: FormField, value: unknown): boolean {
  if (hasNoEnd(field)) return false
  if (field.options?.length || field.type === "boolean") return hasAnswer(field, value)
  return true
}

/** Whether a control the card drew has an answer: false is one, so an untouched Yes/No has none. */
function hasAnswer(field: FormField, value: unknown): boolean {
  if (field.type === "boolean") return typeof value === "boolean"
  return value !== undefined && value !== null && String(value) !== ""
}

/** The fields that leave a form no click to end on: a multiple choice and a browser step. */
function hasNoEnd(field: FormField): boolean {
  return field.type === "multiselect" || field.type === "external"
}

/** Whether the card keeps its Submit button: a form holding a field with no end to click. */
export function needsSubmit(form: FormDetail): boolean {
  return visibleFields(form).some(hasNoEnd)
}

/**
 * The answer a line typed in the composer gives a pending question.
 *
 * The text lands on the first field that can take it — a question usually has a
 * single free-form one — and every other field keeps its default, because the
 * server reads the answer as a whole. Returns null when no visible field could
 * take typed text, so the caller can fall back to sending a normal message
 * rather than answering a question nobody asked.
 */
export function answerFromText(form: FormDetail, text: string): Record<string, unknown> | null {
  const body = text.trim()
  if (!body) return null
  const fields = visibleFields(form)
  const target = fields.find(acceptsText)
  if (!target) return null
  const answer: Record<string, unknown> = {}
  for (const field of fields) {
    if (field !== target) answer[field.key] = normalizeValue(field, fieldDefault(field))
    // A multiselect's answer is a list, and a typed custom answer is its one entry.
    else if (field.type === "multiselect") answer[field.key] = [body]
    else answer[field.key] = normalizeValue(field, body)
  }
  return answer
}
