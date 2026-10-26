<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { ChevronRight, Eye, Folder } from "lucide-vue-next"
import ConfirmDialog from "./ConfirmDialog.vue"
import ConversationMenu from "./ConversationMenu.vue"
import FilterBar from "./FilterBar.vue"
import ProjectMenu from "./ProjectMenu.vue"
import ShortcutBadge from "./ShortcutBadge.vue"
import Spinner from "./Spinner.vue"
import type { SessionInfo } from "@/api/types"
import { projectDeleteAvailable } from "@/api/desktop"
import { useApp } from "@/stores/app"
import { requestComposerFocus } from "@/stores/draft"
import { filterTarget, stopFilter } from "@/stores/filter"
import type { ProjectEntry } from "@/stores/projects"
import { useSessionState } from "@/stores/sessionState"
import { openRequests } from "@/stores/shortcuts"
import { relativeTime } from "@/utils/format"
import { fuzzyMatch } from "@/utils/fuzzy"

const app = useApp()
const { entries, hiddenEntries, loading, pending, current, isExpanded, chatsFor, isChatsLoading, toggleExpanded } =
  app.projects
const { openProject, archiveSession, renameSession, selectSession, switchProject, hideProject, unhideProject, deleteProject } =
  app
const { stateFor, reasonFor } = useSessionState()
const { writable: hiddenWritable, error: hiddenError } = app.hidden

/** Whether the sidebar can hide projects, and whether it can delete them. */
const canHide = hiddenWritable
const canDelete = projectDeleteAvailable()

/**
 * Why a project cannot be deleted, or `undefined` when it can.
 *
 * opencode's `global` placeholder collects the conversations of directories it
 * cannot identify, and the server recreates it on demand, so it is never removed.
 */
function deleteDisabledReason(entry: ProjectEntry): string | undefined {
  if (entry.project.id === "global") return "The global project cannot be deleted"
  if (!canDelete) return "Deleting a project needs the desktop app"
  return undefined
}

/** Whether the Hidden section below the list is open. */
const hiddenOpen = ref(false)

/** The project a delete confirmation is open for, if any. */
const pendingDelete = ref<ProjectEntry | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function askDelete(entry: ProjectEntry) {
  deleteError.value = null
  pendingDelete.value = entry
}

function cancelDelete() {
  if (deleting.value) return
  pendingDelete.value = null
  deleteError.value = null
}

async function confirmDelete() {
  const entry = pendingDelete.value
  if (!entry || deleting.value) return
  deleting.value = true
  deleteError.value = null
  try {
    const result = await deleteProject(entry)
    if (!result.ok) {
      deleteError.value = result.error ?? "Could not delete the project."
      return
    }
    pendingDelete.value = null
  } catch (cause) {
    deleteError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    deleting.value = false
  }
}

const deleteMessage = computed(() => {
  const entry = pendingDelete.value
  if (!entry) return ""
  return `This removes ${entry.name} (${entry.directory}) and every conversation in it from opencode. It cannot be undone.`
})

/** The conversation whose title is being edited inline, and its project. */
const editing = ref<{ id: string; directory: string } | null>(null)
const editTitle = ref("")
const editInput = ref<HTMLInputElement | null>(null)

/** Incremental filter over the projects (Ctrl+R). */
const query = ref("")
/** Index into the filtered list that Enter opens. */
const cursor = ref(0)

const filtering = computed(() => filterTarget.value === "projects")

