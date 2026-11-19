<script setup lang="ts">
import { computed } from 'vue'
import { Repeat } from '@lucide/vue'
import { formatMoney, type Transaction } from '@chipmunk/shared'
import CategoryBadge from '@/components/CategoryBadge.vue'
import CategoryParts from '@/components/CategoryParts.vue'
import LedgerMark from '@/components/ledger/LedgerMark.vue'
import LinkBadge from '@/components/LinkBadge.vue'
import { billCount, netAmount } from '@/lib/links'
import { sentPayeeUnder, titleOf } from '@/lib/payee'
import { categoryAcross, sharesAcross, sharesFor, SHARES_OVER, splitTitle, type ListRow } from '@/lib/sharing'
import MoneyText from '@/components/MoneyText.vue'
import { useAccounts, useLedgers } from '@/composables/queries'
import { shortDate } from '@/lib/format'
import { useUiStore } from '@/stores/ui'

// Absent boolean props are cast to false by Vue, so showDate needs an explicit default.
const props = withDefaults(
  defineProps<{
    /** With `across`, a row of a shared account's All ledgers list: it says its ledger, and its category by name. */
    tx: Transaction & Pick<ListRow, 'across'>
    today?: string
    showAccount?: boolean
    showDate?: boolean
    /** The account's balance after this transaction, as its statement shows it. */
    balance?: number | null
    /** A split payment whose given row is folded under it: what it gave shows as an amount too. */
    givenUnder?: boolean
  }>(),
  { showDate: true, balance: null },
)
const emit = defineEmits<{ open: [Transaction]; accept: [Transaction] }>()

const { byId: accounts } = useAccounts()
const ledgers = useLedgers()
/** All ledgers: the row as that list has it, and the ledger that holds it. */
const across = computed(() => props.tx.across)
const holder = computed(() => ledgers.all.value.find((l) => l.slug === across.value?.ledger.slug))
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
/** All ledgers: "Family · Groceries". */
const held = computed(() => (across.value ? [across.value.ledger.name, categoryAcross(across.value)].filter(Boolean).join(' · ') : ''))
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
        open && !(across && !across.here) && 'bg-muted shadow-[inset_3px_0_0_var(--primary)]',
      ]"
      @click="emit('open', tx)"
      @keydown.enter.prevent="emit('open', tx)"
    >
      <span v-if="showDate" class="hidden pt-px text-sm whitespace-nowrap text-muted-foreground tabular @xl:block">{{ date }}</span>
      <div class="min-w-0">
        <!-- Its name, or what you call its payee, or its payee as sent (then that, small, under it). -->
        <div class="flex items-center gap-1.5">
          <!-- A split row says what it is: whose payment it's a share of, or who its shares are for. -->
          <span :class="['truncate text-sm font-medium', tx.split?.part === 'given' && 'text-muted-foreground']">{{ splitTitle(tx) ?? titleOf(tx) }}</span>
          <span v-if="tx.split?.part === 'payment'" class="shrink-0 rounded-full border px-1.5 text-[11px] text-muted-foreground">Split between ledgers</span>
          <span v-if="tx.status === 'pending'" class="shrink-0 text-xs text-muted-foreground">Pending</span>
          <LinkBadge :tx="tx" />
          <Repeat v-if="tx.recurringItemId" class="size-3 shrink-0 text-muted-foreground" aria-label="Recurring" />
        </div>
        <!-- All ledgers: a split payment's shares, each ledger's. -->
        <div v-if="across?.split" class="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span v-for="s in sharesAcross(across)" :key="s.name" class="whitespace-nowrap">{{ s.name }} <MoneyText :amount="s.minor" :colored="false" /></span>
          <span v-if="across.split.keptMinor < 0" class="text-amber-700 dark:text-amber-400">{{ SHARES_OVER }}</span>
        </div>
        <!-- A split payment: what it gave the other ledgers, under it. The amount only when its given row is folded here, so the totals have it. -->
        <div v-else-if="tx.split?.part === 'payment'" class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span class="truncate">{{ sharesFor(tx.split.shares).text }}</span>
          <MoneyText v-if="givenUnder" :amount="-sharesFor(tx.split.shares).minor" :colored="false" />
          <span v-if="tx.split.keptMinor < 0" class="text-amber-700 dark:text-amber-400">{{ SHARES_OVER }}</span>
        </div>
        <div v-if="sentPayeeUnder(tx)" class="truncate text-xs text-muted-foreground">{{ sentPayeeUnder(tx) }}</div>
        <!-- While the list is too narrow for their own columns: the category (All ledgers: the ledger that holds it, and its category there by name), then date and account. -->
        <div v-if="across" class="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground @xl:hidden">
          <LedgerMark :ledger="holder" size="sm" />
          <span class="truncate">{{ held }}</span>
        </div>
        <CategoryParts v-else-if="tx.parts" :parts="tx.parts" class="mt-1 @xl:hidden" />
        <CategoryBadge v-else v-bind="badge" class="mt-1 max-w-full @xl:hidden" @accept="emit('accept', tx)" />
        <div v-if="meta" class="mt-1 truncate text-xs text-muted-foreground @xl:hidden">{{ meta }}</div>
        <p v-if="tx.notes" class="mt-1 line-clamp-2 text-xs break-words whitespace-pre-line text-foreground/80">{{ tx.notes }}</p>
        <div v-if="tx.tags.length" class="mt-1 flex flex-wrap gap-1">
          <span v-for="t in tx.tags" :key="t.id" class="rounded-full border px-1.5 text-[11px] text-muted-foreground">#{{ t.name }}</span>
        </div>
      </div>
      <!-- The category, with a button to accept a suggested one. -->
      <span v-if="across" class="hidden min-w-0 items-center gap-1.5 text-sm text-muted-foreground @xl:flex">
        <LedgerMark :ledger="holder" size="sm" />
        <span class="truncate">{{ held }}</span>
      </span>
      <CategoryParts v-else-if="tx.parts" :parts="tx.parts" class="hidden @xl:flex" />
      <CategoryBadge v-else v-bind="badge" class="hidden @xl:inline-flex" @accept="emit('accept', tx)" />
      <span v-if="showAccount" class="hidden pt-px text-sm whitespace-nowrap text-muted-foreground @xl:block">{{ account?.name }}</span>
      <div class="flex min-w-0 flex-col items-end gap-1">
        <MoneyText :amount="tx.amountMinor" class="text-sm font-medium whitespace-nowrap" />
        <span v-if="netAmount(tx) !== null" class="text-xs whitespace-nowrap text-muted-foreground">net {{ formatMoney(netAmount(tx)!, tx.currency, { signed: true }) }}</span>
        <MoneyText v-if="balance !== null" :amount="balance" :colored="false" class="text-xs whitespace-nowrap text-muted-foreground" />
      </div>
    </div>
  </li>
</template>
