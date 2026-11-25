<script setup lang="ts">
import { computed } from "vue"
import { MessageSquarePlus, Search } from "lucide-vue-next"
import ShortcutBadge from "./ShortcutBadge.vue"
import iconUrl from "../../build/icon.png"
import ChatsPanel from "./ChatsPanel.vue"
import SidebarSearch from "./SidebarSearch.vue"
import { useApp } from "@/stores/app"
import { clearNotice, notice } from "@/stores/notice"
import { openSearch, searchOpen } from "@/stores/search"

const app = useApp()
const { newChat } = app

/** Whether the open project is archived — its folder is gone, so no new chat. */
const archivedActive = computed(() => app.projects.isArchived(app.server.directory.value))
</script>

<template>
  <aside class="sidebar">
    <SidebarSearch v-if="searchOpen" />
    <template v-else>
      <header class="head drag-region">
        <img class="logo" :src="iconUrl" alt="" />
        <button class="icon search" title="Search conversations (Alt+F)" @click="openSearch()">
          <Search :size="16" />
          <ShortcutBadge placement="inside" modifier="alt" key-label="F" />
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

      <p v-if="notice" class="notice" title="Dismiss" @click="clearNotice()">{{ notice }}</p>

      <ChatsPanel />
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
  padding: 0 8px 0 10px;
}
.logo {
  /* The app icon itself — the same file the window and the tray use — so the
     header carries no second drawing of the logo to keep in step. */
  flex: none;
  width: 26px;
  height: 26px;
  display: block;
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
/* The project switcher moved to the bottom half's header, so the actions keep to
   the right of the strip and the logo stays on the left. */
.icon.search {
  margin-left: auto;
}
.icon:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.icon:disabled {
  opacity: 0.5;
}
/* The sidebar's one line of feedback — a project that would not open, or a
   folder the app could not add — stays under the header until it is dismissed. */
.notice {
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
