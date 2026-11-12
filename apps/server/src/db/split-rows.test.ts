import { describe, expect, it } from 'vitest'
import { addLedger, addSharedList, bareDatabase, bareWriter, fillLedger } from '../test/world'
import { deleteLedgerRows } from './tables'

/**
 * Migration 0003: split payments. A payment on a shared account and its split rows (split_of), one
 * per ledger (tx_split), held to a live payment on their account (guard_transactions_split), and
 * kept where they are while the split lasts (keep_split_rows, keep_split_payment). Raw SQL on a
 * migrated database without the write guards, as in move-rows.test.ts.
 */

const SPLIT = 'change or undo the split first'
const PIECE = "a split row is a piece of a live payment on its account that isn't a split row"

/** Ledgers A and B filled, A's card shared with B, C with nothing of it, and a $100 payment onto the card in A split $80 to B. */
function world() {
  const sqlite = bareDatabase()
  for (const id of ['A', 'B', 'C']) addLedger(sqlite, id)
  const shared = addSharedList(sqlite)
  const a = fillLedger(bareWriter(sqlite, 'A'), { category: shared.food, offCategory: shared.fun })
  const b = fillLedger(bareWriter(sqlite, 'B'), { category: shared.food, offCategory: shared.food })
  const bBank = bareWriter(sqlite, 'B')("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Shared bank')")
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  run('INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES (?, ?, ?)', 'B', a.account, bBank)
  const row = (ledger: string, amount: number, more: { splitOf?: number | null; account?: number; payee?: string; deleted?: string | null } = {}) =>
    Number(
      run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, split_of, deleted_at)
         VALUES (?, ?, '2026-09-10', ?, ?, lower(?), ?, ?)`,
        ledger,
        more.account ?? a.account,
        amount,
        more.payee ?? 'Payment',
        more.payee ?? 'Payment',
        more.splitOf ?? null,
        more.deleted ?? null,
      ).lastInsertRowid,
    )
  const payment = row('A', 10000)
  const share = row('B', 8000, { splitOf: payment })
  const given = row('A', -8000, { splitOf: payment, payee: 'Split between ledgers' })
  const get = (id: number) => sqlite.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  const update = (id: number, sets: string) => () => run(`UPDATE transactions SET ${sets} WHERE id = ?`, id)
  return { sqlite, shared, a, b, run, row, payment, share, given, get, update }
}

describe('guard_transactions_split', () => {
  it('lets a split row name a live payment on its account, and leaves a row that names none alone', () => {
    const w = world()
    expect(w.get(w.share)).toMatchObject({ ledger_id: 'B', split_of: w.payment })
    expect(w.get(w.given)).toMatchObject({ ledger_id: 'A', split_of: w.payment })
    // An ordinary row, on any account, deleted or not.
    expect(w.row('A', -100, { account: w.a.savings })).toBeGreaterThan(0)
    expect(w.row('B', -100, { deleted: '2026-10-01T00:00:00Z' })).toBeGreaterThan(0)
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('refuses a payment on another account, a deleted one, a split row, and one that isn’t there', () => {
    const w = world()
    const onSavings = w.row('A', 500, { account: w.a.savings })
    const deleted = w.row('A', 500, { deleted: '2026-10-01T00:00:00Z' })
    expect(() => w.row('B', 100, { splitOf: onSavings })).toThrow(PIECE)
    // Nor a row on another account of a payment on this one.
    expect(() => w.row('A', 100, { splitOf: w.payment, account: w.a.savings })).toThrow(PIECE)
    expect(() => w.row('B', 100, { splitOf: deleted })).toThrow(PIECE)
    expect(() => w.row('B', 100, { splitOf: w.share })).toThrow(PIECE)
    expect(() => w.row('B', 100, { splitOf: 999_999 })).toThrow(PIECE)
  })

  it('keeps one split row per ledger per payment (tx_split)', () => {
    const w = world()
    expect(() => w.row('B', 100, { splitOf: w.payment })).toThrow('UNIQUE constraint failed: transactions.split_of, transactions.ledger_id')
    // Another payment's, in the same ledger, is its own.
    const other = w.row('A', 3000)
    expect(w.row('B', 1000, { splitOf: other })).toBeGreaterThan(0)
  })
})

describe('keep_split_rows', () => {
  it('refuses a split row a new payment, and a plain row a payment to be a piece of', () => {
    const w = world()
    const other = w.row('A', 3000)
    expect(w.update(w.share, `split_of = ${other}`)).toThrow(SPLIT)
    expect(w.update(other, `split_of = ${w.payment}`)).toThrow(SPLIT)
    // A plain row stays plain, and setting what's there already changes nothing.
    w.update(other, 'split_of = NULL')()
    w.update(w.share, 'split_of = split_of')()
    expect(w.get(w.share)!.split_of).toBe(w.payment)
  })

  it('keeps a split row on its account and in its ledger, and live', () => {
    const w = world()
    expect(w.update(w.share, `account_id = ${w.b.account}`)).toThrow(SPLIT)
    expect(w.update(w.given, `account_id = ${w.a.savings}`)).toThrow(SPLIT)
    // Moved to a ledger that has the account, with nothing attached: still refused.
    expect(w.update(w.share, "ledger_id = 'A'")).toThrow(SPLIT)
    expect(w.update(w.share, "deleted_at = '2026-10-01T00:00:00Z'")).toThrow(SPLIT)
    expect(w.update(w.given, "deleted_at = '2026-10-01T00:00:00Z'")).toThrow(SPLIT)
    expect(w.get(w.share)).toMatchObject({ ledger_id: 'B', account_id: w.a.account, deleted_at: null })
  })

  it('keeps a payment that has split rows on its account and in its ledger, and live', () => {
    const w = world()
    expect(w.update(w.payment, `account_id = ${w.a.savings}`)).toThrow(SPLIT)
    expect(w.update(w.payment, "ledger_id = 'B'")).toThrow(SPLIT)
    expect(w.update(w.payment, "deleted_at = '2026-10-01T00:00:00Z'")).toThrow(SPLIT)
    expect(w.get(w.payment)).toMatchObject({ ledger_id: 'A', account_id: w.a.account, deleted_at: null })
  })

  it('lets everything else of a split row and a split payment change, and the same values be written again', () => {
    const w = world()
    w.update(w.payment, `amount_minor = 12000, date = '2026-09-11', status = 'pending', notes = 'x', category_id = ${w.shared.fun}, transfer_pair_id = NULL`)()
    w.update(w.share, `amount_minor = 7000, date = '2026-09-11', payee = 'Paid', notes = 'ours', name = 'Card', category_id = ${w.shared.fun}`)()
    w.update(w.given, 'amount_minor = -7000, needs_review = 1')()
    // Its account, ledger and deletion, as they are.
    w.update(w.payment, 'account_id = account_id, ledger_id = ledger_id, deleted_at = NULL')()
    w.update(w.share, 'account_id = account_id, ledger_id = ledger_id, deleted_at = deleted_at')()
    w.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', w.share, w.b.tag)
    expect(w.get(w.payment)).toMatchObject({ amount_minor: 12000, status: 'pending', deleted_at: null })
    expect(w.get(w.share)).toMatchObject({ amount_minor: 7000, payee: 'Paid', split_of: w.payment })
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('lets a split row go (split_of cleared), after which it and then the payment are ordinary rows', () => {
    const w = world()
    w.update(w.share, 'split_of = NULL')()
    // A detached row can change account in the same UPDATE that lets it go, or later, or be deleted.
    w.update(w.share, "deleted_at = '2026-10-01T00:00:00Z'")()
    // The payment still has its given row.
    expect(w.update(w.payment, "deleted_at = '2026-10-01T00:00:00Z'")).toThrow(SPLIT)
    w.update(w.given, `split_of = NULL, account_id = ${w.a.savings}`)()
    w.update(w.payment, "deleted_at = '2026-10-01T00:00:00Z'")()
    w.update(w.payment, `deleted_at = NULL, account_id = ${w.a.savings}`)()
    expect(w.get(w.payment)).toMatchObject({ account_id: w.a.savings, deleted_at: null })
  })
})

describe('keep_split_payment', () => {
  it('refuses deleting a payment for good while it has split rows, but not deleting a split row', () => {
    const w = world()
    const del = (id: number) => () => w.run('DELETE FROM transactions WHERE id = ?', id)
    expect(del(w.payment)).toThrow(SPLIT)
    del(w.share)()
    expect(del(w.payment)).toThrow(SPLIT)
    del(w.given)()
    del(w.payment)()
    expect(w.get(w.payment)).toBeUndefined()
  })

  it('stops a split payment’s account, and the ledger that holds it, from being deleted until the split is gone', () => {
    const w = world()
    // The account's rows go by cascade, the payment among them.
    expect(() => w.run('DELETE FROM accounts WHERE id = ?', w.a.account)).toThrow(SPLIT)
    expect(() => deleteLedgerRows(w.sqlite, 'A')).toThrow(SPLIT)
    expect(w.get(w.payment)).toBeDefined()
    expect(w.get(w.share)).toBeDefined()
    // With the split undone (its rows deleted), both go.
    w.run('DELETE FROM transactions WHERE split_of = ?', w.payment)
    w.run('DELETE FROM account_ledgers WHERE ledger_id = ? AND account_id = ?', 'B', w.a.account)
    w.run('DELETE FROM accounts WHERE id = ?', w.a.account)
    expect(w.get(w.payment)).toBeUndefined()
    deleteLedgerRows(w.sqlite, 'A')
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('lets the nightly purge’s delete of deleted rows run beside a split', () => {
    const w = world()
    const old = w.row('A', -300, { deleted: '2026-01-01T00:00:00Z' })
    w.run("DELETE FROM transactions WHERE ledger_id = 'A' AND deleted_at IS NOT NULL")
    w.run("DELETE FROM transactions WHERE ledger_id = 'B' AND deleted_at IS NOT NULL")
    expect(w.get(old)).toBeUndefined()
    expect(w.get(w.payment)).toBeDefined()
  })
})
