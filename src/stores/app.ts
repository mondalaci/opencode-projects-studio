import type { Credentials } from "@/api/client"
import { desktopBridge } from "@/api/desktop"
import type { InstanceInfo } from "@/api/discovery"
import { isRootDirectory, sessionDirectory, type AssistantMessage } from "@/api/types"
import { useChat } from "./chat"
import { useConnection } from "./connection"
import { draft, requestComposerFocus } from "./draft"
import { useFileViewer } from "./fileViewer"
import { useFiles } from "./files"
import { useHiddenProjects } from "./hiddenProjects"
import { useSessionState } from "./sessionState"
import { useLive } from "./live"
import { showNotice } from "./notice"
import { useProjects, type ProjectEntry } from "./projects"
import { useServer } from "./server"
import { useSessions } from "./sessions"
import {
  clearPromptParams,
  readAutoSubmitParam,
  readQueryParam,
  readSessionParam,
  writeSessionParam,
} from "@/utils/url"

export function useApp() {
  const connection = useConnection()
  const server = useServer()
  const sessions = useSessions()
  const projects = useProjects()
  const chat = useChat()
  const live = useLive()
  const files = useFiles()
  const fileViewer = useFileViewer()
  const sessionState = useSessionState()
  const hidden = useHiddenProjects()

  /** Load the conversation list and event stream for the current project. */
  async function loadScoped(client: NonNullable<typeof connection.client.value>) {
    await sessions.load(client, server.directory.value)
    live.start(client)
  }

  async function connect(info: InstanceInfo, credentials?: Credentials) {
    live.stop()
    chat.reset()
    sessions.reset()
    projects.reset()
    server.reset()
    files.reset()
    fileViewer.close()
    sessionState.reset()
    hidden.reset()

    server.applySavedPrefs(info.origin)

    const ok = await connection.connect(info, credentials)
    const client = connection.client.value
    if (!ok || !client) return false

    try {
      const origin = connection.connected.value?.origin ?? info.origin
      await server.load(client, origin, server.savedDirectory(origin))
      // The hidden list decides which rows the sidebar shows, so it is read
      // before anything picks a project to open.
      await hidden.load()

      // One conversation per project: fetch each project's newest conversation
      // so the sidebar can open on the most recent one by default.
      await projects.load(client)

      const target = projects.mostRecent.value?.directory ?? null
      // A refused switch loaded nothing, so the directory the app is on still has
      // to have its conversations and stream fetched.
      const switched = target && target !== server.directory.value ? await switchProject(target) : false
      if (!switched) await loadScoped(client)

      // One global stream keeps every project's conversation state (and the tray
      // rollup) current, not just the active project's.
      sessionState.start(client)

      await openInitialSession()
      await applyLinkParams()
      return true
    } catch (error) {
      live.stop()
      chat.reset()
      sessions.reset()
      projects.reset()
      server.reset()
      hidden.reset()
      connection.disconnect()
      connection.connectError.value = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  function disconnect() {
    live.stop()
    chat.reset()
    sessions.reset()
    projects.reset()
    server.reset()
    files.reset()
    fileViewer.close()
    sessionState.reset()
    hidden.reset()
    connection.disconnect()
  }

  async function selectSession(sessionID: string) {
    const client = connection.client.value
    if (!client) return
    sessions.currentID.value = sessionID
    writeSessionParam(sessionID, readSessionParam() === sessionID)
    const info = await client.getSession(sessionID, { directory: server.directory.value }).catch(() => null)
    if (info) {
      sessions.upsert(info)
      const directory = sessionDirectory(info)
      if (directory) projects.setLatest(directory, info)
    }
    // After the info is in hand: publishing the view needs the conversation's
    // idle stamp, which only the fetched record carries.
    sessionState.markSeen(sessionID)
    await chat.open(client, sessionID, server.directory.value)
  }

  /** Open a session by id, switching project first if it lives elsewhere. */
  async function openSessionByID(sessionID: string) {
    const client = connection.client.value
    if (!client) return false
    const info = await client.getSession(sessionID).catch(() => null)
    if (!info) return false
    const directory = sessionDirectory(info)
    // A conversation that lives in the root placeholder is not openable: opening
    // it would make the app point at `/` and recreate the project.
    if (isRootDirectory(directory)) return false
    if (directory && directory !== server.directory.value && !(await switchProject(directory))) return false
    await selectSession(sessionID)
    return true
  }

  /**
   * The conversation shown when a project is opened: the session id in the URL
   * when it resolves, otherwise the project's newest conversation.
   */
  async function openInitialSession() {
    const id = readSessionParam()
    if (id && (await openSessionByID(id))) return
    const session = projects.latestFor(server.directory.value)
    if (session) await selectSession(session.id)
  }

  async function applyLinkParams() {
    const query = readQueryParam()
    if (query !== null) draft.value = query

    if (!readAutoSubmitParam()) return
    const text = draft.value.trim()
    clearPromptParams()
    if (!text) return
    await sendMessage(text)
    draft.value = ""
  }

  /**
   * Switch the active project (directory) and reload everything scoped to it.
   *
   * A project whose folder has been removed is refused before anything is torn
   * down. Its location cannot be resolved, so the requests that follow would fall
   * back to the server's own directory and strand the app on a project nobody
   * asked for; saying so and staying where the user was is the honest answer.
   *
   * Returns whether the switch happened.
   */
  async function switchProject(directory: string): Promise<boolean> {
    const client = connection.client.value
    if (!client) return false
    // The root is opencode's placeholder, not a project to point at.
    if (isRootDirectory(directory)) return false
    if (server.directory.value === directory) return true
    if (await server.locationMissing(client, directory)) {
      projects.markMissing(directory)
      showNotice(`${directory} no longer exists — its past conversations stay listed, but nothing new can run there.`)
      return false
    }
    projects.clearMissing(directory)
    live.stop()
    chat.reset()
    sessions.reset()
    fileViewer.close()
    server.setDirectory(directory)
    await server.load(client, connection.connected.value?.origin ?? "", directory)
    await loadScoped(client)
    // The opened project's block is discovered here rather than by sweeping
    // every project at connect, which would boot every project's MCP fleet.
    await sessionState.reconcileProject(directory)
    return true
  }

  async function openProject(directory: string): Promise<boolean> {
    const client = connection.client.value
    if (!client) return false
    // A refused switch leaves the current project — and its conversation — alone.
    if (server.directory.value !== directory && !(await switchProject(directory))) return false
    // Only open a conversation that already exists. A project with none stays
    // empty until the first prompt creates its conversation, so simply opening
    // (or re-opening) a project never litters it with empty Untitled chats.
    const session = projects.latestFor(directory)
    if (session) await selectSession(session.id)
    requestComposerFocus()
    return true
  }

  /**
   * Move to the next (`+1`) or previous (`-1`) project in the sidebar's order,
   * wrapping around at either end. It behaves like clicking the row: the
   * project's newest conversation opens, and the composer takes focus.
   */
  async function cycleProject(delta: 1 | -1) {
    // A row whose folder is gone cannot be opened, so it is skipped rather than
    // tried and refused on every press — which would leave the keyboard stuck on
    // the same neighbour.
    const list = projects.entries.value.filter((entry) => !entry.archived)
    if (!list.length) return
    const index = list.findIndex((entry) => entry.directory === server.directory.value)
    if (index === -1) {
      await openProject(list[delta > 0 ? 0 : list.length - 1].directory)
      return
    }
    const target = list[(index + delta + list.length) % list.length].directory
    // A single project wraps onto itself; reopening it would only reset focus.
    if (target === server.directory.value) return
    await openProject(target)
  }

  /**
   * Move to the next (`+1`, older) or previous (`-1`, newer) conversation in the
   * open project, wrapping around at either end. The order is the sidebar's —
   * newest first — so `-1` walks up toward the newest conversation and `+1`
   * walks down toward the oldest. It behaves like clicking a conversation row:
   * the conversation opens and the composer takes focus.
   */
  async function cycleSession(delta: 1 | -1) {
    const list = sessions.sorted.value
    if (!list.length) return
    const index = list.findIndex((item) => item.id === sessions.currentID.value)
    // With nothing open (or a stale id) the first press opens the newest, so a
    // press never lands back where it started.
    if (index === -1) {
      await selectSession(list[0].id)
      requestComposerFocus()
      return
    }
    const target = list[(index + delta + list.length) % list.length]
    // A single conversation wraps onto itself; reopening it would only reset focus.
    if (target.id === sessions.currentID.value) return
    await selectSession(target.id)
    requestComposerFocus()
  }

  /**
   * Move the app off a project it is about to stop showing.
   *
   * Any request scoped to a directory makes the server resolve — and so create —
   * that project, so the app must not keep pointing at one that has just been
   * deleted. Switching to the next visible project first, or to nothing at all,
   * is what keeps the row from coming straight back.
   */
  async function leaveProject(directory: string) {
    if (server.directory.value !== directory) return
    live.stop()
    chat.reset()
    sessions.reset()
    fileViewer.close()
    // Only a project that can actually be opened will take the app off this one,
    // and one that refuses must not leave the app on the row being removed.
    const next = projects.entries.value.find((entry) => entry.directory !== directory && !entry.archived)
    if (!next || !(await openProject(next.directory))) server.clearProject()
  }

  /** Keep a project out of the sidebar, moving off it when it is the open one. */
  async function hideProject(entry: ProjectEntry) {
    const result = await hidden.hide(entry.directory)
    if (result.ok) await leaveProject(entry.directory)
    return result
  }

  /** Show a hidden project in the sidebar again. */
  function unhideProject(directory: string) {
    return hidden.unhide(directory)
  }

  /**
   * Delete a project and everything it owns.
   *
   * opencode has no endpoint for this, so the desktop app removes the row from
   * its own database (see electron/opencode-db.cjs). The project is left before
   * the delete, because a request scoped to its directory would recreate it.
   */
  async function deleteProject(entry: ProjectEntry) {
    const bridge = desktopBridge()
    if (!bridge?.opencode) return { ok: false, error: "Deleting a project needs the desktop app." }

    await leaveProject(entry.directory)
    const result = await bridge.opencode.deleteProject(entry.project.id)
    if (!result.ok) return result

    // If the deleted project was the remembered one, forget it, so a restart
    // does not resolve — and so recreate — the directory it named.
    if (server.savedDirectory(connection.connected.value?.origin ?? "") === entry.directory) {
      server.clearSavedDirectory()
    }
    server.removeProject(entry.directory)
    projects.forgetProject(entry.directory)
    return result
  }

  /**
   * Add a project directory to the sidebar.
   *
   * opencode has no "add project" call: a directory becomes a project the moment
   * a request is scoped to it, so resolving the picked directory registers it on
   * the server. `GET /api/location` is the cheapest such request and answers with
   * the project's canonical path — the key the sidebar lists rows under — which
   * the app then opens like any other row.
   *
   * The desktop app asks the OS for the folder; in a browser the absolute path is
   * typed by hand, since a page cannot open a native folder picker.
   */
  async function addProject(): Promise<{ ok: boolean; error?: string }> {
    const client = connection.client.value
    if (!client) return { ok: false, error: "Not connected to a server." }

    const picker = desktopBridge()?.dialog
    let directory: string | null = null
    if (picker) {
      directory = await picker.pickDirectory({ title: "Add project", buttonLabel: "Add project" })
    } else if (typeof window !== "undefined") {
      directory = window.prompt("Absolute path of the project directory:")?.trim() || null
    }
    // Cancelled (or nothing typed): not an error, and nothing to say.
    if (!directory) return { ok: false }

    const location = await client.location({ directory }).catch(() => null)
    if (!location) return { ok: false, error: `opencode could not open ${directory}.` }
    const canonical = location.project?.canonical || location.directory

    // Opening the project reloads the server's project list, so the new row
    // appears, and creates its first conversation when it has none.
    await openProject(canonical)
    return { ok: true }
  }

  async function newChat() {
    const client = connection.client.value
    if (!client) return null
    // An archived project's folder is gone, so there is nowhere to run a new
    // conversation. Its past conversations stay readable.
    if (projects.isArchived(server.directory.value)) return null
    const session = await sessions.create(
      client,
      { agent: server.agent, model: server.selectedModel.value ?? undefined },
      server.directory.value,
    )
    if (server.directory.value) {
      projects.setLatest(server.directory.value, session)
      projects.recordCreated(server.directory.value)
    }
    await selectSession(session.id)
    requestComposerFocus()
    return session
  }

  type FilePartInput = { type: "file"; mime: string; url: string; filename?: string }

  async function sendMessage(text: string, files: FilePartInput[] = []) {
    const client = connection.client.value
    if (!client) return
    const content = text.trim()
    if (!content && files.length === 0) return
    let sessionID = sessions.currentID.value
    if (!sessionID) {
      const session = await newChat()
      if (!session) return
      sessionID = session.id
    }
    await chat.send(
      client,
      sessionID,
      {
        text: content,
        files: files.map((file) => ({ mime: file.mime, url: file.url, filename: file.filename })),
        model: server.selectedModel.value,
        agent: server.agent,
        imageModel: server.selectedImageModel.value,
      },
      server.directory.value,
    )
  }

  async function abort() {
    const client = connection.client.value
    const sessionID = sessions.currentID.value
    if (!client || !sessionID) return
    await chat.abort(client, sessionID, server.directory.value)
  }

  /**
   * The prompt a "Continue" sends after an output-limit stop. It is deliberately
   * explicit about not repeating the earlier text: the model sees its own cut-off
   * reply in the history and would otherwise begin again from the top.
   */
  const CONTINUE_PROMPT = "Continue from where you stopped. Do not repeat what you already wrote."

  /**
   * Carry on a reply the model was cut off on. A new turn is the only way to get
   * the rest of the text, so it goes through the same `chat.send` the composer
   * uses — but on the model and agent that produced the truncated message, not
   * whatever the picker holds now, so the continuation matches the reply it is
   * continuing.
   */
  async function continueReply(message: AssistantMessage) {
    const client = connection.client.value
    const sessionID = sessions.currentID.value
    if (!client || !sessionID) return
    await chat.send(
      client,
      sessionID,
      {
        text: CONTINUE_PROMPT,
        model: message.model,
        agent: message.agent,
      },
      server.directory.value,
    )
  }

  /**
   * Hand a slash command to the server.
   *
   * A command belongs to a conversation, so an empty pane gets one first —
   * exactly as `sendMessage` does — and the command then expands into the
   * prompt that opens it.
   */
  async function runCommand(name: string, text: string, files: FilePartInput[] = []) {
    const client = connection.client.value
    if (!client) return
    let sessionID = sessions.currentID.value
    if (!sessionID) {
      const session = await newChat()
      if (!session) return
      sessionID = session.id
    }
    await chat.runCommand(client, sessionID, { name, text, files }, server.directory.value)
  }

  /** Compact the open conversation, as the TUI's `/compact` does. */
  async function compact() {
    const client = connection.client.value
    const sessionID = sessions.currentID.value
    if (!client || !sessionID) return
    await chat.compact(client, sessionID, server.directory.value)
  }

  /** Permanently delete a conversation. */
  async function deleteSession(sessionID: string, directory?: string) {
    const client = connection.client.value
    if (!client) return false
    const target = directory ?? server.directory.value
    await client.deleteSession(sessionID, { directory: target })
    sessions.forget(sessionID)
    projects.forgetChat(sessionID)
    if (target) await projects.refreshOne(client, target)
    return true
  }

  async function renameSession(sessionID: string, title: string, directory?: string) {
    const client = connection.client.value
    if (!client) return
    const target = directory ?? server.directory.value
    const info = await client.updateSession(sessionID, { title }, { directory: target })
    if (!info) return
    if (target === server.directory.value) sessions.upsert(info)
    const owner = sessionDirectory(info) ?? target
    if (owner) projects.setLatest(owner, info)
  }

  async function replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject") {
    const client = connection.client.value
    if (!client) return
    await chat.replyPermission(client, sessionID, requestID, reply, server.directory.value)
  }

  async function replyForm(sessionID: string, formID: string, answer: Record<string, unknown>) {
    const client = connection.client.value
    if (!client) return
    await chat.replyForm(client, sessionID, formID, answer, server.directory.value)
  }

  return {
    connection,
    server,
    sessions,
    projects,
    hidden,
    sessionState,
    chat,
    live,
    connect,
    disconnect,
    selectSession,
    switchProject,
    openProject,
    cycleProject,
    cycleSession,
    hideProject,
    unhideProject,
    deleteProject,
    addProject,
    openSessionByID,
    openInitialSession,
    newChat,
    sendMessage,
    runCommand,
    compact,
    abort,
    continueReply,
    deleteSession,
    renameSession,
    replyPermission,
    replyForm,
  }
}

export type AppStore = ReturnType<typeof useApp>
