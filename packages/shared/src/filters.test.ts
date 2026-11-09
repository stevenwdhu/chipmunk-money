import { describe, expect, it } from 'vitest'
import {
  addRule,
  describeCondition,
  describeFilter,
  describeRule,
  filterParam,
  filterRefs,
  filterSchema,
  isEmptyFilter,
  mapConditions,
  mergeCondition,
  normalizeFilter,
  pick,
  putBack,
  reportSpecSchema,
  safeParseFilter,
  sameFilter,
  sameSpec,
  setCondition,
  sideOf,
  withSavedNames,
  withSide,
  type FilterNames,
  type ReportFilter,
} from './filters'

const names: FilterNames = {
  category: (id) => ({ 1: 'Groceries', 2: 'Dining' })[id],
  group: (id) => ({ 7: 'Food', 8: 'Housing', 9: 'Transport' })[id],
  label: (id) => ({ 4: 'Wants', 6: 'Needs' })[id],
  tag: (id) => ({ 5: 'trip-japan' })[id],
  payee: (key) => ({ costco: 'Costco' })[key],
  account: (id) => ({ 9: 'Visa' })[id],
  recurring: (id) => ({ 3: 'Netflix' })[id],
}
const parse = (v: unknown) => filterSchema.parse(v)

describe('filter schema', () => {
  it('fills in what was left out, and leaves out an absent side', () => {
    expect(parse({ spending: { only: [{ field: 'tag', ids: [5] }] } })).toEqual({
      v: 1,
      spending: { only: [{ field: 'tag', ids: [5] }], filterOut: [], picked: [], keep: [] },
    })
  })

  it('holds conditions to their limits', () => {
    const bad = (spending: unknown) => filterSchema.safeParse({ spending }).success
    expect(bad({ only: [{ field: 'amount' }] })).toBe(false)
    expect(bad({ only: [{ field: 'amount', min: 500, max: 100 }] })).toBe(false)
    expect(bad({ only: [{ field: 'amount', min: -1 }] })).toBe(false)
    expect(bad({ only: [{ field: 'tag', ids: [] }] })).toBe(false)
    expect(bad({ only: [{ field: 'tag', ids: Array.from({ length: 201 }, (_, i) => i + 1) }] })).toBe(false)
    expect(bad({ only: [{ field: 'text', words: ['x'.repeat(101)] }] })).toBe(false)
    expect(bad({ only: [{ field: 'colour', ids: [1] }] })).toBe(false)
    // Category, payee, account and recurring once in Only count, tags and words as often as you like.
    expect(bad({ only: [{ field: 'category', ids: [1] }, { field: 'category', ids: [2] }] })).toBe(false)
    expect(bad({ only: [{ field: 'tag', ids: [1] }, { field: 'tag', ids: [2] }] })).toBe(true)
    // Groups and labels too, with none for no group or no label.
    expect(bad({ only: [{ field: 'group', ids: [1, 'none'] }, { field: 'label', ids: ['none'] }] })).toBe(true)
    expect(bad({ only: [{ field: 'group', ids: [1] }, { field: 'group', ids: [2] }] })).toBe(false)
    expect(bad({ only: [{ field: 'label', ids: [1] }, { field: 'label', ids: [2] }] })).toBe(false)
    expect(bad({ only: [{ field: 'label', ids: [] }] })).toBe(false)
    // Each field once in a rule.
    expect(bad({ filterOut: [{ when: [{ field: 'tag', ids: [1] }, { field: 'tag', ids: [2] }] }] })).toBe(false)
    expect(bad({ filterOut: [{ when: [] }] })).toBe(false)
    expect(bad({ filterOut: Array.from({ length: 21 }, () => ({ when: [{ field: 'tag', ids: [1] }] })) })).toBe(false)
    expect(bad({ picked: [0] })).toBe(false)
    expect(bad({ only: [{ field: 'recurring', ids: 'any' }, { field: 'amount', max: 0 }], picked: [4] })).toBe(true)
  })

  it('reads a query param, and says what is wrong with it', () => {
    expect(filterParam.parse('{"income":{"picked":[4]}}')).toMatchObject({ income: { picked: [4] } })
    const notJson = filterParam.safeParse('{oops')
    expect(notJson.success).toBe(false)
    expect(notJson.error?.issues[0]?.message).toBe('Use a filter as JSON')
    expect(filterParam.safeParse(`{"spending":{"picked":[${'1,'.repeat(2500)}1]}}`).success).toBe(false)
    expect(safeParseFilter('{oops')).toBeNull()
    expect(safeParseFilter('{"spending":{"picked":["x"]}}')).toBeNull()
    expect(safeParseFilter(undefined)).toBeNull()
    expect(safeParseFilter('{}')).toEqual({ v: 1 })
  })
})

