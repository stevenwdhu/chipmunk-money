import { describe, expect, it } from 'vitest'
import { addDays, addMonthsToDate, recurringCreateSchema, transactionCreateSchema } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import type { AppContext } from './context'
import {
  addPayment,
  confirmRecurring,
  createRecurring,
  detectRecurring,
  dismissRecurring,
  getRecurring,
  linkPossiblePayment,
  listRecurring,
  recurringPaymentIds,
  notItsPayment,
  updateRecurring,
  upcomingPayments,
} from './recurring'
import { setAppSetting } from './settings'
import { createTransaction, deleteTransaction, getTransaction, listTransactions, recurringPaymentCandidates, restoreTransaction, updateTransaction } from './transactions'

const tx = (input: Record<string, unknown>) => transactionCreateSchema.parse(input)

describe('recurring detection', () => {
  it('suggests a monthly subscription, links history on confirm and matches new payments', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Amex', 'credit')
    const subs = categoryId(ctx, 'Software & media')
    for (let m = 0; m < 6; m++) {
      const date = addMonthsToDate('2026-04-28', m)
      await createTransaction(ctx, tx({ accountId: acc, date, amountMinor: -2099, payee: 'NETFLIX.COM 866-579-7172', categoryId: subs }))
    }
    // Irregular noise that must not be suggested
    for (const d of ['2026-05-02', '2026-05-09', '2026-08-20']) {
      await createTransaction(ctx, tx({ accountId: acc, date: d, amountMinor: -1500, payee: 'Random Diner' }))
    }

    expect(detectRecurring(ctx).created).toBe(1)
    const [item] = listRecurring(ctx, 'suggested')
    expect(item).toMatchObject({ cadence: 'monthly', expectedAmountMinor: -2099, categoryId: subs, nextDueDate: '2026-10-28' })

    confirmRecurring(ctx, item!.id)
    const active = listRecurring(ctx, 'active')[0]!
    expect(active.occurrences).toBe(6)
    expect(active.alerts).toEqual([])

    // Detection never re-suggests a known payee.
    expect(detectRecurring(ctx).created).toBe(0)

    // A new price: asked about rather than linked; yes makes it the amount, and the earlier payments stay.
    const paid = await createTransaction(ctx, tx({ accountId: acc, date: '2026-10-27', amountMinor: -2399, payee: 'NETFLIX.COM 866-579-7172' }))
    expect(getTransaction(ctx, paid.id).recurringItemId).toBeNull()
    expect(listRecurring(ctx, 'active')[0]!.possiblePayment).toMatchObject({ transactionId: paid.id, newAmount: true })
    expect(linkPossiblePayment(ctx, active.id, paid.id)).toMatchObject({ nextDueDate: '2026-11-28', expectedAmountMinor: -2399, occurrences: 7, alerts: [] })
  })

  it('puts its category on all its payments: when they link, when it changes, and on new ones', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Amex', 'credit')
    const [shopping, electronics, phones] = [categoryId(ctx, 'General shopping'), categoryId(ctx, 'Electronics'), categoryId(ctx, 'Phones')]
    for (const date of ['2026-07-25', '2026-08-25', '2026-09-25']) {
      await createTransaction(ctx, tx({ accountId: acc, date, amountMinor: -5250, payee: 'AFFIRM', categoryId: shopping }))
    }
    detectRecurring(ctx)
    const item = listRecurring(ctx, 'suggested')[0]!
    const categories = () => listTransactions(ctx, { accountId: acc, limit: 50 }).items.map((t) => [t.categoryId, t.categorySource])
    updateRecurring(ctx, item.id, { name: 'Headphones', categoryId: electronics, status: 'active' })
    expect(categories()).toEqual(Array(3).fill([electronics, 'recurring']))
    updateRecurring(ctx, item.id, { categoryId: phones })
    expect(categories()).toEqual(Array(3).fill([phones, 'recurring']))
    // A new payment takes it too, though you'd filed the payee elsewhere.
    const paid = await createTransaction(ctx, tx({ accountId: acc, date: '2026-10-25', amountMinor: -5250, payee: 'AFFIRM', categoryId: shopping }))
    expect(getTransaction(ctx, paid.id)).toMatchObject({ recurringItemId: item.id, categoryId: phones })

    // Changing one payment's category changes the item's, and so all of them; so does taking it away.
    updateTransaction(ctx, paid.id, { categoryId: electronics })
    expect(getRecurring(ctx, item.id).categoryId).toBe(electronics)
    expect(categories().map(([c]) => c)).toEqual(Array(4).fill(electronics))
    updateTransaction(ctx, paid.id, { categoryId: null })
    expect(getRecurring(ctx, item.id).categoryId).toBeNull()
    expect(categories().map(([c]) => c)).toEqual(Array(4).fill(null))
  })

  it('flags missing payments and lists upcoming ones', async () => {
    const ctx = testContext({ now: '2026-10-20T18:00:00Z' })
    const acc = makeAccount(ctx)
    for (let m = 0; m < 4; m++) {
      await createTransaction(ctx, tx({ accountId: acc, date: addMonthsToDate('2026-06-01', m), amountMinor: -185_000, payee: 'Rent' }))
    }
    detectRecurring(ctx)
    const item = listRecurring(ctx, 'suggested')[0]!
    confirmRecurring(ctx, item.id)
    expect(listRecurring(ctx, 'active')[0]!.alerts).toContain('missing') // Oct 1 rent never arrived
    const upcoming = upcomingPayments(ctx, 30)
    expect(upcoming.map((u) => u.dueDate)).toEqual(['2026-10-01', '2026-11-01'])
    expect(upcoming[0]!.overdue).toBe(true)

    dismissRecurring(ctx, item.id)
    expect(upcomingPayments(ctx, 30)).toEqual([])
  })

  const pay = async (ctx: AppContext, payee: string, amountMinor: number, dates: string[]) => {
    const accountId = makeAccount(ctx, `Card ${payee}`, 'credit')
    for (const date of dates) await createTransaction(ctx, tx({ accountId, date, amountMinor, payee }), { useAi: false, skipRecurring: true })
    return accountId
  }
  const found = (ctx: AppContext) => listRecurring(ctx, 'suggested').map((i) => [i.expectedAmountMinor, i.cadence, i.nextDueDate])

  it('finds a schedule with a gap, and asks whether the payment that came early is the missing one', async () => {
    const ctx = testContext()
    // Monthly on the 1st, but September's came on Aug 24.
    const acc = await pay(ctx, 'Transfer in', 290_000, ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-08-24', '2026-10-01'])
    expect(detectRecurring(ctx).created).toBe(1)
    expect(listRecurring(ctx, 'suggested')[0]).toMatchObject({ cadence: 'monthly', expectedAmountMinor: 290_000, nextDueDate: '2026-11-01', occurrences: 5 })
    const item = confirmRecurring(ctx, listRecurring(ctx, 'suggested')[0]!.id)
    expect(item).toMatchObject({ occurrences: 5, possiblePayment: { date: '2026-08-24', dueDate: '2026-09-01', newAmount: false } })

    // Yes: it's September's, and stays that through any recalculation.
    const early = item.possiblePayment!.transactionId
    expect(linkPossiblePayment(ctx, item.id, early)).toMatchObject({ occurrences: 6, possiblePayment: null, nextDueDate: '2026-11-01' })
    expect(updateRecurring(ctx, item.id, { name: 'Contribution' }).occurrences).toBe(6)
    expect(getTransaction(ctx, early).recurringItemId).toBe(item.id)
    void acc
  })

  it('finds a bill across the names the bank gave it, paid on the 25th to the 28th, from two cards', async () => {
    const ctx = testContext()
    const [visa, td] = [makeAccount(ctx, 'Visa', 'credit'), makeAccount(ctx, 'TD', 'credit')]
    const add = (payee: string, amountMinor: number, date: string, accountId = visa) =>
      createTransaction(ctx, tx({ accountId, date, amountMinor, payee }), { useAi: false, skipRecurring: true })
    // Property tax through the same service, close in amount, already tracked.
    for (const date of ['2026-06-25', '2026-07-28', '2026-08-20', '2026-09-22']) await add('PayHub Tax', -31_044, date)
    createRecurring(ctx, recurringCreateSchema.parse({ payee: 'PayHub Tax', expectedAmountMinor: -31_044, amountTolerancePct: 2, cadence: 'monthly', anchorDate: '2026-10-20' }))
    await add('PayHub Utilities', -33_674, '2026-04-28')
    await add('PayHub Utilities', -33_674, '2026-05-27', td)
    await add('PayHub Utilities', -33_674, '2026-06-25')
    await add('PayHub Utilities', -33_674, '2026-07-28')
    await add('PayHub', -33_674, '2026-08-27')
    await add('PayHub Rent', -33_674, '2026-09-25')
    setAppSetting(ctx.meta, 'recurring.detection', { priceVariationPct: 10 })

    expect(detectRecurring(ctx).created).toBe(1)
    expect(listRecurring(ctx, 'suggested')[0]).toMatchObject({
      payee: 'PayHub Rent',
      otherPayees: ['PayHub', 'PayHub Utilities'],
      expectedAmountMinor: -33_674,
      cadence: 'monthly',
      accountId: null,
      occurrences: 6,
      nextDueDate: '2026-10-25',
    })
    const item = confirmRecurring(ctx, listRecurring(ctx, 'suggested')[0]!.id)
    expect(item).toMatchObject({ occurrences: 6, possiblePayment: null })
  })

  it('suggests a series that stopped, for history: confirmed, it ends with its payments', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const streaming = categoryId(ctx, 'Software & media')
    // The old price, then a new one, now tracked.
    for (const date of ['2026-04-15', '2026-05-15', '2026-06-15']) await createTransaction(ctx, tx({ accountId: acc, date, amountMinor: -2625, payee: 'ACME TV', categoryId: streaming }), { useAi: false, skipRecurring: true })
    for (const date of ['2026-07-15', '2026-08-15', '2026-09-15']) await createTransaction(ctx, tx({ accountId: acc, date, amountMinor: -4515, payee: 'ACME TV' }), { useAi: false, skipRecurring: true })

    expect(detectRecurring(ctx).created).toBe(2)
    const found = listRecurring(ctx, 'suggested').map((i) => [i.expectedAmountMinor, i.occurrences, i.lastSeenDate, i.stopped])
    expect(found.sort()).toEqual([
      [-2625, 3, '2026-06-15', true],
      [-4515, 3, '2026-09-15', false],
    ])
    const old = listRecurring(ctx, 'suggested').find((i) => i.stopped)!
    expect(confirmRecurring(ctx, old.id)).toMatchObject({ status: 'ended', occurrences: 3, alerts: [], stopped: false })
    expect(listRecurring(ctx, 'suggested').map((i) => i.expectedAmountMinor)).toEqual([-4515])
  })

  it('doesn’t take a coffee you buy at one price on a couple of weekdays a week for a schedule', async () => {
    const ctx = testContext()
    // Two visits a week for 12 weeks, on whichever days: Mon and Wed, then Tue and Fri, Wed and Thu, Mon and Fri.
    const days = [[0, 2], [1, 4], [2, 3], [0, 4]]
    const dates: string[] = []
    for (let w = 0; w < 12; w++) for (const d of days[w % 4]!) dates.push(addDays('2026-07-06', w * 7 + d))
    await pay(ctx, 'STARBUCKS 04527', -625, dates)
    expect(detectRecurring(ctx).created).toBe(0)
  })

  it('needs 3 in a row for a weekly schedule', async () => {
    const ctx = testContext()
    // Groceries at the same price on 4 of the last 7 Saturdays, no more than 2 in a row.
    await pay(ctx, 'VEGGIE BOX CO', -3_800, ['2026-08-15', '2026-09-05', '2026-09-19', '2026-09-26'])
    expect(found(ctx)).toEqual([])
    expect(detectRecurring(ctx).created).toBe(0)
  })

  it('finds two subscriptions from one payee, each by its own amount', async () => {
    const ctx = testContext()
    // iCloud on the 10th, Apple Music on the 11th: each month's window holds both.
    const acc = await pay(ctx, 'APPLE.COM/BILL', -399, ['2026-07-10', '2026-08-10', '2026-09-10'])
    for (const date of ['2026-07-11', '2026-08-11', '2026-09-11']) await createTransaction(ctx, tx({ accountId: acc, date, amountMinor: -1099, payee: 'APPLE.COM/BILL' }), { useAi: false, skipRecurring: true })
    expect(detectRecurring(ctx).created).toBe(2)
    expect(found(ctx).sort()).toEqual([
      [-1099, 'monthly', '2026-10-11'],
      [-399, 'monthly', '2026-10-10'],
    ])
    for (const i of listRecurring(ctx, 'suggested')) {
      expect(i.occurrences).toBe(3)
      confirmRecurring(ctx, i.id)
    }
    // A new payment goes to the item with its amount.
    const music = listRecurring(ctx, 'active').find((i) => i.expectedAmountMinor === -1099)!
    const paid = await createTransaction(ctx, tx({ accountId: acc, date: '2026-10-11', amountMinor: -1099, payee: 'APPLE.COM/BILL' }), { useAi: false })
    expect(getTransaction(ctx, paid.id).recurringItemId).toBe(music.id)
  })

  it('finds the same price on two days of each month as semi-monthly, and doesn’t bring a dismissed one back', async () => {
    const ctx = testContext()
    // Two subscriptions, or one charged twice a month: the payments are the same either way.
    await pay(ctx, 'NETFLIX.COM', -1549, ['2026-07-03', '2026-07-20', '2026-08-03', '2026-08-20', '2026-09-03', '2026-09-20'])
    expect(detectRecurring(ctx).created).toBe(1)
    expect(found(ctx)).toEqual([[-1549, 'semimonthly', '2026-10-03']])
    expect(listRecurring(ctx, 'suggested')[0]).toMatchObject({ anchorDate: '2026-09-20', secondDay: 3, occurrences: 6 })
    for (const i of listRecurring(ctx, 'suggested')) dismissRecurring(ctx, i.id)
    expect(detectRecurring(ctx).created).toBe(0)
  })

  it('follows the latest payment’s amount within the price variation, and asks about a bigger change', async () => {
    const ctx = testContext()
    const acc = await pay(ctx, 'HYDRO ONE', -10_000, ['2026-07-15', '2026-08-14', '2026-09-15'])
    detectRecurring(ctx)
    const item = confirmRecurring(ctx, listRecurring(ctx, 'suggested')[0]!.id)
    const paid = (date: string, amountMinor: number) =>
      createTransaction(ctx, tx({ accountId: acc, date, amountMinor, payee: 'HYDRO ONE' }), { useAi: false }).then(() => getRecurring(ctx, item.id))
    expect(await paid('2026-10-15', -10_400)).toMatchObject({ expectedAmountMinor: -10_400, alerts: [] })
    // 4% more again: within 5% of the new amount, so it follows.
    expect(await paid('2026-11-16', -10_800)).toMatchObject({ expectedAmountMinor: -10_800, alerts: [] })
    expect(await paid('2026-12-15', -13_000)).toMatchObject({ expectedAmountMinor: -10_800, occurrences: 5, possiblePayment: { amountMinor: -13_000, newAmount: true } })
  })

  it('finds pay that comes twice a month, on the 15th and the last day', async () => {
    const ctx = testContext()
    const acc = await pay(ctx, 'ACME PAYROLL', 300_000, ['2026-07-15', '2026-07-31', '2026-08-14', '2026-08-31', '2026-09-15', '2026-09-30'])
    expect(detectRecurring(ctx).created).toBe(1)
    const found = listRecurring(ctx, 'suggested')[0]!
    expect(found).toMatchObject({ cadence: 'semimonthly', anchorDate: '2026-09-15', secondDay: 31, nextDueDate: '2026-10-15', monthlyCostMinor: 600_000 })
    confirmRecurring(ctx, found.id)
    expect(upcomingPayments(ctx, 30).map((u) => u.dueDate)).toEqual(['2026-10-15', '2026-10-31'])
    // The next one is matched, and the one after is the month's end.
    const paid = await createTransaction(ctx, tx({ accountId: acc, date: '2026-10-15', amountMinor: 300_000, payee: 'ACME PAYROLL' }), { useAi: false })
    expect(getTransaction(ctx, paid.id).recurringItemId).toBe(found.id)
    expect(getRecurring(ctx, found.id).nextDueDate).toBe('2026-10-31')
  })

  it('adds semi-monthly by hand with a second day that goes with the first', () => {
    const ctx = testContext()
    const base = { payee: 'Mortgage', name: null, categoryId: null, accountId: null, expectedAmountMinor: -120_000, amountTolerancePct: 5, totalPayments: null }
    const item = createRecurring(ctx, { ...base, cadence: 'semimonthly', anchorDate: '2026-10-01' })
    expect(item).toMatchObject({ secondDay: 15, nextDueDate: '2026-10-01' })
    // Moving the next payment onto the other day swaps them; leaving semi-monthly drops it.
    expect(updateRecurring(ctx, item.id, { nextDueDate: '2026-10-15' })).toMatchObject({ anchorDate: '2026-10-15', secondDay: 1 })
    expect(updateRecurring(ctx, item.id, { secondDay: 31 })).toMatchObject({ secondDay: 31 })
    expect(updateRecurring(ctx, item.id, { cadence: 'monthly' })).toMatchObject({ secondDay: null })
  })

  it('looks a day either side of each due date, and over a weekend', async () => {
    // Due Saturdays; the one on Sep 26 posted on Monday the 28th.
    const weekly = testContext()
    await pay(weekly, 'GOODLIFE FITNESS', -1500, ['2026-09-19', '2026-09-28', '2026-10-03'])
    expect(detectRecurring(weekly).created).toBe(1)
    expect(found(weekly)).toEqual([[-1500, 'weekly', '2026-10-10']])

    // Due the 10th; January's fell on a Saturday and posted Monday the 12th.
    const monthly = testContext({ now: '2026-01-20T18:00:00Z' })
    await pay(monthly, 'ROGERS', -8500, ['2025-11-10', '2025-12-10', '2026-01-12'])
    expect(detectRecurring(monthly).created).toBe(1)
    expect(found(monthly)[0]!.slice(0, 2)).toEqual([-8500, 'monthly'])

    // Two days off on weekdays is too far with the default of one day.
    const late = testContext()
    await pay(late, 'GYM', -1500, ['2026-09-15', '2026-09-24', '2026-10-01'])
    expect(detectRecurring(late).created).toBe(0)
  })

  it('finds yearly payments and month ends, and keeps the last day of the month', async () => {
    const ctx = testContext()
    await pay(ctx, 'COSTCO MEMBERSHIP', -6500, ['2024-10-01', '2025-10-01', '2026-09-30'])
    await pay(ctx, 'LANDLORD', -200_000, ['2026-07-31', '2026-08-31', '2026-09-30'])
    expect(detectRecurring(ctx).created).toBe(2)
    expect(found(ctx).sort()).toEqual([
      [-200_000, 'monthly', '2026-10-31'],
      [-6500, 'yearly', '2027-09-30'],
    ])
  })

  it('skips frequent purchases, and uses the price variation setting', async () => {
    const ctx = testContext()
    // Every other day: there's one in every window, but just as many between them.
    await pay(ctx, 'STARBUCKS', -575, Array.from({ length: 22 }, (_, i) => addDays('2026-08-21', i * 2)))
    await pay(ctx, 'HYDRO ONE', -10_000, ['2026-07-15', '2026-08-14', '2026-09-15'])
    await pay(ctx, 'ENBRIDGE', -10_000, ['2026-07-15', '2026-08-14', '2026-09-15'])
    // Enbridge's August bill was 8% more: over the default 5%.
    ctx.sqlite.prepare("UPDATE transactions SET amount_minor = -10800 WHERE payee = 'ENBRIDGE' AND date = '2026-08-14'").run()
    expect(found(detectAnd(ctx))).toEqual([[-10_000, 'monthly', '2026-10-15']])

    setAppSetting(ctx.meta, 'recurring.detection', { priceVariationPct: 10 })
    expect(detectRecurring(ctx).created).toBe(1)
    expect(listRecurring(ctx, 'suggested').map((i) => [i.payee, i.amountTolerancePct])).toEqual([
      ['HYDRO ONE', 5],
      ['ENBRIDGE', 10],
    ])
  })
})

