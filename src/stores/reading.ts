import { computed, ref } from "vue"

/**
 * How much of a conversation the thread draws.
 *
 * `full` is the conversation as it happened: every reasoning block and every tool
 * call, in the order the model produced them. `compact` is the same conversation
 * as a reading text — the prompts the reader wrote and the prose the model
 * answered with — with the steps that produced that prose collapsed behind one
 * line per turn. It is a view of the same messages, not a different transcript:
 * the steps are still there, a click away.
 *
 * The choice is application-wide rather than per conversation: it is how the
 * reader likes to read, which does not change as they switch between projects.
 */
export type ReadingMode = "full" | "compact"

const KEY = "opencode-projects-studio.reading"

function initial(): ReadingMode {
  try {
    return localStorage.getItem(KEY) === "compact" ? "compact" : "full"
  } catch {
    return "full"
  }
}

export const readingMode = ref<ReadingMode>(initial())

/** Whether the thread is drawing the text alone. */
export const compactReading = computed(() => readingMode.value === "compact")

export function setReadingMode(next: ReadingMode) {
  readingMode.value = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* storage unavailable */
  }
}

export function toggleReadingMode() {
  setReadingMode(compactReading.value ? "full" : "compact")
}
