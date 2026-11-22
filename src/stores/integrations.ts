import { ref } from "vue"
import type { ServerClient } from "@/api/client"
import type {
  CredentialEntry,
  IntegrationAttempt,
  IntegrationConnection,
  IntegrationFormField,
  IntegrationInfo,
  IntegrationMethod,
} from "@/api/types"

/**
 * Integrations, as the TUI's `/connect` dialog presents them.
 *
 * An integration is a provider or an MCP server and the ways it can be signed
 * in to: an API key, an OAuth round trip, a command the server runs itself, or
 * a step finished outside the browser. The server keeps the credentials, and
 * this only drives the dialogs that collect what a method needs.
 *
 * The stages mirror the TUI's own screens: the integration list, the account
 * list of one integration, the method list, the method's form, the key or
 * authorization code it waits on, and the progress of an attempt that runs on
 * the server. Everything the server owns — the attempt, its expiry, the
 * callback — stays the server's; this polls it until it settles.
 */

export type IntegrationStage =
  | { kind: "list" }
  | { kind: "accounts"; integrationID: string }
  | { kind: "methods"; integrationID: string; backTo: "list" | "accounts" }
  | { kind: "form"; integrationID: string; methodIndex: number; backTo: "list" | "accounts" }
  | {
      kind: "key"
      integrationID: string
      methodIndex: number
      answer: Record<string, unknown>
      backTo: "list" | "accounts"
    }
  | {
      kind: "oauth"
      integrationID: string
      methodIndex: number
      attempt: IntegrationAttempt
      status: "waiting" | "failed"
      message?: string
    }
  | {
      kind: "command"
      integrationID: string
      methodIndex: number
      attemptID: string
      status: "waiting" | "failed"
      output: string
      message?: string
    }
  | { kind: "external"; integrationID: string; methodIndex: number; status: "waiting" | "failed"; message?: string }
  | { kind: "done"; integrationID: string }
  | { kind: "failed"; message: string }

/** How often a waiting authorization asks whether its callback has landed. */
const OAUTH_POLL_MS = 1500
/** A command reports its output as it runs, so it is asked more often. */
const COMMAND_POLL_MS = 500

const integrations = ref<IntegrationInfo[]>([])
const credentials = ref<CredentialEntry[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const open = ref(false)
const stage = ref<IntegrationStage>({ kind: "list" })
/** Credentials with an activate or remove in flight, so their row can say so. */
const pending = ref<string[]>([])
/** A method's start or its last answer is on its way, so a second click cannot double it. */
const submitting = ref(false)

let client: ServerClient | null = null
let directory: string | undefined
let onConnected: ((integration: IntegrationInfo) => void) | null = null
let timer: ReturnType<typeof setTimeout> | undefined
/** Bumped whenever a poll is abandoned, so a late answer cannot revive it. */
let generation = 0

/** The methods a person can act on; an environment variable is not a dialog. */
export function interactiveMethods(integration: IntegrationInfo): Exclude<IntegrationMethod, { type: "env" }>[] {
  return integration.methods.filter((method): method is Exclude<IntegrationMethod, { type: "env" }> => method.type !== "env")
}

/** The connections that name a stored credential, which the account list edits. */
export function credentialConnections(integration: IntegrationInfo) {
  return integration.connections.filter(
    (connection): connection is Extract<IntegrationConnection, { type: "credential" }> => connection.type === "credential",
  )
}

/** The first connection that still needs a sign-in, if any. */
export function connectionStatus(integration: IntegrationInfo) {
  return integration.connections.find((connection) => connection.status)?.status
}

/** The line beside an integration's name: its accounts, or its environment variable. */
export function connectionSummary(integration: IntegrationInfo): string {
  const connections = integration.connections
  if (connections.length > 1) return `${connections.length} connections`
  const [first] = connections
  if (!first) return ""
  return first.type === "credential" ? first.label : `$${first.name}`
}

/** The category the TUI sorts an integration under. */
export function integrationCategory(integration: IntegrationInfo): "Popular" | "MCP" | "Services" {
  if (integration.metadata?.source === "mcp") return "MCP"
  if (POPULAR.has(integration.id)) return "Popular"
  return "Services"
}

/** The providers the TUI lifts to the top of its list. */
const POPULAR = new Set(["opencode-go", "opencode", "openai", "github-copilot", "anthropic", "google"])

/** Whether a conditional form field applies, given the answers so far. */
export function fieldApplies(field: IntegrationFormField, values: Record<string, unknown>): boolean {
  if (!field.when?.length) return true
  return field.when.every((condition) => {
    const current = values[condition.key]
    const matches = Array.isArray(current) ? current.includes(String(condition.value)) : current === condition.value
    return condition.op === "eq" ? matches : !matches
  })
}

/**
 * The fields a form actually shows.
 *
 * A hidden field only contributes its default, and a conditional one appears
 * when its `when` says so. An external step is always shown: it is a link to
 * open and a box to tick, not an answer the other fields can make irrelevant.
 */
export function visibleIntegrationFields(
  fields: IntegrationFormField[] | undefined,
  values: Record<string, unknown>,
): IntegrationFormField[] {
  return (fields ?? []).filter(
    (field) => field.type === "external" || (!field.hidden && fieldApplies(field, values)),
  )
}

/** The answers a form starts from: every field's default, hidden ones included. */
export function integrationFormDefaults(fields: IntegrationFormField[] | undefined): Record<string, unknown> {
  const answer: Record<string, unknown> = {}
  for (const field of fields ?? []) {
    if (field.default !== undefined) answer[field.key] = field.default
  }
  return answer
}

/** Coerce a typed value to what the field's type expects. */
export function normalizeIntegrationValue(field: IntegrationFormField, value: unknown): unknown {
  if (field.type === "multiselect") return Array.isArray(value) ? value : []
  if (field.type === "boolean") return value === true || value === "true"
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "string") return value
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  return value
}

