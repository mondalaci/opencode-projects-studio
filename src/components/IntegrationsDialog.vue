<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { ArrowLeft, Check, ExternalLink, Pencil, Plus, Trash2, X } from "lucide-vue-next"
import IntegrationForm from "./IntegrationForm.vue"
import { useApp } from "@/stores/app"
import {
  connectionStatus,
  connectionSummary,
  credentialConnections,
  integrationCategory,
  interactiveMethods,
  useIntegrations,
} from "@/stores/integrations"
import { requestModel } from "@/stores/shortcuts"
import type { IntegrationInfo, IntegrationMethod } from "@/api/types"

/**
 * The `/connect` dialog: every integration the server knows, and the way to
 * sign in to each.
 *
 * It follows the TUI's own screens — the integration list with its categories,
 * the account list of one integration, the method chooser, the form a method
 * asks for, and the progress of an attempt the server runs. An integration that
 * already holds a credential opens its accounts, so a click on a connected
 * provider means "manage this account", not "add another one".
 */

const app = useApp()
const integrations = useIntegrations()
const client = computed(() => app.connection.client.value)

const query = ref("")
const selected = ref(0)
const key = ref("")
const code = ref("")
const editing = ref<string | null>(null)
const label = ref("")
const confirming = ref<string | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)
const keyEl = ref<HTMLInputElement | null>(null)
const codeEl = ref<HTMLInputElement | null>(null)

/** The integration the current stage is about, when it names one. */
const currentIntegration = computed<IntegrationInfo | undefined>(() => {
  const stage = integrations.stage.value
  if (stage.kind === "list" || stage.kind === "failed") return undefined
  return integrations.find(stage.integrationID)
})

const interactive = computed(() => (currentIntegration.value ? interactiveMethods(currentIntegration.value) : []))

const title = computed(() => {
  const stage = integrations.stage.value
  switch (stage.kind) {
    case "accounts":
      return currentIntegration.value?.name ?? "Accounts"
    case "methods":
      return `Connect ${currentIntegration.value?.name ?? "an integration"}`
    case "form":
      return methodTitle(interactive.value[stage.methodIndex])
    case "key":
      return methodTitle(interactive.value[stage.methodIndex])
    case "oauth":
      return methodTitle(interactive.value[stage.methodIndex])
    case "command":
      return methodTitle(interactive.value[stage.methodIndex])
    case "external":
      return methodTitle(interactive.value[stage.methodIndex])
    case "done":
      return "Connected"
    default:
      return "Connect an integration"
  }
})

function methodTitle(method: IntegrationMethod | undefined): string {
  if (!method) return "Connect"
  if (method.type === "key") return method.label ?? "API key"
  if (method.type === "env") return method.names.join(", ")
  return method.label
}

/* ------------------------------- the list -------------------------------- */

interface Row {
  integration: IntegrationInfo
  disabled: boolean
  summary: string
  status?: string
}

const rows = computed<Row[]>(() => {
  const wanted = query.value.trim().toLowerCase()
  return integrations.integrations.value
    .filter((integration) => !wanted || integration.name.toLowerCase().includes(wanted) || integration.id.toLowerCase().includes(wanted))
    .map((integration) => {
      const methods = interactiveMethods(integration)
      const status = connectionStatus(integration)
      return {
        integration,
        disabled: !methods.length && !credentialConnections(integration).length,
        summary: methods.length ? connectionSummary(integration) : "Environment only",
        status: status ? "Sign in required →" : undefined,
      }
    })
})

/** The list split into the TUI's categories, in the order it presents them. */
const groups = computed(() => {
  const order = ["Popular", "Services", "MCP"] as const
  return order
    .map((name) => ({ name, rows: rows.value.filter((row) => integrationCategory(row.integration) === name) }))
    .filter((group) => group.rows.length)
})

/** The rows in the order they are drawn, for the keyboard highlight. */
const flatRows = computed(() => groups.value.flatMap((group) => group.rows))

watch(flatRows, () => {
  selected.value = Math.min(selected.value, Math.max(0, flatRows.value.length - 1))
})

const currentRow = computed(() => flatRows.value[selected.value])

/* ------------------------------- the stage ------------------------------- */

const formFields = computed(() => {
  const stage = integrations.stage.value
  if (stage.kind !== "form") return []
  const method = interactive.value[stage.methodIndex]
  if (!method || method.type === "command") return []
  return method.form ?? []
})

