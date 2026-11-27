<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { ChevronRight, Eye, Folder } from "lucide-vue-next"
import ConfirmDialog from "./ConfirmDialog.vue"
import ConversationMenu from "./ConversationMenu.vue"
import ProjectMenu from "./ProjectMenu.vue"
import ProjectPicker from "./ProjectPicker.vue"
import ShortcutBadge from "./ShortcutBadge.vue"
import Spinner from "./Spinner.vue"
import Splitter from "./Splitter.vue"
import { projectDeleteAvailable } from "@/api/desktop"
import type { SessionInfo } from "@/api/types"
import { useApp } from "@/stores/app"
import { requestComposerFocus } from "@/stores/draft"
import type { ProjectEntry } from "@/stores/projects"
import { useSessionState } from "@/stores/sessionState"
import { openRequests } from "@/stores/shortcuts"
import { relativeTime } from "@/utils/format"

const app = useApp()
const { entries, hiddenEntries, current } = app.projects
const { deleteSession, renameSession, selectSession, hideProject, unhideProject, deleteProject, openChat } = app
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

/* ------------------------------- all-projects chats ------------------------------- */

/** The newest conversations of every project, newest first. */
const recent = app.recentChats.chats

/** When a conversation last changed, for the row's timestamp. */
function chatTime(chat: SessionInfo): number | undefined {
  return chat.time?.updated ?? chat.time?.created
}

/** The directory a conversation lives in, which is the project its row names. */
function directoryOf(chat: SessionInfo): string | undefined {
  return chat.location?.directory
}

/** The project a conversation's row names, falling back to its folder. */
function projectOf(chat: SessionInfo): string {
  return app.projects.displayName(directoryOf(chat))
}

/**
 * The fill a row takes when its conversation waits for a human.
 *
 * This is the Cinnamon applet's rule, applied to the list it summarises: a
 * blocked conversation (red) and a finished one nobody has read yet (green)
 * wear the state's colour as a tint over the whole row, so they are visible
 * without hunting for a 7px dot. A working or idle conversation keeps the list
 * background — the dot says all there is to say about those, and a wall of
 * tinted working rows would shout about nothing new.
 *
 * A fill that has just ended because nothing needs attention any more (the
 * conversation was opened, or its block was answered and the turn stopped)
 * keeps its colour for a moment and cools down, so the eye can follow what
 * stopped needing attention instead of seeing it vanish. A conversation that
 * goes straight back to work skips that: the orange working dot is the answer
 * then, and a red or green sweep over a running turn would say the opposite.
 */
function rowFill(sessionID: string): string | undefined {
  const state = stateFor(sessionID)
  if (state === "blocked") return "filled blocked"
  if (state === "done") return "filled done"
  const coolingFill = cooling.value[sessionID]
  if (coolingFill) return `filled ${coolingFill} cooling`
  return undefined
}

/* ------------------------------- fill cooldown ------------------------------- */

/**
 * How long a fill takes to retract once the conversation stops waiting for a
 * human. Kept in step with the `6s` sweep in the stylesheet: this is when the
 * cooling class comes off, that is how long the fill takes to get there.
 */
const COOL_MS = 6000

/** The fills that are retracting, by conversation id. */
const cooling = ref<Record<string, "blocked" | "done">>({})
const coolTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Keep a fill on screen while it fades back to the list background. */
function startCooling(sessionID: string, fill: "blocked" | "done") {
  const running = coolTimers.get(sessionID)
  if (running) clearTimeout(running)
  cooling.value = { ...cooling.value, [sessionID]: fill }
  coolTimers.set(
    sessionID,
    setTimeout(() => {
      coolTimers.delete(sessionID)
      const next = { ...cooling.value }
      delete next[sessionID]
      cooling.value = next
    }, COOL_MS),
  )
}

/** Drop a cooldown that is no longer needed, because the row filled again. */
function stopCooling(sessionID: string) {
  const running = coolTimers.get(sessionID)
  if (running) clearTimeout(running)
  coolTimers.delete(sessionID)
  if (!(sessionID in cooling.value)) return
  const next = { ...cooling.value }
  delete next[sessionID]
  cooling.value = next
}

