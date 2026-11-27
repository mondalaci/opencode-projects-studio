import type { AssistantMessage, SessionMessage } from "@/api/types"
import { drawnBlocks, readableBlock } from "./blocks"

/**
 * A turn whose steps are collapsed, and what there is behind the summary line.
 *
 * A turn is everything between two prompts: the steps the model took to answer
 * the newer one. The steps that are collapsed are not lost — the summary line
 * opens them again, in the order they happened — but they are not drawn until
 * they are asked for.
 */
export interface CollapsedTurn {
  /** The prompt that opened the turn, or its first reply when it was not prompted. */
  key: string
  /** The first message with a step in it: where the summary line is drawn. */
  anchor: string
  /** How many tool calls are collapsed. */
  tools: number
  /** How many reasoning blocks are collapsed. */
  thoughts: number
}

/** "3 tool calls", "1 reasoning block", "2 tool calls, 1 reasoning block". */
export function stepSummary(turn: CollapsedTurn): string {
  const parts: string[] = []
  if (turn.tools) parts.push(`${turn.tools} tool call${turn.tools === 1 ? "" : "s"}`)
  if (turn.thoughts) parts.push(`${turn.thoughts} reasoning block${turn.thoughts === 1 ? "" : "s"}`)
  return parts.join(", ")
}

/**
 * Which messages of a conversation the compact view collapses.
 *
 * Keyed by assistant message id — an entry is present for every message of a
 * collapsed turn, so a caller can ask each message whether it is compacted
 * without knowing where the turns begin. The entry's `anchor` names the one
 * message the summary line belongs before.
 *
 * A turn is collapsed only once it has produced something to read. Until then
 * there is nothing to read, and the steps are the only sign of what is happening:
 * they are drawn as usual while the turn thinks and runs its tools, and fold away
 * the moment the model writes something. A turn that never writes — one that was
 * stopped while thinking — keeps its steps for the same reason.
 *
 * `key` is the prompt that opened the turn, which is what an expanded turn is
 * remembered by, so a re-render does not fold it again.
 */
export function collapsedTurns(messages: SessionMessage[], compact: boolean): Map<string, CollapsedTurn> {
  const turns = new Map<string, CollapsedTurn>()
  if (!compact) return turns

  interface InProgress {
    key: string
    /** Set by the first message with something to hide. */
    anchor: string | null
    tools: number
    thoughts: number
    ids: string[]
    /** Whether the turn has written anything the reader can read. */
    readable: boolean
  }

  let openedBy: string | null = null
  let turn: InProgress | null = null

  /** File the turn away if it has something to hide behind a summary line. */
  function close() {
    if (turn && turn.anchor && turn.readable && (turn.tools || turn.thoughts)) {
      const { key, anchor, tools, thoughts } = turn
      for (const id of turn.ids) turns.set(id, { key, anchor, tools, thoughts })
    }
    turn = null
  }

  for (const message of messages) {
    if (message.type === "user") {
      close()
      openedBy = message.id
      continue
    }
    if (message.type !== "assistant") continue
    if (!turn) {
      turn = { key: openedBy ?? message.id, anchor: null, tools: 0, thoughts: 0, ids: [], readable: false }
    }
    const steps = digest(message)
    turn.ids.push(message.id)
    if ((steps.tools || steps.thoughts) && !turn.anchor) turn.anchor = message.id
    turn.tools += steps.tools
    turn.thoughts += steps.thoughts
    if (steps.readable) turn.readable = true
  }
  close()
  return turns
}

/**
 * What one message contributes to its turn, remembered per message object.
 *
 * The store replaces only the message a streamed token belongs to, so every
 * other message keeps its object — which is what makes a walk over the whole
 * conversation on every token cheap: the digests are computed once per message
 * and looked up after that, instead of splitting and joining every block of
 * every turn again for each token that arrives.
 */
const digests = new WeakMap<AssistantMessage, { tools: number; thoughts: number; readable: boolean }>()

function digest(message: AssistantMessage) {
  const cached = digests.get(message)
  if (cached) return cached
  const blocks = drawnBlocks(message)
  const hidden = blocks.filter((block) => !readableBlock(block))
  const entry = {
    tools: hidden.filter((block) => block.type === "tool").length,
    thoughts: hidden.filter((block) => block.type === "reasoning").length,
    readable: blocks.some(readableBlock),
  }
  digests.set(message, entry)
  return entry
}
