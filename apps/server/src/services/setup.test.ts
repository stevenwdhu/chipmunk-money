import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { transactionCreateSchema } from '@st/shared'
import { createApp } from '../app'
import { makeAccount, testContext, testStorage } from '../test/helpers'
import { eraseAll, restoreBackup, setupStatus, startDemo, startEmpty } from './setup'
import { createTransaction } from './transactions'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

async function backupBytes(ctx: ReturnType<typeof testContext>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-test-'))
  dirs.push(dir)
  const file = path.join(dir, 'backup.db')
  await ctx.sqlite.backup(file)
  return new Uint8Array(readFileSync(file))
}

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

  it('restores a backup into a fresh database, replacing what was there', async () => {
    const source = testContext()
    const acc = makeAccount(source, 'Backup Chequing')
    await createTransaction(source, transactionCreateSchema.parse({ accountId: acc, date: '2026-09-01', amountMinor: -500, payee: 'Coffee', tags: ['restored'] }), { useAi: false })
    const bytes = await backupBytes(source)

    const target = testContext()
    makeAccount(target, 'Will be replaced')
    const counts = restoreBackup(target, bytes)
    expect(counts).toEqual({ accounts: 1, transactions: 1 })
    const names = target.sqlite.prepare('SELECT name FROM accounts').all()
    expect(names).toEqual([{ name: 'Backup Chequing' }])
    expect(target.sqlite.prepare('SELECT name FROM tags').all()).toEqual([{ name: 'restored' }])
    expect(setupStatus(target).needsSetup).toBe(false)
    expect(target.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('rejects files that are not backups and leaves data alone', () => {
    const ctx = testContext()
    makeAccount(ctx)
    expect(() => restoreBackup(ctx, new TextEncoder().encode('date,payee,amount\n'.repeat(20)))).toThrow(/isn't a Spending Tracker backup/)
    expect(setupStatus(ctx).accounts).toBe(1)
  })

  it('erases everything but settings and shows the welcome screen again', () => {
    const ctx = testContext()
    startDemo(ctx)
    eraseAll(ctx)
    expect(setupStatus(ctx)).toEqual({ needsSetup: true, accounts: 0, transactions: 0 })
    // Default categories come back; app-wide settings (in meta.db) are untouched.
    expect((ctx.sqlite.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }).n).toBeGreaterThan(10)
    expect(ctx.meta.sqlite.prepare(`SELECT value FROM settings WHERE key = 'timezone'`).get()).toBeTruthy()
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
