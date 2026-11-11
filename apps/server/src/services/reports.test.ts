import { describe, expect, it } from 'vitest'
import { filterSchema, transactionCreateSchema } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext, testLedger, testStorage } from '../test/helpers'
import { accountHistory, listAccounts, setBalance } from './accounts'
import { leaveSharedList } from './catalog'
import { getCategory, listCategories, updateCategory } from './categories'
import { applyLabel, createLabel, deleteLabel, updateLabel } from './labels'
import { exportRows, monthSummary, netWorth, periodSummary, purchases, tagTotals, topPayees, trend } from './reports'
import type { AppContext } from './context'
import { createTransaction, listTransactions, transactionSpan } from './transactions'

const tx = (input: Record<string, unknown>) => transactionCreateSchema.parse(input)

describe('reports', () => {
  it('exports a transaction’s tags in the order they were made', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: -100, payee: 'Shop', tags: ['zeta', 'alpha'] }), { useAi: false })
    expect(exportRows(ctx).map((r) => r.tags)).toEqual(['zeta alpha'])
  })

  it('computes spending and income with refunds, transfers and uncategorized rows', async () => {
    const ctx = testContext()
    const chequing = makeAccount(ctx, 'Chequing', 'chequing', 500_000)
    const card = makeAccount(ctx, 'Card', 'credit')
    const add = (input: Record<string, unknown>) => createTransaction(ctx, tx({ accountId: chequing, useAi: false, ...input }), { useAi: false })
    await add({ date: '2026-09-29', amountMinor: 307_500, payee: 'Acme payroll', categoryId: categoryId(ctx, 'Salary') })
    await add({ date: '2026-09-01', amountMinor: -185_000, payee: 'Rent', categoryId: categoryId(ctx, 'Rent') })
    await add({ date: '2026-09-10', amountMinor: -10_000, payee: 'Shoes', categoryId: categoryId(ctx, 'General shopping') })
    await add({ date: '2026-09-12', amountMinor: 2_500, payee: 'Shoes refund', categoryId: categoryId(ctx, 'General shopping') })
    await add({ date: '2026-09-13', amountMinor: -1_000, payee: 'Mystery' })
    await add({ date: '2026-09-14', amountMinor: -50_000, payee: 'Card payment', transferAccountId: card })
    await add({ date: '2026-08-15', amountMinor: -60_000, payee: 'Rent', categoryId: categoryId(ctx, 'Rent') })

    const s = monthSummary(ctx, '2026-09')
    expect(s.spentMinor).toBe(185_000 + 10_000 - 2_500 + 1_000)
    expect(s.incomeMinor).toBe(307_500)
    expect(s.netMinor).toBe(307_500 - 193_500)
    expect(s.previousSpentMinor).toBe(60_000)
    expect(s.averageSpentMinor).toBe(20_000)
    expect(s.byCategory.find((c) => c.name === 'General shopping')?.amountMinor).toBe(7_500)
    expect(s.byCategory.find((c) => c.name === 'Uncategorized')?.amountMinor).toBe(1_000)
    expect(s.uncategorizedCount).toBe(1)

    const t = trend(ctx, '2026-09', 2, 'group')
    expect(t.points.map((p) => p.spentMinor)).toEqual([60_000, 193_500])
    expect(t.series[0]?.name).toBe('Housing')

    // The same month as a period: categories grouped, transfers listed apart (both sides net to zero).
    const p = periodSummary(ctx, '2026-09-01', '2026-09-30')
    expect([p.incomeMinor, p.spentMinor, p.netMinor, p.months]).toEqual([307_500, 193_500, 114_000, 1])
    expect(p.income.map((c) => [c.name, c.amountMinor])).toEqual([['Salary', 307_500]])
    expect(p.expenses.map((g) => [g.name, g.amountMinor])).toEqual([
      ['Housing', 185_000],
      ['Shopping', 7_500],
      ['Other', 1_000],
    ])
    expect(p.expenses.at(-1)?.categories.map((c) => c.name)).toEqual(['Uncategorized'])
    expect(p.excluded).toMatchObject({ amountMinor: 0, categories: [{ name: 'Credit card payment', count: 2 }] })

    // All time: from the first transaction to today.
    const all = periodSummary(ctx)
    expect([all.from, all.to, all.months, all.spentMinor]).toEqual(['2026-08-15', '2026-10-03', 3, 253_500])
    expect(transactionSpan(ctx)).toEqual({ first: '2026-08-15', last: '2026-09-29' })
  })

  it('tracks net worth from balances, and charts a credit card by each month’s spending', async () => {
    const ctx = testContext()
    const chequing = makeAccount(ctx, 'Chequing', 'chequing', 100_000)
    const card = makeAccount(ctx, 'Card', 'credit', 0)
    const tfsa = makeAccount(ctx, 'TFSA', 'investment', 0)
    setBalance(ctx, tfsa, { date: '2026-08-31', balanceMinor: 1_000_000 })
    setBalance(ctx, tfsa, { date: '2026-09-30', balanceMinor: 1_050_000 })
    const add = (input: Record<string, unknown>) => createTransaction(ctx, tx({ accountId: card, useAi: false, ...input }), { useAi: false })
    await add({ date: '2026-08-10', amountMinor: -10_000, payee: 'August stuff' })
    await add({ date: '2026-09-05', amountMinor: -20_000, payee: 'September stuff' })
    // Paying August's bill moves money out of chequing; on the card it's a transfer, not less spending.
    await add({ accountId: chequing, date: '2026-09-15', amountMinor: -10_000, payee: 'Card payment', transferAccountId: card })
    await add({ date: '2026-10-02', amountMinor: -5_000, payee: 'October stuff' })

    const nw = netWorth(ctx, 3)
    expect(nw.points.map((p) => p.date)).toEqual(['2026-08-31', '2026-09-30', '2026-10-03'])
    // Liabilities are what's owed on the card at each date.
    expect(nw.points.map((p) => p.liabilitiesMinor)).toEqual([10_000, 20_000, 25_000])
    expect(nw.points.map((p) => p.netWorthMinor)).toEqual([1_090_000, 1_120_000, 1_115_000])
    expect(nw.byAccount.find((a) => a.accountId === card)).toMatchObject({ balanceMinor: -25_000 })

    // The card's own page shows this month's spending; its chart, each month's.
    const accounts = listAccounts(ctx)
    expect(accounts.map((a) => [a.name, a.balanceMinor, a.monthMinor])).toEqual([
      ['Chequing', 90_000, 0],
      ['Card', -25_000, -5_000],
      ['TFSA', 1_050_000, 0],
    ])
    expect(accountHistory(ctx, card, 3, '2026-10-03')).toEqual([
      { date: '2026-08-31', balanceMinor: -10_000, monthMinor: -10_000 },
      { date: '2026-09-30', balanceMinor: -20_000, monthMinor: -20_000 },
      { date: '2026-10-03', balanceMinor: -25_000, monthMinor: -5_000 },
    ])
  })

  it('sorts spending by your own category labels', async () => {
    const ctx = testContext()
    // Labels are edited in a ledger with its own list (the shared list's in App settings).
    leaveSharedList(ctx)
    const chequing = makeAccount(ctx, 'Chequing', 'chequing', 500_000)
    const savings = makeAccount(ctx, 'Savings', 'savings', 0)
    const [groceries, dining, shopping, paycheque] = ['Groceries', 'Dine out', 'General shopping', 'Salary'].map((n) => categoryId(ctx, n)) as [number, number, number, number]

    // New ledgers come with Needs and Wants labels on the default categories; this test makes its own.
    const defaults = listCategories(ctx).labels
    expect(defaults.map((l) => l.name)).toEqual(['Needs', 'Wants'])
    expect(getCategory(ctx, groceries).labelIds).toEqual([defaults[0]!.id])
    for (const l of defaults) deleteLabel(ctx, l.id)

    const need = createLabel(ctx, { name: 'Need', color: '#2563eb' })
    const want = createLabel(ctx, { name: 'Want' })
    // Without a colour, one that no other label has.
    expect(want.color).not.toBe(need.color)
    expect(() => createLabel(ctx, { name: 'need' })).toThrow(/already a label called “Need”/)
    // Several categories at once, or one category's own labels.
    expect(applyLabel(ctx, want.id, { add: [dining, shopping], remove: [] }).categoryCount).toBe(2)
    updateCategory(ctx, groceries, { labelIds: [need.id] })
    const work = createLabel(ctx, { name: 'Work' })
    updateCategory(ctx, dining, { labelIds: [want.id, work.id] })
    applyLabel(ctx, work.id, { add: [paycheque], remove: [] })
    expect(getCategory(ctx, dining).labelIds).toEqual([want.id, work.id])
    expect(listCategories(ctx).labels.map((l) => [l.name, l.categoryCount])).toEqual([
      ['Need', 1],
      ['Want', 2],
      ['Work', 2],
    ])

    const add = (input: Record<string, unknown>) => createTransaction(ctx, tx({ accountId: chequing, date: '2026-09-10', useAi: false, ...input }), { useAi: false })
    await add({ amountMinor: -10_000, payee: 'Loblaws', categoryId: groceries })
    await add({ amountMinor: 1_000, payee: 'Loblaws refund', categoryId: groceries })
    await add({ amountMinor: -5_000, payee: 'Pizza place', categoryId: dining })
    await add({ amountMinor: -2_000, payee: 'Shoes', categoryId: shopping })
    await add({ amountMinor: -1_500, payee: 'Gym', categoryId: categoryId(ctx, 'Sports & fitness') })
    await add({ amountMinor: -500, payee: 'Mystery' })
    await add({ amountMinor: 300_000, payee: 'Payroll', categoryId: paycheque })
    await add({ amountMinor: -50_000, payee: 'To savings', transferAccountId: savings })

    // A category with two labels counts under both; transfers count under none.
    const p = periodSummary(ctx, '2026-09-01', '2026-09-30')
    expect(p.labels.items.map((l) => [l.name, l.spentMinor, l.incomeMinor])).toEqual([
      ['Need', 9_000, 0],
      ['Want', 7_000, 0],
      ['Work', 5_000, 300_000],
    ])
    expect(p.labels.unlabelledSpentMinor).toBe(2_000)

    const payees = (labelId: number | 'none') => listTransactions(ctx, { limit: 50, labelId }).items.map((t) => t.payee).sort()
    expect(payees(need.id)).toEqual(['Loblaws', 'Loblaws refund'])
    expect(payees(work.id)).toEqual(['Payroll', 'Pizza place'])
    expect(payees('none')).toEqual(['Gym', 'Mystery'])

    // Renaming keeps it unique; deleting it just takes it off its categories.
    expect(() => updateLabel(ctx, work.id, { name: 'WANT' })).toThrow(/already a label/)
    deleteLabel(ctx, want.id)
    expect(getCategory(ctx, dining).labelIds).toEqual([work.id])
    expect(periodSummary(ctx, '2026-09-01', '2026-09-30').labels.items.map((l) => l.name)).toEqual(['Need', 'Work'])
  })
})

