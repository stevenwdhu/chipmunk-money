import { describe, expect, it } from 'vitest'
import type { ApiKeyCreated, BulkResult, Transaction } from '@chipmunk/shared'
import { createApi, createApp, type AppOptions } from './app'
import { openApiPath } from './api/openapi'
import { withDryRun } from './api/router'
import type { AppContext } from './services/context'
import { getAppSetting, setAppSetting } from './services/settings'
import { setupStatus, startDemo } from './services/setup'
import { categoryId, makeAccount, testLedger, testStorage } from './test/helpers'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

function setup(opts: AppOptions = {}) {
  const storage = testStorage()
  const app = createApp(storage, { trustedHeader: null, ...opts })
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as Json }
  }
  const key = async (input: { name?: string; scopes: string[]; ledgers?: string[]; expiresInDays?: number }) => {
    const res = await call('POST', '/api-keys', { name: input.name ?? `${input.scopes.join('+')} key`, ...input })
    expect(res.status).toBe(201)
    const created = res.body as ApiKeyCreated
    return { ...created, auth: { authorization: `Bearer ${created.key}` } }
  }
  return { storage, app, call, key }
}

describe('API coverage', () => {
  it('describes every route in the spec, with a scope and a unique operation id', () => {
    const storage = testStorage()
    const app = createApp(storage)
    const { specs } = createApi(storage)
    const documented = new Set(specs.map((s) => `${s.method.toUpperCase()} /api/v1${s.path}`))
    const registered = app.routes
      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/v1/') && r.path !== '/api/v1/openapi.json')
      .map((r) => `${r.method} ${r.path}`)
    expect(registered.length).toBeGreaterThan(50)
    expect(registered.filter((r) => !documented.has(r))).toEqual([])
    for (const s of specs) {
      expect(['read', 'write', 'admin'], s.path).toContain(s.scope)
      expect(s.response || s.file || s.status === 204, `${s.method} ${s.path} needs a response`).toBeTruthy()
      // Reads never change anything, so they can't require more than `read`.
      if (s.method === 'get') expect(s.scope === 'read' || s.scope === 'admin', s.path).toBe(true)
    }
    const ids = specs.map((s) => s.summary)
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([])
  })

  it('serves the OpenAPI document and the docs page', async () => {
    const { app } = setup()
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as Json
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/ledgers/{ledger}/transactions'].post).toMatchObject({ operationId: 'createATransaction', 'x-scope': 'write' })
    expect(doc.components.schemas.Transaction.properties.externalId).toBeTruthy()
    expect(JSON.stringify(doc)).not.toContain('$defs')
    // A request sends a schema as it's written (fields with defaults are optional), a response returns all of it.
    const bodies = doc.paths['/ledgers/{ledger}/custom-reports'].post.requestBody.content['application/json'].schema
    expect(bodies.properties.spec).toEqual({ $ref: '#/components/schemas/ReportSpecInput' })
    expect(doc.components.schemas.ReportSpecInput.required ?? []).not.toContain('range')
    expect(doc.components.schemas.ReportSpec.required).toContain('range')
    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!)
    expect(refs.filter((n) => !doc.components.schemas[n])).toEqual([])
    const page = await app.request('/api/docs')
    expect(await page.text()).toContain('/api/v1/openapi.json')
  })

  it('returns what the response schemas say, with no undocumented fields', async () => {
    const { storage, call } = setup()
    startDemo(storage.registry.defaultContext())
    const { specs } = createApi(storage)
    const first = async (path: string) => {
      const body = (await call('GET', `/ledgers/personal${path}`)).body
      return (Array.isArray(body) ? body : (body.items ?? body.categories))[0].id as number
    }
    const ids: Record<string, number> = {
      accounts: await first('/accounts'),
      transactions: await first('/transactions'),
      categories: await first('/categories'),
      recurring: await first('/recurring'),
    }
    const query: Record<string, string> = { from: '2026-01-01', to: '2026-10-31' }

    let checked = 0
    for (const s of specs.filter((x) => x.method === 'get' && x.response)) {
      const path = s.path
        .replace(':ledger', 'personal')
        .replace(/\/(\w[\w-]*)\/:id/, (_m, resource: string) => `/${resource}/${ids[resource] ?? 1}`)
      const qs =
        path.includes('/reports/') && !/summary|trend|income|net-worth/.test(path)
          ? `?${new URLSearchParams(query)}`
          : path.endsWith('/payees/choice')
            ? '?payeeKey=loblaws'
            : ''
      const res = await call('GET', path + qs)
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200)
      const parsed = s.response!.safeParse(res.body)
      expect(parsed.success, `${path}: ${parsed.error?.message}`).toBe(true)
      expect(parsed.data, `${path} returns fields the schema doesn't list`).toEqual(res.body)
      checked++
    }
    expect(checked).toBeGreaterThan(25)
    // The demo's custom report is the one checked at /custom-reports/1.
    expect((await call('GET', '/ledgers/personal/custom-reports/1')).body).toMatchObject({ name: 'Everyday spending', missing: [] })
  })
})

