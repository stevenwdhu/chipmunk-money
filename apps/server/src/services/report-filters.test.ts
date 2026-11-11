import { describe, expect, it } from 'vitest'
import { filterSchema, recurringCreateSchema, transactionCreateSchema, type ReportFilterInput } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import type { AppContext } from './context'
import { setLinks } from './links'
import { createRecurring } from './recurring'
import { exportRows, periodSummary, purchases, tagTotals, topPayees, trend } from './reports'
import { getTransaction, insertTransaction, listTransactions } from './transactions'

const add = (ctx: AppContext, accountId: number, date: string, amountMinor: number, payee: string, more: Record<string, unknown> = {}) =>
  insertTransaction(ctx, transactionCreateSchema.parse({ accountId, date, amountMinor, payee, ...more }), { origin: 'manual', skipRecurring: true, suggestion: null })

/**
 * September and October 2026: rent (a recurring payment), groceries, a $2,000 flight tagged #trip-japan
 * that Sam pays half of and the airline refunds $300 of in October, a dinner Alex pays $30 of (and $20
 * of the flight, keeping $30), pay and a bonus, a card payment, an uncategorized purchase, and a
 * dismissed recurring item's payment.
 */
function ledger() {
  const ctx = testContext()
  const card = makeAccount(ctx, 'Visa', 'credit')
  const chq = makeAccount(ctx, 'Chequing')
  const cat = (name: string) => categoryId(ctx, name)
  const t = {
    rent: add(ctx, chq, '2026-09-01', -185_000, 'Landlord', { categoryId: cat('Rent') }),
    spotify: add(ctx, card, '2026-09-03', -1_500, 'Spotify', { categoryId: cat('Entertainment') }),
    groceries: add(ctx, card, '2026-09-05', -10_000, 'Loblaws', { categoryId: cat('Groceries') }),
    flight: add(ctx, card, '2026-09-10', -200_000, 'Air Canada', { categoryId: cat('General shopping'), tags: ['trip-japan'] }),
    dinner: add(ctx, card, '2026-09-12', -12_000, 'Pai', { categoryId: cat('Dine out') }),
    alex: add(ctx, chq, '2026-09-14', 8_000, 'Alex Doe - INTERAC e-Transfer®'),
    mystery: add(ctx, card, '2026-09-15', -1_000, 'Mystery'),
    sam: add(ctx, chq, '2026-09-20', 100_000, 'Sam Roe - INTERAC e-Transfer®'),
    payment: add(ctx, chq, '2026-09-25', -50_000, 'Visa payment', { transferAccountId: card }),
    pay: add(ctx, chq, '2026-09-29', 300_000, 'Acme payroll', { categoryId: cat('Salary') }),
    bonus: add(ctx, chq, '2026-10-01', 50_000, 'Acme bonus', { categoryId: cat('Salary') }),
    refund: add(ctx, card, '2026-10-02', 30_000, 'Air Canada'),
  }
  setLinks(ctx, t.flight, [
    { transactionId: t.sam, amountMinor: 100_000, kind: 'payback' },
    { transactionId: t.refund, amountMinor: 30_000, kind: 'refund' },
  ])
  setLinks(ctx, t.alex, [
    { transactionId: t.dinner, amountMinor: 3_000, kind: 'payback' },
    { transactionId: t.flight, amountMinor: 2_000, kind: 'payback' },
  ])
  const item = (payee: string, amount: number, status: string, tx: number) => {
    const { id } = createRecurring(ctx, recurringCreateSchema.parse({ payee, expectedAmountMinor: amount, cadence: 'monthly', anchorDate: '2026-09-01' }))
    ctx.sqlite.prepare('UPDATE recurring_items SET status = ? WHERE id = ?').run(status, id)
    ctx.sqlite.prepare('UPDATE transactions SET recurring_item_id = ? WHERE id = ?').run(id, tx)
    return id
  }
  const items = { rent: item('Landlord', -185_000, 'active', t.rent), spotify: item('Spotify', -1_500, 'dismissed', t.spotify) }
  return { ctx, card, chq, t, items, cat }
}

const f = (v: ReportFilterInput) => filterSchema.parse(v)
const SEP = ['2026-09-01', '2026-09-30'] as const
const OCT = ['2026-10-01', '2026-10-31'] as const
const BOTH = ['2026-09-01', '2026-10-31'] as const
// Your share of the flight: $2,000 less Sam's $1,000, Alex's $20 and the $300 refund.
const FLIGHT = 200_000 - 100_000 - 2_000 - 30_000