describe('filter helpers', () => {
  it('normalizes ids and empty sides, and compares filters whatever their order', () => {
    const a = parse({
      spending: { only: [{ field: 'category', ids: ['none', 2, 1, 2] }], filterOut: [{ when: [{ field: 'tag', ids: [5] }] }, { when: [{ field: 'amount', min: 100 }, { field: 'recurring', ids: 'none' }] }] },
      income: {},
    })
    expect(normalizeFilter(a)).toEqual({
      v: 1,
      spending: {
        only: [{ field: 'category', ids: [1, 2, 'none'] }],
        filterOut: [{ when: [{ field: 'tag', ids: [5] }] }, { when: [{ field: 'amount', min: 100 }, { field: 'recurring', ids: 'none' }] }],
        picked: [],
        keep: [],
      },
    })
    const b = parse({
      spending: { only: [{ field: 'category', ids: [1, 'none', 2] }], filterOut: [{ when: [{ field: 'recurring', ids: 'none' }, { field: 'amount', min: 100 }] }, { when: [{ field: 'tag', ids: [5] }] }] },
    })
    expect(sameFilter(a, b)).toBe(true)
    expect(sameFilter(a, withSide(b, 'spending', (s) => pick(s, 7)))).toBe(false)
    expect(sameFilter(null, parse({ income: {} }))).toBe(true)
    expect(isEmptyFilter(parse({ spending: {}, income: {} }))).toBe(true)
  })

  it('merges a condition into the one on its field, or sets it', () => {
    const only = mergeCondition([{ field: 'category', ids: [1] }], { field: 'category', ids: [2] })
    expect(only).toEqual([{ field: 'category', ids: [1, 2] }])
    expect(mergeCondition(only, { field: 'amount', min: 5 })).toEqual([...only, { field: 'amount', min: 5 }])
    expect(mergeCondition([{ field: 'amount', min: 5 }], { field: 'amount', max: 9 })).toEqual([{ field: 'amount', max: 9 }])
    expect(setCondition([{ field: 'tag', ids: [5] }, ...only], { field: 'category', ids: [3] })).toEqual([
      { field: 'tag', ids: [5] },
      { field: 'category', ids: [3] },
    ])
  })

  it('merges groups and labels as categories are, any of both', () => {
    expect(mergeCondition([{ field: 'group', ids: ['none', 8] }], { field: 'group', ids: [7, 8] })).toEqual([{ field: 'group', ids: [7, 8, 'none'] }])
    expect(mergeCondition([{ field: 'group', ids: [7] }], { field: 'label', ids: [4] })).toEqual([
      { field: 'group', ids: [7] },
      { field: 'label', ids: [4] },
    ])
    expect(addRule([{ when: [{ field: 'label', ids: [4] }] }], { when: [{ field: 'label', ids: ['none'] }] })).toEqual([{ when: [{ field: 'label', ids: [4, 'none'] }] }])
    expect(normalizeFilter(parse({ income: { only: [{ field: 'label', ids: ['none', 6, 4, 6] }] } })).income!.only).toEqual([{ field: 'label', ids: [4, 6, 'none'] }])
  })

  it('adds a rule once, merging one-field rules', () => {
    let rules = addRule([], { when: [{ field: 'payee', keys: ['costco'] }] })
    rules = addRule(rules, { when: [{ field: 'payee', keys: ['walmart'] }] })
    expect(rules).toEqual([{ when: [{ field: 'payee', keys: ['costco', 'walmart'] }] }])
    const big = { when: [{ field: 'amount' as const, min: 100_000 }, { field: 'recurring' as const, ids: 'none' as const }] }
    rules = addRule(rules, big)
    expect(addRule(rules, { when: [...big.when].reverse() })).toEqual(rules)
    expect(addRule(rules, { when: [{ field: 'amount', min: 5 }] })).toHaveLength(3)
  })

  it('picks and puts back: a put back one stays counted only while a rule would filter it out', () => {
    const s = sideOf(parse({ spending: { keep: [4] } }), 'spending')
    expect(pick(s, 4)).toMatchObject({ picked: [4], keep: [] })
    expect(putBack(pick(s, 8), 8, false)).toMatchObject({ picked: [], keep: [4] })
    expect(putBack(pick(s, 8), 8, true)).toMatchObject({ picked: [], keep: [4, 8] })
  })

  it('remaps ids, and drops a rule that can no longer match', () => {
    const f = parse({
      spending: {
        only: [{ field: 'category', ids: [1, 2] }],
        filterOut: [{ when: [{ field: 'category', ids: [2] }, { field: 'amount', min: 5 }] }, { when: [{ field: 'tag', ids: [5] }] }],
      },
    })
    const without2 = mapConditions(f, (c) => {
      if (c.field !== 'category') return c
      const ids = c.ids.filter((i) => i !== 2)
      return ids.length ? { ...c, ids } : null
    })
    expect(without2.spending).toMatchObject({ only: [{ field: 'category', ids: [1] }], filterOut: [{ when: [{ field: 'tag', ids: [5] }] }] })
    expect(filterRefs(f)).toMatchObject({ category: new Set([1, 2]), tag: new Set([5]) })
    const groups = parse({ spending: { only: [{ field: 'group', ids: [7, 'none'] }], filterOut: [{ when: [{ field: 'label', ids: [4] }] }] } })
    expect(filterRefs(groups)).toMatchObject({ group: new Set([7]), label: new Set([4]), category: new Set() })
  })
})