describe('report filters', () => {
  it('takes a filter as JSON, and says what is wrong with one', async () => {
    const { storage, call } = setup()
    startDemo(storage.registry.defaultContext())
    const base = '/ledgers/personal/reports'
    const range = 'from=2026-01-01&to=2026-10-31'
    const bad = await call('GET', `${base}/period?${range}&filter=${encodeURIComponent('{oops')}`)
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain('filter')
    expect((await call('GET', `${base}/period?${range}&filter=${encodeURIComponent('{"spending":{"picked":[0]}}')}`)).status).toBe(400)

    const all = (await call('GET', `${base}/period?${range}`)).body
    const biggest = (await call('GET', `${base}/purchases?${range}&limit=3`)).body
    expect(biggest.items).toHaveLength(3)
    const filter = JSON.stringify({ spending: { picked: biggest.items.map((i: { transaction: { id: number } }) => i.transaction.id) } })
    const some = (await call('GET', `${base}/period?${range}&filter=${encodeURIComponent(filter)}`)).body
    expect(some.spentMinor + some.filteredOut.spending.amountMinor).toBe(all.spentMinor)
    const out = (await call('GET', `${base}/purchases?${range}&set=filtered-out&filter=${encodeURIComponent(filter)}`)).body
    expect(out).toMatchObject({ count: 3, totalMinor: some.filteredOut.spending.amountMinor })
    const listed = (await call('GET', `/ledgers/personal/transactions?${range}&filteredOut=1&filter=${encodeURIComponent(filter)}`)).body
    expect(listed.items.map((t: { id: number }) => t.id).sort()).toEqual(out.items.map((i: { transaction: { id: number } }) => i.transaction.id).sort())
  })

  it('searches payees by name, or looks up their keys', async () => {
    const { storage, call } = setup()
    startDemo(storage.registry.defaultContext())
    const found = (await call('GET', '/ledgers/personal/payees/search?q=lobl')).body
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((p: { payee: string }) => /loblaws/i.test(p.payee))).toBe(true)
    const keys = encodeURIComponent(JSON.stringify([found[0].payeeKey, 'no such payee']))
    expect((await call('GET', `/ledgers/personal/payees/search?keys=${keys}`)).body).toEqual([found[0]])
    expect((await call('GET', '/ledgers/personal/payees/search?keys=nope')).status).toBe(400)
  })
})