describe('report filters', () => {
  it('counts everything without one, as before', () => {
    const { ctx } = ledger()
    const empty = f({ spending: {}, income: { only: [] } })
    expect(periodSummary(ctx, ...BOTH, empty)).toEqual(periodSummary(ctx, ...BOTH))
    expect(periodSummary(ctx, ...BOTH).filteredOut).toBeNull()
    expect(trend(ctx, '2026-10', 2, 'group', empty)).toEqual(trend(ctx, '2026-10', 2, 'group'))
    expect(topPayees(ctx, ...BOTH, 15, empty)).toEqual(topPayees(ctx, ...BOTH))
    expect(tagTotals(ctx, ...BOTH, empty)).toEqual(tagTotals(ctx, ...BOTH))
    const s = periodSummary(ctx, ...SEP)
    expect(s.spentMinor).toBe(185_000 + 1_500 + 10_000 + (200_000 - 100_000 - 2_000) + (12_000 - 3_000) + 1_000)
    expect(s.incomeMinor).toBe(300_000 + 3_000)
  })

  it('filters out a purchase with its paybacks and refunds, in whatever month they fall', () => {
    const { ctx } = ledger()
    const trip = f({ spending: { filterOut: [{ when: [{ field: 'tag', ids: [tagId(ctx, 'trip-japan')] }] }] } })
    const sep = periodSummary(ctx, ...SEP, trip)
    expect(sep.spentMinor).toBe(periodSummary(ctx, ...SEP).spentMinor - (200_000 - 100_000 - 2_000))
    expect(sep.filteredOut?.spending).toMatchObject({ amountMinor: 98_000, count: 1, byRule: [{ amountMinor: 98_000, count: 1 }] })
    // October's refund goes with it: a negative month is what it is.
    const oct = periodSummary(ctx, ...OCT, trip)
    expect(oct.spentMinor).toBe(0)
    expect(oct.filteredOut?.spending.amountMinor).toBe(-30_000)
    expect(trend(ctx, '2026-10', 2, 'category', trip).points.map((p) => p.filteredOutMinor)).toEqual([98_000, -30_000])
    // No category goes negative: General shopping only had the flight.
    expect(oct.expenses.flatMap((g) => g.categories)).toEqual([])
    // Income doesn't change, and Alex's $30 left over stays income.
    expect(sep.incomeMinor).toBe(303_000)
    expect(sep.filteredOut?.income).toEqual({ amountMinor: 0, count: 0, byRule: [], picked: { amountMinor: 0, count: 0 } })
    expect(tagTotals(ctx, ...BOTH, trip).map((r) => r.name)).toEqual([])
  })

  it('puts counted and filtered out together back into what Only count covers, month by month', () => {
    const { ctx, t, cat } = ledger()
    const only = { only: [{ field: 'category' as const, ids: [cat('General shopping'), cat('Dine out'), cat('Rent'), 'none' as const] }] }
    const scope = f({ spending: only, income: only })
    const filter = f({
      spending: { ...only, filterOut: [{ when: [{ field: 'payee', keys: [getTransaction(ctx, t.dinner).payeeKey] }] }, { when: [{ field: 'amount', min: 50_000 }] }] },
      income: { ...only, filterOut: [{ when: [{ field: 'amount', max: 5_000 }] }] },
    })
    for (const [from, to] of [SEP, OCT]) {
      const all = periodSummary(ctx, from, to, scope)
      const some = periodSummary(ctx, from, to, filter)
      expect(some.spentMinor + some.filteredOut!.spending.amountMinor).toBe(all.spentMinor)
      expect(some.incomeMinor + some.filteredOut!.income.amountMinor).toBe(all.incomeMinor)
    }
  })

  it('judges an amount by your share, after refunds and paybacks', () => {
    const { ctx, t } = ledger()
    // Charged $2,000, the flight is $680 of yours: not a $1,000 one-time charge. Rent is recurring.
    const big = (min: number) => f({ spending: { filterOut: [{ when: [{ field: 'amount', min }, { field: 'recurring', ids: 'none' }] }] } })
    expect(periodSummary(ctx, ...BOTH, big(100_000)).filteredOut?.spending.count).toBe(0)
    const out = purchases(ctx, { from: BOTH[0], to: BOTH[1], filter: big(FLIGHT), set: 'filtered-out' })
    expect(out).toMatchObject({ totalMinor: FLIGHT, count: 1, items: [{ transaction: { id: t.flight }, inRangeMinor: FLIGHT, shareMinor: FLIGHT, rules: [0] }] })
    // For income, what came in less what's linked to bills: Alex's is $30.
    const small = f({ income: { only: [{ field: 'amount', max: 3_000 }] } })
    expect(periodSummary(ctx, ...SEP, small).incomeMinor).toBe(3_000)
  })

  it('picks and puts back', () => {
    const { ctx, t } = ledger()
    const tag = tagId(ctx, 'trip-japan')
    const picked = f({ spending: { picked: [t.dinner] } })
    // Alex's payback for the dinner goes with it.
    expect(periodSummary(ctx, ...SEP, picked).filteredOut?.spending).toMatchObject({ amountMinor: 9_000, count: 1, picked: { amountMinor: 9_000, count: 1 } })
    const kept = f({ spending: { filterOut: [{ when: [{ field: 'tag', ids: [tag] }] }], keep: [t.flight] } })
    expect(periodSummary(ctx, ...SEP, kept)).toMatchObject({ spentMinor: periodSummary(ctx, ...SEP).spentMinor, filteredOut: { spending: { amountMinor: 0, byRule: [{ amountMinor: 0 }] } } })
    // Put back doesn't get past Only count.
    const onlyFood = f({ spending: { only: [{ field: 'category', ids: [categoryId(ctx, 'Groceries')] }], keep: [t.flight] } })
    expect(periodSummary(ctx, ...SEP, onlyFood).spentMinor).toBe(10_000)
    expect(purchases(ctx, { from: SEP[0], to: SEP[1], filter: kept }).items.find((i) => i.transaction.id === t.flight)).toMatchObject({ kept: true, rules: [0] })
  })

  it('filters by each field', () => {
    const { ctx, t, card, items } = ledger()
    const spent = (spending: ReportFilterInput['spending']) => periodSummary(ctx, ...SEP, f({ spending })).spentMinor
    const all = spent(undefined)
    expect(spent({ only: [{ field: 'category', ids: ['none'] }] })).toBe(1_000)
    // NULL-safe: filtering out the uncategorized keeps the rest.
    expect(spent({ filterOut: [{ when: [{ field: 'category', ids: ['none'] }] }] })).toBe(all - 1_000)
    expect(spent({ only: [{ field: 'payee', keys: [getTransaction(ctx, t.groceries).payeeKey] }] })).toBe(10_000)
    expect(spent({ only: [{ field: 'text', words: ['LOBLAW', 'mystery'] }] })).toBe(11_000)
    // Only in the notes: the payees don't count.
    ctx.sqlite.prepare("UPDATE transactions SET notes = 'loblaw run' WHERE id = ?").run(t.dinner)
    expect(spent({ only: [{ field: 'text', words: ['loblaw'], in: ['notes'] }] })).toBe(9_000)
    expect(spent({ only: [{ field: 'text', words: ['loblaw'], in: ['payee', 'notes'] }] })).toBe(19_000)
    expect(spent({ only: [{ field: 'account', ids: [card] }] })).toBe(all - 185_000)
    // A payback counts with its purchase's account, not its own.
    expect(spent({ filterOut: [{ when: [{ field: 'account', ids: [card] }] }] })).toBe(185_000)
    // A dismissed item's payments aren't recurring.
    expect(spent({ only: [{ field: 'recurring', ids: 'any' }] })).toBe(185_000)
    expect(spent({ only: [{ field: 'recurring', ids: 'none' }] })).toBe(all - 185_000)
    expect(spent({ only: [{ field: 'recurring', ids: [items.spotify] }] })).toBe(1_500)
    // Several conditions at once, each with its own parameters.
    expect(
      spent({
        only: [{ field: 'account', ids: [card] }, { field: 'text', words: ['a'] }],
        filterOut: [{ when: [{ field: 'amount', min: 5_000, max: 20_000 }, { field: 'category', ids: [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Groceries')] }] }],
      }),
    ).toBe(200_000 - 100_000 - 2_000)
  })

  it('filters by the group and labels of the line’s category, a payback in its purchase’s', () => {
    const { ctx, cat } = ledger()
    const spent = (spending: ReportFilterInput['spending']) => periodSummary(ctx, ...SEP, f({ spending })).spentMinor
    const all = spent(undefined)
    const group = (name: string) => ctx.sqlite.prepare('SELECT id FROM category_groups WHERE name = ?').pluck().get(name) as number
    const label = (name: string) => ctx.sqlite.prepare('SELECT id FROM labels WHERE name = ?').pluck().get(name) as number
    // Groceries and the dinner less Alex's $30. The flight less Sam's and Alex's paybacks.
    expect(spent({ only: [{ field: 'group', ids: [group('Food')] }] })).toBe(10_000 + 9_000)
    expect(spent({ only: [{ field: 'group', ids: [group('Shopping')] }] })).toBe(FLIGHT + 30_000)
    expect(spent({ only: [{ field: 'label', ids: [label('Needs')] }] })).toBe(185_000 + 10_000)
    expect(spent({ only: [{ field: 'label', ids: [label('Wants')] }] })).toBe(1_500 + (FLIGHT + 30_000) + 9_000)
    // No group: uncategorized, or a category without one. NULL-safe, so filtering it out keeps the rest.
    expect(spent({ only: [{ field: 'group', ids: ['none'] }] })).toBe(1_000)
    expect(spent({ filterOut: [{ when: [{ field: 'group', ids: ['none'] }] }] })).toBe(all - 1_000)
    ctx.sqlite.prepare('UPDATE categories SET group_id = NULL WHERE id = ?').run(cat('Entertainment'))
    expect(spent({ only: [{ field: 'group', ids: [group('Food'), 'none'] }] })).toBe(19_000 + 1_500 + 1_000)
    // No label, as the period summary counts it: uncategorized too, and on the income side Salary.
    expect(spent({ only: [{ field: 'label', ids: ['none'] }] })).toBe(periodSummary(ctx, ...SEP).labels.unlabelledSpentMinor)
    expect(spent({ only: [{ field: 'label', ids: ['none'] }] })).toBe(1_000)
    expect(spent({ filterOut: [{ when: [{ field: 'label', ids: ['none'] }] }] })).toBe(all - 1_000)
    expect(periodSummary(ctx, ...SEP, f({ income: { only: [{ field: 'label', ids: ['none'] }] } })).incomeMinor).toBe(303_000)
    // With each other: wants in Food, and a rule on Food's needs.
    expect(spent({ only: [{ field: 'group', ids: [group('Food')] }, { field: 'label', ids: [label('Wants')] }] })).toBe(9_000)
    expect(spent({ filterOut: [{ when: [{ field: 'group', ids: [group('Food')] }, { field: 'label', ids: [label('Needs'), 'none'] }] }] })).toBe(all - 10_000)
  })

  it('counts top payees and tags by purchase, less their refunds and paybacks', () => {
    const { ctx, t } = ledger()
    const payees = topPayees(ctx, ...BOTH)
    const flight = getTransaction(ctx, t.flight)
    expect(payees.find((p) => p.payeeKey === flight.payeeKey)).toMatchObject({ amountMinor: FLIGHT, count: 1 })
    expect(payees.find((p) => p.payeeKey === getTransaction(ctx, t.dinner).payeeKey)).toMatchObject({ amountMinor: 9_000, count: 1 })
    // Sam and Alex paid back bills: they aren't payees you spent at.
    expect(payees.map((p) => p.payeeKey)).not.toContain(getTransaction(ctx, t.sam).payeeKey)
    expect(tagTotals(ctx, ...BOTH)).toMatchObject([{ name: 'trip-japan', spentMinor: FLIGHT, incomeMinor: 0, count: 1 }])
    // And a filter's drill-down to the payee lists what makes up the row.
    const only = f({ spending: { only: [{ field: 'payee', keys: [flight.payeeKey] }] } })
    expect(periodSummary(ctx, ...BOTH, only).spentMinor).toBe(FLIGHT)
  })

  it('lists the biggest counted purchases, leaving out recurring payments', () => {
    const { ctx, t } = ledger()
    const biggest = purchases(ctx, { from: SEP[0], to: SEP[1] })
    expect(biggest.items.map((i) => [i.transaction.id, i.shareMinor])).toEqual([
      [t.flight, FLIGHT],
      [t.groceries, 10_000],
      [t.dinner, 9_000],
      [t.spotify, 1_500],
      [t.mystery, 1_000],
    ])
    expect(purchases(ctx, { from: SEP[0], to: SEP[1], side: 'income' }).items.map((i) => i.transaction.id)).toEqual([t.pay, t.alex])
  })

  it('lists what a filter counts, or filters out, with their refunds and paybacks', () => {
    const { ctx, t } = ledger()
    const trip = JSON.stringify({ spending: { filterOut: [{ when: [{ field: 'tag', ids: [tagId(ctx, 'trip-japan')] }] }] } })
    const ids = (q: Record<string, unknown>) =>
      listTransactions(ctx, { limit: 50, ...q } as Parameters<typeof listTransactions>[1])
        .items.map((x) => x.id)
        .sort((a, b) => a - b)
    const everything = Object.values(t).sort((a, b) => a - b)
    const pair = getTransaction(ctx, t.payment).transferPairId!
    // Sam's is all for the flight. Alex's is also for the dinner (and $30 of its own): in both lists.
    const out = [t.flight, t.alex, t.sam, t.refund].sort((a, b) => a - b)
    expect(ids({ filter: filterSchema.parse(JSON.parse(trip)), filteredOut: true })).toEqual(out)
    expect(ids({ filter: filterSchema.parse(JSON.parse(trip)) })).toEqual([...everything.filter((id) => !out.includes(id) || id === t.alex), pair].sort((a, b) => a - b))
    // Only what reports count on that side: no transfers.
    expect(ids({ side: 'income' })).toEqual([t.alex, t.pay, t.bonus].sort((a, b) => a - b))
    expect(ids({ side: 'spending' })).not.toContain(t.payment)
    expect(ids({ filteredOut: true })).toEqual([])
    // Transfers aren't the filter's to judge: they stay listed, whatever it counts.
    const groceries = filterSchema.parse({ spending: { only: [{ field: 'category', ids: [categoryId(ctx, 'Groceries')] }] }, income: { only: [{ field: 'payee', keys: ['nobody'] }] } })
    expect(ids({ filter: groceries })).toEqual([t.groceries, t.payment, pair].sort((a, b) => a - b))
    const offCard = filterSchema.parse({ spending: { filterOut: [{ when: [{ field: 'account', ids: [getTransaction(ctx, t.groceries).accountId] }] }] } })
    expect(ids({ filter: offCard })).toContain(pair)
    expect(ids({ filter: offCard, filteredOut: true })).not.toContain(pair)
    expect(periodSummary(ctx, ...SEP, offCard).excluded).toEqual(periodSummary(ctx, ...SEP).excluded)
  })

  it('exports what a filter counts', () => {
    const { ctx } = ledger()
    const trip = f({ spending: { filterOut: [{ when: [{ field: 'tag', ids: [tagId(ctx, 'trip-japan')] }] }] } })
    const payees = (filter?: ReturnType<typeof f>) => exportRows(ctx, ...BOTH, filter).map((r) => r.payee)
    expect(payees(trip)).not.toContain('Air Canada')
    expect(payees(trip)).toContain('Visa payment')
    expect(payees(trip).length).toBe(payees().length - 3)
  })

  it('counts a $0 row on neither side only when both filters would', () => {
    const { ctx, chq } = ledger()
    const check = add(ctx, chq, '2026-09-16', 0, 'Card check')
    const only = (keys: string[]) => filterSchema.parse({ spending: { only: [{ field: 'payee', keys }] }, income: { only: [{ field: 'payee', keys }] } })
    const listed = (filter: ReturnType<typeof only>) => listTransactions(ctx, { limit: 50, filter }).items.map((x) => x.id)
    expect(listed(only(['nobody']))).not.toContain(check)
    expect(listed(only([getTransaction(ctx, check).payeeKey]))).toContain(check)
  })

  it('matches an amount on charges only, not on unlinked refunds', () => {
    const { ctx, card, cat } = ledger()
    add(ctx, card, '2026-09-18', 50_000, 'Big return', { categoryId: cat('General shopping') })
    const small = f({ spending: { filterOut: [{ when: [{ field: 'amount', max: 2_000 }] }] } })
    // Spotify ($15) and the mystery charge ($10) go, the $500 return stays.
    expect(periodSummary(ctx, ...SEP, small).filteredOut?.spending).toMatchObject({ amountMinor: 2_500, count: 2 })
  })
})

function tagId(ctx: AppContext, name: string): number {
  return (ctx.sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number }).id
}
