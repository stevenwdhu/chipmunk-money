import { expect, it } from 'vitest'
import { createApp } from './app'
import type { AppContext } from './services/context'
import { fakeBridge, fakeTx, TOKEN, type FakeCard } from './test/fake-bridge'
import { categoryId, makeAccount, testLedger, testStorage } from './test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount } from './test/shared-accounts'
import { apiKey, mcpClient, send, settle, type Req } from './test/twins'
import { ledgerRows } from './test/world'

/**
 * The whole of shared accounts on one database, in the order a household would go through it, over
 * HTTP (as the app) and over MCP (an agent with a key for every ledger), each step by one or the
 * other. Personal's credit card Visa syncs from a fake bank, where it opens at −$1,000.00, and is
 * shared with Family, Trip and Cabin. After every step the parts sum to the account, and nothing
 * refers across ledgers.
 */

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

it('shares a card, uses it in every ledger, syncs and imports, changes its home, stops sharing, and deletes a ledger and the account', { timeout: 30_000 }, async () => {
  // The bank: three transactions, and an opening balance of −$1,000.00 behind them.
  const card: FakeCard = {
    balance: '-1050.00',
    transactions: [fakeTx('b1', '2026-09-28', '-100.00', 'Grocer'), fakeTx('b2', '2026-09-30', '-50.00', 'Cafe'), fakeTx('b3', '2026-10-01', '100.00', 'Payment Thank You')],
  }
  const storage = testStorage({ fetch: fakeBridge(card) })
  const personal = storage.registry.defaultContext()
  const family = testLedger(storage, 'Family')
  const trip = testLedger(storage, 'Trip')
  const cabin = testLedger(storage, 'Cabin')
  const all = [personal, family, trip, cabin]
  const visa = makeAccount(personal, 'Visa', 'credit', 0, 'TD')
  const app = createApp(storage, { trustedHeader: null })

  /** A request as the app, which must succeed. */
  const http = async (method: string, path: string, body?: unknown, query?: Req['query']) => {
    const res = await send(app, { method, path, body, query })
    expect(res.status, `${method} ${path} → ${res.message ?? ''}`).toBeLessThan(300)
    return res.body as Json
  }
  const agent = await mcpClient(app, await apiKey(app, ['admin']))
  /** A tool call as the agent, which must succeed. */
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await agent.call(name, args)
    expect(res.isError, `${name} → ${res.text}`).toBe(false)
    return res
  }
  const base = (ctx: AppContext) => `/ledgers/${ctx.ledger.slug}`
  /** The ids a ledger holds on Visa, oldest first. */
  const held = (ctx: AppContext) => ctx.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NULL ORDER BY date, id', visa)
  const byPayee = (ctx: AppContext, payee: string) => ctx.q.pluck<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND payee LIKE ? AND deleted_at IS NULL', visa, payee)!
  /** Each ledger's part of an account by slug and its total, after checking they sum to it and nothing refers across ledgers. */
  const check = (account = visa) => {
    expectNoCrossLedgerReferences(storage)
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
    return expectPartsSumToAccount(storage, account)
  }
  const everything = () => all.filter((c) => storage.registry.find(c.ledger.id)).map((c) => ledgerRows(storage.sqlite, c.ledger.id))
  /** A sync, by the agent: what it says of Visa. */
  const sync = async () => {
    const res = await tool('sync_banks', {})
    await settle()
    expect(res.data.errors).toEqual([])
    return res.data.synced.find((a: Json) => a.account === 'Visa')
  }

  // The bank, connected in the home.
  const conn = await http('POST', '/bank/connections', { setupToken: TOKEN })
  const bankAccountId = (conn.accounts as Json[]).find((a) => a.remoteId === 'visa').id as string
  await http('PUT', `${base(personal)}/accounts/${visa}/bank`, { bankAccountId })
  expect(await sync()).toMatchObject({ ledger: 'personal', added: 3 })
  expect(check()).toEqual({ parts: { personal: -105_000 }, totalMinor: -105_000 })

  // Share: the agent, with a dry run first.
  const sharedWith = { ledger: 'personal', account: 'Visa', ledgers: ['Personal', 'Family', 'trip', 'cabin'] }
  let before = everything()
  expect((await tool('share_account', { ...sharedWith, dryRun: true })).data).toMatchObject({ dryRun: true, added: ['family', 'trip', 'cabin'], home: 'personal' })
  expect(everything()).toEqual(before)
  const shared = await tool('share_account', sharedWith)
  expect(shared.data).toMatchObject({ dryRun: false, added: ['family', 'trip', 'cabin'], homeChange: null, removed: [], totalBalance: '-$1,050.00' })
  expect(shared.data.ledgers.map((l: Json) => [l.ledger, l.balance])).toEqual([['personal', '-$1,050.00'], ['family', '$0.00'], ['trip', '$0.00'], ['cabin', '$0.00']])
  const listed = await tool('list_accounts', { ledger: 'family' })
  expect(listed.data.accounts).toMatchObject([
    { id: visa, balanceMinor: 0, sharing: { home: 'personal', isHome: false, ledgers: ['personal', 'family', 'trip', 'cabin'], totalBalanceMinor: -105_000, totalBalance: '-$1,050.00' } },
  ])
  expect(listed.text).toBe(`#${visa} Visa at TD (credit): $0.00 of -$1,050.00 · shared with personal, trip, cabin, its home is personal`)
  expect((await tool('list_accounts', {})).text).toContain('shared with family, trip, cabin, its home is this ledger')

  // Enter by hand in two of the ledgers it's shared with: the agent in Family, the app in Trip.
  const added = await tool('add_transactions', { ledger: 'family', transactions: [{ account: 'Visa', date: '2026-09-29', amount: -120, payee: 'Daycare', category: 'Groceries' }] })
  const daycare = added.data.added[0].id as number
  const taxi = (await http('POST', `${base(trip)}/transactions`, { accountId: visa, date: '2026-09-29', amountMinor: -3_000, payee: 'Taxi', categoryId: categoryId(trip, 'Groceries') })).id as number
  expect(check()).toEqual({ parts: { personal: -105_000, family: -12_000, trip: -3_000, cabin: 0 }, totalMinor: -120_000 })
  // The bank posts both: each is matched where it was entered, and nothing is added.
  card.transactions.push(fakeTx('b4', '2026-09-29', '-120.00', 'Daycare'), fakeTx('b5', '2026-09-29', '-30.00', 'Taxi'))
  card.balance = '-1200.00'
  expect(await sync()).toMatchObject({ added: 0, matched: 2 })
  expect([held(family), held(trip)]).toEqual([[daycare], [taxi]])
  expect(check()).toEqual({ parts: { personal: -105_000, family: -12_000, trip: -3_000, cabin: 0 }, totalMinor: -120_000 })

  // Move: the agent, with a dry run first.
  const grocer = byPayee(personal, 'Grocer%')
  before = everything()
  expect((await tool('move_transactions', { ids: [grocer], to: 'Family', dryRun: true })).data).toMatchObject({ ledger: 'personal', to: 'family', dryRun: true, moved: 1 })
  expect(everything()).toEqual(before)
  const moved = await tool('move_transactions', { ids: [grocer], to: 'Family' })
  expect(moved.data).toMatchObject({ dryRun: false, moved: 1 })
  expect(moved.text).toContain('Moved 1 transaction from Personal to Family.')
  await settle()
  expect((await agent.call('get_transaction', { id: grocer })).isError).toBe(true)
  expect((await tool('get_transaction', { ledger: 'family', id: grocer })).data.transaction).toMatchObject({ amountMinor: -10_000, account: 'Visa', split: null })
  expect(check().parts).toEqual({ personal: -95_000, family: -22_000, trip: -3_000, cabin: 0 })

  // Split the card payment: Family $40.00, Cabin $10.00, and Personal keeps $50.00.
  const payment = byPayee(personal, 'Payment%')
  await http('PATCH', `${base(personal)}/transactions/${payment}`, { categoryId: categoryId(personal, 'Credit card payment') })
  const shares = [
    { ledger: 'Family', amount: 40 },
    { ledger: 'cabin', amount: 10 },
  ]
  before = everything()
  expect((await tool('split_transaction', { id: payment, shares, dryRun: true })).data).toMatchObject({ dryRun: true, kept: '$50.00' })
  expect(everything()).toEqual(before)
  const split = await tool('split_transaction', { id: payment, shares })
  const given = [
    { ledger: 'family', amountMinor: 4_000, amount: '$40.00' },
    { ledger: 'cabin', amountMinor: 1_000, amount: '$10.00' },
  ]
  expect(split.data).toMatchObject({ dryRun: false, keptMinor: 5_000, kept: '$50.00', shares: given, transaction: { id: payment, split: { part: 'payment', keptMinor: 5_000, shares: given, from: null } } })
  expect(split.text).toContain('family $40.00, cabin $10.00, and Personal keeps $50.00.')
  const theirs = await tool('search_transactions', { ledger: 'cabin', account: 'Visa' })
  expect(theirs.data.transactions).toMatchObject([{ amountMinor: 1_000, split: { part: 'share', keptMinor: null, shares: [], from: 'personal' } }])
  expect(theirs.text).toContain('share of a payment in personal')
  expect((await tool('get_transaction', { id: payment })).text).toContain('split: family $40.00, cabin $10.00, keeps $50.00')
  expect(check().parts).toEqual({ personal: -100_000, family: -18_000, trip: -3_000, cabin: 1_000 })

  // The all-ledgers list, from a ledger that holds only a share: the statement, ending at the account's total.
  const whole = await tool('list_account_transactions', { ledger: 'cabin', account: 'Visa' })
  expect(whole.data.transactions.map((t: Json) => [t.payee, t.ledger, t.here, t.amount, t.balanceAfter])).toEqual([
    ['Payment Thank You', 'personal', false, '$100.00', '-$1,200.00'],
    ['Cafe', 'personal', false, '-$50.00', '-$1,300.00'],
    ['Taxi', 'trip', false, '-$30.00', '-$1,250.00'],
    ['Daycare', 'family', false, '-$120.00', '-$1,220.00'],
    ['Grocer', 'family', false, '-$100.00', '-$1,100.00'],
  ])
  expect(whole.data.transactions[0].split).toEqual({ keptMinor: 5_000, kept: '$50.00', shares: given })
  expect(whole.text).toContain('split: family $40.00, cabin $10.00, keeps $50.00')

  // A sync with the bank unchanged: no row added, removed or changed in any ledger, and no balance.
  before = everything()
  expect(await sync()).toMatchObject({ added: 0, updated: 0, matched: 0, removed: 0 })
  expect(everything()).toEqual(before)
  expect(check()).toEqual({ parts: { personal: -100_000, family: -18_000, trip: -3_000, cabin: 1_000 }, totalMinor: -120_000 })

  // A CSV into the home, with a row Family holds and a new one: the agent previews, then imports.
  const rows = [
    { date: '2026-09-28', payee: 'GROCER', amount: -100 },
    { date: '2026-10-02', payee: 'Bakery', amount: -25 },
  ]
  expect((await agent.call('import_transactions', { ledger: 'family', account: 'Visa', rows })).text).toBe('Visa’s home is Personal. CSV files are imported into it there.')
  const preview = await tool('import_transactions', { account: 'Visa', rows })
  expect(preview.data).toMatchObject({ committed: false, newRows: 1, duplicates: 1, preview: [{ payee: 'GROCER', duplicateOf: null, duplicateElsewhere: true }, { payee: 'Bakery', duplicateOf: null, duplicateElsewhere: false }] })
  expect(preview.text).toContain('2026-09-28 GROCER -$100.00 · already in another ledger')
  expect((await tool('import_transactions', { account: 'Visa', rows, confirm: true })).data).toMatchObject({ committed: true, newRows: 1, duplicates: 1 })
  await settle()
  const bakery = byPayee(personal, 'Bakery')
  expect(held(family)).toHaveLength(3)
  expect(check().parts).toEqual({ personal: -102_500, family: -18_000, trip: -3_000, cabin: 1_000 })
  // The bank posts it too, and it's matched.
  card.transactions.push(fakeTx('b6', '2026-10-02', '-25.00', 'Bakery'))
  card.balance = '-1225.00'
  expect(await sync()).toMatchObject({ added: 0, matched: 1 })
  expect(held(personal)).toContain(bakery)
  expect(check()).toEqual({ parts: { personal: -102_500, family: -18_000, trip: -3_000, cabin: 1_000 }, totalMinor: -122_500 })

  // Change the home to Family: the app, with a dry run first. No part changes, and the bank now syncs into Family.
  const everyone = ['personal', 'family', 'trip', 'cabin']
  before = everything()
  expect(await http('PUT', `${base(personal)}/accounts/${visa}/sharing`, { ledgers: everyone, home: 'family' }, { dryRun: true })).toMatchObject({ dryRun: true, home: { from: { slug: 'personal' }, to: { slug: 'family' } } })
  expect(everything()).toEqual(before)
  await http('PUT', `${base(personal)}/accounts/${visa}/sharing`, { ledgers: everyone, home: 'family' })
  expect((await tool('list_accounts', {})).data.accounts.find((a: Json) => a.id === visa)).toMatchObject({ balanceMinor: -102_500, sharing: { home: 'family', isHome: false, ledgers: ['family', 'personal', 'trip', 'cabin'] } })
  expect(check()).toEqual({ parts: { family: -18_000, personal: -102_500, trip: -3_000, cabin: 1_000 }, totalMinor: -122_500 })
  before = everything()
  expect(await sync()).toMatchObject({ ledger: 'family', added: 0, updated: 0, matched: 0, removed: 0 })
  expect(everything()).toEqual(before)

  // Stop sharing with Personal, which keeps its transactions, and with Trip, whose one goes home: the agent, in the new home.
  const stop = { ledger: 'family', account: 'Visa', ledgers: ['family', 'cabin'], rows: { Personal: 'keep', trip: 'home' } }
  expect((await agent.call('share_account', { ...stop, ledger: 'personal' })).text).toBe('Visa’s home is Family. Its sharing is changed there.')
  expect((await agent.call('share_account', { ...stop, rows: { trip: 'home' } })).isError).toBe(true)
  before = everything()
  expect((await tool('share_account', { ...stop, dryRun: true })).data.removed.map((r: Json) => [r.ledger, r.rows])).toEqual([['personal', 'keep'], ['trip', 'home']])
  expect(everything()).toEqual(before)
  const stopped = await tool('share_account', stop)
  await settle()
  expect(stopped.data).toMatchObject({ home: 'family', removed: [{ ledger: 'personal', rows: 'keep', moved: 0, account: { name: 'Visa' } }, { ledger: 'trip', rows: 'home', moved: 1, kept: 0, account: null }] })
  expect(stopped.data.ledgers.map((l: Json) => l.ledger)).toEqual(['family', 'cabin'])
  const kept = stopped.data.removed[0].account.id as number
  expect(held(trip)).toEqual([])
  expect(held(family)).toContain(taxi)
  expect((await http('GET', `${base(trip)}/accounts`)) as Json[]).toEqual([])
  // What Personal kept is on its own account now, at what its own transactions come to: −$50.00, +$100.00, the −$50.00 it gave, and −$25.00.
  const own = check(kept)
  expect(own).toEqual({ parts: { personal: -2_500 }, totalMinor: -2_500 })
  // Visa is the bank's whole balance still, so Family carries that −$25.00 too, with the opening balance and Trip's taxi.
  expect(stopped.data.notices).toContain(
    'Personal’s new account keeps its balance of $25.00 owed, and Visa’s total is the whole bank balance again, so that amount is also in Family until you record how it was settled.',
  )
  expect(check()).toEqual({ parts: { family: -123_500, cabin: 1_000 }, totalMinor: -122_500 })
  // The bank is unchanged: nothing comes back for the rows Personal kept.
  const count = () => storage.sqlite.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }
  const rowsBefore = count()
  expect(await sync()).toMatchObject({ ledger: 'family', added: 0, removed: 0 })
  expect(count()).toEqual(rowsBefore)
  expect(check()).toEqual({ parts: { family: -123_500, cabin: 1_000 }, totalMinor: -122_500 })

  // Delete Family, the home, with its answers: Cabin becomes the home and takes its transactions.
  const asked = await http('GET', `${base(family)}/questions`, undefined, { action: 'delete' })
  expect(asked.questions.map((q: Json) => q.id)).toEqual([`home:${visa}`, `rows:${visa}`])
  expect(asked.blockers).toEqual([])
  expect((await send(app, { method: 'DELETE', path: base(family), body: { confirm: 'Family' } })).status).toBe(409)
  const familyHeld = held(family)
  const gone = await http('DELETE', base(family), { confirm: 'Family', answers: { [`home:${visa}`]: 'cabin', [`rows:${visa}`]: 'move:cabin' } })
  await settle()
  expect(gone.changes).toEqual([
    'Cabin is Visa’s home now.',
    'Family’s 4 transactions on Visa moved to Cabin.',
    'Visa’s opening balance and recorded balances moved to Cabin. Cabin owes $1,025.00 more on Visa, and earlier balances shifted too.',
    'Family and all its data were deleted.',
  ])
  expect((await tool('list_ledgers', {})).data.ledgers.map((l: Json) => l.slug)).toEqual(['personal', 'trip', 'cabin'])
  expect(held(cabin)).toEqual(expect.arrayContaining(familyHeld))
  expect(check()).toEqual({ parts: { cabin: -122_500 }, totalMinor: -122_500 })
  expect((await tool('list_accounts', { ledger: 'cabin' })).data.accounts).toMatchObject([{ id: visa, balanceMinor: -122_500, sharing: null }])
  expect((await agent.call('list_account_transactions', { ledger: 'cabin', account: 'Visa' })).isError).toBe(true)

  // Delete the account, which only Cabin has now. What Personal kept stays.
  await http('DELETE', `${base(cabin)}/accounts/${visa}`)
  await settle()
  expect(storage.sqlite.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(visa)).toEqual({ n: 0 })
  expect((await http('GET', `${base(cabin)}/accounts`)) as Json[]).toEqual([])
  expect(check(kept)).toEqual(own)
  expect((await tool('sync_banks', {})).data).toEqual({ synced: [], errors: [] })
  await agent.close()
})