describe('API keys and scopes', () => {
  it('lets the web app in without a key unless a trusted header is required', async () => {
    let { call } = setup()
    expect((await call('GET', '/me')).body).toMatchObject({ kind: 'web', scopes: ['read', 'write', 'admin'] })

    ;({ call } = setup({ trustedHeader: 'Tailscale-User-Login' }))
    expect((await call('GET', '/ledgers')).status).toBe(401)
    expect((await call('GET', '/ledgers', undefined, { 'tailscale-user-login': 'me@example.com' })).status).toBe(200)
    // The spec stays public.
    const { app } = setup({ trustedHeader: 'Tailscale-User-Login' })
    expect((await app.request('/api/v1/openapi.json')).status).toBe(200)
  })

  it('accepts keys, shows them once, and rejects revoked, expired and made-up ones', async () => {
    const { call, storage } = setup({ trustedHeader: 'Tailscale-User-Login' })
    const web = { 'tailscale-user-login': 'me@example.com' }
    const res = await call('POST', '/api-keys', { name: 'Agent', scopes: ['write'] }, web)
    const created = res.body as ApiKeyCreated
    expect(created.key).toMatch(/^cm_[0-9A-Za-z]{43}$/)
    expect(created.scopes).toEqual(['read', 'write'])
    const auth = { authorization: `Bearer ${created.key}` }
    expect((await call('GET', '/me', undefined, auth)).body).toMatchObject({ actor: 'Agent', kind: 'key', defaultLedger: 'personal' })

    const listed = (await call('GET', '/api-keys', undefined, web)).body
    expect(listed[0]).toMatchObject({ name: 'Agent', prefix: created.key.slice(0, 9), lastUsedAt: expect.any(String) })
    expect(JSON.stringify(listed)).not.toContain(created.key)

    expect((await call('GET', '/me', undefined, { authorization: 'Bearer cm_nope' })).status).toBe(401)
    expect((await call('GET', '/me', undefined, { authorization: created.key })).status).toBe(401)

    expect((await call('DELETE', `/api-keys/${created.id}`, undefined, web)).status).toBe(204)
    expect((await call('GET', '/me', undefined, auth)).status).toBe(401)

    const expiring = (await call('POST', '/api-keys', { name: 'Short', scopes: ['read'], expiresInDays: 1 }, web)).body as ApiKeyCreated
    storage.now = () => new Date('2026-10-06T00:00:00Z')
    expect(
      (await createApp(storage, { trustedHeader: null }).request('/api/v1/me', { headers: { authorization: `Bearer ${expiring.key}` } })).status,
    ).toBe(401)
  })

  it('enforces read, write and admin scopes', async () => {
    const { call, key, storage } = setup()
    const acc = makeAccount(storage.registry.defaultContext())
    const read = await key({ scopes: ['read'] })
    const write = await key({ scopes: ['write'] })
    const admin = await key({ scopes: ['admin'] })
    const newTx = { accountId: acc, date: '2026-10-01', amountMinor: -500, payee: 'Coffee' }

    expect((await call('GET', '/ledgers/personal/transactions', undefined, read.auth)).status).toBe(200)
    const denied = await call('POST', '/ledgers/personal/transactions', newTx, read.auth)
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatchObject({ code: 'forbidden', message: expect.stringContaining('“write”') })

    expect((await call('POST', '/ledgers/personal/transactions', newTx, write.auth)).status).toBe(201)
    expect((await call('PATCH', '/settings', { firstDayOfWeek: 1 }, write.auth)).status).toBe(403)
    expect((await call('GET', '/api-keys', undefined, write.auth)).status).toBe(403)
    expect((await call('POST', '/ledgers', { name: 'Family' }, write.auth)).status).toBe(403)

    expect((await call('PATCH', '/settings', { firstDayOfWeek: 1 }, admin.auth)).status).toBe(200)
    expect((await call('POST', '/ledgers', { name: 'Family' }, admin.auth)).status).toBe(201)
  })

  it('remembers the transactions column order for the whole app', async () => {
    const { call, storage } = setup()
    const columns = async () => (await call('GET', '/settings')).body.transactionColumns
    expect(await columns()).toEqual(['date', 'payee', 'notes', 'category', 'account', 'amount', 'balance'])
    // Columns left out keep their default order at the end.
    expect((await call('PATCH', '/settings', { transactionColumns: ['amount', 'date', 'notes'] })).body.transactionColumns).toEqual([
      'amount',
      'date',
      'notes',
      'payee',
      'category',
      'account',
      'balance',
    ])
    expect(await columns()).toEqual(['amount', 'date', 'notes', 'payee', 'category', 'account', 'balance'])
    // A column added since an order was saved goes after the one before it by default, and one that's
    // gone since (Name) drops out.
    setAppSetting(storage.app, 'transactionColumns', ['amount', 'date', 'payee', 'name', 'category', 'account', 'balance'])
    expect(await columns()).toEqual(['amount', 'date', 'payee', 'notes', 'category', 'account', 'balance'])
    expect((await call('PATCH', '/settings', { transactionColumns: ['date', 'date'] })).status).toBe(400)
    expect((await call('PATCH', '/settings', { transactionColumns: ['running-total'] })).status).toBe(400)
    await call('PATCH', '/settings', { transactionColumns: null })
    expect(await columns()).toEqual(['date', 'payee', 'notes', 'category', 'account', 'amount', 'balance'])

    // Widths too: only the ones you set, within limits. A gone column's drops out.
    setAppSetting(storage.app, 'transactionColumnWidths', { name: 200, payee: 300 })
    expect((await call('GET', '/settings')).body.transactionColumnWidths).toEqual({ payee: 300 })
    setAppSetting(storage.app, 'transactionColumnWidths', {})
    expect((await call('GET', '/settings')).body.transactionColumnWidths).toEqual({})
    expect((await call('PATCH', '/settings', { transactionColumnWidths: { payee: 280, notes: 160 } })).body.transactionColumnWidths).toEqual({ payee: 280, notes: 160 })
    expect((await call('PATCH', '/settings', { transactionColumnWidths: { payee: 10 } })).status).toBe(400)
    expect((await call('PATCH', '/settings', { transactionColumnWidths: { 'running-total': 100 } })).status).toBe(400)
    expect((await call('PATCH', '/settings', { transactionColumnWidths: null })).body.transactionColumnWidths).toEqual({})

    // And the sidebar's width.
    expect((await call('GET', '/settings')).body.sidebarWidth).toBe(240)
    expect((await call('PATCH', '/settings', { sidebarWidth: 300 })).body.sidebarWidth).toBe(300)
    expect((await call('PATCH', '/settings', { sidebarWidth: 1000 })).status).toBe(400)
    expect((await call('PATCH', '/settings', { sidebarWidth: null })).body.sidebarWidth).toBe(240)

    // And the custom colours you picked, once each.
    expect((await call('GET', '/settings')).body.customColors).toEqual([])
    expect((await call('PATCH', '/settings', { customColors: ['#ABCDEF', '#123456', '#abcdef'] })).body.customColors).toEqual(['#abcdef', '#123456'])
    expect((await call('PATCH', '/settings', { customColors: ['blue'] })).status).toBe(400)
    expect((await call('PATCH', '/settings', { customColors: null })).body.customColors).toEqual([])
  })

  it('keeps a key to its ledgers', async () => {
    const { call, key, storage } = setup()
    const family = storage.registry.create({ name: 'Family' })
    const k = await key({ scopes: ['write'], ledgers: ['family'] })
    expect(k.ledgers).toEqual([family.id])

    expect((await call('GET', '/ledgers', undefined, k.auth)).body.map((l: Json) => l.slug)).toEqual(['family'])
    expect((await call('GET', '/me', undefined, k.auth)).body.defaultLedger).toBe('family')
    expect((await call('GET', '/ledgers/family/accounts', undefined, k.auth)).status).toBe(200)
    expect((await call('GET', `/ledgers/${family.id}/accounts`, undefined, k.auth)).status).toBe(200)
    expect((await call('GET', '/ledgers/personal/accounts', undefined, k.auth)).status).toBe(403)
    expect((await call('GET', '/ledgers/personal', undefined, k.auth)).status).toBe(403)
  })
})

