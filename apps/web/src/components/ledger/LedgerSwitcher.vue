<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Check, ChevronsUpDown, Plus, Settings2 } from '@lucide/vue'
import type { Ledger } from '@chipmunk/shared'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAccounts, useLedgers } from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { FROM_ANOTHER_LEDGER } from '@/lib/ledger'
import { cn } from '@/lib/utils'
import LedgerMark from './LedgerMark.vue'
import NewLedgerDialog from './NewLedgerDialog.vue'

const props = withDefaults(defineProps<{ variant?: 'sidebar' | 'compact' }>(), { variant: 'sidebar' })
const route = useRoute()
const router = useRouter()
const { active, current } = useLedgers()
const accounts = useAccounts()
const newOpen = ref(false)
const isDesktop = useIsDesktop()

/**
 * Same page in the other ledger, except pages tied to one record (an account) go to its list. An
 * account shared with the other ledger is the same record there, so its page stays.
 */
function switchTo(ledger: Ledger) {
  if (ledger.slug === current.value?.slug) return
  const account = route.name === 'account' ? accounts.byId.value.get(Number(route.params.id)) : undefined
  const there = !!account?.sharing?.ledgers.some((l) => l.slug === ledger.slug)
  const name = route.name === 'account' && !there ? 'accounts' : route.params.ledger ? (route.name as string) : 'overview'
  const query = name === route.name ? Object.fromEntries(Object.entries(route.query).filter(([k]) => !FROM_ANOTHER_LEDGER.includes(k))) : undefined
  router.push({ name, params: there ? { ledger: ledger.slug, id: route.params.id } : { ledger: ledger.slug }, query })
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :class="
          cn(
            'flex min-w-0 items-center gap-2 rounded-md text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
            props.variant === 'sidebar' ? 'w-full px-2 py-1.5' : '-ml-1 p-1',
          )
        "
        :aria-label="`Ledger: ${current?.name ?? '…'}. Switch ledger`"
        :title="props.variant === 'compact' ? current?.name : undefined"
      >
        <LedgerMark :ledger="current" :size="props.variant === 'sidebar' ? 'md' : 'sm'" />
        <template v-if="props.variant === 'sidebar'">
          <span class="min-w-0 flex-1">
            <span class="block text-[11px] leading-tight text-muted-foreground">Chipmunk</span>
            <span class="block truncate text-sm leading-tight font-semibold">{{ current?.name ?? '…' }}</span>
          </span>
          <ChevronsUpDown class="size-4 shrink-0 text-muted-foreground" />
        </template>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-60">
      <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Ledgers</DropdownMenuLabel>
      <DropdownMenuItem v-for="l in active" :key="l.id" @select="switchTo(l)">
        <LedgerMark :ledger="l" size="sm" />
        <span class="min-w-0 flex-1 truncate">{{ l.name }}</span>
        <Check v-if="l.slug === current?.slug" class="size-4" />
      </DropdownMenuItem>
      <!-- Adding and managing ledgers is for a computer. -->
      <template v-if="isDesktop">
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="newOpen = true"><Plus />New ledger…</DropdownMenuItem>
        <DropdownMenuItem as-child>
          <RouterLink :to="{ name: 'app-settings', query: { tab: 'ledgers' } }"><Settings2 />Manage ledgers</RouterLink>
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
  <NewLedgerDialog v-model:open="newOpen" />
</template>