/** Projects matching the query: by name first, then by directory. */
const filtered = computed<ProjectEntry[]>(() => {
  const raw = query.value.trim()
  if (!raw) return entries.value

  const hits: Array<{ entry: ProjectEntry; score: number }> = []
  for (const entry of entries.value) {
    const byName = fuzzyMatch(raw, entry.name)
    if (byName) {
      hits.push({ entry, score: byName.score })
      continue
    }
    const byPath = fuzzyMatch(raw, entry.directory)
    if (byPath) hits.push({ entry, score: byPath.score - 40 })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.map((hit) => hit.entry)
})

// A new query re-opens the cursor on the best match.
watch(query, () => {
  cursor.value = 0
})

function moveCursor(delta: number) {
  cursor.value = Math.min(filtered.value.length - 1, Math.max(0, cursor.value + delta))
}

function openCursor() {
  const entry = filtered.value[cursor.value]
  if (entry) void openProject(entry.directory)
  closeFilter()
}

function closeFilter() {
  query.value = ""
  stopFilter()
}

function isActive(entry: ProjectEntry) {
  return entry.directory === current.value
}

/** Whether a project's newest conversation is still being fetched. */
function isPending(entry: ProjectEntry) {
  return !entry.session && loading.value && pending.value > 0
}

function conversationTitle(entry: ProjectEntry) {
  return entry.session ? entry.session.title || "Untitled" : "No conversation yet"
}

function conversationTime(entry: ProjectEntry) {
  return relativeTime(entry.session?.time?.updated ?? entry.session?.time?.created)
}

/** The state dot for a project's conversation. */
function conversationState(entry: ProjectEntry) {
  return stateFor(entry.session?.id)
}

function conversationStateTitle(entry: ProjectEntry) {
  return entry.session ? reasonFor(entry.session.id) : "no conversation"
}

/* ------------------------------- inline rename ------------------------------ */

/** Whether a conversation's title is currently being edited inline. */
function isEditing(sessionID: string | undefined) {
  return Boolean(sessionID) && editing.value?.id === sessionID
}

function setRenameInput(el: Element | { $el?: Element } | null) {
  if (!el) {
    editInput.value = null
    return
  }
  const node = (el as { $el?: Element }).$el ?? (el as Element)
  editInput.value = node instanceof HTMLInputElement ? node : null
}

async function startRename(session: SessionInfo, directory: string) {
  editing.value = { id: session.id, directory }
  editTitle.value = session.title || ""
  await nextTick()
  editInput.value?.focus()
  editInput.value?.select()
}

async function commitRename() {
  const target = editing.value
  editing.value = null
  if (!target) return
  const title = editTitle.value.trim()
  const previous =
    chatsFor(target.directory).find((item) => item.id === target.id)?.title ??
    entries.value.find((entry) => entry.directory === target.directory)?.session?.title
  if (!title || title === previous) return
  // Rename against the conversation's own project, so a row that is not the
  // active project can be renamed without switching the whole app over to it.
  await renameSession(target.id, title, target.directory)
}

function cancelRename() {
  editing.value = null
}

/* ------------------------------- chat list ------------------------------- */

/** Reveal or hide a project row's conversation list. */
function toggleChats(entry: ProjectEntry) {
  const client = app.connection.client.value
  if (!client) return
  void toggleExpanded(client, entry.directory)
}

/** The conversations shown under an expanded row (all of them, newest first). */
function projectChats(entry: ProjectEntry) {
  return chatsFor(entry.directory)
}

/** Keep a project out of the sidebar; the store reports a failure in `hiddenError`. */
function hide(entry: ProjectEntry) {
  void hideProject(entry)
}

/** Bring a hidden project back into the list. */
function unhide(entry: ProjectEntry) {
  void unhideProject(entry.directory)
}

/** Open one conversation, switching to its project first when it lives elsewhere. */
async function openChat(entry: ProjectEntry, chat: SessionInfo) {
  if (!isActive(entry)) await switchProject(entry.directory)
  await selectSession(chat.id)
  // Choosing a conversation is the same intent as choosing its project: start
  // typing there.
  requestComposerFocus()
}

/* ------------------------------- list keyboard nav ------------------------------- */

function scrollNavIntoView() {
  const items = navEl.value?.querySelectorAll<HTMLElement>(".project")
  items?.[navIndex.value]?.scrollIntoView({ block: "nearest" })
}

/** Bring the row for a directory into view (used after Alt+L expands it). */
function scrollProjectIntoView(directory: string) {
  const items = navEl.value?.querySelectorAll<HTMLElement>(".project")
  if (!items) return
  for (const el of items) {
    if (el.dataset.dir === directory) {
      el.scrollIntoView({ block: "nearest" })
      return
    }
  }
}

const navEl = ref<HTMLElement | null>(null)
/** Index of the arrow-key cursor in the list, or -1 when inactive. */
const navIndex = ref(-1)

// Alt+P / Alt+S drop the cursor onto the active project.
watch(
  () => [openRequests.project, openRequests.sessions],
  () => {
    if (!entries.value.length) return
    const index = entries.value.findIndex((entry) => isActive(entry))
    navIndex.value = index >= 0 ? index : 0
    void nextTick(() => {
      navEl.value?.focus()
      scrollNavIntoView()
    })
  },
)

// Alt+L expands (or collapses) the active project's conversation list, so the
// current project's chats are one keystroke away without reaching for the mouse.
watch(
  () => openRequests.chats,
  () => {
    const directory = current.value
    const client = app.connection.client.value
    if (!directory || !client) return
    void toggleExpanded(client, directory).then(() => nextTick(() => scrollProjectIntoView(directory)))
  },
)

function endNav() {
  navIndex.value = -1
}

function move(delta: number) {
  navIndex.value = Math.min(entries.value.length - 1, Math.max(0, navIndex.value + delta))
  void nextTick(scrollNavIntoView)
}

function onKeydown(event: KeyboardEvent) {
  if (navIndex.value < 0) return
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault()
      move(1)
      break
    case "ArrowUp":
      event.preventDefault()
      move(-1)
      break
    case "Home":
      event.preventDefault()
      navIndex.value = 0
      void nextTick(scrollNavIntoView)
      break
    case "End":
      event.preventDefault()
      navIndex.value = entries.value.length - 1
      void nextTick(scrollNavIntoView)
      break
    case "Enter": {
      event.preventDefault()
      const entry = entries.value[navIndex.value]
      if (entry) void openProject(entry.directory)
      endNav()
      break
    }
    case "Escape":
      event.preventDefault()
      endNav()
      break
    default:
      break
  }
}
</script>

