/**
 * Types for the opencode **v2** HTTP API (`/api/*`).
 *
 * Derived from the running server's `GET /openapi.json` (`opencode HttpApi`,
 * 121 routes). v2 is not a prefix rename of v1: messages carry their content
 * inline (`Session.Message.Assistant.content[]`), the event stream is
 * `{ id, created, type, data, location?, durable? }`, and lists come back as
 * `{ data, cursor }` envelopes.
 */

export type SessionID = string
export type MessageID = string
export type ProjectID = string

/* --------------------------------- money ---------------------------------- */

export type USD = number
export type USDPerMillionTokens = number

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
  /** Absent from most payloads; the app derives totals from the fields above. */
  total?: number
}

export interface SessionTime {
  created: number
  updated: number
  idle?: number
  viewed?: number
  archived?: number
}

/* --------------------------------- refs ----------------------------------- */

export interface ModelRef {
  /** The model id, e.g. `deepseek/deepseek-v4.1-flash`. */
  id: string
  providerID: string
  variant?: string
}

export interface LocationRef {
  directory: string
}

/* -------------------------------- sessions -------------------------------- */

export interface SessionInfo {
  id: SessionID
  slug?: string
  projectID?: ProjectID
  parentID?: SessionID
  fork?: { sessionID: SessionID; boundary?: unknown } | unknown
  agent?: string
  model?: ModelRef
  cost?: number
  tokens?: TokenUsage
  outcome?: "succeeded" | "failed" | "interrupted"
  time: SessionTime
  title?: string
  /** Relative path within the project, when the session is scoped below it. */
  subpath?: string
  metadata?: Record<string, unknown>
  permissions?: PermissionRule[]
  revert?: { messageID: MessageID; partID?: string; snapshot?: string; files?: FileDiffInfo[] }
  location: LocationRef
}

/** The directory a session lives in (v2 nests it under `location`). */
export function sessionDirectory(session: SessionInfo | undefined | null): string | undefined {
  return session?.location?.directory
}

/* -------------------------------- messages -------------------------------- */

export interface StructuredError {
  type: string
  message: string
  status?: number
  response?: { body: string }
  retryAfterMs?: number
}

export interface MessageTime {
  created: number
  streamed?: number
  completed?: number
}

interface MessageBase {
  id: MessageID
  time: MessageTime
  metadata?: Record<string, unknown>
}

export interface PromptFileAttachment {
  data?: string
  mime: string
  source?: unknown
  name?: string
  description?: string
}

export interface PromptAgentAttachment {
  name: string
}

export interface PromptSkillAttachment {
  id: string
  name: string
  text?: string
}

export interface UserMessage extends MessageBase {
  type: "user"
  text: string
  files?: PromptFileAttachment[]
  agents?: PromptAgentAttachment[]
  skills?: PromptSkillAttachment[]
}

export interface SystemMessage extends MessageBase {
  type: "system"
  text: string
  description?: string
}

export interface SyntheticMessage extends MessageBase {
  type: "synthetic"
  text: string
  description?: string
}

export interface SkillMessage extends MessageBase {
  type: "skill"
  skill: string
  name: string
  text: string
}

export interface ShellMessage extends MessageBase {
  type: "shell"
  shellID: string
  command: string
  status: "running" | "exited" | "timeout" | "killed"
  exit?: number | string
  output?: { output: string; cursor: number; size: number; truncated: boolean }
}

export interface IdleMessage extends MessageBase {
  type: "idle"
  outcome: "succeeded" | "failed" | "interrupted"
  error?: StructuredError
}

export interface ModelSelectedMessage extends MessageBase {
  type: "model-switched"
  model: ModelRef
  previous?: ModelRef
}

export interface AgentSelectedMessage extends MessageBase {
  type: "agent-switched"
  agent: string
  previous?: string
}

export interface LocationSwitchedMessage extends MessageBase {
  type: "location-switched"
  location: LocationRef
  projectID?: ProjectID
  subpath?: string
}

export interface CompactionMessage extends MessageBase {
  type: "compaction"
  status: "running" | "completed" | "failed"
  reason: "auto" | "manual"
  summary?: string
  model?: ModelRef
  error?: StructuredError
  cost?: number
  tokens?: TokenUsage
}

/* ----------------------------- tool + content ----------------------------- */

