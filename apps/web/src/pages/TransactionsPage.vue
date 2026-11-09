<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRouter, type RouteLocationRaw } from 'vue-router'
import { ChartColumn, ChevronLeft, EyeOff, Plus, Save, X } from '@lucide/vue'
import {
  barToFilter,
  filterToParam,
  formatDateShort,
  formatMonth,
  formatMonthShort,
  isEmptyFilter,
  isISODate,
  monthRange,
  parseFixedRange,
  removeAt,
  withSide,
  type FilterSide,
  type ReportFilter,
  type ReportRange,
} from '@st/shared'
import FilterChips from '@/components/filters/FilterChips.vue'
import FilterPanel from '@/components/filters/FilterPanel.vue'
import InfoTip from '@/components/InfoTip.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import MonthSwitcher from '@/components/MonthSwitcher.vue'
import PeriodSummary from '@/components/PeriodSummary.vue'
import SaveFilterAsReportDialog from '@/components/SaveFilterAsReportDialog.vue'
import TransactionFilterBar from '@/components/TransactionFilterBar.vue'
import TransactionTable from '@/components/TransactionTable.vue'
import TransactionTotals from '@/components/TransactionTotals.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useCustomReport, usePeriodSummary, useTransactions, useTransactionSpan, type TransactionFilters } from '@/composables/queries'
import { useFilterNames } from '@/composables/useFilterNames'
import { useTransactionFilters } from '@/composables/useTransactionFilters'
import { useSelectedMonth, useToday } from '@/composables/useToday'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const router = useRouter()
const { month } = useSelectedMonth()
const f = useTransactionFilters()
/** What "Clear" keeps: the period. */
const keep = ['month', 'period', 'from', 'to']

/** Dates from Reports (`from`/`to`), in place of the month. */
const dates = computed(() => {
  const valid = (k: string) => {
    const v = f.q(k)
    return v && isISODate(v) ? v : undefined
  }
  const from = valid('from')
  const to = valid('to')
  return from || to ? { from, to } : null
})
const allTime = computed(() => !dates.value && f.q('period') === 'all')
// Dates or all time go back to a month at a time, and a month goes to all time.
function togglePeriod() {
  if (dates.value || allTime.value) f.setQuery({ from: undefined, to: undefined, period: undefined })
  else f.setQuery({ period: 'all', month: undefined })
}
const period = computed<{ from?: string; to?: string }>(() => dates.value ?? (allTime.value ? {} : monthRange(month.value)))

const filters = computed<TransactionFilters>(() => ({
  ...period.value,
  accountId: f.accountId.value ?? undefined,
  ...f.filters.value,
}))
const list = useTransactions(filters, 100, { keep: true })
const items = computed(() => list.data.value?.pages.flatMap((p) => p.items) ?? [])

const withYear = (d: string) => `${formatDateShort(d)}, ${d.slice(0, 4)}`
/** "Nov 1, 2025 – Oct 31, 2026", with the year once when both dates are in it. */
function datesLabel(from?: string, to?: string) {
  if (from && to) {
    if (from === to) return withYear(from)
    return `${from.slice(0, 4) === to.slice(0, 4) ? formatDateShort(from) : withYear(from)} – ${withYear(to)}`
  }
  return from ? `From ${withYear(from)}` : `Until ${withYear(to!)}`
}
/** "Nov 2025 – Oct 2026" when the dates are whole months, as Reports says it. */
function monthsLabel(from?: string, to?: string) {
  if (!from || !to || !from.endsWith('-01') || monthRange(to.slice(0, 7)).to !== to) return null
  const name = (d: string) => `${formatMonthShort(d.slice(0, 7))} ${d.slice(0, 4)}`
  return name(from) === name(to) ? name(from) : `${name(from)} – ${name(to)}`
}
const periodLabel = computed(() =>
  dates.value ? datesLabel(dates.value.from, dates.value.to) : allTime.value ? 'All time' : formatMonth(month.value),
)
/** The period in fewer words: whole months as months. Null for all time. */
const periodSpan = computed(() => {
  const d = dates.value
  if (!d) return allTime.value ? null : formatMonth(month.value)
  return monthsLabel(d.from, d.to) ?? datesLabel(d.from, d.to)
})

const filtered = computed(() => f.activeCount.value > 0 || f.accountId.value !== null)
const emptyTitle = computed(() =>
  f.filteredOut.value
    ? 'Nothing is filtered out here.'
    : filtered.value
      ? 'Nothing matches these filters.'
      : `No transactions in ${periodLabel.value}.`,
)

/** What Save as report saves: the report's filter with the bar's on top. */
const toSave = computed(() => barToFilter(f.bar.value, f.reportFilter.value))

