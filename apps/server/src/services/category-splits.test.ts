import { describe, expect, it } from 'vitest'
import { filterSchema, recurringCreateSchema, transactionCreateSchema, type ApiKeyCreated } from '@chipmunk/shared'
import { createApp } from '../app'
import { fakeBridge, fakeTx, TOKEN, type FakeCard } from '../test/fake-bridge'
import { categoryId, makeAccount, testContext, testLedger, testStorage } from '../test/helpers'
import { expectNoCrossLedgerReferences, sharedWorld, TESTER } from '../test/shared-accounts'
import { deleteCatalogCategory, mergeCatalogCategory } from './catalog-edit'
import { joinSharedList, leaveSharedList } from './catalog'
import { deleteCategory, deleteGroup, mergeCategory, setCategoryEnabled } from './categories'
import { setParts } from './category-splits'
import type { AppContext } from './context'
import { categorizeUncategorized } from './import'
import { setLinks } from './links'
import { matchTransactions } from './matching'
import { moveTransactions, sendAsDeleted } from './moves'
import { setPayeeChoice } from './payees'
import { addPayment, createRecurring, getRecurring } from './recurring'
import { byCategory, exportRows, monthSummary, periodSummary, purchases, tagTotals, topPayees, trend } from './reports'
import { setSplit } from './splits'
import { monthToDate } from './totals'
import { bulkUpdate, createTransaction, deleteTransaction, getTransaction, insertTransaction, listTransactions, restoreTransaction, updateTransaction } from './transactions'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A transaction split into categories (category-splits.ts), through the services: what reports count
 * for each part, and every rule that keeps a split right when something under it changes.
 */

const add = (ctx: AppContext, accountId: number, date: string, amountMinor: number, payee: string, category: string | null = null) =>
  insertTransaction(ctx, transactionCreateSchema.parse({ accountId, date, amountMinor, payee, categoryId: category && categoryId(ctx, category) }), {
    origin: 'manual',
    skipRecurring: true,
    suggestion: null,
  })

/** What each category comes to in September 2026, as reports count it. */
const spent = (ctx: AppContext, filter?: Json) => Object.fromEntries(byCategory(ctx, '2026-09-01', '2026-09-30', 'expense', filter).map((c) => [c.name, c.amountMinor]))

/** A split's parts as [category name, amount, note]. */
const parts = (ctx: AppContext, id: number) =>
  getTransaction(ctx, id).parts?.map((p) => [p.categoryId === null ? null : ctx.q.pluck<string>('SELECT name FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', p.categoryId)!, p.amountMinor, p.note]) ??
  null

const categoryOf = (ctx: AppContext, id: number) => {
  const t = getTransaction(ctx, id)
  return [t.categoryId === null ? null : ctx.q.pluck<string>('SELECT name FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', t.categoryId), t.categorySource, t.needsReview]
}

/** Costco, $100 on September 10, in Groceries: split as Groceries $62.10, Household supplies $18.40 and Dine out $19.50. */
function costco(ctx: AppContext = testContext(), account = makeAccount(ctx, 'Chequing')) {
  const id = add(ctx, account, '2026-09-10', -10_000, 'Costco', 'Groceries')
  const split = (...list: Array<[string | null, number, string?]>) =>
    setParts(
      ctx,
      id,
      list.map(([category, amountMinor, note]) => ({ categoryId: category === null ? null : categoryId(ctx, category), amountMinor, note })),
    )
  const three = () => split(['Groceries', -6_210], ['Household supplies', -1_840, 'bags'], ['Dine out', -1_950])
  return { ctx, account, id, split, three }
}