export interface ToolTextContent {
  type: "text"
  text: string
}
export interface ToolFileContent {
  type: "file"
  uri: string
  mime: string
  name?: string | null
}
export type ToolContent = ToolTextContent | ToolFileContent

export interface ToolStateStreaming {
  status: "streaming"
  /** Raw, partially parsed JSON input. */
  input: string
}
export interface ToolStateRunning {
  status: "running"
  input: Record<string, unknown>
  metadata?: Record<string, unknown>
}
export interface ToolStateCompleted {
  status: "completed"
  input: Record<string, unknown>
  content: ToolContent[]
  metadata?: Record<string, unknown>
}
export interface ToolStateError {
  status: "error"
  input: Record<string, unknown>
  error: StructuredError
  content?: ToolContent[]
  metadata?: Record<string, unknown>
}
export type ToolState = ToolStateStreaming | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface AssistantTextBlock {
  type: "text"
  text: string
}
export interface AssistantReasoningBlock {
  type: "reasoning"
  text: string
  time?: { created: number; completed?: number }
}
export interface AssistantToolBlock {
  type: "tool"
  /** Tool-call id. */
  id: string
  /** Tool name. */
  name: string
  state: ToolState
  time: { created: number; ran?: number; completed?: number }
  executed?: boolean
}
export type AssistantBlock = AssistantTextBlock | AssistantReasoningBlock | AssistantToolBlock

export interface AssistantMessage extends MessageBase {
  type: "assistant"
  agent: string
  model: ModelRef
  content: AssistantBlock[]
  finish?: string
  rawFinish?: string
  cost?: number
  tokens?: TokenUsage
  error?: StructuredError
  retry?: { attempt: number; at: number; error: StructuredError }
  snapshot?: { start?: string; end?: string; files?: string[] }
}

export type SessionMessage =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | SyntheticMessage
  | SkillMessage
  | ShellMessage
  | IdleMessage
  | ModelSelectedMessage
  | AgentSelectedMessage
  | LocationSwitchedMessage
  | CompactionMessage

/* ---------------------------- agents + models ----------------------------- */

export interface AgentInfo {
  id: string
  name: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
  model?: ModelRef
  description?: string
  color?: string
  system?: string
  steps?: number
  permissions?: PermissionRule[]
}

export interface ModelCapabilities {
  tools: boolean
  input: string[]
  output: string[]
  temperature?: boolean
}

export interface ModelCostTier {
  tier: { type: "context"; size: number }
  input: USDPerMillionTokens
  output: USDPerMillionTokens
  cache: { read: USDPerMillionTokens; write: USDPerMillionTokens }
}
export interface ModelCost {
  input: USDPerMillionTokens
  output: USDPerMillionTokens
  cache: { read: USDPerMillionTokens; write: USDPerMillionTokens }
}

export interface ModelVariant {
  id: string
  settings?: Record<string, unknown>
}

export interface ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  capabilities: ModelCapabilities
  variants: ModelVariant[]
  cost?: ModelCost | ModelCostTier[]
  limit: { context: number; input?: number; output: number }
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled?: boolean
  time?: { released: number }
  settings?: Record<string, unknown>
  options?: Record<string, unknown>
}

export interface ProviderInfo {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package?: string
  settings?: Record<string, unknown>
  models?: Record<string, ModelInfo>
}

/* -------------------------------- projects -------------------------------- */

export interface ProjectInfo {
  id: ProjectID
  canonical: string
  name?: string
  vcs?: string
  icon?: { url?: string; override?: string; color?: string }
  commands?: { start?: string }
  time: { created: number; updated: number; active: number; archived?: number }
  sandboxes?: string[]
}

/**
 * The root directory, which opencode hands back as a project (`global`) even
 * though it is only a placeholder for a directory it cannot identify. Any
 * request scoped to `/` makes the server resolve — and so materialize — a second
 * ordinary project for it, so the studio treats `/` as "not a project".
 */
export const ROOT_DIRECTORY = "/"

/** Whether a directory is opencode's root placeholder rather than a project. */
export function isRootDirectory(directory: string | null | undefined): boolean {
  return directory === ROOT_DIRECTORY
}

/** The directory a project lives in. */
export function projectDirectory(project: ProjectInfo): string {
  return project.canonical
}

/* ----------------------------- config + misc ------------------------------ */

export interface CommandInfo {
  name: string
  description?: string
}

/* ------------------------------ mcp servers ------------------------------ */