/** The state each listed conversation had on the previous pass. */
const lastStates = new Map<string, string>()

// A row that was filled and is not any more starts its cooldown - unless the
// conversation went straight back to work. The orange working dot is the answer
// then, so the fill drops at once instead of sweeping away over the turn it is
// already reporting; a cooldown a new turn interrupts is cut short the same way.
// The list is the unfiltered one, so a row that the filter is hiding still
// cools down unseen.
watch(
  () => recent.value.map((chat) => [chat.id, stateFor(chat.id)] as const),
  (list) => {
    for (const [id, state] of list) {
      const previous = lastStates.get(id)
      lastStates.set(id, state)
      if (!previous) continue
      const wasFilled = previous === "blocked" || previous === "done"
      const isFilled = state === "blocked" || state === "done"
      if (isFilled || state === "working") stopCooling(id)
      else if (wasFilled) startCooling(id, previous)
    }
  },
)

onBeforeUnmount(() => {
  for (const timer of coolTimers.values()) clearTimeout(timer)
  coolTimers.clear()
})

/** Open a conversation from the all-projects list, switching project when needed. */
async function openRecent(chat: SessionInfo) {
  await openChat(chat)
}

/* ------------------------------- current project ------------------------------- */

/** The project row the bottom section belongs to, hidden or not. */
const activeProject = computed<ProjectEntry | null>(() => {
  const directory = current.value
  if (!directory) return null
  return (
    entries.value.find((entry) => entry.directory === directory) ??
    hiddenEntries.value.find((entry) => entry.directory === directory) ??
    null
  )
})

/** Whether the current project's conversation list is showing. */
const projectOpen = ref(true)

/* ------------------------------- split divider ------------------------------- */

/** How much of the split the all-projects list takes, as a fraction of its height. */
const SPLIT_KEY = "opencode-projects-studio.chats-split"
/** Neither half can be dragged away entirely. */
const SPLIT_MIN = 0.15
const SPLIT_MAX = 0.85

function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
}

function loadSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY)
    if (raw === null) return 0.5
    return clampSplit(Number(raw))
  } catch {
    return 0.5
  }
}

const split = ref(loadSplit())

function persistSplit() {
  try {
    localStorage.setItem(SPLIT_KEY, String(split.value))
  } catch {
    /* storage unavailable */
  }
}

/** The two sections share their height by flex-grow, so the split is a fraction. */
const splitStyle = computed(() => ({
  "--split-top": split.value,
  "--split-bottom": 1 - split.value,
}))

/** The open project's conversations, newest first (the list the server loaded). */
const projectChats = computed<SessionInfo[]>(() => {
  const directory = current.value
  if (!directory) return []
  // Events of every project arrive on the one global stream, so a row from
  // another project must not reach a list headed by this one.
  return app.sessions.sorted.value.filter((chat) => (chat.location?.directory ?? directory) === directory)
})

/** Open one of the current project's conversations. */
async function openProjectChat(chat: SessionInfo) {
  await selectSession(chat.id)
  requestComposerFocus()
}

/* ------------------------------- project actions ------------------------------- */

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

/** Keep a project out of the sidebar; the store reports a failure in `hiddenError`. */
function hide(entry: ProjectEntry) {
  void hideProject(entry)
}

/** Bring a hidden project back into the list. */
function unhide(entry: ProjectEntry) {
  void unhideProject(entry.directory)
}

/** Whether the Hidden section below the split is open. */
const hiddenOpen = ref(false)

/* ------------------------------- conversation delete ------------------------------- */

/** The conversation a delete confirmation is open for, and its project. */
const pendingChatDelete = ref<{ id: string; title: string; directory: string } | null>(null)
const deletingChat = ref(false)
const chatDeleteError = ref<string | null>(null)

function askDeleteChat(chat: SessionInfo) {
  const directory = directoryOf(chat) ?? current.value
  if (!directory) return
  chatDeleteError.value = null
  pendingChatDelete.value = { id: chat.id, title: chat.title || "Untitled", directory }
}

function cancelDeleteChat() {
  if (deletingChat.value) return
  pendingChatDelete.value = null
  chatDeleteError.value = null
}

