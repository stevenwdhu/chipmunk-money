import { describe, expect, it } from 'vitest'
import { sharedWorld } from '../test/shared-accounts'
import { addLedger, addSharedList, bareDatabase, bareWriter, fillLedger } from '../test/world'
import { crossLedgerReferences, moveRows, type MovedCategory } from './move-rows'
import { ledgerMaintenance, ledgerMove, UnscopedQuery } from './scope'

/**
 * Migration 0002: a transaction moves to another ledger that has its account, once nothing is
 * attached to it (tx_move_keeps_refs), and moveRows, the one place that moves one, in a write
 * scope that lets through only that change. Raw SQL on a migrated database without the write
 * guards, as in account-ledgers.test.ts, except where the write guards are what's tested.
 */

const MOVE = 'a transaction moves only to a ledger that has its account, with nothing still attached'
const CROSS = 'cross-ledger reference'
const OUTSIDE = 'write outside the ledger scope'

/** Ledgers A and B filled, A's card shared with B, and C with a bank only, on a database without write guards. */
function world() {
  const sqlite = bareDatabase()
  for (const id of ['A', 'B', 'C']) addLedger(sqlite, id)
  const shared = addSharedList(sqlite)
  const a = fillLedger(bareWriter(sqlite, 'A'), { category: shared.food, offCategory: shared.fun })
  const b = fillLedger(bareWriter(sqlite, 'B'), { category: shared.food, offCategory: shared.food })
  const bBank = bareWriter(sqlite, 'B')("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Shared bank')")
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  const ledgerOf = (id: number) => sqlite.prepare('SELECT ledger_id FROM transactions WHERE id = ?').pluck().get(id)
  run('INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES (?, ?, ?)', 'B', a.account, bBank)
  /** A row of A's on its card with nothing attached. */
  const clean = (account = a.account) =>
    Number(
      run(
        "INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id) VALUES ('A', ?, '2026-09-10', -700, 'Cafe', 'cafe', ?)",
        account,
        shared.food,
      ).lastInsertRowid,
    )
  const move = (id: number, ledger: string, more = '') => () => run(`UPDATE transactions SET ledger_id = ?${more} WHERE id = ?`, ledger, id)
  return { sqlite, shared, a, b, bBank, run, ledgerOf, clean, move }
}

