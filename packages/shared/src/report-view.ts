import { isReportPreset, parseFixedRange, type ReportRange } from './dates'
import {
  FILTER_LIMITS,
  FILTER_SIDES,
  filterSchema,
  isEmptyFilter,
  mergeCondition,
  normalizeFilter,
  REPORT_COMPARE,
  REPORT_GROUP_BY,
  safeParseFilter,
  sameFilter,
  setCondition,
  withSide,
  type Condition,
  type FilterSide,
  type ReportFilter,
  type ReportSpec,
} from './filters'

/**
 * What the Reports page shows: a saved report's spec (or Everything's), with what you changed on top
 * kept in the URL. A value the same as the saved one isn't in the URL, so the URL holds only changes.
 */

/** The range a report opens with when it keeps none. */
export const DEFAULT_RANGE: ReportRange = '12m'
export const EVERYTHING: ReportSpec = { v: 1, filter: { v: 1 }, range: null, compare: 'previous', groupBy: 'category' }

/** The Reports page's URL keys for changes to a spec. */
export type SpecQuery = { filter?: string; range?: string; compare?: string; groupBy?: string }

export const isReportRange = (v: string): v is ReportRange => isReportPreset(v) || parseFixedRange(v) !== null

/** The filter as it goes in a URL or `filter` param: compact, and left out when it's empty. */
export function filterToParam(f: ReportFilter | null | undefined): string | undefined {
  return isEmptyFilter(f) ? undefined : JSON.stringify(normalizeFilter(f))
}

/** `saved` (or Everything) with the URL's changes on top. Ones that aren't valid are ignored. */
export function effectiveSpec(saved: ReportSpec | null, query: SpecQuery): ReportSpec {
  const base = saved ?? EVERYTHING
  const filter = query.filter === undefined ? base.filter : (safeParseFilter(query.filter) ?? base.filter)
  return {
    v: 1,
    filter,
    range: query.range && isReportRange(query.range) ? query.range : base.range,
    compare: (REPORT_COMPARE as readonly string[]).includes(query.compare ?? '') ? (query.compare as ReportSpec['compare']) : base.compare,
    groupBy: (REPORT_GROUP_BY as readonly string[]).includes(query.groupBy ?? '') ? (query.groupBy as ReportSpec['groupBy']) : base.groupBy,
  }
}

/** The URL keys for `spec`: only what differs from `saved` (or Everything). An empty filter on a report that has one is `{}`. */
export function specQuery(spec: ReportSpec, saved: ReportSpec | null): SpecQuery {
  const base = saved ?? EVERYTHING
  return {
    filter: sameFilter(spec.filter, base.filter) ? undefined : (filterToParam(spec.filter) ?? '{}'),
    range: spec.range === base.range || spec.range === null ? undefined : spec.range,
    compare: spec.compare === base.compare ? undefined : spec.compare,
    groupBy: spec.groupBy === base.groupBy ? undefined : spec.groupBy,
  }
}

/** The range a spec shows: its own, or the default when it keeps none. */
export const rangeOf = (spec: ReportSpec): ReportRange => (spec.range ?? DEFAULT_RANGE) as ReportRange

/**
 * The filter for a drill-down from a report's row to its transactions: the report's filter with one
 * more Only count condition. A category or payee takes the place of the one on that field (the row
 * is one of them), anything else is added to it.
 */
export function drillFilter(f: ReportFilter, side: FilterSide, c: Condition): ReportFilter {
  return withSide(f, side, (s) => ({ ...s, only: c.field === 'category' || c.field === 'payee' ? setCondition(s.only, c) : mergeCondition(s.only, c) }))
}

/** How many Only count conditions, rules, picks and put backs a filter has. */
export function filterCount(f: ReportFilter | null | undefined): number {
  return FILTER_SIDES.reduce((n, side) => {
    const s = f?.[side]
    return n + (s ? s.only.length + s.filterOut.length + (s.picked.length ? 1 : 0) + (s.keep.length ? 1 : 0) : 0)
  }, 0)
}

