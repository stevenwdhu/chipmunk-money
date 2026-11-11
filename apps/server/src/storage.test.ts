import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { transactionCreateSchema } from '@chipmunk/shared'
import { createApp } from './app'
import { openLedgerDb, openMetaDb } from './db/client'
import { seedDefaults } from './db/seed'
import { SecretBox } from './lib/secrets'
import { listAccounts } from './services/accounts'
import { listCategories, updateCategory } from './services/categories'
import { suggestCategory } from './services/categorize'
import { getAppSetting, setAppSetting } from './services/settings'
import { createTransaction } from './services/transactions'
import { LedgerRegistry, openStorage, type Storage } from './storage'
import { categoryId, makeAccount, testStorage } from './test/helpers'

const dirs: string[] = []
const opened: Storage[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-storage-'))
  dirs.push(dir)
  return dir
}
function open(dataDir: string) {
  const storage = openStorage({ dataDir })
  opened.push(storage)
  return storage
}
afterEach(() => {
  for (const s of opened.splice(0)) {
    s.registry.closeAll()
    s.meta.sqlite.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('ledgers', () => {
  it('starts with a "Personal" ledger', () => {
    const storage = testStorage()
    expect(storage.registry.list().map((l) => [l.name, l.slug, l.isDefault])).toEqual([['Personal', 'personal', true]])
  })

  it("keeps each ledger's data, categories and learning separate", async () => {
    const storage = testStorage()
    const family = storage.registry.create({ name: 'Family' })
    const personal = storage.registry.defaultContext()
    const fam = storage.registry.context(family.slug)

    const acc = makeAccount(personal, 'My Chequing')
    expect(listAccounts(personal).map((a) => a.name)).toEqual(['My Chequing'])
    expect(listAccounts(fam)).toEqual([])

    updateCategory(fam, categoryId(fam, 'Groceries'), { name: 'Food at home' })
    expect(listCategories(personal).categories.some((c) => c.name === 'Groceries')).toBe(true)
    expect(listCategories(fam).categories.some((c) => c.name === 'Food at home')).toBe(true)

    // A confirmed category in Personal is not learned by Family.
    await createTransaction(
      personal,
      transactionCreateSchema.parse({ accountId: acc, date: '2026-09-01', amountMinor: -500, payee: 'Loblaws', categoryId: categoryId(personal, 'Groceries') }),
    )
    expect((await suggestCategory(personal, { payee: 'LOBLAWS', useAi: false })).categoryId).not.toBeNull()
    expect((await suggestCategory(fam, { payee: 'LOBLAWS', useAi: false })).categoryId).toBeNull()

    // App-wide settings are shared.
    expect(personal.meta).toBe(fam.meta)
  })

  it('gives unique slugs, renames them, and resolves by id or slug', () => {
    const { registry } = testStorage()
    const a = registry.create({ name: 'Family' })
    const b = registry.create({ name: 'Family' })
    expect([a.slug, b.slug]).toEqual(['family', 'family-2'])
    expect(registry.create({ name: 'L' }).slug).toBe('l-2')
    const renamed = registry.update(b.id, { name: 'Cottage & Boat' })
    expect(renamed.slug).toBe('cottage-boat')
    expect(registry.get('cottage-boat').id).toBe(b.id)
    expect(registry.get(b.id).name).toBe('Cottage & Boat')
    expect(() => registry.get('nope')).toThrow(/no ledger/)
  })

  it('protects the only active ledger and moves the default when archiving', () => {
    const { registry } = testStorage()
    const personal = registry.defaultLedger()
    expect(() => registry.update(personal.id, { archived: true })).toThrow(/only ledger/)
    expect(() => registry.remove(personal.id)).toThrow(/only ledger/)

    const family = registry.create({ name: 'Family' })
    registry.update(family.id, { isDefault: true })
    expect(registry.defaultLedger().id).toBe(family.id)
    registry.update(family.id, { archived: true })
    expect(registry.defaultLedger().id).toBe(personal.id)
    expect(registry.list().find((l) => l.id === family.id)?.archived).toBe(true)
  })

  it('stores each ledger in its own file and snapshots it before deleting', () => {
    const dir = tempDir()
    const storage = open(dir)
    const family = storage.registry.create({ name: 'Family' })
    const file = path.join(dir, 'ledgers', family.file)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(path.join(dir, 'meta.db'))).toBe(true)

    const { backup } = storage.registry.remove(family.id)
    expect(existsSync(file)).toBe(false)
    expect(backup).toMatch(/^deleted-family-/)
    expect(readdirSync(path.join(dir, 'backups'))).toContain(backup)
  })
})

/** A GET from the app's own page. */
const web = { headers: { 'sec-fetch-site': 'same-origin' } }

describe('ledger API', () => {
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  it('scopes routes by ledger', async () => {
    const storage = testStorage()
    const app = createApp(storage)
    let res = await app.request('/api/v1/ledgers', json('POST', { name: 'Family', start: 'empty' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'Family', slug: 'family', isDefault: false })

    res = await app.request('/api/v1/ledgers/family/accounts', json('POST', { name: 'Joint', type: 'chequing', institution: 'TD' }))
    expect(res.status).toBe(201)
    expect(((await (await app.request('/api/v1/ledgers/family/accounts', web)).json()) as unknown[]).length).toBe(1)
    expect(((await (await app.request('/api/v1/ledgers/personal/accounts', web)).json()) as unknown[]).length).toBe(0)

    res = await app.request('/api/v1/ledgers/nope/accounts', web)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/no ledger called “nope”/)
  })

  it('removes an institution with its last account', async () => {
    const app = createApp(testStorage())
    const add = async (name: string, institution: string) =>
      ((await (await app.request('/api/v1/ledgers/personal/accounts', json('POST', { name, type: 'chequing', institution }))).json()) as { id: number }).id
    const names = async () => ((await (await app.request('/api/v1/ledgers/personal/institutions', web)).json()) as Array<{ name: string }>).map((i) => i.name)
    const chequing = await add('Chequing', 'TD')
    const savings = await add('Savings', 'TD')
    const old = await add('Old account', 'Scotiabank')

    await app.request(`/api/v1/ledgers/personal/accounts/${chequing}`, json('DELETE'))
    expect(await names()).toEqual(['TD', 'Scotiabank'])
    // Moving the last account away empties it too.
    await app.request(`/api/v1/ledgers/personal/accounts/${savings}`, json('PATCH', { institution: 'Scotiabank' }))
    expect(await names()).toEqual(['Scotiabank'])
    // Archived accounts are still there, so their institution stays.
    await app.request(`/api/v1/ledgers/personal/accounts/${savings}`, json('DELETE'))
    await app.request(`/api/v1/ledgers/personal/accounts/${old}`, json('PATCH', { archived: true }))
    expect(await names()).toEqual(['Scotiabank'])
    await app.request(`/api/v1/ledgers/personal/accounts/${old}`, json('DELETE'))
    expect(await names()).toEqual([])
    const activity = (await (await app.request('/api/v1/ledgers/personal/activity', web)).json()) as { items: Array<{ summary: string }> }
    expect(activity.items.map((a) => a.summary)).toContain('Removed the institution TD, which had no accounts left')
  })

  it('creates a demo ledger and requires the name to delete one', async () => {
    const storage = testStorage()
    const app = createApp(storage)
    const created = (await (await app.request('/api/v1/ledgers', json('POST', { name: 'Demo', start: 'demo' }))).json()) as {
      transactions: number
    }
    expect(created.transactions).toBeGreaterThan(300)
    expect((await (await app.request('/api/v1/ledgers/demo/setup', web)).json()) as object).toMatchObject({ needsSetup: false })

    expect((await app.request('/api/v1/ledgers/demo', json('DELETE', { confirm: 'demo' }))).status).toBe(400)
    expect((await app.request('/api/v1/ledgers/demo', json('DELETE', { confirm: 'Demo' }))).status).toBe(200)
    expect(storage.registry.list().map((l) => l.name)).toEqual(['Personal'])
  })

  it('downloads a full backup with every ledger', async () => {
    const storage = testStorage()
    storage.registry.create({ name: 'Family' })
    const res = await createApp(storage).request('/api/v1/backup/full', web)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    const names = Object.keys(files).sort()
    expect(names).toContain('meta.db')
    expect(names).toContain('manifest.json')
    expect(names.filter((n) => n.startsWith('ledgers/'))).toHaveLength(2)
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
    expect(manifest.ledgers.map((l: { name: string }) => l.name).sort()).toEqual(['Family', 'Personal'])
  })
})

describe('app-wide AI usage', () => {
  it('sums AI calls across ledgers and names the ledger on each recent call', async () => {
    const storage = testStorage()
    const family = storage.registry.create({ name: 'Family' })
    const log = (slug: string, ok: boolean) =>
      storage.registry
        .context(slug)
        .sqlite.prepare(`INSERT INTO ai_calls (slot, model, latency_ms, ok, input_tokens, output_tokens) VALUES ('primary', 'm', 100, ?, 10, 2)`)
        .run(ok ? 1 : 0)
    log('personal', true)
    log(family.slug, false)
    log(family.slug, true)
    const usage = (await (await createApp(storage).request('/api/v1/ai/usage', web)).json()) as {
      calls: number
      failures: number
      inputTokens: number
      recent: Array<{ ledger: string }>
    }
    expect(usage).toMatchObject({ calls: 3, failures: 1, inputTokens: 30 })
    expect(usage.recent.map((r) => r.ledger).sort()).toEqual(['Family', 'Family', 'Personal'])
  })
})
