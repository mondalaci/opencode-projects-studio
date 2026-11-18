import { computed, ref } from "vue"
import type { PromptInput, ServerClient } from "@/api/client"
import type {
  AssistantBlock,
  AssistantMessage,
  AssistantReasoningBlock,
  AssistantTextBlock,
  AssistantToolBlock,
  FormDetail,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  SessionInfo,
  SessionMessage,
  StructuredError,
  TokenUsage,
  ToolContent,
  ToolState,
  UserMessage,
} from "@/api/types"
import { parseDataUrl } from "@/utils/file"
import { questionReplies } from "@/utils/question"
import { answeredOnlyInReasoning } from "@/utils/truncation"

export type ChatStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }

export interface SendInput {
  text: string
  files?: Array<{ mime: string; url: string; filename?: string }>
  model?: ModelRef | null
  agent?: string
  /**
   * Image model for `generate_image` to use, as picked in the composer. Sent with
   * every prompt so the tool learns the choice, and an empty value clears it.
   */
  imageModel?: string | null
}

/**
 * The prompt sent when a reply arrived only in the reasoning channel. It says
 * the reply was not delivered rather than "continue", because the model did
 * write the answer — it just wrote it where the reader cannot see it. Asking it
 * to continue would let it think it had already answered.
 */
const REASONING_ONLY_PROMPT =
  "Your previous reply was recorded only in the reasoning channel, so it was not shown. " +
  "Please write the answer again as your visible reply."

/** Messages already asked to restate themselves, so a turn is retried once. */
const autoContinued = new Set<string>()

const messages = ref<SessionMessage[]>([])
const status = ref<ChatStatus>({ type: "idle" })

/**
 * The id of the newest message when the running turn began.
 *
 * What the turn's own reply is told apart by: a message after this mark appeared
 * while the turn was running, so the turn is writing it, while one at or before
 * it belongs to a turn that has already ended. The thread hangs the caret on the
 * reply the turn is writing, and that cannot be read off the message list alone
 * — a turn may start without adding anything to it (a slash command), and a
 * prompt may sit at the end of it with no reply of its own yet to belong to.
 *
 * Null when the turn was adopted rather than started here, since where it began
 * is not something this view witnessed.
 */
const turnAnchor = ref<string | null>(null)
const loading = ref(false)
const sending = ref(false)
const error = ref<string | null>(null)
const permissions = ref<PermissionRequest[]>([])
const forms = ref<FormDetail[]>([])
const todos = ref<Array<{ content: string; status: string; priority: string }>>([])
const currentSessionID = ref<string | null>(null)

/** Bumped when the view should force a re-pin and scroll to the bottom. */
const scrollToBottomRequest = ref(0)

function requestScrollToBottom() {
  scrollToBottomRequest.value++
}

/**
 * Whether the conversation has anything below the fold.
 *
 * Only the thread knows this — it is its own scroll geometry — but the button
 * that answers it is not in the thread: the way back to the end of the
 * conversation hangs at the bottom of the window, in the composer's row, beside
 * the rest of the chrome. The fact travels the channel the scroll request uses,
 * in the other direction.
 */
const contentBelow = ref(false)

/** Where a streamed text/reasoning ordinal landed in an assistant message's content. */
const streamIndex = new Map<string, { text: Map<number, number>; reasoning: Map<number, number> }>()

function indexFor(messageID: string) {
  let index = streamIndex.get(messageID)
  if (!index) {
    index = { text: new Map(), reasoning: new Map() }
    streamIndex.set(messageID, index)
  }
  return index
}

/**
 * Fold a freshly fetched page into the loaded conversation.
 *
 * The list is the whole conversation, oldest first, and the server's copy is
 * authoritative for the messages it carries, so a fetched message replaces the
 * loaded one with the same id. That is also how the optimistic copy of a message
 * just sent is swapped for the real record: the prompt response hands back the
 * id it was given. Older messages that are already loaded are left alone.
 */
function mergeMessages(current: SessionMessage[], fetched: SessionMessage[]): SessionMessage[] {
  if (!fetched.length) return current
  const byID = new Map(current.map((message) => [message.id, message]))
  for (const message of fetched) byID.set(message.id, message)
  // A placeholder is only ever standing in for a message the server has already
  // accepted, so once a page has arrived it has nothing left to do.
  for (const message of current) if (message.id.startsWith("local-")) byID.delete(message.id)
  return [...byID.values()].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
}

