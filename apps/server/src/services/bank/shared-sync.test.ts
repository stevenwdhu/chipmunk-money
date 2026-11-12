import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { transactionCreateSchema } from '@chipmunk/shared'
import { bankTransactions } from '../../db/schema'
import { repoRoot } from '../../env'
import { runDailyJobs } from '../../jobs'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER, type SharedWorld } from '../../test/shared-accounts'
import { ledgerRows } from '../../test/world'
import type { AppContext } from '../context'
import { matchTransactions } from '../matching'
import { moveTransactions } from '../moves'
import { changeHome } from '../sharing'
import { createTransaction, deleteTransaction, findByExternalId, getTransaction, restoreTransaction } from '../transactions'
import { applyRemoteTransactions, latestBankPayload, type ApplyScope } from './apply'
import { BankService } from './service'
import type { RemoteTransaction } from './types'

// The real matching, its calls recorded: which ledgers a sync settles.
vi.mock('../matching', async (importOriginal) => {
  const real = await importOriginal<typeof import('../matching')>()
  return { ...real, matchTransactions: vi.fn(real.matchTransactions) }
})

/**
 * Bank sync on a shared account: Personal is Visa's home, where its bank link is, and Family has it.
 * The rows Family holds got there by a real move, and each sync must find them where they are.
 */

// A fake SimpleFIN Bridge, with one card ------------------------------------------

interface FakeTx {
  id: string
  posted: number
  transacted_at: number
  amount: string
  description: string
  payee: string
  pending?: boolean
}

const at = (date: string) => Math.floor(Date.parse(`${date}T16:00:00Z`) / 1000)
const tx = (id: string, date: string, amount: string, payee: string, opts: { pending?: boolean } = {}): FakeTx => ({
  id,
  posted: opts.pending ? 0 : at(date),
  transacted_at: at(date),
  amount,
  description: payee.toUpperCase(),
  payee,
  ...(opts.pending ? { pending: true } : {}),
})

function fakeBridge(card: { balance: string; transactions: FakeTx[] }) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (/\/simplefin\/claim\/\w+$/.test(url.pathname) && init?.method === 'POST') return new Response('https://user%40x:s3cret@bridge.test/simplefin')
    if (url.pathname !== '/simplefin/accounts') return new Response('not found', { status: 404 })
    const start = Number(url.searchParams.get('start-date') ?? 0)
    const end = Number(url.searchParams.get('end-date') ?? Infinity)
    return Response.json({
      errlist: [],
      connections: [{ conn_id: 'CON-1', name: 'TD - Me', org_name: 'TD Canada Trust', org_id: 'td' }],
      accounts: [
        {
          id: 'visa',
          name: 'Visa',
          conn_id: 'CON-1',
          currency: 'CAD',
          balance: card.balance,
          'balance-date': at('2026-10-03'),
          transactions: url.searchParams.get('balances-only') === '1' ? undefined : card.transactions.filter((t) => t.transacted_at >= start && t.transacted_at < end),
        },
      ],
    })
  }) as typeof globalThis.fetch
}

const TOKEN = Buffer.from('https://bridge.test/simplefin/claim/TOKEN1').toString('base64')

/** A transaction as a provider hands it over. */
const remote = (remoteId: string, date: string, amountMinor: number, payee: string, more: Partial<RemoteTransaction> = {}): RemoteTransaction => ({
  remoteId,
  date,
  amountMinor,
  payee,
  description: payee.toUpperCase(),
  pending: false,
  raw: { remoteId, date, amountMinor, payee, ...more },
  ...more,
})

interface Row {
  ledger: string
  id: number
  externalId: string | null
  date: string
  amount: number
  payee: string
  status: string
  origin: string
  deleted: number
  removedAt: string | null
}

