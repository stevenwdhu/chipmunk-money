import { describe, expect, it } from 'vitest'
import type { AppContext } from '../services/context'
import { testLedger, testStorage } from '../test/helpers'
import { bareDatabase, fillLedger, ledgerRowCounts, type Writer } from '../test/world'
import { appTables } from './client'
import { ledgerMaintenance } from './scope'
import { deleteLedgerRows, LEDGER_VIEWS, TABLES } from './tables'

const writer =
  (ctx: AppContext): Writer =>
  (sql, params = {}) =>
    Number(ctx.q.run(sql, params).lastInsertRowid)

describe('the table list', () => {
  const sqlite = bareDatabase()
  const columns = (table: string) => sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; notnull: number }>
  const foreignKeys = (table: string) => sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string; from: string }>

  it('has every table in the database, once', () => {
    expect(TABLES.map((t) => t.name).sort()).toEqual(appTables(sqlite).sort())
    expect(new Set(TABLES.map((t) => t.name)).size).toBe(TABLES.length)
    const views = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").pluck().all()
    expect([...views].sort()).toEqual([...LEDGER_VIEWS].sort())
  })

  it('says how each table belongs to a ledger', () => {
    for (const t of TABLES) {
      const ledgerId = columns(t.name).find((c) => c.name === 'ledger_id')
      const toLedgers = foreignKeys(t.name).some((f) => f.table === 'ledgers' && f.from === 'ledger_id')
      if (t.kind === 'app' || t.kind === 'child') expect(ledgerId, t.name).toBeUndefined()
      if (t.kind === 'catalog') expect(ledgerId?.notnull, t.name).toBe(0)
      // ai_calls may be for the whole app (null).
      if (t.kind === 'ledger') expect(ledgerId?.notnull, t.name).toBe(t.name === 'ai_calls' ? 0 : 1)
      if (t.kind === 'ledger' || t.kind === 'catalog') expect(toLedgers, t.name).toBe(true)
      if (t.kind === 'child') {
        const fks = foreignKeys(t.name)
        for (const p of t.parents!) expect(fks.some((f) => f.from === p.column && f.table === p.table), `${t.name}.${p.column}`).toBe(true)
      }
    }
  })

  it('comes in insert order: each table after the ones it refers to', () => {
    const order = new Map(TABLES.map((t, i) => [t.name, i]))
    for (const t of TABLES) {
      for (const f of foreignKeys(t.name)) {
        if (f.table !== t.name) expect(order.get(f.table)!, `${t.name} → ${f.table}`).toBeLessThan(order.get(t.name)!)
      }
    }
  })
})

describe('deleteLedgerRows', () => {
  function world() {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const shared = storage.sqlite.prepare('SELECT id FROM categories WHERE ledger_id IS NULL ORDER BY id LIMIT 2').pluck().all() as number[]
    const opts = { category: shared[0]!, offCategory: shared[1]! }
    const rowsA = fillLedger(writer(a), opts)
    const rowsB = fillLedger(writer(b), opts)
    // B's card is shared with A, with a bank of A's own.
    const institution = writer(a)("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Family bank')")
    writer(a)('INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES (@ledger, @account, @institution)', { account: rowsB.account, institution })
    // A bank account linked to one of A's accounts.
    storage.sqlite.prepare("INSERT INTO bank_connections (id, provider, name, secret) VALUES ('c', 'simplefin', 'SimpleFIN', 's')").run()
    storage.sqlite
      .prepare("INSERT INTO bank_accounts (id, connection_id, remote_id, name, currency, account_id) VALUES ('ba', 'c', 'r', 'Card', 'CAD', ?)")
      .run(rowsA.account)
    return { storage, a, b }
  }
  const catalog = (s: ReturnType<typeof world>['storage']) =>
    s.sqlite.prepare('SELECT (SELECT count(*) FROM categories) + (SELECT count(*) FROM category_groups) + (SELECT count(*) FROM labels) + (SELECT count(*) FROM category_labels)').pluck().get()

  it("leaves none of the ledger's rows and doesn't touch another's", () => {
    const { storage, a, b } = world()
    const before = ledgerRowCounts(storage.sqlite, b.ledger.id)
    const sharedBefore = catalog(storage)
    // Every table with ledger data has rows of A to delete.
    expect(Object.entries(ledgerRowCounts(storage.sqlite, a.ledger.id)).filter(([t, n]) => n === 0 && !['category_groups', 'categories', 'labels', 'category_labels'].includes(t))).toEqual([])

    ledgerMaintenance(storage.sqlite, a.ledger.id, () => deleteLedgerRows(storage.sqlite, a.ledger.id))
    expect(Object.values(ledgerRowCounts(storage.sqlite, a.ledger.id)).every((n) => n === 0)).toBe(true)
    expect(ledgerRowCounts(storage.sqlite, b.ledger.id)).toEqual(before)
    expect(catalog(storage)).toBe(sharedBefore)
    // The bank account was unlinked by its foreign key.
    expect(storage.sqlite.prepare("SELECT account_id FROM bank_accounts WHERE id = 'ba'").pluck().get()).toBeNull()
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('keeps the tables asked for', () => {
    const { storage, a } = world()
    ledgerMaintenance(storage.sqlite, a.ledger.id, () => deleteLedgerRows(storage.sqlite, a.ledger.id, { keep: ['activity', 'ledger_settings'] }))
    const left = ledgerRowCounts(storage.sqlite, a.ledger.id)
    expect(Object.entries(left).filter(([, n]) => n > 0).map(([t]) => t).sort()).toEqual(['activity', 'ledger_settings'])
  })

  it("is refused outside the ledger's scope, and deletes nothing then", () => {
    const { storage, a, b } = world()
    const before = ledgerRowCounts(storage.sqlite, a.ledger.id)
    expect(() => deleteLedgerRows(storage.sqlite, a.ledger.id)).toThrow('write outside the ledger scope')
    expect(() => ledgerMaintenance(storage.sqlite, b.ledger.id, () => deleteLedgerRows(storage.sqlite, a.ledger.id))).toThrow('write outside the ledger scope')
    expect(ledgerRowCounts(storage.sqlite, a.ledger.id)).toEqual(before)
  })
})
