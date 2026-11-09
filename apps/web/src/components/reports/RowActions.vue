<script setup lang="ts">
import { Ellipsis, EyeOff, Filter, List } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useIsDesktop } from '@/composables/useBreakpoint'

/**
 * A report row you can filter by. On a computer a click shows its transactions and ⋯ has the rest. On
 * a phone the whole row opens the menu.
 */
defineProps<{ label: string }>()
const emit = defineEmits<{ show: []; only: []; filterOut: [] }>()
const isDesktop = useIsDesktop()
</script>

<template>
  <div v-if="isDesktop" class="flex items-center gap-1">
    <button type="button" class="min-w-0 flex-1 rounded-md text-left transition-colors hover:bg-muted/50" @click="emit('show')">
      <slot />
    </button>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground" :aria-label="`More for ${label}`"><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-48">
        <DropdownMenuItem @select="emit('show')"><List />Show transactions</DropdownMenuItem>
        <DropdownMenuItem @select="emit('only')"><Filter />Only this</DropdownMenuItem>
        <DropdownMenuItem @select="emit('filterOut')"><EyeOff />Filter out this</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
  <DropdownMenu v-else>
    <DropdownMenuTrigger as-child>
      <button type="button" class="flex min-h-11 w-full items-center rounded-md text-left active:bg-muted/50">
        <span class="min-w-0 flex-1"><slot /></span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-56">
      <DropdownMenuLabel class="truncate text-xs font-normal text-muted-foreground">{{ label }}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem class="min-h-11" @select="emit('show')"><List />Show transactions</DropdownMenuItem>
      <DropdownMenuItem class="min-h-11" @select="emit('only')"><Filter />Only this</DropdownMenuItem>
      <DropdownMenuItem class="min-h-11" @select="emit('filterOut')"><EyeOff />Filter out this</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
