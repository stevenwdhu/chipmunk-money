<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type AddMenuItem = { value: string; label: string; disabled?: boolean } | 'separator'

/**
 * "+ Add…" and its menu. What you pick is handed on once the menu has closed, so a row it adds can
 * open its editor without the menu taking the focus back (and closing it).
 */
const props = defineProps<{ items: AddMenuItem[]; label: string; disabled?: boolean; class?: string }>()
const emit = defineEmits<{ pick: [value: string] }>()

let pending: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined
function flush() {
  clearTimeout(timer)
  if (pending === null) return
  const value = pending
  pending = null
  emit('pick', value)
}
function choose(value: string) {
  pending = value
  // In case the menu closes without handing focus back.
  timer = setTimeout(flush, 400)
}
function closed(e: Event) {
  if (pending === null) return
  e.preventDefault()
  flush()
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="sm" :disabled="disabled" :class="cn('h-11 text-muted-foreground md:h-8', props.class)">
        <Plus />{{ label }}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="min-w-48" @close-auto-focus="closed">
      <template v-for="(item, i) in items" :key="i">
        <DropdownMenuSeparator v-if="item === 'separator'" />
        <DropdownMenuItem v-else :disabled="item.disabled" @select="choose(item.value)">{{ item.label }}</DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