describe('filter in words', () => {
  it('says what a rule filters out', () => {
    const rule = (when: unknown) => describeRule(parse({ spending: { filterOut: [{ when }] } }).spending!.filterOut[0]!, 'spending', names)
    expect(rule([{ field: 'tag', ids: [5] }])).toBe('Filter out #trip-japan')
    expect(rule([{ field: 'payee', keys: ['costco', 'unknown store'] }])).toBe('Filter out Costco, unknown store')
    expect(rule([{ field: 'amount', min: 100_000 }, { field: 'recurring', ids: 'none' }])).toBe('Filter out one-time charges of $1,000 or more')
    expect(rule([{ field: 'payee', keys: ['costco'] }, { field: 'amount', min: 20_050 }])).toBe('Filter out charges of $200.50 or more at Costco')
    expect(rule([{ field: 'account', ids: [9] }])).toBe('Filter out charges on Visa')
    expect(rule([{ field: 'recurring', ids: [3] }])).toBe('Filter out charges for Netflix')
    expect(rule([{ field: 'tag', ids: [6] }])).toBe('Filter out Deleted tag')
    expect(describeRule({ when: [{ field: 'amount', max: 2_000 }] }, 'income', names)).toBe('Filter out deposits of $20 or less')
  })

  it('names groups and labels as what they are, so they aren’t taken for categories', () => {
    const only = (ids: Array<number | 'none'>, field: 'group' | 'label' = 'group', side: 'spending' | 'income' = 'spending') =>
      describeCondition({ field, ids }, side, names)
    expect(only([7])).toBe('Only the Food group')
    expect(only([7, 8])).toBe('Only Food and Housing groups')
    expect(only([7, 8, 9])).toBe('Only Food, Housing and Transport groups')
    expect(only([4], 'label')).toBe('Only the Wants label')
    expect(only([7, 'none'])).toBe('Only the Food group or no group')
    expect(only(['none'])).toBe('Only charges with no group')
    expect(only(['none'], 'label', 'income')).toBe('Only deposits with no label')
    expect(only([99])).toBe('Only a deleted group')
    const rule = (when: unknown) => describeRule(parse({ spending: { filterOut: [{ when }] } }).spending!.filterOut[0]!, 'spending', names)
    expect(rule([{ field: 'label', ids: [4] }])).toBe('Filter out the Wants label')
    expect(rule([{ field: 'group', ids: [7, 8] }])).toBe('Filter out Food and Housing groups')
    expect(rule([{ field: 'label', ids: ['none'] }])).toBe('Filter out charges with no label')
    expect(rule([{ field: 'group', ids: [7] }, { field: 'amount', min: 5_000 }])).toBe('Filter out charges of $50 or more in the Food group')
    expect(rule([{ field: 'group', ids: ['none'] }, { field: 'recurring', ids: 'none' }])).toBe('Filter out one-time charges with no group')
    expect(rule([{ field: 'label', ids: [4, 6] }, { field: 'payee', keys: ['costco'] }])).toBe('Filter out charges at Costco with Wants and Needs labels')
    // One that's gone goes by the name the report kept for it.
    const kept = withSavedNames(names, { group: { 99: 'Fun' }, label: { 98: 'Splurge' } })
    expect(describeCondition({ field: 'group', ids: [99] }, 'spending', kept)).toBe('Only the Fun (deleted) group')
    expect(describeRule({ when: [{ field: 'label', ids: [98] }] }, 'spending', kept)).toBe('Filter out the Splurge (deleted) label')
  })

  it('says where words are looked for, and a rule by its label', () => {
    const f = parse({ spending: { filterOut: [{ when: [{ field: 'text', words: ['uber'], in: ['notes', 'name', 'notes'] }] }, { when: [{ field: 'tag', ids: [5] }], label: 'One-offs' }] } })
    expect(f.spending!.filterOut.map((r) => describeRule(r, 'spending', names))).toEqual(['Filter out “uber” in name or notes', 'Filter out One-offs'])
    expect(normalizeFilter(f).spending!.filterOut[0]!.when[0]).toEqual({ field: 'text', words: ['uber'], in: ['name', 'notes'] })
    // A label is part of the rule, and stays through a remap.
    expect(sameFilter(f, parse({ spending: { filterOut: [f.spending!.filterOut[0]!, { when: [{ field: 'tag', ids: [5] }] }] } }))).toBe(false)
    expect(mapConditions(f, (c) => c).spending!.filterOut[1]!.label).toBe('One-offs')
    // Words merged: looked for everywhere if one of them was.
    expect(mergeCondition([{ field: 'text', words: ['a'], in: ['notes'] }], { field: 'text', words: ['b'] })).toEqual([{ field: 'text', words: ['a', 'b'] }])
  })

  it('says groups and labels as what they are, including gone ones', () => {
    const named: FilterNames = { ...names, group: (id) => ({ 1: 'Food' })[id], label: (id) => ({ 2: 'Wants' })[id] }
    const rule = (when: unknown) => describeRule(parse({ spending: { filterOut: [{ when }] } }).spending!.filterOut[0]!, 'spending', named)
    expect(rule([{ field: 'group', ids: ['none'] }, { field: 'label', ids: ['none'] }])).toBe('Filter out charges with no group and no label')
    expect(rule([{ field: 'group', ids: [1] }, { field: 'label', ids: [2] }])).toBe('Filter out charges in the Food group with the Wants label')
    expect(rule([{ field: 'group', ids: [8, 9] }])).toBe('Filter out 2 deleted groups')
    expect(rule([{ field: 'group', ids: [1, 8] }])).toBe('Filter out Food groups and a deleted group')
  })

  it('says what a whole filter does', () => {
    const f: ReportFilter = parse({
      spending: { only: [{ field: 'category', ids: [1, 2] }], filterOut: [{ when: [{ field: 'tag', ids: [5] }] }], picked: [1, 2, 3], keep: [9] },
      income: { only: [{ field: 'recurring', ids: 'any' }] },
    })
    expect(describeFilter(f, names)).toBe('Spending: Only Groceries, Dining · Filter out #trip-japan · Filter out 3 picked · Put back 1. Income: Only recurring')
    expect(describeFilter(null)).toBe('Everything')
  })
})

