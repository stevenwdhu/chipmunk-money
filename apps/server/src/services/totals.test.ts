import { describe, expect, it } from 'vitest'
import { addTx, categoryId, twinAccounts, twinLedgers } from '../test/transaction-twins'
import { monthToDate } from './totals'

describe('month to date', () => {
  it('adds up each of the ledger’s accounts, leaving out transfers and what’s left out of totals', () => {
    const { a, b } = twinLedgers()
    const [accA, accB] = [twinAccounts(a), twinAccounts(b)]
    const groceries = categoryId(a, 'Groceries')
    for (const [ctx, acc, amount] of [[a, accA, -4_000], [b, accB, -9_000]] as const) {
      addTx(ctx, acc.card, '2026-09-02', amount, 'Loblaws', { categoryId: groceries })
      addTx(ctx, acc.card, '2026-09-10', -1_000, 'Loblaws', { categoryId: groceries })
      addTx(ctx, acc.card, '2026-08-30', -500, 'Loblaws', { categoryId: groceries })
      addTx(ctx, acc.chequing, '2026-09-05', -20_000, 'Visa payment', { transferAccountId: acc.card })
    }
    const dates = ['2026-09-05', '2026-09-30']
    expect(monthToDate(a, dates)).toEqual(new Map([[accA.card, [-4_000, -5_000]]]))
    expect(monthToDate(b, dates)).toEqual(new Map([[accB.card, [-9_000, -10_000]]]))
    expect(monthToDate(a, dates, accA.card).get(accA.card)).toEqual([-4_000, -5_000])
    expect(monthToDate(a, dates, accB.card)).toEqual(new Map())
  })
})