describe('safe retries and bulk changes', () => {
  it('replays a POST with the same Idempotency-Key instead of repeating it', async () => {
    const { call, key, storage } = setup()
    const ctx = storage.registry.defaultContext()
    const acc = makeAccount(ctx)
    const body = { accountId: acc, date: '2026-10-01', amountMinor: -1234, payee: 'Loblaws' }
    const headers = { 'idempotency-key': 'abc-123' }

    const first = await call('POST', '/ledgers/personal/transactions', body, headers)
    const again = await call('POST', '/ledgers/personal/transactions', body, headers)
    expect(first.status).toBe(201)
    expect(again.status).toBe(201)
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    expect(again.body.id).toBe(first.body.id)
    expect(setupStatus(ctx).transactions).toBe(1)

    const reused = await call('POST', '/ledgers/personal/transactions', { ...body, amountMinor: -1 }, headers)
    expect(reused.status).toBe(409)
    expect(reused.body.error.code).toBe('conflict')

    // Keys are per caller, and failed requests aren't remembered.
    const agent = await key({ scopes: ['write'] })
    expect((await call('POST', '/ledgers/personal/transactions', body, { ...headers, ...agent.auth })).status).toBe(201)
    expect((await call('POST', '/ledgers/personal/transactions', { ...body, accountId: 999 }, { 'idempotency-key': 'k2' })).status).toBe(400)
    expect((await call('POST', '/ledgers/personal/transactions', body, { 'idempotency-key': 'k2' })).status).toBe(201)
    expect(setupStatus(ctx).transactions).toBe(3)
  })

  it('adds a transaction with an externalId only once per account', async () => {
    const { call, storage } = setup()
    const ctx = storage.registry.defaultContext()
    const acc = makeAccount(ctx)
    const other = makeAccount(ctx, 'Visa', 'credit')
    const body = { accountId: acc, date: '2026-10-01', amountMinor: -1234, payee: 'Loblaws', externalId: 'bank-1' }

    const first = await call('POST', '/ledgers/personal/transactions', body)
    const again = await call('POST', '/ledgers/personal/transactions', { ...body, amountMinor: -9999 })
    expect([first.status, again.status]).toEqual([201, 200])
    expect(again.body).toMatchObject({ id: first.body.id, amountMinor: -1234, externalId: 'bank-1' })
    expect((await call('POST', '/ledgers/personal/transactions', { ...body, accountId: other })).status).toBe(201)

    // Imports skip rows whose externalId the account already has, deleted ones included.
    const row = (line: number, externalId: string, payee = 'Coffee') => ({ line, date: '2026-10-02', payee, amountMinor: -450, externalId })
    const imported = await call('POST', '/ledgers/personal/import/commit', { accountId: acc, rows: [row(1, 'bank-1', 'Loblaws'), row(2, 'bank-2'), row(3, 'bank-3')] })
    expect(imported.body).toMatchObject({ imported: 2, skippedDuplicates: 1 })
    await call('DELETE', `/ledgers/personal/transactions/${first.body.id}`)
    expect((await call('POST', '/ledgers/personal/import/commit', { accountId: acc, rows: [row(1, 'bank-1', 'Loblaws')] })).body.imported).toBe(0)
    const deleted = await call('POST', '/ledgers/personal/transactions', body)
    expect(deleted.status).toBe(409)
  })

  it('reports bulk changes and rolls them back on a dry run', async () => {
    const { call, storage } = setup()
    const ctx = storage.registry.defaultContext()
    const acc = makeAccount(ctx)
    const ids: number[] = []
    for (const payee of ['Uber', 'Uber', 'Lyft']) {
      ids.push((await call('POST', '/ledgers/personal/transactions', { accountId: acc, date: '2026-10-01', amountMinor: -1500, payee })).body.id)
    }
    const transport = categoryId(ctx, 'Taxi')
    const request = { ids, categoryId: transport, addTags: ['work'] }

    const dry = (await call('POST', '/ledgers/personal/transactions/bulk?dryRun=true', request)).body as BulkResult
    expect(dry).toMatchObject({ dryRun: true, updated: 3 })
    expect(dry.changes[0]).toMatchObject({ before: { categoryId: null, tags: [] }, after: { categoryId: transport } })
    const untouched = (await call('GET', `/ledgers/personal/transactions/${ids[0]}`)).body as Transaction
    expect([untouched.categoryId, untouched.tags]).toEqual([null, []])
    expect((await call('GET', '/ledgers/personal/activity')).body.items.map((a: Json) => a.action)).not.toContain('bulk_update')

    const real = (await call('POST', '/ledgers/personal/transactions/bulk', request)).body as BulkResult
    expect(real).toMatchObject({ dryRun: false, updated: 3 })
    expect((await call('GET', `/ledgers/personal/transactions/${ids[0]}`)).body.categoryId).toBe(transport)

    const dryImport = await call('POST', '/ledgers/personal/import/commit?dryRun=true', {
      accountId: acc,
      rows: [{ line: 1, date: '2026-10-05', payee: 'Metro', amountMinor: -2000 }],
    })
    expect(dryImport.body).toMatchObject({ dryRun: true, imported: 1, batchId: null })
    expect(setupStatus(ctx).transactions).toBe(3)
  })
})