describe('instalment plans', () => {
  const pay = async (ctx: AppContext, payee: string, amountMinor: number, dates: string[], accountId = makeAccount(ctx, `Card ${payee} ${amountMinor}`, 'credit')) => {
    for (const date of dates) await createTransaction(ctx, tx({ accountId, date, amountMinor, payee }), { useAi: false, skipRecurring: true })
    return accountId
  }
  const byAmount = (ctx: AppContext, amount: number) => listRecurring(ctx).find((i) => i.expectedAmountMinor === amount)!

  it('finds Pay in 4 after two payments, a paid-off one as finished, and ends after the last', async () => {
    const ctx = testContext()
    const acc = await pay(ctx, 'KLARNA*BOSE', -9_875, ['2026-09-18', '2026-10-02'])
    await pay(ctx, 'KLARNA*BOSE', -3150, ['2026-08-07', '2026-08-21', '2026-09-04', '2026-09-18'], acc)
    await pay(ctx, 'KLARNA*BOSE', -4980, ['2026-09-04', '2026-09-18', '2026-10-02'], acc)
    expect(detectRecurring(ctx).created).toBe(3)
    // All 4 paid: to keep in your history.
    expect(byAmount(ctx, -3150)).toMatchObject({ status: 'suggested', totalPayments: 4, paidPayments: 4, remainingPayments: 0, endDate: '2026-09-18' })
    confirmRecurring(ctx, byAmount(ctx, -3150).id)
    expect(byAmount(ctx, -3150)).toMatchObject({ status: 'ended', paidPayments: 4, occurrences: 4 })
    expect(byAmount(ctx, -9_875)).toMatchObject({
      cadence: 'biweekly',
      status: 'suggested',
      totalPayments: 4,
      paidPayments: 2,
      remainingPayments: 2,
      remainingAmountMinor: -19_750,
      nextDueDate: '2026-10-16',
      endDate: '2026-10-30',
      instalmentService: true,
    })
    expect(byAmount(ctx, -4980)).toMatchObject({ paidPayments: 3, remainingPayments: 1, endDate: '2026-10-16' })

    // Confirmed, each plan takes only its own payments; the upcoming list stops at the last one.
    for (const i of listRecurring(ctx, 'suggested')) confirmRecurring(ctx, i.id)
    expect(byAmount(ctx, -4980)).toMatchObject({ status: 'active', paidPayments: 3 })
    const upcoming = upcomingPayments(ctx, 30).map((u) => [u.dueDate, u.amountMinor, u.paymentNumber, u.totalPayments])
    expect(upcoming.sort()).toEqual([
      ['2026-10-16', -4980, 4, 4],
      ['2026-10-16', -9_875, 3, 4],
      ['2026-10-30', -9_875, 4, 4],
    ])
    const last = await createTransaction(ctx, tx({ accountId: acc, date: '2026-10-16', amountMinor: -4980, payee: 'KLARNA*BOSE' }), { useAi: false })
    expect(getTransaction(ctx, last.id).recurringItemId).toBe(byAmount(ctx, -4980).id)
    expect(byAmount(ctx, -4980)).toMatchObject({ status: 'ended', paidPayments: 4, remainingPayments: 0, endDate: '2026-10-16', alerts: [] })
  })

  it('counts payments from before your history, and can drop the end', async () => {
    const ctx = testContext()
    const acc = await pay(ctx, 'AUTO LOAN PMT', -61_050, ['2026-08-30', '2026-09-30'])
    const loan = createRecurring(ctx, {
      name: 'Car loan',
      payee: 'AUTO LOAN PMT',
      categoryId: null,
      accountId: acc,
      expectedAmountMinor: -61_050,
      amountTolerancePct: 5,
      cadence: 'monthly',
      anchorDate: '2026-10-30',
      totalPayments: 60,
      paidPayments: 40,
    })
    expect(loan).toMatchObject({ occurrences: 2, paidPayments: 40, remainingPayments: 20, endDate: '2028-05-30', remainingAmountMinor: -1_221_000 })
    expect(updateRecurring(ctx, loan.id, { paidPayments: 60 }).status).toBe('ended')
    expect(updateRecurring(ctx, loan.id, { paidPayments: 59 })).toMatchObject({ status: 'active', remainingPayments: 1 })
    expect(updateRecurring(ctx, loan.id, { totalPayments: null })).toMatchObject({ paidPayments: 2, remainingPayments: null, endDate: null })
  })

  it('names a plan after the store in its description, and keeps a name apart from the payee', async () => {
    const ctx = testContext()
    const acc = await pay(ctx, 'KLARNA*BOSE CANADA', -9_875, ['2026-09-18', '2026-10-02'])
    await pay(ctx, 'NETFLIX.COM', -1549, ['2026-07-10', '2026-08-10', '2026-09-10'], acc)
    detectRecurring(ctx)
    expect(listRecurring(ctx, 'suggested').map((i) => [i.payee, i.name]).sort()).toEqual([
      ['KLARNA*BOSE CANADA', 'BOSE CANADA'],
      ['NETFLIX.COM', null],
    ])
    // A name of your own, and back to none; the payee and matching stay.
    const netflix = byAmount(ctx, -1549)
    expect(updateRecurring(ctx, netflix.id, { name: 'Family plan' })).toMatchObject({ name: 'Family plan', payee: 'NETFLIX.COM', payeeKey: 'netflix com' })
    expect(updateRecurring(ctx, netflix.id, { name: null })).toMatchObject({ name: null, payee: 'NETFLIX.COM' })
    expect(createRecurring(ctx, { payee: 'Spotify', name: null, categoryId: null, accountId: null, expectedAmountMinor: -1199, amountTolerancePct: 5, cadence: 'monthly', anchorDate: '2026-10-12', totalPayments: null })).toMatchObject({
      name: null,
      payee: 'Spotify',
      payeeKey: 'spotify',
    })
  })

  it('finds a paid-off Pay in 4 whose payments came a day later each time', async () => {
    const ctx = testContext()
    // 15, 15 and 14 days apart: May 19 is 2 days off 6 weeks before Jul 2, but 1 day off 2 weeks before Jun 3.
    await pay(ctx, 'KLARNA', -15_990, ['2026-05-19', '2026-06-03', '2026-06-18', '2026-07-02'])
    expect(detectRecurring(ctx).created).toBe(1)
    expect(listRecurring(ctx, 'suggested')[0]).toMatchObject({ cadence: 'biweekly', totalPayments: 4, paidPayments: 4, remainingPayments: 0, endDate: '2026-07-02' })
  })

  it('finds a monthly plan that’s been paid off, with its smaller final payment', async () => {
    const ctx = testContext()
    const acc = await pay(ctx, 'AFFIRM', -41_210, ['2026-01-03', '2026-02-03', '2026-03-03', '2026-04-03', '2026-05-03'])
    await pay(ctx, 'AFFIRM', -38_980, ['2026-06-03'], acc)
    expect(detectRecurring(ctx).created).toBe(1)
    const plan = listRecurring(ctx, 'suggested')[0]!
    expect(plan).toMatchObject({ cadence: 'monthly', expectedAmountMinor: -41_210, totalPayments: 6, paidPayments: 6, remainingPayments: 0, endDate: '2026-06-03', totalAmountMinor: -245_030 })
    // Its payments, newest first: the ones found while it's a suggestion, the linked ones once confirmed.
    const found = recurringPaymentIds(ctx, plan.id)
    expect(found.map((id) => getTransaction(ctx, id).date)).toEqual(['2026-06-03', '2026-05-03', '2026-04-03', '2026-03-03', '2026-02-03', '2026-01-03'])
    confirmRecurring(ctx, plan.id)
    expect(getRecurring(ctx, plan.id)).toMatchObject({ status: 'ended', occurrences: 6, totalAmountMinor: -245_030 })
    expect(recurringPaymentIds(ctx, plan.id)).toEqual(found)
    // Scanning again doesn't bring it back.
    expect(detectRecurring(ctx).created).toBe(0)
  })

  it('marks a monthly plan from a buy-now-pay-later service, to say how many payments', async () => {
    const ctx = testContext()
    await pay(ctx, 'AFFIRM', -5250, ['2026-07-25', '2026-08-25', '2026-09-25'])
    detectRecurring(ctx)
    expect(listRecurring(ctx, 'suggested')[0]).toMatchObject({ cadence: 'monthly', totalPayments: null, instalmentService: true })
  })
})

