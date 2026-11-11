import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { transactionCreateSchema, type Account, type BankConnection, type LinkPreview, type SyncResult, type TransactionPage, type WealthsimpleConnectResult } from '@chipmunk/shared'
import { createApp } from '../../app'
import { bankConnections, bankTransactions } from '../../db/schema'
import { categoryId, makeAccount, testStorage } from '../../test/helpers'
import { listNameRules, renamePayee, worldOfLedger } from '../payee-names'
import { listPayeeRules, setPayeeChoice } from '../payees'
import { setAppSetting } from '../settings'
import { insertTransaction } from '../transactions'
import { BankService } from './service'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

// A fake Wealthsimple ---------------------------------------------------------------------

const activity = (id: string, accountId: string, occurredAt: string, amount: string, type: string, subType: string | null, extra: Record<string, unknown> = {}) => ({
  accountId,
  canonicalId: id,
  occurredAt,
  status: 'completed',
  unifiedStatus: 'COMPLETED',
  type,
  subType,
  amount: amount.replace('-', ''),
  amountSign: amount.startsWith('-') ? 'negative' : 'positive',
  currency: 'CAD',
  spendMerchant: null,
  aftOriginatorName: null,
  billPayCompanyName: null,
  billPayPayeeNickname: null,
  eTransferName: null,
  eTransferEmail: null,
  p2pHandle: null,
  counterPartyName: null,
  institutionName: null,
  opposingAccountId: null,
  assetSymbol: null,
  assetQuantity: null,
  ...extra,
})