describe('splitting a transaction into categories', () => {
  it('counts each part in its own category in every report, and the transaction once', () => {
    const { ctx, account, id, three } = costco()
    updateTransaction(ctx, id, { tags: ['bulk'] })
    const before = {
      month: monthSummary(ctx, '2026-09'),
      period: periodSummary(ctx, '2026-09-01', '2026-09-30'),
      trend: trend(ctx, '2026-09', 1, 'group'),
    }
    expect(spent(ctx)).toEqual({ Groceries: 10_000 })
    expect(before.period.expenses.map((g) => [g.name, g.amountMinor])).toEqual([['Food', 10_000]])
    expect(before.period.labels.items.filter((l) => l.spentMinor).map((l) => [l.name, l.spentMinor])).toEqual([['Needs', 10_000]])
    expect(before.trend.series.map((s) => [s.name, s.totalMinor])).toEqual([['Food', 10_000]])

    three()
    // By category: 62.10 + 18.40 + 19.50 = 100.
    expect(spent(ctx)).toEqual({ Groceries: 6_210, 'Dine out': 1_950, 'Household supplies': 1_840 })
    expect(byCategory(ctx, '2026-09-01', '2026-09-30').map((c) => c.count)).toEqual([1, 1, 1])
    // The month and the overview: the same total, one transaction.
    const month = monthSummary(ctx, '2026-09')
    expect([month.spentMinor, month.transactionCount, month.uncategorizedCount]).toEqual([10_000, 1, 0])
    expect(month.byCategory.map((c) => [c.name, c.amountMinor])).toEqual([
      ['Groceries', 6_210],
      ['Dine out', 1_950],
      ['Household supplies', 1_840],
    ])
    // By group: Food is Groceries and Dine out, 62.10 + 19.50, and Housing 18.40.
    const period = periodSummary(ctx, '2026-09-01', '2026-09-30')
    expect(period.expenses.map((g) => [g.name, g.amountMinor])).toEqual([
      ['Food', 8_160],
      ['Housing', 1_840],
    ])
    expect([period.spentMinor, period.transactionCount]).toEqual([10_000, 1])
    // By label: Needs is Groceries and Household supplies, 62.10 + 18.40, and Wants 19.50.
    expect(period.labels.items.filter((l) => l.spentMinor).map((l) => [l.name, l.spentMinor])).toEqual([
      ['Needs', 8_050],
      ['Wants', 1_950],
    ])
    expect(period.labels.unlabelledSpentMinor).toBe(0)
    // Trends by group and by category.
    expect(trend(ctx, '2026-09', 1, 'group').series.map((s) => [s.name, s.totalMinor])).toEqual([
      ['Food', 8_160],
      ['Housing', 1_840],
    ])
    expect(trend(ctx, '2026-09', 1, 'category').series.map((s) => [s.name, s.totalMinor])).toEqual([
      ['Groceries', 6_210],
      ['Dine out', 1_950],
      ['Household supplies', 1_840],
    ])
    expect(trend(ctx, '2026-09', 1, 'category').points[0]).toMatchObject({ spentMinor: 10_000 })
    // By payee and by tag it's one purchase of $100.
    expect(topPayees(ctx, '2026-09-01', '2026-09-30').map((p) => [p.payeeKey, p.amountMinor, p.count])).toEqual([['costco', 10_000, 1]])
    expect(tagTotals(ctx, '2026-09-01', '2026-09-30').map((t) => [t.name, t.spentMinor, t.count])).toEqual([['bulk', 10_000, 1]])
    expect(purchases(ctx, { from: '2026-09-01', to: '2026-09-30' })).toMatchObject({ totalMinor: 10_000, count: 1, items: [{ inRangeMinor: 10_000, shareMinor: 10_000 }] })
    // The account's month to date is the whole of it.
    expect(monthToDate(ctx, ['2026-09-30'], account).get(account)).toEqual([-10_000])

    // The transaction itself: one row, its parts in order, its own category its largest part's, as yours.
    const t = getTransaction(ctx, id)
    expect(t.amountMinor).toBe(-10_000)
    expect(parts(ctx, id)).toEqual([
      ['Groceries', -6_210, null],
      ['Household supplies', -1_840, 'bags'],
      ['Dine out', -1_950, null],
    ])
    expect(categoryOf(ctx, id)).toEqual(['Groceries', 'user', false])
    expect(listTransactions(ctx, { limit: 50 } as never).items.map((x) => x.id)).toEqual([id])
  })

  it('counts only the part a filter is about, and lists the transaction by any part’s category', () => {
    const { ctx, id, three } = costco()
    const other = add(ctx, makeAccount(ctx, 'Card', 'credit'), '2026-09-11', -500, 'Cafe', 'Dine out')
    three()
    const only = (name: string) => filterSchema.parse({ v: 1, spending: { only: [{ field: 'category', ids: [categoryId(ctx, name)] }] } })
    // A custom report of Household supplies counts $18.40 of it, and of Dine out its $19.50 and the cafe.
    expect(spent(ctx, only('Household supplies'))).toEqual({ 'Household supplies': 1_840 })
    expect(periodSummary(ctx, '2026-09-01', '2026-09-30', only('Household supplies'))).toMatchObject({ spentMinor: 1_840, transactionCount: 1 })
    expect(periodSummary(ctx, '2026-09-01', '2026-09-30', only('Dine out'))).toMatchObject({ spentMinor: 2_450, transactionCount: 2 })
    // What a filter leaves out: Groceries filtered out is $62.10 of one purchase.
    const out = filterSchema.parse({ v: 1, spending: { filterOut: [{ when: [{ field: 'category', ids: [categoryId(ctx, 'Groceries')] }] }] } })
    const filtered = periodSummary(ctx, '2026-09-01', '2026-09-30', out)
    expect([filtered.spentMinor, filtered.filteredOut?.spending.amountMinor, filtered.filteredOut?.spending.count]).toEqual([4_290, 6_210, 1])
    // The purchases of a filter: the part's amount in range, of a purchase whose share is all of it.
    expect(purchases(ctx, { from: '2026-09-01', to: '2026-09-30', filter: only('Household supplies') })).toMatchObject({
      totalMinor: 1_840,
      items: [{ transaction: { id }, inRangeMinor: 1_840, shareMinor: 10_000 }],
    })

    // The list, by category: any part's, with the parts on it for the totals bar.
    const listed = (q: Record<string, unknown>) => listTransactions(ctx, { limit: 50, ...q } as never).items.map((t) => t.id)
    expect(listed({ categoryId: [categoryId(ctx, 'Household supplies')] })).toEqual([id])
    expect(listed({ categoryId: [categoryId(ctx, 'Dine out')] })).toEqual([other, id])
    expect(listed({ categoryId: [categoryId(ctx, 'Rent')] })).toEqual([])
    expect(listed({ categoryId: ['none'] })).toEqual([])
    expect(listed({ filter: only('Household supplies') })).toEqual([id])
    expect(listTransactions(ctx, { limit: 50, categoryId: [categoryId(ctx, 'Household supplies')] } as never).items[0]!.parts).toHaveLength(3)
    // By label: Wants has Dine out, which is a part of it.
    const wants = ctx.q.pluck<number>("SELECT id FROM ledger_labels WHERE ledger_id = @ledger AND name = 'Wants'")!
    expect(listed({ labelId: wants })).toEqual([other, id])
    // A part with no category is found as uncategorized, and counted there.
    setParts(ctx, id, [
      { categoryId: categoryId(ctx, 'Groceries'), amountMinor: -9_000 },
      { categoryId: null, amountMinor: -1_000 },
    ])
    expect(listed({ categoryId: ['none'] })).toEqual([id])
    expect(listed({ labelId: 'none' })).toEqual([id])
    expect(spent(ctx)).toEqual({ Groceries: 9_000, Uncategorized: 1_000, 'Dine out': 500 })
    expect(monthSummary(ctx, '2026-09').uncategorizedCount).toBe(1)
  })

  it('leaves a part in a category left out of totals out of them', () => {
    const { ctx, account, split } = costco()
    split(['Groceries', -7_000], ['Transfer', -3_000])
    const period = periodSummary(ctx, '2026-09-01', '2026-09-30')
    expect(period.spentMinor).toBe(7_000)
    expect(period.excluded).toMatchObject({ amountMinor: -3_000, categories: [{ name: 'Transfer', count: 1 }] })
    expect(monthToDate(ctx, ['2026-09-30'], account).get(account)).toEqual([-7_000])
  })

  it('takes a refund linked in full, in part, and a payback off each part by its share, to the cent', () => {
    const { ctx, account, id, three } = costco()
    three()
    // $10.01 back, all of it for the purchase: 6.22 + 1.84 + 1.95 (the last part takes what rounding leaves).
    const refund = add(ctx, account, '2026-09-12', 1_001, 'Costco')
    setLinks(ctx, refund, [{ transactionId: id, amountMinor: 1_001, kind: 'refund' }])
    expect(spent(ctx)).toEqual({ Groceries: 6_210 - 622, 'Dine out': 1_950 - 195, 'Household supplies': 1_840 - 184 })
    expect(monthSummary(ctx, '2026-09')).toMatchObject({ spentMinor: 10_000 - 1_001, incomeMinor: 0 })
    // The refund follows the purchase's own category, its largest part's.
    expect(categoryOf(ctx, refund)).toEqual(['Groceries', 'linked', false])

    // Unlinked, the first refund keeps Groceries as its own: all $10.01 of it comes off Groceries.
    // $33.33 of a $50 refund in Dine out: 20.70 + 6.13 + 6.50 off the parts, and the other $16.67 off Dine out.
    setLinks(ctx, refund, [])
    const partly = add(ctx, account, '2026-09-13', 5_000, 'Costco', 'Dine out')
    setLinks(ctx, partly, [{ transactionId: id, amountMinor: 3_333, kind: 'refund' }])
    expect(spent(ctx)).toEqual({ Groceries: 6_210 - 2_070 - 1_001, 'Household supplies': 1_840 - 613, 'Dine out': 1_950 - 650 - 1_667 })
    expect(monthSummary(ctx, '2026-09')).toMatchObject({ spentMinor: 10_000 - 5_000 - 1_001, incomeMinor: 0 })

    // A friend pays back $3.33 of a $7 e-Transfer in October: 2.07 + 0.61 + 0.65, counted in September with the bill.
    setLinks(ctx, partly, [])
    deleteTransaction(ctx, partly)
    deleteTransaction(ctx, refund)
    const friend = add(ctx, account, '2026-10-02', 700, 'Alex Doe')
    setLinks(ctx, friend, [{ transactionId: id, amountMinor: 333, kind: 'payback' }])
    expect(spent(ctx)).toEqual({ Groceries: 6_210 - 207, 'Dine out': 1_950 - 65, 'Household supplies': 1_840 - 61 })
    expect(monthSummary(ctx, '2026-09')).toMatchObject({ spentMinor: 10_000 - 333, incomeMinor: 0 })
    // The other $3.67 is October's income.
    expect(monthSummary(ctx, '2026-10')).toMatchObject({ spentMinor: 0, incomeMinor: 367 })
    // By payee the purchase is $100 less the payback, once.
    expect(topPayees(ctx, '2026-09-01', '2026-09-30').map((p) => [p.payeeKey, p.amountMinor, p.count])).toEqual([['costco', 9_667, 1]])
  })

  it('creates one split, sets and replaces the parts, and undoes the split three ways', async () => {
    const ctx = testContext()
    const account = makeAccount(ctx, 'Chequing')
    const [groceries, dineOut] = [categoryId(ctx, 'Groceries'), categoryId(ctx, 'Dine out')]
    const made = await createTransaction(
      ctx,
      transactionCreateSchema.parse({
        accountId: account,
        date: '2026-09-10',
        amountMinor: -3_000,
        payee: 'Market',
        categoryId: categoryId(ctx, 'Rent'),
        parts: [
          { categoryId: dineOut, amountMinor: -1_000, note: ' lunch ' },
          { categoryId: groceries, amountMinor: -2_000 },
        ],
      }),
      { useAi: false },
    )
    // `categoryId` was left aside: its own category is its largest part's.
    expect(made).toMatchObject({ categoryId: groceries, categorySource: 'user', needsReview: false })
    expect(parts(ctx, made.id)).toEqual([
      ['Dine out', -1_000, 'lunch'],
      ['Groceries', -2_000, null],
    ])
    // A tie goes to the first part, and parts in the same category become one (with the first note there is).
    setParts(ctx, made.id, [
      { categoryId: dineOut, amountMinor: -1_000 },
      { categoryId: groceries, amountMinor: -1_500 },
      { categoryId: dineOut, amountMinor: -500, note: 'coffee' },
    ])
    expect(parts(ctx, made.id)).toEqual([
      ['Dine out', -1_500, 'coffee'],
      ['Groceries', -1_500, null],
    ])
    expect(categoryOf(ctx, made.id)).toEqual(['Dine out', 'user', false])

    // Undone with no parts: it keeps its category.
    setParts(ctx, made.id, [])
    expect(parts(ctx, made.id)).toBeNull()
    expect(categoryOf(ctx, made.id)).toEqual(['Dine out', 'user', false])
    expect(spent(ctx)).toEqual({ 'Dine out': 3_000 })

    // Undone by one category, the same one included, from the form or the bulk bar.
    const again = () =>
      setParts(ctx, made.id, [
        { categoryId: dineOut, amountMinor: -2_000 },
        { categoryId: groceries, amountMinor: -1_000 },
      ])
    again()
    expect(updateTransaction(ctx, made.id, { categoryId: dineOut })).toMatchObject({ parts: null, categoryId: dineOut })
    again()
    expect(updateTransaction(ctx, made.id, { categoryId: null })).toMatchObject({ parts: null, categoryId: null })
    again()
    bulkUpdate(ctx, { ids: [made.id], categoryId: groceries })
    expect(getTransaction(ctx, made.id)).toMatchObject({ parts: null, categoryId: groceries })
    again()
    expect(updateTransaction(ctx, made.id, { parts: [] })).toMatchObject({ parts: null, categoryId: dineOut })

    // An update that says nothing of the category leaves the split, and one with parts sets them for the new amount.
    again()
    expect(updateTransaction(ctx, made.id, { notes: 'weekly' }).parts).toHaveLength(2)
    const changed = updateTransaction(ctx, made.id, {
      amountMinor: -5_000,
      categoryId: categoryId(ctx, 'Rent'),
      parts: [
        { categoryId: groceries, amountMinor: -4_000, note: null },
        { categoryId: null, amountMinor: -1_000, note: null },
      ],
    })
    expect(changed).toMatchObject({ amountMinor: -5_000, categoryId: groceries })
    expect(parts(ctx, made.id)).toEqual([
      ['Groceries', -4_000, null],
      [null, -1_000, null],
    ])
    // Parts that don't add up to the new amount change nothing.
    expect(() => updateTransaction(ctx, made.id, { amountMinor: -6_000, parts: [{ categoryId: groceries, amountMinor: -4_000, note: null }, { categoryId: null, amountMinor: -1_000, note: null }] })).toThrow(
      'The parts add up to -$50.00, not -$60.00.',
    )
    expect(getTransaction(ctx, made.id).amountMinor).toBe(-5_000)
  })

  it('gives a change of amount by hand to the largest part, and undoes the split when that part can’t take it', () => {
    const { ctx, id, three } = costco()
    three()
    // Up to $112: Groceries takes the $12.
    updateTransaction(ctx, id, { amountMinor: -11_200 })
    expect(parts(ctx, id)).toEqual([
      ['Groceries', -7_410, null],
      ['Household supplies', -1_840, 'bags'],
      ['Dine out', -1_950, null],
    ])
    expect(spent(ctx)).toEqual({ Groceries: 7_410, 'Dine out': 1_950, 'Household supplies': 1_840 })
    // Down to $40: Groceries is left with $2.10, and the largest part is Dine out now.
    updateTransaction(ctx, id, { amountMinor: -4_000 })
    expect(parts(ctx, id)).toEqual([
      ['Groceries', -210, null],
      ['Household supplies', -1_840, 'bags'],
      ['Dine out', -1_950, null],
    ])
    expect(categoryOf(ctx, id)).toEqual(['Dine out', 'user', false])
    // Down to $20: Dine out can't give $20, so the split is undone and it keeps Dine out.
    updateTransaction(ctx, id, { amountMinor: -2_000 })
    expect(parts(ctx, id)).toBeNull()
    expect(categoryOf(ctx, id)).toEqual(['Dine out', 'user', false])
    expect(spent(ctx)).toEqual({ 'Dine out': 2_000 })
  })

  it('follows what a category goes through: off, merged into one another part has, deleted, moved', () => {
    // Turned off with another category for what uses it, which another part has: the two parts become one.
    const off = costco()
    off.three()
    expect(() => setCategoryEnabled(off.ctx, categoryId(off.ctx, 'Dine out'), { enabled: false })).toThrow('1 transaction uses Dine out')
    setCategoryEnabled(off.ctx, categoryId(off.ctx, 'Dine out'), { enabled: false, moveTo: categoryId(off.ctx, 'Household supplies') })
    expect(parts(off.ctx, off.id)).toEqual([
      ['Groceries', -6_210, null],
      ['Household supplies', -3_790, 'bags'],
    ])
    // Turned off with none: the part has no category. With the largest part's off too, the transaction has none of its own.
    setCategoryEnabled(off.ctx, categoryId(off.ctx, 'Household supplies'), { enabled: false, moveTo: null })
    expect(parts(off.ctx, off.id)).toEqual([
      ['Groceries', -6_210, null],
      [null, -3_790, 'bags'],
    ])
    expect(categoryOf(off.ctx, off.id)).toEqual(['Groceries', 'user', false])
    // The last category off as well: both parts have none, so they're one and the split is undone.
    setCategoryEnabled(off.ctx, categoryId(off.ctx, 'Groceries'), { enabled: false, moveTo: null })
    expect(parts(off.ctx, off.id)).toBeNull()
    expect(categoryOf(off.ctx, off.id)).toEqual([null, null, false])
    expect(spent(off.ctx)).toEqual({ Uncategorized: 10_000 })

    // A ledger with its own list: the parts move to the copies (a category moved), then one is merged and one deleted.
    const own = costco()
    own.three()
    leaveSharedList(own.ctx)
    expect(parts(own.ctx, own.id)).toEqual([
      ['Groceries', -6_210, null],
      ['Household supplies', -1_840, 'bags'],
      ['Dine out', -1_950, null],
    ])
    expect(own.ctx.q.pluck('SELECT count(*) FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id JOIN categories c ON c.id = p.category_id WHERE t.ledger_id = @ledger AND c.ledger_id = @ledger')).toBe(3)
    // The largest part's category merged into a smaller part's: one part of $81.60, which is the largest.
    mergeCategory(own.ctx, categoryId(own.ctx, 'Groceries'), categoryId(own.ctx, 'Dine out'))
    expect(parts(own.ctx, own.id)).toEqual([
      ['Dine out', -8_160, null],
      ['Household supplies', -1_840, 'bags'],
    ])
    expect(categoryOf(own.ctx, own.id)).toEqual(['Dine out', 'user', false])
    expect(spent(own.ctx)).toEqual({ 'Dine out': 8_160, 'Household supplies': 1_840 })
    // A part's category deleted: it has none.
    deleteCategory(own.ctx, categoryId(own.ctx, 'Household supplies'))
    expect(parts(own.ctx, own.id)).toEqual([
      ['Dine out', -8_160, null],
      [null, -1_840, 'bags'],
    ])
    // The group of the other deleted with its categories: no part has a category, so the split is undone.
    deleteGroup(own.ctx, own.ctx.q.pluck<number>("SELECT id FROM category_groups WHERE ledger_id = @ledger AND name = 'Food'")!)
    expect(parts(own.ctx, own.id)).toBeNull()
    expect(categoryOf(own.ctx, own.id)).toEqual([null, null, false])
  })

  it('follows the shared category list in every ledger: a category merged or deleted there, and a ledger joining it', () => {
    const storage = testStorage()
    const a = costco(storage.registry.defaultContext())
    const b = costco(testLedger(storage))
    a.three()
    b.split(['Groceries', -4_000], ['Dine out', -6_000])
    const id = (name: string) => categoryId(a.ctx, name)
    // Dine out merged into Groceries, for everyone: A has two parts left, and B's two are one, so its split is undone.
    mergeCatalogCategory(storage, id('Dine out'), id('Groceries'))
    expect(parts(a.ctx, a.id)).toEqual([
      ['Groceries', -8_160, null],
      ['Household supplies', -1_840, 'bags'],
    ])
    expect(parts(b.ctx, b.id)).toBeNull()
    expect(categoryOf(b.ctx, b.id)).toEqual(['Groceries', 'user', false])
    // Household supplies deleted, for everyone: A's part has no category.
    deleteCatalogCategory(storage, id('Household supplies'))
    expect(parts(a.ctx, a.id)).toEqual([
      ['Groceries', -8_160, null],
      [null, -1_840, 'bags'],
    ])
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])

    // A ledger with its own list joins the shared one: its parts go to the shared categories of the same names.
    leaveSharedList(a.ctx)
    const ownGroceries = id('Groceries')
    joinSharedList(storage, a.ctx)
    expect(id('Groceries')).not.toBe(ownGroceries)
    expect(parts(a.ctx, a.id)).toEqual([
      ['Groceries', -8_160, null],
      [null, -1_840, 'bags'],
    ])
    expect(categoryOf(a.ctx, a.id)).toEqual(['Groceries', 'user', false])
    expectNoCrossLedgerReferences(storage)
  })

  it('keeps its parts when it moves to another ledger of a shared account, each in the category of the same name there', () => {
    const w = sharedWorld()
    leaveSharedList(w.family)
    // Family's own list has no Household supplies, and calls nothing else by that name.
    deleteCategory(w.family, categoryId(w.family, 'Household supplies'))
    const id = add(w.personal, w.visa, '2026-09-10', -10_000, 'Costco', 'Groceries')
    setParts(w.personal, id, [
      { categoryId: categoryId(w.personal, 'Groceries'), amountMinor: -6_210 },
      { categoryId: categoryId(w.personal, 'Household supplies'), amountMinor: -1_840, note: 'bags' },
      { categoryId: categoryId(w.personal, 'Dine out'), amountMinor: -1_950 },
    ])
    const moved = moveTransactions(w.personal, w.ctxOf, { ids: [id], to: w.family.ledger.id }, TESTER)
    expect(moved.moved).toBe(1)
    expect(parts(w.family, id)).toEqual([
      ['Groceries', -6_210, null],
      [null, -1_840, 'bags'],
      ['Dine out', -1_950, null],
    ])
    // Family's own categories, not Personal's shared ones.
    expect(getTransaction(w.family, id)).toMatchObject({ categoryId: categoryId(w.family, 'Groceries'), categorySource: 'user' })
    expect(spent(w.family)).toEqual({ Groceries: 6_210, 'Dine out': 1_950, Uncategorized: 1_840 })
    expect(spent(w.personal)).toEqual({})
    expect(w.personal.q.pluck('SELECT count(*) FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id WHERE t.ledger_id = @ledger')).toBe(0)
    expectNoCrossLedgerReferences(w.storage)

    // Back home, with Dine out gone there too: two parts with no category are one.
    setCategoryEnabled(w.personal, categoryId(w.personal, 'Dine out'), { enabled: false })
    moveTransactions(w.family, w.ctxOf, { ids: [id], to: w.personal.ledger.id }, TESTER)
    expect(parts(w.personal, id)).toEqual([
      ['Groceries', -6_210, null],
      [null, -3_790, 'bags'],
    ])
    expectNoCrossLedgerReferences(w.storage)

    // A ledger that gives the account up sends its rows away as deleted ones, with nothing of what they were: no parts.
    w.personal.q.transaction(() => sendAsDeleted(w.personal, w.ctxOf, { ids: [id], to: w.family.ledger.id }))
    expect(w.family.q.pluck('SELECT count(*) FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id WHERE t.ledger_id = @ledger AND t.id = ?', id)).toBe(0)
    expect(w.family.q.pluck('SELECT deleted_at IS NOT NULL FROM transactions WHERE ledger_id = @ledger AND id = ?', id)).toBe(1)
  })

  it('is left alone by AI, payee rules, matching and its recurring item, and teaches nothing', async () => {
    const asked: string[] = []
    const ctx = testContext({
      llm: async (req) => {
        asked.push(req.payee)
        return { category: 'Rent', confidence: 0.9, slot: 'primary', model: 'm' }
      },
    })
    const { account, id, split } = costco(ctx)
    const learned = () => ctx.q.all('SELECT payee_key, category_id, count FROM payee_category_stats WHERE ledger_id = @ledger AND count > 0')
    // Set by hand before, Dine out was learned for Costco: split, it no longer is.
    updateTransaction(ctx, id, { categoryId: categoryId(ctx, 'Dine out') })
    expect(learned()).toHaveLength(1)
    // Its largest part has no category, so neither has the transaction: still nobody's to categorize.
    split([null, -6_000], ['Groceries', -4_000])
    expect(learned()).toEqual([])
    expect(categoryOf(ctx, id)).toEqual([null, null, false])
    const plain = add(ctx, account, '2026-09-11', -500, 'Costco')

    await categorizeUncategorized(ctx)
    expect(asked).toEqual(['Costco'])
    expect(categoryOf(ctx, plain)).toEqual(['Rent', 'ai', true])
    expect(categoryOf(ctx, id)).toEqual([null, null, false])

    // "Always Groceries" for the payee sets the plain one only.
    expect(setPayeeChoice(ctx, { payeeKey: 'costco', mode: 'always', categoryId: categoryId(ctx, 'Groceries') })).toMatchObject({ updated: 1 })
    expect(categoryOf(ctx, plain)).toEqual(['Groceries', 'history', false])
    expect(parts(ctx, id)).toHaveLength(2)
    expect(categoryOf(ctx, id)).toEqual([null, null, false])

    // A payment of a recurring item can be split, and the item's category isn't put back on it.
    const item = createRecurring(ctx, recurringCreateSchema.parse({ payee: 'Costco', expectedAmountMinor: -10_000, cadence: 'monthly', anchorDate: '2026-09-10', categoryId: categoryId(ctx, 'Rent') }))
    // The item took the $100 one as its payment when it was made, and the other is added by hand.
    expect(getTransaction(ctx, id).recurringItemId).toBe(item.id)
    addPayment(ctx, item.id, plain)
    expect(categoryOf(ctx, plain)).toEqual(['Rent', 'recurring', false])
    expect(categoryOf(ctx, id)).toEqual([null, null, false])
    split(['Dine out', -6_000], ['Groceries', -4_000])
    updateTransaction(ctx, plain, { notes: 'x', amountMinor: -501 })
    expect(categoryOf(ctx, id)).toEqual(['Dine out', 'user', false])
    expect(getRecurring(ctx, item.id).categoryId).toBe(categoryId(ctx, 'Rent'))
    expect(learned()).toEqual([])
    // Undone by one category, it's the item's payment like the others: the category goes to the item.
    updateTransaction(ctx, id, { categoryId: categoryId(ctx, 'Groceries') })
    expect(getRecurring(ctx, item.id).categoryId).toBe(categoryId(ctx, 'Groceries'))

    // Matching: synced money in that's split isn't taken for the refund of a purchase.
    const card = makeAccount(ctx, 'Visa', 'credit')
    const bought = add(ctx, card, '2026-09-20', -4_000, 'Shoe Shop', 'Groceries')
    const back = add(ctx, card, '2026-09-22', 4_000, 'Shoe Shop')
    ctx.q.run("UPDATE transactions SET origin = 'sync' WHERE ledger_id = @ledger AND id IN (?, ?)", bought, back)
    setParts(ctx, back, [
      { categoryId: null, amountMinor: 3_000 },
      { categoryId: categoryId(ctx, 'Groceries'), amountMinor: 1_000 },
    ])
    expect(matchTransactions(ctx, { since: '2026-09-01' })).toMatchObject({ refunds: 0, payments: 0, transfers: 0 })
    expect(parts(ctx, back)).toHaveLength(2)
    // Linked in full by hand, nothing of it is left for parts: the split is undone and it follows the purchase.
    setLinks(ctx, back, [{ transactionId: bought, amountMinor: 4_000, kind: 'refund' }])
    expect(parts(ctx, back)).toBeNull()
    expect(categoryOf(ctx, back)).toEqual(['Groceries', 'linked', false])
  })

  it('goes with a deleted transaction and comes back with it', () => {
    const { ctx, id, three } = costco()
    three()
    deleteTransaction(ctx, id)
    expect(spent(ctx)).toEqual({})
    expect(exportRows(ctx)).toEqual([])
    expect(() => setParts(ctx, id, [])).toThrow('Transaction not found')
    restoreTransaction(ctx, id)
    expect(parts(ctx, id)).toHaveLength(3)
    expect(spent(ctx)).toEqual({ Groceries: 6_210, 'Dine out': 1_950, 'Household supplies': 1_840 })
  })

  it('exports a row for each part', () => {
    const { ctx, account, id, three } = costco()
    updateTransaction(ctx, id, { notes: 'weekly shop', tags: ['bulk'] })
    add(ctx, account, '2026-09-11', -500, 'Cafe', 'Dine out')
    three()
    expect(exportRows(ctx).map((r) => [r.date, r.payee, r.amountMinor, r.category, r.categoryGroup, r.notes, r.tags])).toEqual([
      ['2026-09-10', 'Costco', -6_210, 'Groceries', 'Food', 'weekly shop', 'bulk'],
      ['2026-09-10', 'Costco', -1_840, 'Household supplies', 'Housing', 'bags', 'bulk'],
      ['2026-09-10', 'Costco', -1_950, 'Dine out', 'Food', 'weekly shop', 'bulk'],
      ['2026-09-11', 'Cafe', -500, 'Dine out', 'Food', null, null],
    ])
    // The rows add up to what the transactions come to.
    expect(exportRows(ctx).reduce((n, r) => n + Number(r.amountMinor), 0)).toBe(-10_500)
  })

  it('refuses what can’t be split, and parts that don’t hold, in plain words', async () => {
    const { ctx, account, id, split } = costco()
    const [groceries, dineOut] = [categoryId(ctx, 'Groceries'), categoryId(ctx, 'Dine out')]
    const two = (a: number, b: number) => [
      { categoryId: groceries, amountMinor: a },
      { categoryId: dineOut, amountMinor: b },
    ]
    expect(() => setParts(ctx, id, two(-6_000, -3_000))).toThrow('The parts add up to -$90.00, not -$100.00.')
    expect(() => setParts(ctx, id, two(-10_000, 0))).toThrow('Each part is money out, like the transaction, and not zero.')
    expect(() => setParts(ctx, id, two(-11_000, 1_000))).toThrow('Each part is money out, like the transaction, and not zero.')
    expect(() => split(['Groceries', -10_000])).toThrow('Split it into at least two categories.')
    // Two parts in one category are one part.
    expect(() => setParts(ctx, id, two(-6_000, -4_000).map((p) => ({ ...p, categoryId: groceries })))).toThrow('Split it into at least two categories.')
    expect(() => split(['Groceries', -6_000], ['Salary', -4_000])).toThrow('Salary is an income category, so it can’t take part of money out.')
    expect(() => setParts(ctx, id, [{ categoryId: 999_999, amountMinor: -6_000 }, { categoryId: null, amountMinor: -4_000 }])).toThrow('One of the parts is in a category that doesn’t exist.')
    expect(getTransaction(ctx, id).parts).toBeNull()

    // Money in takes an income category, and parts that are money in.
    const pay = add(ctx, account, '2026-09-15', 5_000, 'Employer')
    expect(() => setParts(ctx, pay, two(-2_000, -3_000))).toThrow('Each part is money in, like the transaction, and not zero.')
    setParts(ctx, pay, [
      { categoryId: categoryId(ctx, 'Salary'), amountMinor: 4_000 },
      { categoryId: categoryId(ctx, 'Other income'), amountMinor: 1_000 },
    ])
    expect(monthSummary(ctx, '2026-09').incomeMinor).toBe(5_000)

    // A transfer, on either side.
    const card = makeAccount(ctx, 'Visa', 'credit')
    const out = (await createTransaction(ctx, transactionCreateSchema.parse({ accountId: account, date: '2026-09-16', amountMinor: -2_000, payee: 'Card payment', transferAccountId: card }), { useAi: false })).id
    expect(() => setParts(ctx, out, two(-1_000, -1_000))).toThrow('A transfer can’t be split into categories.')
    expect(() => setParts(ctx, getTransaction(ctx, out).transferPairId!, two(1_000, 1_000))).toThrow('A transfer can’t be split into categories.')
    await expect(
      createTransaction(ctx, transactionCreateSchema.parse({ accountId: account, date: '2026-09-16', amountMinor: -2_000, payee: 'To card', transferAccountId: card, parts: two(-1_000, -1_000) }), { useAi: false }),
    ).rejects.toThrow('A transfer can’t be split into categories.')
    expect(ctx.q.pluck("SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND payee = 'To card'")).toBe(0)
    // A card payment that isn't paired: money onto a credit card in a category left out of totals.
    const paid = add(ctx, card, '2026-09-17', 2_000, 'Payment - thank you', 'Credit card payment')
    expect(() => setParts(ctx, paid, two(1_000, 1_000))).toThrow('A card payment can’t be split into categories.')
    // A refund onto the card isn't one.
    const cashBack = add(ctx, card, '2026-09-18', 2_000, 'Cash back', 'Groceries')
    setParts(ctx, cashBack, two(1_000, 1_000))
    // Money in that has the category of what it pays back.
    const refund = add(ctx, account, '2026-09-19', 10_000, 'Costco')
    setLinks(ctx, refund, [{ transactionId: id, amountMinor: 10_000, kind: 'refund' }])
    expect(() => setParts(ctx, refund, two(6_000, 4_000))).toThrow('It has the category of what it pays back. Unlink it to split it into categories.')
    // One that isn't there.
    expect(() => setParts(ctx, 999_999, two(-1, -1))).toThrow('Transaction not found')
  })

  it('refuses the rows of a payment split between ledgers', () => {
    const w = sharedWorld()
    const payment = add(w.personal, w.visa, '2026-09-20', 10_000, 'Payment - thank you', 'Credit card payment')
    setSplit(w.personal, w.ctxOf, payment, { shares: [{ ledger: 'family', amountMinor: 4_000 }] }, { actor: TESTER, usable: null })
    const rows = (ctx: AppContext) => ctx.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND (id = ? OR split_of = ?) ORDER BY id', payment, payment)
    const two = (sign: number) => [
      { categoryId: null, amountMinor: sign * 1_000 },
      { categoryId: categoryId(w.personal, 'Groceries'), amountMinor: sign * 3_000 },
    ]
    const [paid, given] = rows(w.personal)
    const [share] = rows(w.family)
    const refused = 'It’s part of a payment split between ledgers, so it can’t be split into categories.'
    expect(() => setParts(w.personal, paid!, two(1))).toThrow(refused)
    expect(() => setParts(w.personal, given!, two(-1))).toThrow(refused)
    expect(() => setParts(w.family, share!, two(1))).toThrow(refused)
    // Another ledger's transaction isn't found.
    expect(() => setParts(w.family, paid!, two(1))).toThrow('Transaction not found')
  })
})

