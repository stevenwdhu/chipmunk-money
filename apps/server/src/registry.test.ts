import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAppSetting, getLedgerSetting } from './services/settings'
import { openStorage, type Storage } from './storage'
import { categoryId, makeAccount, testLedger, testStorage } from './test/helpers'
import { ledgerRowCounts } from './test/world'

const opened: Storage[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the ledger registry', () => {
  it('starts a new install with a "Personal" ledger on the shared list', () => {
    const storage = testStorage()
    expect(storage.registry.list().map((l) => [l.name, l.slug, l.isDefault, l.accounts, l.transactions])).toEqual([['Personal', 'personal', true, 0, 0]])
    expect(storage.registry.defaultLedger().categoryList).toBe('shared')
    // It sees the whole shared list.
    const ctx = storage.registry.defaultContext()
    const shared = storage.sqlite.prepare('SELECT count(*) FROM categories WHERE ledger_id IS NULL').pluck().get()
    expect(ctx.q.pluck('SELECT count(*) FROM ledger_categories WHERE ledger_id = @ledger')).toBe(shared)
  })

  it('makes "Personal" once: opening the same data again keeps what is there', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'st-registry-'))
    dirs.push(dir)
    const first = openStorage({ dataDir: dir })
    first.registry.create({ name: 'Family' })
    first.close()
    const again = openStorage({ dataDir: dir })
    opened.push(again)
    expect(again.registry.list().map((l) => l.name)).toEqual(['Personal', 'Family'])
  })

  it('creates a ledger with its settings, and counts each ledger’s accounts and transactions', () => {
    const storage = testStorage()
    const family = storage.registry.create({ name: 'Family', settings: { 'setup.completed': true } })
    const fam = storage.registry.context(family.slug)
    expect(getLedgerSetting(fam, 'setup.completed', false)).toBe(true)
    expect(getLedgerSetting(storage.registry.defaultContext(), 'setup.completed', false)).toBe(false)

    const account = makeAccount(fam, 'Joint')
    fam.q.run(
      "INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id) VALUES (@ledger, ?, '2026-09-01', -500, 'Shop', 'shop', ?)",
      account,
      categoryId(fam, 'Groceries'),
    )
    fam.q.run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, deleted_at) VALUES (@ledger, ?, '2026-09-01', -1, 'x', 'x', 'now')", account)
    const counts = storage.registry.list().map((l) => [l.name, l.accounts, l.transactions])
    expect(counts).toEqual([
      ['Personal', 0, 0],
      ['Family', 1, 1],
    ])
    expect(storage.registry.toDTO(storage.registry.get(family.id))).toMatchObject({ accounts: 1, transactions: 1, isDefault: false })
  })

  it('gives unique slugs and finds a ledger by id or slug', () => {
    const { registry } = testStorage()
    const a = registry.create({ name: 'Family' })
    const b = registry.create({ name: 'Family' })
    expect([a.slug, b.slug]).toEqual(['family', 'family-2'])
    expect(registry.uniqueSlug('L')).toBe('l-2')
    expect(registry.get('family-2').id).toBe(b.id)
    expect(registry.find(a.id)?.slug).toBe('family')
    expect(() => registry.get('nope')).toThrow(/no ledger/)
  })

  it('moves the default when the default ledger is archived or deleted', () => {
    const storage = testStorage()
    const { registry } = storage
    const personal = registry.defaultLedger()
    const family = registry.create({ name: 'Family' })
    registry.update(family.id, { isDefault: true })
    expect(registry.defaultLedger().id).toBe(family.id)
    expect(registry.list().find((l) => l.isDefault)?.id).toBe(family.id)
    registry.update(family.id, { archived: true })
    expect(registry.defaultLedger().id).toBe(personal.id)

    const cottage = registry.create({ name: 'Cottage' })
    registry.update(cottage.id, { isDefault: true })
    registry.remove(cottage.id)
    expect(getAppSetting(storage.app, 'defaultLedger', null)).toBeNull()
    expect(registry.defaultLedger().id).toBe(personal.id)
  })

  it('deletes a ledger with all its rows, and none of another ledger’s', () => {
    const storage = testStorage()
    const personal = storage.registry.defaultContext()
    const family = testLedger(storage, 'Family')
    makeAccount(personal, 'Mine')
    makeAccount(family, 'Joint')
    family.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'trip')")
    family.q.run("INSERT INTO ledger_settings (ledger_id, key, value) VALUES (@ledger, 'setup.completed', 'true')")
    const before = ledgerRowCounts(storage.sqlite, personal.ledger.id)

    expect(storage.registry.remove(family.ledger.id)).toEqual({ backup: null, changes: ['Family and all its data were deleted.'] })
    expect(storage.registry.find(family.ledger.id)).toBeUndefined()
    expect(Object.values(ledgerRowCounts(storage.sqlite, family.ledger.id)).every((n) => n === 0)).toBe(true)
    expect(ledgerRowCounts(storage.sqlite, personal.ledger.id)).toEqual(before)
    expect(storage.registry.list().map((l) => [l.name, l.accounts])).toEqual([['Personal', 1]])
  })

  it("won't archive or delete the only ledger", () => {
    const { registry } = testStorage()
    const personal = registry.defaultLedger()
    expect(() => registry.update(personal.id, { archived: true })).toThrow(/only ledger/)
    expect(() => registry.remove(personal.id)).toThrow(/only ledger/)
  })

  it('gives every context the same app store', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage)
    expect(a.app).toBe(b.app)
    expect(a.meta).toBe(a.app)
    expect('meta' in storage).toBe(false)
    expect(a.q.ledgerId).toBe(a.ledger.id)
  })
})