<template>
  <div class="projects-wrap">
    <Transition name="filter-bar">
      <FilterBar
        v-if="filtering"
        target="projects"
        placeholder="Filter projects…"
        :shown="filtered.length"
        :total="entries.length"
        @update:query="query = $event"
        @move="moveCursor"
        @open="openCursor"
        @close="closeFilter"
      />
    </Transition>

    <nav ref="navEl" class="projects" tabindex="-1" @keydown="onKeydown" @blur="endNav">
      <div
        v-for="(entry, index) in filtered"
        :key="entry.directory"
        class="project"
        :class="{
          active: isActive(entry),
          expanded: isExpanded(entry.directory),
          'kb-active': index === navIndex,
          'cursor-active': filtering && index === cursor,
        }"
        :title="entry.directory"
        :data-dir="entry.directory"
      >
        <button
          class="chevron"
          :class="{ open: isExpanded(entry.directory) }"
          :title="isExpanded(entry.directory) ? 'Hide chats (Alt+L)' : 'Show chats (Alt+L)'"
          :aria-expanded="isExpanded(entry.directory)"
          @click.stop="toggleChats(entry)"
        >
          <ChevronRight :size="14" />
        </button>
        <!-- On the row rather than the chevron: the chevron sits against the
             window's left edge, where a badge wider than the control hangs off
             the window. -->
        <ShortcutBadge v-if="isActive(entry)" modifier="alt" key-label="L" />

        <!-- The project's own actions sit on the name line; the collapsed row's
             conversation actions sit on the conversation line below. -->
        <ProjectMenu
          :can-hide="canHide"
          :delete-disabled-reason="deleteDisabledReason(entry)"
          @hide="hide(entry)"
          @delete="askDelete(entry)"
        />

        <button class="project-hit" @click="openProject(entry.directory)">
          <span class="line">
            <Folder :size="13" class="folder" />
            <span class="name">{{ entry.name }}</span>
            <Spinner v-if="isPending(entry)" :size="11" />
            <span v-else class="time">{{ conversationTime(entry) }}</span>
          </span>
          <!-- The newest conversation is the collapsed summary; once expanded the
               full list below carries it instead. -->
          <span v-if="!isExpanded(entry.directory)" class="line conversation">
            <span
              class="state-dot"
              :class="conversationState(entry)"
              :title="conversationStateTitle(entry)"
            ></span>
            <input
              v-if="isEditing(entry.session?.id)"
              :ref="setRenameInput"
              v-model="editTitle"
              class="rename"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
            <span v-else class="chat-title">{{ conversationTitle(entry) }}</span>
          </span>
        </button>

        <div v-if="isExpanded(entry.directory)" class="chats">
          <p v-if="isChatsLoading(entry.directory)" class="chats-note"><Spinner :size="11" /> Loading chats…</p>
          <template v-else>
            <div
              v-for="chat in projectChats(entry)"
              :key="chat.id"
              class="chat"
              :class="{ current: chat.id === app.sessions.currentID.value }"
            >
              <button class="chat-hit" @click="openChat(entry, chat)">
                <span class="state-dot" :class="stateFor(chat.id)" :title="reasonFor(chat.id)"></span>
                <input
                  v-if="isEditing(chat.id)"
                  :ref="setRenameInput"
                  v-model="editTitle"
                  class="rename"
                  @click.stop
                  @keydown.enter.prevent="commitRename"
                  @keydown.esc.prevent="cancelRename"
                  @blur="commitRename"
                />
                <span v-else class="chat-title">{{ chat.title || "Untitled" }}</span>
                <span class="chat-time">{{ relativeTime(chat.time?.updated ?? chat.time?.created) }}</span>
              </button>
              <!-- Each chat carries its own actions, so the menu can never act on
                   a different conversation than the row it was opened from. -->
              <ConversationMenu
                v-if="!isEditing(chat.id)"
                @rename="startRename(chat, entry.directory)"
                @archive="archiveSession(chat.id, entry.directory)"
              />
            </div>
            <p v-if="!projectChats(entry).length" class="chats-note">No conversations yet.</p>
          </template>
        </div>

        <!-- Collapsed rows name the newest conversation inline, so that is the
             conversation the row's menu acts on. Expanded rows leave the actions
             to the chat list above. -->
        <ConversationMenu
          v-if="entry.session && !isExpanded(entry.directory) && !isEditing(entry.session.id)"
          @rename="startRename(entry.session, entry.directory)"
          @archive="archiveSession(entry.session.id, entry.directory)"
        />
      </div>

      <p v-if="!filtered.length && !loading" class="empty">
        {{ query ? `Nothing matches “${query}”.` : "No projects." }}
      </p>

      <!-- Hidden projects keep their place without taking one: the section lists
           them so a row can be brought back or deleted for good. -->
      <section v-if="hiddenEntries.length && !query" class="hidden-section">
        <button class="hidden-head" :aria-expanded="hiddenOpen" @click="hiddenOpen = !hiddenOpen">
          <ChevronRight :size="13" class="hidden-chevron" :class="{ open: hiddenOpen }" />
          <Eye :size="12" />
          <span class="hidden-label">Hidden</span>
          <span class="hidden-count">{{ hiddenEntries.length }}</span>
        </button>
        <div v-if="hiddenOpen" class="hidden-list">
          <div v-for="entry in hiddenEntries" :key="entry.directory" class="project hidden-project" :title="entry.directory">
            <ProjectMenu
              hidden
              :can-hide="canHide"
              :delete-disabled-reason="deleteDisabledReason(entry)"
              @unhide="unhide(entry)"
              @delete="askDelete(entry)"
            />
            <button class="project-hit" :title="`Unhide ${entry.name}`" @click="unhide(entry)">
              <span class="line">
                <Folder :size="13" class="folder" />
                <span class="name">{{ entry.name }}</span>
              </span>
            </button>
          </div>
        </div>
      </section>

      <p v-if="hiddenError" class="hidden-error">{{ hiddenError }}</p>
    </nav>

    <ConfirmDialog
      :open="Boolean(pendingDelete)"
      title="Delete project?"
      :message="deleteMessage"
      confirm-label="Delete"
      danger
      :busy="deleting"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </div>