/** The value a field starts from when nothing has been picked or typed. */
export function integrationFieldDefault(field: IntegrationFormField): unknown {
  if (field.default !== undefined) return field.default
  if (field.type === "multiselect") return []
  // A Yes/No is a choice, not a starting point: an untouched one stays
  // unanswered and is left out of the answer body.
  if (field.type === "boolean") return undefined
  return ""
}

/** Whether a field holds an answer worth sending. */
function answered(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  return value !== ""
}

/** The answer body a form's values make, leaving out what was never filled in. */
export function integrationAnswer(
  fields: IntegrationFormField[] | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const answer: Record<string, unknown> = {}
  for (const field of fields ?? []) {
    // A conditional field that does not apply contributes nothing, even when a
    // default was filled in for it.
    if (field.type !== "external" && !fieldApplies(field, values)) continue
    const value = values[field.key]
    if (!answered(value)) continue
    answer[field.key] = normalizeIntegrationValue(field, value)
  }
  return answer
}

export function useIntegrations() {
  function stopPolling() {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function find(integrationID: string): IntegrationInfo | undefined {
    return integrations.value.find((integration) => integration.id === integrationID)
  }

  /** The integrations and credentials again. */
  async function load() {
    if (!client) return
    loading.value = true
    error.value = null
    try {
      const [list, stored] = await Promise.all([
        client.integrations({ directory: directory ?? undefined }),
        client.credentials().catch(() => [] as CredentialEntry[]),
      ])
      integrations.value = list
      credentials.value = stored
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  function show(server: ServerClient, dir?: string | null, connected?: (integration: IntegrationInfo) => void) {
    client = server
    directory = dir ?? undefined
    onConnected = connected ?? null
    open.value = true
    error.value = null
    stage.value = { kind: "list" }
    stopPolling()
    void load()
  }

  /**
   * Close the dialog.
   *
   * An attempt that is still running is ended with it, as the TUI does: the
   * authorization it opened in a browser is no longer being watched, and a
   * command it started has nothing left to show its output in.
   */
  function hide() {
    cancelActive()
    stopPolling()
    open.value = false
    stage.value = { kind: "list" }
    error.value = null
    client = null
    directory = undefined
    onConnected = null
  }

  /** End the attempt the current stage is waiting on, if it is waiting on one. */
  function cancelActive() {
    const current = stage.value
    if (!client) return
    if (current.kind === "oauth") {
      void client.oauthCancel(current.integrationID, current.attempt.attemptID).catch(() => undefined)
    } else if (current.kind === "command") {
      void client.integrationCommandCancel(current.integrationID, current.attemptID).catch(() => undefined)
    }
  }

  /** Go back one screen, ending an attempt that would otherwise keep running. */
  function back() {
    if (submitting.value) return
    const current = stage.value
    if (current.kind === "list" || current.kind === "done") return
    if (current.kind === "accounts") {
      stage.value = { kind: "list" }
      return
    }
    if (current.kind === "methods") {
      stage.value = current.backTo === "accounts" ? { kind: "accounts", integrationID: current.integrationID } : { kind: "list" }
      return
    }
    if (current.kind === "form") {
      stage.value =
        current.backTo === "accounts"
          ? { kind: "accounts", integrationID: current.integrationID }
          : { kind: "methods", integrationID: current.integrationID, backTo: "list" }
      return
    }
    if (current.kind === "key") {
      stage.value = {
        kind: "methods",
        integrationID: current.integrationID,
        backTo: current.backTo,
      }
      return
    }
    if (current.kind === "oauth" || current.kind === "command" || current.kind === "external") {
      cancelActive()
      stopPolling()
      stage.value = { kind: "methods", integrationID: current.integrationID, backTo: "list" }
      return
    }
    if (current.kind === "failed") {
      stage.value = { kind: "list" }
    }
  }

  /**
   * Pick an integration.
   *
   * One that already holds a credential opens its accounts instead of its
   * methods: connecting again would add a second account, which is not what a
   * click on a connected provider should mean. The account screen offers that
   * as its own row.
   */
  function chooseIntegration(integrationID: string) {
    const integration = find(integrationID)
    if (!integration) return
    error.value = null
    if (credentialConnections(integration).length) {
      stage.value = { kind: "accounts", integrationID }
      return
    }
    const methods = interactiveMethods(integration)
    if (!methods.length) return
    if (methods.length === 1) {
      beginMethod(integrationID, 0, "list")
      return
    }
    stage.value = { kind: "methods", integrationID, backTo: "list" }
  }

  /** Add another account to an integration that already has one. */
  function addAccount(integrationID: string) {
    const integration = find(integrationID)
    if (!integration) return
    const methods = interactiveMethods(integration)
    if (!methods.length) return
    if (methods.length === 1) {
      beginMethod(integrationID, 0, "accounts")
      return
    }
    stage.value = { kind: "methods", integrationID, backTo: "accounts" }
  }

  /** Ask for the chosen method's form, or start it when it has none to ask. */
  function beginMethod(integrationID: string, methodIndex: number, backTo: "list" | "accounts") {
    if (submitting.value) return
    const integration = find(integrationID)
    if (!integration) return
    const method = interactiveMethods(integration)[methodIndex]
    if (!method) return
    error.value = null
    if (method.type === "command") {
      void startCommand(integrationID, methodIndex)
      return
    }
    const fields = method.form ?? []
    const defaults = integrationFormDefaults(fields)
    if (visibleIntegrationFields(fields, defaults).length) {
      stage.value = { kind: "form", integrationID, methodIndex, backTo }
      return
    }
    void startMethod(integrationID, methodIndex, integrationAnswer(fields, defaults), backTo)
  }

  /** The form's answers are in, so begin the method they belong to. */
  function submitForm(answer: Record<string, unknown>) {
    const current = stage.value
    if (current.kind !== "form") return
    void startMethod(current.integrationID, current.methodIndex, answer, current.backTo)
  }

  async function startMethod(
    integrationID: string,
    methodIndex: number,
    answer: Record<string, unknown>,
    backTo: "list" | "accounts" = "list",
  ) {
    const integration = find(integrationID)
    if (!integration || !client) return
    const method = interactiveMethods(integration)[methodIndex]
    if (!method) return
    const active = client
    const dir = directory
    error.value = null

    if (method.type === "key") {
      stage.value = { kind: "key", integrationID, methodIndex, answer, backTo }
      return
    }

    if (method.type === "external") {
      stage.value = { kind: "external", integrationID, methodIndex, status: "waiting" }
      submitting.value = true
      try {
        await active.integrationConnectExternal(integrationID, method.id, {
          directory: dir,
          ...(Object.keys(answer).length ? { answer } : {}),
        })
        await finish(integration)
      } catch (err) {
        stage.value = {
          kind: "external",
          integrationID,
          methodIndex,
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        submitting.value = false
      }
      return
    }

    if (method.type === "command") {
      void startCommand(integrationID, methodIndex)
      return
    }

    submitting.value = true
    try {
      const attempt = await active.oauthConnect(integrationID, method.id, {
        directory: dir,
        ...(Object.keys(answer).length ? { answer } : {}),
      })
      if (!attempt) throw new Error("The server did not start a sign-in attempt")
      stage.value = { kind: "oauth", integrationID, methodIndex, attempt, status: "waiting" }
      window.open(attempt.url, "_blank", "noopener,noreferrer")
      if (attempt.mode === "auto") pollOAuth(integrationID, attempt.attemptID)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      stage.value = { kind: "methods", integrationID, backTo }
    } finally {
      submitting.value = false
    }
  }

  /** Hand back the API key a key method waits on. */
  async function submitKey(key: string) {
    const current = stage.value
    if (current.kind !== "key" || !client || !key.trim() || submitting.value) return
    const integration = find(current.integrationID)
    if (!integration) return
    error.value = null
    submitting.value = true
    try {
      await client.integrationConnectKey(current.integrationID, key.trim(), {
        directory,
        ...(Object.keys(current.answer).length ? { answer: current.answer } : {}),
      })
      await finish(integration)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      submitting.value = false
    }
  }

  /** Ask the server whether an OAuth callback has landed, until it has. */
  function pollOAuth(integrationID: string, attemptID: string) {
    stopPolling()
    const mine = generation
    timer = setTimeout(async () => {
      if (!client || mine !== generation) return
      try {
        const status = await client.oauthStatus(integrationID, attemptID)
        if (mine !== generation) return
        if (!status || status.status === "pending") {
          pollOAuth(integrationID, attemptID)
          return
        }
        if (status.status === "failed") {
          const current = stage.value
          if (current.kind === "oauth") stage.value = { ...current, status: "failed", message: status.message }
          return
        }
        if (status.status === "expired") {
          const current = stage.value
          if (current.kind === "oauth") stage.value = { ...current, status: "failed", message: "The sign-in expired" }
          return
        }
        const integration = find(integrationID)
        if (integration) await finish(integration)
      } catch (err) {
        const current = stage.value
        if (current.kind === "oauth") {
          stage.value = { ...current, status: "failed", message: err instanceof Error ? err.message : String(err) }
        }
      }
    }, OAUTH_POLL_MS)
  }

  /** Hand back the code a `code`-mode provider is waiting on. */
  async function submitCode(code: string) {
    const current = stage.value
    if (current.kind !== "oauth" || !client || !code.trim() || submitting.value) return
    const integration = find(current.integrationID)
    if (!integration) return
    submitting.value = true
    try {
      await client.oauthComplete(current.integrationID, current.attempt.attemptID, code.trim())
      await finish(integration)
    } catch (err) {
      // Keep the code input: a mistyped code is worth another try.
      const latest = stage.value
      if (latest.kind === "oauth") {
        stage.value = { ...latest, status: "waiting", message: err instanceof Error ? err.message : String(err) }
      }
    } finally {
      submitting.value = false
    }
  }

  /** Begin a command-method sign-in and follow its output. */
  async function startCommand(integrationID: string, methodIndex: number) {
    const integration = find(integrationID)
    if (!integration || !client) return
    const method = interactiveMethods(integration)[methodIndex]
    if (!method || method.type !== "command") return
    const active = client
    error.value = null
    submitting.value = true
    try {
      const attempt = await active.integrationCommandConnect(integrationID, method.id, { directory })
      if (!attempt) throw new Error("The server did not start the sign-in command")
      stage.value = {
        kind: "command",
        integrationID,
        methodIndex,
        attemptID: attempt.attemptID,
        status: "waiting",
        output: "",
      }
      pollCommand(integrationID, attempt.attemptID)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      stage.value = { kind: "methods", integrationID, backTo: "list" }
    } finally {
      submitting.value = false
    }
  }

  /** Ask the server how a command is doing, until it finishes. */
  function pollCommand(integrationID: string, attemptID: string) {
    stopPolling()
    const mine = generation
    timer = setTimeout(async () => {
      if (!client || mine !== generation) return
      try {
        const status = await client.integrationCommandStatus(integrationID, attemptID)
        if (mine !== generation) return
        const current = stage.value
        if (current.kind !== "command") return
        if (!status || status.status === "pending") {
          stage.value = { ...current, output: status?.message ?? current.output }
          pollCommand(integrationID, attemptID)
          return
        }
        if (status.status === "failed") {
          stage.value = { ...current, status: "failed", message: status.message }
          return
        }
        if (status.status === "expired") {
          stage.value = { ...current, status: "failed", message: "The sign-in command expired" }
          return
        }
        const integration = find(integrationID)
        if (integration) await finish(integration)
      } catch (err) {
        const current = stage.value
        if (current.kind === "command") {
          stage.value = { ...current, status: "failed", message: err instanceof Error ? err.message : String(err) }
        }
      }
    }, COMMAND_POLL_MS)
  }

  /** A connection is complete: refresh what the server now offers, then hand it over. */
  async function finish(integration: IntegrationInfo) {
    stopPolling()
    await load()
    stage.value = { kind: "done", integrationID: integration.id }
    onConnected?.(integration)
  }

  /** The stored accounts of one integration, by label, with the active one marked. */
  function accounts(integrationID: string) {
    const integration = find(integrationID)
    if (!integration) return []
    return credentialConnections(integration)
      .map((connection) => ({
        ...connection,
        active: credentials.value.some((entry) => entry.id === connection.id && entry.active),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  /** A click on an account: finish a sign-in, re-authorize, or make it active. */
  async function selectCredential(integrationID: string, credentialID: string) {
    const integration = find(integrationID)
    if (!integration || !client) return
    const connection = credentialConnections(integration).find((item) => item.id === credentialID)
    if (!connection) return
    if (connection.status?.url) {
      window.open(connection.status.url, "_blank", "noopener,noreferrer")
      return
    }
    if (connection.status) {
      const methods = interactiveMethods(integration)
      const index = methods.findIndex((method) => method.type === connection.method)
      if (index !== -1) beginMethod(integrationID, index, "accounts")
      else stage.value = { kind: "methods", integrationID, backTo: "accounts" }
      return
    }
    if (credentials.value.some((entry) => entry.id === credentialID && entry.active)) return
    pending.value = [...pending.value, credentialID]
    try {
      await client.credentialActivate(credentialID)
      await load()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      pending.value = pending.value.filter((id) => id !== credentialID)
    }
  }

  async function renameCredential(credentialID: string, label: string) {
    if (!client || !label.trim()) return
    error.value = null
    try {
      await client.credentialRename(credentialID, label.trim())
      await load()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function deleteCredential(integrationID: string, credentialID: string) {
    if (!client) return
    pending.value = [...pending.value, credentialID]
    try {
      await client.credentialRemove(credentialID)
      await load()
      const integration = find(integrationID)
      if (!integration || (!credentialConnections(integration).length && !interactiveMethods(integration).length)) {
        stage.value = { kind: "list" }
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      pending.value = pending.value.filter((id) => id !== credentialID)
    }
  }

  return {
    integrations,
    credentials,
    loading,
    error,
    open,
    stage,
    pending,
    submitting,
    load,
    show,
    hide,
    back,
    chooseIntegration,
    addAccount,
    beginMethod,
    submitForm,
    submitKey,
    submitCode,
    selectCredential,
    renameCredential,
    deleteCredential,
    accounts,
    find,
  }
}
