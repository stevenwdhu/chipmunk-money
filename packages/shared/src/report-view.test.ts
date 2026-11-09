import { describe, expect, it } from 'vitest'
import { filterSchema, reportSpecSchema } from './filters'
import { barToFilter, copyName, drillFilter, effectiveSpec, EVERYTHING, filterCount, filterToParam, rangeOf, specQuery } from './report-view'

const saved = reportSpecSchema.parse({ range: '6m', compare: 'last-year', filter: { spending: { filterOut: [{ when: [{ field: 'tag', ids: [5] }] }] } } })

describe('report view', () => {
  it('puts the URL’s changes on a saved report, ignoring ones that aren’t valid', () => {
    expect(effectiveSpec(null, {})).toEqual(EVERYTHING)
    expect(effectiveSpec(saved, {})).toEqual(saved)
    expect(effectiveSpec(saved, { range: '2025-01..2025-03', groupBy: 'group' })).toMatchObject({ range: '2025-01..2025-03', groupBy: 'group', compare: 'last-year' })
    expect(effectiveSpec(saved, { range: 'forever', compare: 'sideways', filter: '{oops' })).toEqual(saved)
    expect(effectiveSpec(saved, { filter: '{}' }).filter).toEqual({ v: 1 })
  })

  it('keeps only what changed in the URL, and round-trips', () => {
    expect(specQuery(saved, saved)).toEqual({})
    const changed = { ...saved, range: '12m' as const, filter: filterSchema.parse({}) }
    const q = specQuery(changed, saved)
    expect(q).toEqual({ range: '12m', filter: '{}' })
    expect(effectiveSpec(saved, q)).toEqual(changed)
    expect(specQuery({ ...EVERYTHING, range: '3m' }, null)).toEqual({ range: '3m' })
    expect(rangeOf(EVERYTHING)).toBe('12m')
  })

  it('drills down by replacing a category or payee, and adding a tag', () => {
    const f = filterSchema.parse({ spending: { only: [{ field: 'category', ids: [1, 2] }, { field: 'tag', ids: [5] }] } })
    expect(drillFilter(f, 'spending', { field: 'category', ids: [2] }).spending?.only).toEqual([
      { field: 'category', ids: [2] },
      { field: 'tag', ids: [5] },
    ])
    expect(drillFilter(f, 'spending', { field: 'tag', ids: [6] }).spending?.only[1]).toEqual({ field: 'tag', ids: [5, 6] })
    expect(drillFilter(f, 'income', { field: 'payee', keys: ['acme'] }).income?.only).toEqual([{ field: 'payee', keys: ['acme'] }])
  })

  it('counts filters, and names copies', () => {
    expect(filterCount(saved.filter)).toBe(1)
    expect(filterCount(filterSchema.parse({ spending: { picked: [1, 2], keep: [3] }, income: { only: [{ field: 'amount', min: 1 }] } }))).toBe(3)
    expect(filterToParam({ v: 1, spending: { only: [], filterOut: [], picked: [], keep: [] } })).toBeUndefined()
    expect(copyName('Regular spending', [])).toBe('Regular spending copy')
    expect(copyName('Regular spending', ['regular spending COPY', 'Regular spending copy 2'])).toBe('Regular spending copy 3')
  })

  it('turns the Transactions filter bar into Only count on both sides, leaving out what a filter can’t say', () => {
    const { filter, leftOut } = barToFilter({ categoryIds: [3, 'none'], tagId: 5, labelId: 'none', accountId: 2, q: ' costco ', needsReview: true })
    const only = [
      { field: 'category', ids: [3, 'none'] },
      { field: 'tag', ids: [5] },
      { field: 'label', ids: ['none'] },
      { field: 'account', ids: [2] },
      { field: 'text', words: ['costco'] },
    ]
    // No label is spending without one, as the list has it: the income side isn't narrowed by it.
    const income = only.filter((c) => c.field !== 'label')
    const spending = [...income, { field: 'label', ids: ['none'] }]
    expect(filter).toEqual({ v: 1, spending: { only: spending, filterOut: [], picked: [], keep: [] }, income: { only: income, filterOut: [], picked: [], keep: [] } })
    expect(filterSchema.parse(filter)).toEqual(filter)
    expect(leftOut).toEqual(['needsReview'])
    expect(barToFilter({})).toEqual({ filter: { v: 1 }, leftOut: [] })
    expect(barToFilter({ tagId: Number.NaN, accountId: -1, categoryIds: [0], q: '  ' }).filter).toEqual({ v: 1 })
    expect(barToFilter({ q: 'x'.repeat(101) })).toEqual({ filter: { v: 1 }, leftOut: ['q'] })
    // A report with as many conditions as it holds takes none of the bar's.
    const full = filterSchema.parse({ spending: { only: Array.from({ length: 20 }, (_, i) => ({ field: 'tag', ids: [i + 1] })) } })
    expect(barToFilter({ tagId: 99 }, full)).toEqual({ filter: full, leftOut: ['tooMany'] })
  })

  it('merges the bar into a report’s filter so both must match, as the list shows them', () => {
    const report = filterSchema.parse({
      spending: { only: [{ field: 'category', ids: [1] }], filterOut: [{ when: [{ field: 'tag', ids: [9] }] }] },
      income: { picked: [4] },
    })
    const { filter } = barToFilter({ categoryIds: [2], labelId: 7 }, report)
    // Category 1 and category 2 have nothing in common: the bar's is what was asked for.
    expect(filter.spending).toEqual({
      only: [{ field: 'category', ids: [2] }, { field: 'label', ids: [7] }],
      filterOut: [{ when: [{ field: 'tag', ids: [9] }] }],
      picked: [],
      keep: [],
    })
    expect(filter.income).toEqual({ only: [{ field: 'category', ids: [2] }, { field: 'label', ids: [7] }], filterOut: [], picked: [4], keep: [] })
    expect(barToFilter({}, report).filter).toEqual(report)
    // What both have in common, and a second tag alongside the report's.
    const both = filterSchema.parse({ spending: { only: [{ field: 'category', ids: [1, 2, 3] }, { field: 'tag', ids: [8] }] } })
    expect(barToFilter({ categoryIds: [2, 3, 4], tagId: 5 }, both).filter.spending!.only).toEqual([
      { field: 'category', ids: [2, 3] },
      { field: 'tag', ids: [8] },
      { field: 'tag', ids: [5] },
    ])
  })
})
