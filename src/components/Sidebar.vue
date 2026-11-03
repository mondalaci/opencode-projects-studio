<script setup lang="ts">
import { computed, ref } from "vue"
import { FolderPlus, MessageSquarePlus, Search } from "lucide-vue-next"
import ShortcutBadge from "./ShortcutBadge.vue"
import iconUrl from "../../build/icon.png"
import ProjectsPanel from "./ProjectsPanel.vue"
import SidebarSearch from "./SidebarSearch.vue"
import { useApp } from "@/stores/app"
import { openSearch, searchOpen } from "@/stores/search"

const app = useApp()
const { newChat } = app

/** How many projects the list holds; shown next to the header label. */
const projectCount = computed(() => app.projects.entries.value.length)

/** Whether the open project is archived — its folder is gone, so no new chat. */
const archivedActive = computed(() => app.projects.isArchived(app.server.directory.value))

/** Whether an "Add project" pick is running, so the button cannot be double-fired. */
const addingProject = ref(false)
/** Why adding a project failed, shown under the header until dismissed. */
const addError = ref<string | null>(null)

/** Pick a directory and register it as a project, then open it. */
async function addProject() {
  if (addingProject.value) return
  addingProject.value = true
  addError.value = null
  try {
    const result = await app.addProject()
    // A cancelled picker reports no error: there is nothing to say about it.
    if (!result.ok && result.error) addError.value = result.error
  } catch (cause) {
    addError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    addingProject.value = false
  }
}

</script>

<template>
  <aside class="sidebar">
    <SidebarSearch v-if="searchOpen" />
    <template v-else>
      <header class="head drag-region">
        <img class="logo" :src="iconUrl" alt="" />
        <span class="brand">Projects<ShortcutBadge placement="below" modifier="ctrl" key-label="R" /></span>
        <span class="brand-count" :title="`${projectCount} projects`">{{ projectCount }}</span>
        <button class="icon" title="Search conversations (Alt+F)" @click="openSearch()">
          <Search :size="16" />
          <ShortcutBadge placement="inside" modifier="alt" key-label="F" />
        </button>
        <button class="icon" title="Add project directory…" :disabled="addingProject" @click="addProject()">
          <FolderPlus :size="16" />
        </button>
        <button
          class="icon"
          :disabled="archivedActive"
          :title="archivedActive ? 'Archived project — its folder no longer exists' : 'New chat (Alt+N)'"
          @click="newChat()"
        >
          <MessageSquarePlus :size="17" />
          <ShortcutBadge placement="inside" modifier="alt" key-label="N" />
        </button>
      </header>

      <p v-if="addError" class="add-error" title="Dismiss" @click="addError = null">{{ addError }}</p>

      <ProjectsPanel />
    </template>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex: none;
  height: 100%;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.head {
  /* A containing block for the key badges on the header's buttons, and a layer
     above the list below so a badge hanging past the header stays visible. */
  position: relative;
  z-index: 1;
  /* Matches the conversation header height so the top strip is one band. */
  flex: none;
  height: var(--header-height);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
}
.logo {
  /* The app icon itself — the same file the window and the tray use — so the
     header carries no second drawing of the logo to keep in step. */
  flex: none;
  width: 26px;
  height: 26px;
  display: block;
}
.brand {
  position: relative;
  flex: none;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
/* The list's count, in place of the subheader row it used to live in. */
.brand-count {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.icon {
  /* A containing block for its key badge, or the badge anchors to the header and
     lands on top of its neighbour's. */
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 6px;
  border-radius: var(--radius-sm);
}
.icon:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.icon:disabled {
  opacity: 0.5;
}
/* The "Add project" failure stays under the header until it is dismissed. */
.add-error {
  flex: none;
  margin: 0 8px 6px;
  padding: 5px 8px;
  font-size: 11.5px;
  color: var(--git-deleted);
  background: color-mix(in srgb, var(--git-deleted) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--git-deleted) 30%, transparent);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
</style>