describe('tx_move_keeps_refs', () => {
  it('moves a row with nothing attached to a ledger that has its account, either way', () => {
    const w = world()
    const tx = w.clean()
    w.move(tx, 'B')()
    expect(w.ledgerOf(tx)).toBe('B')
    // Back to the home.
    w.move(tx, 'A')()
    expect(w.ledgerOf(tx)).toBe('A')
    // Changing nothing else of it is still allowed with something attached.
    w.run('UPDATE transactions SET ledger_id = ledger_id, amount_minor = -800 WHERE id = ?', w.a.purchase)
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it("refuses a ledger that doesn't have the account, and an account its ledger isn't shared with", () => {
    const w = world()
    expect(w.move(w.clean(), 'C')).toThrow(MOVE)
    expect(w.move(w.clean(w.a.savings), 'B')).toThrow(MOVE)
    // Nor onto another account in the same statement.
    expect(w.move(w.clean(), 'B', `, account_id = ${w.a.savings}`)).toThrow(MOVE)
    // Not even onto an account the new ledger has: the row would leave its account with its bank id.
    expect(w.move(w.clean(), 'B', `, account_id = ${w.b.account}`)).toThrow(MOVE)
  })

  it('refuses a row with anything still attached, each kind on its own', () => {
    const w = world()
    const tx = w.clean()
    const credit = Number(
      w.run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES ('A', ?, '2026-09-12', 700, 'Cafe', 'cafe')", w.a.account)
        .lastInsertRowid,
    )
    const attached: Array<[string, string, string]> = [
      ['a link as the money out', `INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('refund', ${credit}, ${tx}, 700)`, 'DELETE FROM transaction_links'],
      ['a link as the money in', `INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('payback', ${tx}, ${w.a.purchase}, 1)`, `DELETE FROM transaction_links WHERE money_in_id = ${tx}`],
      ['a tag', `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (${tx}, ${w.a.tag})`, 'DELETE FROM transaction_tags'],
      ['a recurring due', `INSERT INTO recurring_payment_dues (item_id, transaction_id, due_date) VALUES (${w.a.item}, ${tx}, '2026-09-01')`, 'DELETE FROM recurring_payment_dues'],
      ['a not-payment', `INSERT INTO recurring_not_payments (item_id, transaction_id) VALUES (${w.a.item}, ${tx})`, 'DELETE FROM recurring_not_payments'],
      ['a rejected pair as money in', `INSERT INTO transfer_rejections (in_id, out_id) VALUES (${tx}, ${w.a.transferOut})`, `DELETE FROM transfer_rejections WHERE in_id = ${tx}`],
      ['a rejected pair as money out', `INSERT INTO transfer_rejections (in_id, out_id) VALUES (${credit}, ${tx})`, `DELETE FROM transfer_rejections WHERE out_id = ${tx}`],
      ['a bank payload', `INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (${w.a.account}, 'plaid', 'r9', ${tx}, 'added', '{}')`, 'DELETE FROM bank_payloads WHERE remote_id = \'r9\''],
      ['another row naming it as its transfer’s other side', `UPDATE transactions SET transfer_pair_id = ${tx} WHERE id = ${w.a.transferOut}`, `UPDATE transactions SET transfer_pair_id = ${w.a.transferIn} WHERE id = ${w.a.transferOut}`],
    ]
    for (const [what, attach, detach] of attached) {
      w.sqlite.exec(attach)
      expect(w.move(tx, 'B'), what).toThrow(MOVE)
      expect(w.ledgerOf(tx), what).toBe('A')
      w.sqlite.exec(detach)
    }
    w.move(tx, 'B')()
    expect(w.ledgerOf(tx)).toBe('B')
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it("leaves the row's own references to guard_transactions_update, which the same UPDATE must clear", () => {
    const w = world()
    const tx = w.clean()
    const own = (column: string, value: number) => {
      w.run(`UPDATE transactions SET ${column} = ? WHERE id = ?`, value, tx)
      expect(w.move(tx, 'B'), column).toThrow(CROSS)
      w.move(tx, 'B', `, ${column} = NULL`)()
      expect(w.ledgerOf(tx), column).toBe('B')
      w.move(tx, 'A')()
    }
    own('import_batch_id', w.a.batch)
    own('recurring_item_id', w.a.item)
    // Its own pair, when that one doesn't name it back (when it does, the trigger above refuses first).
    own('transfer_pair_id', w.a.transferOut)
    // A category of A's own list isn't B's.
    const group = Number(w.run("INSERT INTO category_groups (ledger_id, name) VALUES ('A', 'Own')").lastInsertRowid)
    own('category_id', Number(w.run("INSERT INTO categories (ledger_id, group_id, name) VALUES ('A', ?, 'Mine')", group).lastInsertRowid))
  })
})

describe('crossLedgerReferences', () => {
  it('finds each way a row can refer across ledgers, and nothing in a sound database', () => {
    const w = world()
    const db = new UnscopedQuery(w.sqlite)
    expect(crossLedgerReferences(db)).toEqual({})
    // With the guards out of the way, A's rows with everything attached go to B as they are.
    for (const t of ['tx_move_keeps_refs', 'guard_transactions_update', 'guard_recurring_items_update']) w.sqlite.exec(`DROP TRIGGER ${t}`)
    const group = Number(w.run("INSERT INTO category_groups (ledger_id, name) VALUES ('A', 'Own')").lastInsertRowid)
    const mine = Number(w.run("INSERT INTO categories (ledger_id, group_id, name) VALUES ('A', ?, 'Mine')", group).lastInsertRowid)
    const onSavings = w.clean(w.a.savings)
    w.run('UPDATE transactions SET category_id = ? WHERE id = ?', mine, w.a.purchase)
    w.run("UPDATE transactions SET ledger_id = 'B' WHERE id IN (?, ?, ?, ?)", w.a.purchase, w.a.payment, w.a.transferIn, onSavings)
    w.run('UPDATE recurring_items SET account_id = ? WHERE id = ?', w.a.savings, w.b.item)
    expect(crossLedgerReferences(db)).toEqual({
      'transaction on an account its ledger doesn’t have': 1,
      'recurring item on an account its ledger doesn’t have': 1,
      'transaction in a category its ledger doesn’t use': 1,
      'transaction with another ledger’s recurring item': 1,
      'transaction with another ledger’s import batch': 1,
      // Each side names the other.
      'transfer paired across ledgers': 2,
      'link across ledgers': 1,
      'rejected pair across ledgers': 1,
      'tag of another ledger': 1,
      'recurring due across ledgers': 1,
      'not-payment across ledgers': 1,
      'bank payload pointing at a row held outside the home': 1,
    })
    // Only what A and B hold is involved.
    expect(crossLedgerReferences(db, ['C'])).toEqual({})
    // Each crossing with a side in A, but not B's rows on an account or in a category B doesn't have: those are B's to answer for.
    expect(Object.keys(crossLedgerReferences(db, ['A']))).toHaveLength(9)
  })
})

describe('moveRows, with the write guards', () => {
  const food = (categoryId: number | null): MovedCategory => ({ categoryId, categorySource: categoryId ? 'user' : null, categoryConfidence: null, needsReview: false })

  it('moves the rows with their categories in one UPDATE, clearing the import batch', () => {
    const w = sharedWorld()
    const { personal, family, storage } = w
    const one = w.addTx(personal, '2026-09-10', -700)
    const two = w.addTx(personal, '2026-09-11', -800)
    const batch = Number(personal.q.run('INSERT INTO import_batches (ledger_id, account_id) VALUES (@ledger, ?)', w.visa).lastInsertRowid)
    personal.q.run("UPDATE transactions SET import_batch_id = ?, needs_review = 1, category_source = 'ai' WHERE ledger_id = @ledger AND id = ?", batch, two)
    const dineOut = family.q.pluck<number>("SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND name = 'Dine out'")!
    const fields = new Map([
      [one, food(dineOut)],
      [two, { categoryId: null, categorySource: null, categoryConfidence: null, needsReview: false }],
    ])
    expect(moveRows(storage.sqlite, { from: personal.ledger.id, to: family.ledger.id, ids: [one, two], fields })).toBe(2)
    const rows = family.q.all('SELECT id, category_id, category_source, needs_review, import_batch_id FROM transactions WHERE ledger_id = @ledger ORDER BY id')
    expect(rows).toEqual([
      { id: one, category_id: dineOut, category_source: 'user', needs_review: 0, import_batch_id: null },
      { id: two, category_id: null, category_source: null, needs_review: 0, import_batch_id: null },
    ])
    expect(personal.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(0)
  })

  it('moves all the rows or none: one held elsewhere, or one with something attached, stops it', () => {
    const w = sharedWorld()
    const { personal, family, storage } = w
    const mine = w.addTx(personal, '2026-09-10', -700)
    const theirs = w.addTx(family, '2026-09-10', -700)
    const move = (ids: number[]) => () =>
      moveRows(storage.sqlite, { from: personal.ledger.id, to: family.ledger.id, ids, fields: new Map(ids.map((id) => [id, food(null)])) })
    expect(move([mine, theirs])).toThrow('Expected to move 2 transactions')
    const tag = Number(personal.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'trip')").lastInsertRowid)
    personal.q.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', mine, tag)
    expect(move([mine])).toThrow(MOVE)
    expect(personal.q.column('SELECT id FROM transactions WHERE ledger_id = @ledger')).toEqual([mine])
    expect(family.q.column('SELECT id FROM transactions WHERE ledger_id = @ledger')).toEqual([theirs])
    // Every row needs its category, and only those.
    expect(() => moveRows(storage.sqlite, { from: personal.ledger.id, to: family.ledger.id, ids: [mine], fields: new Map() })).toThrow('no category')
  })

  it('lets through only a row of `from` becoming one of `to` in a move’s scope', () => {
    const w = sharedWorld()
    const { personal, family, storage } = w
    const { sqlite } = storage
    const [p, f] = [personal.ledger.id, family.ledger.id]
    const tx = w.addTx(personal, '2026-09-10', -700)
    const theirs = w.addTx(family, '2026-09-10', -700)
    const tag = Number(personal.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'trip')").lastInsertRowid)
    const run = (sql: string, ...params: unknown[]) => () => sqlite.prepare(sql).run(...params)
    const toFamily = run('UPDATE transactions SET ledger_id = ? WHERE id = ?', f, tx)
    // Outside a move: not raw, not in either ledger's own scope.
    expect(toFamily).toThrow(OUTSIDE)
    expect(() => ledgerMaintenance(sqlite, p, toFamily)).toThrow(OUTSIDE)
    expect(() => ledgerMaintenance(sqlite, f, toFamily)).toThrow(OUTSIDE)
    expect(() => ledgerMove(sqlite, { from: p, to: p }, toFamily)).toThrow('between two ledgers')
    ledgerMove(sqlite, { from: p, to: f }, () => {
      // Nothing else, in either ledger.
      expect(run('UPDATE transactions SET amount_minor = 1 WHERE id = ?', tx)).toThrow(OUTSIDE)
      expect(run('UPDATE transactions SET ledger_id = ? WHERE id = ?', p, theirs)).toThrow(OUTSIDE)
      expect(run("INSERT INTO tags (ledger_id, name) VALUES (?, 'x')", f)).toThrow(OUTSIDE)
      expect(run('UPDATE tags SET name = ? WHERE id = ?', 'x', tag)).toThrow(OUTSIDE)
      expect(run('DELETE FROM transactions WHERE id = ?', theirs)).toThrow(OUTSIDE)
      expect(run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', tx, tag)).toThrow(OUTSIDE)
      toFamily()
    })
    expect(family.q.column('SELECT id FROM transactions WHERE ledger_id = @ledger ORDER BY id')).toEqual([tx, theirs])
    // And the scope ends with it.
    expect(run('UPDATE transactions SET ledger_id = ? WHERE id = ?', p, tx)).toThrow(OUTSIDE)
  })
})
