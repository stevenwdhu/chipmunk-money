import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Account, ActivityPage, ApiKeyCreated, BankConnection, Institution, Settings, SyncResult, TransactionPage } from '@st/shared'
import { createApp } from '../../app'
import { SecretBox } from '../../lib/secrets'
import { categoryId, makeAccount, testStorage } from '../../test/helpers'
import { createTransaction } from '../transactions'
import { decimalToMinor, sanitize } from './simplefin'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

// A fake SimpleFIN Bridge --------------------------------------------------------

interface FakeTx {
  id: string
  posted: number
  amount: string
  description: string
  payee?: string
  transacted_at?: number
  pending?: boolean
}
interface FakeAccount {
  id: string
  name: string
  balance: string
  currency?: string
  transactions: FakeTx[]
}

const at = (date: string) => Math.floor(Date.parse(`${date}T16:00:00Z`) / 1000)
const tx = (id: string, date: string, amount: string, payee: string, extra: Partial<FakeTx> = {}): FakeTx => ({
  id,
  posted: at(date),
  transacted_at: at(date),
  amount,
  description: payee.toUpperCase(),
  payee,
  ...extra,
})

function fakeBridge() {
  const state = {
    claimed: new Set<string>(),
    accounts: [] as FakeAccount[],
    errlist: [] as Array<{ code: string; msg: string; conn_id?: string; account_id?: string }>,
    status: 200,
    requests: [] as URL[],
  }
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const claim = /\/simplefin\/claim\/(\w+)$/.exec(url.pathname)
    if (claim && init?.method === 'POST') {
      if (state.claimed.has(claim[1]!)) return new Response('', { status: 403 })
      state.claimed.add(claim[1]!)
      return new Response('https://user%40x:s3cret@bridge.test/simplefin')
    }
    if (url.pathname === '/simplefin/accounts') {
      state.requests.push(url)
      const auth = new Headers(init?.headers).get('authorization')
      if (auth !== `Basic ${Buffer.from('user@x:s3cret').toString('base64')}`) return new Response('', { status: 403 })
      if (state.status !== 200) return new Response('', { status: state.status })
      const start = Number(url.searchParams.get('start-date') ?? 0)
      const end = Number(url.searchParams.get('end-date') ?? Infinity)
      const balancesOnly = url.searchParams.get('balances-only') === '1'
      return Response.json({
        errlist: state.errlist,
        connections: [{ conn_id: 'CON-1', name: 'TD - Me', org_name: 'TD Canada Trust', org_id: 'td', sfin_url: 'https://bridge.test/simplefin' }],
        accounts: state.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          conn_id: 'CON-1',
          currency: a.currency ?? 'CAD',
          balance: a.balance,
          'balance-date': at('2026-10-03'),
          transactions: balancesOnly ? undefined : a.transactions.filter((t) => (t.transacted_at ?? t.posted) >= start && (t.transacted_at ?? t.posted) < end),
        })),
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { state, fetch: fakeFetch }
}

const token = (code = 'TOKEN1') => Buffer.from(`https://bridge.test/simplefin/claim/${code}`).toString('base64')

async function setup() {
  const bridge = fakeBridge()
  bridge.state.accounts = [
    { id: 'chq', name: 'Chequing', balance: '1500.00', transactions: [] },
    { id: 'visa', name: 'Visa', balance: '-240.10', transactions: [] },
    { id: 'tfsa', name: 'TFSA', balance: '10250.75', transactions: [] },
  ]
  const storage = testStorage({ fetch: bridge.fetch })
  const app = createApp(storage, { trustedHeader: null })
  const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${url}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  const ctx = storage.registry.defaultContext()
  const connect = async () => (await api('POST', '/bank/connections', { setupToken: token() })).body as BankConnection
  const remote = (conn: BankConnection, id: string) => conn.accounts.find((a) => a.remoteId === id)!
  const sync = async (id: string) => (await api('POST', `/bank/connections/${id}/sync`)).body as SyncResult
  /** Switches a ledger account to synced from a bank account. */
  const link = (accountId: number, bankAccountId: string, syncFrom?: string) =>
    api('PUT', `/ledgers/personal/accounts/${accountId}/bank`, { bankAccountId, ...(syncFrom ? { syncFrom } : {}) })
  const transactions = async () => ((await api('GET', '/ledgers/personal/transactions?limit=500')).body as TransactionPage).items
  return { bridge, storage, app, api, ctx, connect, remote, sync, link, transactions }
}