describe('splitting into categories over HTTP', () => {
  function setup(card?: FakeCard) {
    const storage = testStorage({ fetch: card && fakeBridge(card) })
    const personal = storage.registry.defaultContext()
    const family = testLedger(storage)
    const app = createApp(storage, { trustedHeader: null })
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(`/api/v1${url}`, {
        method,
        headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      const json = (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as Json
      return { status: res.status, body: json, message: json?.error?.message as string | undefined }
    }
    const key = async (scope: string, ledgers?: string[]) => {
      const res = await call('POST', '/api-keys', { name: `${scope} ${ledgers?.join('+') ?? 'all'}`, scopes: [scope], ledgers })
      return { authorization: `Bearer ${(res.body as ApiKeyCreated).key}`, 'sec-fetch-site': 'none' }
    }
    return { storage, personal, family, call, key }
  }

  it('sets the parts with a key that can write in the ledger, and no other', async () => {
    const w = setup()
    const id = add(w.personal, makeAccount(w.personal, 'Chequing'), '2026-09-10', -10_000, 'Costco', 'Groceries')
    const theirs = add(w.family, makeAccount(w.family, 'Chequing'), '2026-09-10', -10_000, 'Costco', 'Groceries')
    const body = {
      parts: [
        { categoryId: categoryId(w.personal, 'Groceries'), amountMinor: -6_210 },
        { categoryId: categoryId(w.personal, 'Dine out'), amountMinor: -3_790, note: 'lunch' },
      ],
    }
    const url = (ledger: string, tx: number) => `/ledgers/${ledger}/transactions/${tx}/parts`
    expect(await w.call('PUT', url('personal', id), body, await w.key('read'))).toMatchObject({ status: 403 })
    expect(await w.call('PUT', url('personal', id), body, await w.key('write', [w.family.ledger.id]))).toMatchObject({ status: 403 })
    // Another ledger's transaction, by its id: not found here, and unchanged there.
    expect(await w.call('PUT', url('personal', theirs), body, await w.key('write'))).toMatchObject({ status: 404, message: 'Transaction not found' })
    expect(getTransaction(w.family, theirs).parts).toBeNull()
    expect(getTransaction(w.personal, id).parts).toBeNull()

    const split = await w.call('PUT', url('personal', id), body, await w.key('write', [w.personal.ledger.id]))
    expect(split.status).toBe(200)
    expect(split.body).toMatchObject({
      id,
      categoryId: body.parts[0]!.categoryId,
      parts: [
        { categoryId: body.parts[0]!.categoryId, amountMinor: -6_210, note: null },
        { categoryId: body.parts[1]!.categoryId, amountMinor: -3_790, note: 'lunch' },
      ],
    })
    expect((await w.call('GET', `/ledgers/personal/transactions/${id}`)).body.parts).toHaveLength(2)
    expect((await w.call('GET', '/ledgers/personal/activity?limit=1')).body.items[0]).toMatchObject({ action: 'update', summary: 'Split Costco -$100.00 on 2026-09-10 into categories' })
    // Created and updated with parts, and refused in plain words.
    const made = await w.call('POST', '/ledgers/personal/transactions', { accountId: getTransaction(w.personal, id).accountId, date: '2026-09-11', amountMinor: -10_000, payee: 'Market', ...body })
    expect([made.status, made.body.parts.length]).toEqual([201, 2])
    expect(await w.call('PATCH', `/ledgers/personal/transactions/${id}`, { parts: [{ categoryId: null, amountMinor: -1 }] })).toMatchObject({ status: 400, message: 'The parts add up to -$0.01, not -$100.00.' })
    // The CSV has a row for each part.
    const csv = (await w.call('GET', '/ledgers/personal/export/transactions.csv?from=2026-09-10&to=2026-09-10')).body as string
    const [header, ...lines] = csv.split('\n').map((l) => l.split(','))
    const cell = (line: string[], column: string) => line[header!.indexOf(column)]
    expect(lines.map((l) => ['payee', 'amount', 'category', 'notes'].map((c) => cell(l, c)))).toEqual([
      ['Costco', '-62.10', 'Groceries', ''],
      ['Costco', '-37.90', 'Dine out', 'lunch'],
    ])
    // Undone.
    expect((await w.call('PUT', url('personal', id), { parts: [] })).body).toMatchObject({ parts: null, categoryId: body.parts[0]!.categoryId })
  })

  it('gives a change of amount from the bank to the largest part, and undoes the split when that part can’t take it', async () => {
    const card: FakeCard = { balance: '-100.00', transactions: [fakeTx('b1', '2026-09-28', '-100.00', 'Bistro', { pending: true })] }
    const w = setup(card)
    const visa = makeAccount(w.personal, 'Visa', 'credit')
    const conn = await w.call('POST', '/bank/connections', { setupToken: TOKEN })
    const bankAccountId = (conn.body.accounts as Json[]).find((a) => a.remoteId === 'visa').id as string
    expect((await w.call('PUT', `/ledgers/personal/accounts/${visa}/bank`, { bankAccountId })).status).toBe(200)
    const sync = async () => expect((await w.call('POST', `/bank/connections/${conn.body.id}/sync`)).body).toMatchObject({ ok: true })
    await sync()
    const id = w.personal.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND external_id = 'b1'")!
    setParts(w.personal, id, [
      { categoryId: categoryId(w.personal, 'Dine out'), amountMinor: -7_000 },
      { categoryId: categoryId(w.personal, 'Groceries'), amountMinor: -3_000 },
    ])
    // It posts with the tip: $115, and Dine out takes the $15.
    card.transactions = [fakeTx('b1', '2026-09-28', '-115.00', 'Bistro')]
    await sync()
    expect(getTransaction(w.personal, id)).toMatchObject({ amountMinor: -11_500, status: 'cleared' })
    expect(parts(w.personal, id)).toEqual([
      ['Dine out', -8_500, null],
      ['Groceries', -3_000, null],
    ])
    // The bank corrects it down to $40: Dine out is left with $10, and Groceries is the largest part.
    card.transactions = [fakeTx('b1', '2026-09-28', '-40.00', 'Bistro')]
    await sync()
    expect(parts(w.personal, id)).toEqual([
      ['Dine out', -1_000, null],
      ['Groceries', -3_000, null],
    ])
    expect(categoryOf(w.personal, id)).toEqual(['Groceries', 'user', false])
    expect(spent(w.personal)).toEqual({ Groceries: 3_000, 'Dine out': 1_000 })
    // And down to $10: Groceries can't give $30, so the split is undone and it keeps Groceries.
    card.transactions = [fakeTx('b1', '2026-09-28', '-10.00', 'Bistro')]
    await sync()
    expect(getTransaction(w.personal, id)).toMatchObject({ amountMinor: -1_000, parts: null })
    expect(categoryOf(w.personal, id)).toEqual(['Groceries', 'user', false])
    // The sync's own categorizing left it alone throughout.
    expect(spent(w.personal)).toEqual({ Groceries: 1_000 })
  })
})
