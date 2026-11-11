<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useElementSize, useMediaQuery } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { AlertTriangle, ArrowDown, ArrowUp, Copy, FileOutput, Pencil, Save, SlidersHorizontal, Tag, Trash2, Undo2 } from '@lucide/vue'
import {
  addRule,
  completeMonthAverage,
  describeCondition,
  describeRule,
  FILTER_SIDES,
  filterCount,
  filterRefs,
  formatMonth,
  formatMonthShort,
  isEmptySide,
  mapConditions,
  mergeCondition,
  monthOf,
  monthRange,
  rangeOf,
  removeAt,
  sideOf,
  UNGROUPED_COLOR,
  chartColor,
  withSide,
  type Condition,
  type CustomReportMissing,
  type FilterSide,
  type ReportFilter,
  type ReportRange,
  type ReportSpec,
} from '@chipmunk/shared'
import GroupedBarChart from '@/components/charts/GroupedBarChart.vue'
import StackedBarChart from '@/components/charts/StackedBarChart.vue'
import FilterChips from '@/components/filters/FilterChips.vue'
import FilterPanel from '@/components/filters/FilterPanel.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import MoneyText from '@/components/MoneyText.vue'
import CategoryRows from '@/components/reports/CategoryRows.vue'
import CompareCard from '@/components/reports/CompareCard.vue'
import CompareSelect from '@/components/reports/CompareSelect.vue'
import PurchasesCard from '@/components/reports/PurchasesCard.vue'
import RangePicker from '@/components/reports/RangePicker.vue'
import ReportKpis from '@/components/reports/ReportKpis.vue'
import ReportSwitcher from '@/components/reports/ReportSwitcher.vue'
import RowActions from '@/components/reports/RowActions.vue'
import SaveReportDialog from '@/components/reports/SaveReportDialog.vue'
import SegmentedToggle from '@/components/SegmentedToggle.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import {
  useByCategory,
  useCategories,
  useCustomReportMutations,
  usePayees,
  usePeriodSummary,
  useTagTotals,
  useTransactionSpan,
  useTrend,
} from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useFilterNames } from '@/composables/useFilterNames'
import { useQueryState } from '@/composables/useQueryState'
import { useReportState } from '@/composables/useReportState'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { money, percent } from '@/lib/format'
import { ledgerApiHref } from '@/lib/ledger'

type At = { side: FilterSide; kind: 'only' | 'rule' | 'picked' | 'keep'; index: number }

const router = useRouter()
const state = useReportState()
const { q, setQuery } = useQueryState()
const isDesktop = useIsDesktop()
// The header has room for the range and comparison only on a wide screen: below that they go under it.
const wide = useMediaQuery('(min-width: 1280px)')
const today = useToday()
const currentMonth = computed(() => monthOf(today.value))
const { byId: categories, colorOf } = useCategories()
const names = useFilterNames(() => [state.filter.value], () => state.saved.value?.names)

// Opening Reports from the nav goes to the last report you chose. Until it's there, and until a saved
// report has loaded, the spec isn't known, so nothing is fetched (it would be Everything's numbers).
const to = state.landing()
const landed = ref(!to)
if (to) router.replace(to).finally(() => (landed.value = true))
const known = computed(() => landed.value && !state.loading.value)

const range = state.range
const comparison = state.comparison
const filter = state.filter
const apiFilter = state.apiFilter
const count = computed(() => filterCount(filter.value))
const title = computed(() => (state.reportId.value === null ? 'Everything' : (state.report.data.value?.name ?? '…')))
const subtitle = computed(() => {
  if (!isDesktop.value || !comparison.value) return range.value.label
  if (!comparable.value) return `${range.value.label} · nothing to compare with before ${formatMonth(firstMonth.value!)}`
  return `${range.value.label} · vs ${comparison.value.label}`
})