async function confirmDeleteChat() {
  const pending = pendingChatDelete.value
  if (!pending || deletingChat.value) return
  deletingChat.value = true
  chatDeleteError.value = null
  try {
    await deleteSession(pending.id, pending.directory)
    pendingChatDelete.value = null
  } catch (cause) {
    chatDeleteError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    deletingChat.value = false
  }
}

const chatDeleteMessage = computed(() => {
  const pending = pendingChatDelete.value
  if (!pending) return ""
  return `This removes “${pending.title}” and its messages from opencode. It cannot be undone.`
})

/* ------------------------------- inline rename ------------------------------- */

/** The conversation whose title is being edited inline, and its project. */
const editing = ref<{ id: string; directory: string; title: string } | null>(null)
const editTitle = ref("")
const editInput = ref<HTMLInputElement | null>(null)

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

async function startRename(chat: SessionInfo) {
  const directory = directoryOf(chat) ?? current.value
  if (!directory) return
  editing.value = { id: chat.id, directory, title: chat.title || "" }
  editTitle.value = chat.title || ""
  await nextTick()
  editInput.value?.focus()
  editInput.value?.select()
}

async function commitRename() {
  const target = editing.value
  editing.value = null
  if (!target) return
  const title = editTitle.value.trim()
  if (!title || title === target.title) return
  // Rename against the conversation's own project, so a row that is not in the
  // open project can be renamed without switching the whole app over to it.
  await renameSession(target.id, title, target.directory)
}

function cancelRename() {
  editing.value = null
}

/* ------------------------------- list keyboard nav ------------------------------- */

const listEl = ref<HTMLElement | null>(null)
/** Index of the arrow-key cursor in the all-projects list, or -1 when inactive. */
const navIndex = ref(-1)

function scrollNavIntoView() {
  const items = listEl.value?.querySelectorAll<HTMLElement>(".chat")
  items?.[navIndex.value]?.scrollIntoView({ block: "nearest" })
}

// Alt+A jumps to the first conversation that wants a human: the topmost filled
// row of the list on screen. Opening it is what acknowledges it, so pressing the
// key again moves on to the next one.
watch(
  () => openRequests.attention,
  () => {
    const target = recent.value.find((chat) => {
      const state = stateFor(chat.id)
      return state === "blocked" || state === "done"
    })
    if (target) void openRecent(target)
  },
)

// Alt+S drops the cursor onto the open conversation's row, or the top. (Alt+P is
// the project switcher's, which the header's picker watches itself.)
watch(
  () => openRequests.sessions,
  () => {
    if (!recent.value.length) return
    const index = recent.value.findIndex((chat) => chat.id === app.sessions.currentID.value)
    navIndex.value = index >= 0 ? index : 0
    void nextTick(() => {
      listEl.value?.focus()
      scrollNavIntoView()
    })
  },
)

// Alt+L folds the current project's conversation list away and back, so the
// split leans on whichever half the reader is working in.
watch(
  () => openRequests.chats,
  () => {
    projectOpen.value = !projectOpen.value
  },
)

function endNav() {
  navIndex.value = -1
}

