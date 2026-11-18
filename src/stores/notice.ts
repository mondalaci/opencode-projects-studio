import { ref } from "vue"

/**
 * The one line of feedback the sidebar shows under its header.
 *
 * A failure that happens while opening a project has no dialog to appear in: the
 * row is already in the list, so there is nothing to confirm and nowhere to hang
 * a prompt. A single dismissable line is what keeps it from being swallowed —
 * and it lives here rather than in a component so that whoever discovers the
 * failure does not have to reach into the view that happens to be mounted.
 */
const message = ref<string | null>(null)

export const notice = message

/** Show `text`, replacing whatever the line said before. */
export function showNotice(text: string) {
  message.value = text
}

/** Dismiss the line. */
export function clearNotice() {
  message.value = null
}
