import { describe, expect, it } from 'vitest'
import { transactionCreateSchema } from '@chipmunk/shared'
import { createApp } from '../app'
import { exportLedger } from '../db/ledger-backup'
import { seedDemo } from '../db/seed-demo'
import { makeAccount, testContext, testLedger, testStorage } from '../test/helpers'
import { getAppSetting } from './settings'
import { eraseAll, restoreBackup, setupStatus, startDemo, startEmpty } from './setup'
import { createTransaction } from './transactions'

describe('setup', () => {
  it('needs setup only on an empty, untouched database', async () => {
    const ctx = testContext()
    expect(setupStatus(ctx).needsSetup).toBe(true)
    expect(startEmpty(ctx).needsSetup).toBe(false)

    const other = testContext()
    makeAccount(other)
    expect(setupStatus(other).needsSetup).toBe(false)
  })

  it('loads the demo once and refuses when data exists', () => {
    const ctx = testContext()
    const res = startDemo(ctx)
    expect(res.transactions).toBeGreaterThan(300)
    expect(setupStatus(ctx)).toMatchObject({ needsSetup: false, accounts: 4 })
    expect(() => startDemo(ctx)).toThrow(/already data/)
  })

  it('keeps each ledger’s demo to itself', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const first = startDemo(a)
    expect(startDemo(b)).toEqual(first)
    expect(setupStatus(b)).toEqual(setupStatus(a))
    for (const ctx of [a, b]) {
      expect(setupStatus(ctx)).toMatchObject({ needsSetup: false, accounts: 4 })
      expect(ctx.q.column('SELECT name FROM custom_reports WHERE ledger_id = @ledger')).toEqual(['Everyday spending'])
    }
    // Each one's report filters by its own trip tag.
    const tripOf = (ctx: typeof a) => ctx.q.pluck<number>("SELECT id FROM tags WHERE ledger_id = @ledger AND name = 'trip-japan'")!
    const specOf = (ctx: typeof a) => JSON.parse(ctx.q.pluck<string>('SELECT spec FROM custom_reports WHERE ledger_id = @ledger')!)
    expect(tripOf(a)).not.toBe(tripOf(b))
    for (const ctx of [a, b]) expect(specOf(ctx).filter.spending.filterOut[0].when[0]).toEqual({ field: 'tag', ids: [tripOf(ctx)] })
    expect(() => seedDemo(b)).toThrow(/already has data/)
  })

  it('restores a backup into another install, replacing what was there', async () => {
    const from = testStorage()
    const source = from.registry.defaultContext()
    const acc = makeAccount(source, 'Backup Chequing')
    await createTransaction(source, transactionCreateSchema.parse({ accountId: acc, date: '2026-09-01', amountMinor: -500, payee: 'Coffee', tags: ['restored'] }), { useAi: false })
    const bytes = exportLedger(from.sqlite, source.ledger.id)

    const storage = testStorage()
    const target = storage.registry.defaultContext()
    makeAccount(target, 'Will be replaced')
    const counts = restoreBackup(storage, target, bytes)
    expect(counts).toEqual({ accounts: 1, transactions: 1 })
    expect(target.q.all('SELECT name FROM ledger_accounts WHERE ledger_id = @ledger')).toEqual([{ name: 'Backup Chequing' }])
    expect(target.q.all('SELECT name FROM tags WHERE ledger_id = @ledger')).toEqual([{ name: 'restored' }])
    expect(setupStatus(target).needsSetup).toBe(false)
  })

  it('rejects files that are not backups and leaves data alone', () => {
    const storage = testStorage()
    const ctx = storage.registry.defaultContext()
    makeAccount(ctx)
    expect(() => restoreBackup(storage, ctx, new TextEncoder().encode('date,payee,amount\n'.repeat(20)))).toThrow(/isn't a Chipmunk backup/)
    expect(setupStatus(ctx).accounts).toBe(1)
  })

  it('erases everything but settings and shows the welcome screen again', () => {
    const storage = testStorage()
    const ctx = storage.registry.defaultContext()
    const other = testLedger(storage, 'Family')
    startDemo(ctx)
    startDemo(other)
    const before = setupStatus(other)
    expect(eraseAll(storage, ctx)).toEqual({ backup: null })
    expect(setupStatus(ctx)).toEqual({ needsSetup: true, accounts: 0, transactions: 0 })
    // The shared categories are all on again, and app-wide settings are untouched.
    expect(ctx.q.pluck('SELECT count(*) FROM ledger_categories WHERE ledger_id = @ledger AND archived_at IS NULL')).toBeGreaterThan(10)
    expect(getAppSetting(storage.app, 'timezone', null)).toBe('America/Toronto')
    // The other ledger keeps its data.
    expect(setupStatus(other)).toEqual(before)
  })

  it('gives the demo’s report the next free id when it loads again after an erase', () => {
    // Ids are global, so the sequence never goes back: it isn't id 1 again (a deliberate change).
    const storage = testStorage()
    const ctx = storage.registry.defaultContext()
    startDemo(ctx)
    const reports = () => ctx.q.all('SELECT id, name FROM custom_reports WHERE ledger_id = @ledger')
    expect(reports()).toEqual([{ id: 1, name: 'Everyday spending' }])
    ctx.q.run("INSERT INTO custom_reports (ledger_id, name, spec) VALUES (@ledger, 'Two', '{}'), (@ledger, 'Three', '{}')")
    eraseAll(storage, ctx)
    startDemo(ctx)
    expect(reports()).toEqual([{ id: 4, name: 'Everyday spending' }])
  })

  it('requires the confirmation word to erase over HTTP', async () => {
    const storage = testStorage()
    const ctx = storage.registry.defaultContext()
    makeAccount(ctx)
    const app = createApp(storage)
    const req = (confirm: string) =>
      app.request('/api/v1/ledgers/personal/erase', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ confirm }) })
    expect((await req('yes')).status).toBe(400)
    expect(setupStatus(ctx).accounts).toBe(1)
    expect((await req('erase')).status).toBe(200)
    expect(setupStatus(ctx).accounts).toBe(0)
  })
})