describe('activity log', () => {
  it('records who changed what, with before and after', async () => {
    const { call, key, storage } = setup()
    const acc = makeAccount(storage.registry.defaultContext())
    const agent = await key({ name: 'Budget bot', scopes: ['write'] })
    const tx = (await call('POST', '/ledgers/personal/transactions', { accountId: acc, date: '2026-10-01', amountMinor: -8432, payee: 'Costco' })).body
    await call('PATCH', `/ledgers/personal/transactions/${tx.id}`, { notes: 'Bulk buy' }, agent.auth)
    await call('PATCH', `/ledgers/personal/transactions/${tx.id}`, { notes: 'Bulk buy' }, agent.auth) // no change, no entry

    const all = (await call('GET', '/ledgers/personal/activity')).body
    expect(all.items.map((a: Json) => [a.actor, a.action, a.summary])).toEqual([
      ['Budget bot', 'update', 'Edited Costco -$84.32 on 2026-10-01'],
      ['web', 'create', 'Added Costco -$84.32 on 2026-10-01'],
    ])
    expect(all.items[0]).toMatchObject({ entity: 'transaction', entityId: String(tx.id), before: { notes: null }, after: { notes: 'Bulk buy' } })

    const mine = (await call('GET', '/ledgers/personal/activity?actor=Budget%20bot')).body
    expect(mine.items).toHaveLength(1)
    expect((await call('GET', '/ledgers/personal/activity/actors')).body.sort()).toEqual(['Budget bot', 'web'])

    const page = (await call('GET', '/ledgers/personal/activity?limit=1')).body
    expect(page.nextCursor).toBeTruthy()
    expect((await call('GET', `/ledgers/personal/activity?limit=1&cursor=${page.nextCursor}`)).body.items[0].action).toBe('create')
  })

  it('keeps the log when the ledger is erased', async () => {
    const { call, storage } = setup()
    makeAccount(storage.registry.defaultContext())
    await call('POST', '/ledgers/personal/erase', { confirm: 'erase' })
    const items = (await call('GET', '/ledgers/personal/activity')).body.items
    expect(items[0]).toMatchObject({ action: 'erase', summary: 'Erased all data' })
  })
})

