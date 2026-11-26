/**
 * Conversation, project and tray state.
 *
 * The signals come from different places (session status endpoint, the global
 * event stream, pending permission and question requests), so they are folded
 * into one small vocabulary here, with the precedence the tray badge needs:
 *
 *   blocked > retry/error > working > done (unacknowledged) > idle
 *
 * Everything in this module is pure, which is what lets the rollup be reasoned
 * about — and tested — without a server.
 */

/** What a conversation shows in the sidebar, and what the tray summarises. */
export type ConversationState = "blocked" | "working" | "done" | "idle"

/** Most actionable first; the index doubles as the rank. */
export const STATE_PRECEDENCE: ConversationState[] = ["blocked", "working", "done", "idle"]

/**
 * The reason a conversation shows while an agent question waits for an answer.
 *
 * "Blocked" covers both a question and a permission request, so the reason is
 * what tells the two apart — the chime keys off it, and so does anything else
 * that wants to know which kind of interruption this is.
 */
export const QUESTION_REASON = "question"

/** Raw signals for one conversation. */
export interface ConversationSignals {
  /** Pending permission request or question: the agent needs a human. */
  blocked?: boolean
  /** Session status as the server reports it: idle, busy, retry, offline. */
  status?: string
  /** Finished since the user last looked at it. */
  unread?: boolean
}

/** Human-readable reason, for the tray tooltip. */
export function stateLabel(state: ConversationState, signals: ConversationSignals = {}): string {
  if (state === "blocked") return signals.status === "offline" ? "offline" : "blocked"
  if (state === "working") return signals.status === "retry" ? "retrying" : "working"
  if (state === "done") return "done"
  return "idle"
}

/** Fold the raw signals into the state a dot or badge shows. */
export function conversationState(signals: ConversationSignals): ConversationState {
  if (signals.blocked) return "blocked"
  // An offline request is waiting on something outside the agent, so it needs the
  // user the same way a blocked one does.
  if (signals.status === "offline") return "blocked"
  if (signals.status === "busy" || signals.status === "retry") return "working"
  if (signals.unread) return "done"
  return "idle"
}

/** The most actionable state in a set, by the precedence above. */
export function worstState(states: ConversationState[]): ConversationState {
  let best: ConversationState = "idle"
  for (const state of states) {
    if (STATE_PRECEDENCE.indexOf(state) < STATE_PRECEDENCE.indexOf(best)) best = state
  }
  return best
}

export interface ProjectRollup {
  id: string
  name: string
  state: ConversationState
  /** Counts within this project. */
  counts: Record<ConversationState, number>
  /** Conversations, most actionable first. */
  conversations: Array<{ id: string; title: string; state: ConversationState; reason: string }>
}

export interface ProjectInput {
  id: string
  name: string
  conversations: Array<{
    id: string
    title: string
    state: ConversationState
    reason?: string
  }>
}

function emptyCounts(): Record<ConversationState, number> {
  return { blocked: 0, working: 0, done: 0, idle: 0 }
}

/** Roll conversations up into their project, most actionable first. */
export function rollupProjects(projects: ProjectInput[]): ProjectRollup[] {
  return projects.map((project) => {
    const counts = emptyCounts()
    for (const conversation of project.conversations) counts[conversation.state]++
    const conversations = [...project.conversations]
      .map((conversation) => ({ ...conversation, reason: conversation.reason ?? conversation.state }))
      .sort((a, b) => STATE_PRECEDENCE.indexOf(a.state) - STATE_PRECEDENCE.indexOf(b.state))
    return {
      id: project.id,
      name: project.name,
      state: worstState(project.conversations.map((conversation) => conversation.state)),
      counts,
      conversations,
    }
  })
}

export interface TrayRollup {
  state: ConversationState
  /** Across every project. */
  counts: Record<ConversationState, number>
  /** Projects needing the user: blocked, or done and not yet looked at. */
  attention: number
  projects: ProjectRollup[]
}

/**
 * Roll projects up into the tray: one state, the counts behind it, and how many
 * projects want attention (the number on the badge).
 */
export function rollupTray(projects: ProjectRollup[]): TrayRollup {
  const counts = emptyCounts()
  for (const project of projects) {
    counts.blocked += project.counts.blocked
    counts.working += project.counts.working
    counts.done += project.counts.done
    counts.idle += project.counts.idle
  }

  const ranked = [...projects].sort(
    (a, b) => STATE_PRECEDENCE.indexOf(a.state) - STATE_PRECEDENCE.indexOf(b.state),
  )
  const attention = projects.filter((project) => project.state === "blocked" || project.state === "done").length

  return {
    state: worstState(projects.map((project) => project.state)),
    counts,
    attention,
    projects: ranked,
  }
}

/** Badge text for an icon: nothing at zero, capped so it stays legible. */
export function badgeText(attention: number): string {
  if (attention <= 0) return ""
  if (attention > 9) return "9+"
  return String(attention)
}

const GLYPH: Record<ConversationState, string> = {
  blocked: "⚠",
  working: "◐",
  done: "✓",
  idle: "○",
}

/** One line per project for the tray tooltip, `⚠ bipane — blocked`. */
export function trayTooltip(rollup: TrayRollup, limit = 8): string {
  const title = `OpenCode Projects Studio — ${rollup.counts.blocked} blocked, ${rollup.counts.working} working, ${rollup.counts.done} done`
  const lines = rollup.projects
    .filter((project) => project.state !== "idle")
    .slice(0, limit)
    .map((project) => {
      const top = project.conversations[0]
      return `${GLYPH[project.state]} ${project.name} — ${top?.reason ?? project.state}`
    })
  return lines.length ? [title, ...lines].join("\n") : title
}

/** Whether a conversation transition should reach the user right now. */
export interface AnnounceInput {
  state: ConversationState
  /** The conversation already wanted attention on the previous pass. */
  known: boolean
  /** Notifications are muted. */
  muted: boolean
  /** The window is hidden or is not the focused window. */
  unfocused: boolean
  /** The conversation is the one on screen in the app. */
  isCurrent: boolean
  /** At least one pass has established the baseline. */
  seeded: boolean
}

/**
 * The announcement policy: only a conversation that has just started wanting the
 * user is worth interrupting them for, and only when they are not already looking
 * at it. "Working" never qualifies — it is not a state that wants a human.
 *
 * A focused window is not the same as a watched conversation: the studio shows
 * one conversation, so another one finishing behind it is exactly the moment the
 * user has no way of noticing, and it still gets a chime.
 */
export function shouldAnnounce(input: AnnounceInput): boolean {
  if (!input.seeded || input.muted || input.known) return false
  if (input.state !== "blocked" && input.state !== "done") return false
  return input.unfocused || !input.isCurrent
}

/** Whether a turn that just finished should count as unacknowledged. */
export interface FinishInput {
  /** The conversation is the one open in the app. */
  isCurrent: boolean
  /** The app window holds keyboard focus. */
  focused: boolean
}

/**
 * Does a finished turn leave something for the user to come back to?
 *
 * Only if they were not watching it *at that moment*: a window that is merely
 * open, sitting behind the editor the user is typing in, is not someone looking
 * at the conversation. Getting this wrong in either direction is silent — too
 * permissive and the "done" dot and the chime never happen, too strict and every
 * watched turn pings.
 */
export function countsAsUnread(input: FinishInput): boolean {
  return !(input.isCurrent && input.focused)
}
