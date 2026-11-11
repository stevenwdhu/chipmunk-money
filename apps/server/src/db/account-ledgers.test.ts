import { describe, expect, it } from 'vitest'
import type { AppContext } from '../services/context'
import { testLedger, testStorage } from '../test/helpers'
import { addLedger, addSharedList, bareDatabase, bareWriter, fillLedger, ledgerRowCounts, type Writer } from '../test/world'
import { ledgerMaintenance } from './scope'
import { deleteLedgerRows } from './tables'

/**
 * Migration 0001: an account shared with other ledgers (account_ledgers), the ledger_accounts view
 * over both, and the guards that hold it together. Raw SQL on a migrated database without the
 * write guards, as in schema.test.ts, except where the write guards are what's tested.
 */

const CROSS = 'cross-ledger reference'

/** The baseline's columns of ledger_accounts, then the three 0001 adds. */
const VIEW_COLUMNS = [
  'ledger_id',
  'id',
  'name',
  'type',
  'currency',
  'opening_balance_minor',
  'opening_date',
  'institution_id',
  'notes',
  'archived_at',
  'sort',
  'external_id',
  'import_mapping',
  'created_at',
  'updated_at',
  'home_ledger_id',
  'opening_ledger_id',
  'split_from_id',
]

/** Ledgers A and B filled, and C with a bank only, on a database without write guards. */
function world() {
  const sqlite = bareDatabase()
  addLedger(sqlite, 'A')
  addLedger(sqlite, 'B')
  addLedger(sqlite, 'C')
  const shared = addSharedList(sqlite)
  const a = fillLedger(bareWriter(sqlite, 'A'), { category: shared.food, offCategory: shared.fun })
  const b = fillLedger(bareWriter(sqlite, 'B'), { category: shared.food, offCategory: shared.food })
  const bBank = bareWriter(sqlite, 'B')("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Shared bank')")
  const cBank = bareWriter(sqlite, 'C')("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Bank')")
  const cAccount = bareWriter(sqlite, 'C')("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES (@ledger, 'Cash', 'cash', @i)", { i: cBank })
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  const get = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined
  const all = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>
  /** Shares A's card with a ledger, with that ledger's institution. */
  const share = (ledger: string, institution: number, more: { sort?: number; archivedAt?: string | null } = {}) =>
    run(
      'INSERT INTO account_ledgers (ledger_id, account_id, institution_id, sort, archived_at) VALUES (?, ?, ?, ?, ?)',
      ledger,
      a.account,
      institution,
      more.sort ?? 0,
      more.archivedAt ?? null,
    )
  const transaction = (ledger: string, account: number, deletedAt: string | null = null) =>
    Number(
      run(
        "INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, deleted_at) VALUES (?, ?, '2026-09-10', -700, 'Cafe', 'cafe', ?)",
        ledger,
        account,
        deletedAt,
      ).lastInsertRowid,
    )
  const recurring = (ledger: string, account: number) =>
    Number(
      run(
        `INSERT INTO recurring_items (ledger_id, name, payee_key, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
         VALUES (?, 'Phone', 'phone', ?, -3000, 'monthly', '2026-01-01', '2026-10-01', 'active', 'manual')`,
        ledger,
        account,
      ).lastInsertRowid,
    )
  const accountsIn = (ledger: string) => all('SELECT id FROM ledger_accounts WHERE ledger_id = ? ORDER BY id', ledger).map((r) => r.id)
  return { sqlite, shared, a, b, bBank, cBank, cAccount, run, get, all, share, transaction, recurring, accountsIn }
}