function world(w: SharedWorld) {
  const ledgers = [w.personal, w.family, w.trip]
  /** Visa's rows in every ledger, deleted ones too. */
  const rows = (): Row[] =>
    ledgers.flatMap((c) =>
      c.q
        .all<Omit<Row, 'ledger'>>(
          `SELECT id, external_id AS externalId, date, amount_minor AS amount, payee, status, origin, deleted_at IS NOT NULL AS deleted, removed_at AS removedAt
           FROM transactions WHERE ledger_id = @ledger AND account_id = ? ORDER BY id`,
          w.visa,
        )
        .map((r) => ({ ledger: c.ledger.slug, ...r })),
    )
  const row = (externalId: string) => rows().find((r) => r.externalId === externalId)
  /** Where each bank id is: the ledger's slug, and whether the row is deleted. */
  const where = () => Object.fromEntries(rows().flatMap((r) => (r.externalId ? [[r.externalId, `${r.ledger}${r.deleted ? ' (deleted)' : ''}`]] : [])))
  const move = (from: AppContext, externalIds: string[], to: AppContext) =>
    moveTransactions(from, w.ctxOf, { ids: externalIds.map((x) => row(x)!.id), to: to.ledger.id }, TESTER)
  const activity = () => Object.fromEntries(ledgers.map((c) => [c.ledger.slug, c.q.column<string>('SELECT summary FROM activity WHERE ledger_id = @ledger ORDER BY id')]))
  const opening = () => w.personal.accountWide.account(w.visa)!
  /** What every sync must leave: the parts sum to the account, nothing refers across ledgers, and each bank id is on one row. */
  const check = () => {
    expectPartsSumToAccount(w.storage, w.visa)
    expectNoCrossLedgerReferences(w.storage)
    const ids = rows().flatMap((r) => (r.externalId ? [r.externalId] : []))
    expect(ids.length, 'each bank id once on the account, across its ledgers').toBe(new Set(ids).size)
  }
  return { rows, row, where, move, activity, opening, check }
}

/** Visa linked to the fake bridge in Personal, and synced once. */
async function synced(card: { balance: string; transactions: FakeTx[] }) {
  const w = sharedWorld({ fetch: fakeBridge(card) })
  const bank = new BankService(w.storage)
  const conn = await bank.connect({ setupToken: TOKEN })
  const bankAccountId = conn.accounts.find((a) => a.remoteId === 'visa')!.id
  bank.linkAccount(w.personal, w.visa, { bankAccountId })
  const sync = async (opts: { full?: boolean } = {}) => {
    const result = await bank.sync(conn.id, opts)
    expect(result.ok, result.error ?? '').toBe(true)
    return result.accounts[0]!
  }
  await sync()
  return { ...w, ...world(w), card, bank, bankAccountId, sync }
}

/** Applied to Visa in its home as Plaid's changes. */
const plaid = (w: SharedWorld, changed: RemoteTransaction[], removed: Array<{ remoteId: string; raw?: unknown }> = []) =>
  applyRemoteTransactions(w.personal, w.ctxOf, w.visa, changed, { removed, floor: null }, 'plaid')

/** A 409 with this message, and no transaction id in it. */
function conflict(fn: () => unknown, message: string) {
  let error: unknown
  try {
    fn()
  } catch (err) {
    error = err
  }
  expect(error, 'refused').toMatchObject({ status: 409, message })
}

