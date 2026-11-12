import { describe, expect, it } from 'vitest'
import { accountTransactionPageSchema, type AccountTransaction } from '@chipmunk/shared'
import { categoryId, makeAccount } from '../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER } from '../test/shared-accounts'
import { getAccount, setBalance } from './accounts'
import type { AppContext } from './context'
import { moveTransactions } from './moves'
import { deleteTransaction, listAccountTransactions, updateTransaction } from './transactions'

/**
 * The all-ledgers list of a shared account: its rows in every ledger that has it, with the account's
 * running balance. Personal is Visa's home. The rows Family and Trip hold got there by a real move.
 */

const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    const err = e as { status?: number; message: string }
    return { status: err.status, message: err.message }
  }
  throw new Error('Expected it to be refused')
}

/** What an item has, and no more: nothing of another ledger's but names. */
const KEYS = ['amountMinor', 'balanceAfterMinor', 'category', 'currency', 'date', 'datetime', 'here', 'id', 'ledger', 'name', 'notes', 'origin', 'payee', 'payeeName', 'split', 'status']

function world(shareWith: Array<'family' | 'trip'>) {
  const w = sharedWorld({ shareWith, opening: -1_000 })
  const { personal, family, trip } = w
  const move = (ids: number[], to: AppContext) => moveTransactions(personal, w.ctxOf, { ids, to: to.ledger.id }, TESTER)
  // Two on one day, so the order within it counts. A balance recorded between them and the later rows.
  const rows = {
    cafe: w.addTx(personal, '2026-07-03', -450, { payee: 'Corner Cafe' }),
    market: w.addTx(personal, '2026-07-20', -3_200, { payee: 'Market' }),
    shoes: w.addTx(personal, '2026-08-02', -9_000, { payee: 'Shoes' }),
    gas: w.addTx(personal, '2026-08-02', -6_100, { payee: 'Gas Bar' }),
    refund: w.addTx(personal, '2026-08-10', 2_000, { payee: 'Shoes' }),
    books: w.addTx(personal, '2026-09-14', -1_500, { payee: 'Book Shop' }),
    gone: w.addTx(personal, '2026-09-20', -700, { payee: 'Pizza' }),
  }
  setBalance(personal, w.visa, { date: '2026-07-31', balanceMinor: -5_000 })
  move([rows.market, rows.gas, rows.gone], family)
  updateTransaction(family, rows.market, { categoryId: categoryId(family, 'Groceries'), notes: 'Week’s food' })
  deleteTransaction(family, rows.gone)
  if (shareWith.includes('trip')) move([rows.shoes, rows.refund], trip)
  const parts = expectPartsSumToAccount(w.storage, w.visa)
  expectNoCrossLedgerReferences(w.storage)
  /** Every page, `limit` at a time. */
  const pages = (ctx: AppContext, q: { from?: string; to?: string; limit?: number } = {}, allowed: readonly string[] | null = null) => {
    const items: AccountTransaction[] = []
    let count = 0
    for (let cursor: string | undefined; ; count++) {
      const page = listAccountTransactions(ctx, w.visa, { ...q, cursor }, allowed)
      expect(accountTransactionPageSchema.parse(page)).toEqual(page)
      items.push(...page.items)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    return { items, pages: count + 1 }
  }
  return { ...w, rows, parts, pages }
}

describe('the all-ledgers list of a shared account', () => {
  for (const shareWith of [['family'], ['family', 'trip']] as Array<Array<'family' | 'trip'>>) {
    it(`lists every ledger’s rows, newest first, ending at the account’s total, a page at a time (${shareWith.length + 1} ledgers)`, () => {
      const w = world(shareWith)
      const { personal, family, rows, parts } = w
      const holder = (id: number) => (id === rows.market || id === rows.gas ? 'family' : shareWith.includes('trip') && (id === rows.shoes || id === rows.refund) ? 'trip' : 'personal')

      const { items, pages } = w.pages(personal, { limit: 2 })
      expect(pages).toBe(3)
      // As a credit card's register lists them: by date, then the order they were added. Not the deleted one.
      expect(items.map((t) => t.id)).toEqual([rows.books, rows.refund, rows.gas, rows.shoes, rows.market, rows.cafe])
      expect(items.map((t) => t.ledger.slug)).toEqual(items.map((t) => holder(t.id)))
      expect(items.map((t) => t.here)).toEqual(items.map((t) => holder(t.id) === 'personal'))
      for (const t of items) expect(Object.keys(t).sort()).toEqual(KEYS)
      // The running balance is the account's total, like the bank's statement.
      expect(parts.totalMinor).toBe(getAccount(personal, w.visa).sharing!.totalBalanceMinor)
      expect(items[0]!.balanceAfterMinor).toBe(parts.totalMinor)
      items.slice(1).forEach((t, i) => expect(t.balanceAfterMinor, `after ${t.payee}`).toBe(items[i]!.balanceAfterMinor - items[i]!.amountMinor))
      // Family's row: its category by name and its notes. No item has an id of Family's but its own (KEYS).
      expect(items.find((t) => t.id === rows.market)).toMatchObject({
        ledger: { slug: 'family', name: 'Family' },
        category: 'Groceries',
        notes: 'Week’s food',
        payee: 'Market',
        payeeName: 'Market',
        amountMinor: -3_200,
        status: 'cleared',
        origin: 'manual',
      })

      // The same list in Family, `here` the other way.
      const fromFamily = w.pages(family, { limit: 4 })
      expect(fromFamily.pages).toBe(2)
      expect(fromFamily.items).toEqual(items.map((t) => ({ ...t, here: t.ledger.slug === 'family' })))

      // Between dates, still the account's running balance: the rows after them taken off.
      const august = w.pages(personal, { from: '2026-08-01', to: '2026-08-31' }).items
      expect(august).toEqual(items.filter((t) => t.date >= '2026-08-01' && t.date <= '2026-08-31'))

      expect(status(() => listAccountTransactions(personal, w.visa, { cursor: 'nope' }, null))).toEqual({ status: 400, message: 'Invalid cursor' })
      expectNoCrossLedgerReferences(w.storage)
    })
  }

  it('is for a shared account, and for a caller allowed in every ledger that has it', () => {
    const w = world(['family', 'trip'])
    const { personal, family, trip } = w
    const chequing = makeAccount(personal, 'Chequing')
    expect(status(() => listAccountTransactions(personal, chequing, {}, null))).toEqual({
      status: 409,
      message: 'Chequing isn’t shared, so all its transactions are in this ledger.',
    })
    const refused = { status: 403, message: 'This key can’t see every ledger that has Visa' }
    expect(status(() => listAccountTransactions(personal, w.visa, {}, [personal.ledger.id]))).toEqual(refused)
    expect(status(() => listAccountTransactions(family, w.visa, {}, [personal.ledger.id, family.ledger.id]))).toEqual(refused)
    expect(listAccountTransactions(trip, w.visa, {}, [personal.ledger.id, family.ledger.id, trip.ledger.id]).items).toHaveLength(6)

    // A ledger that doesn't have the account doesn't find it.
    const two = world(['family'])
    expect(status(() => listAccountTransactions(two.trip, two.visa, {}, null))).toEqual({ status: 404, message: 'Account not found' })
  })
})
