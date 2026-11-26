<script setup lang="ts">
import { computed } from "vue"
import { MessageSquarePlus, Search } from "lucide-vue-next"
import ShortcutBadge from "./ShortcutBadge.vue"
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
      <!-- The lists own the top of the sidebar: search and new chat float over
           its corner instead of owning a header band of their own, and the band
           is gone so nothing is spent on a strip that holds only a logo. -->
      <div class="grip drag-region" aria-hidden="true"></div>
      <div class="actions">
        <button class="icon" title="Search conversations (Alt+F)" @click="openSearch()">
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
      </div>

      <p v-if="notice" class="notice" title="Dismiss" @click="clearNotice()">{{ notice }}</p>

      <ChatsPanel />
    </template>
  </aside>
</template>

<style scoped>
.sidebar {
  /* A containing block for the actions, which float over the lists' top corner
     and must stay above what they cover. */
  position: relative;
  width: var(--sidebar-width);
  flex: none;
  height: 100%;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
/* The window grip the removed header band used to give. The row it covers is the
   chat lists' label, which nothing interacts with, so the grip costs no height;
   it stops below them rather than reaching into the first row. */
.grip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--sidebar-head-height);
  z-index: 1;
}
/* The actions sit on the label row the lists already carry rather than in a strip
   of their own, so the top of the sidebar holds content and not a band. */
.actions {
  position: absolute;
  top: 0;
  right: 6px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--sidebar-head-height);
}
.icon {
  /* A containing block for its key badge, or the badge anchors to the strip and
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
/* The sidebar's one line of feedback — a project that would not open, or a
   folder the app could not add — sits clear of the actions floating above it,
   until it is dismissed. */
.notice {
  flex: none;
  margin: calc(var(--sidebar-head-height) + 2px) 8px 6px;
  padding: 5px 8px;
  font-size: 11.5px;
  color: var(--git-deleted);
  background: color-mix(in srgb, var(--git-deleted) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--git-deleted) 30%, transparent);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
</style>