describe('report spec', () => {
  it('keeps a range, a comparison and a grouping, and knows when it was changed', () => {
    const saved = reportSpecSchema.parse({ range: '12m', filter: { spending: { picked: [1] } } })
    expect(saved).toMatchObject({ v: 1, range: '12m', compare: 'previous', groupBy: 'category' })
    expect(sameSpec({ ...saved, filter: parse({ spending: { picked: [1] }, income: {} }) }, saved)).toBe(true)
    expect(sameSpec({ ...saved, range: '6m' }, saved)).toBe(false)
    expect(sameSpec({ ...saved, compare: 'none' }, saved)).toBe(false)
    // Kept without a range: any range is the same report.
    const anyRange = reportSpecSchema.parse({})
    expect(sameSpec({ ...anyRange, range: '2025-01..2025-06' }, anyRange)).toBe(true)
    expect(reportSpecSchema.safeParse({ range: '2025-01..2028-01' }).success).toBe(false)
    expect(reportSpecSchema.safeParse({ range: 'ytd' }).success).toBe(true)
    // No more than the report endpoints take.
    const keys = Array.from({ length: 200 }, (_, i) => `a payee with a long name, number ${i}`)
    expect(reportSpecSchema.safeParse({ filter: { spending: { only: [{ field: 'payee', keys }] } } }).success).toBe(false)
  })
})
