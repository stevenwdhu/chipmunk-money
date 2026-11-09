<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { X } from '@lucide/vue'
import type { FilteredOut, FilterNames, FilterSide, ReportFilter } from '@st/shared'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useUiStore } from '@/stores/ui'
import FilterBuilder from './FilterBuilder.vue'

type At = { side: FilterSide; kind: 'only' | 'rule' | 'picked' | 'keep'; index: number }

/**
 * Building a report's filter. On a computer it's a panel over the page's right side, like the
 * transaction editor, under which the report stays in sight and follows each edit. On a phone it's a
 * drawer. Edits apply as you make them (`change`), so Done just closes it.
 */
const props = defineProps<{
  open: boolean
  filter: ReportFilter
  names: FilterNames
  filteredOut: { spending: FilteredOut; income: FilteredOut } | null
  /** Which chip opened it: the panel shows that side's tab and scrolls to that row. */
  at?: At | null
  /** For "Pick purchases" (the biggest counted purchases in this range) and the footer. */
  range: { from: string; to: string }
  apiFilter?: string
  counted: { spendingMinor: number; incomeMinor: number }
}>()
const emit = defineEmits<{ 'update:open': [boolean]; change: [ReportFilter] }>()

const isDesktop = useIsDesktop()
const ui = useUiStore()
const close = () => emit('update:open', false)

// The keyboard goes on in the panel (its tabs), not behind the veil, and closing it gives the focus back
// to what opened it (the Filters button or a chip).
const aside = useTemplateRef<HTMLElement>('aside')
let opener: HTMLElement | null = null
watch(
  () => props.open && isDesktop.value,
  async (shown) => {
    if (!shown) {
      if (!props.open && opener?.isConnected) opener.focus({ preventScroll: true })
      opener = null
      return
    }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    aside.value?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus({ preventScroll: true })
  },
)

// Escape closes the panel, unless a dialog, popover, menu or the editor over it takes the key (looked
// at before they handle it and close, hence the capture).
useEventListener(
  document,
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !props.open || !isDesktop.value || ui.editorOpen) return
    if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"], [role="listbox"]')) return
    close()
  },
  { capture: true },
)
</script>

<template>
  <template v-if="isDesktop">
    <!-- A faint veil over the rest: clicking it closes the panel. -->
    <div
      aria-hidden="true"
      :class="[
        'fixed inset-0 z-35 bg-background/40 transition-opacity duration-200 ease-out',
        open ? 'opacity-100' : 'pointer-events-none opacity-0',
      ]"
      @click="close"
    />
    <aside
      ref="aside"
      aria-label="Filters"
      :inert="!open"
      :class="[
        'fixed inset-y-0 right-0 z-36 flex w-full flex-col border-l bg-background shadow-xl transition-transform duration-200 ease-out sm:max-w-sm',
        open ? 'translate-x-0' : 'translate-x-full',
      ]"
    >
      <header class="flex items-center gap-3 px-5 pt-4 pb-3">
        <h2 class="min-w-0 flex-1 text-lg leading-none font-semibold">Filters</h2>
        <Button variant="ghost" size="icon-sm" class="-mr-2" aria-label="Close" @click="close"><X /></Button>
      </header>
      <FilterBuilder
        v-if="open"
        :filter="filter"
        :names="names"
        :filtered-out="filteredOut"
        :at="at"
        :range="range"
        :api-filter="apiFilter"
        :counted="counted"
        @change="(f) => emit('change', f)"
        @done="close"
      />
    </aside>
  </template>

  <Drawer v-else :open="open" @update:open="(v) => emit('update:open', v)">
    <DrawerContent class="data-[swipe-direction=down]:max-h-[92svh]">
      <DrawerHeader class="pb-3 text-left">
        <DrawerTitle>Filters</DrawerTitle>
        <DrawerDescription class="sr-only">What this report counts and filters out, for spending and for income</DrawerDescription>
      </DrawerHeader>
      <FilterBuilder
        :filter="filter"
        :names="names"
        :filtered-out="filteredOut"
        :at="at"
        :range="range"
        :api-filter="apiFilter"
        :counted="counted"
        @change="(f) => emit('change', f)"
        @done="close"
      />
    </DrawerContent>
  </Drawer>
</template>