describe('reordering', () => {
  it('sets the order of accounts and categories', async () => {
    const { call, storage } = setup()
    const ctx = storage.registry.defaultContext()
    const a = makeAccount(ctx, 'A')
    const b = makeAccount(ctx, 'B')
    const c = makeAccount(ctx, 'C')
    const res = await call('POST', '/ledgers/personal/accounts/reorder', { ids: [c, a] })
    expect(res.body.map((x: Json) => x.name)).toEqual(['C', 'A', 'B'])
    expect((await call('POST', '/ledgers/personal/accounts/reorder', { ids: [999] })).status).toBe(404)
    expect(b).toBeGreaterThan(a)
  })
})

describe('two ledgers', () => {
  const tags = (ctx: AppContext) => ctx.q.column<string>('SELECT name FROM tags WHERE ledger_id = @ledger ORDER BY name')
  const addTag = (ctx: AppContext, name: string) => ctx.q.run('INSERT INTO tags (ledger_id, name) VALUES (@ledger, @name)', { name })

  function twoLedgers() {
    const s = setup()
    const personal = s.storage.registry.defaultContext()
    const family = testLedger(s.storage)
    return { ...s, personal, family }
  }

  it('keeps each ledger’s routes to its own rows, and another ledger’s ids are not found', async () => {
    const { call, personal, family } = twoLedgers()
    const add = async (ctx: AppContext) => {
      const body = { accountId: makeAccount(ctx), date: '2026-10-01', amountMinor: -1234, payee: 'Costco' }
      const res = await call('POST', `/ledgers/${ctx.ledger.slug}/transactions`, body)
      expect(res.status).toBe(201)
      return res.body.id as number
    }
    const mine = await add(personal)
    const theirs = await add(family)
    expect(mine).not.toBe(theirs)
    expect((await call('GET', '/ledgers/family/transactions')).body.items.map((t: Json) => t.id)).toEqual([theirs])
    expect((await call('GET', '/ledgers/personal/transactions')).body.items.map((t: Json) => t.id)).toEqual([mine])

    const missing = await call('GET', '/ledgers/family/transactions/999999')
    expect(missing.status).toBe(404)
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { notes: 'Not yours' }],
      ['DELETE', undefined],
    ] as const) {
      const res = await call(method, `/ledgers/family/transactions/${mine}`, body)
      expect([method, res.status, res.body.error]).toEqual([method, 404, missing.body.error])
    }
    // Bulk changes skip ids they don't find.
    const bulk = await call('POST', '/ledgers/family/transactions/bulk', { ids: [mine], addTags: ['work'] })
    expect([bulk.status, bulk.body.updated]).toEqual([200, 0])
    expect((await call('GET', `/ledgers/personal/transactions/${mine}`)).body).toMatchObject({ id: mine, notes: null, tags: [] })
  })

  it('rolls back a dry run in every ledger and in the app-wide tables', () => {
    const { storage, personal, family } = twoLedgers()
    const out = withDryRun(storage.sqlite, () => {
      addTag(personal, 'gone')
      addTag(family, 'gone')
      setAppSetting(storage.app, 'dry', true)
      return 'ran'
    })
    expect(out).toBe('ran')
    expect([tags(personal), tags(family), getAppSetting(storage.app, 'dry', null)]).toEqual([[], [], null])

    // In an open transaction, only what the dry run did.
    personal.q.transaction(() => {
      addTag(personal, 'kept')
      withDryRun(storage.sqlite, () => addTag(family, 'gone'))
    })
    expect([tags(personal), tags(family)]).toEqual([['kept'], []])

    // A handler that fails is rolled back too, and its error comes through.
    expect(() =>
      withDryRun(storage.sqlite, () => {
        addTag(family, 'gone')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(tags(family)).toEqual([])
  })

  it('treats an Idempotency-Key sent to another ledger as a different request', async () => {
    const { call, personal, family } = twoLedgers()
    const headers = { 'idempotency-key': 'same-key' }
    expect((await call('POST', '/ledgers/personal/tags', { name: 'trip' }, headers)).status).toBe(201)
    const other = await call('POST', '/ledgers/family/tags', { name: 'trip' }, headers)
    expect([other.status, other.body.error.code]).toEqual([409, 'conflict'])
    expect([tags(personal), tags(family)]).toEqual([['trip'], []])
  })

  it('counts each ledger’s AI calls in its own usage, and only the usable ones app-wide', async () => {
    const { call, key, personal, family } = twoLedgers()
    const aiCall = (ctx: AppContext, model: string, tokens: number, at: string) =>
      ctx.q.run(
        `INSERT INTO ai_calls (ledger_id, created_at, slot, model, latency_ms, ok, input_tokens, output_tokens)
         VALUES (@ledger, @at, 'primary', @model, 10, 1, @tokens, 1)`,
        { model, tokens, at },
      )
    aiCall(personal, 'p1', 100, '2026-10-01T10:00:00Z')
    aiCall(personal, 'p2', 100, '2026-10-01T12:00:00Z')
    aiCall(family, 'f1', 7, '2026-10-01T11:00:00Z')

    const mine = (await call('GET', '/ledgers/family/ai/usage')).body
    expect(mine).toMatchObject({ calls: 1, inputTokens: 7 })
    expect(mine.recent.map((r: Json) => r.model)).toEqual(['f1'])

    const all = (await call('GET', '/ai/usage')).body
    expect(all).toMatchObject({ calls: 3, inputTokens: 207 })
    expect(all.recent.map((r: Json) => [r.model, r.ledger])).toEqual([
      ['p2', 'Personal'],
      ['f1', 'Family'],
      ['p1', 'Personal'],
    ])
    const limited = await key({ scopes: ['read'], ledgers: ['family'] })
    const theirs = (await call('GET', '/ai/usage', undefined, limited.auth)).body
    expect(theirs).toMatchObject({ calls: 1, inputTokens: 7 })
    expect(theirs.recent.map((r: Json) => r.ledger)).toEqual(['Family'])
  })
})

it('builds OpenAPI paths from Hono paths', () => {
  expect(openApiPath('/ledgers/:ledger/accounts/:id/snapshots/:snapshotId')).toBe('/ledgers/{ledger}/accounts/{id}/snapshots/{snapshotId}')
})
