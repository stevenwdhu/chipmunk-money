import { describe, expect, it } from 'vitest'
import type { ApiKeyCreated } from '@chipmunk/shared'
import { createApp } from './app'
import { bankAccounts, bankConnections } from './db/schema'
import { keepTransactions } from './services/bank/store'
import type { AppContext } from './services/context'
import { fakeBridge, fakeTx, TOKEN, type FakeCard } from './test/fake-bridge'
import { categoryId, makeAccount, testLedger, testStorage } from './test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount } from './test/shared-accounts'
import { ledgerRows } from './test/world'

/**
 * Shared accounts over HTTP: sharing a card, entering by hand in a ledger it's shared with, moving,
 * splitting a payment, the all-ledgers list, changing the home and stopping sharing both ways, each
 * as the app (a session) and with API keys. Personal is Visa's home (it opens at −$1,000.00), and
 * Family and Trip are the other ledgers. A key for every ledger does what the app does. A key
 * limited to one ledger is refused wherever another ledger would be read row by row or written,
 * and still sees the account's total and the other ledgers' names beside its own part.
 */

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
type Headers = Record<string, string>

const OPENING = -100_000

function setup(opts: { fetch?: typeof fetch } = {}) {
  const storage = testStorage({ fetch: opts.fetch })
  const personal = storage.registry.defaultContext()
  const family = testLedger(storage, 'Family')
  const trip = testLedger(storage, 'Trip')
  const visa = makeAccount(personal, 'Visa', 'credit', OPENING, 'TD')
  const chequing = makeAccount(personal, 'Chequing', 'chequing', 500_000, 'TD')

  const app = createApp(storage, { trustedHeader: null })
  const call = async (method: string, url: string, body?: unknown, headers: Headers = {}) => {
    const res = await app.request(`/api/v1${url}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const json = (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as Json
    return { status: res.status, body: json, message: res.status >= 400 ? (json?.error?.message as string | undefined) : undefined }
  }
  /** An API key's headers: for every ledger, or limited to some. */
  const key = async (scope: 'read' | 'write' | 'admin', ledgers?: AppContext[]): Promise<Headers> => {
    const res = await call('POST', '/api-keys', { name: `${scope} ${ledgers?.map((l) => l.ledger.slug).join('+') ?? 'all'}`, scopes: [scope], ledgers: ledgers?.map((l) => l.ledger.id) })
    expect(res.status).toBe(201)
    return { authorization: `Bearer ${(res.body as ApiKeyCreated).key}`, 'sec-fetch-site': 'none' }
  }
  const base = (ctx: AppContext) => `/ledgers/${ctx.ledger.slug}`
  /** Shares Visa: `ledgers` is everyone who will have it. */
  const sharing = (body: { ledgers: string[]; home?: string; rows?: Record<string, string> }, o: { in?: AppContext; dryRun?: boolean; headers?: Headers } = {}) =>
    call('PUT', `${base(o.in ?? personal)}/accounts/${visa}/sharing${o.dryRun ? '?dryRun=true' : ''}`, body, o.headers)
  /** A transaction entered by hand, through the API, in a ledger that has Visa. */
  const spend = async (ctx: AppContext, date: string, amountMinor: number, payee = 'Shop', extra: Record<string, unknown> = {}) => {
    const res = await call('POST', `${base(ctx)}/transactions`, { accountId: visa, date, amountMinor, payee, categoryId: categoryId(ctx, 'Groceries'), ...extra })
    expect(res.status, res.message).toBe(201)
    return res.body.id as number
  }
  /** A card payment onto Visa, in the ledger's category for card payments. */
  const payment = (ctx: AppContext, date: string, amountMinor: number) => spend(ctx, date, amountMinor, 'PAYMENT THANK YOU', { categoryId: categoryId(ctx, 'Credit card payment') })
  const move = (from: AppContext, ids: number[], to: string, o: { dryRun?: boolean; headers?: Headers } = {}) =>
    call('POST', `${base(from)}/transactions/move${o.dryRun ? '?dryRun=true' : ''}`, { ids, to }, o.headers)
  const split = (ctx: AppContext, id: number, shares: Array<{ ledger: string; amountMinor: number }>, o: { dryRun?: boolean; headers?: Headers } = {}) =>
    call('PUT', `${base(ctx)}/transactions/${id}/split${o.dryRun ? '?dryRun=true' : ''}`, { shares }, o.headers)
  const account = async (ctx: AppContext, headers?: Headers, id = visa) => (await call('GET', `${base(ctx)}/accounts/${id}`, undefined, headers)).body as Json
  const held = async (ctx: AppContext, headers?: Headers) =>
    ((await call('GET', `${base(ctx)}/transactions?accountId=${visa}&limit=500`, undefined, headers)).body.items as Json[]).map((t) => t.id as number).sort((a, b) => a - b)
  /** Each ledger's part of Visa by slug, after checking they sum to its total and nothing refers across ledgers. */
  const parts = () => {
    expectNoCrossLedgerReferences(storage)
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
    return expectPartsSumToAccount(storage, visa).parts
  }
  /** Every ledger's rows: what a dry run and a refused request must leave as it was. */
  const everything = () => [personal, family, trip].map((c) => ledgerRows(storage.sqlite, c.ledger.id))
  /** Runs a request that must change nothing, and returns its answer. */
  const unchanged = async <T>(request: () => Promise<T>): Promise<T> => {
    const before = everything()
    const res = await request()
    expect(everything()).toEqual(before)
    return res
  }
  return { storage, app, personal, family, trip, visa, chequing, call, key, base, sharing, spend, payment, move, split, account, held, parts, everything, unchanged }
}

type World = ReturnType<typeof setup>

/** Visa shared with Family, each holding rows: Personal −$200.00 and −$80.00, Family −$300.00 (moved there) and −$120.00 (entered there). */
async function shared(w: World = setup(), ledgers = ['personal', 'family']) {
  expect((await w.sharing({ ledgers })).status).toBe(200)
  const p1 = await w.spend(w.personal, '2026-08-05', -20_000)
  const p2 = await w.spend(w.personal, '2026-09-20', -8_000)
  const f1 = await w.spend(w.personal, '2026-08-10', -30_000, 'Grocer')
  expect((await w.move(w.personal, [f1], 'family')).status).toBe(200)
  const f2 = await w.spend(w.family, '2026-09-15', -12_000, 'Daycare')
  return { ...w, p1, p2, f1, f2 }
}

const refused = (message: string) => ({ status: 403, message })
const words = (m?: string) => m?.replace(/\d+/g, '#')

describe('sharing an account over HTTP', () => {
  it('shares a credit card with a dry run first, and shows it in the other ledger without what’s the home’s', async () => {
    const w = setup()
    const before = await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/sharing`)
    expect(before.status).toBe(200)
    expect(before.body).toEqual({
      accountId: w.visa,
      home: { slug: 'personal', name: 'Personal', archived: false, transactionCount: 0, balanceMinor: OPENING },
      opening: { slug: 'personal', name: 'Personal' },
      members: [],
      totalBalanceMinor: OPENING,
    })
    // It answers for any account type.
    expect((await w.call('GET', `${w.base(w.personal)}/accounts/${w.chequing}/sharing`)).body.members).toEqual([])
    expect((await w.account(w.personal)).sharing).toBeNull()

    const dry = await w.unchanged(() => w.sharing({ ledgers: ['personal', 'family'] }, { dryRun: true }))
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({ dryRun: true, added: [{ slug: 'family', name: 'Family' }], home: null, removed: [], opening: null, notices: [] })
    expect(dry.body.sharing.members.map((m: Json) => m.slug)).toEqual(['family'])
    expect((await w.call('GET', `${w.base(w.family)}/accounts`)).body).toEqual([])

    // For real, with a key for every ledger.
    const all = await w.key('admin')
    const done = await w.sharing({ ledgers: ['personal', 'family'] }, { headers: all })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ dryRun: false, added: [{ slug: 'family', name: 'Family' }], parts: { before: { personal: OPENING }, after: { personal: OPENING, family: 0 } } })

    const block = {
      home: { slug: 'personal', name: 'Personal' },
      opening: { slug: 'personal', name: 'Personal' },
      ledgers: [
        { slug: 'personal', name: 'Personal' },
        { slug: 'family', name: 'Family' },
      ],
      totalBalanceMinor: OPENING,
    }
    expect(await w.account(w.personal)).toMatchObject({ balanceMinor: OPENING, openingBalanceMinor: OPENING, sharing: { ...block, isHome: true } })
    // In Family: its own part, and nothing of the opening balance, the recorded balances, the import mapping or the bank.
    const [inFamily] = (await w.call('GET', `${w.base(w.family)}/accounts`)).body as Json[]
    expect(inFamily).toMatchObject({
      id: w.visa,
      name: 'Visa',
      institution: 'TD',
      balanceMinor: 0,
      openingBalanceMinor: 0,
      balanceAsOf: null,
      importMapping: null,
      bank: null,
      transactionCount: 0,
      sharing: { ...block, isHome: false },
    })
    expect((await w.call('GET', `${w.base(w.family)}/accounts/${w.visa}/snapshots`)).body).toEqual([])
    expect(w.parts()).toEqual({ personal: OPENING, family: 0 })
  })

  it('is changed in the home only, by an admin, for credit cards and ledgers that exist', async () => {
    const w = setup()
    await w.sharing({ ledgers: ['personal', 'family'] })
    const elsewhere = { status: 409, message: 'Visa’s home is Personal. Its sharing is changed there.' }
    expect(await w.call('GET', `${w.base(w.family)}/accounts/${w.visa}/sharing`)).toMatchObject(elsewhere)
    expect(await w.unchanged(() => w.sharing({ ledgers: ['personal'] }, { in: w.family }))).toMatchObject(elsewhere)
    // Trip doesn't have it at all.
    expect(await w.call('GET', `${w.base(w.trip)}/accounts/${w.visa}/sharing`)).toMatchObject({ status: 404, message: 'Account not found' })
    expect(await w.sharing({ ledgers: ['trip'] }, { in: w.trip })).toMatchObject({ status: 404, message: 'Account not found' })

    expect(await w.sharing({ ledgers: ['personal', 'trip'] }, { headers: await w.key('write') })).toMatchObject({ status: 403, message: "This API key can't do that. It needs the “admin” scope." })
    expect((await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/sharing`, undefined, await w.key('read'))).status).toBe(200)

    const notCard = await w.unchanged(() => w.call('PUT', `${w.base(w.personal)}/accounts/${w.chequing}/sharing`, { ledgers: ['personal', 'family'] }))
    expect(notCard).toMatchObject({ status: 400, message: 'Only credit cards can be shared for now, and Chequing isn’t one.' })
    expect(await w.sharing({ ledgers: ['personal', 'nope'] })).toMatchObject({ status: 400, message: 'There’s no ledger “nope”.' })
    expect(await w.sharing({ ledgers: ['family'] })).toMatchObject({ status: 400, message: 'Personal is Visa’s home. Keep it in the list, or name the new home.' })
    expect(await w.sharing({ ledgers: ['personal'], home: 'family' })).toMatchObject({ status: 400, message: 'Family isn’t in the list, so it can’t be Visa’s home.' })
  })

  it('needs a key allowed in each ledger added: one that isn’t gets the same 403 for a ledger that doesn’t exist', async () => {
    const w = setup()
    const mine = await w.key('admin', [w.personal])
    const add = await w.unchanged(() => w.sharing({ ledgers: ['personal', 'trip'] }, { headers: mine }))
    expect(add).toMatchObject(refused('This key can’t use “trip”, so it can’t share Visa with it.'))
    expect(await w.sharing({ ledgers: ['personal', 'nope'] }, { headers: mine })).toMatchObject(refused('This key can’t use “nope”, so it can’t share Visa with it.'))
    // The dry run is refused the same way.
    expect(await w.sharing({ ledgers: ['personal', 'trip'] }, { headers: mine, dryRun: true })).toMatchObject(refused('This key can’t use “trip”, so it can’t share Visa with it.'))
    // Under a ledger it can't use at all, like every route.
    expect(await w.sharing({ ledgers: ['family'] }, { in: w.family, headers: mine })).toMatchObject(refused("This API key isn't allowed to use that ledger."))

    // A key for both shares it. A list that changes nothing is fine for the key limited to the home.
    expect((await w.sharing({ ledgers: ['personal', 'family'] }, { headers: await w.key('admin', [w.personal, w.family]) })).status).toBe(200)
    const same = await w.unchanged(() => w.sharing({ ledgers: ['personal', 'family'] }, { headers: mine }))
    expect(same).toMatchObject({ status: 200, body: { added: [], removed: [], home: null } })
  })
})

describe('GET /accounts/:id/sharing with a key limited to some ledgers', () => {
  it('names a ledger the key can’t use without its count or its balance, and keeps the total', async () => {
    const w = await shared(setup(), ['personal', 'family', 'trip'])
    const url = `${w.base(w.personal)}/accounts/${w.visa}/sharing`
    const part = (slug: string, name: string, transactionCount: number | null, balanceMinor: number | null) => ({ slug, name, archived: false, transactionCount, balanceMinor })
    const whole = {
      accountId: w.visa,
      home: part('personal', 'Personal', 2, OPENING - 28_000),
      opening: { slug: 'personal', name: 'Personal' },
      members: [part('family', 'Family', 2, -42_000), part('trip', 'Trip', 0, 0)],
      totalBalanceMinor: OPENING - 70_000,
    }
    // The app and a key for every ledger see it all.
    expect((await w.call('GET', url)).body).toEqual(whole)
    expect((await w.call('GET', url, undefined, await w.key('read'))).body).toEqual(whole)
    expect((await w.call('GET', url, undefined, await w.key('read', [w.personal, w.family, w.trip]))).body).toEqual(whole)
    // A key for the home alone, and one for two of the three.
    const mine = await w.call('GET', url, undefined, await w.key('read', [w.personal]))
    expect(mine.status).toBe(200)
    expect(mine.body).toEqual({ ...whole, members: [part('family', 'Family', null, null), part('trip', 'Trip', null, null)] })
    const two = await w.call('GET', url, undefined, await w.key('read', [w.personal, w.family]))
    expect(two.body).toEqual({ ...whole, members: [whole.members[0], part('trip', 'Trip', null, null)] })

    // A change that takes no ledger out answers the same way: no part of a ledger the key can't use.
    const admin = await w.key('admin', [w.personal])
    const dry = await w.unchanged(() => w.sharing({ ledgers: ['personal', 'family', 'trip'] }, { dryRun: true, headers: admin }))
    expect(dry.status).toBe(200)
    expect(dry.body.sharing).toEqual(mine.body)
    expect(dry.body.parts).toEqual({ before: { personal: OPENING - 28_000 }, after: { personal: OPENING - 28_000 } })
    // After a home change by a key for the old home and the new one, Trip stays a name.
    const moved = await w.sharing({ ledgers: ['personal', 'family', 'trip'], home: 'family' }, { headers: await w.key('admin', [w.personal, w.family]) })
    expect(moved.status).toBe(200)
    expect(moved.body.sharing.home).toEqual(part('family', 'Family', 2, -42_000))
    expect(moved.body.sharing.members).toEqual([part('personal', 'Personal', 2, OPENING - 28_000), part('trip', 'Trip', null, null)])
    expect(moved.body.parts.after).toEqual({ personal: OPENING - 28_000, family: -42_000 })
  })
})

describe('a ledger the account is shared with', () => {
  it('enters transactions by hand on it, which are its own', async () => {
    const w = setup()
    await w.sharing({ ledgers: ['personal', 'family'] })
    const id = await w.spend(w.family, '2026-09-15', -12_000, 'Daycare')
    expect(w.parts()).toEqual({ personal: OPENING, family: -12_000 })
    expect(await w.account(w.family)).toMatchObject({ balanceMinor: -12_000, transactionCount: 1, sharing: { totalBalanceMinor: OPENING - 12_000 } })
    expect(await w.account(w.personal)).toMatchObject({ balanceMinor: OPENING, transactionCount: 0, sharing: { totalBalanceMinor: OPENING - 12_000 } })
    expect(await w.held(w.family)).toEqual([id])
    expect(await w.held(w.personal)).toEqual([])
    // Personal can't read, change or delete it: it's not found there.
    const missing = { status: 404, message: 'Transaction not found' }
    expect(await w.call('GET', `${w.base(w.personal)}/transactions/${id}`)).toMatchObject(missing)
    expect(await w.call('PATCH', `${w.base(w.personal)}/transactions/${id}`, { notes: 'mine now' })).toMatchObject(missing)
    expect(await w.call('DELETE', `${w.base(w.personal)}/transactions/${id}`)).toMatchObject(missing)
    // What only the home does is refused there, naming the home.
    expect(await w.call('PATCH', `${w.base(w.family)}/accounts/${w.visa}`, { name: 'Ours' })).toMatchObject({ status: 409, message: 'Visa’s home is Personal. Its name, type, opening balance and notes are changed there.' })
    expect(await w.call('POST', `${w.base(w.family)}/accounts/${w.visa}/balance`, { date: '2026-10-01', balanceMinor: 0 })).toMatchObject({ status: 409, message: 'Visa’s home is Personal. Its balance is updated there.' })
    const rows = [{ line: 1, date: '2026-09-15', payee: 'Daycare', amountMinor: -12_000 }]
    expect(await w.call('POST', `${w.base(w.family)}/import/preview`, { accountId: w.visa, rows })).toMatchObject({ status: 409, message: 'Visa’s home is Personal. CSV files are imported into it there.' })
    expect(await w.call('DELETE', `${w.base(w.personal)}/accounts/${w.visa}`)).toMatchObject({ status: 409, message: 'Stop sharing Visa first.' })

    // The home's import preview knows Family's row as a duplicate, without its id.
    const preview = await w.call('POST', `${w.base(w.personal)}/import/preview`, { accountId: w.visa, rows: [...rows, { line: 2, date: '2026-09-16', payee: 'New', amountMinor: -500 }] })
    expect(preview.status).toBe(200)
    expect(preview.body.map((r: Json) => [r.duplicateOf, r.duplicateElsewhere])).toEqual([
      [null, true],
      [null, false],
    ])
    expect(JSON.stringify(preview.body)).not.toContain(`"duplicateOf":${id}`)
  })
})

describe('POST /accounts/:id/balance on a shared account', () => {
  it('says with a dry run what recording a balance gives the home and the whole account, and records nothing', async () => {
    const w = await shared()
    const before = w.parts()
    expect(before).toEqual({ personal: OPENING - 28_000, family: -42_000 })
    // −$1,900.00 on 31 Aug: the rows after it come on top (Personal −$80.00, Family −$120.00), and Personal takes the rest.
    const body = { date: '2026-08-31', balanceMinor: -190_000 }
    const dry = await w.unchanged(() => w.call('POST', `${w.base(w.personal)}/accounts/${w.visa}/balance?dryRun=true`, body))
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({ balanceMinor: -168_000, sharing: { totalBalanceMinor: -210_000 } })
    expect(w.parts()).toEqual(before)
    expect((await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/snapshots`)).body).toEqual([])

    const real = await w.call('POST', `${w.base(w.personal)}/accounts/${w.visa}/balance`, body)
    expect(real.body).toMatchObject({ balanceMinor: dry.body.balanceMinor, sharing: { totalBalanceMinor: dry.body.sharing.totalBalanceMinor } })
    expect(w.parts()).toEqual({ personal: -168_000, family: -42_000 })
  })
})