describe('payments from another payee', () => {
  // Property tax through PayHub, monthly on the 20th; then the bank starts sending plain "PayHub" for every PayHub payment.
  const setup = async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const add = (payee: string, amountMinor: number, date: string, skipRecurring = true) =>
      createTransaction(ctx, tx({ accountId: acc, date, amountMinor, payee }), { useAi: false, skipRecurring })
    for (const date of ['2026-06-20', '2026-07-20', '2026-08-20']) await add('PayHub Tax', -31_044, date)
    detectRecurring(ctx)
    const item = confirmRecurring(ctx, listRecurring(ctx, 'suggested')[0]!.id)
    expect(item).toMatchObject({ nextDueDate: '2026-09-20', alerts: ['missing'], possiblePayment: null })
    return { ctx, item, add }
  }

  it('offers a payment from a similar payee, and linking it adds the payee', async () => {
    const { ctx, item, add } = await setup()
    const older = await add('PayHub', -31_044, '2026-05-20')
    const paid = await add('PayHub', -31_044, '2026-09-22')
    const other = await add('PayHub', -4579, '2026-09-24')
    // Another bill through PayHub close to the amount, but in August, which already has its payment.
    const utilities = await add('PayHub', -31_950, '2026-08-25')
    expect(getRecurring(ctx, item.id).possiblePayment).toEqual({ transactionId: paid.id, date: '2026-09-22', payee: 'PayHub', amountMinor: -31_044, newAmount: false, role: null, dueDate: '2026-09-20' })

    const linked = linkPossiblePayment(ctx, item.id, paid.id)
    expect(linked).toMatchObject({ otherPayees: ['PayHub'], nextDueDate: '2026-10-20', alerts: [], possiblePayment: null, occurrences: 5 })
    // Its earlier payment from that payee too; not one at another amount.
    expect(getTransaction(ctx, older.id).recurringItemId).toBe(item.id)
    expect(getTransaction(ctx, other.id).recurringItemId).toBeNull()
    expect(getTransaction(ctx, utilities.id).recurringItemId).toBeNull()

    // New payments from it match, but only about the item's amount: it sends other payments too.
    const smaller = await add('PayHub', -18_000, '2026-10-19', false)
    expect(getTransaction(ctx, smaller.id).recurringItemId).toBeNull()
    const next = await add('PayHub', -31_044, '2026-10-21', false)
    expect(getTransaction(ctx, next.id).recurringItemId).toBe(item.id)
    expect(detectRecurring(ctx).created).toBe(0)

    // Removed in the dialog, it's gone from the item (its linked payments stay).
    expect(updateRecurring(ctx, item.id, { otherPayees: [] }).otherPayees).toEqual([])
    expect(getTransaction(ctx, next.id).recurringItemId).toBe(item.id)
  })

  it('takes off a payment from the other payee in a month that already has its payment, at the next change', async () => {
    const { ctx, item, add } = await setup()
    const paid = await add('PayHub', -31_044, '2026-09-22')
    linkPossiblePayment(ctx, item.id, paid.id)
    // Linked before the one-per-due-date rule: the utilities bill a week after August's tax payment.
    const utilities = await add('PayHub', -31_950, '2026-08-25')
    ctx.sqlite.prepare("UPDATE transactions SET recurring_item_id = ?, category_source = 'recurring' WHERE id = ?").run(item.id, utilities.id)
    expect(getRecurring(ctx, item.id).occurrences).toBe(5)
    expect(updateRecurring(ctx, item.id, { name: 'Property tax' })).toMatchObject({ occurrences: 4, nextDueDate: '2026-10-20' })
    expect(getTransaction(ctx, utilities.id)).toMatchObject({ recurringItemId: null, categoryId: null })
  })

  it('doesn’t offer one again once you say it isn’t the item’s, nor one from a different payee', async () => {
    const { ctx, item, add } = await setup()
    const paid = await add('PayHub', -31_044, '2026-09-22')
    await add('PayHub Utilities', -31_044, '2026-09-21')
    expect(getRecurring(ctx, item.id).possiblePayment?.transactionId).toBe(paid.id)
    expect(notItsPayment(ctx, item.id, paid.id)).toMatchObject({ possiblePayment: null, alerts: ['missing'] })
  })
})