function move(delta: number) {
  navIndex.value = Math.min(recent.value.length - 1, Math.max(0, navIndex.value + delta))
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
      navIndex.value = recent.value.length - 1
      void nextTick(scrollNavIntoView)
      break
    case "Enter": {
      event.preventDefault()
      const chat = recent.value[navIndex.value]
      if (chat) void openRecent(chat)
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
  <div class="chats-wrap" :style="splitStyle">
    <!-- The top half: every project's newest conversations, newest first, each
         naming the project it belongs to. -->
    <section class="recent-section">
      <header class="section-head">
        <span class="section-label">
          All chats
          <ShortcutBadge placement="after" modifier="alt" key-label="A" />
        </span>
        <!-- The row leaves its right end free for the sidebar's floating search
             and new-chat buttons, which is why no count sits out there: it would
             land under them. -->
        <span v-if="app.recentChats.loading.value" class="section-note"><Spinner :size="10" /> loading…</span>
      </header>

      <div ref="listEl" class="chat-list" tabindex="-1" @keydown="onKeydown" @blur="endNav">
        <!-- A conversation whose turn just ended moves to the top of a list that
             is on screen. The group lets the rows travel to their new places
             instead of teleporting: it records every row's place before the
             patch and transitions the difference away afterwards. -->
        <TransitionGroup name="chat">
          <div
            v-for="(chat, index) in recent"
            :key="chat.id"
            class="chat recent-chat"
            :class="[
              rowFill(chat.id),
              {
                current: chat.id === app.sessions.currentID.value,
                'kb-active': index === navIndex,
              },
            ]"
          >
            <button class="chat-hit" @click="openRecent(chat)">
              <span class="state-dot" :class="stateFor(chat.id)" :title="reasonFor(chat.id)"></span>
              <span class="chat-lines">
                <span class="chat-line">
                  <span class="chat-project" :title="directoryOf(chat)">
                    <span class="chat-project-name">{{ projectOf(chat) }}</span>
                  </span>
                  <span class="chat-time">{{ relativeTime(chatTime(chat)) }}</span>
                </span>
                <span class="chat-line subject">
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
                </span>
              </span>
            </button>
            <ConversationMenu
              v-if="!isEditing(chat.id)"
              @rename="startRename(chat)"
              @delete="askDeleteChat(chat)"
            />
          </div>
        </TransitionGroup>

        <p v-if="!recent.length" class="chats-note">
          <template v-if="app.recentChats.loading.value">Loading conversations…</template>
          <template v-else>No conversations yet.</template>
        </p>
      </div>
    </section>

    <!-- The divider between the two lists: drag (or focus and use the arrows) to
         give either half more room; double-click returns to an even split. -->
    <Splitter
      v-if="projectOpen"
      v-model="split"
      orientation="horizontal"
      unit="fraction"
      :min="SPLIT_MIN"
      :max="SPLIT_MAX"
      :step="0.02"
      :reset-to="0.5"
      :scale="100"
      label="Resize the chat lists"
      @commit="persistSplit"
    />

    <!-- The bottom half: only the open project's own conversations. Its header
         names the project and is the switcher — Ctrl+R (or Alt+P) opens the
         searchable project list from here. -->
    <section class="project-section" :class="{ collapsed: !projectOpen }">
      <header class="project-head">
        <button
          class="project-toggle"
          :aria-expanded="projectOpen"
          :title="projectOpen ? 'Hide chats (Alt+L)' : 'Show chats (Alt+L)'"
          @click="projectOpen = !projectOpen"
        >
          <ChevronRight :size="13" class="project-chevron" :class="{ open: projectOpen }" />
        </button>
        <ProjectPicker />
        <span
          v-if="activeProject?.archived"
          class="archived-badge"
          title="Archived — this project's folder no longer exists"
        >archived</span>
        <span v-if="projectChats.length" class="project-count" :title="`${projectChats.length} conversations loaded`">{{ projectChats.length }}</span>
        <ShortcutBadge v-if="activeProject" modifier="alt" key-label="L" />
        <ProjectMenu
          v-if="activeProject"
          :can-hide="canHide"
          :delete-disabled-reason="deleteDisabledReason(activeProject)"
          @hide="hide(activeProject)"
          @delete="askDelete(activeProject)"
        />
      </header>

      <div v-if="projectOpen" class="chat-list">
        <TransitionGroup name="chat">
          <div
            v-for="chat in projectChats"
            :key="chat.id"
            class="chat"
            :class="{ current: chat.id === app.sessions.currentID.value }"
          >
            <button class="chat-hit" @click="openProjectChat(chat)">
              <span class="chat-line">
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
                <span class="chat-time">{{ relativeTime(chatTime(chat)) }}</span>
              </span>
            </button>
            <!-- Each chat carries its own actions, so the menu can never act on a
                 different conversation than the row it was opened from. -->
            <ConversationMenu
              v-if="!isEditing(chat.id)"
              @rename="startRename(chat)"
              @delete="askDeleteChat(chat)"
            />
          </div>
        </TransitionGroup>

        <p v-if="!projectChats.length" class="chats-note">
          {{ current ? "No conversations yet." : "No project open." }}
        </p>
      </div>
    </section>

    <!-- Hidden projects keep their place without taking one: the section lists
         them so a row can be brought back or deleted for good. -->
    <section v-if="hiddenEntries.length" class="hidden-section">
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

    <ConfirmDialog
      :open="Boolean(pendingChatDelete)"
      title="Delete conversation?"
      :message="chatDeleteMessage"
      confirm-label="Delete"
      danger
      :busy="deletingChat"
      :error="chatDeleteError"
      @confirm="confirmDeleteChat"
      @cancel="cancelDeleteChat"
    />
  </div>
</template>

<style scoped>
.chats-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* The two halves of the split share the height; each scrolls on its own, so the
   open project's chats stay in view while the all-projects list is browsed. The
   share itself is the divider's drag: the wrapper carries the two fractions as
   custom properties, which are the sections' flex-grow. */
.recent-section,
.project-section {
  flex-shrink: 1;
  flex-basis: 0;
  min-height: 72px;
  display: flex;
  flex-direction: column;
}
.recent-section {
  flex-grow: var(--split-top, 1);
}
.project-section {
  flex-grow: var(--split-bottom, 1);
}
.project-section.collapsed {
  flex: 0 0 auto;
  min-height: 0;
}
.section-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  /* One row tall, with its right end left free for the sidebar's search and
     new-chat buttons, which float over it rather than sit in a strip above it. */
  height: var(--sidebar-head-height);
  padding: 0 72px 0 12px;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.section-label {
  position: relative;
  /* Only as wide as its text, so the badge's `after` placement lands right beside
     the label instead of in the middle of the row. */
  flex: none;
  min-width: 0;
  white-space: nowrap;
}
.section-note {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-transform: none;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.chat-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 8px 8px;
  outline: none;
}
.chat {
  position: relative;
  border-radius: var(--radius-sm);
}
.chat:hover {
  background: var(--bg-hover);
}
/* A row that changes place — a conversation that just got fresher, or one that
   the removal of a neighbour pulled up — travels there instead of teleporting.
   Vue records every row's place before the patch and transitions the difference
   away afterwards (the `-move` class); the lift keeps the travelling row above
   the ones it passes, and the list's own colour hides the row it is passing, so
   the two titles never mix. */
.chat-move {
  background: var(--bg-sidebar);
  transition: transform 0.26s cubic-bezier(0.2, 0.7, 0.1, 1);
  z-index: 1;
}
.chat.kb-active {
  box-shadow: inset 0 0 0 2px var(--accent);
}
/* A row is its state dot beside its text, the dot centred on the whole row
   rather than sitting on the first line of a two-line one. */
.chat-hit {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 5px 9px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
}
/* The two-line body of an all-projects row: the project over the subject. */
.chat-lines {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.chat-line {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* The open conversation is marked by a ring around its row — the only row in the
   list with one. A fill would have to fight the red and green state tints for the
   same ground, and whichever won would hide the other; the ring sits on top of
   the tint instead, so a row can be both open and waiting for a human and say
   both things at once. It is an outline rather than a border because an outline
   paints above the row's tint layer — and above the tint's cooldown sweep — so
   the ring never disappears while the row is being read. */
.chat.current {
  outline: 2px solid var(--row-active-ring);
  outline-offset: -2px;
}
/* A conversation that waits for a human tints its row with the state's colour —
   green for a finish nobody has read, red for a blocked turn. It used to be a
   solid fill in the Cinnamon applet's tile colours, which made one blocked row
   shout louder than the whole list around it; the tint keeps the state findable
   at a glance while leaving the text in the theme's own ink instead of dark on
   colour. The colour is the applet's dark-theme value on both themes, so the
   tint reads the same way in either. */
.chat.filled {
  --fill: #3fb950;
}
.chat.filled.blocked {
  --fill: #f85149;
}
/* The tint is its own layer behind the row's text, because the cooldown retracts
   that layer while the text stays where it is. */
.chat.filled::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--fill) 18%, transparent);
  clip-path: inset(0 0 0 0);
  pointer-events: none;
}
/* The row's content sits above the tint layer, and the actions button above the
   hit area, or the tint would swallow it. */
