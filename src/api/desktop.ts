/**
 * Typed access to the Electron preload bridge.
 *
 * The app also runs in a plain browser (for pure-UI development), where
 * `window.opencodeDesktop` is absent. Callers must check `desktopAvailable` and
 * degrade gracefully instead of assuming the git IPC surface exists.
 */

import type { ConversationState } from "@/utils/sessionState"

export type GitScope = "staged" | "worktree" | "untracked"

export interface GitRepoInfo {
  isRepo: boolean
  /** Why the directory is not usable as a repository. */
  reason?: "no directory" | "git-not-installed" | "not-a-repository"
  root?: string
  name?: string
  branch?: string | null
  head?: string | null
}

export interface GitFileEntry {
  /** Repository-relative path (the new path for renames). */
  path: string
  /** Previous path, present for renames and copies. */
  origPath?: string
  /** Index (staged) status code: `M`, `A`, `D`, `R`, `C`, `?`, or space. */
  index: string
  /** Working-tree status code: `M`, `D`, `R`, `?`, or space. */
  worktree: string
  untracked: boolean
  staged: boolean
  unstaged: boolean
}

export interface GitUnpushed {
  /** Commits on HEAD that the upstream (or any remote) does not contain. */
  count: number
  /** The tracked upstream, e.g. `origin/main`, or null when none is set. */
  upstream: string | null
}

export interface GitStatusResult extends GitRepoInfo {
  files: GitFileEntry[]
  /** Committed-but-unpushed work, which the file list does not reveal. */
  unpushed?: GitUnpushed
  error?: string
}

export interface GitDiffRequest {
  dir: string
  path: string
  scope: GitScope
}

export interface GitDiffResult {
  ok: boolean
  patch?: string
  binary?: boolean
  truncated?: boolean
  error?: string
  root?: string
  /** The old side's full text, so the viewer can show the whole file. */
  oldText?: string
  /** The new side's full text. */
  newText?: string
  /** False when a side was too large or binary: the viewer then shows hunks only. */
  complete?: boolean
}

export interface GitOpResult {
  ok: boolean
  error?: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  desktop: boolean
  /** Whether an application menu is installed (false on the chromeless platforms). */
  menu: boolean
}

/** A window's geometry in DIP, with the minimum size it may be resized to. */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export interface FileListResult {
  ok: boolean
  error?: string
  /** Repository root, or the project directory when it is not a repository. */
  root?: string
  isRepo?: boolean
  /** Project-relative paths, sorted. */
  files: string[]
  /** True when the walk hit its cap and the list is incomplete. */
  truncated?: boolean
}

export interface FileReadResult {
  ok: boolean
  error?: string
  text?: string
  binary?: boolean
  /** Size on disk, in bytes. */
  size?: number
  /** True when only the head of the file was returned. */
  truncated?: boolean
}

/** One entry of the tray menu, as sent to the main process. */
export interface TrayMenuItem {
  label?: string
  type?: "normal" | "separator"
  enabled?: boolean
  /** Clicking this entry focuses the conversation with this id. */
  sessionID?: string
  /** Clicking this entry opens this http(s) URL, for a conversation the browser owns. */
  url?: string
  /** Built-in action for the fixed entries at the bottom of the menu. */
  action?: "open" | "mute" | "quit"
  submenu?: TrayMenuItem[]
}

export interface TrayUpdate {
  /** PNG data URL for the badge icon; omitted keeps the current image. */
  dataURL?: string
  tooltip: string
  menu: TrayMenuItem[]
  muted: boolean
}

/** Tray icon, its menu, and the notifications behind them. */
export interface DesktopTrayApi {
  update(payload: TrayUpdate): Promise<void>
  /**
   * A desktop notification. `sessionID` focuses a studio conversation when the
   * notification is clicked; `url` opens a web chat conversation in the browser
   * instead, since the browser owns that one.
   */
  notify(payload: { title: string; body: string; sessionID?: string; url?: string }): Promise<void>
  /** Tray clicks that only the main process can turn into window actions. */
  onFocusSession(listener: (sessionID: string) => void): () => void
  onAction(listener: (action: "open" | "mute") => void): () => void
}

/** Workspace files, for the incremental file search. */
export interface DesktopFilesApi {
  list(directory: string): Promise<FileListResult>
  read(request: { dir: string; path: string }): Promise<FileReadResult>
}

/** One conversation as the web chat app reports it. */
export interface WebChatConversation {
  id: string
  title: string
  /** The project directory the conversation lives in, when it reported one. */
  project: string
  state: ConversationState
  reason: string
}

/** One reporting browser tab. */
export interface WebChatClient {
  /** Stable per-tab id, so two tabs are two entries. */
  client: string
  /** The app root, so a conversation can be opened in the browser. */
  url: string
  /** When the last report arrived; the main process drops stale clients. */
  at: number
  /** How many conversations the tab has open, with news or without. */
  open: number
  /** The tab as a whole. */
  state: ConversationState
  /** Only the conversations with something to say: idle ones are not reported. */
  conversations: WebChatConversation[]
}

/** Every live web chat tab, as the main process sees them. */
export interface WebChatPicture {
  at: number
  clients: WebChatClient[]
}

/** Conversation state reported by the web chat app, on its way to the tray. */
export interface DesktopWebChatApi {
  /** The current picture, for a renderer that has just loaded. */
  current(): Promise<WebChatPicture | null>
  /** Subscribe to changes; returns an unsubscribe function. */
  onStatus(listener: (picture: WebChatPicture) => void): () => void
}

/** A point in the same DIP space as window bounds. */
export interface ScreenPoint {
  x: number
  y: number
}

/** Controls for the chromeless window, which draws its own title bar. */
export interface DesktopWindowApi {
  minimize(): Promise<void>
  /** Toggles maximize/restore; observe `onMaximizedChange` for the result. */
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** Subscribe to maximize/unmaximize; returns an unsubscribe function. */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
  /** Current geometry, so a drag can be applied to it incrementally. */
  bounds(): Promise<WindowBounds | null>
  setBounds(bounds: Partial<WindowBounds>): Promise<void>
  /**
   * Cursor position in window-bounds coordinates. Resize drags must use this
   * rather than `MouseEvent.screenX`: a drag that moves the window also moves
   * its coordinate space, so event deltas would feed back on themselves.
   */
  cursorPoint(): Promise<ScreenPoint>
}

export interface DesktopBridge {
  desktop: true
  platform: NodeJS.Platform
  git: {
    repo(directory: string): Promise<GitRepoInfo>
    status(directory: string): Promise<GitStatusResult>
    diff(request: GitDiffRequest): Promise<GitDiffResult>
    stage(request: { dir: string; path: string }): Promise<GitOpResult>
    unstage(request: { dir: string; path: string }): Promise<GitOpResult>
  }
  files: DesktopFilesApi
  tray: DesktopTrayApi
  webchat: DesktopWebChatApi
  shell: {
    reveal(target: string): Promise<void>
    openExternal(url: string): Promise<void>
    openPath(target: string): Promise<string>
    info(): Promise<AppInfo>
  }
  window: DesktopWindowApi
}

declare global {
  interface Window {
    opencodeDesktop?: DesktopBridge
  }
}

/** The preload bridge, or undefined when running in a plain browser. */
export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.opencodeDesktop
}

/** Whether git-backed features are available in this runtime. */
export function gitAvailable(): boolean {
  return Boolean(desktopBridge()?.git)
}

/** Whether the window draws its own title bar (no OS decoration). */
export function windowControlsAvailable(): boolean {
  return Boolean(desktopBridge()?.window)
}