/** The methods a person can choose between on the method screen. */
const methodRows = computed(() =>
  interactive.value.map((method, index) => ({
    index,
    method,
    label: method.type === "key" ? (method.label ?? "API key") : method.label,
    detail: method.type === "command" ? method.command.join(" ") : undefined,
  })),
)

/** The accounts of the integration whose account screen is open. */
const accountRows = computed(() => {
  const stage = integrations.stage.value
  if (stage.kind !== "accounts") return []
  return integrations.accounts(stage.integrationID)
})

watch(
  () => integrations.open.value,
  (open) => {
    if (!open) {
      window.removeEventListener("keydown", onKeydown)
      return
    }
    query.value = ""
    selected.value = 0
    key.value = ""
    code.value = ""
    editing.value = null
    confirming.value = null
    window.addEventListener("keydown", onKeydown)
    void nextTick(() => searchEl.value?.focus())
  },
)

watch(
  () => integrations.stage.value.kind,
  (kind) => {
    if (kind === "key") void nextTick(() => keyEl.value?.focus())
    if (kind === "oauth") void nextTick(() => codeEl.value?.focus())
    if (kind === "list") void nextTick(() => searchEl.value?.focus())
  },
)

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))

function move(delta: number) {
  const count = flatRows.value.length
  if (!count) return
  const next = (selected.value + delta) % count
  selected.value = next < 0 ? next + count : next
}

function onKeydown(event: KeyboardEvent) {
  const stage = integrations.stage.value
  if (event.key === "Escape") {
    event.preventDefault()
    if (stage.kind === "list") integrations.hide()
    else if (stage.kind === "done") integrations.hide()
    else integrations.back()
    return
  }
  if (stage.kind !== "list") return
  if (event.key === "ArrowDown") {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === "ArrowUp") {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault()
    if (currentRow.value && !currentRow.value.disabled) integrations.chooseIntegration(currentRow.value.integration.id)
  }
}

/* ------------------------------- the flow -------------------------------- */

/** A sign-in finished: refresh the catalogue, then show what it unlocked. */
function connected(integration: IntegrationInfo) {
  const server = app.server
  const origin = app.connection.connected.value?.origin
  const directory = server.directory.value ?? undefined
  if (!client.value || !origin) {
    integrations.hide()
    return
  }
  void server.load(client.value, origin, directory).then(() => {
    const provider = server.providers.value.find(
      (item) =>
        (item.integrationID === integration.id || item.id === integration.id) &&
        server.models.value.some((model) => model.providerID === item.id),
    )
    // An MCP server has no models to pick; its connected screen is the only
    // confirmation the dialog can give, so it stays until it is dismissed.
    if (integration.metadata?.source === "mcp") return
    integrations.hide()
    requestModel(provider?.id)
  })
}

function start() {
  if (!client.value) return
  integrations.show(client.value, app.server.directory.value ?? undefined, connected)
}

/** The dialog is mounted always; the store decides whether it is on screen. */
watch(
  () => integrations.open.value,
  (open) => {
    if (open) key.value = ""
  },
)

function submitForm(answer: Record<string, unknown>) {
  integrations.submitForm(answer)
}

function submitKey() {
  if (!key.value.trim()) return
  void integrations.submitKey(key.value)
}

function submitCode() {
  if (!code.value.trim()) return
  void integrations.submitCode(code.value)
}

function retryAttempt() {
  const stage = integrations.stage.value
  if (stage.kind === "oauth" || stage.kind === "command" || stage.kind === "external") {
    integrations.beginMethod(stage.integrationID, stage.methodIndex, "list")
  }
}

function startRename(credentialID: string, current: string) {
  editing.value = credentialID
  label.value = current
  confirming.value = null
}

async function saveRename() {
  if (!editing.value) return
  const id = editing.value
  const value = label.value
  editing.value = null
  await integrations.renameCredential(id, value)
}

async function remove(integrationID: string, credentialID: string) {
  if (confirming.value !== credentialID) {
    confirming.value = credentialID
    return
  }
  confirming.value = null
  await integrations.deleteCredential(integrationID, credentialID)
}

function openUrl(url: string | undefined) {
  if (url) window.open(url, "_blank", "noopener,noreferrer")
}