describe('recalculating a recurring item', () => {
  const setup = async () => {
    const ctx = testContext()
    const visa = makeAccount(ctx, 'Visa', 'credit')
    const add = (payee: string, amountMinor: number, date: string, accountId = visa) =>
      createTransaction(ctx, tx({ accountId, date, amountMinor, payee }), { useAi: false, skipRecurring: true })
    const paid = []
    for (const date of ['2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10']) paid.push(await add('Spotify', -1199, date))
    detectRecurring(ctx)
    const item = confirmRecurring(ctx, listRecurring(ctx, 'suggested')[0]!.id)
    expect(item).toMatchObject({ occurrences: 4, nextDueDate: '2026-10-10' })
    return { ctx, item, add, paid, visa }
  }

  it('takes off a payment that isn’t the item’s: back to expecting it, never linked again, uncategorized', async () => {
    const { ctx, item, paid } = await setup()
    const music = categoryId(ctx, 'Software & media')
    updateRecurring(ctx, item.id, { categoryId: music })
    const wrong = paid[3]!
    expect(getTransaction(ctx, wrong.id)).toMatchObject({ categoryId: music, needsReview: false })

    const after = notItsPayment(ctx, item.id, wrong.id)
    expect(after).toMatchObject({ occurrences: 3, nextDueDate: '2026-09-10', possiblePayment: null })
    expect(getTransaction(ctx, wrong.id)).toMatchObject({ recurringItemId: null, categoryId: null, categorySource: null, needsReview: false })
    // Any later change works its payments out again, without it.
    expect(updateRecurring(ctx, item.id, { name: 'Music' }).occurrences).toBe(3)
    expect(getTransaction(ctx, wrong.id).recurringItemId).toBeNull()
  })

  it('works its payments out again when you edit it', async () => {
    const { ctx, item, add } = await setup()
    // The price went up: asked about, and the payments at the old price stay its.
    const dearer = await add('Spotify', -1399, '2026-10-10')
    expect(getRecurring(ctx, item.id).possiblePayment).toMatchObject({ transactionId: dearer.id, newAmount: true })
    expect(linkPossiblePayment(ctx, item.id, dearer.id)).toMatchObject({ occurrences: 5, expectedAmountMinor: -1399, nextDueDate: '2026-11-10' })
    // Even with no variation: each is checked against the amount of its time.
    expect(updateRecurring(ctx, item.id, { amountTolerancePct: 0 }).occurrences).toBe(5)
    // Paid from another account: payments from elsewhere don't count.
    const amex = makeAccount(ctx, 'Amex', 'credit')
    await add('Spotify', -1399, '2026-11-10', amex)
    expect(updateRecurring(ctx, item.id, { accountId: amex })).toMatchObject({ occurrences: 1, nextDueDate: '2026-12-10' })
    // A next due date you set stays.
    expect(updateRecurring(ctx, item.id, { nextDueDate: '2027-01-10' }).nextDueDate).toBe('2027-01-10')
  })

  it('keeps only payments within its price variation, one per due date; the others can be an item of their own', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const add = (amountMinor: number, date: string) =>
      createTransaction(ctx, tx({ accountId: acc, date, amountMinor, payee: 'Transfer in' }), { useAi: false, skipRecurring: true })
    // Two transfers in on the 1st of each month, and one in between.
    for (const date of ['2026-07-01', '2026-08-01', '2026-09-01']) {
      await add(256_469, date)
      await add(290_000, date)
    }
    await add(226_563, '2026-08-20')
    const item = createRecurring(
      ctx,
      recurringCreateSchema.parse({ payee: 'Transfer in', expectedAmountMinor: 256_469, amountTolerancePct: 1, cadence: 'monthly', anchorDate: '2026-10-01' }),
    )
    expect(item).toMatchObject({ occurrences: 3, nextDueDate: '2026-10-01' })
    expect(recurringPaymentIds(ctx, item.id).map((id) => getTransaction(ctx, id).amountMinor)).toEqual([256_469, 256_469, 256_469])
    expect(listRecurring(ctx, 'suggested')).toEqual([])
    expect(detectRecurring(ctx).created).toBe(1)
    expect(listRecurring(ctx, 'suggested')[0]).toMatchObject({ expectedAmountMinor: 290_000, cadence: 'monthly' })
  })

  it('moves the next due date back when its latest payment is deleted', async () => {
    const { ctx, item, paid } = await setup()
    deleteTransaction(ctx, paid[3]!.id)
    expect(getRecurring(ctx, item.id)).toMatchObject({ occurrences: 3, nextDueDate: '2026-09-10' })
    restoreTransaction(ctx, paid[3]!.id)
    expect(getRecurring(ctx, item.id)).toMatchObject({ occurrences: 4, nextDueDate: '2026-10-10' })
  })

  it('reopens a paid-off plan that loses a payment, but not one you stopped', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const pays = []
    for (const date of ['2026-06-02', '2026-06-16', '2026-06-30', '2026-07-14']) {
      pays.push(await createTransaction(ctx, tx({ accountId: acc, date, amountMinor: -2500, payee: 'KLARNA*SHOP' }), { useAi: false, skipRecurring: true }))
    }
    detectRecurring(ctx)
    const plan = confirmRecurring(ctx, listRecurring(ctx, 'suggested')[0]!.id)
    expect(plan).toMatchObject({ status: 'ended', paidPayments: 4 })
    expect(notItsPayment(ctx, plan.id, pays[3]!.id)).toMatchObject({ status: 'active', paidPayments: 3, nextDueDate: '2026-07-14' })

    // Stopped with payments left: an edit doesn't bring it back.
    updateRecurring(ctx, plan.id, { status: 'ended' })
    expect(updateRecurring(ctx, plan.id, { name: 'Shoes', totalPayments: 4 }).status).toBe('ended')
  })
})

