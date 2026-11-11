import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { leaveSharedList } from '../services/catalog'
import { deleteCatalogCategory, updateCatalogCategory } from '../services/catalog-edit'
import { historySuggestion, learn } from '../services/categorize'
import type { AppContext } from '../services/context'
import { eraseAll, restoreBackup } from '../services/setup'
import { fullBackup, openStorage, type Storage } from '../storage'
import { categoryId, testLedger, testStorage } from '../test/helpers'
import { fullLedger, ledgerRows, withoutLedger } from '../test/ledger-backup'
import { ledgerRowCounts } from '../test/world'
import { APPLICATION_ID, DB_FILE } from './client'
import { exportLedger, importLedger, readLedgerBackup } from './ledger-backup'
import { TABLES } from './tables'

const dirs: string[] = []
const opened: Storage[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-ledger-backup-'))
  dirs.push(dir)
  return dir
}
function fileStorage(dir = tempDir()) {
  const storage = openStorage({ dataDir: dir })
  opened.push(storage)
  return storage
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Restores bytes into a ledger the way the app does, but without its bank unlinking or setup flag: the rows alone. */
function importBytes(storage: Storage, ctx: AppContext, bytes: Uint8Array) {
  const backup = readLedgerBackup(storage.sqlite, bytes)
  try {
    return importLedger(storage.sqlite, ctx.ledger.id, backup, { joinShared: () => {} })
  } finally {
    backup.close()
  }
}

const open = (bytes: Uint8Array) => {
  const dir = tempDir()
  const file = path.join(dir, 'b.db')
  writeFileSync(file, bytes)
  return { db: new Database(file), file }
}

describe('a ledger backup', () => {
  it('holds one ledger, its category list and no app-wide secrets', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(b, '⟦B⟧')
    storage.sqlite.prepare("INSERT INTO bank_connections (id, provider, name, secret) VALUES ('c1', 'plaid', 'Bank', 'sealed')").run()
    storage.sqlite.prepare("INSERT INTO api_keys (id, name, prefix, hash, scopes) VALUES ('k1', 'key', 'ck_', 'h', '[]')").run()

    const { db } = open(exportLedger(storage.sqlite, a.ledger.id))
    try {
      expect(db.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
      expect(db.prepare('SELECT id FROM ledgers').pluck().all()).toEqual([a.ledger.id])
      for (const t of ['api_keys', 'bank_connections', 'bank_accounts', 'bank_transactions', 'idempotency_keys', 'payee_name_rules', 'payee_tidy']) {
        expect([t, db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get()]).toEqual([t, 0])
      }
      expect(db.prepare('SELECT key FROM app_settings').pluck().all()).toEqual(['categories.catalog'])
      // Not a row of B's, by ledger or by its text.
      for (const t of TABLES) {
        const cols = (db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>).map((c) => c.name)
        if (cols.includes('ledger_id')) expect([t.name, db.prepare(`SELECT count(*) FROM "${t.name}" WHERE ledger_id = ?`).pluck().get(b.ledger.id)]).toEqual([t.name, 0])
      }
      expect(db.prepare("SELECT count(*) FROM transactions WHERE name LIKE '%⟦B⟧%' OR notes LIKE '%⟦B⟧%'").pluck().get()).toBe(0)
      // The shared list it uses, with what it turned off.
      expect(db.prepare('SELECT count(*) FROM categories WHERE ledger_id IS NULL').pluck().get()).toBeGreaterThan(10)
      expect(db.prepare('SELECT category_id FROM ledger_category_off').pluck().all()).toEqual([categoryId(a, 'Gifts')])
    } finally {
      db.close()
    }
  })

  it('restores into its own ledger with every row and id as it was', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const rows = fullLedger(a)
    fullLedger(b, '⟦B⟧')
    const before = ledgerRows(storage.sqlite, a.ledger.id)
    const bBefore = ledgerRows(storage.sqlite, b.ledger.id)
    const bytes = exportLedger(storage.sqlite, a.ledger.id)
    // Changed since the backup: these go.
    a.q.run("UPDATE transactions SET payee = 'Changed' WHERE ledger_id = @ledger")
    a.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'later')")

    expect(importBytes(storage, a, bytes)).toEqual({ moved: [] })
    expect(ledgerRows(storage.sqlite, a.ledger.id)).toEqual(before)
    // The refund renamed apart from its bill keeps its name: links went in before transactions.
    expect(a.q.pluck('SELECT name FROM transactions WHERE id = ? AND ledger_id = @ledger', rows.refund)).toBe('Returned')
    expect(ledgerRows(storage.sqlite, b.ledger.id)).toEqual(bBefore)
  })

  it('keeps the order rows were added in', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const [groceries, dineOut] = [categoryId(a, 'Groceries'), categoryId(a, 'Dine out')]
    // Learned first, so it wins the tie between two categories for a similar payee.
    for (const id of [dineOut, groceries]) for (let i = 0; i < 3; i++) learn(a, 'corner cafe downtown', -500, id)
    const bytes = exportLedger(storage.sqlite, a.ledger.id)
    for (const ctx of [a, b]) {
      importBytes(storage, ctx, bytes)
      expect(historySuggestion(ctx, 'Corner Cafe', -500)).toMatchObject({ categoryId: dineOut, source: 'fuzzy' })
    }
  })

  it('numbers ids taken by another ledger again, with the ids in reports and the activity log', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const rows = fullLedger(a)
    const bytes = exportLedger(storage.sqlite, a.ledger.id)
    const aBefore = ledgerRows(storage.sqlite, a.ledger.id)
    const maxId = (t: string) => storage.sqlite.prepare(`SELECT max(id) FROM "${t}"`).pluck().get() as number
    // A's ids, numbered again in order from past every id the table has had.
    const renumbered = (table: string, ids: number[]) => {
      const base = maxId(table)
      return (id: number) => base + ids.indexOf(id) + 1
    }
    const tx = renumbered('transactions', a.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger ORDER BY id'))
    const tag = renumbered('tags', a.q.column<number>('SELECT id FROM tags WHERE ledger_id = @ledger ORDER BY id'))
    const account = renumbered('accounts', a.q.column<number>('SELECT id FROM ledger_accounts WHERE ledger_id = @ledger ORDER BY id'))

    // A copy of A into B: every id is A's, so all of them move.
    const { moved } = importBytes(storage, b, bytes)
    expect(moved).toEqual(expect.arrayContaining(['transactions', 'tags', 'accounts']))
    expect(b.q.column('SELECT id FROM transactions WHERE ledger_id = @ledger ORDER BY id')).toEqual(
      [rows.purchase, rows.refund, rows.transferOut, rows.transferIn, rows.payment].map(tx).sort((x, y) => x - y),
    )
    // Pairs and links point at B's copies.
    expect(b.q.pluck('SELECT transfer_pair_id FROM transactions WHERE id = ? AND ledger_id = @ledger', tx(rows.transferOut))).toBe(tx(rows.transferIn))
    expect(b.q.get('SELECT l.money_in_id AS i, l.money_out_id AS o FROM transaction_links l JOIN transactions t ON t.id = l.money_in_id WHERE t.ledger_id = @ledger')).toEqual({
      i: tx(rows.refund),
      o: tx(rows.purchase),
    })
    // The same shared categories (this install's list), by id.
    expect(b.q.pluck('SELECT category_id FROM transactions WHERE id = ? AND ledger_id = @ledger', tx(rows.purchase))).toBe(categoryId(a, 'Groceries'))
    expect(b.q.column('SELECT category_id FROM ledger_category_off WHERE ledger_id = @ledger')).toEqual([categoryId(a, 'Gifts')])

    const spec = JSON.parse(b.q.pluck<string>('SELECT spec FROM custom_reports WHERE ledger_id = @ledger')!)
    expect(spec.filter.spending).toEqual({
      only: [
        { field: 'tag', ids: [tag(rows.tag)] },
        { field: 'account', ids: [account(rows.account)] },
      ],
      filterOut: [],
      picked: [tx(rows.purchase)],
      keep: [tx(rows.refund)],
    })
    expect(spec.names).toEqual({ tag: { [tag(rows.tag)]: 'trip' }, account: { [account(rows.account)]: 'Card' } })
    const edit = b.q.get<{ entity_id: string; before: string; after: string }>("SELECT entity_id, before, after FROM activity WHERE ledger_id = @ledger AND action = 'update'")!
    expect(edit.entity_id).toBe(String(tx(rows.purchase)))
    expect(JSON.parse(edit.before)).toEqual({ id: tx(rows.purchase), accountId: account(rows.account), tags: [{ id: tag(rows.tag), name: 'trip' }] })
    expect(JSON.parse(edit.after)).toMatchObject({ id: tx(rows.purchase), transferPairId: tx(rows.transferIn) })

    // A is as it was, and B has its rows.
    expect(ledgerRows(storage.sqlite, a.ledger.id)).toEqual(aBefore)
    expect(ledgerRowCounts(storage.sqlite, b.ledger.id)).toEqual(ledgerRowCounts(storage.sqlite, a.ledger.id))
    // New rows never take an id a copy now has.
    expect(Number(b.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'new')").lastInsertRowid)).toBeGreaterThan(tag(rows.tag))
  })

  it('from another install, matches its categories to this list by name', () => {
    const source = testStorage()
    const s = source.registry.defaultContext()
    const rows = fullLedger(s)
    const bytes = exportLedger(source.sqlite, s.ledger.id)

    // Another install, whose ids are taken by a ledger of its own.
    const storage = testStorage()
    const p = storage.registry.defaultContext()
    fullLedger(p)
    const f = testLedger(storage, 'Restored')
    const pBefore = ledgerRows(storage.sqlite, p.ledger.id)
    const sharedBefore = storage.sqlite.prepare('SELECT id, name FROM categories WHERE ledger_id IS NULL ORDER BY id').all()
    restoreBackup(storage, f, bytes)

    expect(f.q.pluck('SELECT category_list FROM ledgers WHERE id = @ledger')).toBe('shared')
    expect(f.q.pluck("SELECT c.name FROM transactions t JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id WHERE t.ledger_id = @ledger AND t.payee = 'Shop' AND t.amount_minor < 0")).toBe('Groceries')
    // What it turned off is off here too; nothing was added to the list, and its own rows are gone.
    expect(f.q.column("SELECT name FROM ledger_categories WHERE ledger_id = @ledger AND archived_at IS NOT NULL")).toEqual(['Gifts'])
    expect(storage.sqlite.prepare('SELECT id, name FROM categories WHERE ledger_id IS NULL ORDER BY id').all()).toEqual(sharedBefore)
    expect(f.q.pluck('SELECT count(*) FROM categories WHERE ledger_id = @ledger')).toBe(0)
    expect(f.q.pluck('SELECT name FROM transactions WHERE ledger_id = @ledger AND amount_minor = 4000')).toBe('Returned')
    expect(f.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(5)
    expect(ledgerRows(storage.sqlite, p.ledger.id)).toEqual(pBefore)
    void rows
  })

  it('restores by id when shared categories were deleted or renamed since, and leaves the list as it is', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const rows = fullLedger(a)
    const groceries = categoryId(a, 'Groceries')
    const dineOut = categoryId(a, 'Dine out')
    const gifts = categoryId(a, 'Gifts')
    a.q.run('UPDATE transactions SET category_id = ? WHERE id = ? AND ledger_id = @ledger', dineOut, rows.refund)
    const bytes = exportLedger(storage.sqlite, a.ledger.id)
    deleteCatalogCategory(storage, groceries)
    updateCatalogCategory(storage, dineOut, { name: 'Restaurants' })
    updateCatalogCategory(storage, gifts, { name: 'Presents' })
    const list = () => storage.sqlite.prepare('SELECT id, name FROM categories WHERE ledger_id IS NULL ORDER BY id').all()
    const sharedBefore = list()
    const bBefore = ledgerRows(storage.sqlite, b.ledger.id)

    // A key limited to some ledgers may: nothing would be added to the list.
    restoreBackup(storage, a, bytes, { addCategories: false })
    expect(list()).toEqual(sharedBefore)
    expect(a.q.pluck('SELECT category_list FROM ledgers WHERE id = @ledger')).toBe('shared')
    expect(a.q.pluck('SELECT count(*) FROM categories WHERE ledger_id = @ledger')).toBe(0)
    // Renamed: its transactions keep it. Off: still off.
    expect(a.q.pluck('SELECT category_id FROM transactions WHERE id = ? AND ledger_id = @ledger', rows.refund)).toBe(dineOut)
    expect(a.q.column('SELECT category_id FROM ledger_category_off WHERE ledger_id = @ledger')).toEqual([gifts])
    // Deleted: its transactions and recurring items are uncategorized, and what was learned about it goes.
    expect(a.q.all('SELECT category_id, category_source, needs_review FROM transactions WHERE id IN (?, ?) AND ledger_id = @ledger', rows.purchase, rows.payment)).toEqual([
      { category_id: null, category_source: null, needs_review: 0 },
      { category_id: null, category_source: null, needs_review: 0 },
    ])
    expect(a.q.column('SELECT category_id FROM recurring_items WHERE ledger_id = @ledger')).toEqual([null])
    expect(a.q.pluck('SELECT count(*) FROM payee_rules WHERE ledger_id = @ledger')).toBe(0)
    expect(a.q.pluck('SELECT count(*) FROM payee_category_stats WHERE ledger_id = @ledger')).toBe(0)
    expect(a.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(5)
    expect(ledgerRows(storage.sqlite, b.ledger.id)).toEqual(bBefore)
  })

  it('adds categories to the shared list only when the caller may', () => {
    const source = testStorage()
    const s = source.registry.defaultContext()
    fullLedger(s)
    const { db, file } = open(exportLedger(source.sqlite, s.ledger.id))
    db.prepare(`INSERT INTO categories (name) VALUES ('Added by a backup')`).run()
    db.prepare(`UPDATE transactions SET category_id = (SELECT id FROM categories WHERE name = 'Added by a backup') WHERE amount_minor = -5000`).run()
    // App settings in the file are never taken.
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('timezone', '"Pacific/Kiritimati"')`).run()
    db.close()
    const bytes = new Uint8Array(readFileSync(file))

    const storage = testStorage()
    const f = testLedger(storage, 'Restored')
    const added = () => storage.sqlite.prepare("SELECT count(*) FROM categories WHERE ledger_id IS NULL AND name = 'Added by a backup'").pluck().get()
    expect(() => restoreBackup(storage, f, bytes, { addCategories: false })).toThrow(/can’t add to it/)
    expect(added()).toBe(0)
    expect(f.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(0)
    restoreBackup(storage, f, bytes, { addCategories: true })
    expect(added()).toBe(1)
    expect(f.q.pluck("SELECT c.name FROM transactions t JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id WHERE t.ledger_id = @ledger AND t.amount_minor = -5000")).toBe(
      'Added by a backup',
    )
    expect(storage.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'timezone'").pluck().get()).toBe('"America/Toronto"')
  })

  it('never hands out again an id a report in the backup still names', () => {
    const source = testStorage()
    const s = source.registry.defaultContext()
    const kept = Number(s.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'kept')").lastInsertRowid)
    const gone = Number(s.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'gone')").lastInsertRowid)
    s.q.run('DELETE FROM tags WHERE id = ? AND ledger_id = @ledger', gone)
    const spec = { filter: { spending: { only: [{ field: 'tag', ids: [kept, gone] }], filterOut: [], picked: [], keep: [] } }, names: { tag: { [kept]: 'kept', [gone]: 'gone' } }, range: '12m' }
    s.q.run("INSERT INTO custom_reports (ledger_id, name, spec) VALUES (@ledger, 'Tags', ?)", JSON.stringify(spec))
    const bytes = exportLedger(source.sqlite, s.ledger.id)

    // Into an install whose tag ids are taken by a ledger of its own, and into a new one.
    const busy = testStorage()
    const p = busy.registry.defaultContext()
    for (const name of ['a', 'b', 'c']) p.q.run('INSERT INTO tags (ledger_id, name) VALUES (@ledger, ?)', name)
    for (const [storage, target] of [
      [busy, testLedger(busy, 'Restored')],
      [testStorage(), null],
    ] as const) {
      const ctx = target ?? storage.registry.defaultContext()
      restoreBackup(storage, ctx, bytes)
      const named = JSON.parse(ctx.q.pluck<string>('SELECT spec FROM custom_reports WHERE ledger_id = @ledger')!).filter.spending.only[0].ids as number[]
      expect(ctx.q.column('SELECT id FROM tags WHERE ledger_id = @ledger')).toEqual([named[0]])
      const added = Number(ctx.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'new')").lastInsertRowid)
      expect(added).toBeGreaterThan(named[1]!)
    }
  })

  it('never lets a backup decide where this database’s ids continue', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const aRows = fullLedger(a)
    const rows = fullLedger(b, '⟦B⟧')
    const good = exportLedger(storage.sqlite, b.ledger.id)
    const edited = (sql: string[]) => {
      const { db, file } = open(good)
      for (const s of sql) db.exec(s)
      db.close()
      return new Uint8Array(readFileSync(file))
    }
    const cols = Object.keys(ledgerRows(storage.sqlite, b.ledger.id).transactions![0] as object).filter((c) => c !== 'id' && c !== 'external_id' && c !== 'transfer_pair_id')
    /** A copy of one of B's transactions, with this id. */
    const copy = (id: string) => `INSERT INTO transactions (id, ${cols.join(', ')}) SELECT ${id}, ${cols.join(', ')} FROM transactions WHERE id = ${rows.payment}`
    const huge = 'UPDATE sqlite_sequence SET seq = 9223372036854775807'
    const addTransaction = () => {
      const id = Number(
        a.q.run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES (@ledger, ?, '2026-10-01', -100, 'New', 'new')", aRows.account)
          .lastInsertRowid,
      )
      expect(a.q.pluck('SELECT payee FROM transactions WHERE id = ? AND ledger_id = @ledger', id)).toBe('New')
      return id
    }
    const before = addTransaction()

    // A file's sequence, and ids far past this database's, don't move where new ids go.
    for (const bytes of [edited([huge]), edited([huge, copy(String(2 ** 50))])]) {
      restoreBackup(storage, b, bytes)
      const seqs = storage.sqlite.prepare('SELECT max(seq) FROM sqlite_sequence').pluck().get() as number
      expect(seqs).toBeLessThan(10_000)
      expect(addTransaction()).toBeLessThan(before + 100)
    }
    // Ids a JS number can't hold are refused.
    for (const id of [String(2n ** 62n), '-5', '0']) {
      const bad = edited([copy(id)])
      expect(() => restoreBackup(storage, b, bad)).toThrow(/inconsistent data/)
    }
    expect(addTransaction()).toBeLessThan(before + 100)
  })

  it('keeps a ledger’s own category list', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    fullLedger(a)
    leaveSharedList(a)
    a.q.run("UPDATE categories SET name = 'Food at home' WHERE ledger_id = @ledger AND name = 'Groceries'")
    const before = ledgerRows(storage.sqlite, a.ledger.id)
    const bytes = exportLedger(storage.sqlite, a.ledger.id)
    const { db } = open(bytes)
    expect(db.prepare('SELECT count(*) FROM categories WHERE ledger_id IS NULL').pluck().get()).toBe(0)
    db.close()

    importBytes(storage, a, bytes)
    expect(ledgerRows(storage.sqlite, a.ledger.id)).toEqual(before)
    expect(a.q.pluck('SELECT category_list FROM ledgers WHERE id = @ledger')).toBe('own')

    // Into a ledger on the shared list, as a copy with new ids.
    const b = testLedger(storage, 'Copy')
    importBytes(storage, b, bytes)
    expect(b.q.pluck('SELECT category_list FROM ledgers WHERE id = @ledger')).toBe('own')
    expect(b.q.column("SELECT name FROM ledger_categories WHERE ledger_id = @ledger AND name = 'Food at home'")).toEqual(['Food at home'])
    expect(ledgerRows(storage.sqlite, b.ledger.id).categories!.length).toBe(ledgerRows(storage.sqlite, a.ledger.id).categories!.length)
  })

  it('refuses a bad file and changes nothing, leaving no temp file', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(b)
    const before = ledgerRows(storage.sqlite, a.ledger.id)
    const good = exportLedger(storage.sqlite, a.ledger.id)

    const edited = (sql: string[]) => {
      const { db, file } = open(good)
      db.pragma('foreign_keys = OFF')
      for (const s of sql) db.exec(s)
      db.close()
      return new Uint8Array(readFileSync(file))
    }
    const otherApp = (() => {
      const { db, file } = open(good)
      db.pragma('application_id = 7')
      db.close()
      return new Uint8Array(readFileSync(file))
    })()
    const garbage = new Uint8Array(good)
    garbage.fill(7, 100)
    const cases: Array<[Uint8Array, RegExp]> = [
      [new TextEncoder().encode('date,payee,amount\n'.repeat(20)), /isn't a Chipmunk backup/],
      [garbage, /isn't a Chipmunk backup/],
      [otherApp, /isn't a Chipmunk backup/],
      [edited(["INSERT INTO ledgers (id, name, slug) VALUES ('X', 'X', 'x')"]), /whole Chipmunk database/],
      [edited(['DELETE FROM ledgers']), /isn't a Chipmunk backup/],
      // A transaction whose account isn't in the file.
      [edited(['DELETE FROM accounts WHERE id = (SELECT min(account_id) FROM transactions)']), /inconsistent data/],
      // A row pointing into another ledger of this install.
      [edited([`UPDATE transactions SET account_id = ${b.q.pluck('SELECT id FROM ledger_accounts WHERE ledger_id = @ledger LIMIT 1')} WHERE id = (SELECT min(id) FROM transactions)`]), /inconsistent data/],
      [edited(["UPDATE __drizzle_migrations SET created_at = created_at + 10000000000"]), /newer version/],
    ]
    for (const [bytes, message] of cases) {
      expect(() => restoreBackup(storage, a, bytes)).toThrow(message)
      expect(ledgerRows(storage.sqlite, a.ledger.id)).toEqual(before)
      expect(readdirSync(path.join(dir, '.tmp'))).toEqual([])
    }
  })

  it('unlinks bank accounts from the accounts a restore replaces', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const rows = fullLedger(a)
    storage.sqlite.prepare("INSERT INTO bank_connections (id, provider, name, secret) VALUES ('c1', 'plaid', 'Bank', 'sealed')").run()
    storage.sqlite.prepare("INSERT INTO bank_accounts (id, connection_id, remote_id, name, currency, account_id) VALUES ('b1', 'c1', 'r1', 'Card', 'CAD', ?)").run(rows.account)
    const bytes = exportLedger(storage.sqlite, a.ledger.id)
    restoreBackup(storage, a, bytes)
    const dangling = `SELECT count(*) FROM bank_accounts b WHERE b.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.account_id)`
    expect(storage.sqlite.prepare(dangling).pluck().get()).toBe(0)
    expect(storage.sqlite.prepare("SELECT account_id FROM bank_accounts WHERE id = 'b1'").pluck().get()).toBeNull()

    storage.sqlite.prepare("UPDATE bank_accounts SET account_id = ? WHERE id = 'b1'").run(rows.account)
    eraseAll(storage, a)
    expect(storage.sqlite.prepare(dangling).pluck().get()).toBe(0)
    expect(storage.sqlite.prepare("SELECT account_id FROM bank_accounts WHERE id = 'b1'").pluck().get()).toBeNull()
  })
})

describe('erasing a ledger', () => {
  it('keeps its activity and ledger settings, and nothing of another ledger changes', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(b)
    a.q.run("INSERT INTO ledger_settings (ledger_id, key, value) VALUES (@ledger, 'reports.range', '\"6m\"')")
    const activity = ledgerRows(storage.sqlite, a.ledger.id).activity
    const counts = ledgerRowCounts(storage.sqlite, a.ledger.id)
    const bBefore = ledgerRows(storage.sqlite, b.ledger.id)

    const { backup } = eraseAll(storage, a)
    expect(backup).toMatch(/^pre-erase-personal-.*\.db$/)
    const after = ledgerRows(storage.sqlite, a.ledger.id)
    expect(after.activity).toEqual(activity)
    expect(after.ledger_settings).toEqual([expect.objectContaining({ key: 'reports.range', value: '"6m"' })])
    for (const [t, rs] of Object.entries(after)) if (t !== 'activity' && t !== 'ledger_settings') expect([t, rs.length]).toEqual([t, 0])
    expect(ledgerRows(storage.sqlite, b.ledger.id)).toEqual(bBefore)

    // Its copy restores what was there.
    const saved = new Uint8Array(readFileSync(path.join(dir, 'backups', backup!)))
    restoreBackup(storage, a, saved)
    expect(ledgerRowCounts(storage.sqlite, a.ledger.id)).toEqual(counts)
  })
})

describe('deleting a ledger', () => {
  it('leaves none of its rows, and its saved copy restores', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const a = storage.registry.defaultContext()
    const f = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(f)
    const fBefore = ledgerRows(storage.sqlite, f.ledger.id)
    const aBefore = ledgerRows(storage.sqlite, a.ledger.id)

    const { backup } = storage.registry.remove(f.ledger.id)
    expect(backup).toMatch(/^deleted-family-.*\.db$/)
    expect(Object.entries(ledgerRowCounts(storage.sqlite, f.ledger.id)).filter(([, n]) => n > 0)).toEqual([])
    expect(storage.sqlite.prepare('SELECT count(*) FROM activity WHERE ledger_id = ?').pluck().get(f.ledger.id)).toBe(0)
    expect(ledgerRows(storage.sqlite, a.ledger.id)).toEqual(aBefore)

    // Into a new ledger: its ids are free again, so they're kept.
    const back = testLedger(storage, 'Family again')
    importBytes(storage, back, new Uint8Array(readFileSync(path.join(dir, 'backups', backup!))))
    expect(withoutLedger(ledgerRows(storage.sqlite, back.ledger.id))).toEqual(withoutLedger(fBefore))
  })
})

describe('the full backup', () => {
  it('is the whole database, and opens as it was', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(b)
    const { bytes } = fullBackup(storage)
    const files = unzipSync(bytes)
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
    expect(manifest).toMatchObject({ format: 2, secretKey: expect.stringMatching(/secret\.key/) })
    expect(manifest.restore).toMatch(/-wal/)

    const dir = tempDir()
    writeFileSync(path.join(dir, DB_FILE), files[DB_FILE]!)
    const copy = fileStorage(dir)
    expect(copy.registry.list().map((l) => [l.id, l.name, l.accounts, l.transactions])).toEqual(storage.registry.list().map((l) => [l.id, l.name, l.accounts, l.transactions]))
    for (const id of [a.ledger.id, b.ledger.id]) expect(ledgerRows(copy.sqlite, id)).toEqual(ledgerRows(storage.sqlite, id))
  })
})