function openAgain() {
  const stage = integrations.stage.value
  if (stage.kind === "oauth") openUrl(stage.attempt.url)
}

defineExpose({ start })
</script>

<template>
  <div v-if="integrations.open.value" class="integration-overlay" @click.self="integrations.hide()">
    <div class="integration-dialog" role="dialog" aria-modal="true" aria-label="Connect an integration">
      <header class="head">
        <button
          v-if="integrations.stage.value.kind !== 'list'"
          type="button"
          class="icon back"
          title="Back (Esc)"
          @click="integrations.stage.value.kind === 'done' ? integrations.hide() : integrations.back()"
        >
          <ArrowLeft :size="15" />
        </button>
        <h2>{{ title }}</h2>
        <button type="button" class="icon" title="Close (Esc)" @click="integrations.hide()">
          <X :size="14" />
        </button>
      </header>

      <!-- the integrations -->
      <template v-if="integrations.stage.value.kind === 'list'">
        <input
          ref="searchEl"
          v-model="query"
          class="search"
          type="text"
          placeholder="Search integrations"
          spellcheck="false"
        />

        <div class="list">
          <template v-for="group in groups" :key="group.name">
            <p class="group">{{ group.name }}</p>
            <button
              v-for="row in group.rows"
              :key="row.integration.id"
              type="button"
              class="row"
              :class="{
                active: flatRows[selected] === row,
                disabled: row.disabled,
              }"
              :disabled="row.disabled"
              @mousemove="selected = flatRows.indexOf(row)"
              @click="integrations.chooseIntegration(row.integration.id)"
            >
              <span class="row-main">
                <span class="row-name">
                  <Check
                    v-if="row.integration.connections.length && !row.status"
                    :size="13"
                    class="connected-mark"
                  />
                  {{ row.integration.name }}
                </span>
                <span v-if="row.summary" class="row-summary">{{ row.summary }}</span>
              </span>
              <span v-if="row.status" class="row-status">{{ row.status }}</span>
            </button>
          </template>
          <p v-if="!rows.length" class="empty">
            {{
              integrations.loading.value
                ? "Loading integrations…"
                : integrations.integrations.value.length
                  ? "No matching integrations"
                  : "No integrations available"
            }}
          </p>
        </div>

        <p v-if="integrations.error.value" class="message bad section">{{ integrations.error.value }}</p>

        <footer class="foot">
          <span class="hint">↑↓ choose · Enter open · Esc close</span>
        </footer>
      </template>

      <!-- the accounts of one integration -->
      <template v-else-if="integrations.stage.value.kind === 'accounts'">
        <div class="list">
          <button
            v-if="interactive.length"
            type="button"
            class="row action-row"
            @click="integrations.addAccount(integrations.stage.value.integrationID)"
          >
            <span class="row-main">
              <span class="row-name"><Plus :size="13" /> Add account</span>
            </span>
          </button>

          <div v-for="account in accountRows" :key="account.id" class="account">
            <template v-if="editing === account.id">
              <input
                v-model="label"
                class="inline-input"
                type="text"
                placeholder="Account name"
                spellcheck="false"
                @keydown.enter.prevent="saveRename"
                @keydown.escape.prevent="editing = null"
              />
              <button type="button" class="small" @click="saveRename">Save</button>
              <button type="button" class="small ghost" @click="editing = null">Cancel</button>
            </template>
            <template v-else>
              <button
                type="button"
                class="row account-row"
                :class="{ active: account.active }"
                :disabled="integrations.pending.value.includes(account.id)"
                @click="integrations.selectCredential(integrations.stage.value.integrationID, account.id)"
              >
                <span class="row-main">
                  <span class="row-name">
                    <Check v-if="account.active" :size="13" class="connected-mark" />
                    {{ account.label }}
                  </span>
                  <span class="row-summary">{{ account.method }}</span>
                </span>
                <span v-if="account.status" class="row-status" :title="account.status.message">
                  Sign in required →
                </span>
                <span v-else-if="account.active" class="row-status active-label">Active</span>
              </button>
              <button
                type="button"
                class="icon small-icon"
                title="Rename account"
                :disabled="integrations.pending.value.includes(account.id)"
                @click="startRename(account.id, account.label)"
              >
                <Pencil :size="13" />
              </button>
              <button
                type="button"
                class="icon small-icon danger"
                :title="confirming === account.id ? 'Press again to delete' : 'Delete account'"
                :disabled="integrations.pending.value.includes(account.id)"
                @click="remove(integrations.stage.value.integrationID, account.id)"
              >
                <Trash2 :size="13" />
              </button>
            </template>
          </div>

          <p v-if="!accountRows.length" class="empty">No accounts connected.</p>
        </div>

        <p v-if="integrations.error.value" class="message bad section">{{ integrations.error.value }}</p>

        <footer class="foot">
          <span class="hint">Choose an account · Esc back</span>
        </footer>
      </template>

      <!-- the ways in -->
      <template v-else-if="integrations.stage.value.kind === 'methods'">
        <div class="list">
          <button
            v-for="row in methodRows"
            :key="row.index"
            type="button"
            class="row"
            @click="integrations.beginMethod(integrations.stage.value.integrationID, row.index, integrations.stage.value.backTo)"
          >
            <span class="row-main">
              <span class="row-name">{{ row.label }}</span>
              <span v-if="row.detail" class="row-summary mono">{{ row.detail }}</span>
            </span>
          </button>
        </div>

        <p v-if="integrations.error.value" class="message bad section">{{ integrations.error.value }}</p>

        <footer class="foot">
          <span class="hint">Choose how to sign in · Esc back</span>
        </footer>
      </template>

      <!-- the method's form -->
      <template v-else-if="integrations.stage.value.kind === 'form'">
        <div class="section form-section">
          <IntegrationForm
            :fields="formFields"
            :busy="integrations.loading.value || integrations.submitting.value"
            :error="integrations.error.value"
            submit-label="Continue"
            @submit="submitForm"
            @cancel="integrations.back()"
          />
        </div>
      </template>

      <!-- the key a key method waits on -->
      <template v-else-if="integrations.stage.value.kind === 'key'">
        <div class="section">
          <p class="message">Paste the API key for <strong>{{ currentIntegration?.name }}</strong>.</p>
          <div class="inline-actions">
            <input
              ref="keyEl"
              v-model="key"
              class="inline-input"
              type="password"
              placeholder="API key"
              spellcheck="false"
              autocomplete="off"
              @keydown.enter.prevent="submitKey"
            />
            <button type="button" class="action" :disabled="!key.trim() || integrations.submitting.value" @click="submitKey">
              Connect
            </button>
          </div>
          <p v-if="integrations.error.value" class="message bad">{{ integrations.error.value }}</p>
        </div>
        <footer class="foot">
          <span class="hint">Enter connect · Esc back</span>
        </footer>
      </template>

      <!-- an OAuth attempt -->
      <template v-else-if="integrations.stage.value.kind === 'oauth'">
        <div class="section">
          <p class="message">{{ integrations.stage.value.attempt.instructions || "Waiting for the browser…" }}</p>
          <pre class="url">{{ integrations.stage.value.attempt.url }}</pre>

          <template v-if="integrations.stage.value.status === 'waiting'">
            <div v-if="integrations.stage.value.attempt.mode === 'code'" class="inline-actions">
              <input
                ref="codeEl"
                v-model="code"
                class="inline-input"
                type="text"
                placeholder="Paste the authorization code"
                spellcheck="false"
                @keydown.enter.prevent="submitCode"
              />
              <button type="button" class="action" :disabled="!code.trim() || integrations.submitting.value" @click="submitCode">
                Submit
              </button>
            </div>
            <div class="inline-actions">
              <button type="button" class="link" @click="openAgain">
                <ExternalLink :size="12" /> Open the sign-in page again
              </button>
              <button type="button" class="ghost" @click="integrations.back()">Cancel</button>
            </div>
            <p v-if="integrations.stage.value.message" class="message bad">{{ integrations.stage.value.message }}</p>
          </template>

          <template v-else>
            <p class="message bad">{{ integrations.stage.value.message }}</p>
            <div class="inline-actions">
              <button type="button" class="action" @click="retryAttempt">Try again</button>
              <button type="button" class="ghost" @click="integrations.back()">Back</button>
            </div>
          </template>
        </div>
      </template>

      <!-- a command attempt -->
      <template v-else-if="integrations.stage.value.kind === 'command'">
        <div class="section">
          <p class="message">
            {{ integrations.stage.value.status === "waiting" ? "Waiting for the command to finish…" : integrations.stage.value.message }}
          </p>
          <pre v-if="integrations.stage.value.output" class="output">{{ integrations.stage.value.output }}</pre>
          <div class="inline-actions">
            <button
              v-if="integrations.stage.value.status === 'waiting'"
              type="button"
              class="ghost"
              @click="integrations.back()"
            >
              Cancel
            </button>
            <button v-else type="button" class="action" @click="retryAttempt">Try again</button>
            <button v-if="integrations.stage.value.status !== 'waiting'" type="button" class="ghost" @click="integrations.back()">
              Back
            </button>
          </div>
        </div>
      </template>

      <!-- a step the server finishes itself -->
      <template v-else-if="integrations.stage.value.kind === 'external'">
        <div class="section">
          <p class="message">
            {{ integrations.stage.value.status === "waiting" ? "Connecting…" : integrations.stage.value.message }}
          </p>
          <div v-if="integrations.stage.value.status !== 'waiting'" class="inline-actions">
            <button type="button" class="action" @click="retryAttempt">Try again</button>
            <button type="button" class="ghost" @click="integrations.back()">Back</button>
          </div>
        </div>
      </template>

      <!-- finished -->
      <template v-else-if="integrations.stage.value.kind === 'done'">
        <div class="section">
          <p class="message ok">
            <Check :size="14" /> Connected {{ currentIntegration?.name }}
          </p>
        </div>
        <footer class="foot">
          <button type="button" class="action" @click="integrations.hide()">Done</button>
        </footer>
      </template>

      <!-- a failure that has no screen of its own -->
      <template v-else>
        <div class="section">
          <p class="message bad">{{ integrations.stage.value.message }}</p>
        </div>
        <footer class="foot">
          <button type="button" class="action" @click="integrations.back()">Back</button>
        </footer>
      </template>
    </div>
  </div>