describe('payments added at their own amount', () => {
  const add = async (ctx: AppContext, accountId: number, date: string, amountMinor: number, payee = 'AFFIRM') =>
    createTransaction(ctx, tx({ accountId, date, amountMinor, payee }), { useAi: false })
  /** A 5-payment plan of $100 a month from Jul 15, its first 3 paid, and a $300 down payment 5 days before the first. */
  const plan = async (ctx: AppContext) => {
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const down = await add(ctx, acc, '2026-07-10', -30_000)
    for (const date of ['2026-07-15', '2026-08-15', '2026-09-15']) await add(ctx, acc, date, -10_000)
    const item = createRecurring(
      ctx,
      recurringCreateSchema.parse({ payee: 'AFFIRM', name: 'Sofa', expectedAmountMinor: -10_000, cadence: 'monthly', anchorDate: '2026-07-15', totalPayments: 5, accountId: acc }),
    )
    return { ctx, acc, down, item }
  }

  it('adds a down payment: counted and categorized, the usual amount stays and its other payments too', async () => {
    const { ctx, down, item } = await plan(testContext())
    expect(item).toMatchObject({ paidPayments: 3, remainingPayments: 2 })
    expect(getTransaction(ctx, down.id).recurringItemId).toBeNull()
    // Offered with its payee's payments first.
    const offered = recurringPaymentCandidates(ctx, item.id, {})
    expect(offered.map((c) => [c.transaction.id, c.likely])).toEqual([[down.id, true]])

    const sofa = categoryId(ctx, 'Electronics')
    updateRecurring(ctx, item.id, { categoryId: sofa })
    // The down payment is in the first payment's period: it takes the one before.
    expect(addPayment(ctx, item.id, down.id)).toMatchObject({
      paidPayments: 4,
      remainingPayments: 1,
      expectedAmountMinor: -10_000,
      alerts: [],
      nextDueDate: '2026-10-15',
      remainingAmountMinor: -10_000,
      totalAmountMinor: -70_000,
    })
    expect(getTransaction(ctx, down.id)).toMatchObject({ recurringItemId: item.id, categoryId: sofa })
    expect(recurringPaymentIds(ctx, item.id)).toHaveLength(4)
    // Worked out again (an edit), it keeps all four.
    expect(updateRecurring(ctx, item.id, { amountTolerancePct: 5 })).toMatchObject({ paidPayments: 4, expectedAmountMinor: -10_000 })
    expect(recurringPaymentCandidates(ctx, item.id, {})).toEqual([])
  })

  it('adds a final payment far from the usual amount: the plan ends, and it was no price change', async () => {
    const { ctx, acc, down, item } = await plan(testContext())
    addPayment(ctx, item.id, down.id)
    // $43.21 is too far from $100 to be linked: it's asked about, as its last payment, and can be added.
    const last = await add(ctx, acc, '2026-10-15', -4321)
    expect(getTransaction(ctx, last.id).recurringItemId).toBeNull()
    expect(getRecurring(ctx, item.id).possiblePayment).toMatchObject({ transactionId: last.id, newAmount: false, role: 'last' })
    expect(addPayment(ctx, item.id, last.id)).toMatchObject({
      status: 'ended',
      paidPayments: 5,
      remainingPayments: 0,
      expectedAmountMinor: -10_000,
      totalAmountMinor: -64_321,
      endDate: '2026-10-15',
    })
    // It has all its payments now.
    const more = await add(ctx, acc, '2026-10-20', -1000)
    expect(() => addPayment(ctx, item.id, more.id)).toThrow(/has all 5 payments/)
    // And undone, it's back to expecting the last one.
    expect(notItsPayment(ctx, item.id, last.id)).toMatchObject({ status: 'active', paidPayments: 4, expectedAmountMinor: -10_000 })
  })

  it('links a plan’s last payment it asks about at its own amount, not as a new price', async () => {
    const { ctx, acc, down, item } = await plan(testContext())
    addPayment(ctx, item.id, down.id)
    const last = await add(ctx, acc, '2026-10-15', -7000)
    expect(getRecurring(ctx, item.id).possiblePayment).toMatchObject({ transactionId: last.id, newAmount: false, role: 'last' })
    expect(linkPossiblePayment(ctx, item.id, last.id)).toMatchObject({ status: 'ended', paidPayments: 5, expectedAmountMinor: -10_000, totalAmountMinor: -67_000 })
  })

  it('takes a down payment before the plan’s first payment, then matches the usual ones as they come', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const down = await add(ctx, acc, '2026-09-20', -30_000)
    const item = createRecurring(
      ctx,
      recurringCreateSchema.parse({ payee: 'AFFIRM', expectedAmountMinor: -10_000, cadence: 'monthly', anchorDate: '2026-10-01', totalPayments: 4, accountId: acc }),
    )
    // The only payment, at its own amount: no price change, nothing missing.
    expect(addPayment(ctx, item.id, down.id)).toMatchObject({ paidPayments: 1, expectedAmountMinor: -10_000, alerts: [], nextDueDate: '2026-10-01' })
    const first = await add(ctx, acc, '2026-10-01', -10_000)
    expect(getTransaction(ctx, first.id).recurringItemId).toBe(item.id)
    expect(getRecurring(ctx, item.id)).toMatchObject({ paidPayments: 2, nextDueDate: '2026-11-01', alerts: [] })
  })

  it('keeps a plan’s payments when its last one, a little smaller, is the newest', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const date of ['2026-05-20', '2026-06-20', '2026-07-20', '2026-08-20', '2026-09-20']) await add(ctx, acc, date, -41_210)
    const item = createRecurring(
      ctx,
      recurringCreateSchema.parse({ payee: 'AFFIRM', expectedAmountMinor: -41_210, cadence: 'monthly', anchorDate: '2026-05-20', totalPayments: 6, amountTolerancePct: 10 }),
    )
    // 9.7% less: within the variation, so it links and the plan ends.
    await add(ctx, acc, '2026-10-20', -37_200)
    expect(getRecurring(ctx, item.id)).toMatchObject({ status: 'ended', paidPayments: 6 })
    // Worked out again, the earlier ones are still compared with its amount, not with the last one.
    expect(updateRecurring(ctx, item.id, { name: 'Bike' })).toMatchObject({ status: 'ended', paidPayments: 6, expectedAmountMinor: -41_210, totalAmountMinor: -243_250 })
  })

  it('keeps a paid-off plan the scan found with its smaller last payment, once you confirm it', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const date of ['2026-02-20', '2026-03-20', '2026-04-20', '2026-05-20', '2026-06-20']) await add(ctx, acc, date, -41_210)
    await add(ctx, acc, '2026-07-20', -30_000)
    detectRecurring(ctx)
    const found = listRecurring(ctx, 'suggested')[0]!
    expect(found).toMatchObject({ totalPayments: 6, paidPayments: 6 })
    expect(confirmRecurring(ctx, found.id)).toMatchObject({ status: 'ended', paidPayments: 6, expectedAmountMinor: -41_210, totalAmountMinor: -236_050 })
  })

  it('counts one from before its linked payments as one you said was paid before your history', async () => {
    const { ctx, down, item } = await plan(testContext())
    // You said 4 were paid: the app had found 3.
    expect(updateRecurring(ctx, item.id, { paidPayments: 4 })).toMatchObject({ paidPayments: 4 })
    expect(addPayment(ctx, item.id, down.id)).toMatchObject({ paidPayments: 4, remainingPayments: 1 })
  })

  it('refuses an account or category that doesn’t exist, instead of failing', () => {
    const ctx = testContext()
    const bill = { payee: 'Hydro', expectedAmountMinor: -8000, cadence: 'monthly', anchorDate: '2026-10-01' }
    expect(() => createRecurring(ctx, recurringCreateSchema.parse({ ...bill, accountId: 99_999 }))).toThrow('That account does not exist')
    expect(() => createRecurring(ctx, recurringCreateSchema.parse({ ...bill, categoryId: 99_999 }))).toThrow('That category does not exist')
    const item = createRecurring(ctx, recurringCreateSchema.parse(bill))
    expect(() => updateRecurring(ctx, item.id, { categoryId: 99_999 })).toThrow('That category does not exist')
  })

  it('adds only a payment from its account, the same way, to an item you track', async () => {
    const { ctx, item } = await plan(testContext())
    const other = makeAccount(ctx, 'Chequing', 'chequing')
    const elsewhere = await add(ctx, other, '2026-07-10', -30_000)
    expect(() => addPayment(ctx, item.id, elsewhere.id)).toThrow(/another account/)
    const refund = await add(ctx, item.accountId!, '2026-07-20', 5000)
    expect(() => addPayment(ctx, item.id, refund.id)).toThrow(/money in/)
    expect(recurringPaymentCandidates(ctx, item.id, {}).map((c) => c.transaction.id)).not.toContain(elsewhere.id)
    // Searched, at any date, and from other payees.
    const old = await add(ctx, item.accountId!, '2025-01-02', -2500, 'Sofa Store')
    expect(recurringPaymentCandidates(ctx, item.id, { q: 'sofa store' })).toMatchObject([{ transaction: { id: old.id }, likely: false }])
    updateRecurring(ctx, item.id, { status: 'suggested' })
    expect(() => addPayment(ctx, item.id, old.id)).toThrow(/Confirm it first/)
  })
})

