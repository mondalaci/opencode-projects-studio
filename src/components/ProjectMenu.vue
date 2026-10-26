<script setup lang="ts">
import { Eye, EyeOff, MoreHorizontal, Trash2 } from "lucide-vue-next"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui"

/**
 * The hover actions of one project row.
 *
 * The trigger is placed by the parent, so the same menu serves a project in the
 * sidebar and one in the Hidden section below it. `hidden` decides whether the
 * entry hides the project or brings it back; `canHide` is false in a browser,
 * and `deleteDisabledReason` is set when the project may not be deleted at all
 * (a browser, or opencode's own placeholder project).
 */
defineProps<{ hidden?: boolean; canHide?: boolean; deleteDisabledReason?: string }>()
defineEmits<{ hide: []; unhide: []; delete: [] }>()
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <span class="project-menu" title="Project actions" @click.stop>
        <MoreHorizontal :size="14" />
      </span>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="opencode-menu" :side-offset="4" align="end">
        <DropdownMenuItem
          v-if="hidden"
          class="opencode-menu-item"
          :disabled="!canHide"
          :title="canHide ? undefined : 'Hiding projects needs the desktop app'"
          @select="canHide && $emit('unhide')"
        >
          <Eye :size="14" /> Unhide project
        </DropdownMenuItem>
        <DropdownMenuItem
          v-else
          class="opencode-menu-item"
          :disabled="!canHide"
          :title="canHide ? undefined : 'Hiding projects needs the desktop app'"
          @select="canHide && $emit('hide')"
        >
          <EyeOff :size="14" /> Hide project
        </DropdownMenuItem>
        <DropdownMenuSeparator class="opencode-menu-sep" />
        <DropdownMenuItem
          class="opencode-menu-item danger"
          :disabled="Boolean(deleteDisabledReason)"
          :title="deleteDisabledReason"
          @select="!deleteDisabledReason && $emit('delete')"
        >
          <Trash2 :size="14" /> Delete project…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style scoped>
/* The actions button sits over the row's name line and shows on hover. */
.project-menu {
  position: absolute;
  top: 5px;
  right: 6px;
  z-index: 1;
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
.project-menu:hover {
  color: var(--text);
}
/* Keep the button visible while its menu is open, even if the pointer left. */
.project-menu[data-state="open"] {
  opacity: 1;
  color: var(--text);
}
</style>
