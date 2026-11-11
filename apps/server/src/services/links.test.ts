import { describe, expect, it } from 'vitest'
import { addDays, transactionCreateSchema } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import type { AppContext } from './context'
import { setLinks, setLinksTogether } from './links'
import { byCategory, monthSummary } from './reports'
import { deleteTransaction, getTransaction, insertTransaction, linkCandidates, listTransactions, restoreTransaction } from './transactions'

const add = (ctx: AppContext, accountId: number, date: string, amountMinor: number, payee: string, categoryId: number | null = null) =>
  insertTransaction(ctx, transactionCreateSchema.parse({ accountId, date, amountMinor, payee, categoryId }), { origin: 'manual', skipRecurring: true, suggestion: null })

/** What each category comes to in a month, as reports count it. */
const spent = (ctx: AppContext, month: string) =>
  Object.fromEntries(byCategory(ctx, `${month}-01`, `${month}-31`).map((c) => [c.name, c.amountMinor]))

describe('paybacks', () => {
  it('finds bills it could pay back: the nearest around it, or, searched, the newest first at any date', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const tv = (date: string, amountMinor: number) => add(ctx, card, date, amountMinor, 'Acme TV')
    const [apr, jun, jul, aug, oct] = [tv('2026-04-15', -2_625), tv('2026-06-15', -2_625), tv('2026-07-15', -4_515), tv('2026-08-15', -4_515), tv('2026-10-15', -4_515)]
    const back = add(ctx, chq, '2026-07-18', 5_000, 'Alex Doe - INTERAC e-Transfer®')
    expect(linkCandidates(ctx, back, { kind: 'payback' }).map((c) => c.transaction.id)).toEqual([jul, jun])
    expect(linkCandidates(ctx, back, { kind: 'payback', q: 'acme' }).map((c) => c.transaction.id)).toEqual([oct, aug, jul, jun, apr])
  })

  it('finds bills it could pay back in some categories, at any date, newest first', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const [therapy, dineOut] = [categoryId(ctx, 'Therapy & counselling'), categoryId(ctx, 'Dine out')]
    const old = add(ctx, card, '2026-03-03', -16_500, 'Acme Clinic', therapy)
    const recent = add(ctx, card, '2026-09-03', -5_500, 'Acme Clinic', therapy)
    const lunch = add(ctx, card, '2026-09-05', -2_000, 'Corner Cafe', dineOut)
    const loose = add(ctx, card, '2026-09-06', -1_000, 'Something')
    const back = add(ctx, chq, '2026-09-09', 5_500, 'Insurer - Direct deposit')
    const ids = (categoryId: Array<number | 'none'>, q?: string) => linkCandidates(ctx, back, { kind: 'payback', categoryId, q }).map((c) => c.transaction.id)
    // The one that fits the amount first, then the newest: the March bill too, outside the 60 days.
    expect(ids([therapy])).toEqual([recent, old])
    expect(ids([dineOut, 'none'])).toEqual([loose, lunch])
    // With a search as well: both.
    expect(ids([therapy, dineOut], 'acme')).toEqual([recent, old])
  })

  it('finds an old bill whose amount fits, past 300 newer ones in the category', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const groceries = categoryId(ctx, 'Groceries')
    const big = add(ctx, card, '2024-01-05', -9_000, 'Big Shop', groceries)
    for (let i = 0; i < 300; i++) add(ctx, card, addDays('2025-01-01', i), -1_234, 'Corner Store', groceries)
    const back = add(ctx, chq, '2026-09-09', 4_500, 'Alex Doe - INTERAC e-Transfer®')
    expect(linkCandidates(ctx, back, { kind: 'payback', categoryId: [groceries] })[0]).toMatchObject({ transaction: { id: big }, likely: true })
  })

  it('pays back several bills with one e-Transfer, and one bill with several, in the bills’ categories and months', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const [dineOut, fun] = [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Entertainment')]
    const dinner = add(ctx, card, '2026-09-30', -12_000, 'Pai Northern Thai', dineOut)
    const movie = add(ctx, card, '2026-10-01', -4_000, 'Cineplex', fun)
    const alex = add(ctx, chq, '2026-10-02', 5_000, 'Alex Doe - INTERAC e-Transfer®')
    const sam = add(ctx, chq, '2026-10-03', 3_000, 'Sam Roe - INTERAC e-Transfer®')

    // The bills it could pay back: the nearest first.
    expect(linkCandidates(ctx, alex, { kind: 'payback' }).map((c) => c.transaction.id)).toEqual([movie, dinner])
    // From the bill: Sam's is a whole share of it (a quarter), so it comes first.
    expect(linkCandidates(ctx, dinner, { kind: 'payback' })[0]).toMatchObject({ transaction: { id: sam }, likely: true })

    // Alex pays for their dinner and their movie at once.
    setLinks(ctx, alex, [
      { transactionId: dinner, amountMinor: 3_000, kind: 'payback' },
      { transactionId: movie, amountMinor: 2_000, kind: 'payback' },
    ])
    // Sam pays for dinner, linked from the bill (Alex's stays).
    setLinks(ctx, dinner, [
      { transactionId: alex, amountMinor: 3_000, kind: 'payback' },
      { transactionId: sam, amountMinor: 3_000, kind: 'payback' },
    ])
    // Linked to several bills, Alex's has no category of its own. Sam's has the dinner's.
    expect(getTransaction(ctx, alex)).toMatchObject({ categoryId: null, categorySource: 'linked' })
    expect(getTransaction(ctx, sam)).toMatchObject({ categoryId: dineOut, categorySource: 'linked' })
    expect(getTransaction(ctx, dinner).links.map((l) => [l.transactionId, l.amountMinor])).toEqual([
      [alex, 3_000],
      [sam, 3_000],
    ])

    // Reports count your share, in the month of the bill, and the paybacks aren't income.
    expect(spent(ctx, '2026-09')).toEqual({ 'Dine out': 6_000 })
    expect(spent(ctx, '2026-10')).toEqual({ Entertainment: 2_000 })
    expect(monthSummary(ctx, '2026-10')).toMatchObject({ incomeMinor: 0, spentMinor: 2_000, uncategorizedCount: 0 })
    // In the transaction list, Alex's is under both bills' categories, and isn't uncategorized.
    const ids = (q: Parameters<typeof listTransactions>[1]) => listTransactions(ctx, q).items.map((t) => t.id)
    expect(ids({ categoryId: [fun], limit: 10 })).toEqual([alex, movie])
    expect(ids({ categoryId: [dineOut], limit: 10 })).toEqual([sam, alex, dinner])
    expect(ids({ categoryId: ['none'], limit: 10 })).toEqual([])
    // In any of several.
    expect(ids({ categoryId: [fun, dineOut], limit: 10 })).toEqual([sam, alex, movie, dinner])
    expect(ids({ categoryId: [fun, 'none'], limit: 10 })).toEqual([alex, movie])

    // Never more than came in, nor more than is left on a bill.
    expect(() => setLinks(ctx, alex, [{ transactionId: dinner, amountMinor: 6_000, kind: 'payback' }])).toThrow('That’s $60.00, more than the $50.00 that came in.')
    const jo = add(ctx, chq, '2026-10-04', 9_000, 'Jo - INTERAC e-Transfer®')
    expect(() => setLinks(ctx, jo, [{ transactionId: dinner, amountMinor: 9_000, kind: 'payback' }])).toThrow(
      'Only $60.00 of Pai Northern Thai (-$120.00 on 2026-09-30) is left to pay back.',
    )
    expect(() => setLinks(ctx, jo, [{ transactionId: sam, amountMinor: 1_000, kind: 'payback' }])).toThrow('Only a purchase or bill can be paid back')

    // Partly linked: the rest of it is in its own category (uncategorized money in counts as income).
    setLinks(ctx, alex, [{ transactionId: movie, amountMinor: 2_000, kind: 'payback' }])
    expect(getTransaction(ctx, alex)).toMatchObject({ categoryId: null, categorySource: null })
    expect(monthSummary(ctx, '2026-10')).toMatchObject({ incomeMinor: 3_000 + 9_000, uncategorizedCount: 2 })
    expect(spent(ctx, '2026-09')).toEqual({ 'Dine out': 9_000 })

    // A deleted bill's paybacks don't count, and come back with it.
    deleteTransaction(ctx, movie)
    expect(monthSummary(ctx, '2026-10').incomeMinor).toBe(5_000 + 9_000)
    restoreTransaction(ctx, movie)
    expect(spent(ctx, '2026-10')).toEqual({ Entertainment: 2_000 })

    // Unlinked, it keeps the category it had, now as yours.
    setLinks(ctx, sam, [])
    expect(getTransaction(ctx, sam)).toMatchObject({ categoryId: dineOut, categorySource: 'user', links: [] })
  })

  it('counts a refund or payback of an uncategorized purchase against its spending, not as income', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const order = add(ctx, card, '2026-09-10', -10_000, 'Online order')
    const refund = add(ctx, card, '2026-10-05', 4_000, 'Online order refund')
    const share = add(ctx, chq, '2026-10-06', 1_000, 'Sam Roe - INTERAC e-Transfer®')
    setLinks(ctx, order, [
      { transactionId: refund, amountMinor: 4_000, kind: 'refund' },
      { transactionId: share, amountMinor: 1_000, kind: 'payback' },
    ])
    expect(monthSummary(ctx, '2026-09')).toMatchObject({ spentMinor: 10_000 - 1_000, incomeMinor: 0 })
    expect(monthSummary(ctx, '2026-10')).toMatchObject({ spentMinor: -4_000, incomeMinor: 0 })
    expect(spent(ctx, '2026-10')).toEqual({ Uncategorized: -4_000 })
    // Listed with it, as uncategorized and as spending without a label.
    const ids = (q: Parameters<typeof listTransactions>[1]) => listTransactions(ctx, q).items.map((t) => t.id)
    expect(ids({ categoryId: ['none'], limit: 10 })).toEqual([share, refund, order])
    expect(ids({ labelId: 'none', from: '2026-10-01', to: '2026-10-31', limit: 10 })).toEqual([share, refund])
  })

  it('sets what several paybacks pay back at once: all of them, or none', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const [dineOut, fun] = [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Entertainment')]
    const dinner = add(ctx, card, '2026-09-30', -12_000, 'Pai Northern Thai', dineOut)
    const movie = add(ctx, card, '2026-10-01', -4_000, 'Cineplex', fun)
    const alex = add(ctx, chq, '2026-10-02', 4_000, 'Alex Doe - INTERAC e-Transfer®')
    const sam = add(ctx, chq, '2026-10-03', 4_000, 'Sam Roe - INTERAC e-Transfer®')
    const payback = (transactionId: number, amountMinor: number) => ({ transactionId, amountMinor, kind: 'payback' as const })
    const linksOf = (id: number) => getTransaction(ctx, id).links.map((l) => [l.transactionId, l.amountMinor])
    // Alex's was taken at first for all of the movie.
    setLinks(ctx, alex, [payback(movie, 4_000)])

    // Together they pay back both bills, a part of each. Sam's part of the movie is checked against
    // Alex's new links, not the old one that took all of it.
    setLinksTogether(ctx, [
      { id: sam, links: [payback(dinner, 3_000), payback(movie, 1_000)] },
      { id: alex, links: [payback(dinner, 3_000), payback(movie, 1_000)] },
    ])
    expect(linksOf(movie)).toEqual([
      [sam, 1_000],
      [alex, 1_000],
    ])
    expect(getTransaction(ctx, alex)).toMatchObject({ categoryId: null, categorySource: 'linked' })
    expect(spent(ctx, '2026-09')).toEqual({ 'Dine out': 6_000 })
    expect(spent(ctx, '2026-10')).toEqual({ Entertainment: 2_000 })

    // One that doesn't hold: none of them change.
    const jo = add(ctx, chq, '2026-10-04', 2_000, 'Jo - INTERAC e-Transfer®')
    expect(() =>
      setLinksTogether(ctx, [
        { id: jo, links: [payback(dinner, 2_000)] },
        { id: sam, links: [payback(dinner, 5_000)] },
      ]),
    ).toThrow('That’s $50.00, more than the $40.00 that came in.')
    expect(linksOf(jo)).toEqual([])
    expect(linksOf(sam)).toEqual([
      [dinner, 3_000],
      [movie, 1_000],
    ])
    // Only money in, each once.
    expect(() => setLinksTogether(ctx, [{ id: dinner, links: [] }])).toThrow('Only money in can pay back')
    expect(() => setLinksTogether(ctx, [{ id: jo, links: [] }, { id: jo, links: [] }])).toThrow('Set each transaction once.')
  })
})