function fakeWealthsimple() {
  const state = {
    refresh: 'r1',
    access: 'a1',
    issued: 1,
    /** The refresh token stops working (say, after a password change). */
    revoked: false,
    passwords: [] as string[],
    activities: [
      activity('a-etransfer', 'ca-cash-family', '2026-09-08T18:05:31.000000+00:00', '25.00', 'DEPOSIT', 'E_TRANSFER', { eTransferName: 'Jane Doe' }),
      activity('a-pay', 'ca-cash-family', '2026-09-09T21:06:24.123456+00:00', '1250.00', 'DEPOSIT', 'AFT', { aftOriginatorName: 'ACME PAYROLL' }),
      activity('a-bill', 'ca-cash-family', '2026-09-16T08:00:00.000000+00:00', '-1800.00', 'WITHDRAWAL', 'BILL_PAY', {
        billPayCompanyName: 'NORTHERN BANK VISA',
        billPayPayeeNickname: 'Northern Visa',
      }),
      activity('a-in', 'ca-cash-family', '2026-10-01T08:00:00.000000+00:00', '1500.00', 'INTERNAL_TRANSFER', 'DESTINATION', { opposingAccountId: 'ca-cash-mine' }),
      // Interest is recorded by date (midnight in Toronto): 9:00 pm the day before in Vancouver.
      activity('a-interest', 'ca-cash-family', '2026-10-01T04:00:00.000000+00:00', '2.35', 'INTEREST', null, { status: null }),
      activity('a-failed', 'ca-cash-family', '2026-09-20T16:00:12.000000+00:00', '-120.00', 'WITHDRAWAL', 'BILL_PAY', {
        status: 'failed',
        unifiedStatus: 'FAILED',
        billPayCompanyName: 'CITY UTILITIES',
      }),
      activity('c-walmart', 'ca-credit-card-1', '2026-09-28T23:10:00.000000+00:00', '-45.67', 'CREDIT_CARD', 'PURCHASE', { spendMerchant: 'Wal-Mart Supercenter#1234' }),
      // 6:18 pm in Vancouver, already the next day in UTC.
      activity('c-noodle', 'ca-credit-card-1', '2026-10-03T01:18:47.000000+00:00', '-27.50', 'CREDIT_CARD', 'PURCHASE', { spendMerchant: 'Tst-Golden Noodle House -' }),
      activity('c-pending', 'ca-credit-card-1', '2026-10-03T15:01:02.000000+00:00', '-12.00', 'CREDIT_CARD', 'PURCHASE', {
        status: 'authorized',
        unifiedStatus: 'IN_PROGRESS',
        spendMerchant: 'Sq *Corner Cafe',
      }),
      activity('c-payment', 'ca-credit-card-1', '2026-09-30T19:59:05.000000+00:00', '100.00', 'CREDIT_CARD', 'PAYMENT'),
      activity('h-in', 'hisa-1', '2026-09-24T17:30:00.000000+00:00', '500.00', 'INTERNAL_TRANSFER', 'DESTINATION', { opposingAccountId: 'ca-cash-mine' }),
      activity('h-interest', 'hisa-1', '2026-10-01T04:00:00.000000+00:00', '1.10', 'INTEREST', null),
      // A contribution, what it bought, and a dividend.
      activity('t-in', 'tfsa-1', '2026-09-15T16:00:07.000000+00:00', '1000.00', 'INTERNAL_TRANSFER', 'DESTINATION', { opposingAccountId: 'ca-cash-mine' }),
      activity('t-buy', 'tfsa-1', '2026-09-15T17:00:01.000000+00:00', '-998.40', 'DIY_BUY', 'MARKET_ORDER', { assetSymbol: 'VFV', assetQuantity: '6.0000' }),
      activity('t-div', 'tfsa-1', '2026-09-30T04:00:00.000000+00:00', '4.12', 'DIVIDEND', null, { assetSymbol: 'VFV' }),
    ],
    /** The activity queries' conditions, as sent. */
    conditions: [] as Json[],
  }
  const accounts = [
    { id: 'ca-cash-family', status: 'open', unifiedAccountType: 'CASH', nickname: 'Household', currency: 'CAD', accountOwnerConfiguration: 'MULTI_OWNER', financials: { currentCombined: { id: 'x', netLiquidationValue: { amount: '4210.50', currency: 'CAD' } } } },
    { id: 'ca-cash-mine', status: 'open', unifiedAccountType: 'CASH', nickname: null, currency: 'CAD', accountOwnerConfiguration: 'INDIVIDUAL', financials: { currentCombined: { id: 'y', netLiquidationValue: { amount: '150.00', currency: 'CAD' } } } },
    { id: 'ca-credit-card-1', status: 'open', unifiedAccountType: 'CREDIT_CARD', nickname: null, currency: 'CAD', accountOwnerConfiguration: null, financials: { currentCombined: { id: 'z', netLiquidationValue: { amount: '0', currency: 'CAD' } } } },
    { id: 'hisa-1', status: 'open', unifiedAccountType: 'HISA_PORTFOLIO_NON_REGISTERED', nickname: null, currency: 'CAD', accountOwnerConfiguration: null, financials: { currentCombined: { id: 'v', netLiquidationValue: { amount: '2000.00', currency: 'CAD' } } } },
    { id: 'tfsa-1', status: 'open', unifiedAccountType: 'SELF_DIRECTED_TFSA', nickname: null, currency: 'CAD', accountOwnerConfiguration: null, financials: { currentCombined: { id: 'w', netLiquidationValue: { amount: '5000.00', currency: 'CAD' } } } },
    { id: 'closed-1', status: 'closed', unifiedAccountType: 'SELF_DIRECTED_NON_REGISTERED', nickname: 'Old', currency: 'CAD', accountOwnerConfiguration: null, financials: null },
  ]
  const page = <T,>(items: T[], first: number, cursor: string | null) => {
    const at = Number(cursor ?? 0)
    const slice = items.slice(at, at + first)
    return { edges: slice.map((node) => ({ node })), pageInfo: { hasNextPage: at + first < items.length, endCursor: String(at + first) } }
  }

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const authed = headers.get('authorization') === `Bearer ${state.access}`
    if (url.href === 'https://my.wealthsimple.com/app/login') {
      return new Response('<html><script type="module" src="https://my.wealthsimple.com/app-1a2b3c.js"></script></html>', {
        headers: { 'set-cookie': 'wssdi=dec0-1234; Path=/; Secure' },
      })
    }
    if (url.href === 'https://my.wealthsimple.com/app-1a2b3c.js') return new Response('x={"production":{api:"…",clientId:"c0ffee42"}}')
    if (url.href === 'https://api.production.wealthsimple.com/v1/oauth/v2/token') {
      if (body.client_id !== 'c0ffee42' || headers.get('x-ws-device-id') !== 'dec0-1234') return Response.json({ error: 'invalid_client' }, { status: 401 })
      if (body.grant_type === 'password') {
        state.passwords.push(body.password)
        if (body.username !== 'me@example.com' || body.password !== 'pw' || headers.get('x-wealthsimple-otp') !== '123456;remember=true') {
          return Response.json({ error: 'invalid_grant' }, { status: 401 })
        }
      } else if (body.grant_type === 'refresh_token') {
        if (state.revoked || body.refresh_token !== state.refresh) return Response.json({ error: 'invalid_grant' }, { status: 401 })
      }
      state.issued++
      state.access = `a${state.issued}`
      state.refresh = `r${state.issued}`
      return Response.json({ access_token: state.access, refresh_token: state.refresh })
    }
    if (url.href === 'https://api.production.wealthsimple.com/v1/oauth/v2/token/info') {
      return authed ? Response.json({ identity_canonical_id: 'identity-1' }) : Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (url.href === 'https://my.wealthsimple.com/graphql') {
      if (!authed) return Response.json({ errors: [{ message: 'Not Authorized', extensions: { code: 'UNAUTHENTICATED' } }] })
      const v = body.variables
      switch (body.operationName) {
        case 'FetchAllAccountFinancials':
          return Response.json({ data: { identity: { id: v.identityId, accounts: page(accounts, 2, v.cursor) } } })
        case 'FetchCreditCardAccount':
          return Response.json({ data: { creditCardAccount: { id: v.id, balance: { current: '1250.40', availableCreditLimit: '8749.60' } } } })
        case 'FetchActivityFeedItems': {
          const c = v.condition
          state.conditions.push(c)
          const items = state.activities.filter(
            (a) => c.accountIds.includes(a.accountId) && (!c.startDate || a.occurredAt.slice(0, 10) >= c.startDate) && a.occurredAt.slice(0, 10) <= c.endDate,
          )
          return Response.json({ data: { activityFeedItems: page(items, 3, v.cursor) } })
        }
      }
    }
    return new Response('', { status: 404 })
  }) as typeof globalThis.fetch
  return { state, fetch: fakeFetch }
}