describe('POST /transactions/move', () => {
  it('moves with a dry run first, as the app and with a key for every ledger, and the id is then not found where it was', async () => {
    const w = await shared()
    expect(w.parts()).toEqual({ personal: OPENING - 28_000, family: -42_000 })

    const dry = await w.unchanged(() => w.move(w.personal, [w.p1], 'family', { dryRun: true }))
    expect(dry.status).toBe(200)
    expect(dry.body).toEqual({
      moved: 1,
      carried: 0,
      unlinked: 0,
      unpaired: 0,
      recategorized: 0,
      recurringDetached: 0,
      tagsCreated: 0,
      matched: { refunds: 0, transfers: 0, payments: 0, cleared: 0 },
      dropped: { links: [], partlyLinked: [], pairs: [], recurring: [] },
      dryRun: true,
    })
    expect((await w.call('GET', `${w.base(w.personal)}/transactions/${w.p1}`)).status).toBe(200)

    const done = await w.move(w.personal, [w.p1], 'family', { headers: await w.key('write') })
    expect(done).toMatchObject({ status: 200, body: { moved: 1, dryRun: false } })
    expect(w.parts()).toEqual({ personal: OPENING - 8_000, family: -62_000 })
    expect(await w.call('GET', `${w.base(w.personal)}/transactions/${w.p1}`)).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'Transaction not found' } } })
    expect((await w.call('GET', `${w.base(w.family)}/transactions/${w.p1}`)).body).toMatchObject({ id: w.p1, amountMinor: -20_000, accountId: w.visa })
    // And back, from Family, by its id as well as its slug.
    expect((await w.move(w.family, [w.p1], w.personal.ledger.id)).status).toBe(200)
    expect(w.parts()).toEqual({ personal: OPENING - 28_000, family: -42_000 })
    // Both ledgers' activity says so.
    for (const c of [w.personal, w.family]) {
      const log = (await w.call('GET', `${w.base(c)}/activity?limit=3`)).body.items as Json[]
      expect(log.some((a) => a.action === 'move')).toBe(true)
    }
  })

  it('answers an id another ledger holds like one that doesn’t exist, and refuses what doesn’t fit', async () => {
    const w = await shared()
    const foreign = await w.unchanged(() => w.move(w.personal, [w.f2], 'family'))
    const missing = await w.move(w.personal, [999_999], 'family')
    expect(foreign).toMatchObject({ status: 400, message: `There’s no transaction ${w.f2} in Personal to move.` })
    expect([missing.status, words(missing.message)]).toEqual([foreign.status, words(foreign.message)])
    // One of them not fitting stops them all.
    expect((await w.unchanged(() => w.move(w.personal, [w.p1, w.f2], 'family'))).status).toBe(400)

    expect(await w.move(w.personal, [w.p1], 'trip')).toMatchObject({ status: 400, message: 'Visa isn’t shared with Trip, so Shop (-$200.00 on 2026-08-05) can’t move there.' })
    expect(await w.move(w.personal, [w.p1], 'personal')).toMatchObject({ status: 400, message: 'They’re in Personal already.' })
    expect(await w.move(w.personal, [w.p1], 'nope')).toMatchObject({ status: 400, message: 'There’s no ledger “nope”.' })
    expect((await w.move(w.personal, [], 'family')).status).toBe(400)
    expect((await w.move(w.personal, [w.p1], 'family', { headers: await w.key('read') })).status).toBe(403)
  })

  it('refuses a key limited to one of the two ledgers, either way', async () => {
    const w = await shared()
    const mine = await w.key('write', [w.personal])
    const theirs = await w.key('write', [w.family])
    expect(await w.unchanged(() => w.move(w.personal, [w.p1], 'family', { headers: mine }))).toMatchObject(refused('This key can’t use “family”, so it can’t move transactions there.'))
    expect(await w.move(w.personal, [w.p1], 'family', { headers: mine, dryRun: true })).toMatchObject(refused('This key can’t use “family”, so it can’t move transactions there.'))
    // The same for a ledger that doesn't exist, and for its id.
    expect(await w.move(w.personal, [w.p1], 'nope', { headers: mine })).toMatchObject(refused('This key can’t use “nope”, so it can’t move transactions there.'))
    expect((await w.move(w.personal, [w.p1], w.family.ledger.id, { headers: mine })).status).toBe(403)
    expect(await w.unchanged(() => w.move(w.family, [w.f1], 'personal', { headers: theirs }))).toMatchObject(refused('This key can’t use “personal”, so it can’t move transactions there.'))
    expect(await w.move(w.personal, [w.p1], 'family', { headers: theirs })).toMatchObject(refused("This API key isn't allowed to use that ledger."))
    // A key for the two of them moves.
    expect((await w.move(w.personal, [w.p1], 'family', { headers: await w.key('write', [w.personal, w.family]) })).status).toBe(200)
  })
})