/**
 * Add a message the user just sent, in front of the turn it starts.
 *
 * `session.step.started` can beat the prompt response back to the client, so
 * this turn's assistant step is often already in the list — and a streamed step
 * sits at its end. Appending the message after it would print the message under
 * the step it started, putting the answer above the question; the step is not
 * complete until the turn ends, so an unfinished trailing step is this one.
 */
function addUserMessage(message: UserMessage) {
  let at = messages.value.length
  while (at > 0) {
    const previous = messages.value[at - 1]
    if (previous.type !== "assistant" || previous.time?.completed) break
    at--
  }
  messages.value = [...messages.value.slice(0, at), message, ...messages.value.slice(at)]
}

function findMessage(id: string) {
  return messages.value.find((item) => item.id === id)
}

function replaceMessage(id: string, update: (message: SessionMessage) => SessionMessage) {
  const index = messages.value.findIndex((item) => item.id === id)
  if (index === -1) return undefined
  const next = messages.value.slice()
  next[index] = update(next[index])
  messages.value = next
  return next[index]
}

/** Ensure an assistant message exists for a step's `assistantMessageID`. */
function ensureAssistant(id: string, base: Partial<AssistantMessage> = {}): AssistantMessage {
  const existing = findMessage(id)
  if (existing && existing.type === "assistant") {
    if (base.agent || base.model) {
      replaceMessage(id, (message) => ({ ...(message as AssistantMessage), ...base }))
    }
    return findMessage(id) as AssistantMessage
  }
  if (existing) return existing as unknown as AssistantMessage
  const created: AssistantMessage = {
    id,
    type: "assistant",
    agent: base.agent ?? "",
    model: base.model ?? { id: "", providerID: "" },
    content: [],
    time: { created: base.time?.created ?? Date.now() },
    ...base,
  }
  // Appended rather than sorted: a step arriving on the stream belongs after
  // everything loaded, and its `started` stamp comes from the server's clock
  // while a message the user just sent is stamped locally. Sorting the two can
  // put the step above the message it is answering.
  messages.value = [...messages.value, created]
  return created
}

function updateAssistant(id: string, update: (message: AssistantMessage) => AssistantMessage) {
  const current = ensureAssistant(id)
  replaceMessage(id, () => update(current))
}

/** Append (or extend) an assistant text/reasoning block by its ordinal. */
function streamBlock(id: string, kind: "text" | "reasoning", ordinal: number, delta: string, replace = false, text?: string) {
  const index = indexFor(id)
  const map = kind === "text" ? index.text : index.reasoning
  updateAssistant(id, (message) => {
    const content = message.content.slice()
    let at = map.get(ordinal)
    if (at === undefined || content[at]?.type !== kind) {
      at = content.length
      map.set(ordinal, at)
      content.push(kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "" })
    }
    const block = content[at]
    const nextText = replace ? (text ?? delta) : block.type === kind ? (block as { text: string }).text + delta : delta
    if (kind === "text") {
      content[at] = { type: "text", text: nextText }
    } else {
      // `replace` is the "…ended" event, so it also stamps `completed` — that
      // timestamp is what stops the block's right-gutter spinner. Without it
      // every reasoning block in a turn kept spinning until the turn-end
      // reconcile replaced the streamed copy.
      const time = (block as AssistantReasoningBlock).time
      content[at] = {
        type: "reasoning",
        text: nextText,
        time: {
          created: time?.created ?? Date.now(),
          completed: time?.completed ?? (replace ? Date.now() : undefined),
        },
      }
    }
    return { ...message, content }
  })
}

function upsertTool(
  id: string,
  toolID: string,
  patch: {
    name?: string
    /** The next state, or how to build it from the one it replaces — for the
     *  events that carry only part of a tool call. */
    state?: ToolState | ((previous: ToolState) => ToolState)
    executed?: boolean
  },
) {
  updateAssistant(id, (message) => {
    const content = message.content.slice()
    let at = content.findIndex((block) => block.type === "tool" && block.id === toolID)
    if (at === -1) {
      at = content.length
      content.push({
        type: "tool",
        id: toolID,
        name: patch.name ?? "",
        state: { status: "streaming", input: "" },
        time: { created: Date.now() },
      })
    }
    const block = content[at] as AssistantToolBlock
    const next: AssistantToolBlock = {
      ...block,
      name: patch.name ?? block.name,
      executed: patch.executed ?? block.executed,
      state: typeof patch.state === "function" ? patch.state(block.state) : (patch.state ?? block.state),
    }
    content[at] = next
    return { ...message, content }
  })
}