.chat.filled .chat-hit {
  position: relative;
  z-index: 1;
}
.chat.filled :deep(.conversation-menu) {
  z-index: 2;
}
/* The keyboard cursor's ring goes on the tint layer, which sits above the row's
   own background, so the tint cannot wash it out. */
.chat.filled.kb-active::before {
  box-shadow: inset 0 0 0 2px var(--accent);
}
/* The cooldown: a tint that has just ended — the conversation was opened, or its
   block was answered and the turn stopped — shrinks away to the right over six
   seconds. A conversation that goes back to work skips it, so the sweep never
   plays over a running turn. A sweep instead of a fade, because a fading colour
   passes through muddy mixes on the way out; this one just gets narrower until
   the row is its old self again. */
.chat.filled.cooling::before {
  clip-path: inset(0 0 0 100%);
  transition: clip-path 6s linear;
}
.chat-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-time {
  flex: none;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  transition: margin-right 0.12s ease;
}
/* The actions button appears over the timestamp's corner on hover, so the time
   steps aside instead of being hidden: it stays readable while the row is under
   the pointer. */
.chat:hover .chat-time {
  margin-right: 20px;
}
/* A row of the all-projects list is two lines: the project the chat belongs to
   on top, the chat's own subject under it, both at the subject's size. The dot
   sits outside the pair, so the two lines share a left edge on their own. */