async function setup() {
  const ws = fakeWealthsimple()
  const storage = testStorage({ fetch: ws.fetch })
  // Vancouver, three hours behind Wealthsimple's Toronto.
  setAppSetting(storage.app, 'timezone', 'America/Vancouver')
  const bank = new BankService(storage)
  const app = createApp(storage, { trustedHeader: null, bank })
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
  const signIn = async (extra: Record<string, unknown> = {}) =>
    (await api('POST', '/bank/wealthsimple/connections', { email: 'me@example.com', password: 'pw', otp: '123456', ...extra })).body as WealthsimpleConnectResult
  const remote = (conn: BankConnection, id: string) => conn.accounts.find((a) => a.remoteId === id)!
  const link = (accountId: number, bankAccountId: string, syncFrom?: string) =>
    api('PUT', `/ledgers/personal/accounts/${accountId}/bank`, { bankAccountId, ...(syncFrom ? { syncFrom } : {}) })
  const sync = async (id: string) => (await api('POST', `/bank/connections/${id}/sync`)).body as SyncResult
  const transactions = async (accountId: number) =>
    ((await api('GET', `/ledgers/personal/transactions?limit=500&accountId=${accountId}`)).body as TransactionPage).items
  return { ws, storage, bank, api, ctx, signIn, remote, link, sync, transactions }
}

