<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ChevronDown, ChevronLeft } from '@lucide/vue'
import { REPORT_PRESETS, resolveRange, type ReportRange, type ResolvedRange } from '@st/shared'
import SegmentedToggle from '@/components/SegmentedToggle.vue'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useToday } from '@/composables/useToday'
import { cn } from '@/lib/utils'
import MonthRangeGrid from './MonthRangeGrid.vue'

/**
 * A report's months. On a computer 3M to 2Y are one tap away and More has This year, Last year and
 * Custom. On a phone it's a button that opens all of them in a drawer.
 */
defineProps<{ resolved: ResolvedRange }>()
const model = defineModel<ReportRange>({ required: true })
const isDesktop = useIsDesktop()
const today = useToday()

const ONE_TAP: ReadonlyArray<{ value: ReportRange; label: string }> = [
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '12m', label: '1Y' },
  { value: '24m', label: '2Y' },
]
const MORE: ReportRange[] = ['ytd', 'last-year']
const inMore = computed(() => !ONE_TAP.some((o) => o.value === model.value))
const label = (r: ReportRange) => resolveRange(r, today.value).label
const fixed = computed(() => !(REPORT_PRESETS as readonly string[]).includes(model.value))

const open = ref(false)
const custom = ref(false)
watch(open, (v) => v && (custom.value = false))

function choose(r: ReportRange) {
  model.value = r
  open.value = false
}
</script>

<template>
  <div v-if="isDesktop" class="flex items-center rounded-md bg-muted p-0.5">
    <SegmentedToggle v-model="model" :options="ONE_TAP" label="Range" class="bg-transparent p-0" />
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          :class="cn('flex items-center gap-1 rounded px-2 py-1 text-xs whitespace-nowrap', inMore ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')"
        >
          {{ inMore ? resolved.label : 'More' }}<ChevronDown class="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent class="w-64 p-2" align="end">
        <MonthRangeGrid v-if="custom" :start="resolved.start" :end="resolved.end" class="p-1" @pick="choose" />
        <div v-else class="grid">
          <button v-for="r in MORE" :key="r" type="button" class="flex items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" @click="choose(r)">
            <span class="flex-1">{{ label(r) }}</span><Check v-if="model === r" class="size-4" />
          </button>
          <button type="button" class="flex items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" @click="custom = true">
            <span class="flex-1">Custom…</span><Check v-if="fixed" class="size-4" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  </div>

  <template v-else>
    <Button variant="outline" class="w-full min-w-0 justify-between" @click="open = true">
      <span class="truncate">{{ resolved.label }}</span>
      <ChevronDown class="text-muted-foreground" />
    </Button>
    <Drawer v-model:open="open">
      <DrawerContent class="data-[swipe-direction=down]:max-h-[92svh]">
        <DrawerHeader class="flex-row items-center gap-2 pb-1 text-left">
          <Button v-if="custom" variant="ghost" size="icon-sm" class="-ml-2" aria-label="Back to ranges" @click="custom = false"><ChevronLeft /></Button>
          <DrawerTitle>{{ custom ? 'Custom range' : 'Range' }}</DrawerTitle>
          <DrawerDescription class="sr-only">The months this report covers</DrawerDescription>
        </DrawerHeader>
        <div class="overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <MonthRangeGrid v-if="custom" :start="resolved.start" :end="resolved.end" @pick="choose" />
          <ul v-else class="-mx-2 text-sm">
            <li v-for="r in REPORT_PRESETS" :key="r">
              <button type="button" class="flex min-h-11 w-full items-center rounded-md px-2 text-left active:bg-muted" @click="choose(r)">
                <span class="flex-1">{{ label(r) }}</span><Check v-if="model === r" class="size-4" />
              </button>
            </li>
            <li>
              <button type="button" class="flex min-h-11 w-full items-center rounded-md px-2 text-left active:bg-muted" @click="custom = true">
                <span class="flex-1">Custom…</span>
                <span v-if="fixed" class="mr-2 text-xs text-muted-foreground">{{ resolved.label }}</span>
                <Check v-if="fixed" class="size-4" />
              </button>
            </li>
          </ul>
        </div>
      </DrawerContent>
    </Drawer>
  </template>
</template>