describe('bank sync on a shared account', () => {
  it('adds nothing and changes nothing after a move, a full re-send and a new link, with the bank unchanged', async () => {
    const card = {
      balance: '-400.00',
      transactions: [tx('a1', '2026-09-28', '-50.00', 'Corner Cafe'), tx('a2', '2026-09-29', '-30.00', 'Book Shop'), tx('a3', '2026-09-30', '-70.00', 'Gas Bar')],
    }
    const w = await synced(card)
    // The bank's balance less the rows went into the opening balance at the first sync.
    expect(w.opening()).toMatchObject({ openingBalanceMinor: -25000, recorded: null })
    w.move(w.personal, ['a2', 'a3'], w.family)
    expect(w.where()).toEqual({ a1: 'personal', a2: 'family', a3: 'family' })
    w.check()

    const everything = () => [w.personal, w.family, w.trip].map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
    const before = everything()
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    // Fetch history: everything sent again.
    expect(await w.sync({ full: true })).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    // What a new link takes in, from what was kept: nothing new either, and its opening date goes back to the oldest row, wherever it is.
    w.bank.unlinkAccount(w.personal, w.visa)
    w.bank.linkAccount(w.personal, w.visa, { bankAccountId: w.bankAccountId })
    expect(w.bank.fill(w.personal, w.visa)).toEqual({ added: 0, adopted: 0 })
    // No new row, no opening balance change, no recorded balance, no activity.
    expect(everything()).toEqual(before)
    expect(w.opening()).toMatchObject({ openingBalanceMinor: -25000, recorded: null })

    // Its oldest row is Family's: the opening date moves back to it.
    w.personal.q.run("UPDATE accounts SET opening_date = '2026-09-30' WHERE id = ? AND ledger_id = @ledger", w.visa)
    w.move(w.personal, ['a1'], w.family)
    w.bank.unlinkAccount(w.personal, w.visa)
    w.bank.linkAccount(w.personal, w.visa, { bankAccountId: w.bankAccountId })
    expect(w.bank.fill(w.personal, w.visa)).toEqual({ added: 0, adopted: 0 })
    expect(w.opening().openingDate).toBe('2026-09-28')
    expect(w.personal.accountWide.firstDate(w.visa)).toBe('2026-09-28')

    // A moved row's payload is the account's: found by the account and its bank id, pointing at no row.
    expect(latestBankPayload(w.family, w.row('a2')!.id)).toMatchObject({ provider: 'simplefin', remoteId: 'a2', event: 'added' })
    w.check()
  })

  it('updates a moved pending charge that posts where it is, and settles and logs it there (SimpleFIN)', async () => {
    const w = await synced({ balance: '-40.00', transactions: [tx('p1', '2026-09-30', '-40.00', 'Corner Cafe', { pending: true })] })
    w.move(w.personal, ['p1'], w.family)
    const pending = w.row('p1')!
    const before = w.activity()
    vi.mocked(matchTransactions).mockClear()

    // Posted with the tip, under a new id.
    w.card.transactions = [tx('c1', '2026-10-01', '-46.00', 'Corner Cafe')]
    w.card.balance = '-46.00'
    expect(await w.sync()).toMatchObject({ ledger: 'personal', added: 0, updated: 1, adopted: 0, removed: 0 })
    expect(w.rows()).toMatchObject([{ ledger: 'family', id: pending.id, externalId: 'c1', status: 'cleared', amount: -4600, deleted: 0 }])
    // One activity entry, in the ledger whose row changed. Family's matching ran.
    expect(w.activity()).toEqual({ ...before, family: [...before.family!, 'Synced Visa from TD Canada Trust: 1 updated'] })
    expect(vi.mocked(matchTransactions).mock.calls.map(([c]) => c.ledger.slug).sort()).toEqual(['family', 'personal'])
    expect(w.opening()).toMatchObject({ openingBalanceMinor: 0, recorded: null })
    w.check()
  })

  it('updates a moved pending charge where it is for Plaid’s replaces, and adopts what Family entered by hand', async () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    expect(plaid(w, [remote('p1', '2026-09-30', -4000, 'Corner Cafe', { pending: true })])).toMatchObject({ added: 1 })
    w.move(w.personal, ['p1'], w.family)
    const pending = w.row('p1')!

    const posted = plaid(w, [remote('c1', '2026-10-01', -4600, 'Corner Cafe', { replaces: 'p1' })], [{ remoteId: 'p1', raw: { removed: 'p1' } }])
    expect(posted).toMatchObject({ added: 0, updated: 1, adopted: 0, removed: 0, newIds: [] })
    expect([...posted.byLedger]).toEqual([[w.family.ledger.id, { added: 0, updated: 1, adopted: 0, removed: 0 }]])
    expect(w.rows()).toMatchObject([{ ledger: 'family', id: pending.id, externalId: 'c1', status: 'cleared', amount: -4600, deleted: 0 }])
    w.check()

    // Family entered a charge by hand: the bank's is that one, adopted in Family.
    const mine = await createTransaction(
      w.family,
      transactionCreateSchema.parse({ accountId: w.visa, date: '2026-10-01', amountMinor: -2500, payee: 'Book Shop' }),
      { useAi: false },
    )
    const adopted = plaid(w, [remote('b1', '2026-10-02', -2500, 'Book Shop')])
    expect(adopted).toMatchObject({ added: 0, updated: 0, adopted: 1, removed: 0 })
    expect([...adopted.byLedger.keys()]).toEqual([w.family.ledger.id])
    expect(w.row('b1')).toMatchObject({ ledger: 'family', id: mine.id, origin: 'manual', amount: -2500 })
    expect(w.where()).toEqual({ c1: 'family', b1: 'family' })
    w.check()
  })

  it('brings the bank’s category and payee to a row Family holds', () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    plaid(w, [remote('r1', '2026-09-29', -1500, 'Corner Cafe', { category: { name: 'Food and drink › Coffee', confident: true } })])
    w.move(w.personal, ['r1'], w.family)
    const changed = plaid(w, [remote('r1', '2026-09-29', -1500, 'Corner Cafe & Bar', { category: { name: 'Food and drink › Restaurant', confident: false } })])
    expect([...changed.byLedger]).toEqual([[w.family.ledger.id, { added: 0, updated: 1, adopted: 0, removed: 0 }]])
    const held = w.family.q.get('SELECT payee, bank_category AS bankCategory, bank_category_confident AS confident FROM transactions WHERE ledger_id = @ledger AND id = ?', w.row('r1')!.id)
    expect(held).toEqual({ payee: 'Corner Cafe & Bar', bankCategory: 'Food and drink › Restaurant', confident: 0 })
    w.check()
  })

  it('deletes what the bank removed where it is held, saying the bank removed it', async () => {
    const w = await synced({
      balance: '-60.00',
      transactions: [tx('p2', '2026-09-30', '-25.00', 'Gas Bar', { pending: true }), tx('s1', '2026-09-29', '-35.00', 'Book Shop')],
    })
    w.move(w.personal, ['p2', 's1'], w.family)
    const before = w.activity()
    w.card.transactions = [w.card.transactions[1]!]
    w.card.balance = '-35.00'
    expect(await w.sync()).toMatchObject({ removed: 1 })
    expect(w.row('p2')).toMatchObject({ ledger: 'family', deleted: 1, removedAt: '2026-10-03T18:00:00.000Z' })
    expect(w.activity()).toEqual({ ...before, family: [...before.family!, 'Synced Visa from TD Canada Trust: 1 removed'] })
    w.check()

    // Sent again under its id, it's back where it was. Removed again, then posted replacing it, too.
    const p2 = w.row('p2')!.id
    expect([...plaid(w, [remote('p2', '2026-09-30', -2500, 'Gas Bar', { pending: true })]).byLedger.keys()]).toEqual([w.family.ledger.id])
    expect(w.row('p2')).toMatchObject({ ledger: 'family', id: p2, deleted: 0, removedAt: null })
    plaid(w, [], [{ remoteId: 'p2' }])
    expect(plaid(w, [remote('c2', '2026-10-01', -2700, 'Gas Bar', { replaces: 'p2' })])).toMatchObject({ added: 0, updated: 1 })
    expect(w.row('c2')).toMatchObject({ ledger: 'family', id: p2, status: 'cleared', deleted: 0, removedAt: null })
    w.check()

    // Plaid says outright what it removed, posted or not.
    const removed = plaid(w, [], [{ remoteId: 's1' }])
    expect([...removed.byLedger]).toEqual([[w.family.ledger.id, { added: 0, updated: 0, adopted: 0, removed: 1 }]])
    expect(w.row('s1')).toMatchObject({ ledger: 'family', deleted: 1, removedAt: '2026-10-03T18:00:00.000Z' })
    // Restored by a person, it's no longer one the bank removed.
    restoreTransaction(w.family, w.row('s1')!.id)
    expect(w.row('s1')).toMatchObject({ deleted: 0, removedAt: null })
    w.check()
  })

  it('restores in place a moved pending charge the bank dropped and then posted, but never one a person deleted', async () => {
    const w = await synced({
      balance: '-100.00',
      transactions: [
        tx('p3', '2026-09-30', '-40.00', 'Corner Cafe', { pending: true }),
        tx('p4', '2026-09-30', '-30.00', 'Gas Bar', { pending: true }),
        tx('p5', '2026-09-29', '-30.00', 'Book Shop', { pending: true }),
      ],
    })
    w.move(w.personal, ['p3', 'p4', 'p5'], w.family)
    const [p3, p4, p5] = ['p3', 'p4', 'p5'].map((x) => w.row(x)!)

    // The bank drops p3 (it was removed by the bank). Family deletes p4 itself, having entered the same charge by hand.
    const twin = await createTransaction(
      w.family,
      transactionCreateSchema.parse({ accountId: w.visa, date: '2026-09-30', amountMinor: -3000, payee: 'Gas Bar' }),
      { useAi: false },
    )
    deleteTransaction(w.family, p4!.id)
    w.card.transactions = w.card.transactions.filter((t) => t.id !== 'p3')
    w.card.balance = '-60.00'
    expect(await w.sync()).toMatchObject({ removed: 1 })
    expect(w.row('p3')).toMatchObject({ deleted: 1, removedAt: '2026-10-03T18:00:00.000Z' })
    // The bank removed p5 eight days ago: too long for it to come back as itself.
    w.family.q.run(
      "UPDATE transactions SET status = 'pending', deleted_at = '2026-09-25T18:00:00.000Z', removed_at = '2026-09-25T18:00:00.000Z' WHERE ledger_id = @ledger AND id = ?",
      p5!.id,
    )

    // Then each posts under a new id.
    w.card.transactions = [tx('c3', '2026-10-01', '-44.00', 'Corner Cafe'), tx('c4', '2026-09-30', '-30.00', 'Gas Bar'), tx('c5', '2026-09-30', '-30.00', 'Book Shop')]
    w.card.balance = '-104.00'
    expect(await w.sync()).toMatchObject({ added: 1, updated: 1, adopted: 1 })
    // p3 is back where it was, posted. p4 stays deleted, and the charge Family entered by hand is the bank's.
    expect(w.row('c3')).toMatchObject({ ledger: 'family', id: p3!.id, status: 'cleared', amount: -4400, deleted: 0, removedAt: null })
    expect(w.row('p4')).toMatchObject({ ledger: 'family', id: p4!.id, deleted: 1, removedAt: null })
    expect(w.row('c4')).toMatchObject({ ledger: 'family', id: twin.id, origin: 'manual', deleted: 0 })
    // p5 stays deleted, and its posted one is new, in the home.
    expect(w.row('p5')).toMatchObject({ ledger: 'family', id: p5!.id, deleted: 1 })
    expect(w.where()).toEqual({ c3: 'family', p4: 'family (deleted)', c4: 'family', p5: 'family (deleted)', c5: 'personal' })
    expect(getTransaction(w.family, p3!.id)).toMatchObject({ externalId: 'c3', status: 'cleared' })
    w.check()
  })

  it('keeps a member’s nightly job, purge and refreshed payees working with moved synced rows', async () => {
    const w = await synced({
      balance: '-90.00',
      transactions: [tx('s1', '2026-09-28', '-20.00', 'Corner Cafe'), tx('s2', '2026-09-29', '-30.00', 'Book Shop'), tx('s3', '2026-09-30', '-40.00', 'Gas Bar', { pending: true })],
    })
    w.move(w.personal, ['s1', 's2', 's3'], w.family)
    // Family deletes s1, and the bank removes s3, both long enough ago to be purged.
    deleteTransaction(w.family, w.row('s1')!.id)
    w.card.transactions = w.card.transactions.slice(0, 2)
    w.card.balance = '-50.00'
    await w.sync()
    w.family.q.run("UPDATE transactions SET deleted_at = '2026-08-01T00:00:00Z' WHERE ledger_id = @ledger AND deleted_at IS NOT NULL")

    expect(runDailyJobs(w.storage)).toEqual([])
    expect(w.where()).toEqual({ s2: 'family' })
    // Their payloads are the account's still.
    const payloads = w.personal.q.all(
      `SELECT p.remote_id AS remoteId, p.transaction_id AS transactionId FROM ledger_accounts a JOIN bank_payloads p ON p.account_id = a.id
       WHERE a.ledger_id = @ledger AND a.id = ? ORDER BY p.id`,
      w.visa,
    )
    expect(payloads).toEqual([
      { remoteId: 's1', transactionId: null },
      { remoteId: 's2', transactionId: null },
      { remoteId: 's3', transactionId: null },
    ])

    // At boot: what was kept is applied again to every ledger's rows.
    expect(w.bank.refreshPayees()).toBe(0)
    const kept = w.storage.app.db.select().from(bankTransactions).where(eq(bankTransactions.remoteId, 's2')).get()!
    const data = { ...(JSON.parse(kept.data) as RemoteTransaction), payee: 'Book Shop & Cafe' }
    w.storage.app.db.update(bankTransactions).set({ data: JSON.stringify(data) }).where(eq(bankTransactions.remoteId, 's2')).run()
    expect(w.bank.applyKept()).toBe(1)
    expect(w.row('s2')).toMatchObject({ ledger: 'family', payee: 'Book Shop & Cafe' })
    w.check()
  })

  it('lands new rows in the new home after a home change, which the link follows', async () => {
    const w = await synced({ balance: '-80.00', transactions: [tx('a1', '2026-09-28', '-50.00', 'Corner Cafe'), tx('a2', '2026-09-29', '-30.00', 'Book Shop')] })
    w.move(w.personal, ['a2'], w.family)
    changeHome(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    expect(w.bank.linkedTo(w.family.ledger.id, w.visa)).toBeDefined()
    expect(w.bank.linkedTo(w.personal.ledger.id, w.visa)).toBeUndefined()

    const before = [w.personal, w.family, w.trip].map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
    expect(await w.sync()).toMatchObject({ ledger: 'family', added: 0, updated: 0 })
    expect([w.personal, w.family, w.trip].map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))).toEqual(before)

    w.card.transactions.push(tx('n1', '2026-10-01', '-15.00', 'Gas Bar'))
    w.card.balance = '-95.00'
    expect(await w.sync()).toMatchObject({ ledger: 'family', added: 1 })
    expect(w.where()).toEqual({ a1: 'personal', a2: 'family', n1: 'family' })
    // In the old home, the account syncs no more.
    expect(() => applyRemoteTransactions(w.personal, w.ctxOf, w.visa, [], { removed: [], floor: null } satisfies ApplyScope, 'simplefin')).toThrow(/syncs in its home/)
    w.check()
  })
})

