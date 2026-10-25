import { computed, ref, watch } from "vue"
import { desktopBridge, type TrayMenuItem } from "@/api/desktop"
import { useSessionState } from "./sessionState"
import { useWebChat, type WebChatEntry } from "./webchat"
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
 *
 * The web chat app's conversations ride along: its tabs report to the main
 * process, which hands them here, and they share the icon (bottom-left, where
 * studio's own dots sit bottom-right), the menu, and the chime policy. Their dot
 * matches studio's own — always drawn, same size, grey for nothing to report —
 * and only the count in the badge stays studio's, because it counts projects.
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

/**
 * What to call a web chat conversation's project. The report carries the
 * directory rather than a name, and studio names its own projects by the folder
 * they live in, so the folder is the name that keeps the two consistent.
 */
function projectName(conversation: WebChatEntry): string {
  const directory = conversation.project.replace(/\/+$/, "")
  if (!directory) return "OpenCode Chat"
  const folder = directory.split("/").filter(Boolean).pop()
  return folder || "OpenCode Chat"
}

export function useTray() {
  const state = useSessionState()
  const webchat = useWebChat()

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
      webchat.state.value,
      muted.value,
      tooltip.value,
      menu.value.map((item) => `${item.label ?? "-"}:${item.enabled === false ? 0 : 1}:${item.submenu?.length ?? 0}`).join("|"),
    ].join("\u0000"),
  )

  /**
   * The tooltip: studio's own conversations, and a line for the web chat app
   * when its tabs have anything to report. An idle web chat says nothing — its
   * line would only be noise in a tooltip nobody hovers to read "nothing".
   */
  const tooltip = computed(() => {
    const base = trayTooltip(state.trayRollup.value)
    const counts = webchat.counts.value
    if (!webchatConversations.value.length) return base
    const total = counts.blocked + counts.working + counts.done
    if (!total) return base
    return [
      base,
      `OpenCode Chat — ${counts.blocked} blocked, ${counts.working} working, ${counts.done} done (${webchat.open.value} open)`,
    ].join("\n")
  })

  /** The web chat conversations worth a menu entry: anything not idle, newest state first. */
  const webchatConversations = computed<WebChatEntry[]>(() =>
    webchat.conversations.value.filter((conversation) => conversation.state !== "idle"),
  )

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

    // The web chat app's own conversations, in their own section: they are a
    // different application's, and clicking one opens the browser rather than
    // this window.
    const chat = webchatConversations.value
    if (chat.length) {
      const counts = webchat.counts.value
      items.push(
        { type: "separator" },
        {
          label: `OpenCode Chat — ${counts.blocked} blocked, ${counts.working} working, ${counts.done} done (${webchat.open.value} open)`,
          enabled: false,
        },
      )
      for (const conversation of chat.slice(0, 10)) {
        const label = `${projectName(conversation)} — ${conversation.title} (${conversation.reason})`
        // Without a usable URL there is nothing the click could do, so the entry
        // states the fact and stays inert.
        if (conversation.link) items.push({ label, url: conversation.link })
        else items.push({ label, enabled: false })
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
    const dataURL = await trayIconDataURL(
      rollup.state as ConversationState,
      rollup.attention,
      webchat.state.value,
    )
    await bridge.tray.update({
      dataURL,
      tooltip: tooltip.value,
      menu: menu.value,
      muted: muted.value,
    })
  }

  /** Whether the window is hidden or simply not the focused window. */
  function unfocused() {
    if (typeof document === "undefined") return false
    return document.hidden || !document.hasFocus()
  }

  /** A conversation that wants a human, from either app. */
  interface Attention {
    id: string
    title: string
    /** Who to name in the notification, and how to open it again. */
    source: string
    sessionID?: string
    url?: string
    state: ConversationState
    reason: string
  }

  /**
   * The conversations that want a human, from studio's own projects and from the
   * web chat app's tabs — both apps' work ends up on one tray, so both are
   * announced by the same policy.
   *
   * Keyed by conversation id, which is server-wide: a conversation open in both
   * apps is one entry, and one chime, rather than two.
   */
  function attentionWanted(): Map<string, Attention> {
    const wanted = new Map<string, Attention>()
    for (const project of state.trayRollup.value.projects) {
      for (const conversation of project.conversations) {
        // "Blocked" and "done but not opened" are the two states that want a
        // human; a conversation that is merely working does not.
        if (conversation.state !== "blocked" && conversation.state !== "done") continue
        wanted.set(conversation.id, {
          id: conversation.id,
          title: conversation.title,
          source: project.name,
          sessionID: conversation.id,
          state: conversation.state,
          reason: conversation.reason,
        })
      }
    }
    for (const conversation of webchat.conversations.value) {
      if (conversation.state !== "blocked" && conversation.state !== "done") continue
      if (wanted.has(conversation.id)) continue
      wanted.set(conversation.id, {
        id: conversation.id,
        title: conversation.title,
        source: projectName(conversation),
        url: conversation.link ?? undefined,
        state: conversation.state,
        reason: conversation.reason,
      })
    }
    return wanted
  }

  /**
   * Announce the conversations that have just started wanting the user: only a
   * conversation that was not already waiting for one is worth interrupting for.
   */
  function announce() {
    const wanted = attentionWanted()
    for (const conversation of wanted.values()) {
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
          title: `${conversation.source} needs you`,
          body: `${conversation.title} — ${conversation.reason}`,
          sessionID: conversation.sessionID,
          url: conversation.url,
        })
      }
    }
    previousAttention = new Set(wanted.keys())
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

    // The web chat app's tabs report into the main process, which sends the
    // picture here; every change to it moves the signature above.
    webchat.start()

    watch(
      signature,
      () => {
        announce()
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
