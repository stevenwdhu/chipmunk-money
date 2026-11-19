<script setup lang="ts">
import { computed } from 'vue'
import type { Transaction, TransactionPart } from '@chipmunk/shared'
import MoneyText from '@/components/MoneyText.vue'
import { useCategories } from '@/composables/queries'
import { foldGiven } from '@/lib/sharing'

/**
 * How many transactions are listed and the money in and out. Transfers between your accounts cancel
 * out across accounts, so they count only for a single account's list. What a split payment gave the
 * other ledgers shows under the payment, not as a row, so it isn't counted as a transaction, and it
 * is money out like the amount the list shows there. With more still to load, the count is what's
 * loaded so far ("100+"), as the page asks for them. Filtered by categories or by a label, one split
 * into categories counts only its parts in them. Under a report's filter on categories (`whole`) it
 * counts whole, and the bar says so.
 */
const props = defineProps<{
  items: Transaction[]
  more?: boolean
  singleAccount?: boolean
  categoryIds?: Array<number | 'none'>
  labelId?: number | 'none'
  whole?: boolean
}>()
const { categories } = useCategories()

/** Whether the filters are about a part, or null when none of them is by category. `none`: spending with no label, as the list finds it. */
const counts = computed(() => {
  const ids = props.categoryIds?.length ? props.categoryIds : null
  const label = props.labelId
  if (!ids && label === undefined) return null
  const labelled = new Set(
    categories.value.filter((c) => (label === 'none' ? !c.isIncome && !c.excludeFromTotals && !c.labelIds.length : c.labelIds.includes(label!))).map((c) => c.id),
  )
  return (p: TransactionPart) =>
    (!ids || ids.includes(p.categoryId ?? 'none')) && (label === undefined || (p.categoryId === null ? label === 'none' && p.amountMinor < 0 : labelled.has(p.categoryId)))
})
const amountOf = (t: Transaction) => (t.parts && counts.value ? t.parts.filter(counts.value).reduce((n, p) => n + p.amountMinor, 0) : t.amountMinor)

const totals = computed(() => {
  let inflow = 0
  let outflow = 0
  for (const t of props.items) {
    if (t.transferPairId && !props.singleAccount) continue
    const amount = amountOf(t)
    if (amount > 0) inflow += amount
    else outflow += amount
  }
  return { inflow, outflow, count: props.more ? props.items.length : foldGiven(props.items).items.length }
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
    <span>{{ totals.count }}{{ more ? '+' : '' }} transaction{{ totals.count === 1 ? '' : 's' }}</span>
    <span>In <MoneyText :amount="totals.inflow" /></span>
    <span>Out <MoneyText :amount="totals.outflow" :colored="false" class="text-foreground" /></span>
    <span v-if="whole && items.some((t) => t.parts)">Ones split by category count whole</span>
  </div>
</template>
