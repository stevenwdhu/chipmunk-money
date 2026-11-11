<script setup lang="ts">
import { computed } from 'vue'
import { isEmptyFilter, sideOf, type PeriodSummary, type ReportFilter, type ReportSpec } from '@chipmunk/shared'
import { money, percent } from '@/lib/format'
import KpiCard from './KpiCard.vue'

/** Spent, Per month, Filtered out (or Income) and Saved for a report's range, each against the comparison. */
const props = defineProps<{
  summary: PeriodSummary | undefined
  /** The comparison's summary, with the same filter. */
  prev: PeriodSummary | null
  perMonth: number | null
  prevPerMonth: number | null
  compare: ReportSpec['compare']
  filter: ReportFilter
}>()

const filtered = computed(() => !isEmptyFilter(props.filter))
const label = (l: string) => (filtered.value ? `${l} (filtered)` : l)
const vs = computed(() => (props.compare === 'previous' ? 'prev.' : props.compare === 'last-year' ? 'last yr' : undefined))
const change = (cur: number | null | undefined, prev: number | null | undefined) =>
  cur === null || cur === undefined || !prev || !props.prev ? null : (cur - prev) / Math.abs(prev)

const spending = computed(() => sideOf(props.filter, 'spending'))
/** Rules or picks on the spending side: the third figure is what they filter out. */
const showFilteredOut = computed(() => spending.value.filterOut.length > 0 || spending.value.picked.length > 0)
const out = computed(() => props.summary?.filteredOut?.spending ?? null)

const saved = computed(() => {
  const s = props.summary
  if (!s) return null
  const net = s.incomeMinor - s.spentMinor
  const fo = s.filteredOut?.income
  // Income of 0 because the filter leaves it out says nothing about saving.
  const noIncome = s.incomeMinor === 0 && (sideOf(props.filter, 'income').only.length > 0 || (!!fo && (fo.amountMinor !== 0 || fo.count > 0)))
  return { net, rate: s.incomeMinor > 0 ? net / s.incomeMinor : null, noIncome }
})
</script>

<template>
  <div class="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
    <KpiCard
      :label="label('Spent')"
      :value="summary ? money(summary.spentMinor) : '—'"
      :change="change(summary?.spentMinor, prev?.spentMinor)"
      :vs="vs"
      up-is-bad
    />
    <KpiCard
      :label="label('Per month')"
      :value="perMonth === null ? '' : money(perMonth)"
      info="The average of complete months, so the month in progress doesn't pull it down"
      :change="change(perMonth, prevPerMonth)"
      :vs="vs"
      up-is-bad
    >
      <template v-if="perMonth === null" #value><span class="text-sm font-normal text-muted-foreground">No complete months yet</span></template>
    </KpiCard>
    <KpiCard v-if="showFilteredOut" label="Filtered out" :value="out ? money(out.amountMinor) : '—'">
      <template v-if="out">{{ out.count }} purchase{{ out.count === 1 ? '' : 's' }}</template>
    </KpiCard>
    <KpiCard
      v-else
      :label="label('Income')"
      :value="summary ? money(summary.incomeMinor) : '—'"
      :change="change(summary?.incomeMinor, prev?.incomeMinor)"
      :vs="vs"
    />
    <KpiCard
      :label="label('Saved')"
      :value="!saved || saved.noIncome ? '—' : money(saved.net)"
      :negative="!!saved && !saved.noIncome && saved.net < 0"
    >
      <template v-if="saved?.noIncome">This report's filter leaves out income</template>
      <template v-else-if="saved?.rate !== null && saved?.rate !== undefined">{{ percent(saved.rate) }} savings rate</template>
    </KpiCard>
  </div>
</template>