/** "Regular spending copy", or "… copy 2" when that's taken too. */
export function copyName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()))
  const base = `${name} copy`.slice(0, 60)
  if (!lower.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const next = `${name.slice(0, 60 - ` copy ${i}`.length)} copy ${i}`
    if (!lower.has(next.toLowerCase())) return next
  }
}

/** The Transactions page's filter bar, as barToFilter takes it. */
export type FilterBar = {
  categoryIds?: Array<number | 'none'>
  tagId?: number
  labelId?: number | 'none'
  accountId?: number
  q?: string
  needsReview?: boolean
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

/**
 * Adds a condition to Only count so both must match, as the list shows them: on a field already
 * there (one of each in Only count), what both have in common; a tag or words, alongside.
 */
function narrow(only: Condition[], c: Condition): Condition[] {
  const i = only.findIndex((x) => x.field === c.field)
  const x = only[i]
  if (!x || c.field === 'tag' || c.field === 'text') return [...only, c]
  const common = <T>(a: T[], b: T[]) => a.filter((v) => b.includes(v))
  const both: Condition | null =
    'keys' in x && 'keys' in c
      ? { ...x, keys: common(x.keys, c.keys) }
      : Array.isArray((x as { ids?: unknown }).ids) && Array.isArray((c as { ids?: unknown }).ids)
        ? ({ ...x, ids: common((x as { ids: unknown[] }).ids, (c as { ids: unknown[] }).ids) } as Condition)
        : null
  // Nothing in common (the list shows nothing): the bar's own, so the report says what was asked.
  const empty = !both || ('keys' in both ? !both.keys.length : !(both as { ids: unknown[] }).ids.length)
  return only.map((y, j) => (j === i ? (empty ? c : both) : y))
}

/**
 * The Transactions filter bar as Only count conditions on both sides, as the bar has none: its
 * categories, tag, label, account and search. "No label" is spending in categories without one, as
 * the list has it, so it's on the spending side only. With `into` (a report's filter), each must
 * match as well as its Only count, as the list shows them. `leftOut` is what a filter can't say:
 * needing review, a search longer than a word can be, or more conditions than a report holds.
 */
export function barToFilter(
  bar: FilterBar,
  into?: ReportFilter | null,
): { filter: ReportFilter; leftOut: Array<'needsReview' | 'q' | 'tooMany'> } {
  const both: Condition[] = []
  const categories = (bar.categoryIds ?? []).filter((c) => c === 'none' || isId(c))
  if (categories.length) both.push({ field: 'category', ids: categories })
  if (isId(bar.tagId)) both.push({ field: 'tag', ids: [bar.tagId] })
  if (isId(bar.labelId)) both.push({ field: 'label', ids: [bar.labelId] })
  if (isId(bar.accountId)) both.push({ field: 'account', ids: [bar.accountId] })
  const q = bar.q?.trim() ?? ''
  if (q && q.length <= FILTER_LIMITS.word) both.push({ field: 'text', words: [q] })
  const only: Record<FilterSide, Condition[]> = {
    spending: bar.labelId === 'none' ? [...both, { field: 'label', ids: ['none'] }] : both,
    income: both,
  }
  const base = normalizeFilter(into)
  const filter = FILTER_SIDES.reduce((f, side) => withSide(f, side, (s) => ({ ...s, only: only[side].reduce(narrow, s.only) })), base)
  const leftOut: Array<'needsReview' | 'q' | 'tooMany'> = [...(bar.needsReview ? ['needsReview' as const] : []), ...(q.length > FILTER_LIMITS.word ? ['q' as const] : [])]
  // A report full of conditions can't take the bar's too: it's saved as it is.
  if (!filterSchema.safeParse(filter).success) return { filter: base, leftOut: [...leftOut, 'tooMany'] }
  return { filter, leftOut }
}