describe('PUT /transactions/:id/split', () => {
  it('splits a card payment with a dry run first, changes it and undoes it', async () => {
    const w = await shared()
    const pay = await w.payment(w.personal, '2026-10-01', 10_000)
    expect(w.parts()).toEqual({ personal: OPENING - 18_000, family: -42_000 })

    const dry = await w.unchanged(() => w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 8_000 }], { dryRun: true }))
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({
      dryRun: true,
      keptMinor: 2_000,
      shares: [{ ledger: { slug: 'family', name: 'Family' }, amountMinor: 8_000 }],
      transaction: { id: pay, amountMinor: 10_000, split: { part: 'payment', keptMinor: 2_000 } },
    })
    expect((await w.call('GET', `${w.base(w.personal)}/transactions/${pay}`)).body.split).toBeNull()

    const done = await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 8_000 }], { headers: await w.key('write') })
    expect(done).toMatchObject({ status: 200, body: { dryRun: false, keptMinor: 2_000 } })
    expect(Object.keys(done.body).sort()).toEqual(['dryRun', 'keptMinor', 'shares', 'transaction'])
    expect(w.parts()).toEqual({ personal: OPENING - 26_000, family: -34_000 })
    // Family has its share, as a payment onto the card, and Personal the row that gives it.
    const theirs = (await w.call('GET', `${w.base(w.family)}/transactions?accountId=${w.visa}&from=2026-10-01`)).body.items as Json[]
    expect(theirs.map((t) => [t.amountMinor, t.split])).toEqual([[8_000, { part: 'share', from: { slug: 'personal', name: 'Personal' } }]])
    const ours = (await w.call('GET', `${w.base(w.personal)}/transactions?accountId=${w.visa}&from=2026-10-01`)).body.items as Json[]
    expect(ours.map((t) => [t.amountMinor, t.split?.part]).sort()).toEqual([
      [-8_000, 'given'],
      [10_000, 'payment'],
    ])
    // A share changes with the split only, and the payment can't move or go while it's split.
    expect((await w.call('PATCH', `${w.base(w.family)}/transactions/${theirs[0].id}`, { amountMinor: 1 })).status).toBe(409)
    expect((await w.call('DELETE', `${w.base(w.family)}/transactions/${theirs[0].id}`)).status).toBe(409)
    expect((await w.call('DELETE', `${w.base(w.personal)}/transactions/${pay}`)).status).toBe(409)
    expect((await w.move(w.personal, [pay], 'family')).status).toBe(400)

    expect((await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 5_000 }])).body.keptMinor).toBe(5_000)
    expect(w.parts()).toEqual({ personal: OPENING - 23_000, family: -37_000 })
    const undone = await w.split(w.personal, pay, [])
    expect(undone).toMatchObject({ status: 200, body: { keptMinor: 10_000, shares: [], transaction: { split: null } } })
    expect(w.parts()).toEqual({ personal: OPENING - 18_000, family: -42_000 })
  })

  it('answers an id another ledger holds like one that doesn’t exist, and only splits a card payment', async () => {
    const w = await shared()
    const pay = await w.payment(w.personal, '2026-10-01', 10_000)
    const shares = [{ ledger: 'family', amountMinor: 8_000 }]
    const foreign = await w.unchanged(() => w.split(w.personal, w.f2, shares))
    const missing = await w.split(w.personal, 999_999, shares)
    expect(foreign).toMatchObject({ status: 400, message: `There’s no transaction ${w.f2} in Personal to split.` })
    expect([missing.status, words(missing.message)]).toEqual([foreign.status, words(foreign.message)])

    expect(await w.split(w.personal, w.p1, shares)).toMatchObject({ status: 400, message: 'Only a card payment can be split.' })
    expect(await w.split(w.personal, pay, [{ ledger: 'trip', amountMinor: 1 }])).toMatchObject({ status: 400, message: 'There’s no ledger “trip” that has Visa.' })
    expect(await w.split(w.personal, pay, [{ ledger: 'nope', amountMinor: 1 }])).toMatchObject({ status: 400, message: 'There’s no ledger “nope” that has Visa.' })
    expect(await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 10_001 }])).toMatchObject({ status: 400, message: 'The shares come to $100.01, more than $100.00 paid.' })
    expect((await w.split(w.personal, pay, shares, { headers: await w.key('read') })).status).toBe(403)
  })

  it('refuses a key that can’t use the holder and every ledger with a share', async () => {
    const w = await shared(setup(), ['personal', 'family', 'trip'])
    const pay = await w.payment(w.personal, '2026-10-01', 10_000)
    const mine = await w.key('write', [w.personal])
    const two = await w.key('write', [w.personal, w.family])
    const cant = (name: string) => refused(`This key can’t use ${name}, so it can’t change how this payment is split.`)
    expect(await w.unchanged(() => w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 8_000 }], { headers: mine }))).toMatchObject(cant('Family'))
    expect(await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 8_000 }], { headers: mine, dryRun: true })).toMatchObject(cant('Family'))
    // A key for Personal and Family splits with Family, and not with Trip.
    expect(await w.unchanged(() => w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 5_000 }, { ledger: 'trip', amountMinor: 1_000 }], { headers: two }))).toMatchObject(cant('Trip'))
    expect((await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 5_000 }], { headers: two })).status).toBe(200)
    // The key for Personal alone can't change it or undo it now: Family's share would change.
    expect(await w.unchanged(() => w.split(w.personal, pay, [], { headers: mine }))).toMatchObject(cant('Family'))
    // Once Trip has a share, the key for two can't change the split either.
    expect((await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 5_000 }, { ledger: 'trip', amountMinor: 1_000 }])).status).toBe(200)
    expect(await w.unchanged(() => w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 6_000 }], { headers: two }))).toMatchObject(cant('Trip'))
    expect(w.parts()).toEqual({ personal: OPENING - 18_000 - 6_000, family: -42_000 + 5_000, trip: 1_000 })
  })
})