describe('reports in two ledgers', () => {
  /** The same accounts, payees, categories and tag in a ledger, with amounts scaled by `x`. */
  async function fill(ctx: AppContext, x: number) {
    const chequing = makeAccount(ctx, 'Chequing', 'chequing', 100_000 * x)
    const card = makeAccount(ctx, 'Card', 'credit')
    const add = (input: Record<string, unknown>) => createTransaction(ctx, tx({ accountId: chequing, useAi: false, ...input }), { useAi: false })
    await add({ date: '2026-09-01', amountMinor: 300_000 * x, payee: 'Acme payroll', categoryId: categoryId(ctx, 'Salary') })
    await add({ date: '2026-09-05', amountMinor: -12_000 * x, payee: 'Shop', categoryId: categoryId(ctx, 'Groceries'), tags: ['trip'] })
    await add({ date: '2026-09-06', amountMinor: -3_000 * x, payee: 'Cafe', categoryId: categoryId(ctx, 'Dine out') })
    await add({ date: '2026-09-07', amountMinor: -40_000 * x, payee: 'Card payment', transferAccountId: card })
    await add({ date: '2026-08-20', amountMinor: -5_000 * x, payee: 'Shop', categoryId: categoryId(ctx, 'Groceries') })
    return { chequing, card }
  }

  /** Every report of a ledger, filtered and not. */
  const everything = (ctx: AppContext) => {
    const groceries = filterSchema.parse({ spending: { only: [{ field: 'category', ids: [categoryId(ctx, 'Groceries')] }] } })
    return {
      month: monthSummary(ctx, '2026-09'),
      period: periodSummary(ctx, '2026-08-01', '2026-09-30'),
      filtered: periodSummary(ctx, '2026-08-01', '2026-09-30', groceries),
      allTime: periodSummary(ctx),
      trend: trend(ctx, '2026-09', 3, 'category'),
      payees: topPayees(ctx, '2026-08-01', '2026-09-30'),
      tags: tagTotals(ctx, '2026-08-01', '2026-09-30'),
      purchases: purchases(ctx, { from: '2026-08-01', to: '2026-09-30' }),
      netWorth: netWorth(ctx, 3),
      exported: exportRows(ctx),
    }
  }

  it('each counts only its own money, payees, tags and accounts', async () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    await fill(a, 1)
    const alone = everything(a)
    expect(alone.month).toMatchObject({ spentMinor: 15_000, incomeMinor: 300_000, transactionCount: 3 })

    // A second ledger with the same names (and the same shared categories), its amounts doubled.
    await fill(b, 2)
    expect(everything(a)).toEqual(alone)
    const twin = everything(b)
    expect(twin.month).toMatchObject({ spentMinor: 30_000, incomeMinor: 600_000, transactionCount: 3 })
    expect(twin.payees.map((p) => [p.payee, p.amountMinor])).toEqual([
      ['Shop', 34_000],
      ['Cafe', 6_000],
    ])
    expect(twin.tags).toEqual([expect.objectContaining({ name: 'trip', spentMinor: 24_000, count: 1 })])
    expect(twin.netWorth.byAccount.map((x) => x.accountId)).toEqual(listAccounts(b).map((x) => x.id))
    // Its chequing account: opening, pay, spending, and the card payment. The card's balance is a debt.
    expect(twin.netWorth.current).toMatchObject({ assetsMinor: 200_000 + 600_000 - 24_000 - 6_000 - 80_000 - 10_000, liabilitiesMinor: -80_000 })
    expect(twin.exported).toHaveLength(6)
    expect(twin.purchases.items.map((i) => i.transaction.id)).not.toContain(alone.purchases.items[0]!.transaction.id)
  })
})