const rangeModel = computed({ get: () => rangeOf(state.spec.value), set: (r: ReportRange) => state.setSpec({ range: r }) })
const compareModel = computed({ get: () => state.spec.value.compare, set: (c: ReportSpec['compare']) => state.setSpec({ compare: c }) })
const groupByModel = computed({ get: () => state.spec.value.groupBy, set: (g: ReportSpec['groupBy']) => state.setSpec({ groupBy: g }) })

// Data ----------------------------------------------------------------------

const summary = usePeriodSummary(() => ({ from: range.value.from, to: range.value.to, filter: apiFilter.value }), { enabled: known })
const prevSummary = usePeriodSummary(
  () => ({ from: comparison.value?.from ?? range.value.from, to: comparison.value?.to ?? range.value.to, filter: apiFilter.value }),
  { enabled: () => known.value && !!comparison.value },
)
const cur = computed(() => summary.data.value)
const span = useTransactionSpan()
const firstMonth = computed(() => span.data.value?.first?.slice(0, 7) ?? null)
// Months before your first transaction have nothing in them: a change against them says nothing.
const comparable = computed(() => !!comparison.value && (!firstMonth.value || comparison.value.start >= firstMonth.value))
const prev = computed(() => (comparable.value ? (prevSummary.data.value ?? null) : null))

const trendParams = computed(() => ({
  end: range.value.end,
  months: range.value.months.length,
  groupBy: state.spec.value.groupBy,
  filter: apiFilter.value,
}))
const trend = useTrend(trendParams, { enabled: known })
// The comparison's months, for its per-month figure. Without a comparison it's the same query as `trend`.
const prevTrend = useTrend(
  () => (comparison.value ? { ...trendParams.value, end: comparison.value.end, months: comparison.value.months.length } : trendParams.value),
  { enabled: known },
)
const average = (points: Array<{ month: string; spentMinor: number }> | undefined) =>
  completeMonthAverage(
    (points ?? []).map((p) => ({ month: p.month, value: p.spentMinor })),
    { currentMonth: currentMonth.value, firstMonth: firstMonth.value },
  )
const perMonth = computed(() => average(trend.data.value?.points))
const prevPerMonth = computed(() => (comparable.value ? average(prevTrend.data.value?.points) : null))

const payees = usePayees(() => ({ from: range.value.from, to: range.value.to, limit: 10, filter: apiFilter.value }), { enabled: known })
const tagTotals = useTagTotals(() => ({ from: range.value.from, to: range.value.to, filter: apiFilter.value }), { enabled: known })

/** Rules or picks on the spending side: what they filter out (the KPI and the Purchases tab). */
const spendingOut = computed(() => {
  const s = sideOf(filter.value, 'spending')
  return s.filterOut.length || s.picked.length ? (cur.value?.filteredOut?.spending ?? null) : null
})

// Spending over time and the month in focus -------------------------------------

const t = computed(() => trend.data.value)
const labels = computed(() => (t.value?.months ?? []).map((m) => formatMonthShort(m)))
const titles = computed(() => (t.value?.months ?? []).map((m) => formatMonth(m)))
const values = computed(() => {
  const out: Record<string, number[]> = {}
  for (const s of t.value?.series ?? []) out[s.key] = (t.value?.points ?? []).map((p) => p.byKey[s.key] ?? 0)
  return out
})
/**
 * One colour per category on this page, the same in every card: by how much went to it in the range
 * (then in the comparison, for ones only there), each the next chart colour, uncategorized grey.
 */
const categoryColors = computed(() => {
  const out = new Map<number | null, string>([[null, UNGROUPED_COLOR]])
  let next = 0
  for (const s of [cur.value, prev.value]) {
    const ranked = (s?.expenses ?? []).flatMap((g) => g.categories).sort((a, b) => b.amountMinor - a.amountMinor || (a.categoryId ?? 0) - (b.categoryId ?? 0))
    for (const c of ranked) if (!out.has(c.categoryId)) out.set(c.categoryId, chartColor(next++))
  }
  return out
})
const categoryColor = (id: number | null) => categoryColors.value.get(id)
/** The chart's series, by category in the page's colours (groups keep their own). */
const chartSeries = computed(() =>
  (t.value?.series ?? []).map((s) =>
    state.spec.value.groupBy === 'category' ? { ...s, color: categoryColor(s.key === 'none' ? null : Number(s.key.slice(1))) ?? s.color } : s,
  ),
)

