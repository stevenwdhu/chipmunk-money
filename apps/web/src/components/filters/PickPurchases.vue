<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, EyeOff } from '@lucide/vue'
import type { FilterSide, Transaction } from '@chipmunk/shared'
import InfoTip from '@/components/InfoTip.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAccounts, useReportPurchases } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { money, shortDate } from '@/lib/format'
import { titleOf } from '@/lib/payee'

/** The biggest purchases (or deposits) the filter counts in the range, by your share. A tap filters one out. */
const props = defineProps<{ side: FilterSide; range: { from: string; to: string }; apiFilter?: string; picked: number[] }>()
const emit = defineEmits<{ back: []; pick: [id: number] }>()

const today = useToday()
const { byId: accounts } = useAccounts()
const purchases = useReportPurchases(() => ({ ...props.range, side: props.side, set: 'counted', filter: props.apiFilter, limit: 50 }))
// One just picked goes at once, before the list comes back without it.
const items = computed(() => (purchases.data.value?.items ?? []).filter((i) => !props.picked.includes(i.transaction.id)))
const title = computed(() => (props.side === 'spending' ? 'Pick purchases' : 'Pick deposits'))
const tip = computed(() =>
  props.side === 'spending' ? 'Your biggest counted charges in this range. Tap one to filter it out' : 'Your biggest counted deposits in this range. Tap one to filter it out',
)
const details = (t: Transaction) => [shortDate(t.date, today.value), accounts.value.get(t.accountId)?.name].filter(Boolean).join(' · ')
</script>

<template>
  <div class="grid gap-2">
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="icon" class="-ml-2 size-11 md:size-8" aria-label="Back" @click="emit('back')"><ChevronLeft /></Button>
      <h3 class="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
        {{ title }}
        <InfoTip :text="tip" />
      </h3>
    </div>

    <div v-if="purchases.isPending.value" class="grid gap-3 py-2">
      <Skeleton v-for="i in 5" :key="i" class="h-10" />
    </div>
    <p v-else-if="!items.length" class="py-6 text-center text-sm text-muted-foreground">
      {{ side === 'spending' ? 'No counted purchases in this range.' : 'No counted deposits in this range.' }}
    </p>
    <ul v-else class="-mx-2 grid">
      <li v-for="i in items" :key="i.transaction.id">
        <button
          type="button"
          class="flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
          :aria-label="`Filter out ${titleOf(i.transaction)}, ${money(i.shareMinor)}`"
          @click="emit('pick', i.transaction.id)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ titleOf(i.transaction) }}</span>
            <span class="block truncate text-xs text-muted-foreground">{{ details(i.transaction) }}</span>
          </span>
          <span class="shrink-0 text-right">
            <span class="block text-sm tabular">{{ money(i.shareMinor) }}</span>
            <span
              v-if="i.shareMinor !== Math.abs(i.transaction.amountMinor)"
              class="block text-xs text-muted-foreground"
              :title="`Of ${money(Math.abs(i.transaction.amountMinor))}`"
              >your share</span
            >
          </span>
          <EyeOff class="size-4 shrink-0 text-muted-foreground" />
        </button>
      </li>
    </ul>
  </div>
</template>
