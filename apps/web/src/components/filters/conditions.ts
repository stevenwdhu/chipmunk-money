import {
  normalizeFilter,
  type Condition,
  type ConditionField,
  type FilterSide,
  type FilterSideFilter,
  type ReportFilter,
  type Rule,
  type TransactionPage,
} from '@chipmunk/shared'
import { money } from '@/lib/format'
import { lapi } from '@/lib/ledger'

/** What a condition can be on, as the builder's field select names it. */
export const FIELDS: ReadonlyArray<{ value: ConditionField; label: string }> = [
  { value: 'category', label: 'Category' },
  { value: 'group', label: 'Group' },
  { value: 'label', label: 'Label' },
  { value: 'tag', label: 'Tag' },
  { value: 'payee', label: 'Payee' },
  { value: 'text', label: 'Words' },
  { value: 'amount', label: 'Amount' },
  { value: 'account', label: 'Account' },
  { value: 'recurring', label: 'Recurring' },
]

/** Fields Only count takes once each (a second one would be merged into the first). */
export const ONCE_IN_ONLY: ReadonlySet<ConditionField> = new Set<ConditionField>(['category', 'group', 'label', 'payee', 'account', 'recurring'])

/** Filter out a charge (or deposit) of $1,000 or more that isn't a recurring item's. */
export const BIG_ONE_TIME: Rule = { when: [{ field: 'amount', min: 100000 }, { field: 'recurring', ids: 'none' }] }

/** A condition with nothing picked yet, for a new row. */
export function emptyCondition(field: ConditionField): Condition {
  switch (field) {
    case 'category':
    case 'group':
    case 'label':
      return { field, ids: [] }
    case 'tag':
      return { field, ids: [] }
    case 'account':
      return { field, ids: [] }
    case 'payee':
      return { field, keys: [] }
    case 'text':
      return { field, words: [] }
    case 'amount':
      return { field }
    case 'recurring':
      return { field, ids: [] }
  }
}

/** It has what it needs to apply. A row without it waits in the builder and isn't part of the filter yet. */
export function isComplete(c: Condition): boolean {
  switch (c.field) {
    case 'payee':
      return c.keys.length > 0
    case 'text':
      return c.words.length > 0
    case 'amount':
      return (c.min !== undefined || c.max !== undefined) && (c.min === undefined || c.max === undefined || c.min <= c.max)
    case 'recurring':
      return !Array.isArray(c.ids) || c.ids.length > 0
    default:
      return c.ids.length > 0
  }
}

/**
 * The builder's copy of a filter: rows keep a key (for the list and for opening a new row's editor),
 * and a row can wait for its value. `fresh` marks a condition just added to a rule with "+ and…": until
 * it has a value, the rule goes on applying without it. Any other row waiting in a rule holds the
 * whole rule back, as applying the rest alone would filter out more than it says.
 */
export type DraftRow = { key: number; c: Condition; fresh?: boolean }
export type DraftRule = { key: number; when: DraftRow[]; label?: string }
export type DraftSide = { only: DraftRow[]; filterOut: DraftRule[]; picked: number[]; keep: number[] }
export type Draft = Record<FilterSide, DraftSide>

let lastKey = 0
export const draftRow = (c: Condition): DraftRow => ({ key: ++lastKey, c })
export const draftRule = (when: Condition[], label?: string): DraftRule => ({
  key: ++lastKey,
  when: when.map(draftRow),
  ...(label && { label }),
})

function draftSide(s: FilterSideFilter | undefined): DraftSide {
  return {
    only: (s?.only ?? []).map(draftRow),
    filterOut: (s?.filterOut ?? []).map((r) => draftRule(r.when, r.label)),
    picked: [...(s?.picked ?? [])],
    keep: [...(s?.keep ?? [])],
  }
}

export const toDraft = (f: ReportFilter): Draft => ({ spending: draftSide(f.spending), income: draftSide(f.income) })

const applies = (r: DraftRow) => isComplete(r.c)
const ruleApplies = (r: DraftRule) => r.when.some(applies) && r.when.every((x) => applies(x) || x.fresh)

function sideFilter(d: DraftSide): FilterSideFilter {
  return {
    only: d.only.filter(applies).map((r) => r.c),
    filterOut: d.filterOut
      .filter(ruleApplies)
      .map((r) => ({ when: r.when.filter(applies).map((x) => x.c), ...(r.label && { label: r.label }) })),
    picked: d.picked,
    keep: d.keep,
  }
}

/** The filter the draft stands for: rows still waiting for a value left out, along with the rules they hold back. */
export const fromDraft = (d: Draft): ReportFilter => normalizeFilter({ v: 1, spending: sideFilter(d.spending), income: sideFilter(d.income) })

/** A row's place among the ones that apply (as the filter, the chips and byRule count them), or -1 while it waits. */
export function appliedIndex(d: DraftSide, kind: 'only' | 'rule', i: number): number {
  const list: boolean[] = kind === 'only' ? d.only.map(applies) : d.filterOut.map(ruleApplies)
  return list[i] ? list.slice(0, i).filter(Boolean).length : -1
}

/** The draft row at a place among the ones that apply (the other way round). */
export function draftIndex(d: DraftSide, kind: 'only' | 'rule', applied: number): number {
  const list: boolean[] = kind === 'only' ? d.only.map(applies) : d.filterOut.map(ruleApplies)
  let n = -1
  return list.findIndex((ok) => ok && ++n === applied)
}

/** Whole dollars, as the builder's figures show them: "$4,210". */
export const wholeMoney = (minor: number) => money(Math.round(minor / 100) * 100 || 0).replace(/\.00$/, '')

/** What a rule filters out: "6 · $4,210". */
export const figure = (f: { count: number; amountMinor: number }) => `${f.count} · ${wholeMoney(f.amountMinor)}`

export const sideNoun = (side: FilterSide, n: number) => (side === 'spending' ? (n === 1 ? 'purchase' : 'purchases') : n === 1 ? 'deposit' : 'deposits')

/**
 * Which of these transactions one of the side's Filter out rules filters out (Only count aside): put
 * back, they're kept counted, and the rest just stop being picked. The list can't be asked for ids,
 * so it's asked one day at a time (a day has few transactions).
 */
export async function matchedByRules(side: FilterSide, rules: Rule[], txs: Array<{ id: number; date: string }>): Promise<Set<number>> {
  if (!rules.length || !txs.length) return new Set()
  const filter = JSON.stringify({ [side]: { filterOut: rules } })
  const days = [...new Set(txs.map((t) => t.date))]
  const found = new Set<number>()
  for (let i = 0; i < days.length; i += 6) {
    const pages = await Promise.all(
      days.slice(i, i + 6).map((d) => lapi.get<TransactionPage>('/transactions', { filter, filteredOut: true, from: d, to: d, limit: 500 })),
    )
    for (const p of pages) for (const t of p.items) found.add(t.id)
  }
  return new Set(txs.filter((t) => found.has(t.id)).map((t) => t.id))
}