/** What the spending side's rules and picks filter out each month, hatched on top of the bars. */
const outByMonth = computed(() => {
  const s = sideOf(filter.value, 'spending')
  if (!s.filterOut.length && !s.picked.length) return null
  const values = (t.value?.points ?? []).map((p) => p.filteredOutMinor)
  return values.some((v) => v > 0) ? { label: 'Filtered out', values } : null
})

// Showing what's filtered out on the bars is up to you, on this device. Off, a big one-off doesn't
// squash the rest of the chart.
const SHOW_OUT_KEY = 'st.reports.showFilteredOut'
function readShowOut() {
  try {
    return localStorage.getItem(SHOW_OUT_KEY) === '1'
  } catch {
    return false
  }
}
const showOut = ref(readShowOut())
watch(showOut, (on) => {
  try {
    if (on) localStorage.setItem(SHOW_OUT_KEY, '1')
    else localStorage.removeItem(SHOW_OUT_KEY)
  } catch {
    // Private browsing and the like: it just isn't remembered.
  }
})

// The chart takes the card's height, which the month beside it sets on a wide screen.
const chartBox = useTemplateRef<HTMLElement>('chartBox')
const { height: chartBoxHeight } = useElementSize(chartBox)
const chartHeight = computed(() => Math.max(240, Math.round(chartBoxHeight.value)))

const focusMonth = computed(() => {
  const f = q('focus')
  return f && range.value.months.includes(f) ? f : range.value.end
})
const focusIndex = computed(() => {
  const i = t.value?.months.indexOf(focusMonth.value) ?? -1
  return i < 0 ? null : i
})
function selectMonth(i: number) {
  const m = t.value?.months[i]
  if (m) setQuery({ focus: m === range.value.end ? undefined : m })
}
const breakdown = useByCategory(() => ({ ...monthRange(focusMonth.value), kind: 'expense' as const, filter: apiFilter.value }), { enabled: known })
const focusTotal = computed(() => t.value?.points.find((p) => p.month === focusMonth.value)?.spentMinor ?? 0)
const focusVsAvg = computed(() => (perMonth.value ? (focusTotal.value - perMonth.value) / perMonth.value : null))
/** Categories that refunds took below zero: the bars leave them out. */
const belowZero = computed(() => (breakdown.data.value ?? []).filter((c) => c.amountMinor < 0).map((c) => c.name))

// Filtering from a row ----------------------------------------------------------

type Row = { side: FilterSide; condition: Condition; label: string }
const categoryRow = (c: { categoryId: number | null; name: string }): Row => ({
  side: 'spending',
  condition: { field: 'category', ids: [c.categoryId ?? 'none'] },
  label: c.name,
})
const payeeRow = (p: { payeeKey: string; payee: string }): Row => ({ side: 'spending', condition: { field: 'payee', keys: [p.payeeKey] }, label: p.payee })
const tagRow = (tg: { tagId: number; name: string; spentMinor: number; incomeMinor: number }): Row => ({
  side: tg.spentMinor === 0 && tg.incomeMinor > 0 ? 'income' : 'spending',
  condition: { field: 'tag', ids: [tg.tagId] },
  label: `#${tg.name}`,
})

function show(r: Row, month?: string) {
  router.push(state.drill({ side: r.side, condition: r.condition, month }))
}
function onlyThis(r: Row) {
  state.setFilter(
    withSide(filter.value, r.side, (s) => ({ ...s, only: mergeCondition(s.only, r.condition) })),
    { undo: describeCondition(r.condition, r.side, names.value) },
  )
}
function filterOutThis(r: Row) {
  state.setFilter(
    withSide(filter.value, r.side, (s) => ({ ...s, filterOut: addRule(s.filterOut, { when: [r.condition] }) })),
    { undo: `Filtered out ${r.label}` },
  )
}

