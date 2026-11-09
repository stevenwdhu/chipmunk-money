<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { RouterLink } from 'vue-router'
import { ChevronLeft, Ellipsis } from '@lucide/vue'
import LedgerSwitcher from '@/components/ledger/LedgerSwitcher.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLedgers } from '@/composables/queries'
import { navLink, secondaryNav } from '@/lib/nav'

/**
 * A page's header. On a phone its ⋯ menu also holds Activity and the settings (the sidebar has them
 * on wider screens). A page's own actions go in the `menu` slot, so there's one ⋯ menu, not two.
 */
withDefaults(defineProps<{ title: string; back?: RouteLocationRaw; subtitle?: string; ledger?: boolean; menuLabel?: string }>(), {
  ledger: true,
  menuLabel: 'More',
})
const { current } = useLedgers()
</script>

<template>
  <header
    class="sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b bg-background/95 px-4 pt-safe backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6"
  >
    <!-- The ledger's colour, so it's always clear which books you're in. -->
    <span
      v-if="ledger && current"
      class="pointer-events-none absolute inset-x-0 top-0 h-0.5"
      :style="{ background: current.color }"
      aria-hidden="true"
    />
    <Button v-if="back" as-child variant="ghost" size="icon-sm" class="-ml-2">
      <RouterLink :to="back" aria-label="Back"><ChevronLeft /></RouterLink>
    </Button>
    <div v-else-if="ledger" class="md:hidden"><LedgerSwitcher variant="compact" /></div>
    <div class="min-w-0">
      <!-- A page can put more in its title (a switcher, a badge), with its own h1. -->
      <slot name="title"><h1 class="truncate text-base font-semibold md:text-lg">{{ title }}</h1></slot>
      <p v-if="subtitle" class="truncate text-xs text-muted-foreground">{{ subtitle }}</p>
    </div>
    <div class="ml-auto flex items-center gap-1">
      <slot name="actions" />
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <!-- Without a page menu, only phones need it. -->
          <Button variant="ghost" size="icon-sm" :class="!$slots.menu && 'md:hidden'" :aria-label="menuLabel">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52">
          <template v-if="$slots.menu">
            <slot name="menu" />
            <DropdownMenuSeparator class="md:hidden" />
          </template>
          <DropdownMenuItem v-for="item in secondaryNav" :key="item.name" as-child class="md:hidden">
            <RouterLink :to="navLink(item)"><component :is="item.icon" />{{ item.label }}</RouterLink>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>
</template>
