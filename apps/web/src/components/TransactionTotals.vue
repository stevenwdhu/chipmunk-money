<script setup lang="ts">
import { computed } from 'vue'
import type { Transaction } from '@chipmunk/shared'
import MoneyText from '@/components/MoneyText.vue'
import { foldGiven } from '@/lib/sharing'

/**
 * How many transactions are listed and the money in and out. Transfers between your accounts cancel
 * out across accounts, so they count only for a single account's list. What a split payment gave the
 * other ledgers shows under the payment, not as a row, so it isn't counted as a transaction, and it
 * is money out like the amount the list shows there.
 */
const props = defineProps<{ items: Transaction[]; more?: boolean; singleAccount?: boolean }>()

const totals = computed(() => {
  let inflow = 0
  let outflow = 0
  for (const t of props.items) {
    if (t.transferPairId && !props.singleAccount) continue
    if (t.amountMinor > 0) inflow += t.amountMinor
    else outflow += t.amountMinor
  }
  return { inflow, outflow, count: foldGiven(props.items).items.length }
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
    <span>{{ totals.count }}{{ more ? '+' : '' }} transaction{{ totals.count === 1 ? '' : 's' }}</span>
    <span>In <MoneyText :amount="totals.inflow" /></span>
    <span>Out <MoneyText :amount="totals.outflow" :colored="false" class="text-foreground" /></span>
  </div>
</template>