describe('SimpleFIN helpers', () => {
  it('turns amounts into cents exactly', () => {
    expect([decimalToMinor('-12.34'), decimalToMinor('100'), decimalToMinor('0.005'), decimalToMinor('-1.999'), decimalToMinor('+3.1')]).toEqual([
      -1234, 10000, 1, -200, 310,
    ])
    expect(() => decimalToMinor('abc')).toThrow()
  })

  it('cleans provider text before showing it', () => {
    expect(sanitize('<b>Sign in</b>\n again\u0007')).toBe('Sign in again')
  })

  it('encrypts secrets with a key kept beside the data', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'st-secret-'))
    try {
      const box = SecretBox.forDataDir(dir)
      const sealed = box.seal('https://u:p@bridge.test/simplefin')
      expect(sealed).not.toContain('bridge.test')
      expect(SecretBox.forDataDir(dir).open(sealed)).toBe('https://u:p@bridge.test/simplefin')
      expect(statSync(path.join(dir, 'secret.key')).mode & 0o777).toBe(0o600)
      expect(readFileSync(path.join(dir, 'secret.key'), 'utf8').length).toBeGreaterThan(40)
      expect(() => SecretBox.forDataDir(null).open(sealed)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bank connections', () => {

  it('claims a setup token once, stores the access encrypted and lists the accounts', async () => {
    const { connect, storage, api, bridge } = await setup()
    const conn = await connect()
    expect(conn).toMatchObject({ provider: 'simplefin', name: 'SimpleFIN Bridge', status: 'ok', requestsLast24h: 1 })
    expect(conn.accounts.map((a) => [a.name, a.institution, a.balanceMinor, a.link])).toEqual([
      ['Chequing', 'TD Canada Trust', 150000, null],
      ['Visa', 'TD Canada Trust', -24010, null],
      ['TFSA', 'TD Canada Trust', 1025075, null],
    ])
    // Discovering accounts only asks for balances.
    expect(bridge.state.requests[0]!.searchParams.get('balances-only')).toBe('1')
    const stored = storage.meta.sqlite.prepare('SELECT secret FROM bank_connections').get() as { secret: string }
    expect(stored.secret).not.toMatch(/s3cret|bridge/)

    const again = await api('POST', '/bank/connections', { setupToken: token() })
    expect(again.status).toBe(400)
    expect(again.body.error.message).toMatch(/already used/)
    const http = await api('POST', '/bank/connections', { setupToken: Buffer.from('http://bridge.test/simplefin/claim/X').toString('base64') })
    expect(http.body.error.message).toMatch(/HTTPS/)
  })

  it('syncs transactions into a linked account without duplicates, keeping your edits', async () => {
    const { connect, remote, link, api, sync, transactions, ctx, bridge } = await setup()
    const chequing = makeAccount(ctx, 'TD Chequing')
    // History: "Loblaws" is groceries.
    await createTransaction(ctx, { accountId: chequing, date: '2026-08-01', amountMinor: -5000, payee: 'Loblaws', categoryId: categoryId(ctx, 'Groceries'), notes: null, tags: [], status: 'cleared', transferAccountId: null })
    bridge.state.accounts[0]!.transactions = [
      tx('t1', '2026-09-28', '-45.67', 'Loblaws'),
      tx('t2', '2026-10-01', '2500.00', 'Payroll'),
      tx('t3', '2026-08-20', '-9.99', 'Too old'),
    ]
    const conn = await connect()
    const linked = await link(chequing, remote(conn, 'chq').id, '2026-09-01')
    expect((linked.body as Account).bank).toMatchObject({ name: 'Chequing', institution: 'TD Canada Trust', lastSyncedAt: null })
    expect(remote((await api('GET', '/bank/connections')).body[0], 'chq').link).toMatchObject({ ledgerSlug: 'personal', accountId: chequing, accountName: 'TD Chequing' })

    const first = await sync(conn.id)
    expect(first.accounts).toEqual([expect.objectContaining({ accountName: 'TD Chequing', added: 2, updated: 0, adopted: 0, removed: 0, error: null })])
    let txs = (await transactions()).filter((t) => t.origin === 'sync')
    expect(txs.map((t) => [t.payee, t.amountMinor, t.externalId])).toEqual([
      ['Payroll', 250000, 't2'],
      ['Loblaws', -4567, 't1'],
    ])
    // Categorized from history.
    expect(txs[1]!.categoryId).toBe(categoryId(ctx, 'Groceries'))

    // The bank's payee isn't yours to change. You call the payee something and add a note, and the bank
    // later corrects the amount.
    expect((await api('PATCH', `/ledgers/personal/transactions/${txs[1]!.id}`, { payee: 'Loblaws groceries' })).status).toBe(400)
    await api('POST', '/ledgers/personal/payees/rename', { payee: txs[1]!.payee, name: 'Loblaws groceries' })
    await api('PATCH', `/ledgers/personal/transactions/${txs[1]!.id}`, { notes: 'weekly shop' })
    bridge.state.accounts[0]!.transactions[0]!.amount = '-46.67'
    const second = await sync(conn.id)
    expect(second.accounts[0]).toMatchObject({ added: 0, updated: 1 })
    txs = (await transactions()).filter((t) => t.origin === 'sync')
    expect(txs).toHaveLength(2)
    expect(txs[1]).toMatchObject({ payee: 'Loblaws', payeeName: 'Loblaws groceries', notes: 'weekly shop', amountMinor: -4667 })

    // Deleted transactions stay deleted.
    await api('DELETE', `/ledgers/personal/transactions/${txs[0]!.id}`)
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 0 })

    // SimpleFIN's own data is kept: once, and again only when it changed (it's sent every sync).
    // What the bank last sent for it, as it sent it.
    const kept = (await api('GET', `/ledgers/personal/transactions/${txs[1]!.id}/bank-data`)).body as { event: string; provider: string; payload: { amount: string } }
    expect([kept.event, kept.provider, kept.payload.amount]).toEqual(['changed', 'simplefin', '-46.67'])

    // The account shows where it syncs from, and Activity has an entry per sync.
    const account = (await api('GET', `/ledgers/personal/accounts/${chequing}`)).body as Account
    expect(account.bank).toMatchObject({ provider: 'simplefin', institution: 'TD Canada Trust', name: 'Chequing', balanceMinor: 150000 })
    const activity = (await api('GET', '/ledgers/personal/activity?actor=SimpleFIN%20sync')).body as ActivityPage
    expect(activity.items.map((a) => a.summary)).toEqual([
      'Synced TD Chequing from TD Canada Trust: 1 updated',
      'Synced TD Chequing from TD Canada Trust: 2 new',
    ])
  })

  it('turns pending into posted, removes vanished pending, and adopts what you entered', async () => {
    const { connect, remote, link, api, sync, transactions, ctx, bridge } = await setup()
    const visa = makeAccount(ctx, 'TD Visa', 'credit')
    // Entered by hand before linking: the bank's copy should be adopted, not added.
    await createTransaction(ctx, { accountId: visa, date: '2026-09-30', amountMinor: -1250, payee: 'Tim Hortons', categoryId: null, notes: null, tags: [], status: 'cleared', transferAccountId: null })
    bridge.state.accounts[1]!.transactions = [
      tx('p1', '2026-10-02', '-30.00', 'Shell', { pending: true }),
      tx('p2', '2026-10-02', '-5.00', 'Hold', { pending: true }),
      tx('b1', '2026-10-01', '-12.50', 'TIM HORTONS #123'),
    ]
    const conn = await connect()
    await link(visa, remote(conn, 'visa').id, '2026-09-15')
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 2, adopted: 1 })

    let txs = await transactions()
    expect(txs.find((t) => t.payee === 'Tim Hortons')).toMatchObject({ externalId: 'b1', origin: 'manual' })
    const shell = txs.find((t) => t.payee === 'Shell')!
    expect(shell.status).toBe('pending')
    await api('PATCH', `/ledgers/personal/transactions/${shell.id}`, { notes: 'road trip' })

    // Next day: the gas posts under a new id for a slightly different amount; the hold disappears.
    bridge.state.accounts[1]!.transactions = [tx('s1', '2026-10-03', '-31.25', 'Shell'), tx('b1', '2026-10-01', '-12.50', 'TIM HORTONS #123')]
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 0, updated: 1, removed: 1 })
    txs = await transactions()
    expect(txs.filter((t) => t.payee === 'Shell')).toEqual([
      expect.objectContaining({ id: shell.id, status: 'cleared', amountMinor: -3125, externalId: 's1', notes: 'road trip' }),
    ])
    expect(txs.some((t) => t.payee === 'Hold')).toBe(false)

    // The provider re-issues an id for a posted transaction: still one transaction.
    bridge.state.accounts[1]!.transactions = [tx('s1-new', '2026-10-03', '-31.25', 'Shell'), tx('b1', '2026-10-01', '-12.50', 'TIM HORTONS #123')]
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 0, updated: 1, removed: 0 })
    expect((await transactions()).filter((t) => t.payee === 'Shell')).toEqual([expect.objectContaining({ id: shell.id, externalId: 's1-new' })])
  })

  it('leaves older transactions alone when another account needs a longer window', async () => {
    const { connect, remote, link, api, sync, transactions, ctx, bridge } = await setup()
    bridge.state.accounts[0]!.transactions = [tx('old', '2026-09-01', '-20.00', 'Bakery'), tx('new', '2026-10-02', '-8.00', 'Cafe')]
    const conn = await connect()
    await link(makeAccount(ctx, 'Chq'), remote(conn, 'chq').id, '2026-08-25')
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 2 })

    // The provider re-issues the old one's id, and a second account is linked with history from August.
    bridge.state.accounts[0]!.transactions[0]!.id = 'old-reissued'
    await link(makeAccount(ctx, 'Visa', 'credit'), remote(conn, 'visa').id, '2026-08-01')
    const r = await sync(conn.id)
    expect(r.accounts.find((a) => a.accountName === 'Chq')).toMatchObject({ added: 0 })
    expect((await transactions()).filter((t) => t.payee === 'Bakery')).toHaveLength(1)
  })

  it('keeps a synced account’s balance at the bank’s, and only a manual one’s can be set by hand', async () => {
    const { connect, remote, link, api, sync, bridge, ctx } = await setup()
    bridge.state.accounts[0]!.transactions = [tx('a', '2026-09-20', '-100.00', 'Rent share')]
    const conn = await connect()
    // An account you kept by hand, with a starting balance that doesn't add up to the bank's.
    const chequing = makeAccount(ctx, 'TD Chequing', 'chequing', 20_000)
    await link(chequing, remote(conn, 'chq').id, '2026-09-01')
    await sync(conn.id)
    const balance = async () => ((await api('GET', `/ledgers/personal/accounts/${chequing}`)).body as Account).balanceMinor
    expect(await balance()).toBe(150000)

    // What changes the bank's data here is matched again at the next sync.
    bridge.state.accounts[0]!.transactions.push(tx('b', '2026-10-01', '-25.00', 'Coffee'))
    bridge.state.accounts[0]!.balance = '1475.00'
    await sync(conn.id)
    expect(await balance()).toBe(147500)

    // Its balance can't be set by hand while it syncs.
    const refused = await api('POST', `/ledgers/personal/accounts/${chequing}/balance`, { date: '2026-10-02', balanceMinor: 99 })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/syncs from TD Canada Trust, so its balance is the bank’s/)
    expect((await api('PATCH', `/ledgers/personal/accounts/${chequing}`, { openingBalanceMinor: 1 })).status).toBe(409)
    // Other edits are fine; and once it's manual, so is the balance.
    expect((await api('PATCH', `/ledgers/personal/accounts/${chequing}`, { name: 'Chequing' })).status).toBe(200)
    await api('DELETE', `/ledgers/personal/accounts/${chequing}/bank`)
    expect((await api('POST', `/ledgers/personal/accounts/${chequing}/balance`, { date: '2026-10-02', balanceMinor: 99 })).status).toBe(200)
  })

  it('creates a new account that matches the bank balance, and records an investment’s with its money in and out', async () => {
    const { connect, remote, link, api, sync, bridge, ctx } = await setup()
    bridge.state.accounts[0]!.transactions = [tx('a', '2026-09-20', '-100.00', 'Rent share'), tx('b', '2026-09-25', '-50.00', 'Hydro')]
    const conn = await connect()
    // A new account that's synced from the start.
    const created = (await api('POST', '/ledgers/personal/accounts', { name: 'Everyday chequing', type: 'chequing', bank: { bankAccountId: remote(conn, 'chq').id } })).body as Account
    expect(created.bank).toMatchObject({ name: 'Chequing' })
    // An empty account takes all the history there is: no date before which it's left out.
    expect(remote((await api('GET', '/bank/connections')).body[0], 'chq').syncFrom).toBeNull()

    const tfsa = makeAccount(ctx, 'TFSA', 'investment')
    await link(tfsa, remote(conn, 'tfsa').id)
    bridge.state.accounts[2]!.transactions = [tx('in', '2026-09-30', '500.00', 'Contribution')]
    await sync(conn.id)

    const accounts = (await api('GET', '/ledgers/personal/accounts')).body as Account[]
    expect(accounts.find((a) => a.id === created.id)).toMatchObject({ balanceMinor: 150000, transactionCount: 2, institution: 'TD Canada Trust' })
    // One request, never more than SimpleFIN's 90 days.
    const last = bridge.state.requests[bridge.state.requests.length - 1]!
    expect(Number(last.searchParams.get('end-date')) - Number(last.searchParams.get('start-date'))).toBeLessThanOrEqual(90 * 86400)
    // An investment's value moves on its own, so the bank's balance is recorded, and its transactions come in too.
    expect(accounts.find((a) => a.id === tfsa)).toMatchObject({ balanceMinor: 1025075, transactionCount: 1, balanceAsOf: '2026-10-03' })
    const snaps = (await api('GET', `/ledgers/personal/accounts/${tfsa}/snapshots`)).body
    expect(snaps).toEqual([expect.objectContaining({ source: 'sync', balanceMinor: 1025075 })])
  })

  it('shows provider problems and respects the daily request limit', async () => {
    const { connect, remote, link, api, sync, ctx, bridge, storage } = await setup()
    const conn = await connect()
    await link(makeAccount(ctx, 'Chq'), remote(conn, 'chq').id)

    bridge.state.errlist = [{ code: 'con.auth', msg: 'Sign in to <b>TD</b> again', conn_id: 'CON-1' }]
    const r = await sync(conn.id)
    expect(r.accounts[0]!.error).toBe('Sign in to TD again')
    let c = (await api('GET', `/bank/connections`)).body[0] as BankConnection
    expect(c).toMatchObject({ status: 'attention', errors: [expect.objectContaining({ code: 'con.auth', message: 'Sign in to TD again' })] })
    expect(c.accounts.find((a) => a.remoteId === 'chq')!.error).toBe('Sign in to TD again')

    bridge.state.status = 403
    const failed = await sync(conn.id)
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/refused/) })
    c = (await api('GET', `/bank/connections`)).body[0] as BankConnection
    expect(c.status).toBe('error')
    expect(c.nextSyncAt).toBe(new Date(storage.now().getTime() + 2 * 3600_000).toISOString())

    bridge.state.status = 200
    for (let i = c.requestsLast24h; i < 20; i++) await sync(conn.id)
    const limited = await api('POST', `/bank/connections/${conn.id}/sync`)
    expect(limited.status).toBe(429)
    expect(limited.body.error).toMatchObject({ code: 'rate_limited', message: expect.stringMatching(/about 24 updates a day/) })
  })

  it('keeps every bank account’s transactions, linked or not, so linking one takes them without fetching', async () => {
    const { connect, remote, link, sync, transactions, ctx, bridge, api } = await setup()
    bridge.state.accounts[1]!.transactions = [tx('p1', '2026-10-02', '-30.00', 'Shell', { pending: true }), tx('b1', '2026-09-20', '-12.50', 'TIM HORTONS #123')]
    const conn = await connect()
    // A new connection's first sync is due at the next check, to fetch its transactions.
    expect(((await api('GET', '/bank/connections')).body as BankConnection[])[0]!.nextSyncAt).toBe(new Date(ctx.now()).toISOString())
    expect((await sync(conn.id)).accounts).toEqual([])
    expect(bridge.state.requests.at(-1)!.searchParams.get('balances-only')).toBeNull()

    // The pending gas posts under another id, while nothing is linked.
    bridge.state.accounts[1]!.transactions = [tx('s1', '2026-10-03', '-31.25', 'Shell'), tx('b1', '2026-09-20', '-12.50', 'TIM HORTONS #123')]
    await sync(conn.id)
    const requests = bridge.state.requests.length
    const visa = makeAccount(ctx, 'TD Visa', 'credit')
    const linked = (await link(visa, remote(conn, 'visa').id)).body as Account
    expect(bridge.state.requests.length).toBe(requests)
    expect(linked).toMatchObject({ balanceMinor: -24010, bank: { lastSyncedAt: new Date(ctx.now()).toISOString() } })
    // Not the pending one it stopped reporting.
    expect((await transactions()).map((t) => [t.payee, t.externalId, t.status])).toEqual([
      ['Shell', 's1', 'cleared'],
      ['TIM HORTONS #123', 'b1', 'cleared'],
    ])
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 0, updated: 0, removed: 0 })
  })

  it('syncs as often as the setting for its service says', async () => {
    const { connect, remote, link, api, sync, ctx, storage } = await setup()
    const conn = await connect()
    await link(makeAccount(ctx, 'Chq'), remote(conn, 'chq').id)
    const next = async () => ((await api('GET', '/bank/connections')).body as BankConnection[])[0]!.nextSyncAt
    const inHours = (h: number) => new Date(storage.now().getTime() + h * 3600_000).toISOString()

    await sync(conn.id)
    expect(await next()).toBe(inHours(6))
    const changed = await api('PATCH', '/settings', { bankSyncHours: { simplefin: 12 } })
    expect((changed.body as Settings).bank.syncHours).toEqual({ simplefin: 12, plaid: 1, wealthsimple: 2 })
    expect(await next()).toBe(inHours(12))
    // SimpleFIN's daily limit doesn't allow hourly syncs; Plaid's setting is separate.
    expect((await api('PATCH', '/settings', { bankSyncHours: { simplefin: 1 } })).status).toBe(400)
    await api('PATCH', '/settings', { bankSyncHours: { plaid: 3 } })
    expect(((await api('GET', '/settings')).body as Settings).bank.syncHours).toEqual({ simplefin: 12, plaid: 3, wealthsimple: 2 })
  })

  it('needs admin to connect and link, write to sync', async () => {
    const { api, connect } = await setup()
    const conn = await connect()
    const key = async (scopes: string[]) => `Bearer ${((await api('POST', '/api-keys', { name: scopes[0], scopes })).body as ApiKeyCreated).key}`
    const writer = { authorization: await key(['write']) }
    expect((await api('GET', '/bank/connections', undefined, writer)).status).toBe(403)
    expect((await api('POST', '/bank/connections', { setupToken: token('T2') }, writer)).status).toBe(403)
    expect((await api('POST', `/bank/connections/${conn.id}/sync`, undefined, writer)).status).toBe(200)
    expect((await api('DELETE', `/bank/connections/${conn.id}`)).status).toBe(204)
    expect((await api('GET', '/bank/connections')).body).toEqual([])
  })

  it('switches an account between synced and manual without duplicates', async () => {
    const { connect, remote, link, api, sync, transactions, ctx, bridge } = await setup()
    const chq = makeAccount(ctx, 'Chq')
    bridge.state.accounts[0]!.transactions = [tx('x1', '2026-10-01', '-10.00', 'Lunch')]
    const conn = await connect()
    await link(chq, remote(conn, 'chq').id)
    await sync(conn.id)

    const manual = await api('DELETE', `/ledgers/personal/accounts/${chq}/bank`)
    expect((manual.body as Account).bank).toBeNull()
    expect((await transactions()).filter((t) => t.payee === 'Lunch')).toHaveLength(1)
    expect((await api('DELETE', `/ledgers/personal/accounts/${chq}/bank`)).status).toBe(409)

    // While manual, you add one by hand; then you switch back to synced.
    await createTransaction(ctx, { accountId: chq, date: '2026-10-02', amountMinor: -400, payee: 'Coffee', categoryId: null, notes: null, tags: [], status: 'cleared', transferAccountId: null })
    bridge.state.accounts[0]!.transactions.push(tx('x2', '2026-10-02', '-4.00', 'COFFEE'), tx('x3', '2026-10-03', '-7.00', 'Bagel'))
    await link(chq, remote(conn, 'chq').id)
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 1, adopted: 1 })
    expect((await transactions()).map((t) => t.payee).sort()).toEqual(['Bagel', 'Coffee', 'Lunch'])

    // A bank account feeds one account at a time.
    const other = makeAccount(ctx, 'Other')
    const taken = await link(other, remote(conn, 'chq').id)
    expect(taken.status).toBe(409)
    expect(taken.body.error.message).toMatch(/already syncs into Chq/)
    const activity = (await api('GET', '/ledgers/personal/activity?entity=account')).body as ActivityPage
    expect(activity.items.map((a) => a.action)).toEqual(expect.arrayContaining(['link_bank', 'unlink_bank']))
  })

  it('stops syncing into an account that was deleted', async () => {
    const { connect, remote, link, api, sync, ctx } = await setup()
    const conn = await connect()
    const id = makeAccount(ctx, 'Old')
    await link(id, remote(conn, 'chq').id)
    await api('DELETE', `/ledgers/personal/accounts/${id}`)
    expect(remote((await api('GET', `/bank/connections`)).body[0], 'chq').link).toBeNull()
    expect((await sync(conn.id)).accounts).toEqual([])
  })
})

