<script setup lang="ts">
import { ref } from 'vue'
import { AlertTriangle, Check, ChevronDown, Plus } from '@lucide/vue'
import { filterCount, rangeOf, resolveRange, type CustomReport } from '@chipmunk/shared'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useToday } from '@/composables/useToday'
import { cn } from '@/lib/utils'

/** The Reports page's title: the report open (or Everything), and a list to open another or start one. */
defineProps<{ name: string; currentId: number | null; reports: CustomReport[] }>()
const emit = defineEmits<{ open: [id: number | null]; new: [] }>()
const isDesktop = useIsDesktop()
const today = useToday()
const drawer = ref(false)

/** "3 filters · Last 12 months" */
function about(r: CustomReport) {
  const n = filterCount(r.spec.filter)
  const range = r.spec.range ? resolveRange(rangeOf(r.spec), today.value).label : 'Any range'
  return `${n ? `${n} filter${n === 1 ? '' : 's'}` : 'No filter'} · ${range}`
}

function choose(id: number | null) {
  drawer.value = false
  emit('open', id)
}

function startNew() {
  drawer.value = false
  emit('new')
}

// The -mx-1 bleed lets the padding sit outside the title, so the button may be 0.5rem wider than the h1.
const triggerClass =
  '-mx-1 flex max-w-[calc(100%+0.5rem)] min-w-0 items-center gap-1 rounded-md px-1 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
</script>

<template>
  <h1 class="min-w-0 text-base font-semibold md:text-lg">
    <DropdownMenu v-if="isDesktop">
      <DropdownMenuTrigger as-child>
        <button type="button" :class="triggerClass" :aria-label="`${name}. Open another report`">
          <span class="truncate">{{ name }}</span><ChevronDown class="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-72">
        <DropdownMenuItem @select="choose(null)">
          <span class="min-w-0 flex-1 truncate">Everything</span>
          <Check v-if="currentId === null" class="size-4" />
        </DropdownMenuItem>
        <DropdownMenuItem v-for="r in reports" :key="r.id" class="items-start" @select="choose(r.id)">
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate">{{ r.name }}</span>
              <AlertTriangle v-if="r.missing.length" class="size-3.5 text-amber-600" aria-label="Uses something that no longer exists" />
            </span>
            <span class="block truncate text-xs text-muted-foreground">{{ about(r) }}</span>
          </span>
          <Check v-if="currentId === r.id" class="mt-0.5 size-4" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="startNew"><Plus />New custom report</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <template v-else>
      <button
        type="button"
        :class="cn(triggerClass, 'relative after:absolute after:inset-x-0 after:-inset-y-2.5')"
        :aria-label="`${name}. Open another report`"
        @click="drawer = true"
      >
        <span class="truncate">{{ name }}</span><ChevronDown class="size-4 shrink-0 text-muted-foreground" />
      </button>
      <Drawer v-model:open="drawer">
        <DrawerContent class="data-[swipe-direction=down]:max-h-[92svh]">
          <DrawerHeader class="pb-1 text-left">
            <DrawerTitle>Reports</DrawerTitle>
            <DrawerDescription class="sr-only">Open a report or start a new one</DrawerDescription>
          </DrawerHeader>
          <ul class="overflow-y-auto px-2 pb-[calc(1rem+env(safe-area-inset-bottom))] text-sm font-normal">
            <li>
              <button type="button" class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left active:bg-muted" @click="choose(null)">
                <span class="flex-1">Everything</span>
                <Check v-if="currentId === null" class="size-4" />
              </button>
            </li>
            <li v-for="r in reports" :key="r.id">
              <button
                type="button"
                :class="cn('flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left active:bg-muted', currentId === r.id && 'font-medium')"
                @click="choose(r.id)"
              >
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate">{{ r.name }}</span>
                    <AlertTriangle v-if="r.missing.length" class="size-3.5 shrink-0 text-amber-600" aria-label="Uses something that no longer exists" />
                  </span>
                  <span class="block truncate text-xs font-normal text-muted-foreground">{{ about(r) }}</span>
                </span>
                <Check v-if="currentId === r.id" class="size-4 shrink-0" />
              </button>
            </li>
            <li class="mt-1 border-t pt-1">
              <button type="button" class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left active:bg-muted" @click="startNew">
                <Plus class="size-4 text-muted-foreground" />New custom report
              </button>
            </li>
          </ul>
        </DrawerContent>
      </Drawer>
    </template>
  </h1>
</template>
