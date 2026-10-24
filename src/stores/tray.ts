import { computed, ref, watch } from "vue"
import { desktopBridge, type TrayMenuItem } from "@/api/desktop"
import { useSessionState } from "./sessionState"
import { playAttentionChime, playQuestionChime, prepareAudio } from "@/utils/chime"
import { trayIconDataURL } from "@/utils/trayIcon"
import {
  QUESTION_REASON,
  badgeText,
  shouldAnnounce,
  trayTooltip,
  type ConversationState,
} from "@/utils/sessionState"

/**
 * The tray icon and the attention chime.
 *
 * The renderer owns the rollup (it has the session state) and pushes three
 * things to the main process on every change: the badge bitmap, the tooltip and
 * the menu. The main process owns the tray object, the native notifications and
 * bringing the window forward.
 */

const MUTE_KEY = "opencode-projects-studio.mute"

const bridge = desktopBridge()

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "true"
  } catch {
    return false
  }
}

const muted = ref(loadMuted())

export function useTray() {
  const state = useSessionState()

  /** Conversations that did not need the user a moment ago. */
  let previousAttention = new Set<string>()
  /** The first push only records the baseline; it does not announce it. */
  let seeded = false

  /**
   * Everything the tray shows, flattened into one string to watch. Watching the
   * pieces separately would miss a menu whose length stays the same while its
   * labels change, which is the common case (a project going working -> done).
   */
  const signature = computed(() =>
    [
      state.trayRollup.value.state,
      state.trayRollup.value.attention,
      muted.value,
      tooltip.value,
      menu.value.map((item) => `${item.label ?? "-"}:${item.enabled === false ? 0 : 1}:${item.submenu?.length ?? 0}`).join("|"),
    ].join("\u0000"),
  )

  const tooltip = computed(() => trayTooltip(state.trayRollup.value))

  const menu = computed<TrayMenuItem[]>(() => {
    const rollup = state.trayRollup.value
    const items: TrayMenuItem[] = [
      {
        label: `OpenCode — ${rollup.counts.blocked} blocked, ${rollup.counts.working} working, ${rollup.counts.done} done`,
        enabled: false,
      },
      { type: "separator" },
    ]

    const actionable = rollup.projects.filter((project) => project.state !== "idle" || project.conversations.length)
    if (!actionable.length) {
      items.push({ label: "No projects connected", enabled: false })
    }
    for (const project of actionable.slice(0, 12)) {
      const top = project.conversations[0]
      const label = `${project.name} — ${top?.reason ?? project.state}`
      // One conversation per project today, so the project entry is the item;
      // the submenu appears only when there is more than one to choose between.
      if (project.conversations.length > 1) {
        items.push({
          label,
          submenu: project.conversations.slice(0, 10).map((conversation) => ({
            label: conversation.title,
            sessionID: conversation.id,
          })),
        })
      } else if (top) {
        items.push({ label, sessionID: top.id })
      } else {
        items.push({ label: `${project.name} — no conversation`, enabled: false })
      }
    }

    items.push(
      { type: "separator" },
      { label: "Open OpenCode Projects Studio", action: "open" },
      { label: muted.value ? "Unmute notifications" : "Mute notifications", action: "mute" },
      { type: "separator" },
      { label: "Quit", action: "quit" },
    )
    return items
  })

  /** Draw and push the current rollup. */
  async function push() {
    if (!bridge?.tray) return
    const rollup = state.trayRollup.value
    const dataURL = await trayIconDataURL(rollup.state as ConversationState, rollup.attention)
    await bridge.tray.update({
      dataURL,
      tooltip: tooltip.value,
      menu: menu.value,
      muted: muted.value,
    })
  }

  /**
   * Announce conversations that just became blocked. Only idle→blocked is worth a
   * notification: it is the one transition that means "a human is needed".
   */
  /** Whether the window is hidden or simply not the focused window. */
  function unfocused() {
    if (typeof document === "undefined") return false
    return document.hidden || !document.hasFocus()
  }

  function notifyNewlyBlocked() {
    const blocked = new Set<string>()
    for (const project of state.trayRollup.value.projects) {
      for (const conversation of project.conversations) {
        // "Blocked" and "done but not opened" are the two states that want a
        // human; a conversation that is merely working does not.
        if (conversation.state !== "blocked" && conversation.state !== "done") continue
        blocked.add(conversation.id)

        if (
          !shouldAnnounce({
            state: conversation.state,
            known: previousAttention.has(conversation.id),
            muted: muted.value,
            unfocused: unfocused(),
            seeded,
          })
        ) {
          continue
        }
        // A question parks the turn on an answer, a permission on a grant, and a
        // finished turn on neither: the reason is what separates them, so the
        // three do not all arrive with the same sound.
        const question = conversation.reason === QUESTION_REASON
        if (question) playQuestionChime()
        else playAttentionChime()
        // A question sounds but does not pop: it is answered in the app, so the
        // desktop notification would interrupt more than it helps.
        if (conversation.state === "blocked" && !question) {
          void bridge?.tray?.notify({
            title: `${project.name} needs you`,
            body: `${conversation.title} — ${conversation.reason}`,
            sessionID: conversation.id,
          })
        }
      }
    }
    previousAttention = blocked
    seeded = true
  }

  function toggleMute(next?: boolean) {
    muted.value = typeof next === "boolean" ? next : !muted.value
    try {
      localStorage.setItem(MUTE_KEY, String(muted.value))
    } catch {
      /* storage unavailable */
    }
    push()
  }

  /**
   * Send the rollup whenever it changes, and react to the tray: menu clicks for
   * the mute toggle, and "focus this conversation" from the menu or a
   * notification.
   */
  function start(handlers: { onFocusSession?: (sessionID: string) => void } = {}) {
    // Unlock audio on the first interaction, for platforms that insist on one.
    prepareAudio()

    watch(
      signature,
      () => {
        notifyNewlyBlocked()
        push()
      },
      { immediate: true },
    )

    bridge?.tray?.onAction((action) => {
      if (action === "mute") toggleMute()
    })

    bridge?.tray?.onFocusSession((sessionID) => {
      if (sessionID) handlers.onFocusSession?.(sessionID)
    })
  }

  return { muted, tooltip, menu, push, start, toggleMute }
}

export type TrayStore = ReturnType<typeof useTray>