describe('what a ledger with a share is told of the payment', () => {
  it('never has the payment’s amount in its activity, whatever happens to its share', async () => {
    const w = await shared(setup(), ['personal', 'family', 'trip'])
    const pay = await w.payment(w.personal, '2026-10-01', 54_321)
    const theirs = await w.key('read', [w.family])
    const activity = async (ctx: AppContext, headers: Headers) => {
      const res = await w.call('GET', `${w.base(ctx)}/activity?limit=200`, undefined, headers)
      expect(res.status).toBe(200)
      // Nothing of the payment another ledger holds: not in a summary, not in what's kept beside it.
      expect(JSON.stringify(res.body)).not.toMatch(/543\.21|54321/)
      return (res.body.items as Json[]).filter((e) => e.action === 'split').map((e) => e.summary as string)
    }
    const family = (amountMinor: number) => [{ ledger: 'family', amountMinor }, { ledger: 'trip', amountMinor: 1_111 }]

    expect((await w.split(w.personal, pay, family(8_000))).status).toBe(200)
    expect((await activity(w.family, theirs))[0]).toBe('Personal gave this ledger a share of $80.00 of its payment onto Visa on 2026-10-01')
    // The holder's own log has it in full.
    expect((await w.call('GET', `${w.base(w.personal)}/activity?entity=transaction&limit=1`)).body.items[0].summary).toBe(
      'Split the $543.21 payment onto Visa on 2026-10-01: Family $80.00, Trip $11.11, and Personal keeps $452.10',
    )
    expect((await w.split(w.personal, pay, family(9_000))).status).toBe(200)
    expect((await activity(w.family, theirs))[0]).toBe('Personal changed this ledger’s share of its payment onto Visa on 2026-10-01 from $80.00 to $90.00')
    expect((await w.split(w.personal, pay, [{ ledger: 'trip', amountMinor: 1_111 }])).status).toBe(200)
    expect((await activity(w.family, theirs))[0]).toBe('Personal took back this ledger’s share of $90.00 of its payment onto Visa on 2026-10-01')
    expect((await w.split(w.personal, pay, family(8_000))).status).toBe(200)
    expect((await w.split(w.personal, pay, [])).status).toBe(200)
    expect((await activity(w.family, theirs))[0]).toBe('Personal undid the split of its payment onto Visa on 2026-10-01, and this ledger’s share of $80.00 with it')

    // A share can't move: the refusal names the payment by its account, date and holder.
    expect((await w.split(w.personal, pay, family(8_000))).status).toBe(200)
    const share = ((await w.call('GET', `${w.base(w.family)}/transactions?accountId=${w.visa}&from=2026-10-01`, undefined, theirs)).body.items as Json[])[0].id as number
    expect(await w.move(w.family, [share], 'trip', { headers: await w.key('write', [w.family, w.trip]) })).toMatchObject({
      status: 400,
      message: 'Undo the split of the payment onto Visa on 2026-10-01 in Personal first.',
    })

    // Trip stops sharing and keeps its rows: its share is an ordinary transaction of its own.
    const stop = await w.sharing({ ledgers: ['personal', 'family'], rows: { trip: 'keep' } })
    expect(stop.status, stop.message).toBe(200)
    expect(stop.body.notices[0]).toBe('Trip’s share of $11.11 of Personal’s payment on 2026-10-01 is an ordinary transaction now, and so is what Personal gave for it. No balance changes.')
    expect((await activity(w.trip, await w.key('read', [w.trip])))[0]).toBe('This ledger’s share of $11.11 of Personal’s payment onto Visa on 2026-10-01 is its own transaction now')
    // What the home keeps of it names the payment, which is its own.
    const kept = (await w.call('GET', `${w.base(w.personal)}/activity?entity=account&limit=1`)).body.items[0]
    expect(kept.after.splits).toEqual([{ done: 'detachedShare', holder: { slug: 'personal', name: 'Personal' }, date: '2026-10-01', paymentMinor: 54_321, amountMinor: 1_111, currency: 'CAD' }])

    // Family is erased and its rows deleted: its share goes back, and what was done is kept in its log.
    const erased = await w.call('POST', `${w.base(w.family)}/erase`, { confirm: 'erase', answers: { [`rows:${w.visa}`]: 'delete' } })
    expect(erased.status, erased.message).toBe(200)
    expect(erased.body.changes[0]).toBe('Family’s share of $80.00 of Personal’s payment on 2026-10-01 goes back to Personal.')
    expect((await activity(w.family, theirs))[0]).toBe('Personal took back this ledger’s share of $80.00 of its payment onto Visa on 2026-10-01')
    const log = (await w.call('GET', `${w.base(w.family)}/activity?entity=ledger&limit=1`, undefined, theirs)).body.items[0]
    expect(log.after.changes).toEqual(erased.body.changes)
  })
})

