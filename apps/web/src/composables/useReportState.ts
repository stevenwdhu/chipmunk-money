import { computed, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw, type RouteLocationNamedRaw, type RouteLocationRaw } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  comparisonRange,
  DEFAULT_RANGE,
  drillFilter,
  effectiveSpec,
  FILTER_LIMITS,
  FILTER_SIDES,
  filterParam,
  filterToParam,
  isEmptyFilter,
  monthRange,
  rangeOf,
  resolveRange,
  safeParseFilter,
  sameFilter,
  sameSpec,
  sideOf,
  specQuery,
  type Condition,
  type FilterSide,
  type MonthKey,
  type ReportFilter,
  type ReportSpec,
} from '@chipmunk/shared'
import { errorMessage } from '@/lib/api'
import { currentLedger } from '@/lib/ledger'
import { useCustomReport, useCustomReportMutations, useCustomReports } from './queries'
import { useQueryState } from './useQueryState'
import { useToday } from './useToday'

const lastReportKey = (ledger: string) => `st.lastReport.${ledger}`

/** The report you last chose in this ledger, on this device (null: Everything). */
export function rememberedReport(ledger: string): number | null {
  try {
    const v = Number(localStorage.getItem(lastReportKey(ledger)))
    return Number.isInteger(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function rememberReport(ledger: string, id: number | null) {
  try {
    if (id === null) localStorage.removeItem(lastReportKey(ledger))
    else localStorage.setItem(lastReportKey(ledger), String(id))
  } catch {
    // Private browsing and the like: it just isn't remembered.
  }
}

/** The URL keys a report's changes live in; `focus` is the month shown on its own, not part of a report. */
const SPEC_KEYS = ['filter', 'range', 'compare', 'groupBy'] as const

/** Why a report's filter can't hold `f` (a 201st pick, say), or null when it can. */
function overLimit(f: ReportFilter): string | null {
  if (filterParam.safeParse(filterToParam(f) ?? '{}').success) return null
  const over = (k: 'picked' | 'keep') => FILTER_SIDES.some((side) => sideOf(f, side)[k].length > FILTER_LIMITS.ids)
  if (over('picked')) return `A report can filter out up to ${FILTER_LIMITS.ids} picked transactions. Tag them instead`
  if (over('keep')) return `A report can put back up to ${FILTER_LIMITS.ids} transactions`
  return 'That’s more than a report’s filter can hold, so it isn’t applied'
}

/**
 * The Reports page's state: the report open (`/reports/:reportId`, or Everything), its saved spec,
 * your changes on top (in the URL, so they survive reloads and Back), and what to show from them.
 * Saving, Save as new, Discard, Rename and Delete (with Undo) live here, and so does remembering the
 * last report on this device.
 */
export function useReportState() {
  const route = useRoute()
  const router = useRouter()
  const { q, setQuery } = useQueryState()
  const today = useToday()
  const mutations = useCustomReportMutations()
  const reports = useCustomReports()

  const reportId = computed(() => {
    const v = route.params.reportId
    return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null
  })
  const report = useCustomReport(reportId)
  const saved = computed<ReportSpec | null>(() => (reportId.value === null ? null : (report.data.value?.spec ?? null)))
  const spec = computed(() => effectiveSpec(saved.value, { filter: q('filter'), range: q('range'), compare: q('compare'), groupBy: q('groupBy') }))
  const filter = computed(() => spec.value.filter)
  /** The filter as the API takes it, or undefined for everything. */
  const apiFilter = computed(() => filterToParam(filter.value))
  const filtered = computed(() => !isEmptyFilter(filter.value))

  const loading = computed(() => reportId.value !== null && !report.data.value)
  const edited = computed(() => !!report.data.value && !sameSpec(spec.value, report.data.value.spec))
  /** Its filter changed (not just the range, comparison or grouping): the phone's bar asks to save then. */
  const filterEdited = computed(() => !!report.data.value && !sameFilter(filter.value, report.data.value.spec.filter))

  const range = computed(() => resolveRange(rangeOf(spec.value), today.value))
  const comparison = computed(() => (spec.value.compare === 'none' ? null : comparisonRange(range.value, spec.value.compare, today.value)))

  /**
   * Changes the spec shown, keeping only what differs from the saved one in the URL. With `undo`, a
   * toast offers to take it back (to where you were, should you have gone on to Transactions since).
   * Nothing changes while the report loads, as the spec isn't known yet, or when it's more than a
   * filter can hold.
   */
  function setSpec(next: Partial<ReportSpec>, opts: { undo?: string } = {}) {
    if (loading.value) return
    const why = next.filter && overLimit(next.filter)
    if (why) {
      toast.error(why)
      return
    }
    const before: RouteLocationRaw = { name: route.name!, params: { ...route.params }, query: { ...route.query } }
    setQuery({ ...specQuery({ ...spec.value, ...next }, saved.value) })
    if (opts.undo) toast(opts.undo, { action: { label: 'Undo', onClick: () => router.replace(before) } })
  }
  const setFilter = (f: ReportFilter, opts: { undo?: string } = {}) => setSpec({ filter: f }, opts)

  /** Drops your changes. The range you view a report that keeps none with isn't one, so it stays. */
  const dropChanges = () =>
    setQuery(Object.fromEntries(SPEC_KEYS.filter((k) => k !== 'range' || saved.value?.range !== null).map((k) => [k, undefined])))
  const at = (id: number | null, query: LocationQueryRaw = {}): RouteLocationNamedRaw => ({
    name: 'reports',
    params: { ...route.params, reportId: id === null ? '' : String(id) },
    query,
  })

  /** The range you're viewing, to open a report that keeps none with (none needed for the default). */
  const viewing = (): LocationQueryRaw => (rangeOf(spec.value) === DEFAULT_RANGE ? {} : { range: rangeOf(spec.value) })

  /** Opens a report (null: Everything), without your changes to the one open now. One that keeps no range opens with yours. */
  function open(id: number | null) {
    rememberReport(currentLedger.value, id)
    const keepsNone = id === null || reports.data.value?.find((r) => r.id === id)?.spec.range === null
    router.push(at(id, keepsNone ? viewing() : {}))
  }

  async function save() {
    const r = report.data.value
    if (!r) return
    try {
      // A report that keeps no range still keeps none, whatever range you're viewing it with.
      await mutations.update.mutateAsync({ id: r.id, spec: { ...spec.value, range: r.spec.range === null ? null : spec.value.range } })
      dropChanges()
      toast.success(`Saved ${r.name}`)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  /** Saves what's shown as a new report (with its range, or with none so it opens with any). Throws on a bad name, for the dialog to show. */
  async function create(name: string, keepRange: boolean) {
    const carry = { ...(keepRange ? {} : viewing()), focus: q('focus') }
    const r = await mutations.create.mutateAsync({ name, spec: { ...spec.value, range: keepRange ? rangeOf(spec.value) : null } })
    rememberReport(currentLedger.value, r.id)
    await router.replace(at(r.id, carry))
    toast.success(`Saved ${r.name}`)
    return r
  }

  async function rename(name: string) {
    const r = report.data.value
    if (!r) return
    await mutations.update.mutateAsync({ id: r.id, name })
  }

  async function remove() {
    const r = report.data.value
    if (!r) return
    try {
      await mutations.remove.mutateAsync(r.id)
    } catch (err) {
      toast.error(errorMessage(err))
      return
    }
    rememberReport(currentLedger.value, null)
    await router.replace(at(null))
    toast(`Deleted ${r.name}`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const back = await mutations.create.mutateAsync({ name: r.name, spec: r.spec })
            open(back.id)
          } catch (err) {
            toast.error(errorMessage(err))
          }
        },
      },
    })
  }

  // A report that isn't there any more (deleted elsewhere, or another ledger's link): back to Everything.
  watch(
    () => (report.error.value as { status?: number } | null)?.status,
    (status) => {
      if (status !== 404) return
      toast('That report isn’t in this ledger anymore')
      rememberReport(currentLedger.value, null)
      router.replace(at(null))
    },
  )
  // Null isn't remembered here, so landing() still finds the last report when the page opens on Everything.
  watch(reportId, (id) => id !== null && rememberReport(currentLedger.value, id), { immediate: true })
  // A link with a filter that can't be read (cut short, or from an older version) shows the report without it.
  watch(
    () => q('filter'),
    (v) => {
      if (!v || safeParseFilter(v)) return
      toast('That filter couldn’t be read, so it isn’t applied')
      setQuery({ filter: undefined })
    },
    { immediate: true },
  )

  /** Opening Reports from the nav (no report, no changes) goes to the last report you chose here. */
  function landing(): RouteLocationRaw | null {
    if (reportId.value !== null || Object.keys(route.query).length) return null
    const id = rememberedReport(currentLedger.value)
    return id === null ? null : { ...at(id), replace: true }
  }

  /**
   * The transactions behind a part of the report: in its range (or one month), by its filter with
   * `condition` added (a row's category, payee or tag), on one side, or what it filters out.
   */
  function drill(opts: { side: FilterSide; condition?: Condition; month?: MonthKey; filteredOut?: boolean }): RouteLocationRaw {
    const f = opts.condition ? drillFilter(filter.value, opts.side, opts.condition) : filter.value
    const dates = opts.month ? monthRange(opts.month) : range.value
    return {
      name: 'transactions',
      query: {
        from: dates.from,
        to: dates.to,
        filter: filterToParam(f),
        side: opts.side,
        filteredOut: opts.filteredOut ? '1' : undefined,
        report: reportId.value === null ? undefined : String(reportId.value),
      },
    }
  }

  return {
    reportId,
    report,
    reports,
    saved,
    spec,
    filter,
    apiFilter,
    filtered,
    loading,
    edited,
    filterEdited,
    range,
    comparison,
    setSpec,
    setFilter,
    open,
    save,
    create,
    rename,
    remove,
    discard: dropChanges,
    landing,
    drill,
    saving: computed(() => mutations.create.isPending.value || mutations.update.isPending.value),
  }
}

export type ReportState = ReturnType<typeof useReportState>