describe('ledger_accounts', () => {
  it('is the accounts table, row for row, while no account is shared', () => {
    const w = world()
    const columns = w.all("SELECT name FROM pragma_table_info('ledger_accounts')").map((c) => c.name)
    expect(columns).toEqual(VIEW_COLUMNS)
    const order = 'ORDER BY ledger_id, id'
    expect(w.all(`SELECT * FROM ledger_accounts ${order}`)).toEqual(
      w.all(
        `SELECT ledger_id, id, name, type, currency, opening_balance_minor, opening_date, institution_id, notes, archived_at, sort, external_id,
           import_mapping, created_at, updated_at, ledger_id AS home_ledger_id, ledger_id AS opening_ledger_id, NULL AS split_from_id
         FROM accounts ${order}`,
      ),
    )
    expect(w.all(`SELECT * FROM ledger_accounts ${order}`)).toHaveLength(5)
  })

  it("gives a shared account to each ledger it's in, with the member's institution, sort and archive", () => {
    const w = world()
    w.run("UPDATE accounts SET notes = 'the family card', import_mapping = '{}', external_id = 'x1', opening_balance_minor = -1200 WHERE id = ?", w.a.account)
    w.share('B', w.bBank, { sort: 7, archivedAt: '2026-10-01' })
    expect(w.accountsIn('A')).toEqual([w.a.account, w.a.savings])
    expect(w.accountsIn('B')).toEqual([w.a.account, w.b.account, w.b.savings])
    expect(w.accountsIn('C')).toEqual([w.cAccount])

    const home = w.get('SELECT * FROM ledger_accounts WHERE ledger_id = ? AND id = ?', 'A', w.a.account)!
    const member = w.get('SELECT * FROM ledger_accounts WHERE ledger_id = ? AND id = ?', 'B', w.a.account)!
    expect(home).toEqual({ ...w.get('SELECT * FROM accounts WHERE id = ?', w.a.account), home_ledger_id: 'A', opening_ledger_id: 'A' })
    // The account's own facts, and B's institution, sort and archive.
    expect(member).toEqual({ ...home, ledger_id: 'B', institution_id: w.bBank, sort: 7, archived_at: '2026-10-01' })
    expect(member).toMatchObject({ name: 'Card', notes: 'the family card', opening_balance_minor: -1200, home_ledger_id: 'A', opening_ledger_id: 'A' })
  })
})