// The filter panel and chips ----------------------------------------------------

const panelOpen = ref(false)
const panelAt = ref<At | null>(null)
function openPanel(at?: At) {
  panelAt.value = at ?? null
  panelOpen.value = true
}
function startNew() {
  state.open(null)
  openPanel()
}

function removeChip(at: At) {
  const s = sideOf(filter.value, at.side)
  const words =
    at.kind === 'only'
      ? describeCondition(s.only[at.index]!, at.side, names.value)
      : at.kind === 'rule'
        ? describeRule(s.filterOut[at.index]!, at.side, names.value)
        : at.kind === 'picked'
          ? `Filter out ${s.picked.length} picked`
          : `Put back ${s.keep.length}`
  const next = withSide(filter.value, at.side, (x) =>
    at.kind === 'only'
      ? { ...x, only: removeAt(x.only, at.index) }
      : at.kind === 'rule'
        ? { ...x, filterOut: removeAt(x.filterOut, at.index) }
        : at.kind === 'picked'
          ? { ...x, picked: [] }
          : { ...x, keep: [] },
  )
  state.setFilter(next, { undo: `Removed “${words}”` })
}

// What a saved report refers to that's gone ----------------------------------------

/** What the report says is missing, while the filter shown still uses it. */
const missing = computed(() => {
  const list = state.report.data.value?.missing ?? []
  if (!list.length) return []
  const refs = filterRefs(filter.value)
  return list.filter((m) => (refs[m.kind] as Set<number | string>).has(m.id))
})

const NOUNS: Record<CustomReportMissing['kind'], [string, string]> = {
  category: ['a category', 'categories'],
  group: ['a group', 'groups'],
  label: ['a label', 'labels'],
  tag: ['a tag', 'tags'],
  payee: ['a payee', 'payees'],
  account: ['an account', 'accounts'],
  recurring: ['a recurring item', 'recurring items'],
  transaction: ['a transaction', 'transactions'],
}
const WHY: Record<CustomReportMissing['reason'], [string, string]> = {
  deleted: ['that no longer exists', 'that no longer exist'],
  off: ['that’s turned off', 'that are turned off'],
  unused: ['no transaction has anymore', 'no transactions have anymore'],
}
/** "This report uses a tag that no longer exists" */
const missingText = computed(() => {
  const list = missing.value
  const n = list.length
  if (!n) return ''
  const first = list[0]!
  const noun = new Set(list.map((m) => m.kind)).size > 1 ? `${n} things` : n === 1 ? NOUNS[first.kind][0] : `${n} ${NOUNS[first.kind][1]}`
  const why = new Set(list.map((m) => m.reason)).size > 1 ? 'that are gone or turned off' : WHY[first.reason][n === 1 ? 0 : 1]
  return `This report uses ${noun} ${why}`
})

function removeMissing() {
  const gone = (kind: CustomReportMissing['kind'], id: number | string) => missing.value.some((m) => m.kind === kind && m.id === id)
  let f: ReportFilter = mapConditions(filter.value, (c): Condition | null => {
    if (c.field === 'category' || c.field === 'group' || c.field === 'label') {
      const ids = c.ids.filter((i) => i === 'none' || !gone(c.field, i))
      return ids.length ? { ...c, ids } : null
    }
    if (c.field === 'tag' || c.field === 'account') {
      const ids = c.ids.filter((i) => !gone(c.field, i))
      return ids.length ? { field: c.field, ids } : null
    }
    if (c.field === 'payee') {
      const keys = c.keys.filter((k) => !gone('payee', k))
      return keys.length ? { ...c, keys } : null
    }
    if (c.field === 'recurring' && Array.isArray(c.ids)) {
      const ids = c.ids.filter((i) => !gone('recurring', i))
      return ids.length ? { ...c, ids } : null
    }
    return c
  })
  for (const side of FILTER_SIDES) {
    if (isEmptySide(f[side])) continue
    f = withSide(f, side, (s) => ({
      ...s,
      picked: s.picked.filter((i) => !gone('transaction', i)),
      keep: s.keep.filter((i) => !gone('transaction', i)),
    }))
  }
  state.setFilter(f)
}

