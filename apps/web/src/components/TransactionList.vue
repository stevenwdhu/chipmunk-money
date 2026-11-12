<script setup lang="ts" generic="T extends Transaction">
import { computed } from 'vue'
import type { Transaction } from '@chipmunk/shared'
import TransactionListItem from '@/components/TransactionListItem.vue'
import { foldGiven } from '@/lib/sharing'
import { cn } from '@/lib/utils'

/**
 * Transactions as rows that share one grid, so their columns line up and fit their contents. A wide
 * list has Date · Payee · Category · Account · Amount, each as wide as its longest entry, with the
 * payee taking the rest (and the first to be cut short). In a narrow one, each row shows the
 * category under the payee, then date and account. What a split payment gave the other ledgers shows
 * under the payment when both are listed, not as a row of its own.
 */
const props = withDefaults(
  defineProps<{
    items: T[]
    today?: string
    showDate?: boolean
    showAccount?: boolean
    /** The account's balance after each transaction, if the list has one. */
    balanceOf?: (tx: T) => number | null
    /** Rows shown faded: changed so they no longer match the filters, kept until those change. */
    faded?: Set<number>
    /** Split payments whose given row was folded under them before the list got them (its rows are already folded). */
    under?: Set<number>
  }>(),
  { showDate: true },
)
const emit = defineEmits<{ open: [Transaction]; accept: [Transaction] }>()

const folded = computed(() => foldGiven(props.items))
const shown = computed(() => folded.value.items)
/** A split payment with its given row folded under it, here or before. */
const givenUnder = (tx: T) => folded.value.under.has(tx.id) || !!props.under?.has(tx.id)

// Written out in full so Tailwind sees each one.
const WIDE: Record<string, string> = {
  'date,account': '@xl:grid-cols-[auto_minmax(8rem,1fr)_auto_auto_auto]',
  date: '@xl:grid-cols-[auto_minmax(8rem,1fr)_auto_auto]',
  account: '@xl:grid-cols-[minmax(8rem,1fr)_auto_auto_auto]',
  '': '@xl:grid-cols-[minmax(8rem,1fr)_auto_auto]',
}
const columns = computed(() => WIDE[[props.showDate && 'date', props.showAccount && 'account'].filter(Boolean).join(',')]!)
</script>

<template>
  <div class="@container">
    <!-- Narrow, each row sizes itself (a long category shouldn't squeeze every payee); wide, they share columns. -->
    <ul :class="cn('grid grid-cols-1 gap-x-3 [&>li:first-child>div]:border-t-0', columns)">
      <TransactionListItem
        v-for="tx in shown"
        :key="tx.id"
        :tx="tx"
        :today="today"
        :show-date="showDate"
        :show-account="showAccount"
        :balance="balanceOf?.(tx) ?? null"
        :given-under="givenUnder(tx)"
        :class="faded?.has(tx.id) && 'opacity-60'"
        :title="faded?.has(tx.id) ? 'It doesn’t match the filters any more. It stays until you change them.' : undefined"
        @open="emit('open', $event)"
        @accept="emit('accept', $event)"
      />
    </ul>
  </div>
</template>
