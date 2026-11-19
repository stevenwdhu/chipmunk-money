import { describe, expect, it } from 'vitest'
import { accountBankSwitchSchema, recurringCreateSchema, transactionCreateSchema, transactionQuerySchema } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import { sharedWorld } from '../test/shared-accounts'
import { getAccount } from './accounts'
import { applySwitch } from './bank/switching'
import type { AppContext } from './context'
import { addPayment, createRecurring, detectRecurring, getRecurring, listRecurring, updateRecurring } from './recurring'
import { exportRows } from './reports'
import { createTransaction, getTransaction, listAccountTransactions, listTransactions, updateTransaction } from './transactions'

const NOW = '2026-11-10T18:00:00Z'
const add = (ctx: AppContext, accountId: number, date: string, amountMinor: number, payee: string, status = 'cleared') =>
  createTransaction(ctx, transactionCreateSchema.parse({ accountId, date, amountMinor, payee, status }), { useAi: false })
/** A sort key as it was before pending ones had their own place: a posted one's still is. */
const POSTED_KEY = /^\d{4}-\d{2}-\d{2}\|[012]\|[\d:T-]*\|\d{12}$/

describe('pending transactions on top', () => {
  /** A chequing account opened with $1,000.00 and six transactions, two of them pending: $1,009.50 in all. */
  const register = async () => {
    const ctx = testContext({ now: NOW })
    const acc = makeAccount(ctx, 'Chequing', 'chequing', 100_000)
    await add(ctx, acc, '2026-10-01', -1000, 'Alpha')
    await add(ctx, acc, '2026-10-02', -2000, 'Bravo', 'pending')
    await add(ctx, acc, '2026-10-03', 5000, 'Charlie')
    await add(ctx, acc, '2026-10-05', -300, 'Delta')
    await add(ctx, acc, '2026-10-06', -700, 'Echo', 'pending')
    await add(ctx, acc, '2026-10-04', -50, 'Foxtrot')
    return { ctx, acc }
  }
  /** Every page of a list, `limit` rows at a time. */
  const paged = <T>(page: (cursor?: string) => { items: T[]; nextCursor: string | null }) => {
    const all: T[] = []
    const cursors: string[] = []
    for (let cursor: string | undefined; ; ) {
      const p = page(cursor)
      all.push(...p.items)
      if (!p.nextCursor) return { all, cursors }
      cursors.push((cursor = p.nextCursor))
    }
  }

  it('lists pending ones first, newest first, then the posted ones, and the running balance follows that order', async () => {
    const { ctx, acc } = await register()
    expect(getAccount(ctx, acc).balanceMinor).toBe(100_950)
    // Echo is the newest pending one. Bravo, pending too, is older than Charlie, Foxtrot and Delta, and above them.
    // Each balance is the one above less the row above: 1,009.50, +7.00, +20.00, +3.00, +0.50, −50.00,
    // and the oldest row's is the opening $1,000.00 less its $10.00.
    const expected = [
      ['Echo', 100_950],
      ['Bravo', 101_650],
      ['Delta', 103_650],
      ['Foxtrot', 103_950],
      ['Charlie', 104_000],
      ['Alpha', 99_000],
    ]
    for (const limit of [1, 2, 4, 50]) {
      const { all } = paged((cursor) => listTransactions(ctx, transactionQuerySchema.parse({ accountId: acc, limit, cursor })))
      expect(all.map((t) => [t.payee, t.balanceAfterMinor]), `${limit} at a time`).toEqual(expected)
    }
    // The whole ledger's list has the same order, and so does a range of dates.
    expect(listTransactions(ctx, transactionQuerySchema.parse({ limit: 50 })).items.map((t) => t.payee)).toEqual(expected.map(([payee]) => payee))
    expect(listTransactions(ctx, transactionQuerySchema.parse({ from: '2026-10-02', to: '2026-10-04', limit: 50 })).items.map((t) => t.payee)).toEqual(['Bravo', 'Foxtrot', 'Charlie'])
  })

  it('exports oldest first, with the pending ones last', async () => {
    const { ctx } = await register()
    expect(exportRows(ctx).map((r) => [r.payee, r.status])).toEqual([
      ['Alpha', 'cleared'],
      ['Charlie', 'cleared'],
      ['Foxtrot', 'cleared'],
      ['Delta', 'cleared'],
      ['Bravo', 'pending'],
      ['Echo', 'pending'],
    ])
  })

  it('lists a shared account’s pending ones first in every ledger’s rows, to the account’s total', () => {
    const w = sharedWorld({ now: NOW })
    const pending = (ctx: AppContext, id: number) => ctx.q.run("UPDATE transactions SET status = 'pending' WHERE ledger_id = @ledger AND id = ?", id)
    w.addTx(w.personal, '2026-09-28', -1000, { payee: 'Alpha' })
    pending(w.personal, w.addTx(w.personal, '2026-09-30', -400, { payee: 'Bravo' }))
    w.addTx(w.family, '2026-09-29', -2000, { payee: 'Charlie' })
    pending(w.family, w.addTx(w.family, '2026-09-27', -600, { payee: 'Delta' }))
    // $40.00 owed in all. Bravo then Delta are pending. Each balance is the one above less the row above.
    const expected = [
      ['Bravo', 'pending', -4000],
      ['Delta', 'pending', -3600],
      ['Charlie', 'cleared', -3000],
      ['Alpha', 'cleared', -1000],
    ]
    for (const limit of [1, 2, 3, 50]) {
      const { all } = paged((cursor) => listAccountTransactions(w.personal, w.visa, { limit, cursor }, null))
      expect(all.map((t) => [t.payee, t.status, t.balanceAfterMinor]), `${limit} at a time`).toEqual(expected)
    }
  })

  it('lists and pages a ledger without pending ones as before, with the cursors it had', async () => {
    const ctx = testContext({ now: NOW })
    const acc = makeAccount(ctx, 'Chequing', 'chequing', 100_000)
    await add(ctx, acc, '2026-10-01', -1000, 'Alpha')
    await add(ctx, acc, '2026-10-03', 5000, 'Charlie')
    await add(ctx, acc, '2026-10-03', -300, 'Delta')
    const { all, cursors } = paged((cursor) => listTransactions(ctx, transactionQuerySchema.parse({ accountId: acc, limit: 1, cursor })))
    // Money out comes last in a day on a bank account, so Delta is above Charlie: 1,037.00, then +3.00, then −50.00.
    expect(all.map((t) => [t.payee, t.balanceAfterMinor])).toEqual([
      ['Delta', 103_700],
      ['Charlie', 104_000],
      ['Alpha', 99_000],
    ])
    expect(cursors).toHaveLength(2)
    for (const c of cursors) expect(c).toMatch(POSTED_KEY)
    // A pending one elsewhere in the list doesn't change a posted one's place or cursor.
    await add(ctx, acc, '2026-09-01', -100, 'Echo', 'pending')
    const again = paged((cursor) => listTransactions(ctx, transactionQuerySchema.parse({ accountId: acc, limit: 1, cursor })))
    expect(again.all.map((t) => t.payee)).toEqual(['Echo', 'Delta', 'Charlie', 'Alpha'])
    expect(again.cursors.slice(1)).toEqual(cursors)
  })
})

