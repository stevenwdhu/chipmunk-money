import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Account, ActivityPage, BankConnection, Settings, SyncResult, TransactionPage } from '@chipmunk/shared'
import { createApp } from '../../app'
import { bankAccounts, bankConnections, bankTransactions } from '../../db/schema'
import { makeAccount, testStorage } from '../../test/helpers'
import { aiConfig, getAppSetting, sealStoredSecrets, setAppSetting } from '../settings'
import { plaidCategory } from './plaid'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

// A fake Plaid ---------------------------------------------------------------------

interface FakeTx {
  transaction_id: string
  account_id: string
  amount: number
  date: string
  authorized_date?: string | null
  name: string
  merchant_name?: string | null
  pending: boolean
  pending_transaction_id?: string | null
}
interface Batch {
  added?: FakeTx[]
  modified?: FakeTx[]
  removed?: Array<{ transaction_id: string; account_id: string }>
}

const plaidTx = (id: string, account: string, date: string, amount: number, merchant: string, extra: Partial<FakeTx> = {}): FakeTx => ({
  transaction_id: id,
  account_id: account,
  amount,
  date,
  authorized_date: date,
  name: merchant.toUpperCase(),
  merchant_name: merchant,
  pending: false,
  ...extra,
})

function fakePlaid() {
  const state = {
    /** Each call to /transactions/sync hands out the next batch; the cursor counts what's been handed out. */
    batches: [] as Batch[],
    error: null as string | null,
    requests: [] as Array<{ path: string; body: Json }>,
    removed: [] as string[],
  }
  const accounts = [
    { account_id: 'acc-chq', name: 'Chequing', mask: '1234', type: 'depository', subtype: 'checking', balances: { current: 1500.25, available: 1400, iso_currency_code: 'CAD' } },
    { account_id: 'acc-visa', name: 'Visa', mask: '9876', type: 'credit', subtype: 'credit card', balances: { current: 250.5, available: 4749.5, iso_currency_code: 'CAD' } },
  ]
  const error = (status: number, code: string, message: string) =>
    Response.json({ error_type: 'ITEM_ERROR', error_code: code, error_message: message, display_message: null }, { status })
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body ?? '{}'))
    state.requests.push({ path: url.pathname, body })
    if (url.origin !== 'https://sandbox.plaid.com') return new Response('', { status: 404 })
    if (body.client_id !== 'cid' || body.secret !== 'sek-123456') return error(400, 'INVALID_API_KEYS', 'invalid client_id or secret provided')
    switch (url.pathname) {
      case '/link/token/create':
        return Response.json({ link_token: 'link-sandbox-1', expiration: '2026-10-03T22:00:00Z' })
      case '/item/public_token/exchange':
        return body.public_token === 'public-sandbox-td' ? Response.json({ access_token: 'access-td', item_id: 'item-td' }) : error(400, 'INVALID_PUBLIC_TOKEN', 'bad token')
      case '/accounts/get':
        if (state.error) return error(400, state.error, 'the login details of this item have changed')
        return Response.json({ accounts, item: { item_id: 'item-td', institution_id: 'ins_td' } })
      case '/institutions/get_by_id':
        return Response.json({ institution: { institution_id: 'ins_td', name: 'TD Canada Trust' } })
      case '/transactions/sync': {
        const at = Number(body.cursor ?? 0)
        const batch = state.batches[at]
        if (!batch) return Response.json({ added: [], modified: [], removed: [], next_cursor: String(at), has_more: false })
        return Response.json({
          added: batch.added ?? [],
          modified: batch.modified ?? [],
          removed: batch.removed ?? [],
          next_cursor: String(at + 1),
          has_more: at + 1 < state.batches.length,
        })
      }
      case '/item/remove':
        state.removed.push(body.access_token)
        return Response.json({})
      default:
        return new Response('', { status: 404 })
    }
  }) as typeof globalThis.fetch
  return { state, fetch: fakeFetch }
}

