<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft } from '@lucide/vue'
import type { FilterSide, Transaction } from '@st/shared'
import InfoTip from '@/components/InfoTip.vue'
import MoneyText from '@/components/MoneyText.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAccounts, useTransactions } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { shortDate } from '@/lib/format'
import { titleOf } from '@/lib/payee'

/**
 * The transactions picked to filter out, each with Put back, or the ones put back, each with Filter
 * out again. They're found as what a filter of just them filters out, whatever their dates.
 */
const props = defineProps<{ side: FilterSide; ids: number[]; mode: 'picked' | 'keep'; busy?: boolean }>()
const emit = defineEmits<{ back: []; putBack: [items: Array<{ id: number; date?: string }>]; unkeep: [ids: number[]] }>()

const today = useToday()
const { byId: accounts } = useAccounts()
const list = useTransactions(() => ({ filter: JSON.stringify({ [props.side]: { picked: props.ids } }), filteredOut: true }), 200)
// Their refunds and paybacks are filtered out with them: just the transactions themselves.
const rows = computed(() => {
  const ids = new Set(props.ids)
  return list.rows.value.filter((t) => ids.has(t.id))
})
/** Ones that were deleted since. */
const gone = computed(() => {
  if (!list.isSuccess.value || list.isPlaceholderData.value || list.hasNextPage.value) return []
  const found = new Set(rows.value.map((t) => t.id))
  return props.ids.filter((id) => !found.has(id))
})

const details = (t: Transaction) => [shortDate(t.date, today.value), accounts.value.get(t.accountId)?.name].filter(Boolean).join(' · ')
const act = (items: Array<Transaction | number>) => {
  const all = items.map((t) => (typeof t === 'number' ? { id: t } : t))
  if (props.mode === 'picked') emit('putBack', all)
  else emit('unkeep', all.map((t) => t.id))
}
</script>

<template>
  <div class="grid gap-2">
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="icon" class="-ml-2 size-11 md:size-8" aria-label="Back" @click="emit('back')"><ChevronLeft /></Button>
      <h3 class="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
        {{ mode === 'picked' ? `${ids.length} picked` : `${ids.length} put back` }}
        <InfoTip text="Counts this one payment again. For a bill that comes back every year, make it a recurring item so Not recurring keeps it counted" />
      </h3>
      <Button
        v-if="mode === 'picked' && ids.length > 1"
        variant="ghost"
        size="sm"
        class="h-11 md:h-8"
        :disabled="busy"
        @click="act([...rows, ...gone])"
      >
        Put back all
      </Button>
    </div>

    <div v-if="list.isPending.value" class="grid gap-3 py-2">
      <Skeleton v-for="i in Math.min(ids.length, 4)" :key="i" class="h-10" />
    </div>
    <ul v-else class="divide-y">
      <li v-for="t in rows" :key="t.id" class="flex items-center gap-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-3 text-sm">
            <span class="truncate font-medium">{{ titleOf(t) }}</span>
            <MoneyText :amount="t.amountMinor" class="shrink-0" />
          </div>
          <div class="truncate text-xs text-muted-foreground">{{ details(t) }}</div>
        </div>
        <Button variant="outline" size="sm" class="h-11 shrink-0 md:h-8" :disabled="busy" @click="act([t])">
          {{ mode === 'picked' ? 'Put back' : 'Filter out again' }}
        </Button>
      </li>
      <li v-if="gone.length" class="flex items-center gap-3 py-2 text-sm text-muted-foreground">
        <span class="min-w-0 flex-1">{{ gone.length === 1 ? '1 was deleted' : `${gone.length} were deleted` }}</span>
        <Button variant="ghost" size="sm" class="h-11 shrink-0 md:h-8" :disabled="busy" @click="act(gone)">Take off the list</Button>
      </li>
    </ul>
  </div>
</template>