describe('a plan’s full price', () => {
  const pay = (ctx: AppContext, accountId: number, payee: string, amountMinor: number, date: string) =>
    createTransaction(ctx, tx({ accountId, date, amountMinor, payee }), { useAi: false })
  const plan = (ctx: AppContext, input: Record<string, unknown>) =>
    createRecurring(ctx, recurringCreateSchema.parse({ cadence: 'biweekly', amountTolerancePct: 10, ...input }))

  it('predicts the last payment from what’s left of it, for what’s left and what’s coming up', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of ['2026-09-08', '2026-09-22']) await pay(ctx, acc, 'KLARNA*SONOS', -9975, d)
    const item = plan(ctx, { payee: 'KLARNA*SONOS', expectedAmountMinor: -9975, anchorDate: '2026-09-08', totalPayments: 4, fullPriceMinor: -39_901 })
    expect(item).toMatchObject({ paidPayments: 2, fullPriceMinor: -39_901, lastPaymentMinor: -9976, remainingAmountMinor: -19_951, totalAmountMinor: -39_901 })
    expect(upcomingPayments(ctx, 30).map((u) => [u.dueDate, u.amountMinor, u.paymentNumber])).toEqual([
      ['2026-10-06', -9975, 3],
      ['2026-10-20', -9976, 4],
    ])
  })

  it('gives two plans from one payee each their own payment, the last one by what’s left of its price', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of ['2026-09-01', '2026-09-15']) {
      await pay(ctx, acc, 'KLARNA', -9875, d)
      await pay(ctx, acc, 'KLARNA', -4980, d)
    }
    // A ends with $50.00, what's left of its price. B's usual $49.80 is closer to that than A's $98.75.
    const a = plan(ctx, { payee: 'KLARNA', name: 'Speaker', expectedAmountMinor: -9875, anchorDate: '2026-09-01', totalPayments: 3, fullPriceMinor: -24_750 })
    const b = plan(ctx, { payee: 'KLARNA', name: 'Lamp', expectedAmountMinor: -4980, anchorDate: '2026-09-01', totalPayments: 4 })
    expect(a.lastPaymentMinor).toBe(-5000)
    const final = await pay(ctx, acc, 'KLARNA', -5000, '2026-09-29')
    const lamp = await pay(ctx, acc, 'KLARNA', -4980, '2026-09-29')
    expect(getTransaction(ctx, final.id).recurringItemId).toBe(a.id)
    expect(getTransaction(ctx, lamp.id).recurringItemId).toBe(b.id)
    expect(getRecurring(ctx, a.id)).toMatchObject({ status: 'ended', paidPayments: 3, totalAmountMinor: -24_750 })
    expect(getRecurring(ctx, b.id)).toMatchObject({ status: 'active', paidPayments: 3 })
    // Worked out again, each keeps its own.
    expect(updateRecurring(ctx, a.id, { name: 'Speakers' })).toMatchObject({ status: 'ended', paidPayments: 3 })
    expect(updateRecurring(ctx, b.id, { name: 'Lamps' })).toMatchObject({ status: 'active', paidPayments: 3 })
    expect(getTransaction(ctx, final.id).recurringItemId).toBe(a.id)
  })

  it('asks about a plan’s payment much later than its due date instead of taking it', async () => {
    const ctx = testContext({ now: '2026-10-20T18:00:00Z' })
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of ['2026-07-01', '2026-08-01', '2026-09-01']) await pay(ctx, acc, 'AFFIRM', -12_500, d)
    const item = plan(ctx, { payee: 'AFFIRM', expectedAmountMinor: -12_500, cadence: 'monthly', anchorDate: '2026-07-01', totalPayments: 6 })
    const late = await pay(ctx, acc, 'AFFIRM', -12_500, '2026-10-15')
    expect(getTransaction(ctx, late.id).recurringItemId).toBeNull()
    expect(getRecurring(ctx, item.id).possiblePayment).toMatchObject({ transactionId: late.id, newAmount: false, role: null, dueDate: '2026-10-01' })
    expect(linkPossiblePayment(ctx, item.id, late.id)).toMatchObject({ paidPayments: 4, expectedAmountMinor: -12_500 })
  })

  it('offers a missing first payment only when it makes the payments add up to the full price', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const first = await pay(ctx, acc, 'KLARNA*TENT', -3500, '2026-08-10')
    await pay(ctx, acc, 'KLARNA*TENT', -4712, '2026-08-17')
    for (const d of ['2026-08-24', '2026-09-07', '2026-09-21']) await pay(ctx, acc, 'KLARNA*TENT', -2500, d)
    const bare = { payee: 'KLARNA*TENT', expectedAmountMinor: -2500, anchorDate: '2026-08-24', totalPayments: 4 }
    // Without a full price nothing says one is missing.
    const item = plan(ctx, bare)
    expect(item).toMatchObject({ paidPayments: 3, possiblePayment: null })
    // With it, only the $35.00 makes $110.00: not the $47.12 from the same payee.
    expect(updateRecurring(ctx, item.id, { fullPriceMinor: -11_000 })).toMatchObject({
      lastPaymentMinor: -3500,
      possiblePayment: { transactionId: first.id, role: 'first', newAmount: false },
    })
    expect(linkPossiblePayment(ctx, item.id, first.id)).toMatchObject({ status: 'ended', paidPayments: 4, expectedAmountMinor: -2500, totalAmountMinor: -11_000 })
  })

  it('is only a plan’s, and money out like its payments', () => {
    const ctx = testContext()
    const bill = { payee: 'Hydro', expectedAmountMinor: -8000, cadence: 'monthly', anchorDate: '2026-10-01' }
    expect(() => createRecurring(ctx, recurringCreateSchema.parse({ ...bill, fullPriceMinor: -96_000 }))).toThrow('Only an instalment plan has a full price')
    expect(() => createRecurring(ctx, recurringCreateSchema.parse({ ...bill, totalPayments: 12, fullPriceMinor: 96_000 }))).toThrow('money out')
    const item = createRecurring(ctx, recurringCreateSchema.parse({ ...bill, totalPayments: 12, fullPriceMinor: -96_001 }))
    expect(item).toMatchObject({ fullPriceMinor: -96_001, lastPaymentMinor: -8001 })
    // No longer a plan: no full price either.
    expect(updateRecurring(ctx, item.id, { totalPayments: null })).toMatchObject({ fullPriceMinor: null, lastPaymentMinor: null })
  })
})

