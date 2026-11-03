<script setup lang="ts">
import { MoreHorizontal, Pencil, Trash2 } from "lucide-vue-next"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui"

/**
 * The hover actions of a single conversation row.
 *
 * The trigger is placed by the parent: the project row pins it to the top-right
 * corner, a chat row centers it vertically. Both callers pass the conversation
 * the menu acts on, so a row can only ever delete the chat it belongs to.
 */
defineEmits<{ rename: []; delete: [] }>()
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <span class="conversation-menu" title="Conversation actions" @click.stop>
        <MoreHorizontal :size="14" />
      </span>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="opencode-menu" :side-offset="4" align="end">
        <DropdownMenuItem class="opencode-menu-item" @select="$emit('rename')">
          <Pencil :size="14" /> Rename conversation
        </DropdownMenuItem>
        <DropdownMenuSeparator class="opencode-menu-sep" />
        <DropdownMenuItem class="opencode-menu-item danger" @select="$emit('delete')">
          <Trash2 :size="14" /> Delete conversation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style scoped>
/* The actions button sits over the row's timestamp and shows on hover. */
.conversation-menu {
  position: absolute;
  top: 5px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--text-muted);
  background: var(--bg-active);
  opacity: 0;
}
.conversation-menu:hover {
  color: var(--text);
}
/* Keep the button visible while its menu is open, even if the pointer left. */
.conversation-menu[data-state="open"] {
  opacity: 1;
  color: var(--text);
}
</style>