.chat-project {
  display: flex;
  align-items: center;
  min-width: 0;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chats-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 9px;
  font-size: 11.5px;
  color: var(--text-faint);
}
/* The bottom half's own header: the project switcher, and the actions on the
   open project. It sits above the list so the switcher's key badge can hang
   past the row. */
.project-head {
  position: relative;
  z-index: 1;
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 0;
}
.project-toggle {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 4px 5px 9px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
}
.project-toggle:hover {
  background: var(--bg-hover);
}
.project-chevron {
  flex: none;
  color: var(--text-faint);
  transition: transform 0.12s ease;
}
.project-chevron.open {
  transform: rotate(90deg);
}
.folder {
  flex: none;
  color: var(--text-muted);
}
/* The project's loaded conversation tally, between the name and the menu. */
.project-count {
  flex: none;
  min-width: 16px;
  padding: 0 5px;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  color: var(--text-faint);
  background: var(--bg-active);
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  transition: opacity 0.1s ease;
}
/* The actions button takes the tally's place instead of covering it. */
.project-head:hover .project-count {
  opacity: 0;
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
.rename {
  flex: 1;
  min-width: 0;
  background: var(--bg-input);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 1px 5px;
  font-size: 12px;
  color: var(--text);
  outline: none;
}
/* The actions button sits over the row's timestamp and shows on hover; the
   trigger's own look lives in ConversationMenu. Rows scope it to themselves, so
   hovering a chat never reveals its siblings' buttons. */
.chat:hover :deep(.conversation-menu) {
  opacity: 1;
}
.project-head:hover > :deep(.project-menu) {
  opacity: 1;
}
/* Chat rows are shorter than a header, so center the button on them. */
.chat :deep(.conversation-menu) {
  top: 50%;
  transform: translateY(-50%);
}
/* An archived project's folder is gone: past conversations stay readable, but
   the row reads as inactive. */
.archived-badge {
  flex: none;
  padding: 0 5px;
  font-size: 9.5px;
  line-height: 14px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  background: var(--bg-active);
  border-radius: 7px;
}
/* The Hidden section folds away under the split; its rows are project rows. */
.hidden-section {
  flex: none;
  max-height: 40%;
  overflow-y: auto;
  padding: 6px 8px;
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
.project {
  position: relative;
  border-radius: var(--radius-sm);
}
.project:hover {
  background: var(--bg-hover);
}
.project-hit {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 9px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  width: 100%;
  min-width: 0;
}
.line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.hidden-project .name {
  color: var(--text-muted);
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
.hidden-error {
  flex: none;
  margin: 0;
  padding: 4px 8px 8px;
  font-size: 11.5px;
  color: var(--git-deleted);
}
</style>