// Saving ----------------------------------------------------------------------

const saveOpen = ref(false)
const saveMode = ref<'create' | 'copy' | 'rename'>('create')
function openSave(mode: 'create' | 'copy' | 'rename') {
  saveMode.value = mode
  saveOpen.value = true
}
const confirmDelete = ref(false)
async function remove() {
  confirmDelete.value = false
  await state.remove()
}

// Moving the report open in the list, for phones and keyboards (the sidebar's dragging is neither).
const { reorder } = useCustomReportMutations()
const place = computed(() => (state.reports.data.value ?? []).findIndex((r) => r.id === state.reportId.value))
function move(by: -1 | 1) {
  const ids = (state.reports.data.value ?? []).map((r) => r.id)
  const i = place.value
  if (i < 0 || i + by < 0 || i + by >= ids.length) return
  ids.splice(i + by, 0, ...ids.splice(i, 1))
  reorder.mutate(ids, { onError: (err) => toast.error(`Couldn’t move the report. ${errorMessage(err)}`) })
}

/** The phone's bar over the nav: a filter on Everything to save, or filter changes to a report. */
const bar = computed(() => {
  if (isDesktop.value) return null
  if (state.reportId.value === null) return state.filtered.value ? 'new' : null
  return state.filterEdited.value ? 'edited' : null
})

/** The transactions the report counts in its range (all of them for Everything). */
const exportHref = computed(() => {
  const params = new URLSearchParams({ from: range.value.from, to: range.value.to })
  if (apiFilter.value) params.set('filter', apiFilter.value)
  return ledgerApiHref(`/export/transactions.csv?${params}`)
})
</script>