describe('GET /accounts/:id/transactions', () => {
  it('lists every ledger’s transactions with the account’s running total, from any ledger that has it', async () => {
    const w = await shared()
    const pay = await w.payment(w.personal, '2026-10-01', 10_000)
    await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 8_000 }])
    const total = OPENING - 70_000 + 10_000
    for (const [ctx, headers] of [[w.personal, undefined], [w.family, await w.key('read')]] as const) {
      const res = await w.call('GET', `${w.base(ctx)}/accounts/${w.visa}/transactions`, undefined, headers)
      expect(res.status).toBe(200)
      const items = res.body.items as Json[]
      expect(items.map((t) => [t.id, t.ledger.slug, t.here, t.amountMinor, t.balanceAfterMinor])).toEqual([
        [pay, 'personal', ctx === w.personal, 10_000, total],
        [w.p2, 'personal', ctx === w.personal, -8_000, total - 10_000],
        [w.f2, 'family', ctx === w.family, -12_000, total - 2_000],
        [w.f1, 'family', ctx === w.family, -30_000, total + 10_000],
        [w.p1, 'personal', ctx === w.personal, -20_000, total + 40_000],
      ])
      expect(items[0].split).toEqual({ keptMinor: 2_000, shares: [{ ledger: { slug: 'family', name: 'Family' }, amountMinor: 8_000 }] })
      expect(items[2]).toMatchObject({ payee: 'Daycare', category: 'Groceries' })
      // Names only: no ids of the other ledger's categories or tags.
      expect(Object.keys(items[2]).sort()).toEqual(
        ['amountMinor', 'balanceAfterMinor', 'category', 'currency', 'date', 'datetime', 'here', 'id', 'ledger', 'name', 'notes', 'origin', 'payee', 'payeeName', 'split', 'status'].sort(),
      )
      expect(res.body.nextCursor).toBeNull()
    }
    // In pages, and between dates.
    const first = await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/transactions?limit=2`)
    expect(first.body.items.map((t: Json) => t.id)).toEqual([pay, w.p2])
    const next = await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/transactions?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
    expect(next.body.items.map((t: Json) => t.id)).toEqual([w.f2, w.f1])
    const august = await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/transactions?from=2026-08-01&to=2026-08-31`)
    expect(august.body.items.map((t: Json) => t.id)).toEqual([w.f1, w.p1])
    expect((await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/transactions?limit=501`)).status).toBe(400)

    expect(await w.call('GET', `${w.base(w.personal)}/accounts/${w.chequing}/transactions`)).toMatchObject({ status: 409, message: 'Chequing isn’t shared, so all its transactions are in this ledger.' })
    expect(await w.call('GET', `${w.base(w.trip)}/accounts/${w.visa}/transactions`)).toMatchObject({ status: 404, message: 'Account not found' })
  })

  it('is only for a key allowed in every ledger that has the account, which still sees the total and the names beside its part', async () => {
    const w = await shared(setup(), ['personal', 'family', 'trip'])
    const cant = refused('This key can’t see every ledger that has Visa')
    const mine = await w.key('read', [w.personal])
    const two = await w.key('read', [w.personal, w.family])
    expect(await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/transactions`, undefined, mine)).toMatchObject(cant)
    expect(await w.call('GET', `${w.base(w.family)}/accounts/${w.visa}/transactions`, undefined, two)).toMatchObject(cant)
    expect((await w.call('GET', `${w.base(w.trip)}/accounts/${w.visa}/transactions`, undefined, await w.key('read', [w.personal, w.family, w.trip]))).status).toBe(200)

    // Its part, the account's total and every ledger's name.
    const a = await w.account(w.personal, mine)
    expect(a).toMatchObject({
      balanceMinor: OPENING - 28_000,
      sharing: { isHome: true, totalBalanceMinor: OPENING - 70_000, ledgers: [{ slug: 'personal', name: 'Personal' }, { slug: 'family', name: 'Family' }, { slug: 'trip', name: 'Trip' }] },
    })
    // Never another ledger's row: not in its lists, not by id, not in its reports or its export.
    expect(await w.held(w.personal, mine)).toEqual([w.p1, w.p2])
    for (const id of [w.f1, w.f2]) expect((await w.call('GET', `${w.base(w.personal)}/transactions/${id}`, undefined, mine)).status).toBe(404)
    const csv = (await w.call('GET', `${w.base(w.personal)}/export/transactions.csv`, undefined, mine)).body as string
    expect(csv).toContain('Shop')
    expect(csv).not.toMatch(/Daycare|,Grocer,/)
    const everywhere = await w.call('GET', `${w.base(w.personal)}/transactions?q=Daycare`, undefined, mine)
    expect(everywhere.body.items).toEqual([])
    expect((await w.call('GET', `${w.base(w.family)}/transactions`, undefined, mine)).status).toBe(403)
  })
})

