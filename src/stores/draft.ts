import { computed, ref } from "vue"
import { useServer } from "./server"

export interface Attachment {
  id: string
  mime: string
  /** Data URL (base64) sent as the file part `url`. */
  url: string
  filename: string
}

/**
 * The composer is a per-project field.
 *
 * What is typed — and what is attached — belongs to the project it was typed
 * in: switching projects parks it there and brings that project's own text
 * back, so a half-written prompt neither follows the user into another
 * project's conversation nor vanishes from the one it was meant for.
 */

const { directory } = useServer()

/** The key the composer's state is filed under: the open project's directory. */
function projectKey(): string {
  return directory.value ?? ""
}

const drafts = ref<Record<string, string>>({})

/** Shared empty list, so the getter of an untouched project has a stable value. */
const NO_ATTACHMENTS: Attachment[] = []

const attached = ref<Record<string, Attachment[]>>({})

const isEmptyText = (text: string) => text === ""
const isEmptyList = (list: unknown[]) => list.length === 0

/** Replace one project's entry, dropping the key when there is nothing left in it. */
function writeEntry<T>(
  source: Record<string, T>,
  key: string,
  value: T,
  empty: (value: T) => boolean,
): Record<string, T> {
  const next = { ...source }
  if (empty(value)) delete next[key]
  else next[key] = value
  return next
}

/** Write to whichever project is open now. */
function setEntry<T>(source: Record<string, T>, value: T, empty: (value: T) => boolean): Record<string, T> {
  return writeEntry(source, projectKey(), value, empty)
}

/**
 * The composer's text, for the open project.
 *
 * A writable computed rather than a plain ref, so every existing `draft.value`
 * assignment — sending, `/clear`, a restored prompt after a failed send — reads
 * and writes the entry of whichever project is open at that moment.
 */
export const draft = computed({
  get: () => drafts.value[projectKey()] ?? "",
  set: (value: string) => {
    drafts.value = setEntry(drafts.value, value, isEmptyText)
  },
})

/** Files attached to the composer (picked, pasted or dropped), sent as file parts. */
export const attachments = computed<Attachment[]>({
  get: () => attached.value[projectKey()] ?? NO_ATTACHMENTS,
  set: (value: Attachment[]) => {
    attached.value = setEntry(attached.value, value, isEmptyList)
  },
})

/** Bumped to ask the composer to focus its input (e.g. after a new chat). */
export const composerFocusRequest = ref(0)

export function requestComposerFocus() {
  composerFocusRequest.value += 1
}

/**
 * Drop a project's parked composer content, for when the project is deleted —
 * a draft that can never be sent again is only memory held for nothing.
 */
export function forgetDraft(directory: string) {
  if (directory in drafts.value) {
    const next = { ...drafts.value }
    delete next[directory]
    drafts.value = next
  }
  if (directory in attached.value) {
    const next = { ...attached.value }
    delete next[directory]
    attached.value = next
  }
}

let counter = 0
function nextId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `att-${Date.now()}-${counter++}`
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** Attach a picked, pasted or dropped file of any type. */
export async function addFile(file: File): Promise<Attachment | null> {
  // The project the file was dropped into, not the one open when it has been
  // read: reading is asynchronous, and the user may have switched meanwhile.
  const key = projectKey()
  const mime = file.type || "application/octet-stream"
  const url = await readAsDataUrl(file)
  if (!url) return null
  const isImage = mime.startsWith("image/")
  const extension = (mime.split("/")[1] || "bin").replace("+xml", "")
  const fallback = isImage ? `pasted-image-${Date.now()}.${extension}` : `file-${Date.now()}.${extension}`
  const attachment: Attachment = {
    id: nextId(),
    mime,
    url,
    filename: file.name && file.name !== "image.png" ? file.name : fallback,
  }
  const list = attached.value[key] ?? NO_ATTACHMENTS
  attached.value = writeEntry(attached.value, key, [...list, attachment], isEmptyList)
  return attachment
}

export function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((item) => item.id !== id)
}

export function clearAttachments() {
  attachments.value = []
}

export function useDraft() {
  return { draft, attachments }
}