async function setup() {
  const plaid = fakePlaid()
  const storage = testStorage({ fetch: plaid.fetch })
  const app = createApp(storage, { trustedHeader: null })
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(`/api/v1${url}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  const ctx = storage.registry.defaultContext()
  const keys = () => api('PATCH', '/settings', { plaid: { clientId: 'cid', secret: 'sek-123456', environment: 'sandbox' } })
  const connect = async () => (await api('POST', '/bank/plaid/connections', { publicToken: 'public-sandbox-td' })).body as BankConnection
  const remote = (conn: BankConnection, id: string) => conn.accounts.find((a) => a.remoteId === id)!
  const link = (accountId: number, bankAccountId: string, syncFrom?: string) =>
    api('PUT', `/ledgers/personal/accounts/${accountId}/bank`, { bankAccountId, ...(syncFrom ? { syncFrom } : {}) })
  const sync = async (id: string) => (await api('POST', `/bank/connections/${id}/sync`)).body as SyncResult
  const transactions = async (accountId: number) =>
    ((await api('GET', `/ledgers/personal/transactions?limit=500&accountId=${accountId}`)).body as TransactionPage).items
  return { plaid, storage, api, ctx, keys, connect, remote, link, sync, transactions }
}

describe('Plaid', () => {
  it('names its categories, and says when it is sure of them', () => {
    expect(plaidCategory({ primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS', confidence_level: 'VERY_HIGH' })).toEqual({
      name: 'Transportation › Gas',
      confident: true,
    })
    expect(plaidCategory({ primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT', confidence_level: 'LOW' })).toEqual({
      name: 'Food and drink › Restaurant',
      confident: false,
    })
    expect(plaidCategory({ primary: 'INCOME', detailed: 'INCOME', confidence_level: 'HIGH' })).toEqual({ name: 'Income', confident: true })
    expect(plaidCategory(null)).toBeUndefined()
  })

  it('keeps Plaid’s secret and AI keys encrypted at rest', async () => {
    const { api, storage, keys } = await setup()
    const settings = (await keys()).body as Settings
    expect(settings.bank.plaid).toEqual({ clientId: 'cid', hasSecret: true, secretHint: '••••3456', environment: 'sandbox', source: 'settings', configured: true })
    expect(JSON.stringify(settings)).not.toContain('sek-123456')
    expect(getAppSetting<{ secret: string }>(storage.app, 'plaid', { secret: '' }).secret).toMatch(/^v1:/)
    // Leaving the secret out keeps it.
    expect(((await api('PATCH', '/settings', { plaid: { clientId: 'cid2', environment: 'production' } })).body as Settings).bank.plaid).toMatchObject({
      clientId: 'cid2',
      hasSecret: true,
      environment: 'production',
    })

    await api('PATCH', '/settings', { ai: { primary: { kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-1234' } } })
    expect(getAppSetting<{ apiKey: string }>(storage.app, 'ai.primary', { apiKey: '' }).apiKey).toMatch(/^v1:/)
    expect(aiConfig(storage.app, 'primary')?.apiKey).toBe('sk-ant-1234')
    // A key saved before keys were encrypted is encrypted at startup and still works.
    setAppSetting(storage.app, 'ai.fallback', { kind: 'openai', model: 'gpt-5-mini', baseUrl: null, apiKey: 'sk-old-5678' })
    sealStoredSecrets(storage.app)
    expect(getAppSetting<{ apiKey: string }>(storage.app, 'ai.fallback', { apiKey: '' }).apiKey).toMatch(/^v1:/)
    expect(aiConfig(storage.app, 'fallback')?.apiKey).toBe('sk-old-5678')

    // Delete removes just the secret or key; the rest stays.
    const noSecret = await api('PATCH', '/settings', { plaid: { clientId: 'cid2', environment: 'production', secret: null } })
    expect((noSecret.body as Settings).bank.plaid).toMatchObject({ clientId: 'cid2', hasSecret: false, configured: false })
    const noKey = await api('PATCH', '/settings', { ai: { primary: { kind: 'anthropic', model: 'claude-opus-5-5', baseUrl: null, apiKey: null } } })
    expect((noKey.body as Settings).ai.primary).toMatchObject({ kind: 'anthropic', model: 'claude-opus-5-5', hasApiKey: false })
  })

  it('connects a bank in Plaid Link and syncs what changed, keeping your edits', async () => {
    const { api, plaid, keys, connect, remote, link, sync, transactions, ctx, storage } = await setup()
    // Plaid's endpoints wait for its keys.
    expect((await api('POST', '/bank/plaid/link-token', {})).status).toBe(400)
    await keys()

    const token = (await api('POST', '/bank/plaid/link-token', {})).body
    expect(token.linkToken).toBe('link-sandbox-1')
    const linkRequest = plaid.state.requests.find((r) => r.path === '/link/token/create')!.body
    expect(linkRequest).toMatchObject({ products: ['transactions'], country_codes: ['CA', 'US'], transactions: { days_requested: 730 } })

    const conn = await connect()
    expect(conn).toMatchObject({ provider: 'plaid', name: 'TD Canada Trust', status: 'ok', needsSignIn: false })
    // A card's balance is what's owed, as a negative balance like everywhere in the app.
    expect(conn.accounts.map((a) => [a.name, a.institution, a.balanceMinor, a.availableMinor])).toEqual([
      ['Chequing (1234)', 'TD Canada Trust', 150025, 140000],
      ['Visa (9876)', 'TD Canada Trust', -25050, null],
    ])

    plaid.state.batches = [
      {
        added: [
          plaidTx('t-groc', 'acc-chq', '2026-09-28', 45.67, 'Loblaws'),
          plaidTx('t-pay', 'acc-chq', '2026-10-01', -2500, 'Acme Payroll'),
          plaidTx('p-coffee', 'acc-chq', '2026-10-02', 4.5, 'Starbucks', { pending: true }),
          plaidTx('t-old', 'acc-chq', '2026-08-01', 9.99, 'Too old'),
          plaidTx('v-1', 'acc-visa', '2026-09-30', 30, 'Indigo'),
        ],
      },
    ]
    const chequing = makeAccount(ctx, 'TD Chequing')
    await link(chequing, remote(conn, 'acc-chq').id, '2026-09-01')
    const first = await sync(conn.id)
    expect(first.accounts).toEqual([expect.objectContaining({ accountName: 'TD Chequing', added: 3, updated: 0, removed: 0, error: null })])
    let txs = await transactions(chequing)
    const payroll = txs[1]!.id
    expect(txs.map((t) => [t.payee, t.amountMinor, t.status, t.externalId])).toEqual([
      ['Starbucks', -450, 'pending', 'p-coffee'],
      ['Acme Payroll', 250000, 'cleared', 't-pay'],
      ['Loblaws', -4567, 'cleared', 't-groc'],
    ])

    // You note the coffee; then it posts (replacing the pending one), the groceries change and one goes away.
    await api('PATCH', `/ledgers/personal/transactions/${txs[0]!.id}`, { notes: 'with Sam' })
    plaid.state.batches.push({
      added: [plaidTx('t-coffee', 'acc-chq', '2026-10-02', 4.75, 'Starbucks', { pending_transaction_id: 'p-coffee' })],
      modified: [plaidTx('t-groc', 'acc-chq', '2026-09-28', 46, 'Loblaws')],
      removed: [
        { transaction_id: 'p-coffee', account_id: 'acc-chq' },
        { transaction_id: 't-pay', account_id: 'acc-chq' },
      ],
    })
    const second = await sync(conn.id)
    expect(second.accounts[0]).toMatchObject({ added: 0, updated: 2, removed: 1 })
    txs = await transactions(chequing)
    expect(txs.map((t) => [t.payee, t.amountMinor, t.status, t.externalId, t.notes])).toEqual([
      ['Starbucks', -475, 'cleared', 't-coffee', 'with Sam'],
      ['Loblaws', -4600, 'cleared', 't-groc', null],
    ])
    // Only what changed is asked for next time.
    expect(plaid.state.requests.filter((r) => r.path === '/transactions/sync').at(-1)!.body.cursor).toBe('1')
    // Every account's transactions are kept, the unlinked Visa's too, and what Plaid removed is marked.
    const kept = storage.app.db
      .select({ remoteId: bankTransactions.remoteId, removedAt: bankTransactions.removedAt })
      .from(bankTransactions)
      .orderBy(bankTransactions.remoteId)
      .all()
      .map((r) => [r.remoteId, r.removedAt === null ? 0 : 1])
    expect(kept).toEqual([
      ['p-coffee', 1],
      ['t-coffee', 0],
      ['t-groc', 0],
      ['t-old', 0],
      ['t-pay', 1],
      ['v-1', 0],
    ])
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 0, updated: 0, removed: 0 })

    // What Plaid last sent for each, as it sent it: for the id it has now (not the pending coffee's).
    const bankData = async (id: number) => {
      const p = (await api('GET', `/ledgers/personal/transactions/${id}/bank-data`)).body as Json
      return [p.event, p.remoteId, p.payload.amount ?? null, p.payload.pending ?? null]
    }
    expect(await bankData(txs[1]!.id)).toEqual(['changed', 't-groc', 46, false])
    expect(await bankData(txs[0]!.id)).toEqual(['added', 't-coffee', 4.75, false])
    expect(await bankData(payroll)).toEqual(['removed', 't-pay', null, null])
    expect(((await api('GET', `/ledgers/personal/transactions/${txs[1]!.id}/bank-data`)).body as Json).payload).toMatchObject({
      transaction_id: 't-groc',
      merchant_name: 'Loblaws',
      authorized_date: '2026-09-28',
    })

    // Fetching all history asks Plaid from the start again; nothing doubles up or changes.
    const all = (await api('POST', `/bank/connections/${conn.id}/fetch-history`)).body as SyncResult
    expect(all.accounts[0]).toMatchObject({ added: 0, updated: 0, removed: 0 })
    expect(plaid.state.requests.filter((r) => r.path === '/transactions/sync').at(-2)!.body.cursor).toBeUndefined()
    expect(await transactions(chequing)).toHaveLength(2)
    plaid.state.requests.length = 0

    // Linking the card later fetches the login's history again; the chequing account doesn't double up.
    const visa = makeAccount(ctx, 'TD Visa', 'credit')
    await link(visa, remote(conn, 'acc-visa').id, '2026-09-01')
    expect(plaid.state.requests.filter((r) => r.path === '/transactions/sync').length).toBe(0)
    await sync(conn.id)
    expect((await transactions(visa)).map((t) => [t.payee, t.amountMinor])).toEqual([['Indigo', -3000]])
    expect(await transactions(chequing)).toHaveLength(2)

    const activity = (await api('GET', '/ledgers/personal/activity?actor=Plaid%20sync')).body as ActivityPage
    expect(activity.items.map((a) => a.summary)).toContain('Synced TD Chequing from TD Canada Trust: 2 updated, 1 removed')
    const account = (await api('GET', `/ledgers/personal/accounts/${chequing}`)).body as Account
    expect(account.bank).toMatchObject({ provider: 'plaid', name: 'Chequing (1234)' })
  })

  it('leaves an amount or date you corrected alone, until you let syncs update it again', async () => {
    const { plaid, api, ctx, keys, connect, remote, link, sync, transactions } = await setup()
    await keys()
    const conn = await connect()
    plaid.state.batches = [
      {
        added: [
          plaidTx('t-affirm', 'acc-chq', '2026-09-25', -52.50, 'Affirm'),
          plaidTx('p-gas', 'acc-chq', '2026-10-01', 40, 'Shell', { pending: true }),
          plaidTx('t-gone', 'acc-chq', '2026-09-20', 12, 'Gone'),
        ],
      },
    ]
    const chequing = makeAccount(ctx, 'TD Chequing')
    await link(chequing, remote(conn, 'acc-chq').id, '2026-09-01')
    await sync(conn.id)
    const byPayee = async () => new Map((await transactions(chequing)).map((t) => [t.payee, t]))
    let txs = await byPayee()
    expect(txs.get('Affirm')).toMatchObject({ amountMinor: 5250, correctedAt: null })

    // The bank had the sign wrong: you fix it, and correct the gas station's amount and the other one's date.
    const fix = (payee: string, body: object) => api('PATCH', `/ledgers/personal/transactions/${txs.get(payee)!.id}`, body)
    expect((await fix('Affirm', { amountMinor: -5250 })).body.correctedAt).toEqual(expect.any(String))
    await fix('Shell', { amountMinor: -4500 })
    await fix('Gone', { date: '2026-09-21' })
    // Other edits don't count as corrections.
    expect((await fix('Affirm', { notes: 'payment, not a refund' })).body.correctedAt).toEqual(expect.any(String))

    // The bank sends the Affirm one again, posts the gas (under a new id) and removes the third.
    plaid.state.batches.push({
      added: [plaidTx('t-gas', 'acc-chq', '2026-10-02', 41, 'Shell', { pending_transaction_id: 'p-gas' })],
      modified: [plaidTx('t-affirm', 'acc-chq', '2026-09-25', -52.50, 'Affirm')],
      removed: [{ transaction_id: 't-gone', account_id: 'acc-chq' }],
    })
    expect((await sync(conn.id)).accounts[0]).toMatchObject({ added: 0, removed: 0 })
    txs = await byPayee()
    expect(txs.get('Affirm')).toMatchObject({ amountMinor: -5250 })
    expect(txs.get('Shell')).toMatchObject({ amountMinor: -4500, date: '2026-10-01', status: 'cleared', externalId: 't-gas' })
    expect(txs.get('Gone')).toMatchObject({ date: '2026-09-21' })

    // Let syncs update it again: the next time the bank sends it, its amount is the bank's.
    expect((await fix('Affirm', { corrected: false })).body.correctedAt).toBeNull()
    plaid.state.batches.push({ modified: [plaidTx('t-affirm', 'acc-chq', '2026-09-25', 52.50, 'Affirm')] })
    await sync(conn.id)
    expect((await byPayee()).get('Affirm')).toMatchObject({ amountMinor: -5250, correctedAt: null })
    plaid.state.batches.push({ modified: [plaidTx('t-affirm', 'acc-chq', '2026-09-25', 50, 'Affirm')] })
    await sync(conn.id)
    expect((await byPayee()).get('Affirm')).toMatchObject({ amountMinor: -5000 })
  })

  it('asks you to reconnect when the bank wants you to sign in again', async () => {
    const { api, plaid, keys, connect, remote, link, sync, ctx } = await setup()
    await keys()
    const conn = await connect()
    await link(makeAccount(ctx, 'TD Chequing'), remote(conn, 'acc-chq').id)
    plaid.state.error = 'ITEM_LOGIN_REQUIRED'
    const failed = await sync(conn.id)
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/sign in again/) })
    const after = (await api('GET', '/bank/connections')).body[0] as BankConnection
    expect(after).toMatchObject({ status: 'error', needsSignIn: true })

    // Reconnecting opens Link for that bank login.
    await api('POST', '/bank/plaid/link-token', { connectionId: conn.id })
    const update = plaid.state.requests.filter((r) => r.path === '/link/token/create').at(-1)!.body
    expect(update).toMatchObject({ access_token: 'access-td' })
    expect(update).not.toHaveProperty('products')
    plaid.state.error = null
    expect((await sync(conn.id)).ok).toBe(true)
    expect(((await api('GET', '/bank/connections')).body[0] as BankConnection).needsSignIn).toBe(false)
  })

  it('works beside SimpleFIN: an account syncs from one bank account, at either service', async () => {
    const { api, storage, keys, connect, remote, link, ctx } = await setup()
    await keys()
    const conn = await connect()
    // A SimpleFIN connection, with an account at another bank.
    storage.app.db
      .insert(bankConnections)
      .values({ id: 'sf', provider: 'simplefin', name: 'SimpleFIN Bridge', secret: storage.secrets.seal('https://u:p@bridge.test/simplefin') })
      .run()
    storage.app.db.insert(bankAccounts).values({ id: 'sf-chq', connectionId: 'sf', remoteId: 'ACT-1', name: 'Chequing', currency: 'CAD' }).run()
    const chequing = makeAccount(ctx, 'TD Chequing')
    expect((await link(chequing, 'sf-chq', '2026-09-01')).status).toBe(200)

    // Moving it to Plaid: SimpleFIN's account stops feeding it.
    expect((await link(chequing, remote(conn, 'acc-chq').id, '2026-09-01')).status).toBe(200)
    const listed = (await api('GET', '/bank/connections')).body as BankConnection[]
    expect(listed.map((c) => c.provider).sort()).toEqual(['plaid', 'simplefin'])
    expect(listed.flatMap((c) => c.accounts).filter((a) => a.link?.accountId === chequing).map((a) => a.id)).toEqual([remote(conn, 'acc-chq').id])
    // The database holds it to one, too.
    expect(() =>
      storage.app.db.update(bankAccounts).set({ accountId: chequing }).where(eq(bankAccounts.id, 'sf-chq')).run(),
    ).toThrow(/UNIQUE/)
  })
})