</template>

<style scoped>
.integration-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 24px;
}
.integration-dialog {
  width: min(560px, 100%);
  max-height: min(720px, 100%);
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 10px 14px;
}
.head h2 {
  flex: 1;
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icon {
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  display: grid;
  place-items: center;
  flex: none;
}
.icon:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.icon.danger:hover {
  color: var(--danger);
}
.icon:disabled {
  opacity: 0.35;
  cursor: default;
}
.search {
  margin: 0 14px 8px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.search:focus {
  border-color: var(--accent);
}
.list {
  padding: 0 8px 8px;
  overflow-y: auto;
  min-height: 0;
}
.group {
  margin: 10px 8px 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.group:first-child {
  margin-top: 0;
}
.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.row:hover:not(:disabled),
.row.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.row:disabled {
  cursor: default;
  opacity: 0.45;
}
.row-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.row-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-summary {
  font-size: 11.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-summary.mono {
  font-family: var(--font-mono);
}
.row-status {
  flex: none;
  font-size: 11.5px;
  color: var(--accent);
}
.connected-mark {
  color: var(--accent);
  flex: none;
}
.action-row .row-name {
  color: var(--accent);
}
.account {
  display: flex;
  align-items: center;
  gap: 4px;
}
.account-row {
  flex: 1;
  min-width: 0;
}
.account-row.active {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.active-label {
  color: var(--text-faint);
}
.small-icon {
  width: 24px;
  height: 24px;
}
.empty {
  margin: 0;
  padding: 8px 8px 10px;
  font-size: 12.5px;
  color: var(--text-faint);
}
.section {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  overflow-y: auto;
  min-height: 0;
}
.form-section {
  border-top: none;
  padding-top: 4px;
}
.message {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-muted);
  word-break: break-word;
}
.message.ok {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
}
.message.bad {
  color: var(--danger);
}
.url,
.output {
  margin: 8px 0 0;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-faint);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
}
.inline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.inline-input {
  flex: 1 1 180px;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}
.inline-input:focus {
  border-color: var(--accent);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
}
.link:hover {
  text-decoration: underline;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
}
.action {
  padding: 5px 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-text);
  font-size: 12.5px;
}
.action:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.action:disabled {
  opacity: 0.4;
  cursor: default;
}
.ghost {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 12.5px;
}
.ghost:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.small {
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-size: 12px;
}
.small.ghost {
  background: transparent;
  color: var(--text-muted);
}
.hint {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
