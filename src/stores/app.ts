import type { Credentials } from "@/api/client"
import { desktopBridge } from "@/api/desktop"
import type { InstanceInfo } from "@/api/discovery"
import { sessionDirectory, type SessionInfo } from "@/api/types"
import { useArchive } from "./archive"
import { useChat } from "./chat"
import { useConnection } from "./connection"
import { draft, requestComposerFocus } from "./draft"
import { useFileViewer } from "./fileViewer"
import { useFiles } from "./files"
import { useHiddenProjects } from "./hiddenProjects"
import { useSessionState } from "./sessionState"
import { useLive } from "./live"
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
  const archive = useArchive()
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
    archive.reset()
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
      if (target && target !== server.directory.value) await switchProject(target)
      else await loadScoped(client)

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
      archive.reset()
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
    archive.reset()
    hidden.reset()
    connection.disconnect()
  }

  async function selectSession(sessionID: string) {
    const client = connection.client.value
    if (!client) return
    sessions.clearPreview()
    sessions.currentID.value = sessionID
    sessionState.markSeen(sessionID)
    writeSessionParam(sessionID, readSessionParam() === sessionID)
    const info = await client.getSession(sessionID, { directory: server.directory.value }).catch(() => null)
    if (info) {
      sessions.upsert(info)
      const directory = sessionDirectory(info)
      if (directory) projects.setLatest(directory, info)
    }
    await chat.open(client, sessionID, server.directory.value)
  }

  /** Open a session by id, switching project first if it lives elsewhere. */
  async function openSessionByID(sessionID: string) {
    const client = connection.client.value
    if (!client) return false
    const info = await client.getSession(sessionID).catch(() => null)
    if (!info) return false
    const directory = sessionDirectory(info)
    if (directory && directory !== server.directory.value) await switchProject(directory)
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

  /** Switch the active project (directory) and reload everything scoped to it. */
  async function switchProject(directory: string) {
    const client = connection.client.value
    if (!client) return
    if (server.directory.value === directory) return
    live.stop()
    chat.reset()
    sessions.reset()
    fileViewer.close()
    server.setDirectory(directory)
    await server.load(client, connection.connected.value?.origin ?? "", directory)
    await loadScoped(client)
  }

  async function openProject(directory: string) {
    const client = connection.client.value
    if (!client) return
    if (server.directory.value !== directory) await switchProject(directory)
    const session = projects.latestFor(directory)
    if (session) {
      await selectSession(session.id)
    } else {
      await newChat()
    }
    requestComposerFocus()
  }

  /**
   * Move to the next (`+1`) or previous (`-1`) project in the sidebar's order,
   * wrapping around at either end. It behaves like clicking the row: the
   * project's newest conversation opens, and the composer takes focus.
   */
  async function cycleProject(delta: 1 | -1) {
    const list = projects.entries.value
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
    const next = projects.entries.value.find((entry) => entry.directory !== directory)
    if (next) await openProject(next.directory)
    else server.clearProject()
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

    server.removeProject(entry.directory)
    projects.forgetProject(entry.directory)
    return result
  }

  async function newChat() {
    const client = connection.client.value
    if (!client) return null
    const session = await sessions.create(
      client,
      { agent: server.agent, model: server.selectedModel.value ?? undefined },
      server.directory.value,
    )
    if (server.directory.value) projects.setLatest(server.directory.value, session)
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

  async function archiveSession(sessionID: string, directory?: string) {
    const client = connection.client.value
    if (!client) return
    const target = directory ?? server.directory.value
    await sessions.archive(client, sessionID, target)
    projects.forgetChat(sessionID)
    if (target === server.directory.value && !sessions.currentID.value && sessions.sorted.value[0]) {
      await selectSession(sessions.sorted.value[0].id)
    }
    if (target) await projects.refreshOne(client, target)
  }

  async function openArchive() {
    const client = connection.client.value
    if (!client) return
    archive.open.value = true
    await archive.load(client)
  }

  function closeArchive() {
    archive.open.value = false
  }

  /**
   * Show an archived conversation in the conversation pane without switching
   * project or adding it to the active lists, so it can be read before deciding
   * to restore or delete it.
   */
  async function viewArchivedSession(session: SessionInfo) {
    const client = connection.client.value
    if (!client) return
    const directory = session.location?.directory ?? server.directory.value
    sessions.previewSession(session)
    await chat.open(client, session.id, directory)
  }

  async function restoreSession(sessionID: string, directory?: string) {
    const client = connection.client.value
    if (!client) return false
    const target = directory ?? server.directory.value
    await client.updateSession(sessionID, { archived: false }, { directory: target })
    archive.remove(sessionID)

    // The PATCH answers 204, so re-read the row to put it back in the lists.
    const info = await client.getSession(sessionID).catch(() => null)
    const owner = info ? (sessionDirectory(info) ?? target) : target
    if (info) {
      if (owner && owner === server.directory.value) sessions.upsert(info)
      if (owner) projects.setLatest(owner, info)
    }
    if (owner) await projects.refreshOne(client, owner)
    return true
  }

  /** Permanently delete a conversation, from the archive page or a list. */
  async function deleteSession(sessionID: string, directory?: string) {
    const client = connection.client.value
    if (!client) return false
    const target = directory ?? server.directory.value
    await client.deleteSession(sessionID, { directory: target })
    archive.remove(sessionID)
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
    archive,
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
    hideProject,
    unhideProject,
    deleteProject,
    openSessionByID,
    openInitialSession,
    newChat,
    sendMessage,
    runCommand,
    compact,
    abort,
    archiveSession,
    openArchive,
    closeArchive,
    viewArchivedSession,
    restoreSession,
    deleteSession,
    renameSession,
    replyPermission,
    replyForm,
  }
}

export type AppStore = ReturnType<typeof useApp>