/** The arguments a streamed call's JSON text holds, or {} while they do not parse. */
function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function joinText(content: ToolContent[] | undefined): string {
  return (content ?? [])
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("")
}

export function useChat() {
  const isBusy = computed(() => status.value.type === "busy" || status.value.type === "retry")

  /**
   * The conversation as it reads, with a question's typed replies woven in.
   *
   * The server records a free-form answer inside the `question` tool that asked
   * for it, so on its own the answer only ever shows as that tool call's output.
   * Deriving a message from the tool's structured answers — rather than keeping
   * one locally — is what makes the reply read like any other turn, survive a
   * reload, and appear the moment the tool reports the answer back.
   */
  const conversation = computed<SessionMessage[]>(() => {
    const out: SessionMessage[] = []
    for (const message of messages.value) {
      out.push(message)
      if (message.type !== "assistant") continue
      for (const block of message.content) {
        if (block.type !== "tool") continue
        for (const reply of questionReplies(block)) {
          out.push({ id: reply.id, type: "user", text: reply.text, time: { created: reply.at } })
        }
      }
    }
    return out
  })

  const pendingPermissions = computed(() =>
    permissions.value.filter((request) => request.sessionID === currentSessionID.value),
  )
  const pendingForms = computed(() => forms.value.filter((form) => form.sessionID === currentSessionID.value))
  /** The turn is parked on a question or a permission prompt, not streaming. */
  const awaitingUser = computed(
    () => pendingPermissions.value.length > 0 || pendingForms.value.length > 0,
  )

  async function open(client: ServerClient, sessionID: string, directory?: string) {
    currentSessionID.value = sessionID
    loading.value = true
    error.value = null
    messages.value = []
    streamIndex.clear()
    todos.value = []
    status.value = { type: "idle" }
    // A session being opened is a turn adopted, not one started here: where it
    // began is not something this view witnessed, so nothing is marked and the
    // thread reads the running turn's reply off the message itself.
    turnAnchor.value = null
    try {
      const [list, perms, formList, session, active] = await Promise.all([
        client.allMessages(sessionID, { directory }),
        client.sessionPermissions(sessionID, { directory }).catch(() => [] as PermissionRequest[]),
        client.sessionForms(sessionID, { directory }).catch(() => [] as FormDetail[]),
        client.getSession(sessionID, { directory }).catch(() => null),
        client.activeSessions({ directory }).catch(() => null),
      ])
      messages.value = list
      clearFailedIdleBanner()
      permissions.value = perms
      forms.value = formList
      // The server publishes which sessions are running, and that is the only
      // authoritative answer; the session record is the fallback. A trailing
      // assistant message that never completed also means the server is still
      // working on it — but an interrupted run leaves exactly that shape behind,
      // so it cannot be read on its own.
      if (isRunning(active, session, sessionID, list[list.length - 1])) status.value = { type: "busy" }
      else settleUnfinishedTools(session?.outcome ?? "succeeded")
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  /** Re-read the conversation from the server (used to reconcile after a turn). */
  async function reconcile(client: ServerClient, directory?: string) {
    const sessionID = currentSessionID.value
    if (!sessionID) return
    try {
      const [list, formList, session, active] = await Promise.all([
        client.recentMessages(sessionID, { directory }),
        client.sessionForms(sessionID, { directory }).catch(() => [] as FormDetail[]),
        client.getSession(sessionID, { directory }).catch(() => null),
        client.activeSessions({ directory }).catch(() => null),
      ])
      if (currentSessionID.value !== sessionID) return
      // The conversation stays whole: the fetched page updates the messages it
      // carries and everything else already loaded is kept. Replacing the list
      // outright would discard every page but this one.
      messages.value = mergeMessages(messages.value, list)
      streamIndex.clear()
      clearFailedIdleBanner()
      forms.value = formList
      // Only ever *ends* a turn here. Starting one is announced by
      // `session.execution.started`, and this runs on a debounce, so treating
      // "running" as busy would flap against the terminal events.
      //
      // The stream reports changes only, so a turn whose terminal event was lost
      // — a gap in the SSE connection, a dropped frame — would stay "running"
      // forever. The server is authoritative, so end the turn here.
      if (!isRunning(active, session, sessionID, list[list.length - 1])) {
        completeTurn(session?.outcome ?? "succeeded")
      }
    } catch {
      /* leave the streamed state in place */
    }
  }

  /**
   * Drop the questions holding this session, server-side and locally.
   *
   * A run parked on a question is idle as far as the server is concerned, so the
   * question itself is what holds it: withdrawing makes the tool call return and
   * the agent resume. The matching `form.cancelled` event is not guaranteed to
   * arrive — an interrupted turn emits none — so the local list is cleared here
   * rather than left to the stream.
   */
  async function withdrawForms(client: ServerClient, sessionID: string, directory?: string) {
    const asks = forms.value.filter((form) => form.sessionID === sessionID)
    if (!asks.length) return
    await Promise.allSettled(asks.map((form) => client.cancelForm(sessionID, form.id, { directory })))
    forms.value = forms.value.filter((form) => form.sessionID !== sessionID)
  }

  async function send(client: ServerClient, sessionID: string, input: SendInput, directory?: string) {
    sending.value = true
    error.value = null
    scrollToBottomRequest.value++
    try {
      // A message answers the question that was still on screen: the card is
      // discarded as soon as it is sent, never left behind the new message.
      await withdrawForms(client, sessionID, directory)
      // v2 sets the model/agent on the session, then sends a plain prompt.
      if (input.model) await client.setModel(sessionID, input.model, { directory })
      if (input.agent) await client.setAgent(sessionID, input.agent, { directory })
      const body: PromptInput = {
        text: input.text,
        files: input.files?.map((file) => ({ uri: file.url, name: file.filename })),
        // Admission metadata, read by the image plugin's prompt hook. Always
        // present so that going back to "default" clears the remembered choice.
        metadata: { imageModel: input.imageModel ?? "" },
      }
      const sent = await client.prompt(sessionID, body, { directory })
      // Show the message immediately, under the id the server gave it, so the
      // conversation's own copy replaces it in place rather than appearing beside
      // it. The inline bytes have to travel with it: an image whose `data` is
      // missing has nothing to render, so it would show as a bare file name —
      // exactly the attachment the composer had just been previewing.
      const optimistic: UserMessage = {
        id: sent?.data?.id ?? `local-${Date.now()}`,
        type: "user",
        text: input.text,
        files: input.files?.map((file) => ({
          mime: file.mime,
          name: file.filename,
          data: parseDataUrl(file.url)?.data,
          source: { type: "inline" },
        })),
        time: { created: Date.now() },
      }
      addUserMessage(optimistic)
      beginTurn()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      sending.value = false
    }
  }

  /**
   * Ask again when a turn's only content is reasoning.
   *
   * Some models put the whole answer in the reasoning channel and finish with
   * `stop`, which the harness records as a successful turn: the reader sees a
   * thinking block and no reply. A fresh turn is the only way to get the text,
   * so it goes through the same `send` the composer uses, on the model and agent
   * that produced the message.
   *
   * One retry per user turn: if the last thing the user said was this prompt,
   * the model already failed to recover, so it stops rather than looping.
   */
  async function continueReasoningOnly(client: ServerClient, sessionID: string, directory?: string) {
    if (sessionID !== currentSessionID.value || awaitingUser.value) return
    const last = [...messages.value].reverse().find((item) => item.type === "assistant") as
      | AssistantMessage
      | undefined
    if (!last || autoContinued.has(last.id) || !answeredOnlyInReasoning(last)) return
    const lastUser = [...messages.value].reverse().find((item) => item.type === "user")
    if (lastUser?.type === "user" && lastUser.text === REASONING_ONLY_PROMPT) return
    autoContinued.add(last.id)
    await send(
      client,
      sessionID,
      { text: REASONING_ONLY_PROMPT, model: last.model, agent: last.agent },
      directory,
    )
  }

  /**
   * Run a slash command the server knows.
   *
   * There is no message to place here: the server expands the command into one
   * of its own and it arrives on the event stream like any other turn. The turn
   * is marked busy for the same reason a prompt is — the stop button has to be
   * armed the moment the command starts working. The command's own agent and
   * model are its business, so unlike `send` nothing is pushed onto the session.
   */
  async function runCommand(
    client: ServerClient,
    sessionID: string,
    input: { name: string; text: string; files?: SendInput["files"] },
    directory?: string,
  ) {
    sending.value = true
    error.value = null
    scrollToBottomRequest.value++
    try {
      await withdrawForms(client, sessionID, directory)
      await client.runCommand(
        sessionID,
        {
          name: input.name,
          text: input.text,
          files: input.files?.map((file) => ({ uri: file.url, name: file.filename })),
        },
        { directory },
      )
      beginTurn()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      sending.value = false
    }
  }

  /** Compact the conversation, as the TUI's `/compact` does. */
  async function compact(client: ServerClient, sessionID: string, directory?: string) {
    sending.value = true
    error.value = null
    try {
      await client.compact(sessionID, { directory })
      beginTurn()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      sending.value = false
    }
  }

  /**
   * Stop the turn. A run parked on a question or a permission prompt is idle as
   * far as the server is concerned, so interrupting would cancel nothing: the
   * asks themselves are what hold it. Withdraw them first — the tool call then
   * returns, and the agent resumes — and interrupt only what still runs after.
   */
  async function abort(client: ServerClient, sessionID: string, directory?: string) {
    const requests = permissions.value.filter((request) => request.sessionID === sessionID)
    await Promise.allSettled([
      ...requests.map((request) =>
        client.replyPermission(sessionID, request.id, "reject", { directory }),
      ),
      withdrawForms(client, sessionID, directory),
    ])
    // Clear locally too, in case the matching events arrive late or not at all.
    permissions.value = permissions.value.filter((request) => request.sessionID !== sessionID)
    try {
      await client.interrupt(sessionID, { directory })
    } catch {
      /* Nothing running to interrupt; the withdrawn asks are the stop. */
    }
    status.value = { type: "idle" }
  }

  async function replyPermission(
    client: ServerClient,
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    directory?: string,
  ) {
    await client.replyPermission(sessionID, requestID, reply, { directory })
    permissions.value = permissions.value.filter((item) => item.id !== requestID)
  }

  async function replyForm(
    client: ServerClient,
    sessionID: string,
    formID: string,
    answer: Record<string, unknown>,
    directory?: string,
  ) {
    await client.replyForm(sessionID, formID, answer, { directory })
    forms.value = forms.value.filter((item) => item.id !== formID)
  }

  /** Has the server finished with this session? */
  /**
   * Whether the server has a turn running for this session.
   *
   * `GET /api/session/active` answers it directly — `{ ses_…: { type: "running" } }`
   * — and is preferred. The fallback reads the session record, whose `outcome` and
   * `time.idle` are sticky: they describe the last turn that ended, not the one
   * that may be running now, so neither can be read as "settled" on its own. The
   * idle stamp only means something next to the message it followed.
   */
  function isRunning(
    active: Record<string, { type: string }> | null,
    session: SessionInfo | null,
    sessionID: string,
    newest: SessionMessage | undefined,
  ): boolean {
    if (active) return sessionID in active
    const idle = session?.time?.idle
    if (idle === undefined) return false
    return idle < (newest?.time?.created ?? 0)
  }

  /**
   * Stop anything the finished turn left looking in flight.
   *
   * A tool block only leaves `streaming`/`running` when its own success or
   * failure event lands, and an assistant message is only marked completed by
   * `session.step.ended`. A turn that is interrupted — or whose events were lost
   * in a gap in the event stream — delivers neither, so the card spins and the
   * message streams forever although the server has moved on. Only the final
   * assistant message can still be in flight.
   */
  function settleUnfinishedTools(outcome: "succeeded" | "failed" | "interrupted") {
    let at = messages.value.length - 1
    while (at >= 0 && messages.value[at].type !== "assistant") at--
    if (at < 0) return
    const message = messages.value[at] as AssistantMessage

    const unfinished: StructuredError = {
      type: outcome,
      message:
        outcome === "interrupted"
          ? "The turn was interrupted before this tool reported a result."
          : "The turn ended before this tool reported a result.",
    }
    const content = message.content.map((block): AssistantBlock => {
      if (block.type !== "tool") return block
      if (block.state.status !== "streaming" && block.state.status !== "running") return block
      const input = block.state.status === "running" ? block.state.input : {}
      return {
        ...block,
        state: { status: "error", input, error: unfinished },
        time: { ...block.time, completed: block.time.completed ?? Date.now() },
      }
    })
    const time = message.time
    messages.value = messages.value.map((item, index) =>
      index === at
        ? {
            ...message,
            content,
            time: time ? { ...time, completed: time.completed ?? Date.now() } : time,
            // A retry note only describes a turn that is still waiting to try
            // again; the server's own client clears it the same way.
            retry: undefined,
          }
        : item,
    )
  }

  /** The newest message's id, or null in an empty conversation. */
  function newestID(): string | null {
    return messages.value[messages.value.length - 1]?.id ?? null
  }

  /**
   * Mark where a turn began, if nothing was running when it did.
   *
   * Every announcement of a turn comes through here — the send paths in this
   * store and the server's `session.execution.started` — and a turn already in
   * flight keeps the mark it started with. Re-marking one that is running would
   * move the mark past the reply being written, and the caret hangs on whatever
   * the turn has written since it began.
   */
  function markTurnStart() {
    if (status.value.type === "idle") turnAnchor.value = newestID()
  }

  /** Start a turn: busy, and marked at the point it started from. */
  function beginTurn() {
    markTurnStart()
    status.value = { type: "busy" }
  }

  function completeTurn(outcome: "succeeded" | "failed" | "interrupted") {
    status.value = { type: "idle" }
    settleUnfinishedTools(outcome)
  }

  /**
   * The assistant message a failed turn was writing, if it wrote one.
   *
   * A failure belongs to the turn it interrupted. The last assistant message in
   * the conversation is not necessarily that message: in a session whose turn
   * failed before writing anything, the newest reply is from the previous turn,
   * and hanging the error on it would blame the wrong answer. So the scan starts
   * after the newest prompt and only looks at what this turn produced. A turn
   * that wrote nothing leaves nothing to attach to, and the banner carries it.
   */
  function failedTurnAssistantID(): string | undefined {
    let prompt = -1
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].type === "user") {
        prompt = i
        break
      }
    }
    for (let i = messages.value.length - 1; i > prompt; i--) {
      if (messages.value[i].type === "assistant") return messages.value[i].id
    }
    const last = messages.value[messages.value.length - 1]
    if (last?.type === "assistant" && !last.time?.completed) return last.id
    return undefined
  }

  /**
   * Record a failure where it happened.
   *
   * A step or turn error belongs on the message it interrupted: it scrolls with
   * the conversation and is not mistaken for a failure of whatever the reader
   * does next. The banner is only for errors that have no message to attach to.
   */
  function attachError(err: StructuredError | undefined, messageID?: string) {
    if (!err) return
    const target = messageID ?? failedTurnAssistantID()
    if (!target) {
      error.value = err.message || "The turn failed."
      return
    }
    updateAssistant(target, (message) => ({ ...message, error: err }))
  }

  /**
   * Drop the banner once the failed turn is in the thread.
   *
   * A failed turn ends with an idle message the server records, and the thread
   * renders it. The banner carried the same failure only while that record was in
   * flight; keeping both would print the reason twice. A banner from a different
   * failure — a prompt the server refused outright — is left alone.
   */
  function clearFailedIdleBanner() {
    const newest = messages.value[messages.value.length - 1]
    if (newest?.type !== "idle" || newest.outcome !== "failed") return
    if (error.value === (newest.error?.message || "The turn failed.")) error.value = null
  }

  function applyEvent(type: string, data: Record<string, unknown> | undefined) {
    if (!data) return
    const sessionID = data.sessionID as string | undefined
    const isCurrent = !sessionID || sessionID === currentSessionID.value

    switch (type) {
      case "session.execution.started":
        if (isCurrent) beginTurn()
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle": {
        if (!isCurrent) break
        // A failed execution carries its reason, and nothing else reports it.
        if (type === "session.execution.failed") attachError(data.error as StructuredError | undefined)
        // The idle event carries how the turn ended, and "interrupted" is the
        // one that used to leave the view spinning. Interrupting produces
        // `session.execution.interrupted` — a terminal event of its own — so it
        // has to end the turn here too: without it the last message keeps its
        // streaming caret blinking after the step is already over.
        const outcome =
          type === "session.idle"
            ? ((data.outcome as "succeeded" | "failed" | "interrupted" | undefined) ?? "succeeded")
            : type === "session.execution.failed"
              ? "failed"
              : type === "session.execution.interrupted"
                ? "interrupted"
                : "succeeded"
        completeTurn(outcome)
        break
      }
      case "session.retry.scheduled": {
        if (!isCurrent) return
        // The turn is still live — it is waiting to try again — so it stays busy
        // while saying so, instead of looking like ordinary work.
        const attempt = (data.attempt as number) ?? 1
        const err = data.error as StructuredError | undefined
        status.value = { type: "retry", attempt, message: err?.message ?? "Retrying" }
        const messageID = data.assistantMessageID as string | undefined
        if (messageID) {
          updateAssistant(messageID, (message) => ({
            ...message,
            retry: {
              attempt,
              at: (data.at as number) ?? Date.now(),
              error: err ?? { type: "retry", message: "Retrying" },
            },
          }))
        }
        break
      }
      case "session.error": {
        if (!isCurrent) return
        // A session-wide failure has no message to hang off, so it goes to the
        // banner — the one place v1 put it before the port dropped this handler.
        const err = data.error as StructuredError | undefined
        error.value = err?.message || "Session error"
        break
      }
      case "session.step.started": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string | undefined
        if (messageID) {
          ensureAssistant(messageID, {
            agent: (data.agent as string) ?? "",
            model: data.model as ModelRef | undefined,
            time: { created: (data.started as number) ?? Date.now() },
          })
        }
        break
      }
      case "session.step.failed": {
        if (!isCurrent) return
        // The failure belongs to the step it happened in, so it is shown on that
        // message. Mirroring it into the banner as well printed the same text
        // twice, one line above the other, every time a step was interrupted.
        attachError(data.error as StructuredError | undefined, data.assistantMessageID as string | undefined)
        break
      }
      case "session.step.ended": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string | undefined
        if (messageID) {
          updateAssistant(messageID, (message) => ({
            ...message,
            finish: data.finish as string | undefined,
            rawFinish: data.rawFinish as string | undefined,
            cost: (data.cost as number) ?? message.cost,
            tokens: (data.tokens as TokenUsage) ?? message.tokens,
            time: { ...message.time, completed: Date.now() },
          }))
        }
        break
      }
      case "session.text.started": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) streamBlock(messageID, "text", (data.ordinal as number) ?? 0, "")
        break
      }
      case "session.text.delta": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        const delta = data.delta as string | undefined
        if (messageID && delta) streamBlock(messageID, "text", (data.ordinal as number) ?? 0, delta)
        break
      }
      case "session.text.ended": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) streamBlock(messageID, "text", (data.ordinal as number) ?? 0, data.text as string ?? "", true)
        break
      }
      case "session.reasoning.started": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) streamBlock(messageID, "reasoning", (data.ordinal as number) ?? 0, "")
        break
      }
      case "session.reasoning.delta": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        const delta = data.delta as string | undefined
        if (messageID && delta) streamBlock(messageID, "reasoning", (data.ordinal as number) ?? 0, delta)
        break
      }
      case "session.reasoning.ended": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) streamBlock(messageID, "reasoning", (data.ordinal as number) ?? 0, data.text as string ?? "", true)
        break
      }
      case "session.tool.input.started": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) upsertTool(messageID, data.id as string, { name: data.name as string, state: { status: "streaming", input: "" } })
        break
      }
      case "session.tool.input.delta": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        const delta = data.delta as string | undefined
        if (messageID && delta) {
          const toolID = data.id as string
          updateAssistant(messageID, (message) => {
            const content = message.content.slice()
            const at = content.findIndex((block) => block.type === "tool" && block.id === toolID)
            if (at === -1) return message
            const block = content[at] as AssistantToolBlock
            const input = block.state.status === "streaming" ? block.state.input + delta : ""
            content[at] = { ...block, state: { status: "streaming", input } }
            return { ...message, content }
          })
        }
        break
      }
      case "session.tool.input.ended": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        const text = data.text as string | undefined
        // The whole argument text replaces whatever the deltas assembled, so a
        // missed delta cannot leave the call with half its arguments.
        if (messageID && text !== undefined) {
          upsertTool(messageID, data.id as string, {
            state: (previous) => (previous.status === "streaming" ? { status: "streaming", input: text } : previous),
          })
        }
        break
      }
      case "session.tool.called": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) {
          upsertTool(messageID, data.id as string, {
            state: { status: "running", input: (data.input as Record<string, unknown>) ?? {} },
            executed: data.executed as boolean | undefined,
          })
        }
        break
      }
      case "session.tool.progress": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        const toolID = data.id as string
        if (messageID && toolID) {
          updateAssistant(messageID, (message) => {
            const content = message.content.slice()
            const at = content.findIndex((block) => block.type === "tool" && block.id === toolID)
            if (at === -1) return message
            const block = content[at] as AssistantToolBlock
            if (block.state.status === "running") {
              content[at] = { ...block, state: { ...block.state, metadata: data.metadata as Record<string, unknown> } }
            }
            return { ...message, content }
          })
        }
        break
      }
      case "session.tool.success": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) {
          upsertTool(messageID, data.id as string, {
            state: (previous) => ({
              status: "completed",
              // The result travels with the event; the arguments do not — those
              // come with `session.tool.called`, or as the streamed text — so the
              // input the call was made with is kept rather than blanked, and the
              // row keeps showing its command until the turn settles.
              input: previous.status === "streaming" ? parseToolInput(previous.input) : previous.input,
              content: (data.content as ToolContent[]) ?? [],
              metadata: data.metadata as Record<string, unknown>,
            }),
            executed: data.executed as boolean | undefined,
          })
        }
        break
      }
      case "session.tool.failed": {
        if (!isCurrent) return
        const messageID = data.assistantMessageID as string
        if (messageID) {
          upsertTool(messageID, data.id as string, {
            state: (previous) => ({
              status: "error",
              input: previous.status === "streaming" ? parseToolInput(previous.input) : previous.input,
              error: (data.error as StructuredError) ?? { type: "error", message: "Tool failed" },
              content: (data.content as ToolContent[]) ?? [],
              metadata: data.metadata as Record<string, unknown>,
            }),
          })
        }
        break
      }
      case "permission.asked": {
        const request = data as unknown as PermissionRequest
        if (request?.id && !permissions.value.some((item) => item.id === request.id)) {
          permissions.value = [...permissions.value, request]
        }
        break
      }
      case "permission.replied":
      case "permission.rejected": {
        const id = data.requestID as string
        if (id) permissions.value = permissions.value.filter((item) => item.id !== id)
        break
      }
      // `form.created` wraps the form in `data.form`; the settled events carry
      // the id at the top level. Getting this wrong means a question never
      // reaches the dock and the agent waits forever for an answer.
      case "form.created": {
        const form = (data.form ?? data) as unknown as FormDetail
        if (form?.id && !forms.value.some((item) => item.id === form.id)) forms.value = [...forms.value, form]
        break
      }
      case "form.replied":
      case "form.cancelled": {
        const id = (data.id as string) ?? (data.formID as string)
        if (id) forms.value = forms.value.filter((item) => item.id !== id)
        break
      }
      default:
        break
    }
  }

  function reset() {
    currentSessionID.value = null
    messages.value = []
    streamIndex.clear()
    status.value = { type: "idle" }
    turnAnchor.value = null
    error.value = null
    permissions.value = []
    forms.value = []
    todos.value = []
  }

  return {
    messages,
    conversation,
    status,
    turnAnchor,
    isBusy,
    awaitingUser,
    loading,
    sending,
    error,
    todos,
    pendingPermissions,
    pendingForms,
    currentSessionID,
    scrollToBottomRequest,
    requestScrollToBottom,
    contentBelow,
    open,
    reconcile,
    send,
    continueReasoningOnly,
    runCommand,
    compact,
    abort,
    replyPermission,
    replyForm,
    applyEvent,
    reset,
  }
}

export type { AssistantBlock, AssistantTextBlock, AssistantToolBlock }
export { joinText }