<template>
  <PageHeader title="Reports" :subtitle="subtitle">
    <template #title>
      <div class="flex min-w-0 items-center gap-2">
        <ReportSwitcher :name="title" :current-id="state.reportId.value" :reports="state.reports.data.value ?? []" @open="state.open" @new="startNew" />
        <Badge v-if="state.edited.value" variant="secondary" class="shrink-0">Edited</Badge>
      </div>
    </template>
    <template #actions>
      <template v-if="wide">
        <RangePicker v-model="rangeModel" :resolved="range" />
        <CompareSelect v-model="compareModel" size="sm" class="w-48" />
      </template>
      <template v-if="isDesktop">
        <Button variant="outline" size="sm" @click="openPanel()"><SlidersHorizontal />Filters{{ count ? ` · ${count}` : '' }}</Button>
        <Button
          v-if="state.reportId.value !== null"
          size="sm"
          :variant="state.edited.value ? 'default' : 'outline'"
          :disabled="!state.edited.value || state.saving.value"
          @click="state.save()"
        >
          <Save />Save
        </Button>
        <Button v-else-if="state.filtered.value" size="sm" @click="openSave('create')"><Save />Save as report</Button>
      </template>
      <Button v-else variant="ghost" size="icon-sm" class="relative size-11" :aria-label="count ? `Filters, ${count} on` : 'Filters'" @click="openPanel()">
        <SlidersHorizontal />
        <span v-if="count" class="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground tabular">
          {{ count }}
        </span>
      </Button>
    </template>
    <template #menu>
      <DropdownMenuItem v-if="state.reportId.value !== null && state.edited.value" class="md:hidden" :disabled="state.saving.value" @select="state.save()">
        <Save />Save
      </DropdownMenuItem>
      <template v-if="state.reportId.value !== null">
        <DropdownMenuItem @select="openSave('copy')"><Copy />Save as new</DropdownMenuItem>
        <DropdownMenuItem v-if="state.edited.value" @select="state.discard()"><Undo2 />Discard changes</DropdownMenuItem>
        <DropdownMenuItem @select="openSave('rename')"><Pencil />Rename</DropdownMenuItem>
        <template v-if="(state.reports.data.value?.length ?? 0) > 1 && place >= 0">
          <DropdownMenuItem :disabled="place === 0 || reorder.isPending.value" @select="move(-1)"><ArrowUp />Move up</DropdownMenuItem>
          <DropdownMenuItem :disabled="place === state.reports.data.value!.length - 1 || reorder.isPending.value" @select="move(1)">
            <ArrowDown />Move down
          </DropdownMenuItem>
        </template>
        <DropdownMenuItem variant="destructive" @select="confirmDelete = true"><Trash2 />Delete…</DropdownMenuItem>
        <DropdownMenuSeparator />
      </template>
      <DropdownMenuItem v-else-if="state.filtered.value" class="md:hidden" @select="openSave('create')"><Save />Save as report</DropdownMenuItem>
      <DropdownMenuItem as-child>
        <a :href="exportHref" download><FileOutput />Export CSV</a>
      </DropdownMenuItem>
    </template>
  </PageHeader>

  <main :class="['flex flex-col gap-4 p-4 md:gap-6 md:p-6', bar && 'pb-20']">
    <div class="flex flex-col gap-3">
      <div v-if="!wide" class="grid grid-cols-2 gap-2 md:flex md:items-center">
        <RangePicker v-model="rangeModel" :resolved="range" />
        <CompareSelect v-model="compareModel" :size="isDesktop ? 'sm' : 'default'" class="w-full md:w-48" />
      </div>
      <FilterChips
        :filter="filter"
        :names="names"
        :filtered-out="cur?.filteredOut ?? null"
        :max="isDesktop ? undefined : 2"
        @open="openPanel"
        @remove="removeChip"
      />
      <Alert v-if="missing.length" class="border-amber-500/40 bg-amber-500/5">
        <AlertTriangle class="text-amber-600" />
        <AlertTitle class="line-clamp-none">{{ missingText }}</AlertTitle>
        <AlertDescription>
          <Button variant="link" size="sm" class="h-auto px-0" @click="removeMissing">{{ missing.length === 1 ? 'Remove it' : 'Remove them' }}</Button>
        </AlertDescription>
      </Alert>
    </div>

    <ReportKpis :summary="cur" :prev="prev" :per-month="perMonth" :prev-per-month="prevPerMonth" :compare="state.spec.value.compare" :filter="filter" />

    <div class="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-3">
      <Card class="gap-4 xl:col-span-2">
        <CardHeader>
          <CardTitle>Spending over time</CardTitle>
          <CardDescription>Click a month for its breakdown.</CardDescription>
          <CardAction>
            <SegmentedToggle
              v-model="groupByModel"
              label="Group by"
              :options="[
                { value: 'category', label: 'Category' },
                { value: 'group', label: 'Group' },
              ]"
            />
          </CardAction>
        </CardHeader>
        <CardContent class="flex flex-1 flex-col">
          <!-- The chart fills what the card has: it's laid over its box, so the box can grow and shrink with the card. -->
          <div ref="chartBox" class="relative min-h-60 flex-1">
            <div v-if="t" class="absolute inset-0">
              <StackedBarChart
                :height="chartHeight"
                :labels="labels"
                :titles="titles"
                :series="chartSeries"
                :values="values"
                :reference="perMonth ? { value: perMonth, label: `Per month ${money(perMonth)}` } : null"
                :extra="showOut ? outByMonth : null"
                :selected="focusIndex"
                :chart-label="`Spending by month, stacked by ${state.spec.value.groupBy}`"
                @select="selectMonth"
              >
                <template #tooltip="{ index }">
                  <div v-if="t.points[index]?.filteredOutMinor" class="mt-1 flex justify-between gap-2 border-t pt-1 text-muted-foreground">
                    <span>Filtered out</span><span class="tabular">{{ money(t.points[index]!.filteredOutMinor) }}</span>
                  </div>
                </template>
              </StackedBarChart>
            </div>
          </div>
          <div v-if="t" class="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span v-for="s in chartSeries.slice(0, 10)" :key="s.key" class="flex items-center gap-1.5">
              <span class="size-2 rounded-full" :style="{ background: s.color }" />{{ s.name }}
            </span>
            <span v-if="t.series.length > 10">+{{ t.series.length - 10 }} more</span>
            <label v-if="outByMonth" class="flex min-h-11 cursor-pointer items-center gap-1.5 md:min-h-0">
              <Switch v-model="showOut" class="mr-0.5" />
              <span
                class="size-2.5 rounded-[2px]"
                style="background: repeating-linear-gradient(135deg, var(--muted-foreground) 0 1px, color-mix(in oklab, var(--muted-foreground) 15%, transparent) 1px 3px)"
              />Show filtered out
            </label>
          </div>
        </CardContent>
      </Card>

      <Card class="gap-4">
        <CardHeader>
          <CardTitle>{{ formatMonth(focusMonth) }}</CardTitle>
          <CardDescription>
            {{ money(focusTotal) }} spent
            <template v-if="focusVsAvg !== null">
              · <span :class="focusVsAvg <= 0 ? 'text-positive' : 'text-negative'">{{ focusVsAvg <= 0 ? '' : '+' }}{{ percent(focusVsAvg) }} vs per month</span>
            </template>
          </CardDescription>
        </CardHeader>
        <CardContent class="grid gap-3">
          <CategoryRows
            v-if="breakdown.data.value?.some((c) => c.amountMinor > 0)"
            :items="breakdown.data.value ?? []"
            :total="focusTotal"
            :color-of="categoryColor"
            @show="(c) => show(categoryRow(c), focusMonth)"
            @only="(c) => onlyThis(categoryRow(c))"
            @filter-out="(c) => filterOutThis(categoryRow(c))"
          />
          <p v-else class="text-sm text-muted-foreground">No spending this month.</p>
          <p v-if="belowZero.length" class="text-xs text-muted-foreground">
            Net of refunds, so {{ belowZero.join(', ') }} {{ belowZero.length === 1 ? "isn't" : "aren't" }} listed
          </p>
        </CardContent>
      </Card>

      <CompareCard
        v-if="comparison && cur && prev"
        class="xl:col-span-2"
        :cur="cur"
        :prev="prev"
        :cur-label="range.label"
        :prev-label="comparison.label"
        :prev-heading="state.spec.value.compare === 'last-year' ? 'Last year' : 'Previous'"
        :color-of="categoryColor"
        @drill="(id) => show(categoryRow({ categoryId: id, name: '' }))"
      />

      <Card class="gap-3">
        <CardHeader>
          <CardTitle>Top payees</CardTitle>
          <CardDescription>Where the most money went</CardDescription>
        </CardHeader>
        <CardContent>
          <ol class="flex flex-col divide-y text-sm">
            <li v-for="(p, i) in payees.data.value ?? []" :key="p.payeeKey">
              <RowActions :label="p.payee" @show="show(payeeRow(p))" @only="onlyThis(payeeRow(p))" @filter-out="filterOutThis(payeeRow(p))">
                <span class="flex items-center gap-3 px-1 py-2">
                  <span class="w-4 text-xs text-muted-foreground tabular">{{ i + 1 }}</span>
                  <span
                    class="size-2 shrink-0 rounded-full"
                    :style="{ background: categoryColor(p.categoryId) ?? colorOf(categories.get(p.categoryId ?? -1)) ?? UNGROUPED_COLOR }"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ p.payee }}</span>
                  <span class="text-xs text-muted-foreground">{{ p.count }}×</span>
                  <span class="tabular">{{ money(p.amountMinor) }}</span>
                </span>
              </RowActions>
            </li>
          </ol>
          <p v-if="payees.data.value && !payees.data.value.length" class="text-sm text-muted-foreground">No spending in this range.</p>
        </CardContent>
      </Card>

      <PurchasesCard class="xl:col-span-2" :state="state" :names="names" :filtered-out="spendingOut" :ready="known" @open-filter="openPanel" />

      <Card v-if="tagTotals.data.value?.length" class="gap-3">
        <CardHeader>
          <CardTitle>Tags</CardTitle>
          <CardDescription>Totals for tagged transactions in this range</CardDescription>
        </CardHeader>
        <CardContent>
          <ul class="flex flex-col divide-y text-sm">
            <li v-for="tg in tagTotals.data.value" :key="tg.tagId">
              <RowActions :label="`#${tg.name}`" @show="show(tagRow(tg))" @only="onlyThis(tagRow(tg))" @filter-out="filterOutThis(tagRow(tg))">
                <span class="flex items-center gap-2 px-1 py-2">
                  <Tag class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate">#{{ tg.name }}</span>
                  <span class="text-xs text-muted-foreground">{{ tg.count }}</span>
                  <MoneyText v-if="tagRow(tg).side === 'income'" :amount="tg.incomeMinor" />
                  <span v-else class="tabular">{{ money(tg.spentMinor) }}</span>
                </span>
              </RowActions>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card class="gap-4 xl:col-span-2">
        <CardHeader>
          <CardTitle>Income vs spending</CardTitle>
          <CardDescription>Transfers between your accounts are left out.</CardDescription>
        </CardHeader>
        <CardContent>
          <GroupedBarChart
            v-if="t"
            :labels="labels"
            :titles="titles"
            :series="[
              { key: 'income', name: 'Income', color: 'var(--positive)', values: t.points.map((p) => p.incomeMinor) },
              { key: 'spent', name: 'Spent', color: 'var(--muted-foreground)', values: t.points.map((p) => p.spentMinor) },
            ]"
            chart-label="Income and spending by month"
          >
            <template #tooltip="{ index }">
              <div class="mt-1 flex justify-between border-t pt-1 font-medium">
                <span>Saved</span>
                <MoneyText :amount="t.points[index]?.netMinor ?? 0" :colored="false" />
              </div>
            </template>
          </GroupedBarChart>
        </CardContent>
      </Card>
    </div>
  </main>

  <!-- On a phone: saving sits over the nav while there's a filter to save. -->
  <div
    v-if="bar"
    class="fixed inset-x-0 bottom-[calc(3.125rem+env(safe-area-inset-bottom))] z-30 flex items-center gap-2 border-t bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
  >
    <template v-if="bar === 'new'">
      <span class="flex-1 text-sm text-muted-foreground">{{ count }} filter{{ count === 1 ? '' : 's' }}</span>
      <Button class="h-11" @click="openSave('create')"><Save />Save as report</Button>
    </template>
    <template v-else>
      <span class="flex-1 text-sm font-medium">Edited</span>
      <Button variant="ghost" class="h-11" @click="state.discard()">Discard</Button>
      <Button class="h-11" :disabled="state.saving.value" @click="state.save()">Save</Button>
    </template>
  </div>

  <FilterPanel
    v-model:open="panelOpen"
    :filter="filter"
    :names="names"
    :filtered-out="cur?.filteredOut ?? null"
    :at="panelAt"
    :range="{ from: range.from, to: range.to }"
    :api-filter="apiFilter"
    :counted="{ spendingMinor: cur?.spentMinor ?? 0, incomeMinor: cur?.incomeMinor ?? 0 }"
    @change="(f: ReportFilter) => state.setFilter(f)"
  />
  <SaveReportDialog v-model:open="saveOpen" :state="state" :names="names" :mode="saveMode" />
  <Dialog v-model:open="confirmDelete">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Delete {{ title }}?</DialogTitle>
        <DialogDescription>Your transactions don't change</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="confirmDelete = false">Cancel</Button>
        <Button variant="destructive" @click="remove">Delete</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