</template>

<style scoped>
.projects-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.projects {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  outline: none;
}
.project {
  position: relative;
  border-radius: var(--radius-sm);
  /* Chat rows line their state dot up with the summary line's, under the name. */
  --chats-indent: 46px;
}
.project:hover {
  background: var(--bg-hover);
}
.project.active {
  background: var(--bg-active);
}
.project.kb-active {
  box-shadow: inset 0 0 0 2px var(--accent);
}
.project.cursor-active {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
}
.project-hit {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* Left padding leaves room for the absolutely positioned chevron. */
  padding: 6px 9px 6px 27px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  width: 100%;
  min-width: 0;
}
/* The disclosure control that reveals a project's other chats. */
.chevron {
  position: absolute;
  top: 5px;
  left: 4px;
  z-index: 1;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: 5px;
}
.chevron:hover {
  color: var(--text);
  background: var(--bg-active);
}
.chevron svg {
  transition: transform 0.12s ease;
}
.chevron.open svg {
  transform: rotate(90deg);
}
/* The expanded conversation list. */
.chats {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-bottom: 3px;
}
.chat {
  position: relative;
  border-radius: var(--radius-sm);
}
.chat:hover {
  background: var(--bg-active);
}
.chat-hit {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 4px 9px 4px var(--chats-indent);
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
}
/* The open conversation is marked on its title, like the search results. */
.chat.current .chat-title {
  color: var(--accent);
  font-weight: 600;
}
.chat-time {
  flex: none;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  transition: opacity 0.1s ease;
}
/* The actions button replaces the timestamp instead of covering half of it. */
.chat:hover .chat-time {
  opacity: 0;
}
.chats-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 9px 4px var(--chats-indent);
  font-size: 11.5px;
  color: var(--text-faint);
}
.line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.folder {
  flex: none;
  color: var(--text-muted);
}
.project.active .folder {
  color: var(--accent);
}
.name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.time {
  flex: none;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.conversation {
  padding-left: 19px;
}
/* Conversation state: the traffic light that the tray badge rolls up. */
.state-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9b9b9b;
}
.state-dot.blocked {
  background: var(--git-deleted);
}
.state-dot.working {
  background: var(--git-modified);
}
.state-dot.done {
  background: var(--git-added);
}
.state-dot.idle {
  background: #9b9b9b;
}
.state-dot.working {
  animation: opencode-pulse 1.4s ease-in-out infinite;
}
@keyframes opencode-pulse {
  50% {
    opacity: 0.35;
  }
}
.chat-title {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project.active .chat-title {
  color: var(--text);
}
.rename {
  flex: 1;
  min-width: 0;
  background: var(--bg-input);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 1px 5px;
  font-size: 11.5px;
  color: var(--text);
  outline: none;
}
/* The actions button sits over the row's timestamp and shows on hover; the
   trigger's own look lives in ConversationMenu. Rows scope it to themselves, so
   hovering a chat never reveals its siblings' buttons. */
.project:hover > :deep(.conversation-menu),
.chat:hover :deep(.conversation-menu) {
  opacity: 1;
}
/* A project row carries two menus: the project's own on the name line, and the
   newest conversation's on the conversation line below it. */
.project > :deep(.conversation-menu) {
  top: auto;
  bottom: 5px;
}
.project:hover > :deep(.project-menu) {
  opacity: 1;
}
/* Chat rows are shorter than the project row, so center the button on them. */
.chat :deep(.conversation-menu) {
  top: 50%;
  transform: translateY(-50%);
}
.empty {
  text-align: center;
  padding: 22px 6px;
  font-size: 12.5px;
  color: var(--text-faint);
}
/* The Hidden section folds away under the list; its rows are project rows too. */
.hidden-section {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.hidden-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.hidden-head:hover {
  background: var(--bg-hover);
  color: var(--text-muted);
}
.hidden-chevron {
  flex: none;
  transition: transform 0.12s ease;
}
.hidden-chevron.open {
  transform: rotate(90deg);
}
.hidden-label {
  flex: 1;
  min-width: 0;
  text-align: left;
}
.hidden-count {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.hidden-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hidden-project .name {
  color: var(--text-muted);
}
.hidden-error {
  margin: 6px 0 0;
  padding: 4px 8px;
  font-size: 11.5px;
  color: var(--git-deleted);
}
</style>
