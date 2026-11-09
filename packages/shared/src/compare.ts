import type { PeriodSummary } from './models'

export type CompareRow = {
  categoryId: number | null
  name: string
  color: string
  currentMinor: number
  previousMinor: number
  changeMinor: number
  changePct: number | null
}
export type CompareGroup = {
  groupId: number | null
  name: string
  currentMinor: number
  previousMinor: number
  changeMinor: number
  changePct: number | null
  categories: CompareRow[]
}

type Amounts = { currentMinor: number; previousMinor: number }

function change({ currentMinor, previousMinor }: Amounts) {
  const changeMinor = currentMinor - previousMinor
  // `|| 0` so a tiny drop doesn't show as -0%
  const changePct = previousMinor === 0 ? null : Math.round((changeMinor / previousMinor) * 1000) / 1000 || 0
  return { currentMinor, previousMinor, changeMinor, changePct }
}

const byChange = <T extends { changeMinor: number }>(rows: T[]) =>
  rows.sort((a, b) => Math.abs(b.changeMinor) - Math.abs(a.changeMinor))

/**
 * Spending by group and category in two periods side by side. A group or category in only one of
 * them shows with 0 in the other. Sorted by the size of the change, largest first.
 */
export function comparePeriods(cur: PeriodSummary, prev: PeriodSummary): CompareGroup[] {
  type Category = Amounts & { name: string; color: string }
  const groups = new Map<number | null, Amounts & { name: string; categories: Map<number | null, Category> }>()
  const add = (summary: PeriodSummary, side: keyof Amounts) => {
    for (const g of summary.expenses) {
      let group = groups.get(g.groupId)
      if (!group) groups.set(g.groupId, (group = { name: g.name, currentMinor: 0, previousMinor: 0, categories: new Map() }))
      group[side] += g.amountMinor
      for (const c of g.categories) {
        let row = group.categories.get(c.categoryId)
        if (!row) group.categories.set(c.categoryId, (row = { name: c.name, color: c.color, currentMinor: 0, previousMinor: 0 }))
        row[side] += c.amountMinor
      }
    }
  }
  // The current side first, so its names, colours and order win
  add(cur, 'currentMinor')
  add(prev, 'previousMinor')
  return byChange(
    [...groups].map(([groupId, g]) => ({
      groupId,
      name: g.name,
      ...change(g),
      categories: byChange([...g.categories].map(([categoryId, c]) => ({ categoryId, name: c.name, color: c.color, ...change(c) }))),
    })),
  )
}