describe('an external id on a shared account', () => {
  it('is the account’s in every ledger: another ledger’s is a 409 that names no transaction', async () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    plaid(w, [remote('e1', '2026-09-28', -1000, 'Corner Cafe'), remote('e2', '2026-09-29', -2000, 'Book Shop')])
    w.move(w.personal, ['e2'], w.family)
    const [e1, e2] = [w.row('e1')!.id, w.row('e2')!.id]
    const message = 'Another ledger has this transaction'

    // Where it's held, as before. Elsewhere, refused.
    expect(findByExternalId(w.personal, w.visa, 'e1')).toEqual({ id: e1, deleted: false })
    expect(findByExternalId(w.family, w.visa, 'e2')).toEqual({ id: e2, deleted: false })
    conflict(() => findByExternalId(w.personal, w.visa, 'e2'), message)
    conflict(() => findByExternalId(w.family, w.visa, 'e1'), message)
    expect(findByExternalId(w.family, w.visa, 'e3')).toBeNull()
    // A ledger that doesn't have the account learns nothing.
    expect(findByExternalId(w.trip, w.visa, 'e1')).toBeNull()

    // Entered by hand (and so every insert), in the home and in a member: refused, not the unique index's error.
    const entry = (externalId: string) => transactionCreateSchema.parse({ accountId: w.visa, date: '2026-09-30', amountMinor: -500, payee: 'Shop', externalId })
    await expect(createTransaction(w.personal, entry('e2'), { useAi: false })).rejects.toMatchObject({ status: 409, message })
    await expect(createTransaction(w.family, entry('e1'), { useAi: false })).rejects.toMatchObject({ status: 409, message })
    deleteTransaction(w.family, e2)
    conflict(() => findByExternalId(w.personal, w.visa, 'e2'), message)
    expect(findByExternalId(w.family, w.visa, 'e2')).toEqual({ id: e2, deleted: true })
    w.check()
  })
})

describe('the account’s rows read across ledgers', () => {
  /** Uses of the reads that hand out rows, by file, comments left out. */
  function rowReads(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    return [...code.matchAll(/\baccountWide\s*\.\s*(bankRows|bankIds|holder)\b/g)].map((m) => m[1]!)
  }

  it('are read only by the bank code, and findByExternalId, which hands out no other ledger’s id', () => {
    const root = path.join(repoRoot, 'apps/server')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) found.push(...rowReads(readFileSync(full, 'utf8')).map((read) => `${path.relative(root, full)}: ${read}`))
      }
    }
    walk(path.join(root, 'src'))
    expect([...new Set(found)].sort()).toEqual([
      'src/services/bank/apply.ts: bankRows',
      'src/services/bank/apply.ts: holder',
      'src/services/bank/service.ts: bankIds',
      'src/services/transactions.ts: holder',
    ])
    expect(rowReads('// ctx.accountWide.bankRows(1)\nconst x = ctx.accountWide . holder(1, "a")')).toEqual(['holder'])
  })
})
