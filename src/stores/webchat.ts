import { computed, ref } from "vue"
import { desktopBridge, type WebChatClient, type WebChatPicture } from "@/api/desktop"
import { STATE_PRECEDENCE, worstState, type ConversationState } from "@/utils/sessionState"

/**
 * The conversations the web chat app is holding, as reported to this process.
 *
 * The browser tabs push their state to a loopback endpoint in the main process,
 * which decides which of them are still alive and hands the picture over; all
 * that is left here is presenting it. Nothing in this store arranges for a
 * conversation to be announced — that is the tray's job, and it reads this.
 *
 * In a plain browser (no preload bridge) there is no endpoint to be told about,
 * so the picture simply stays empty and the tray is studio's own.
 */

/** One conversation, with the client that reported it. */
export interface WebChatEntry {
  id: string
  title: string
  project: string
  state: ConversationState
  reason: string
  /** The tab that reported it, for the "which browser" part of a label. */
  client: string
  /** A URL that opens this conversation in the browser, when one could be built. */
  link: string | null
}

const picture = ref<WebChatPicture>({ at: 0, clients: [] })

/** Open a conversation in the browser that reported it. */
function linkTo(url: string, sessionID: string): string | null {
  if (!url) return null
  try {
    return new URL(`?session=${encodeURIComponent(sessionID)}`, url).href
  } catch {
    return null
  }
}

export function useWebChat() {
  const bridge = desktopBridge()

  const clients = computed<WebChatClient[]>(() => picture.value.clients)

  /**
   * Every conversation any live tab reports, as one entry each and most
   * actionable first.
   *
   * The tabs all list the same project's conversations, so the same conversation
   * arrives once per tab — three tabs with two conversations that want attention
   * would otherwise make seven entries, which is what the menu would list and
   * what the count would say. Folding them by id is what makes them mean "a
   * conversation", and where two tabs disagree the most actionable reading wins:
   * a permission one tab has seen and another has not is still a permission.
   */
  const conversations = computed<WebChatEntry[]>(() => {
    const byID = new Map<string, WebChatEntry>()
    for (const client of clients.value) {
      for (const conversation of client.conversations) {
        const entry: WebChatEntry = {
          id: conversation.id,
          title: conversation.title,
          project: conversation.project,
          state: conversation.state,
          reason: conversation.reason,
          client: client.client,
          link: linkTo(client.url, conversation.id),
        }
        const seen = byID.get(entry.id)
        if (!seen) {
          byID.set(entry.id, entry)
          continue
        }
        // Keep whichever reading is more actionable, and a link if either tab
        // could build one.
        const better = STATE_PRECEDENCE.indexOf(entry.state) < STATE_PRECEDENCE.indexOf(seen.state)
        byID.set(entry.id, {
          ...(better ? entry : seen),
          link: seen.link ?? entry.link,
        })
      }
    }
    return [...byID.values()].sort(
      (a, b) => STATE_PRECEDENCE.indexOf(a.state) - STATE_PRECEDENCE.indexOf(b.state),
    )
  })

  /** The tab as a whole, for the tray's left-hand dot. */
  const state = computed<ConversationState>(() =>
    worstState(conversations.value.map((conversation) => conversation.state)),
  )

  /**
   * How many conversations the tabs have open in total, with news or without.
   * The reported list holds only the ones with something to say, so this is what
   * says how much of the web chat the tray is describing.
   */
  const open = computed(() => clients.value.reduce((sum, client) => sum + client.open, 0))

  /** Counts behind the state, for the tooltip's summary line. */
  const counts = computed(() => {
    const totals: Record<ConversationState, number> = { blocked: 0, working: 0, done: 0, idle: 0 }
    for (const conversation of conversations.value) totals[conversation.state]++
    return totals
  })

  /**
   * How many conversations want the user: a blocked one, or a finished turn they
   * have not looked at. This is the number the left dot carries, where studio's
   * right dot carries its projects.
   */
  const attention = computed(() => counts.value.blocked + counts.value.done)

  let detach: (() => void) | null = null

  /**
   * Follow the picture. Called once, for the life of the window: which browser
   * tabs are reporting has nothing to do with which server studio is connected
   * to, so this outlives a disconnect.
   *
   * The subscription is installed before the initial pull is awaited: a report
   * that lands in between must win over the stale snapshot, or a tab that
   * started working while the renderer was loading would be drawn as idle until
   * something else changed.
   */
  function start() {
    if (!bridge?.webchat || detach) return
    let pushed = false
    detach = bridge.webchat.onStatus((next) => {
      pushed = true
      picture.value = next ?? { at: 0, clients: [] }
    })
    void bridge.webchat
      .current()
      .then((initial) => {
        if (!pushed && initial) picture.value = initial
      })
      .catch(() => undefined)
  }

  return { picture, clients, conversations, state, counts, open, attention, start }
}

export type WebChatStore = ReturnType<typeof useWebChat>