// The report's filter as chips (from a report, ones that are gone by the names it kept), and the way
// back to it.
const report = useCustomReport(f.reportId)
const names = useFilterNames(() => [f.reportFilter.value, toSave.value.filter], () => report.data.value?.spec.names)
// One that's gone (deleted, or in another ledger) has no way back.
const fromReport = computed(() => (f.reportId.value !== null && !report.isError.value ? f.reportId.value : null))
/** These dates as Reports' months ("2025-11..2026-10"), for Everything opened from here. */
const rangeParam = computed(() => {
  const d = dates.value
  if (!d?.from || !d.to) return undefined
  const range = `${d.from.slice(0, 7)}..${d.to.slice(0, 7)}`
  return parseFixedRange(range) ? range : undefined
})
const back = computed<{ label: string; to: RouteLocationRaw } | null>(() => {
  if (fromReport.value !== null) {
    return {
      label: `Back to ${report.data.value?.name ?? 'the report'}`,
      to: { name: 'reports', params: { reportId: String(fromReport.value) } },
    }
  }
  if (!f.reportFilter.value) return null
  return {
    label: 'Edit in Reports',
    to: {
      name: 'reports',
      params: { reportId: '' },
      query: { filter: filterToParam(f.reportFilter.value), range: rangeParam.value },
    },
  }
})
// The report you came from (Everything too) is the page before: back to it as you left it, its range,
// unsaved changes and all.
function goBack(e: MouseEvent, navigate: (e?: MouseEvent) => unknown) {
  const before: unknown = window.history.state?.back
  const cameFrom = typeof before === 'string' && before.split(/[?#]/)[0] === router.resolve(back.value!.to).path
  if (!cameFrom || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return navigate(e)
  e.preventDefault()
  router.back()
}

const sideLabel = computed(() => (f.side.value === 'income' ? 'Income only' : f.side.value === 'spending' ? 'Spending only' : null))
const bannerText = computed(() => {
  const by = (fromReport.value !== null && report.data.value?.name) || 'this filter'
  return periodSpan.value ? `Filtered out by ${by}, ${periodSpan.value}` : `Filtered out by ${by}`
})

const rowsTip = 'Rows show their own date and amount, so they can differ a little from the report. A payback counts on its bill’s date there'

type ChipAt = { side: FilterSide; kind: 'only' | 'rule' | 'picked' | 'keep'; index: number }

// The filter panel, as on Reports: it edits the filter in the URL, and the list follows each edit.
const panelOpen = ref(false)
const panelAt = ref<ChipAt | null>(null)
function openPanel(at?: ChipAt) {
  panelAt.value = at ?? null
  panelOpen.value = true
}
/** The report's filter, or an empty one to start from. */
const filter = computed<ReportFilter>(() => f.reportFilter.value ?? { v: 1 })
// Its figures (what's counted, and what each rule filters out) are the period's and the bar's, as the
// list shows them, fetched while it's open. Edits still go to the report's filter only.
const apiFilter = computed(() => filterToParam(toSave.value.filter))
const panelSummary = usePeriodSummary(() => ({ ...period.value, filter: apiFilter.value }), { enabled: panelOpen })
const span = useTransactionSpan()
const today = useToday()
/** The period for "Pick purchases": all time (or an open end) goes as far as there are transactions. */
const panelRange = computed(() => ({
  from: period.value.from ?? span.data.value?.first ?? today.value,
  to: period.value.to ?? span.data.value?.last ?? today.value,
}))

const saveOpen = ref(false)
/** The months shown, as a report's fixed months: none for all time, or dates that can't be. */
const saveRange = computed<ReportRange | null>(() => {
  if (allTime.value) return null
  return dates.value ? ((rangeParam.value as ReportRange | undefined) ?? null) : `${month.value}..${month.value}`
})

function removeChip(at: ChipAt) {
  f.setReportFilter(
    withSide(f.reportFilter.value, at.side, (s) => {
      if (at.kind === 'only') return { ...s, only: removeAt(s.only, at.index) }
      if (at.kind === 'rule') return { ...s, filterOut: removeAt(s.filterOut, at.index) }
      return at.kind === 'picked' ? { ...s, picked: [] } : { ...s, keep: [] }
    }),
  )
}

// The summary covers the whole period, whatever the filters; its categories filter the list.
const summaryTitle = computed(() => (periodSpan.value ? `${periodSpan.value} summary` : 'All-time summary'))
// A category in the summary: in or out of the ones filtered by.
function filterByCategory(id: number | 'none') {
  const now = f.categoryIds.value
  f.categoryIds.value = now.includes(id) ? now.filter((c) => c !== id) : [...now, id]
}
function filterByLabel(id: number | 'none') {
  f.setQuery({ labelId: f.labelId.value === id ? undefined : String(id) })
}
</script>

<template>
  <PageHeader title="Transactions" :subtitle="periodLabel">
    <template #actions>
      <MonthSwitcher v-if="!dates && !allTime" />
      <Button variant="ghost" size="sm" class="hidden sm:inline-flex" @click="togglePeriod">{{ dates || allTime ? 'By month' : 'All time' }}</Button>
      <Button class="ml-1 hidden md:inline-flex" @click="ui.openAdd({ accountId: f.accountId.value ?? undefined })"><Plus />Add</Button>
    </template>
  </PageHeader>

  <main class="flex flex-col gap-3 p-4 md:gap-4 md:p-6">
    <RouterLink v-if="back" v-slot="{ href, navigate }" :to="back.to" custom>
      <a
        :href="href"
        class="-my-1 -ml-1 inline-flex max-w-full min-h-9 items-center gap-1 self-start rounded-md px-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        @click="goBack($event, navigate)"
      >
        <ChevronLeft v-if="fromReport !== null" class="size-4 shrink-0" /><ChartColumn v-else class="size-4 shrink-0" />
        <span class="truncate">{{ back.label }}</span>
      </a>
    </RouterLink>

    <Alert v-if="f.filteredOut.value">
      <EyeOff />
      <AlertTitle class="line-clamp-none">{{ bannerText }}</AlertTitle>
      <AlertDescription>
        <Button variant="link" size="sm" class="h-8 px-0" @click="f.setQuery({ filteredOut: undefined })">Show what’s counted</Button>
      </AlertDescription>
    </Alert>

    <TransactionFilterBar :filters="f" show-account :keep="keep">
      <Button variant="ghost" size="sm" class="h-9 sm:hidden" @click="togglePeriod">{{ dates || allTime ? 'By month' : 'All time' }}</Button>
    </TransactionFilterBar>

    <!-- The report's filter as chips, to edit in the filter panel, and saving it all as a report. -->
    <div class="flex flex-wrap items-center gap-2">
      <!-- Styled like FilterChips' chips. -->
      <span v-if="sideLabel" class="inline-flex h-8 items-center gap-1 rounded-full border border-foreground/25 bg-background pl-3 text-sm">
        {{ sideLabel }}
        <button
          type="button"
          class="relative mr-0.5 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground after:absolute after:-inset-2 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:after:inset-0"
          :aria-label="`Remove ${sideLabel}`"
          @click="f.setQuery({ side: undefined })"
        >
          <X class="size-3.5" />
        </button>
      </span>
      <!-- The tip and Save as report follow the last chip, instead of wrapping onto a line of their own. -->
      <FilterChips :filter="filter" :names="names" @open="openPanel" @remove="removeChip">
        <InfoTip v-if="f.reportFilter.value || sideLabel" :text="rowsTip" />
        <Button
          v-if="!isEmptyFilter(toSave.filter)"
          variant="ghost"
          size="sm"
          class="relative after:absolute after:inset-x-0 after:-inset-y-1.5 md:after:inset-y-0"
          @click="saveOpen = true"
        >
          <Save />Save as report
        </Button>
      </FilterChips>
    </div>

    <TransactionTotals :items="items" :more="list.hasNextPage.value" :single-account="f.accountId.value !== null" />

    <div class="grid grid-cols-1 items-start gap-3 md:gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <div class="flex min-w-0 flex-col gap-3 md:gap-4">
        <!-- Smaller screens: the summary sits above the list, folded. -->
        <PeriodSummary
          class="xl:hidden"
          collapsible
          :title="summaryTitle"
          v-bind="period"
          :active-categories="f.categoryIds.value"
          :active-label="f.labelId.value"
          @filter="filterByCategory"
          @label="filterByLabel"
        />
        <TransactionTable :list="list" :empty-title="emptyTitle">
          <template #empty>
            <Button v-if="filtered" variant="outline" size="sm" @click="f.clear(keep)">Clear filters</Button>
            <Button v-else size="sm" @click="ui.openAdd()"><Plus />Add transaction</Button>
          </template>
        </TransactionTable>
      </div>

      <PeriodSummary
        class="sticky top-20 hidden max-h-[calc(100svh-6rem)] overflow-y-auto xl:flex"
        :title="summaryTitle"
        v-bind="period"
        :active-categories="f.categoryIds.value"
        :active-label="f.labelId.value"
        @filter="filterByCategory"
        @label="filterByLabel"
      />
    </div>
  </main>

  <FilterPanel
    v-model:open="panelOpen"
    :filter="filter"
    :names="names"
    :filtered-out="panelSummary.data.value?.filteredOut ?? null"
    :at="panelAt"
    :range="panelRange"
    :api-filter="apiFilter"
    :counted="{ spendingMinor: panelSummary.data.value?.spentMinor ?? 0, incomeMinor: panelSummary.data.value?.incomeMinor ?? 0 }"
    @change="(next: ReportFilter) => f.setReportFilter(next)"
  />
  <SaveFilterAsReportDialog v-model:open="saveOpen" :filter="toSave.filter" :names="names" :range="saveRange" :left-out="toSave.leftOut" />
</template>