describe('changing the home over HTTP', () => {
  it('makes another ledger the home with a dry run first, and the old home answers 409 from then on', async () => {
    const w = await shared()
    const before = w.parts()
    const dry = await w.unchanged(() => w.sharing({ ledgers: ['personal', 'family'], home: 'family' }, { dryRun: true }))
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({
      dryRun: true,
      home: { from: { slug: 'personal', name: 'Personal' }, to: { slug: 'family', name: 'Family' } },
      added: [],
      removed: [],
      notices: ['Family is the home from now on. Personal keeps Visa’s opening balance, and differences with the bank still land in Personal.'],
    })
    expect((await w.account(w.personal)).sharing.isHome).toBe(true)

    const done = await w.sharing({ ledgers: ['personal', 'family'], home: 'family' }, { headers: await w.key('admin') })
    expect(done).toMatchObject({ status: 200, body: { dryRun: false, sharing: { home: { slug: 'family' }, opening: { slug: 'personal' }, members: [{ slug: 'personal' }] } } })
    expect(w.parts()).toEqual(before)
    expect(await w.account(w.family)).toMatchObject({ sharing: { isHome: true, home: { slug: 'family' }, opening: { slug: 'personal' } } })
    expect(await w.account(w.personal)).toMatchObject({ balanceMinor: before.personal, openingBalanceMinor: 0, sharing: { isHome: false } })
    // Sharing is the new home's to change.
    const elsewhere = { status: 409, message: 'Visa’s home is Family. Its sharing is changed there.' }
    expect(await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}/sharing`)).toMatchObject(elsewhere)
    expect(await w.sharing({ ledgers: ['personal', 'family'], home: 'personal' })).toMatchObject(elsewhere)
    // And back, with the old home taken out in the same request as a home change the other way.
    expect((await w.sharing({ ledgers: ['personal', 'family'], home: 'personal' }, { in: w.family })).status).toBe(200)
    const out = await w.sharing({ ledgers: ['family'], home: 'family', rows: { personal: 'home' } })
    expect(out).toMatchObject({ status: 200, body: { home: { to: { slug: 'family' } }, removed: [{ ledger: { slug: 'personal' }, rows: 'home', moved: 2 }], opening: { from: { slug: 'personal' }, to: { slug: 'family' } } } })
    expect((await w.call('GET', `${w.base(w.personal)}/accounts/${w.visa}`)).status).toBe(404)
    expect(expectPartsSumToAccount(w.storage, w.visa).parts).toEqual({ family: OPENING - 70_000 })
  })

  it('needs a key allowed in the new home', async () => {
    const w = await shared()
    const mine = await w.key('admin', [w.personal])
    const res = await w.unchanged(() => w.sharing({ ledgers: ['personal', 'family'], home: 'family' }, { headers: mine }))
    expect(res).toMatchObject(refused('This key can’t use Family, so it can’t make it Visa’s home.'))
    expect((await w.sharing({ ledgers: ['personal', 'family'], home: 'family' }, { headers: mine, dryRun: true })).status).toBe(403)
    expect((await w.sharing({ ledgers: ['personal', 'family'], home: 'family' }, { headers: await w.key('admin', [w.personal, w.family]) })).status).toBe(200)
  })
})

describe('stopping sharing over HTTP', () => {
  it('asks where the ledger’s transactions go, and sends them home with a dry run first', async () => {
    const w = await shared()
    expect(await w.unchanged(() => w.sharing({ ledgers: ['personal'] }))).toMatchObject({ status: 400, message: 'Say whether Family’s 2 transactions go home or stay in Family.' })
    expect(await w.sharing({ ledgers: ['personal'], rows: { family: 'away' } })).toMatchObject({ status: 400, message: 'Say “home” or “keep” for Family’s transactions.' })

    const dry = await w.unchanged(() => w.sharing({ ledgers: ['personal'], rows: { family: 'home' } }, { dryRun: true }))
    expect(dry.status).toBe(200)
    expect(dry.body).toMatchObject({
      dryRun: true,
      removed: [{ ledger: { slug: 'family', name: 'Family' }, rows: 'home', moved: 2, sentAsDeleted: 0, kept: 0, account: null, splits: [] }],
      opening: null,
      parts: { before: { personal: OPENING - 28_000, family: -42_000 }, after: { personal: OPENING - 70_000 } },
      sharing: { members: [], totalBalanceMinor: OPENING - 70_000 },
    })

    const done = await w.sharing({ ledgers: ['personal'], rows: { family: 'home' } }, { headers: await w.key('admin') })
    expect(done).toMatchObject({ status: 200, body: { dryRun: false, removed: [{ moved: 2 }] } })
    expect((await w.call('GET', `${w.base(w.family)}/accounts`)).body).toEqual([])
    expect(await w.account(w.personal)).toMatchObject({ balanceMinor: OPENING - 70_000, transactionCount: 4, sharing: null })
    expect(await w.held(w.personal)).toEqual([w.p1, w.p2, w.f1, w.f2].sort((a, b) => a - b))
    expect((await w.call('GET', `${w.base(w.family)}/transactions/${w.f2}`)).status).toBe(404)
    expectNoCrossLedgerReferences(w.storage)
    // Nothing of Family names the account, so the ledger and the account can both go.
    expect((await w.call('DELETE', '/ledgers/family', { confirm: 'Family' })).status).toBe(200)
    expect((await w.call('DELETE', `${w.base(w.personal)}/accounts/${w.visa}`)).status).toBe(204)
  })

  it('keeps them in the ledger on an account of its own, with a dry run first', async () => {
    const w = await shared()
    const dry = await w.unchanged(() => w.sharing({ ledgers: ['personal'], rows: { family: 'keep' } }, { dryRun: true }))
    expect(dry.status).toBe(200)
    expect(dry.body.removed).toMatchObject([{ ledger: { slug: 'family' }, rows: 'keep', moved: 0, kept: 2, account: { name: 'Visa', balanceMinor: -42_000 } }])
    expect(dry.body.parts).toEqual({ before: { personal: OPENING - 28_000, family: -42_000 }, after: { personal: OPENING - 70_000 } })
    expect(dry.body.notices).toEqual([
      'Family’s new account keeps its balance of $420.00 owed, and Visa’s total doesn’t go down by it, so that amount is also in Personal until you record how it was settled.',
    ])
    expect((await w.account(w.family)).sharing).not.toBeNull()

    const done = await w.sharing({ ledgers: ['personal'], rows: { family: 'keep' } })
    expect(done.status).toBe(200)
    const own = done.body.removed[0].account.id as number
    expect(own).not.toBe(w.visa)
    expect(await w.account(w.family, undefined, own)).toMatchObject({ name: 'Visa', balanceMinor: -42_000, transactionCount: 2, sharing: null, bank: null })
    expect((await w.call('GET', `${w.base(w.family)}/accounts/${w.visa}`)).status).toBe(404)
    expect((await w.call('GET', `${w.base(w.family)}/transactions/${w.f2}`)).body).toMatchObject({ id: w.f2, accountId: own })
    // Visa's total is the whole balance again, all of it Personal's.
    expect(await w.account(w.personal)).toMatchObject({ balanceMinor: OPENING - 70_000, transactionCount: 2, sharing: null })
    expectNoCrossLedgerReferences(w.storage)
  })

  it('needs a key allowed in every ledger that has the account, before anything is said of the ledger’s transactions', async () => {
    const w = await shared(setup(), ['personal', 'family', 'trip'])
    const cant = (name: string) => refused(`This key can’t use every ledger that has Visa, so it can’t stop sharing it with ${name}. Do it in the app.`)
    const mine = await w.key('admin', [w.personal])
    const two = await w.key('admin', [w.personal, w.family])
    // Without `rows`, the app is told how many transactions Family has: the key isn't.
    expect(await w.unchanged(() => w.sharing({ ledgers: ['personal', 'trip'] }, { headers: mine }))).toMatchObject(cant('Family'))
    expect(await w.sharing({ ledgers: ['personal', 'trip'], rows: { family: 'home' } }, { headers: mine, dryRun: true })).toMatchObject(cant('Family'))
    // Trip has nothing on it, and still every ledger that has the account counts: a split let go of can write in any.
    expect(await w.unchanged(() => w.sharing({ ledgers: ['personal', 'family'] }, { headers: mine }))).toMatchObject(cant('Trip'))
    expect(await w.unchanged(() => w.sharing({ ledgers: ['personal', 'family'] }, { headers: two }))).toMatchObject(cant('Trip'))
    expect(await w.unchanged(() => w.sharing({ ledgers: ['personal'], rows: { family: 'keep' } }, { headers: two }))).toMatchObject(cant('Family'))

    const all = await w.key('admin', [w.personal, w.family, w.trip])
    expect((await w.sharing({ ledgers: ['personal', 'family'] }, { headers: all })).status).toBe(200)
    // Now the key for the two that have it can end the sharing.
    expect((await w.sharing({ ledgers: ['personal'], rows: { family: 'home' } }, { headers: two })).status).toBe(200)
    expect((await w.account(w.personal)).sharing).toBeNull()
  })
})

describe('the bank and a shared account over HTTP', () => {
  /** A bank account syncing into Personal's chequing, and one syncing nowhere, kept from a sync. */
  function banked(w: World) {
    const db = w.storage.app.db
    db.insert(bankConnections).values({ id: 'bank', provider: 'simplefin', name: 'The bank', secret: w.storage.secrets.seal('{}') }).run()
    const fetchedAt = '2026-10-03T12:00:00.000Z'
    db.insert(bankAccounts).values({ id: 'bank-chequing', connectionId: 'bank', remoteId: 'c', name: 'Chequing', currency: 'CAD', accountId: w.chequing, fetchedAt }).run()
    db.insert(bankAccounts).values({ id: 'bank-card', connectionId: 'bank', remoteId: 'v', name: 'Card', currency: 'CAD', fetchedAt }).run()
    const remote = { remoteId: 'v1', date: '2026-08-01', amountMinor: -100, payee: 'OLD', description: 'OLD', pending: false }
    keepTransactions(w.storage.app, 'bank-card', { transactions: [remote], window: null, removed: [] }, fetchedAt)
  }

  it('reviews and switches only for a caller allowed in every ledger that has it, and marks other ledgers’ rows and split payments', async () => {
    const w = await shared()
    banked(w)
    const pay = await w.payment(w.personal, '2026-10-01', 10_000)
    await w.split(w.personal, pay, [{ ledger: 'family', amountMinor: 8_000 }])
    const url = `${w.base(w.personal)}/accounts/${w.visa}/bank`

    // A key limited to Personal can use the bank account that already syncs into it, and still not for a shared account.
    const mine = await w.key('write', [w.personal])
    const cant = refused('A key limited to some ledgers can’t switch a shared account. Do it in the app.')
    expect(await w.unchanged(() => w.call('POST', `${url}/preview`, { bankAccountId: 'bank-chequing' }, mine))).toMatchObject(cant)
    expect(await w.unchanged(() => w.call('PUT', url, { bankAccountId: 'bank-chequing' }, mine))).toMatchObject(cant)
    const body = { bankAccountId: 'bank-chequing', from: '2026-08-01', version: 'x', pairs: [], skip: [], remove: [w.f1] }
    expect(await w.unchanged(() => w.call('POST', `${url}/switch`, body, mine))).toMatchObject(cant)
    // In a ledger it's shared with, it's the home's to do.
    expect(await w.call('POST', `${w.base(w.family)}/accounts/${w.visa}/bank/preview`, { bankAccountId: 'bank-card' })).toMatchObject({ status: 409, message: 'Visa’s home is Personal. Its bank sync is set up there.' })

    // The app's review shows each row with the ledger that holds it, and the split payment as one.
    const preview = await w.call('POST', `${url}/preview`, { bankAccountId: 'bank-card', from: '2026-08-01' })
    expect(preview.status).toBe(200)
    const local = (preview.body.rows as Json[]).flatMap((r) => (r.local ? [r.local] : []))
    expect(local.map((l) => [l.id, l.elsewhere?.ledger.slug ?? null, l.split]).sort((a, b) => a[0] - b[0])).toEqual(
      [
        [w.p1, null, false],
        [w.p2, null, false],
        [w.f1, 'family', false],
        [w.f2, 'family', false],
        [pay, null, true],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    )
    // Removing the split payment is refused before anything changes.
    const remove = await w.unchanged(() => w.call('POST', `${url}/switch`, { bankAccountId: 'bank-card', from: preview.body.from, version: preview.body.version, pairs: [], skip: [], remove: [pay] }))
    expect(remove.status).toBe(409)
    expect(remove.message).toBe('Undo the split of the $100.00 payment onto Visa on 2026-10-01 first.')
  })

  it('deletes a split-off account only with a key allowed in the home of the account it was split off from, which keeps its bank ids', async () => {
    const card: FakeCard = { balance: '-150.00', transactions: [fakeTx('b1', '2026-09-28', '-100.00', 'Grocer'), fakeTx('b2', '2026-09-30', '-50.00', 'Cafe')] }
    const w = setup({ fetch: fakeBridge(card) })
    const conn = await w.call('POST', '/bank/connections', { setupToken: TOKEN })
    const bankAccountId = (conn.body.accounts as Json[]).find((a) => a.remoteId === 'visa').id as string
    expect((await w.call('PUT', `${w.base(w.personal)}/accounts/${w.visa}/bank`, { bankAccountId })).status).toBe(200)
    expect((await w.sharing({ ledgers: ['personal', 'family'] })).status).toBe(200)
    const sync = () => w.call('POST', `/bank/connections/${conn.body.id}/sync`)
    expect((await sync()).body).toMatchObject({ ok: true })
    expect((await w.move(w.personal, await w.held(w.personal), 'family')).status).toBe(200)
    // Family stops sharing and keeps its two synced rows on an account of its own.
    const stop = await w.sharing({ ledgers: ['personal'], rows: { family: 'keep' } })
    expect(stop.status, stop.message).toBe(200)
    const own = stop.body.removed[0].account.id as number
    const url = `${w.base(w.family)}/accounts/${own}`
    const bankIds = () => w.personal.q.column<string>('SELECT external_id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND bank_id_only = 1 ORDER BY external_id', w.visa)
    const latest = async () => (await w.call('GET', `${w.base(w.personal)}/activity?limit=1`)).body.items[0] as Json

    // Deleting it leaves its bank ids on Visa, in Personal: a key for Family alone can't.
    const theirs = await w.key('write', [w.family])
    const before = await latest()
    expect(await w.unchanged(() => w.call('DELETE', url, undefined, theirs))).toMatchObject(
      refused('Family’s Visa was split off from Personal’s Visa, which keeps its bank ids. This key can’t use Personal, so it can’t delete Visa. Do it in the app.'),
    )
    expect(bankIds()).toEqual([])
    expect(await latest()).toEqual(before)
    // It still reads and changes the account, which is its own.
    expect((await w.call('PATCH', url, { name: 'Old Visa' }, theirs)).status).toBe(200)

    // A key for both ledgers can, and Personal's log says what Visa keeps.
    expect((await w.call('DELETE', url, undefined, await w.key('write', [w.personal, w.family]))).status).toBe(204)
    expect(bankIds()).toEqual(['b1', 'b2'])
    expect(await latest()).toMatchObject({
      actor: 'write personal+family',
      action: 'update',
      entity: 'account',
      entityId: String(w.visa),
      summary: 'Family’s Old Visa, split off from Visa, was deleted: Visa keeps the bank ids of its 2 transactions',
      after: { bankIds: 2 },
    })
    // So a sync adds nothing again.
    expect((await sync()).body).toMatchObject({ ok: true })
    expect([await w.held(w.personal), await w.held(w.family)]).toEqual([[], []])
    expect((await w.call('GET', `${w.base(w.family)}/accounts`)).body).toEqual([])
  })

  it('syncs with a key for the home alone, wherever the rows are held', async () => {
    const card: FakeCard = {
      balance: '-150.00',
      transactions: [fakeTx('b1', '2026-09-28', '-100.00', 'Grocer'), fakeTx('b2', '2026-09-30', '-50.00', 'Cafe', { pending: true })],
    }
    const w = setup({ fetch: fakeBridge(card) })
    const conn = await w.call('POST', '/bank/connections', { setupToken: TOKEN })
    expect(conn.status, conn.message).toBe(201)
    const bankAccountId = (conn.body.accounts as Json[]).find((a) => a.remoteId === 'visa').id as string
    expect((await w.call('PUT', `${w.base(w.personal)}/accounts/${w.visa}/bank`, { bankAccountId })).status).toBe(200)
    expect((await w.sharing({ ledgers: ['personal', 'family'] })).status).toBe(200)
    const sync = (headers?: Headers, history = false) => w.call('POST', `/bank/connections/${conn.body.id}/${history ? 'fetch-history' : 'sync'}`, undefined, headers)
    expect((await sync()).body).toMatchObject({ ok: true })
    const ids = await w.held(w.personal)
    expect(ids).toHaveLength(2)
    expect((await w.move(w.personal, ids, 'family')).status).toBe(200)
    expect(w.parts()).toEqual({ personal: 0, family: -15_000 })

    // The pending one posts, at another amount: the key limited to the home syncs, and Family's row changes in place.
    card.transactions[1] = fakeTx('b2', '2026-09-30', '-55.00', 'Cafe')
    card.balance = '-155.00'
    const mine = await w.key('write', [w.personal])
    const synced = await sync(mine)
    expect(synced.status, synced.message).toBe(200)
    expect(synced.body).toMatchObject({ ok: true })
    expect(await w.held(w.personal)).toEqual([])
    const theirs = (await w.call('GET', `${w.base(w.family)}/transactions?accountId=${w.visa}`)).body.items as Json[]
    expect(theirs.map((t) => [t.id, t.amountMinor, t.status]).sort((a, b) => a[0] - b[0])).toEqual([
      [ids[0], -10_000, 'cleared'],
      [ids[1], -5_500, 'cleared'],
    ])
    expect(w.parts()).toEqual({ personal: 0, family: -15_500 })
    expect((await w.account(w.personal, mine)).sharing.totalBalanceMinor).toBe(-15_500)
    // Fetch history adds nothing twice, with the same key.
    expect((await sync(mine, true)).body).toMatchObject({ ok: true })
    expect((await w.held(w.family)).length + (await w.held(w.personal)).length).toBe(2)
    // A key limited to Family can't: the connection syncs into Personal.
    expect(await sync(await w.key('write', [w.family]))).toMatchObject(refused('This connection syncs into ledgers this API key can’t use.'))
  })
})
