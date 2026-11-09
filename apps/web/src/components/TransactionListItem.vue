<script setup lang="ts">
import { computed } from 'vue'
import { Repeat } from '@lucide/vue'
import { formatMoney, type Transaction } from '@st/shared'
import CategoryBadge from '@/components/CategoryBadge.vue'
import LinkBadge from '@/components/LinkBadge.vue'
import { billCount, netAmount } from '@/lib/links'
import { sentPayeeUnder, titleOf } from '@/lib/payee'
import MoneyText from '@/components/MoneyText.vue'
import { useAccounts } from '@/composables/queries'
import { shortDate } from '@/lib/format'
import { useUiStore } from '@/stores/ui'

// Absent boolean props are cast to false by Vue, so showDate needs an explicit default.
const props = withDefaults(
  defineProps<{
    tx: Transaction
    today?: string
    showAccount?: boolean
    showDate?: boolean
    /** The account's balance after this transaction, as its statement shows it. */
    balance?: number | null
  }>(),
  { showDate: true, balance: null },
)
const emit = defineEmits<{ open: [Transaction]; accept: [Transaction] }>()

const { byId: accounts } = useAccounts()
const ui = useUiStore()
/** Open in the editor panel beside the list. */
const open = computed(() => ui.editorOpen && ui.editing?.id === props.tx.id)
const account = computed(() => accounts.value.get(props.tx.accountId))
const date = computed(() => shortDate(props.tx.date, props.today))
const badge = computed(() => ({
  categoryId: props.tx.categoryId,
  needsReview: props.tx.needsReview,
  source: props.tx.categorySource,
  confidence: props.tx.categoryConfidence,
  transfer: !!props.tx.transferPairId,
  bills: billCount(props.tx),
  acceptable: true,
  txId: props.tx.id,
}))
/** Date and account, under the payee while the row is too narrow for their own columns. */
const meta = computed(() => {
  const parts: string[] = []
  if (props.showDate) parts.push(date.value)
  if (props.showAccount && account.value) parts.push(account.value.name)
  return parts.join(' · ')
})
</script>

<template>
  <!-- A row of TransactionList's grid: its cells line up with every other row's. -->
  <li class="contents">
    <div
      role="button"
      tabindex="0"
      :data-tx-id="tx.id"
      :class="[
        'grid grid-cols-[minmax(7rem,1fr)_auto] items-start gap-x-3 border-t px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none md:px-6 @xl:col-span-full @xl:grid-cols-subgrid',
        open && 'bg-muted shadow-[inset_3px_0_0_var(--primary)]',
      ]"
      @click="emit('open', tx)"
      @keydown.enter.prevent="emit('open', tx)"
    >
      <span v-if="showDate" class="hidden pt-px text-sm whitespace-nowrap text-muted-foreground tabular @xl:block">{{ date }}</span>
      <div class="min-w-0">
        <!-- Its name, or what you call its payee, or its payee as sent (then that, small, under it). -->
        <div class="flex items-center gap-1.5">
          <span class="truncate text-sm font-medium">{{ titleOf(tx) }}</span>
          <LinkBadge :tx="tx" />
          <Repeat v-if="tx.recurringItemId" class="size-3 shrink-0 text-muted-foreground" aria-label="Recurring" />
        </div>
        <div v-if="sentPayeeUnder(tx)" class="truncate text-xs text-muted-foreground">{{ sentPayeeUnder(tx) }}</div>
        <!-- While the list is too narrow for their own columns: the category, then date and account. -->
        <CategoryBadge v-bind="badge" class="mt-1 max-w-full @xl:hidden" @accept="emit('accept', tx)" />
        <div v-if="meta" class="mt-1 truncate text-xs text-muted-foreground @xl:hidden">{{ meta }}</div>
        <p v-if="tx.notes" class="mt-1 line-clamp-2 text-xs break-words whitespace-pre-line text-foreground/80">{{ tx.notes }}</p>
        <div v-if="tx.tags.length" class="mt-1 flex flex-wrap gap-1">
          <span v-for="t in tx.tags" :key="t.id" class="rounded-full border px-1.5 text-[11px] text-muted-foreground">#{{ t.name }}</span>
        </div>
      </div>
      <!-- The category, with a button to accept a suggested one. -->
      <CategoryBadge v-bind="badge" class="hidden @xl:inline-flex" @accept="emit('accept', tx)" />
      <span v-if="showAccount" class="hidden pt-px text-sm whitespace-nowrap text-muted-foreground @xl:block">{{ account?.name }}</span>
      <div class="flex min-w-0 flex-col items-end gap-1">
        <MoneyText :amount="tx.amountMinor" class="text-sm font-medium whitespace-nowrap" />
        <span v-if="netAmount(tx) !== null" class="text-xs whitespace-nowrap text-muted-foreground">net {{ formatMoney(netAmount(tx)!, tx.currency, { signed: true }) }}</span>
        <MoneyText v-if="balance !== null" :amount="balance" :colored="false" class="text-xs whitespace-nowrap text-muted-foreground" />
      </div>
    </div>
  </li>
</template>