describe('pending transactions and recurring items', () => {
  /** A $50 monthly bill within 10%, with its Aug 1, Sep 1 and Oct 1 payments: due next on Nov 1. */
  const bill = async () => {
    const ctx = testContext({ now: NOW })
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of ['2026-08-01', '2026-09-01', '2026-10-01']) await add(ctx, acc, d, -5000, 'ROGERS')
    const item = createRecurring(
      ctx,
      recurringCreateSchema.parse({ payee: 'ROGERS', expectedAmountMinor: -5000, cadence: 'monthly', amountTolerancePct: 10, anchorDate: '2026-08-01', categoryId: categoryId(ctx, 'Electronics') }),
    )
    expect(item).toMatchObject({ occurrences: 3, nextDueDate: '2026-11-01' })
    return { ctx, acc, item }
  }

  it('doesn’t take a pending payment, new or at a recalculation, and takes it once it’s no longer pending', async () => {
    const { ctx, acc, item } = await bill()
    const nov = await add(ctx, acc, '2026-11-01', -5000, 'ROGERS', 'pending')
    expect(getTransaction(ctx, nov.id).recurringItemId).toBeNull()
    expect(updateRecurring(ctx, item.id, { name: 'Internet' })).toMatchObject({ occurrences: 3, nextDueDate: '2026-11-01' })
    // Its amount settles while it's still pending: still not the item's.
    expect(updateTransaction(ctx, nov.id, { amountMinor: -5100 }).recurringItemId).toBeNull()
    // Posted by hand: the item's 4th payment, in its category, and December's is next.
    expect(updateTransaction(ctx, nov.id, { status: 'cleared' })).toMatchObject({ recurringItemId: item.id, categoryId: categoryId(ctx, 'Electronics') })
    expect(getRecurring(ctx, item.id)).toMatchObject({ occurrences: 4, nextDueDate: '2026-12-01' })
  })

  it('drops a pending payment it took on its own at its next recalculation, and takes it back once it posts', async () => {
    const { ctx, acc, item } = await bill()
    // As before pending ones were left alone: linked on its own, then still pending.
    const nov = await add(ctx, acc, '2026-11-01', -5000, 'ROGERS')
    expect(getTransaction(ctx, nov.id).recurringItemId).toBe(item.id)
    ctx.q.run("UPDATE transactions SET status = 'pending' WHERE ledger_id = @ledger AND id = ?", nov.id)
    expect(updateRecurring(ctx, item.id, { name: 'Internet' })).toMatchObject({ occurrences: 3, nextDueDate: '2026-11-01' })
    expect(getTransaction(ctx, nov.id)).toMatchObject({ recurringItemId: null, categoryId: null })
    expect(updateTransaction(ctx, nov.id, { status: 'cleared' }).recurringItemId).toBe(item.id)
    // Marked pending again by hand, it comes off: the item works its payments out again.
    expect(updateTransaction(ctx, nov.id, { status: 'pending' }).recurringItemId).toBeNull()
    expect(getRecurring(ctx, item.id)).toMatchObject({ occurrences: 3, nextDueDate: '2026-11-01' })
  })

  it('keeps a pending payment added by hand through recalculations', async () => {
    const { ctx, acc, item } = await bill()
    const extra = await add(ctx, acc, '2026-11-03', -2000, 'ROGERS', 'pending')
    expect(addPayment(ctx, item.id, extra.id).occurrences).toBe(4)
    const other = await add(ctx, acc, '2026-11-04', -9900, 'BELL', 'pending')
    expect(updateTransaction(ctx, other.id, { recurringItemId: item.id }).recurringItemId).toBe(item.id)
    expect(updateRecurring(ctx, item.id, { name: 'Internet' }).occurrences).toBe(5)
    expect([extra, other].map((t) => getTransaction(ctx, t.id).recurringItemId)).toEqual([item.id, item.id])
    // And when it posts.
    expect(updateTransaction(ctx, extra.id, { status: 'cleared' }).recurringItemId).toBe(item.id)
    expect(getRecurring(ctx, item.id).occurrences).toBe(5)
  })

  it('takes a pending payment that a switch to another service pairs with a posted one', async () => {
    const { ctx, acc, item } = await bill()
    const nov = await add(ctx, acc, '2026-11-01', -5000, 'ROGERS', 'pending')
    const kept = await add(ctx, acc, '2026-11-02', -5000, 'ROGERS', 'pending')
    const remote = [
      { remoteId: 'n1', date: '2026-11-02', amountMinor: -5000, payee: 'ROGERS', description: 'ROGERS', pending: false },
      { remoteId: 'n2', date: '2026-11-02', amountMinor: -5000, payee: 'ROGERS', description: 'ROGERS', pending: true },
    ]
    const pairs = [
      { transactionId: nov.id, remoteId: 'n1' },
      { transactionId: kept.id, remoteId: 'n2' },
    ]
    const input = accountBankSwitchSchema.parse({ bankAccountId: 'b', version: 'v', from: '2026-10-15', pairs })
    expect(applySwitch(ctx, () => ctx, acc, 'plaid', remote, input)).toMatchObject({ matched: 2, added: 0 })
    // The one that posted is the item's 4th payment. The one still pending isn't its.
    expect(getTransaction(ctx, nov.id)).toMatchObject({ status: 'cleared', date: '2026-11-02', recurringItemId: item.id })
    expect(getTransaction(ctx, kept.id)).toMatchObject({ status: 'pending', recurringItemId: null })
    expect(getRecurring(ctx, item.id)).toMatchObject({ occurrences: 4, nextDueDate: '2026-12-01' })
  })

  it('finds no schedule in pending payments, and counts none for a suggestion', async () => {
    const ctx = testContext({ now: '2026-12-01T18:00:00Z' })
    const acc = makeAccount(ctx, 'Visa', 'credit')
    for (const d of ['2026-08-28', '2026-09-28']) await add(ctx, acc, d, -2099, 'NETFLIX.COM')
    const third = await add(ctx, acc, '2026-10-28', -2099, 'NETFLIX.COM', 'pending')
    // Two posted payments aren't a schedule: the third is pending.
    expect(detectRecurring(ctx).created).toBe(0)
    updateTransaction(ctx, third.id, { status: 'cleared' })
    expect(detectRecurring(ctx).created).toBe(1)
    expect(listRecurring(ctx, 'suggested')[0]).toMatchObject({ occurrences: 3, expectedAmountMinor: -2099 })
    const fourth = await add(ctx, acc, '2026-11-28', -2099, 'NETFLIX.COM', 'pending')
    expect(listRecurring(ctx, 'suggested')[0]!.occurrences).toBe(3)
    updateTransaction(ctx, fourth.id, { status: 'cleared' })
    expect(listRecurring(ctx, 'suggested')[0]!.occurrences).toBe(4)
  })
})
