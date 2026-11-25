import { reactive, ref } from "vue"

/**
 * Keyboard-shortcut state.
 *
 * Holding a modifier reveals key badges on the controls its shortcuts trigger,
 * mirroring the "hold Cmd to see shortcuts" pattern. `Alt` and `Ctrl` are separate
 * layers — the filters live on Ctrl, everything else on Alt — so the layer that is
 * held is what gets shown, and each badge names its own modifier.
 *
 * Actions that need to reach a specific component are dispatched through
 * `openRequests` counters that the component watches.
 */
export type ShortcutModifier = "alt" | "ctrl"

/** Which modifier is held, if any. */
export const heldModifier = ref<ShortcutModifier | null>(null)

export function setHeldModifier(value: ShortcutModifier | null) {
  heldModifier.value = value
}

export const openRequests = reactive({
  model: 0,
  project: 0,
  sessions: 0,
  effort: 0,
  tools: 0,
  chats: 0,
  integrations: 0,
  attention: 0,
})

export function requestOpen(
  which: "model" | "project" | "sessions" | "effort" | "tools" | "chats" | "integrations" | "attention",
) {
  if (which === "model") modelProviderFilter.value = null
  openRequests[which] += 1
}

/**
 * The provider a just-opened model picker should show.
 *
 * Connecting an integration in `/connect` opens the picker on the provider the
 * connection unlocked, so the reader lands on the models it just gained instead
 * of hunting for them in the full list. `null` means every provider.
 */
export const modelProviderFilter = ref<string | null>(null)

/** Open the model picker, optionally narrowed to one provider. */
export function requestModel(providerID?: string) {
  modelProviderFilter.value = providerID ?? null
  openRequests.model += 1
}

/**
 * Steps through the prompts of the open conversation, counted rather than
 * called: the component that can take a step — the thread's prompt marks and
 * buttons — is mounted only while the conversation is on screen, and a step
 * asked for when it is not (the diff view fills the pane, a conversation is
 * still loading) should come to nothing rather than reach into a component that
 * is not there. A count that nobody watched is a step that nobody took, which is
 * what a shortcut pressed behind the diff view means.
 */
export const promptSteps = reactive({ up: 0, down: 0 })

export function requestPromptStep(which: "up" | "down") {
  promptSteps[which] += 1
}

/** Key codes (layout/modifier independent) for the shortcuts. */
export const shortcutKeys = {
  model: "KeyM",
  project: "KeyP",
  /**
   * Jump to the first conversation that needs a human. `A` for attention: the
   * all-projects list fills such a row with its state's colour, and this is the
   * key that takes you to the topmost one.
   */
  attention: "KeyA",
  newChat: "KeyN",
  focusChat: "KeyC",
  sessions: "KeyS",
  chats: "KeyL",
  search: "KeyF",
  effort: "KeyE",
  tools: "KeyT",
  pronounce: "KeyV",
  stop: "KeyX",
  /**
   * Stepping through the conversation's prompts.
   *
   * `Alt` + an arrow: what Slack and Discord put on "previous / next" in their
   * sidebars, so the gesture is one a chat is already expected to have, and the
   * arrows say the same thing as the arrows on the two buttons. No browser holds
   * either pair — the familiar combos on arrows all belong to the other ones
   * (`Alt` + left/right walk history, `Alt` + home opens the home page, and the
   * tab-walking pair is on `PageUp`/`PageDown`, which is why this is not that
   * pair: `Ctrl`/`Cmd` + `PageUp`/`PageDown` switches browser tabs in a page
   * that is not the app's own window, and a shortcut that disappears on the web
   * is one the two should not share).
   */
  promptUp: "ArrowUp",
  promptDown: "ArrowDown",
} as const

/**
 * Pronunciation widgets are independent Vue apps (one per code block), so the
 * shortcut cannot be dispatched through a single component the way the
 * `openRequests` counters are. Each mounted widget registers its play/stop
 * toggle here; the newest registration wins, so Alt+V drives the most recent
 * widget on screen.
 */
let activePronunciation: (() => void) | null = null

export function registerPronunciation(handler: () => void): () => void {
  activePronunciation = handler
  return () => {
    if (activePronunciation === handler) activePronunciation = null
  }
}

export function togglePronunciation() {
  activePronunciation?.()
}
