import { describe, expect, it } from 'vitest'
import { comparePeriods } from './compare'
import type { CategoryAmount, PeriodSummary } from './models'

const cat = (categoryId: number | null, name: string, amountMinor: number, color = '#000000'): CategoryAmount => ({
  categoryId,
  name,
  color,
  groupId: null,
  groupName: null,
  amountMinor,
  count: 1,
})

const group = (groupId: number | null, name: string, categories: CategoryAmount[]) => ({
  groupId,
  name,
  amountMinor: categories.reduce((sum, c) => sum + c.amountMinor, 0),
  categories,
})

function summary(expenses: PeriodSummary['expenses']): PeriodSummary {
  const spentMinor = expenses.reduce((sum, g) => sum + g.amountMinor, 0)
  return {
    from: '2026-10-01',
    to: '2026-10-31',
    months: 1,
    incomeMinor: 0,
    spentMinor,
    netMinor: -spentMinor,
    income: [],
    expenses,
    excluded: { amountMinor: 0, categories: [] },
    labels: { items: [], unlabelledSpentMinor: 0 },
    transactionCount: 0,
    uncategorizedCount: 0,
    filteredOut: null,
  }
}

describe('comparePeriods', () => {
  it('shows groups and categories from either side, with 0 on the other', () => {
    const cur = summary([
      group(1, 'Food', [cat(10, 'Groceries', 300), cat(11, 'Dining', 200)]),
      group(2, 'Transport', [cat(20, 'Gas', 100)]),
    ])
    const prev = summary([
      group(1, 'Food', [cat(10, 'Groceries', 250), cat(12, 'Coffee', 50)]),
      group(3, 'Housing', [cat(30, 'Rent', 1000)]),
    ])
    expect(comparePeriods(cur, prev)).toEqual([
      {
        groupId: 3,
        name: 'Housing',
        currentMinor: 0,
        previousMinor: 1000,
        changeMinor: -1000,
        changePct: -1,
        categories: [
          { categoryId: 30, name: 'Rent', color: '#000000', currentMinor: 0, previousMinor: 1000, changeMinor: -1000, changePct: -1 },
        ],
      },
      {
        groupId: 1,
        name: 'Food',
        currentMinor: 500,
        previousMinor: 300,
        changeMinor: 200,
        changePct: 0.667,
        categories: [
          { categoryId: 11, name: 'Dining', color: '#000000', currentMinor: 200, previousMinor: 0, changeMinor: 200, changePct: null },
          { categoryId: 10, name: 'Groceries', color: '#000000', currentMinor: 300, previousMinor: 250, changeMinor: 50, changePct: 0.2 },
          { categoryId: 12, name: 'Coffee', color: '#000000', currentMinor: 0, previousMinor: 50, changeMinor: -50, changePct: -1 },
        ],
      },
      {
        groupId: 2,
        name: 'Transport',
        currentMinor: 100,
        previousMinor: 0,
        changeMinor: 100,
        changePct: null,
        categories: [
          { categoryId: 20, name: 'Gas', color: '#000000', currentMinor: 100, previousMinor: 0, changeMinor: 100, changePct: null },
        ],
      },
    ])
  })

  it('matches the no-group group and Uncategorized by their null ids', () => {
    const cur = summary([group(null, 'Other', [cat(40, 'Gifts', 100), cat(null, 'Uncategorized', 500)])])
    const prev = summary([group(null, 'Other', [cat(null, 'Uncategorized', 300)])])
    const [other] = comparePeriods(cur, prev)
    expect(other).toMatchObject({ groupId: null, currentMinor: 600, previousMinor: 300, changeMinor: 300 })
    expect(other?.categories.map((c) => [c.categoryId, c.changeMinor])).toEqual([
      [null, 200],
      [40, 100],
    ])
  })

  it('names a row from the current side when it has one', () => {
    const cur = summary([group(1, 'Eating', [cat(11, 'Dining', 200, '#ff0000')])])
    const prev = summary([group(1, 'Food', [cat(11, 'Restaurants', 100, '#00ff00')]), group(2, 'Gone', [cat(20, 'Old', 5, '#0000ff')])])
    const [eating, gone] = comparePeriods(cur, prev)
    expect(eating).toMatchObject({ name: 'Eating', categories: [{ name: 'Dining', color: '#ff0000' }] })
    expect(gone).toMatchObject({ name: 'Gone', categories: [{ name: 'Old', color: '#0000ff' }] })
  })

  it('keeps the current order on equal changes', () => {
    const cur = summary([group(1, 'A', [cat(1, 'a', 100)]), group(2, 'B', [cat(2, 'b', 300)])])
    const prev = summary([group(2, 'B', [cat(2, 'b', 200)]), group(1, 'A', [cat(1, 'a', 200)]), group(3, 'C', [cat(3, 'c', 100)])])
    expect(comparePeriods(cur, prev).map((g) => g.name)).toEqual(['A', 'B', 'C'])
  })

  it('rounds the change to 3 decimals, and has none from nothing', () => {
    const pct = (current: number, previous: number) => {
      const [g] = comparePeriods(summary([group(1, 'G', [cat(1, 'c', current)])]), summary([group(1, 'G', [cat(1, 'c', previous)])]))
      return g?.changePct
    }
    expect(pct(400, 300)).toBe(0.333)
    expect(pct(200, 300)).toBe(-0.333)
    expect(pct(1000, 300)).toBe(2.333)
    expect(pct(299_999, 300_000)).toBe(0)
    expect(pct(500, 0)).toBeNull()
    expect(pct(0, 0)).toBeNull()
  })
})