describe('account_ledgers guards', () => {
  it('let a member hold transactions and recurring items on the account, and nobody else', () => {
    const w = world()
    w.share('B', w.bBank)
    const tx = w.transaction('B', w.a.account)
    const item = w.recurring('B', w.a.account)
    expect(() => w.transaction('C', w.a.account)).toThrow(CROSS)
    expect(() => w.recurring('C', w.a.account)).toThrow(CROSS)

    // Onto the account by an update too.
    w.run('UPDATE transactions SET account_id = ? WHERE id = ?', w.a.account, w.b.purchase)
    w.run('UPDATE recurring_items SET account_id = ? WHERE id = ?', w.a.account, w.b.item)
    const cTx = w.transaction('C', w.cAccount)
    expect(() => w.run('UPDATE transactions SET account_id = ? WHERE id = ?', w.a.account, cTx)).toThrow(CROSS)
    // Sharing one account opens none of the home's others.
    expect(() => w.run('UPDATE transactions SET account_id = ? WHERE id = ?', w.a.savings, tx)).toThrow(CROSS)
    expect(() => w.run('UPDATE recurring_items SET account_id = ? WHERE id = ?', w.a.savings, item)).toThrow(CROSS)
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it("refuse a member row for the home, or with another ledger's institution, and never move one", () => {
    const w = world()
    expect(() => w.share('A', w.a.institution)).toThrow(CROSS)
    expect(() => w.share('B', w.a.institution)).toThrow(CROSS)
    expect(() => w.share('B', w.cBank)).toThrow(CROSS)
    w.share('B', w.bBank)
    expect(() => w.run("UPDATE account_ledgers SET institution_id = ? WHERE ledger_id = 'B'", w.cBank)).toThrow(CROSS)
    w.run("UPDATE account_ledgers SET institution_id = ?, sort = 3, archived_at = 'now' WHERE ledger_id = 'B'", w.b.institution)
    expect(() => w.run("UPDATE account_ledgers SET ledger_id = 'C' WHERE ledger_id = 'B'")).toThrow('rows stay in their ledger')
    expect(() => w.run("UPDATE account_ledgers SET account_id = ? WHERE ledger_id = 'B'", w.a.savings)).toThrow('rows stay in their ledger')
    // A member's institution can't go while the row uses it.
    expect(() => w.run('DELETE FROM institutions WHERE id = ?', w.b.institution)).toThrow(/FOREIGN KEY/)
  })

  it("keep a member row while its ledger holds a transaction or a recurring item on the account, or is its opening ledger", () => {
    const w = world()
    w.share('B', w.bBank)
    const leave = () => w.run("DELETE FROM account_ledgers WHERE ledger_id = 'B' AND account_id = ?", w.a.account)
    const USED = 'the ledger still uses the account'

    const tx = w.transaction('B', w.a.account, '2026-10-02')
    // A deleted one counts: it can still be restored.
    expect(() => leave()).toThrow(USED)
    w.run('DELETE FROM transactions WHERE id = ?', tx)
    const item = w.recurring('B', w.a.account)
    expect(() => leave()).toThrow(USED)
    w.run('DELETE FROM recurring_items WHERE id = ?', item)
    w.run("UPDATE accounts SET opening_ledger_id = 'B' WHERE id = ?", w.a.account)
    expect(() => leave()).toThrow(USED)
    w.run('UPDATE accounts SET opening_ledger_id = NULL WHERE id = ?', w.a.account)
    // Another ledger's rows on the account, and B's on other accounts, don't keep it.
    w.transaction('A', w.a.account)
    expect(leave().changes).toBe(1)
    expect(w.accountsIn('B')).not.toContain(w.a.account)
  })

  it('take the opening ledger as null, the home or a member, and refuse any other', () => {
    const w = world()
    const opening = (ledger: string | null) => () => w.run('UPDATE accounts SET opening_ledger_id = ? WHERE id = ?', ledger, w.a.account)
    expect(opening('B')).toThrow(CROSS)
    opening('A')()
    opening(null)()
    w.share('B', w.bBank)
    opening('B')()
    expect(w.get('SELECT opening_ledger_id FROM ledger_accounts WHERE ledger_id = ? AND id = ?', 'B', w.a.account)).toEqual({ opening_ledger_id: 'B' })
    expect(opening('C')).toThrow(CROSS)
    // A new account: only its own ledger, or null.
    const insert = (opening: string | null) => () =>
      w.run("INSERT INTO accounts (ledger_id, name, type, institution_id, opening_ledger_id) VALUES ('A', 'x', 'cash', ?, ?)", w.a.institution, opening)
    expect(insert('B')).toThrow(CROSS)
    insert('A')()
    insert(null)()
  })

  it("let the home change, in its three steps, only to a ledger the account is shared with", () => {
    const w = world()
    const card = w.a.account
    expect(() => w.run("UPDATE accounts SET ledger_id = 'B', institution_id = ? WHERE id = ?", w.bBank, card)).toThrow(
      "an account's home moves only to a ledger it is shared with",
    )
    w.share('B', w.bBank, { sort: 4 })
    const bTx = w.transaction('B', card)
    const before = w.all('SELECT id, ledger_id FROM transactions WHERE account_id = ? ORDER BY id', card)

    /** The home change's statements, from `from` to `to`. */
    const changeHome = (from: string, to: string) =>
      w.sqlite.transaction(() => {
        const old = w.get('SELECT institution_id, sort, archived_at FROM accounts WHERE id = ? AND ledger_id = ?', card, from)!
        // 1. The account moves, with the new home's institution, sort and archive.
        const moved = w.run(
          `UPDATE accounts SET ledger_id = @to,
             institution_id = (SELECT m.institution_id FROM account_ledgers m WHERE m.ledger_id = @to AND m.account_id = @card),
             sort = (SELECT m.sort FROM account_ledgers m WHERE m.ledger_id = @to AND m.account_id = @card),
             archived_at = (SELECT m.archived_at FROM account_ledgers m WHERE m.ledger_id = @to AND m.account_id = @card)
           WHERE id = @card AND ledger_id = @from`,
          { card, from, to },
        )
        expect(moved.changes).toBe(1)
        // 2. The new home's member row goes, and the old home takes one.
        expect(w.run('DELETE FROM account_ledgers WHERE ledger_id = ? AND account_id = ?', to, card).changes).toBe(1)
        expect(
          w.run('INSERT INTO account_ledgers (ledger_id, account_id, institution_id, sort, archived_at) VALUES (?, ?, ?, ?, ?)', from, card, old.institution_id, old.sort, old.archived_at)
            .changes,
        ).toBe(1)
        // 3. The opening ledger stays where it was: the old home when it was null, null when it was the new home.
        w.run(
          'UPDATE accounts SET opening_ledger_id = CASE WHEN opening_ledger_id IS NULL THEN @from WHEN opening_ledger_id = @to THEN NULL ELSE opening_ledger_id END WHERE id = @card',
          { card, from, to },
        )
      })()

    changeHome('A', 'B')
    const view = (ledger: string) =>
      w.get('SELECT institution_id, sort, home_ledger_id, opening_ledger_id FROM ledger_accounts WHERE ledger_id = ? AND id = ?', ledger, card)
    expect(view('B')).toEqual({ institution_id: w.bBank, sort: 4, home_ledger_id: 'B', opening_ledger_id: 'A' })
    expect(view('A')).toEqual({ institution_id: w.a.institution, sort: 0, home_ledger_id: 'B', opening_ledger_id: 'A' })
    // Every row stays where it was, and both ledgers can still write on the account.
    expect(w.all('SELECT id, ledger_id FROM transactions WHERE account_id = ? ORDER BY id', card)).toEqual(before)
    w.transaction('A', card)
    w.run('UPDATE transactions SET amount_minor = -800 WHERE id = ?', bTx)
    // The old home is the opening ledger, so its member row stays.
    expect(() => w.run("DELETE FROM account_ledgers WHERE ledger_id = 'A' AND account_id = ?", card)).toThrow('the ledger still uses the account')

    // Not to a ledger it isn't shared with.
    expect(() => w.run("UPDATE accounts SET ledger_id = 'C', institution_id = ? WHERE id = ?", w.cBank, card)).toThrow(
      "an account's home moves only to a ledger it is shared with",
    )

    // And back: the opening ledger is the home again, so null.
    changeHome('B', 'A')
    expect(view('A')).toEqual({ institution_id: w.a.institution, sort: 0, home_ledger_id: 'A', opening_ledger_id: 'A' })
    expect(w.get('SELECT opening_ledger_id FROM accounts WHERE id = ?', card)).toEqual({ opening_ledger_id: null })
    expect(view('B')).toEqual({ institution_id: w.bBank, sort: 4, home_ledger_id: 'A', opening_ledger_id: 'A' })
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('keep the member row of a ledger that was the home while it has an import batch of the account', () => {
    const w = world()
    // C's cash is shared with B, and C imported into it. Then B becomes the home.
    w.run("INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES ('B', ?, ?)", w.cAccount, w.bBank)
    const batch = Number(w.run("INSERT INTO import_batches (ledger_id, account_id) VALUES ('C', ?)", w.cAccount).lastInsertRowid)
    w.run("UPDATE accounts SET ledger_id = 'B', institution_id = ? WHERE id = ?", w.bBank, w.cAccount)
    w.run("DELETE FROM account_ledgers WHERE ledger_id = 'B' AND account_id = ?", w.cAccount)
    w.run("INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES ('C', ?, ?)", w.cAccount, w.cBank)
    const leave = () => w.run("DELETE FROM account_ledgers WHERE ledger_id = 'C' AND account_id = ?", w.cAccount)
    // Left behind, the batch would be deleted with the account, from the new home's scope.
    expect(() => leave()).toThrow('the ledger still uses the account')
    w.run('DELETE FROM import_batches WHERE id = ?', batch)
    expect(leave().changes).toBe(1)
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('check from the other side when rows are inserted out of order', () => {
    const w = world()
    const ID = 9999
    const outOfOrder = (...steps: Array<[string, ...unknown[]]>) =>
      w.sqlite.transaction(() => {
        w.sqlite.pragma('defer_foreign_keys = ON')
        for (const [sql, ...params] of steps) w.run(sql, ...params)
      })()
    const member = (ledger: string, account: number, institution: number): [string, ...unknown[]] => [
      'INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES (?, ?, ?)',
      ledger,
      account,
      institution,
    ]
    const account = (ledger: string, institution: number): [string, ...unknown[]] => [
      "INSERT INTO accounts (id, ledger_id, name, type, institution_id) VALUES (?, ?, 'x', 'credit', ?)",
      ID,
      ledger,
      institution,
    ]
    // A member row, then its institution in another ledger.
    expect(() => outOfOrder(member('B', w.a.account, ID), ["INSERT INTO institutions (id, ledger_id, name) VALUES (?, 'A', 'x')", ID])).toThrow(CROSS)
    // A member row, then its account with that ledger as the home.
    expect(() => outOfOrder(member('B', ID, w.bBank), account('B', w.bBank))).toThrow(CROSS)
    // A transaction, a recurring item and an import batch in a ledger the account isn't shared with.
    const tx: [string, ...unknown[]] = ["INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES ('B', ?, '2026-09-01', -1, 'x', 'x')", ID]
    expect(() => outOfOrder(tx, account('A', w.a.institution))).toThrow(CROSS)
    // With the member row, the member's rows may come before the account.
    outOfOrder(
      member('B', ID, w.bBank),
      tx,
      [
        `INSERT INTO recurring_items (ledger_id, name, payee_key, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
         VALUES ('B', 'x', 'x', ?, 1, 'monthly', '2026-01-01', '2026-01-01', 'active', 'manual')`,
        ID,
      ],
      account('A', w.a.institution),
    )
    expect(w.accountsIn('B')).toContain(ID)
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('let a shared account be deleted, member rows and all', () => {
    const w = world()
    w.share('B', w.bBank)
    w.share('C', w.cBank)
    // The guard on member rows steps aside when the account itself goes.
    w.transaction('B', w.a.account)
    w.run('DELETE FROM accounts WHERE id = ?', w.a.account)
    expect(w.all('SELECT * FROM account_ledgers')).toEqual([])
    expect(w.all('SELECT id FROM transactions WHERE account_id = ?', w.a.account)).toEqual([])
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })
})

describe('account_ledgers with the write guards', () => {
  const writer =
    (ctx: AppContext): Writer =>
    (sql, params = {}) =>
      Number(ctx.q.run(sql, params).lastInsertRowid)

  /** Two ledgers filled, the home's card shared with the member, which holds a row and a recurring item on it. */
  function storageWorld() {
    const storage = testStorage()
    const home = storage.registry.defaultContext()
    const member = testLedger(storage, 'Family')
    const shared = storage.sqlite.prepare('SELECT id FROM categories WHERE ledger_id IS NULL ORDER BY id LIMIT 2').pluck().all() as number[]
    const opts = { category: shared[0]!, offCategory: shared[1]! }
    const homeRows = fillLedger(writer(home), opts)
    fillLedger(writer(member), opts)
    const write = writer(member)
    const institution = write("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Shared bank')")
    write('INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES (@ledger, @account, @institution)', { account: homeRows.account, institution })
    write("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES (@ledger, @account, '2026-09-10', -700, 'Cafe', 'cafe')", {
      account: homeRows.account,
    })
    write(
      `INSERT INTO recurring_items (ledger_id, name, payee_key, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
       VALUES (@ledger, 'Phone', 'phone', @account, -3000, 'monthly', '2026-01-01', '2026-10-01', 'active', 'manual')`,
      { account: homeRows.account },
    )
    return { storage, home, member, homeRows }
  }

  it("delete a member ledger's rows, member row included, and leave the home's alone", () => {
    const { storage, home, member, homeRows } = storageWorld()
    const before = ledgerRowCounts(storage.sqlite, home.ledger.id)
    const deleted = ledgerMaintenance(storage.sqlite, member.ledger.id, () => deleteLedgerRows(storage.sqlite, member.ledger.id))
    expect(deleted).toMatchObject({ account_ledgers: 1, transactions: 6, recurring_items: 2 })
    expect(Object.values(ledgerRowCounts(storage.sqlite, member.ledger.id)).every((n) => n === 0)).toBe(true)
    expect(ledgerRowCounts(storage.sqlite, home.ledger.id)).toEqual(before)
    expect(home.q.pluck('SELECT count(*) FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', homeRows.account)).toBe(1)
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it("delete a shared account in its home once the member's rows on it are gone", () => {
    const { storage, home, member, homeRows } = storageWorld()
    const deleteCard = () => home.q.run('DELETE FROM accounts WHERE id = ? AND ledger_id = @ledger', homeRows.account)
    // The member's rows and member row are the member's to delete: the home's scope can't reach them.
    expect(deleteCard).toThrow('write outside the ledger scope')
    member.q.transaction(() => {
      member.q.run('DELETE FROM transactions WHERE account_id = ? AND ledger_id = @ledger', homeRows.account)
      member.q.run('DELETE FROM recurring_items WHERE account_id = ? AND ledger_id = @ledger', homeRows.account)
      member.q.run('DELETE FROM account_ledgers WHERE account_id = ? AND ledger_id = @ledger', homeRows.account)
    })
    expect(deleteCard().changes).toBe(1)
    expect(member.q.pluck('SELECT count(*) FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', homeRows.account)).toBe(0)
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })
})