describe('institutions', () => {
  const institutionsOf = async (api: Awaited<ReturnType<typeof setup>>['api']) =>
    ((await api('GET', '/ledgers/personal/institutions')).body as Institution[]).map((i) => [i.name, i.accountCount])

  it('puts every account under one, picked by id or by name', async () => {
    const { api } = await setup()
    const add = (body: object) => api('POST', '/ledgers/personal/accounts', { type: 'chequing', ...body })
    expect((await add({ name: 'Chequing' })).status).toBe(400)
    const chq = (await add({ name: 'Chequing', institution: 'TD' })).body as Account
    // The same name (in any case) is the same institution.
    const savings = (await add({ name: 'Savings', institution: ' td ' })).body as Account
    expect([chq.institution, savings.institutionId]).toEqual(['TD', chq.institutionId])
    const cash = (await add({ name: 'Cash', institutionId: chq.institutionId })).body as Account
    expect(cash.institutionId).toBe(chq.institutionId)
    expect((await add({ name: 'Nope', institutionId: 999 })).status).toBe(404)

    // Moving an account to a new institution creates it.
    const moved = (await api('PATCH', `/ledgers/personal/accounts/${cash.id}`, { institution: 'Wallet' })).body as Account
    expect(moved.institution).toBe('Wallet')
    expect(await institutionsOf(api)).toEqual([['TD', 2], ['Wallet', 1]])
    expect((await api('PATCH', `/ledgers/personal/accounts/${cash.id}`, { institution: null })).status).toBe(400)
    const activity = (await api('GET', '/ledgers/personal/activity?entity=institution')).body as ActivityPage
    expect(activity.items.map((a) => a.summary)).toEqual(['Added the institution Wallet', 'Added the institution TD'])
  })

  it('files a synced account under the institution named after its bank, unless you choose one', async () => {
    const { connect, remote, api } = await setup()
    const conn = await connect()
    const add = (body: object) => api('POST', '/ledgers/personal/accounts', body)
    const chq = (await add({ name: 'Chequing', type: 'chequing', bank: { bankAccountId: remote(conn, 'chq').id } })).body as Account
    expect(chq.institution).toBe('TD Canada Trust')
    const visa = (await add({ name: 'Visa', type: 'credit', bank: { bankAccountId: remote(conn, 'visa').id } })).body as Account
    expect(visa.institutionId).toBe(chq.institutionId)
    const tfsa = (await add({ name: 'TFSA', type: 'investment', institution: 'Wealthsimple', bank: { bankAccountId: remote(conn, 'tfsa').id } })).body as Account
    expect(tfsa.institution).toBe('Wealthsimple')
    expect(await institutionsOf(api)).toEqual([['TD Canada Trust', 2], ['Wealthsimple', 1]])
  })

  it('can be renamed, reordered, merged and deleted', async () => {
    const { api, ctx } = await setup()
    makeAccount(ctx, 'Chequing', 'chequing', 0, 'TD')
    const path = '/ledgers/personal/institutions'
    const bank = (await api('POST', path, { name: 'TD Bank' })).body as Institution
    const [td] = (await api('GET', path)).body as Institution[]
    expect((await api('POST', path, { name: 'td' })).status).toBe(409)
    expect((await api('PATCH', `${path}/${td!.id}`, { name: 'TD bank' })).status).toBe(409)

    await api('POST', `${path}/reorder`, { ids: [bank.id, td!.id] })
    expect(await institutionsOf(api)).toEqual([['TD Bank', 0], ['TD', 1]])

    // One with accounts can only be merged into another.
    expect((await api('DELETE', `${path}/${td!.id}`)).status).toBe(409)
    expect((await api('DELETE', `${path}/${td!.id}?moveTo=${bank.id}`)).status).toBe(204)
    expect(await institutionsOf(api)).toEqual([['TD Bank', 1]])
    const other = (await api('POST', path, { name: 'Empty' })).body as Institution
    expect((await api('DELETE', `${path}/${other.id}`)).status).toBe(204)
  })
})