describe('Wealthsimple', () => {
  it('signs in with a 2FA code, keeping the session and never the password', async () => {
    const { ws, storage, api, signIn } = await setup()
    // Asked for the code first: nothing is kept yet.
    const first = (await api('POST', '/bank/wealthsimple/connections', { email: 'me@example.com', password: 'pw' })).body
    expect(first).toEqual({ otpRequired: true, connection: null })
    expect((await api('GET', '/bank/connections')).body).toEqual([])
    expect((await api('POST', '/bank/wealthsimple/connections', { email: 'me@example.com', password: 'pw', otp: '000000' })).status).toBe(400)

    const { otpRequired, connection } = await signIn()
    expect(otpRequired).toBe(false)
    expect(connection).toMatchObject({ provider: 'wealthsimple', name: 'Wealthsimple', status: 'ok', needsSignIn: false })
    // Open accounts, by nickname or kind; a card's balance is what's owed.
    expect(connection!.accounts.map((a) => [a.name, a.institution, a.balanceMinor])).toEqual([
      ['Household', 'Wealthsimple', 421_050],
      ['Chequing', 'Wealthsimple', 15_000],
      ['Credit card', 'Wealthsimple', -125_040],
      ['Savings', 'Wealthsimple', 200_000],
      ['TFSA', 'Wealthsimple', 500_000],
    ])
    const row = storage.app.db.select().from(bankConnections).get()!
    expect(JSON.parse(storage.secrets.open(row.secret))).toMatchObject({ email: 'me@example.com', identityId: 'identity-1', deviceId: 'dec0-1234', refreshToken: ws.state.refresh })
    expect(JSON.stringify(JSON.parse(storage.secrets.open(row.secret)))).not.toContain('"pw"')
    // The same login again is the same connection.
    await signIn()
    expect((await api('GET', '/bank/connections')).body).toHaveLength(1)
  })

  it('syncs chequing, card and savings activity: payees, local dates and times, pending, and what didn’t happen', async () => {
    const { ws, ctx, api, storage, signIn, remote, link, sync, transactions } = await setup()
    const { connection } = await signIn()
    const family = makeAccount(ctx, 'Family chequing', 'chequing', 0, 'Wealthsimple')
    const card = makeAccount(ctx, 'Wealthsimple Visa', 'credit', 0, 'Wealthsimple')
    const savings = makeAccount(ctx, 'Savings', 'savings', 0, 'Wealthsimple')
    const tfsa = makeAccount(ctx, 'TFSA', 'investment', 0, 'Wealthsimple')
    await link(family, remote(connection!, 'ca-cash-family').id)
    await link(card, remote(connection!, 'ca-credit-card-1').id)
    await link(savings, remote(connection!, 'hisa-1').id)
    await link(tfsa, remote(connection!, 'tfsa-1').id)
    const result = await sync(connection!.id)
    expect(result.ok).toBe(true)
    // One window back to the start of the history, for every open account at once, a page at a time.
    expect(ws.state.conditions[0]).toMatchObject({ accountIds: ['ca-cash-family', 'ca-cash-mine', 'ca-credit-card-1', 'hisa-1', 'tfsa-1'] })

    const byPayee = (list: Awaited<ReturnType<typeof transactions>>) =>
      Object.fromEntries(list.map((t) => [t.payeeName, { date: t.date, time: t.datetime, amount: t.amountMinor, status: t.status, id: t.externalId }]))
    expect(byPayee(await transactions(family))).toEqual({
      'Jane Doe - INTERAC e-Transfer®': { date: '2026-09-08', time: '2026-09-08T11:05:31', amount: 2_500, status: 'cleared', id: 'a-etransfer' },
      'ACME PAYROLL - Direct deposit': { date: '2026-09-09', time: '2026-09-09T14:06:24', amount: 125_000, status: 'cleared', id: 'a-pay' },
      // By date only: no time, and on its date in Toronto.
      'Northern Visa - Bill payment': { date: '2026-09-16', time: null, amount: -180_000, status: 'cleared', id: 'a-bill' },
      'Transfer from Chequing': { date: '2026-10-01', time: null, amount: 150_000, status: 'cleared', id: 'a-in' },
      Interest: { date: '2026-10-01', time: null, amount: 235, status: 'cleared', id: 'a-interest' },
    })
    expect(byPayee(await transactions(card))).toEqual({
      'Wal-Mart Supercenter#1234': { date: '2026-09-28', time: '2026-09-28T16:10:00', amount: -4_567, status: 'cleared', id: 'c-walmart' },
      // The day it was in Vancouver, not UTC's next day.
      'Tst-Golden Noodle House -': { date: '2026-10-02', time: '2026-10-02T18:18:47', amount: -2_750, status: 'cleared', id: 'c-noodle' },
      'Sq *Corner Cafe': { date: '2026-10-03', time: '2026-10-03T08:01:02', amount: -1_200, status: 'pending', id: 'c-pending' },
      'Credit card payment': { date: '2026-09-30', time: '2026-09-30T12:59:05', amount: 10_000, status: 'cleared', id: 'c-payment' },
    })
    // Wealthsimple's savings account is a portfolio to it, but only cash: transfers and interest.
    expect(byPayee(await transactions(savings))).toEqual({
      'Transfer from Chequing': { date: '2026-09-24', time: '2026-09-24T10:30:00', amount: 50_000, status: 'cleared', id: 'h-in' },
      Interest: { date: '2026-10-01', time: null, amount: 110, status: 'cleared', id: 'h-interest' },
    })
    // An investment's money in and out, not what it bought (that's kept, marked as a trade).
    expect(byPayee(await transactions(tfsa))).toEqual({
      'Transfer from Chequing': { date: '2026-09-15', time: '2026-09-15T09:00:07', amount: 100_000, status: 'cleared', id: 't-in' },
      'VFV - Dividend': { date: '2026-09-30', time: null, amount: 412, status: 'cleared', id: 't-div' },
    })
    const buy = storage.app.db.select({ data: bankTransactions.data }).from(bankTransactions).where(eq(bankTransactions.remoteId, 't-buy')).get()!.data
    expect(JSON.parse(buy)).toMatchObject({ payee: 'Buy VFV', amountMinor: -99_840, trade: true, description: 'Diy buy · Market order · 6.0000 VFV' })
    // The balances are Wealthsimple's.
    expect((await api('GET', `/ledgers/personal/accounts/${tfsa}`)).body.balanceMinor).toBe(500_000)
    expect((await api('GET', `/ledgers/personal/accounts/${savings}`)).body.balanceMinor).toBe(200_000)
    expect((await api('GET', `/ledgers/personal/accounts/${family}`)).body.balanceMinor).toBe(421_050)
    expect((await api('GET', `/ledgers/personal/accounts/${card}`)).body.balanceMinor).toBe(-125_040)
  })

  it('keeps the new refresh token each sync, and asks you to sign in again when it stops working', async () => {
    const { ws, storage, ctx, signIn, remote, link, sync, api } = await setup()
    const { connection } = await signIn()
    const card = makeAccount(ctx, 'Wealthsimple Visa', 'credit', 0, 'Wealthsimple')
    await link(card, remote(connection!, 'ca-credit-card-1').id)
    await sync(connection!.id)
    await sync(connection!.id)
    const secret = () => JSON.parse(storage.secrets.open(storage.app.db.select().from(bankConnections).where(eq(bankConnections.id, connection!.id)).get()!.secret))
    expect(secret().refreshToken).toBe(ws.state.refresh)

    ws.state.revoked = true
    expect((await sync(connection!.id)).ok).toBe(false)
    const listed = (await api('GET', '/bank/connections')).body as BankConnection[]
    expect(listed.find((c) => c.id === connection!.id)).toMatchObject({ status: 'error', needsSignIn: true })

    // Signing in again keeps the connection (and its linked account), and catches up.
    ws.state.revoked = false
    const again = await signIn({ connectionId: connection!.id })
    expect(again.connection).toMatchObject({ id: connection!.id, status: 'ok', needsSignIn: false })
    expect(again.connection!.accounts.find((a) => a.remoteId === 'ca-credit-card-1')!.link?.accountId).toBe(card)
  })

  it('takes over an account from Plaid without adding the overlap twice', async () => {
    const { ws, storage, bank, ctx, signIn, remote, link, sync, transactions } = await setup()
    const card = makeAccount(ctx, 'Wealthsimple Visa', 'credit', 0, 'Wealthsimple')
    // What Plaid brought: its own ids and wording, dated by UTC.
    for (const [id, date, amount, payee] of [
      ['plaid-walmart', '2026-09-29', -4_567, 'Walmart'],
      ['plaid-noodle', '2026-10-03', -2_750, 'Golden Noodle'],
      ['plaid-payment', '2026-09-30', 10_000, 'Credit Card Payment - From: Cash'],
    ] as const) {
      insertTransaction(ctx, transactionCreateSchema.parse({ accountId: card, date, amountMinor: amount, payee, externalId: id }), { origin: 'sync', skipRecurring: true, suggestion: null })
    }
    // What you set for Plaid's Golden Noodle: a choice, and a name.
    const dineOut = categoryId(ctx, 'Dine out')
    setPayeeChoice(ctx, { payeeKey: 'golden noodle', mode: 'always', categoryId: dineOut })
    renamePayee(worldOfLedger(ctx), { payee: 'Golden Noodle', name: 'Noodle night' })
    const { connection } = await signIn()
    // No limit by default, as when any account switches to synced.
    await link(card, remote(connection!, 'ca-credit-card-1').id)
    await sync(connection!.id)
    const list = await transactions(card)
    expect(list.map((t) => [t.payeeName, t.externalId, t.date]).sort()).toEqual([
      // Wealthsimple's wording, ids and dates now: a synced one's payee is its current connection's.
      ['Credit card payment', 'c-payment', '2026-09-30'],
      ['Noodle night', 'c-noodle', '2026-10-02'],
      ['Sq *Corner Cafe', 'c-pending', '2026-10-03'],
      // Plaid's "Walmart" is Wealthsimple's "Wal-Mart Supercenter#1234" now.
      ['Wal-Mart Supercenter#1234', 'c-walmart', '2026-09-28'],
    ])
    // What you named it keeps its name in Wealthsimple's wording, which joins your rule, and its choice.
    const noodle = list.find((t) => t.externalId === 'c-noodle')!
    expect(noodle).toMatchObject({ payee: 'Tst-Golden Noodle House -', payeeKey: 'noodle night', payeeName: 'Noodle night' })
    expect(listNameRules(worldOfLedger(ctx))).toEqual([expect.objectContaining({ patterns: ['Golden Noodle', 'Tst-Golden Noodle House -'], name: 'Noodle night' })])
    expect(listPayeeRules(ctx)).toEqual([expect.objectContaining({ payeeKey: 'noodle night', mode: 'always', categoryId: dineOut })])

    // One switched before payees followed their connection, still with Plaid's: what the connection
    // sent, as kept, catches it up. Nothing is fetched, and nothing else changes.
    ctx.q.run("UPDATE transactions SET payee = 'Golden Noodle' WHERE ledger_id = @ledger AND external_id = 'c-noodle'")
    const fetches = ws.state.conditions.length
    expect(bank.applyKept()).toBe(1)
    expect((await transactions(card)).find((t) => t.externalId === 'c-noodle')).toMatchObject({ payee: 'Tst-Golden Noodle House -', payeeName: 'Noodle night' })
    expect(ws.state.conditions.length).toBe(fetches)
    expect(bank.applyKept()).toBe(0)

    // Tidied by older payee rules, as kept and in the ledger: made again from what Wealthsimple sent,
    // still without fetching, and the transaction moves back with its alias.
    storage.app.db
      .update(bankTransactions)
      .set({ data: sql`json_set(${bankTransactions.data}, '$.payee', 'Noodle Old')` })
      .where(eq(bankTransactions.remoteId, 'c-noodle'))
      .run()
    ctx.q.run("UPDATE transactions SET payee = 'Noodle Old', payee_key = 'noodle old' WHERE ledger_id = @ledger AND external_id = 'c-noodle'")
    expect(bank.refreshPayees()).toBe(1)
    expect((await transactions(card)).find((t) => t.externalId === 'c-noodle')).toMatchObject({ payee: 'Tst-Golden Noodle House -', payeeName: 'Noodle night' })
    expect(ws.state.conditions.length).toBe(fetches)
    expect(bank.refreshPayees()).toBe(0)
  })

  it('switches an account over as reviewed, from what its syncs kept: pairs, a changed amount, older history, and what only one side has', async () => {
    const { ws, ctx, bank, api, signIn, remote, sync, transactions } = await setup()
    const card = makeAccount(ctx, 'Wealthsimple Visa', 'credit', 0, 'Wealthsimple')
    ctx.q.run("UPDATE accounts SET opening_date = '2026-09-20' WHERE ledger_id = @ledger AND id = ?", card)
    // What Plaid brought, with its own ids and wording, dated by UTC.
    const add = (externalId: string, date: string, amountMinor: number, payee: string) =>
      insertTransaction(ctx, transactionCreateSchema.parse({ accountId: card, date, amountMinor, payee, externalId }), { origin: 'sync', skipRecurring: true, suggestion: null })
    add('plaid-walmart', '2026-09-29', -4_567, 'Walmart')
    add('plaid-noodle', '2026-10-03', -2_750, 'Golden Noodle')
    add('plaid-payment', '2026-09-30', 10_000, 'Credit Card Payment - From: Cash')
    const cafe = add('plaid-cafe', '2026-10-03', -1_000, 'Corner Cafe')
    const refund = add('plaid-refund', '2026-09-20', 499, 'Refund')
    ws.state.activities.push(
      activity('c-book', 'ca-credit-card-1', '2026-09-25T20:00:01.000000+00:00', '-9.99', 'CREDIT_CARD', 'PURCHASE', { spendMerchant: 'Book Nook' }),
      // Older than anything Plaid brought.
      activity('c-old', 'ca-credit-card-1', '2026-09-05T20:00:00.000000+00:00', '-15.00', 'CREDIT_CARD', 'PURCHASE', { spendMerchant: 'Old Bookshop' }),
    )
    const { connection } = await signIn()
    const bankAccountId = remote(connection!, 'ca-credit-card-1').id
    const preview = async (from?: string) => (await api('POST', `/ledgers/personal/accounts/${card}/bank/preview`, { bankAccountId, from })).body as LinkPreview

    // Nothing fetched for it yet: nothing to compare (it doesn't fetch).
    expect(await preview()).toMatchObject({ fetchedAt: null, rows: [] })
    // Its connection syncs on its own, linked or not, keeping every account's transactions.
    expect((await api('GET', '/bank/connections')).body[0].nextSyncAt).not.toBeNull()
    expect((await sync(connection!.id)).accounts).toEqual([])
    const fetches = ws.state.conditions.length

    // Compared from the oldest one kept, newest first. The bank's from before the account's first are its older history.
    const p = await preview()
    expect(p).toMatchObject({ from: '2026-09-05', earliest: '2026-09-05', first: '2026-09-20', provider: 'wealthsimple', fetchedAt: '2026-10-03T18:00:00.000Z' })
    expect(p.rows.map((r) => [r.kind, r.local?.payee ?? null, r.remote?.payee ?? null])).toEqual([
      ['matched', 'Golden Noodle', 'Tst-Golden Noodle House -'],
      ['near', 'Corner Cafe', 'Sq *Corner Cafe'],
      ['matched', 'Credit Card Payment - From: Cash', 'Credit card payment'],
      ['matched', 'Walmart', 'Wal-Mart Supercenter#1234'],
      ['remote', null, 'Book Nook'],
      ['local', 'Refund', null],
      ['remote', null, 'Old Bookshop'],
    ])
    expect((await preview('2026-09-20')).rows.map((r) => r.remote?.payee)).not.toContain('Old Bookshop')
    // While it's reviewed, its connection doesn't sync on its own.
    expect(bank.due()).toEqual([])
    expect((await transactions(card)).map((t) => t.externalId).sort()).toEqual(['plaid-cafe', 'plaid-noodle', 'plaid-payment', 'plaid-refund', 'plaid-walmart'])

    // The cafe's is the same purchase (yours has the amount you corrected), the book stays out, the refund goes.
    const pairs = p.rows.filter((r) => r.kind === 'matched').map((r) => ({ transactionId: r.local!.id, remoteId: r.remote!.remoteId }))
    const decided = {
      bankAccountId,
      from: p.from,
      pairs: [...pairs, { transactionId: cafe, remoteId: 'c-pending', keepAmount: true }],
      skip: ['c-book'],
      remove: [refund],
    }
    // Made from something else (a sync since, say): nothing changes.
    const stale = await api('POST', `/ledgers/personal/accounts/${card}/bank/switch`, { ...decided, version: 'old' })
    expect(stale.status).toBe(409)
    expect((await transactions(card)).map((t) => t.externalId)).not.toContain('c-old')

    const res = await api('POST', `/ledgers/personal/accounts/${card}/bank/switch`, { ...decided, version: p.version })
    expect(res.body.result).toEqual({ matched: 4, added: 1, skipped: 1, removed: 1, kept: 0 })
    // Reviewed from the oldest one kept: no limit for older history a later fetch brings.
    expect(remote((await api('GET', '/bank/connections')).body[0], 'ca-credit-card-1').syncFrom).toBeNull()
    const account = res.body.account as Account
    expect(account.bank).toMatchObject({ bankAccountId, provider: 'wealthsimple', lastSyncedAt: '2026-10-03T18:00:00.000Z' })
    // Its balance is the bank's, and its opening date moved back to its older history.
    expect(account).toMatchObject({ balanceMinor: -125_040, openingDate: '2026-09-05' })
    // Without fetching: what was reviewed is what switched. And its connection syncs on its own again.
    expect(ws.state.conditions.length).toBe(fetches)
    const byId = async () =>
      Object.fromEntries((await transactions(card)).map((t) => [t.externalId, { payee: t.payeeName, date: t.date, amount: t.amountMinor, corrected: !!t.correctedAt }]))
    const expected = {
      // The new service's payees.
      'c-walmart': { payee: 'Wal-Mart Supercenter#1234', date: '2026-09-28', amount: -4_567, corrected: false },
      'c-noodle': { payee: 'Tst-Golden Noodle House -', date: '2026-10-02', amount: -2_750, corrected: false },
      'c-payment': { payee: 'Credit card payment', date: '2026-09-30', amount: 10_000, corrected: false },
      'c-pending': { payee: 'Sq *Corner Cafe', date: '2026-10-03', amount: -1_000, corrected: true },
      'c-old': { payee: 'Old Bookshop', date: '2026-09-05', amount: -1_500, corrected: false },
    }
    expect(await byId()).toEqual(expected)

    // Syncing afterwards brings nothing back: not the book, not twice.
    expect((await sync(connection!.id)).accounts[0]).toMatchObject({ added: 0 })
    expect(await byId()).toEqual(expected)
  })

  it('keeps an account’s import date until you change it, and without one takes everything kept', async () => {
    const { ws, ctx, api, signIn, remote, link, sync, transactions } = await setup()
    const { connection } = await signIn()
    await sync(connection!.id)
    const fetches = ws.state.conditions.length
    const card = makeAccount(ctx, 'Wealthsimple Visa', 'credit', 0, 'Wealthsimple')
    const bankAccountId = remote(connection!, 'ca-credit-card-1').id
    const ids = async () => (await transactions(card)).map((t) => t.externalId).sort()
    expect(((await link(card, bankAccountId, '2026-10-01')).body as Account).bank).toMatchObject({ syncFrom: '2026-10-01' })
    expect(await ids()).toEqual(['c-noodle', 'c-pending'])
    // Linked again without one: it keeps its date.
    expect(((await link(card, bankAccountId)).body as Account).bank).toMatchObject({ syncFrom: '2026-10-01' })
    // Cleared: no limit, so it takes the rest of what's kept, without fetching.
    const cleared = (await api('PUT', `/ledgers/personal/accounts/${card}/bank`, { bankAccountId, syncFrom: null })).body as Account
    expect(cleared.bank).toMatchObject({ syncFrom: null })
    expect(await ids()).toEqual(['c-noodle', 'c-payment', 'c-pending', 'c-walmart'])
    expect(ws.state.conditions.length).toBe(fetches)
  })

  it('links an account to a bank account straight from what its syncs kept, without fetching', async () => {
    const { ws, ctx, api, signIn, remote, link, sync, transactions } = await setup()
    const { connection } = await signIn()
    // What's kept doesn't go back as far as Wealthsimple does yet (say, its first sync didn't ask).
    const older = activity('c-old', 'ca-credit-card-1', '2026-08-01T20:00:01.000000+00:00', '-15.00', 'CREDIT_CARD', 'PURCHASE', { spendMerchant: 'Old Bookshop' })
    await sync(connection!.id)
    const fetches = ws.state.conditions.length
    const card = makeAccount(ctx, 'Wealthsimple Visa', 'credit', 0, 'Wealthsimple')
    const linked = (await link(card, remote(connection!, 'ca-credit-card-1').id)).body as Account
    expect(ws.state.conditions.length).toBe(fetches)
    expect(linked.bank).toMatchObject({ lastSyncedAt: '2026-10-03T18:00:00.000Z' })
    expect(linked.balanceMinor).toBe(-125_040)
    expect((await transactions(card)).map((t) => t.externalId).sort()).toEqual(['c-noodle', 'c-payment', 'c-pending', 'c-walmart'])

    // So does a new account, made synced.
    const created = await api('POST', '/ledgers/personal/accounts', { name: 'Household', type: 'chequing', bank: { bankAccountId: remote(connection!, 'ca-cash-family').id } })
    expect(created.status).toBe(201)
    expect((await transactions((created.body as Account).id)).map((t) => t.externalId).sort()).toEqual(['a-bill', 'a-etransfer', 'a-in', 'a-interest', 'a-pay'])
    expect(ws.state.conditions.length).toBe(fetches)

    // An empty account has no date before which it leaves transactions out, so fetching all history brings the older ones.
    expect(remote((await api('GET', '/bank/connections')).body[0], 'ca-credit-card-1').syncFrom).toBeNull()
    ws.state.activities.push(older)
    expect((await api('POST', `/bank/connections/${connection!.id}/fetch-history`)).status).toBe(200)
    expect((await transactions(card)).map((t) => t.externalId)).toContain('c-old')
  })
})