export type McpStatus =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth"; error: string }

export interface McpServer {
  name: string
  status: McpStatus
  /** Present when the server signs in through an integration of its own. */
  integrationID?: string
}

/* ------------------------------ integrations ----------------------------- */

export type IntegrationMethod =
  | { type: "oauth"; id: string; label: string }
  | { type: "command"; id: string; label: string; command: string[] }
  | { type: "key"; label?: string; form?: unknown }
  | { type: "external"; id: string; label: string; form?: unknown }
  | { type: "env"; names: string[] }

export interface IntegrationInfo {
  id: string
  name: string
  metadata?: Record<string, unknown>
  methods: IntegrationMethod[]
  connections: unknown[]
}

export interface IntegrationAttempt {
  attemptID: string
  url: string
  instructions: string
  /** `auto` completes on the server's own callback; `code` waits for a paste. */
  mode: "auto" | "code"
  time: { created: number; expires: number }
}

export type IntegrationAttemptStatus =
  | { status: "pending"; time: { created: number; expires: number } }
  | { status: "complete"; time: { created: number; expires: number } }
  | { status: "failed"; message: string; time: { created: number; expires: number } }
  | { status: "expired"; time: { created: number; expires: number } }

export interface ServerConfig {
  $schema?: string
  model?: string | { providerID: string; model: string; variant?: string }
  small_model?: string
  default_agent?: string
  username?: string
  agents?: Record<string, unknown>
  [key: string]: unknown
}

export interface ServerInfo {
  version: string
  pid: number
  urls: string[]
  paths: { tmp: string }
  capabilities?: { persistentPty?: boolean | null } | null
}

export interface LocationInfo {
  directory: string
  project: { id: ProjectID; directory: string; canonical: string }
}

export interface SkillInfo {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

/* ------------------------- permissions + forms ---------------------------- */

export type PermissionEffect = "allow" | "deny" | "ask"
export type PermissionReply = "once" | "always" | "reject"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export interface PermissionRequest {
  id: string
  sessionID: SessionID
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type: "tool"; messageID: string; id: string }
  message?: string
}

export type FormFieldType = "string" | "number" | "integer" | "boolean" | "multiselect" | "external"

export interface FormOption {
  value: string
  label: string
  description?: string
}

export interface FormField {
  key: string
  type: FormFieldType
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  format?: string
  default?: unknown
  options?: FormOption[]
  custom?: boolean
  url?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export interface FormState {
  status: "pending" | "answered" | "cancelled"
  answer?: Record<string, unknown>
  message?: string
}

export interface FormInfo {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: FormField[]
}

export interface FormDetail extends FormInfo {
  state: FormState
}

/* ----------------------------------- vcs ---------------------------------- */

export interface FileDiffInfo {
  file: string
  additions: number
  deletions: number
  status?: string
}

/* --------------------------------- events --------------------------------- */

/**
 * One frame of the v2 event stream (`GET /api/event`).
 *
 * The server sends `{ id, created, type, data, location?, durable? }` on the
 * `data:` line, so `properties` (v1) becomes `data` here.
 */
export interface ServerEvent {
  id?: string
  created?: number
  type: string
  data?: Record<string, unknown>
  location?: LocationRef
  durable?: { aggregateID: string; seq: number; version: number }
  metadata?: Record<string, unknown>
}

/** The v2 event's payload, named `properties` for the store handlers. */
export function eventData(event: ServerEvent): Record<string, unknown> | undefined {
  return event.data
}

/* -------------------------------- envelopes ------------------------------- */

export interface DataEnvelope<T> {
  data: T
  location?: LocationRef
}
export interface Cursor {
  previous?: string | null
  next?: string | null
}
export interface ListEnvelope<T> {
  data: T[]
  cursor?: Cursor
}

/* ------------------------------ chat helpers ------------------------------ */

/** A conversation as the chat store keeps it: the v2 message, verbatim. */
export type ChatMessage = SessionMessage

/** True for an assistant message that has not finished streaming. */
export function isAssistant(message: SessionMessage): message is AssistantMessage {
  return message.type === "assistant"
}

/** Concatenate the text blocks of an assistant message. */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is AssistantTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
}

/** The tool blocks of an assistant message, in order. */
export function assistantTools(message: AssistantMessage): AssistantToolBlock[] {
  return message.content.filter((block): block is AssistantToolBlock => block.type === "tool")
}
