import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { watchDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { FILTER_SIDES, filterToParam, isEmptyFilter, safeParseFilter, type FilterBar, type FilterSide, type ReportFilter } from '@chipmunk/shared'
import type { TransactionFilters } from '@/composables/queries'
import { useQueryState } from '@/composables/useQueryState'

/**
 * The transaction filters you set in a filter bar: search, categories, tag, "needs review" and the
 * account, plus a report's filter (from Reports, or built in the filter panel). They live in the URL,
 * so they survive reloads and can be linked to.
 */
export function useTransactionFilters() {
  const router = useRouter()
  const { q, setQuery } = useQueryState()

  const accountId = computed<number | null>({
    get: () => (q('accountId') ? Number(q('accountId')) : null),
    set: (v) => setQuery({ accountId: v ? String(v) : undefined }),
  })
  /** Categories, any of them: ids, and 'none' for uncategorized (`categoryId=12,none` in the URL). */
  const categoryIds = computed<Array<number | 'none'>>({
    get: () =>
      (q('categoryId') ?? '')
        .split(',')
        .map((c) => (c === 'none' ? ('none' as const) : Number(c)))
        .filter((c) => c === 'none' || (Number.isInteger(c) && c > 0)),
    set: (v) => setQuery({ categoryId: v.length ? [...new Set(v)].join(',') : undefined }),
  })
  const tagId = computed(() => (q('tagId') ? Number(q('tagId')) : undefined))
  const needsReview = computed(() => q('needsReview') === '1')
  /** A category label's id, or 'none' for spending in categories without a label. */
  const labelId = computed<number | 'none' | undefined>(() => {
    const v = q('labelId')
    return v === 'none' ? 'none' : v && Number(v) > 0 ? Number(v) : undefined
  })

  /** A report's filter (`filter`, as JSON), or null for none. */
  const reportFilter = computed<ReportFilter | null>(() => {
    const f = safeParseFilter(q('filter'))
    return isEmptyFilter(f) ? null : f
  })
  /** What that filter filters out, instead of what it counts (`filteredOut=1`). */
  const filteredOut = computed(() => q('filteredOut') === '1' && reportFilter.value !== null)
  /** Only what reports count as spending, or as income. */
  const side = computed<FilterSide | undefined>(() => FILTER_SIDES.find((s) => s === q('side')))
  /** The custom report the filter came from, for the way back to it. */
  const reportId = computed(() => (/^\d+$/.test(q('report') ?? '') ? Number(q('report')) : null))
  // A link with a filter that can't be read (cut short, or from an older version) shows the list without it.
  watch(
    () => q('filter'),
    (v) => {
      if (!v || safeParseFilter(v)) return
      toast('That filter couldn’t be read, so the list isn’t filtered by it')
      setQuery({ filter: undefined, filteredOut: undefined })
    },
    { immediate: true },
  )
  /**
   * Changes the report's filter, unless it's more than one can hold (it would then be dropped as
   * unreadable). Nothing left in it: nothing to show as filtered out either.
   */
  function setReportFilter(f: ReportFilter) {
    const param = filterToParam(f)
    if (param && !safeParseFilter(param)) return void toast.error('That’s more than a filter can hold, so it isn’t applied')
    setQuery({ filter: param, filteredOut: param ? q('filteredOut') : undefined })
  }

  // The search box updates the URL as you pause typing, and follows it when it changes elsewhere.
  const search = ref(q('q') ?? '')
  watchDebounced(search, (v) => setQuery({ q: v.trim() || undefined }), { debounce: 300 })
  watch(
    () => q('q'),
    (v) => {
      if ((v ?? '') !== search.value.trim()) search.value = v ?? ''
    },
  )

  /** Everything but the period and the account. */
  const filters = computed<TransactionFilters>(() => ({
    categoryId: categoryIds.value.length ? categoryIds.value.join(',') : undefined,
    tagId: tagId.value,
    needsReview: needsReview.value || undefined,
    labelId: labelId.value,
    q: q('q'),
    filter: filterToParam(reportFilter.value),
    filteredOut: filteredOut.value || undefined,
    side: side.value,
  }))
  /** The bar's filters and the account, as a report would take them (barToFilter). */
  const bar = computed<FilterBar>(() => ({
    categoryIds: categoryIds.value,
    tagId: tagId.value,
    labelId: labelId.value,
    accountId: accountId.value ?? undefined,
    q: q('q'),
    needsReview: needsReview.value,
  }))
  /** How many filters are on, not counting the account. A report's filter counts as one. */
  const activeCount = computed(
    () =>
      [
        categoryIds.value.length || undefined,
        tagId.value,
        needsReview.value || undefined,
        labelId.value,
        q('q'),
        reportFilter.value,
        filteredOut.value || undefined,
        side.value,
      ].filter(Boolean).length,
  )

  /** Turns every filter off, keeping the query keys in `keep` (e.g. the month). */
  function clear(keep: string[] = []) {
    search.value = ''
    router.replace({ query: Object.fromEntries(keep.map((k) => [k, q(k)])) })
  }

  return {
    q,
    setQuery,
    accountId,
    categoryIds,
    tagId,
    needsReview,
    labelId,
    reportFilter,
    filteredOut,
    side,
    reportId,
    setReportFilter,
    search,
    filters,
    bar,
    activeCount,
    clear,
  }
}

export type TransactionFilterState = ReturnType<typeof useTransactionFilters>