describe('cases from the 0.2.0 review', () => {
  const pay = (ctx: AppContext, accountId: number, payee: string, amountMinor: number, date: string) =>
    createTransaction(ctx, tx({ accountId, date, amountMinor, payee }), { useAi: false })
  const item = (ctx: AppContext, input: Record<string, unknown>) => createRecurring(ctx, recurringCreateSchema.parse({ cadence: 'monthly', amountTolerancePct: 10, ...input }))
  const monthly = (from: string, n: number) => Array.from({ length: n }, (_, i) => addMonthsToDate(from, i))

  it('keeps the next regular payment after an extra one you added', async () => {
    const ctx = testContext({ now: '2026-11-10T18:00:00Z' })
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of monthly('2026-08-01', 3)) await pay(ctx, acc, 'ROGERS', -5000, d)
    const bill = item(ctx, { payee: 'ROGERS', expectedAmountMinor: -5000, anchorDate: '2026-08-01' })
    const extra = await pay(ctx, acc, 'ROGERS', -2000, '2026-10-10')
    addPayment(ctx, bill.id, extra.id)
    const nov = await pay(ctx, acc, 'ROGERS', -5000, '2026-11-01')
    expect(getTransaction(ctx, nov.id).recurringItemId).toBe(bill.id)
    expect(updateRecurring(ctx, bill.id, { name: 'Internet' })).toMatchObject({ occurrences: 5, nextDueDate: '2026-12-01' })
    expect(getTransaction(ctx, nov.id).recurringItemId).toBe(bill.id)
  })

  it('gives back a payment from before your history when the one you added for it is taken off or deleted', async () => {
    for (const how of ['not its', 'deleted'] as const) {
      const ctx = testContext({ now: '2026-11-10T18:00:00Z' })
      const acc = makeAccount(ctx, 'Visa', 'credit')
      for (const d of monthly('2026-08-15', 3)) await pay(ctx, acc, 'AFFIRM', -10_000, d)
      const plan = item(ctx, { payee: 'AFFIRM', expectedAmountMinor: -10_000, anchorDate: '2026-08-15', totalPayments: 5, accountId: acc })
      expect(updateRecurring(ctx, plan.id, { paidPayments: 4 })).toMatchObject({ paidPayments: 4, remainingPayments: 1 })
      const down = await pay(ctx, acc, 'AFFIRM', -30_000, '2026-07-20')
      expect(addPayment(ctx, plan.id, down.id)).toMatchObject({ paidPayments: 4, remainingPayments: 1 })
      if (how === 'not its') notItsPayment(ctx, plan.id, down.id)
      else deleteTransaction(ctx, down.id)
      expect(getRecurring(ctx, plan.id), how).toMatchObject({ paidPayments: 4, remainingPayments: 1 })
    }
  })

  it('ends a plan whose other payments were all before your history when its last comes at another amount', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const plan = item(ctx, { payee: 'AFFIRM', expectedAmountMinor: -10_000, anchorDate: '2026-10-01', totalPayments: 4, paidPayments: 3, accountId: acc })
    const last = await pay(ctx, acc, 'AFFIRM', -4321, '2026-10-01')
    expect(getRecurring(ctx, plan.id).possiblePayment).toMatchObject({ transactionId: last.id, role: 'last' })
    expect(linkPossiblePayment(ctx, plan.id, last.id)).toMatchObject({ status: 'ended', paidPayments: 4, remainingPayments: 0 })
  })

  it('keeps a full-priced plan’s last payment when its down payment came from another payee', async () => {
    const ctx = testContext({ now: '2026-11-20T18:00:00Z' })
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of monthly('2026-08-15', 3)) await pay(ctx, acc, 'AFFIRM', -10_000, d)
    const plan = item(ctx, { payee: 'AFFIRM', name: 'Sofa', expectedAmountMinor: -10_000, anchorDate: '2026-08-15', totalPayments: 5, fullPriceMinor: -64_321, accountId: acc })
    const down = await pay(ctx, acc, 'SOFA STORE', -30_000, '2026-08-01')
    expect(addPayment(ctx, plan.id, down.id)).toMatchObject({ paidPayments: 4, lastPaymentMinor: -4321 })
    const last = await pay(ctx, acc, 'AFFIRM', -4321, '2026-11-15')
    expect(getRecurring(ctx, plan.id)).toMatchObject({ status: 'ended', paidPayments: 5 })
    expect(updateRecurring(ctx, plan.id, { name: 'Couch' })).toMatchObject({ status: 'ended', paidPayments: 5 })
    expect(getTransaction(ctx, last.id).recurringItemId).toBe(plan.id)
  })

  it('keeps a plan’s payments whose amount drifted up within its price variation', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const plan = item(ctx, { payee: 'CAR LOAN', expectedAmountMinor: -10_000, anchorDate: '2026-05-01', totalPayments: 24, amountTolerancePct: 5, accountId: acc })
    const amounts = [-10_000, -10_000, -10_300, -10_300, -10_600, -10_600]
    for (const [i, d] of monthly('2026-05-01', 6).entries()) await pay(ctx, acc, 'CAR LOAN', amounts[i]!, d)
    expect(getRecurring(ctx, plan.id).paidPayments).toBe(6)
    expect(updateRecurring(ctx, plan.id, { name: 'Car' })).toMatchObject({ paidPayments: 6 })
  })

  it('doesn’t link a plan’s payment much later than its due date on an edit either', async () => {
    const ctx = testContext({ now: '2026-10-20T18:00:00Z' })
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of ['2026-08-01', '2026-09-01']) await pay(ctx, acc, 'AFFIRM', -12_500, d)
    const plan = item(ctx, { payee: 'AFFIRM', expectedAmountMinor: -12_500, anchorDate: '2026-08-01', totalPayments: 6, accountId: acc })
    const late = await pay(ctx, acc, 'AFFIRM', -12_500, '2026-10-15')
    updateRecurring(ctx, plan.id, { name: 'Couch' })
    expect(getTransaction(ctx, late.id).recurringItemId).toBeNull()
    expect(getRecurring(ctx, plan.id).possiblePayment).toMatchObject({ transactionId: late.id })
  })

  it('still finds a monthly bill with two extra or late payments, and two subscriptions at one price', async () => {
    const found = (ctx: AppContext) => listRecurring(ctx, 'suggested').map((i) => [i.payee, i.cadence, i.expectedAmountMinor])
    const water = testContext({ now: '2026-10-14T18:00:00Z' })
    let acc = makeAccount(water, 'Chequing', 'chequing')
    for (const d of [...monthly('2026-05-05', 6), '2026-07-20', '2026-09-22']) await pay(water, acc, 'CITY WATER', -6000, d)
    detectRecurring(water)
    expect(found(water)).toEqual([['CITY WATER', 'monthly', -6000]])

    const gas = testContext({ now: '2026-10-14T18:00:00Z' })
    acc = makeAccount(gas, 'Chequing', 'chequing')
    for (const d of ['2026-05-05', '2026-06-12', '2026-07-05', '2026-08-12', '2026-09-05', '2026-10-05']) await pay(gas, acc, 'ENBRIDGE GAS', -8000, d)
    detectRecurring(gas)
    expect(found(gas)).toEqual([['ENBRIDGE GAS', 'monthly', -8000]])

    const apps = testContext({ now: '2026-10-14T18:00:00Z' })
    acc = makeAccount(apps, 'Visa', 'credit')
    for (const d of [...monthly('2026-04-03', 7), ...monthly('2026-03-24', 7)]) await pay(apps, acc, 'GOOGLE *PLAY', -279, d)
    detectRecurring(apps)
    expect(found(apps).map(([, c]) => c)).toEqual(['monthly', 'monthly'])
  })

  it('finds a plan’s own payee’s payments to add on a busy card', async () => {
    const ctx = testContext({ now: '2026-11-10T18:00:00Z' })
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const down = await pay(ctx, acc, 'AFFIRM', -30_000, '2026-07-20')
    for (const d of monthly('2026-08-15', 3)) await pay(ctx, acc, 'AFFIRM', -10_000, d)
    for (let i = 0; i < 400; i++) await pay(ctx, acc, `SHOP ${i}`, -500, addDays('2026-07-25', i % 100))
    const plan = item(ctx, { payee: 'AFFIRM', expectedAmountMinor: -10_000, anchorDate: '2026-08-15', totalPayments: 5, accountId: acc })
    expect(recurringPaymentCandidates(ctx, plan.id, {})[0]).toMatchObject({ transaction: { id: down.id }, likely: true })
  })
})

function detectAnd(ctx: AppContext) {
  detectRecurring(ctx)
  return ctx
}
