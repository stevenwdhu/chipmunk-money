import { describe, expect, it } from 'vitest'
import type { LedgerAction, LedgerAnswers } from '@chipmunk/shared'
import { runDailyJobs } from '../jobs'
import { fakeBridge, fakeTx, TOKEN, type FakeCard } from '../test/fake-bridge'
import { categoryId } from '../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER } from '../test/shared-accounts'
import { ledgerRows } from '../test/world'
import { balancesAt, deleteAccount, getAccount, listAccounts, setBalance } from './accounts'
import { applyRemoteTransactions } from './bank/apply'
import { BankService } from './bank/service'
import type { RemoteTransaction } from './bank/types'
import type { AppContext } from './context'
import { moveTransactions } from './moves'
import { questionsFor } from './questions'
import { eraseAll } from './setup'
import { changeHome, setSharing } from './sharing'
import { setSplit } from './splits'
import { deleteTransaction, purgeDeleted } from './transactions'

/**
 * What's asked before a ledger that has a shared account is deleted, erased or archived, and what
 * the answers then do. Personal is Visa's home, and Family and Trip have it. Visa opens at
 * −$1,000.00. A row a member holds got there by a real move. Every number is worked out by hand in
 * the comments.
 */

const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    const err = e as { status?: number; message: string }
    return { status: err.status, message: err.message }
  }
  throw new Error('Expected it to be refused')
}

const ASK = { status: 409, message: 'Answer the questions first' }

/** Dates on both sides of each row and of the balance recorded on 31 August. */
const DATES = ['2026-07-31', '2026-08-09', '2026-08-31', '2026-09-30']

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

function world(opts: Parameters<typeof sharedWorld>[0] = {}) {
  const w = sharedWorld({ shareWith: ['family', 'trip'], opening: -100_000, ...opts })
  const { personal, storage } = w
  const all = [w.personal, w.family, w.trip]
  const home = () => w.ctxOf(storage.sqlite.prepare('SELECT ledger_id FROM accounts WHERE id = ?').pluck().get(w.visa) as string)
  /** A row a ledger holds on Visa, entered as by hand. */
  const row = (ctx: AppContext, date: string, amount: number, more: { payee?: string; category?: string } = {}) => {
    const category = more.category ? categoryId(ctx, more.category) : null
    return Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, category_source)
         VALUES (@ledger, @account, @date, @amount, @payee, lower(@payee), @category, @source)`,
        { account: w.visa, date, amount, payee: more.payee ?? 'Shop', category, source: category ? 'user' : null },
      ).lastInsertRowid,
    )
  }
  const move = (from: AppContext, ids: number[], to: AppContext) => moveTransactions(from, w.ctxOf, { ids, to: to.ledger.id }, TESTER)
  /** A purchase on Visa entered in Personal and moved to `to`. */
  const spentIn = (to: AppContext, date: string, amount: number) => {
    const id = row(personal, date, amount, { category: 'Groceries' })
    if (to !== personal) move(personal, [id], to)
    return id
  }
  /** A card payment onto Visa, entered in Personal and moved to `to`, then split there. */
  const payment = (to: AppContext, date: string, amount: number, shares: Record<string, number>) => {
    const id = row(personal, date, amount, { payee: 'PAYMENT THANK YOU', category: 'Credit card payment' })
    if (to !== personal) move(personal, [id], to)
    setSplit(to, w.ctxOf, id, { shares: Object.entries(shares).map(([ledger, amountMinor]) => ({ ledger, amountMinor })) }, { actor: TESTER, usable: null })
    return id
  }
  /** Applied to Visa in its home as Plaid's changes. */
  const plaid = (changed: RemoteTransaction[]) => applyRemoteTransactions(home(), w.ctxOf, w.visa, changed, { removed: [], floor: null }, 'plaid')
  /** A full window as SimpleFIN sends it, 90 days back. */
  const window = (sent: RemoteTransaction[]) => applyRemoteTransactions(home(), w.ctxOf, w.visa, sent, { from: '2026-07-05', to: '2026-10-03', floor: null }, 'simplefin')
  const bankRow = (ctx: AppContext, externalId: string) => ctx.q.pluck<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND external_id = ?', externalId)!
  /** Each ledger's part of Visa today, by slug: the ledgers that have it. */
  const parts = () => expectPartsSumToAccount(storage, w.visa, { dates: DATES }).parts
  /** Each ledger's part of Visa at DATES, by slug: null for one that doesn't have it. */
  const history = () => Object.fromEntries(all.filter((c) => storage.registry.find(c.ledger.id)).map((c) => [c.ledger.slug, balancesAt(c, DATES).get(w.visa) ?? null]))
  /** The rows on Visa kept only for their bank ids, in its home: each bank id. */
  const kept = () => home().q.column<string>('SELECT external_id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND bank_id_only = 1 ORDER BY external_id', w.visa)
  const answers = (a: Record<'home' | 'rows', string | undefined>): LedgerAnswers =>
    Object.fromEntries(Object.entries(a).flatMap(([k, v]) => (v === undefined ? [] : [[`${k}:${w.visa}`, v]])))
  const ask = (ctx: AppContext, action: LedgerAction, allowed: string[] | null = null) => questionsFor(ctx, action, allowed ? new Set(allowed) : null)
  const act = (ctx: AppContext, action: LedgerAction, a: { home?: string; rows?: string } = {}) => {
    const opts = { answers: answers({ home: a.home, rows: a.rows }), actor: TESTER }
    if (action === 'delete') return storage.registry.remove(ctx.ledger.id, opts).changes
    if (action === 'erase') return eraseAll(storage, ctx, opts).changes
    return storage.registry.change(ctx.ledger.id, { archived: true, answers: opts.answers }, { actor: TESTER }).changes
  }
  const everything = () => [all.map((c) => ledgerRows(storage.sqlite, c.ledger.id)), storage.registry.list()]
  /**
   * What every action must leave: the parts sum to the account today and at DATES, nothing refers
   * across ledgers, every split still sums to zero, and nothing of a ledger that left (`gone`)
   * names the account. Returns today's parts.
   */
  const check = (gone?: AppContext) => {
    const now = parts()
    expectNoCrossLedgerReferences(storage)
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
    const splits = storage.sqlite.prepare('SELECT split_of AS payment, sum(amount_minor) AS sum FROM transactions WHERE split_of IS NOT NULL GROUP BY split_of').all()
    for (const s of splits as Array<{ payment: number; sum: number }>) expect(s.sum, `the split rows of ${s.payment} sum to zero`).toBe(0)
    if (gone) {
      for (const table of ['transactions', 'recurring_items', 'import_batches', 'account_ledgers']) {
        const n = storage.sqlite.prepare(`SELECT count(*) FROM ${table} WHERE ledger_id = ? AND account_id = ?`).pluck().get(gone.ledger.id, w.visa)
        expect(n, `${gone.ledger.name}’s ${table} on Visa`).toBe(0)
      }
    }
    return now
  }
  /** The account can go once the ledgers that are left stop sharing it. */
  const deleteVisa = () => {
    const h = home()
    const others = h.accountWide.ledgers(w.visa).filter((l) => !l.isHome)
    setSharing(h, w.ctxOf, w.visa, { ledgers: [h.ledger.slug], rows: Object.fromEntries(others.map((l) => [l.slug, 'home'])) }, { actor: TESTER, usable: null })
    deleteAccount(h, w.ctxOf, w.visa)
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
  }
  return { ...w, row, move, spentIn, payment, plaid, window, bankRow, parts, history, kept, ask, act, everything, check, deleteVisa, home }
}

/**
 * Personal −$200.00 on 5 August and −$80.00 on 20 September, Family −$300.00 on 10 August and
 * −$120.00 on 15 September, Trip −$50.00 on 12 August. With `recorded`, −$1,550.00 is recorded on
 * 31 August, which is what the opening balance and the August rows come to.
 * Personal −1,000 − 280 = −1,280. Family −420. Trip −50. Visa −1,750.
 */
function basic(opts: { recorded?: boolean } = {}) {
  const w = world()
  w.spentIn(w.personal, '2026-08-05', -20_000)
  w.spentIn(w.family, '2026-08-10', -30_000)
  w.spentIn(w.trip, '2026-08-12', -5_000)
  if (opts.recorded) setBalance(w.personal, w.visa, { date: '2026-08-31', balanceMinor: -155_000 })
  w.spentIn(w.family, '2026-09-15', -12_000)
  w.spentIn(w.personal, '2026-09-20', -8_000)
  expect(w.parts()).toEqual({ personal: -128_000, family: -42_000, trip: -5_000 })
  return w
}

const HOME_NOTE = 'New transactions from sync and CSV go to the new home. Nothing already recorded moves.'

describe('the questions', () => {
  it('ask the home for a new home and what happens to its transactions, and say the opening balance moves', () => {
    const w = basic()
    const home = {
      id: `home:${w.visa}`,
      text: 'Visa’s home is Personal. Which ledger becomes its home?',
      note: HOME_NOTE,
      options: [
        { value: 'family', label: 'Family' },
        { value: 'trip', label: 'Trip' },
      ],
    }
    // Nothing is recorded and Visa isn't synced, so rows that go leave the total and nobody takes them up.
    const rows = {
      id: `rows:${w.visa}`,
      text: 'Personal has 2 transactions on Visa. Delete them or move them?',
      note: 'Delete them: no other ledger’s balance on Visa changes. Move to Family: Family’s balance on Visa changes by -$280.00. Move to Trip: Trip’s balance on Visa changes by -$280.00.',
      options: [
        { value: 'delete', label: 'Delete them' },
        { value: 'move:family', label: 'Move to Family' },
        { value: 'move:trip', label: 'Move to Trip' },
      ],
    }
    const notice = 'Visa’s opening balance and recorded balances move to its new home. Its balance on Visa changes by -$1,000.00 today, and earlier balances shift too.'
    expect(w.ask(w.personal, 'delete')).toEqual({ questions: [home, rows], notices: [notice], blockers: [] })
    expect(w.ask(w.personal, 'erase')).toEqual({ questions: [home, rows], notices: [notice], blockers: [] })
    // Archiving keeps its transactions.
    expect(w.ask(w.personal, 'archive')).toEqual({ questions: [home], notices: [notice], blockers: [] })
  })

  it('ask a ledger the account is shared with only about its transactions, one of them as "it"', () => {
    const w = basic({ recorded: true })
    // −$300.00 of Family's is dated before the recorded balance, which has it: Personal takes it at once.
    expect(w.ask(w.family, 'delete')).toEqual({
      questions: [
        {
          id: `rows:${w.visa}`,
          text: 'Family has 2 transactions on Visa. Delete them or move them?',
          note: 'Delete them: Personal’s balance on Visa changes by -$300.00. Move to Personal: Personal’s balance on Visa changes by -$420.00. Move to Trip: Trip’s balance on Visa changes by -$420.00.',
          options: [
            { value: 'delete', label: 'Delete them' },
            { value: 'move:personal', label: 'Move to Personal' },
            { value: 'move:trip', label: 'Move to Trip' },
          ],
        },
      ],
      notices: [],
      blockers: [],
    })
    expect(w.ask(w.family, 'archive')).toEqual({ questions: [], notices: [], blockers: [] })
    expect(w.ask(w.trip, 'erase').questions).toMatchObject([
      {
        text: 'Trip has 1 transaction on Visa. Delete it or move it?',
        // Trip's row is dated before the recorded balance too.
        note: 'Delete it: Personal’s balance on Visa changes by -$50.00. Move to Personal: Personal’s balance on Visa changes by -$50.00. Move to Family: Family’s balance on Visa changes by -$50.00.',
        options: [{ label: 'Delete it' }, { label: 'Move to Personal' }, { label: 'Move to Family' }],
      },
    ])
  })

  it('name the new home as such while it’s still to be chosen and takes up what’s deleted', () => {
    const w = basic({ recorded: true })
    // Personal's −$200.00 of 5 August is in the recorded balance: the opening ledger, which the new home becomes, takes it.
    expect(w.ask(w.personal, 'delete').questions[1]!.note).toBe(
      'Delete them: the new home’s balance on Visa changes by -$200.00. Move to Family: Family’s balance on Visa changes by -$280.00. Move to Trip: Trip’s balance on Visa changes by -$280.00.',
    )
  })

  it('are none for a ledger with no shared account, and an archived ledger is no choice', () => {
    const w = world({ shareWith: [] })
    w.row(w.personal, '2026-09-01', -500)
    for (const action of ['delete', 'erase', 'archive'] as const) expect(w.ask(w.personal, action)).toEqual({ questions: [], notices: [], blockers: [] })

    const b = basic()
    expect(b.act(b.trip, 'archive')).toEqual(['Trip was archived.'])
    const asked = b.ask(b.personal, 'delete')
    expect(asked.questions.map((q) => q.options.map((o) => o.value))).toEqual([['family'], ['delete', 'move:family']])
    // One ledger can be the home, so it's named.
    expect(asked.notices).toEqual(['Visa’s opening balance and recorded balances move to Family. Family’s balance on Visa changes by -$1,000.00 today, and earlier balances shift too.'])
  })

  it('block the action when no other ledger can be the home, or the key can’t use every ledger that has the account', () => {
    const w = basic()
    w.act(w.family, 'archive')
    w.act(w.trip, 'archive')
    const archived = 'Visa’s home is Personal, and every other ledger that has it is archived. Restore one of them, or stop sharing Visa, first.'
    expect(w.ask(w.personal, 'delete')).toEqual({
      questions: [{ id: `rows:${w.visa}`, text: 'Personal has 2 transactions on Visa. Delete them or move them?', note: null, options: [{ value: 'delete', label: 'Delete them' }] }],
      notices: [],
      blockers: [archived],
    })
    expect(w.ask(w.personal, 'archive')).toEqual({ questions: [], notices: [], blockers: [archived] })
    for (const action of ['delete', 'erase'] as const) expect(status(() => w.act(w.personal, action, { rows: 'delete' }))).toEqual(ASK)
    w.storage.registry.update(w.family.ledger.id, { archived: false })
    w.storage.registry.update(w.trip.ledger.id, { archived: false })

    const ids = [w.personal.ledger.id, w.family.ledger.id]
    for (const [action, verb] of [['delete', 'delete'], ['erase', 'erase'], ['archive', 'archive']] as const) {
      expect(w.ask(w.family, action, ids).blockers).toEqual([`This key can’t use every ledger that has Visa, so it can’t ${verb} Family. Do it in the app.`])
    }
    expect(w.ask(w.family, 'delete', [...ids, w.trip.ledger.id]).blockers).toEqual([])
    const limited = { answers: { [`rows:${w.visa}`]: 'delete' }, allowed: new Set(ids), actor: TESTER }
    expect(status(() => w.storage.registry.remove(w.family.ledger.id, limited))).toEqual(ASK)
    expect(status(() => eraseAll(w.storage, w.family, limited))).toEqual(ASK)
    expect(status(() => w.storage.registry.change(w.family.ledger.id, { archived: true }, limited))).toEqual(ASK)
    expect(w.parts()).toEqual({ personal: -128_000, family: -42_000, trip: -5_000 })
  })
})

describe('the answers', () => {
  it('are needed, each one, and must be one of the options: nothing changes otherwise', () => {
    const w = basic()
    const before = w.everything()
    for (const action of ['delete', 'erase'] as const) {
      expect(status(() => w.act(w.personal, action))).toEqual(ASK)
      expect(status(() => w.act(w.personal, action, { home: 'family' }))).toEqual(ASK)
      expect(status(() => w.act(w.personal, action, { rows: 'delete' }))).toEqual(ASK)
      expect(status(() => w.act(w.personal, action, { home: 'personal', rows: 'delete' }))).toEqual({
        status: 400,
        message: '“personal” isn’t an answer to “Visa’s home is Personal. Which ledger becomes its home?”',
      })
      expect(status(() => w.act(w.personal, action, { home: 'family', rows: 'move:personal' }))).toEqual({
        status: 400,
        message: '“move:personal” isn’t an answer to “Personal has 2 transactions on Visa. Delete them or move them?”',
      })
      expect(status(() => w.act(w.family, action))).toEqual(ASK)
      expect(status(() => w.act(w.family, action, { rows: 'move:family' }))).toMatchObject({ status: 400 })
    }
    expect(status(() => w.act(w.personal, 'archive'))).toEqual(ASK)
    expect(status(() => w.storage.registry.update(w.personal.ledger.id, { archived: true }))).toEqual(ASK)
    expect(status(() => w.act(w.personal, 'archive', { home: 'nowhere' }))).toMatchObject({ status: 400 })
    // An archived ledger is no option.
    w.act(w.trip, 'archive')
    expect(status(() => w.act(w.personal, 'archive', { home: 'trip' }))).toMatchObject({ status: 400 })
    expect(status(() => w.act(w.family, 'delete', { rows: 'move:trip' }))).toMatchObject({ status: 400 })
    w.storage.registry.update(w.trip.ledger.id, { archived: false })
    expect(w.everything()).toEqual(before)
  })

  it('are ignored where nothing is asked', () => {
    const w = basic()
    expect(w.storage.registry.remove(w.trip.ledger.id, { answers: { [`rows:${w.visa}`]: 'delete', [`home:${w.visa}`]: 'family', 'rows:999': 'x', other: 'y' }, actor: TESTER }).changes).toEqual([
      'Trip’s 1 transaction on Visa was deleted.',
      'Trip and all its data were deleted.',
    ])
    expect(w.check(w.trip)).toEqual({ personal: -128_000, family: -42_000 })
  })
})

describe('deleting or erasing the home', () => {
  it('deleted with "delete them": Family is the home and takes the opening balance, and what was recorded of Personal’s', () => {
    const w = basic({ recorded: true })
    const before = w.history()
    expect(w.act(w.personal, 'delete', { home: 'family', rows: 'delete' })).toEqual([
      'Family is Visa’s home now.',
      'Personal’s 2 transactions on Visa were deleted.',
      'Visa’s opening balance and recorded balances moved to Family. Family’s balance on Visa changed by -$1,000.00, and earlier balances shifted too.',
      'Personal and all its data were deleted.',
    ])
    expect(w.storage.registry.find(w.personal.ledger.id)).toBeUndefined()
    expect(w.family.accountWide.ledgers(w.visa).map((l) => [l.slug, l.isHome, l.isOpening])).toEqual([
      ['family', true, true],
      ['trip', false, false],
    ])
    // Family −420, the notice's −1,000 and the note's −200. Visa: −1,550 recorded, and Family's −120 after it.
    expect(w.check(w.personal)).toEqual({ family: -162_000, trip: -5_000 })
    // Trip, which nothing named, is where it was at every date. Family carries the balances from now on.
    expect(w.history()).toEqual({ family: [-100_000, -100_000, -150_000, -162_000], trip: before.trip })
    expect(getAccount(w.family, w.visa)).toMatchObject({ openingBalanceMinor: -100_000, balanceAsOf: '2026-08-31', sharing: { home: { slug: 'family' }, opening: { slug: 'family' } } })
    expect(w.family.q.column('SELECT summary FROM activity WHERE ledger_id = @ledger ORDER BY id DESC LIMIT 2')).toEqual([
      'Personal was deleted, so Visa isn’t shared with it any more',
      'Personal made this ledger Visa’s home',
    ])
    w.deleteVisa()
  })

  it('erased with "move to Family" and Trip as the home: Family gets its transactions and Trip the opening balance', () => {
    const w = basic()
    const before = w.history()
    expect(w.act(w.personal, 'erase', { home: 'trip', rows: 'move:family' })).toEqual([
      'Trip is Visa’s home now.',
      'Personal’s 2 transactions on Visa moved to Family.',
      'Visa’s opening balance and recorded balances moved to Trip. Trip’s balance on Visa changed by -$1,000.00, and earlier balances shifted too.',
      'Personal’s data was erased.',
    ])
    // Family −420 − 280. Trip −50 − 1,000. Visa is still −1,750.
    expect(w.check(w.personal)).toEqual({ trip: -105_000, family: -70_000 })
    // Family at each date: what it had, and Personal's rows from their dates on. Trip: the opening balance at every date.
    expect(w.history()).toEqual({
      personal: null,
      family: [0, -20_000, -50_000, -70_000],
      trip: before.trip!.map((v) => v - 100_000),
    })
    // The ledger is still there, with nothing in it, and its activity kept.
    expect(listAccounts(w.personal)).toEqual([])
    expect(w.personal.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(0)
    expect(w.personal.q.pluck("SELECT count(*) FROM activity WHERE ledger_id = @ledger AND action = 'stop_sharing'")).toBe(1)
    w.deleteVisa()
  })
})

describe('deleting or erasing a ledger the account is shared with', () => {
  for (const action of ['delete', 'erase'] as const) {
    it(`${action} with "delete them": its rows go, and Personal takes what the recorded balance had of them`, () => {
      const w = basic({ recorded: true })
      const before = w.history()
      expect(w.act(w.family, action, { rows: 'delete' })).toEqual([
        'Family’s 2 transactions on Visa were deleted.',
        action === 'delete' ? 'Family and all its data were deleted.' : 'Family’s data was erased.',
      ])
      // Personal −1,280 and the note's −300. Visa: −1,550 recorded and Personal's −80 after it.
      expect(w.check(w.family)).toEqual({ personal: -158_000, trip: -5_000 })
      // Personal's part from the recorded balance on. Trip's at no date.
      expect(w.history()).toMatchObject({ personal: [-100_000, -120_000, -150_000, -158_000], trip: before.trip })
      expect(before.personal).toEqual([-100_000, -120_000, -120_000, -128_000])
      w.deleteVisa()
    })
  }

  it('moves its transactions to the home, or to the other ledger, as it’s told', () => {
    const toHome = basic()
    const before = toHome.history()
    expect(toHome.act(toHome.family, 'delete', { rows: 'move:personal' })).toEqual(['Family’s 2 transactions on Visa moved to Personal.', 'Family and all its data were deleted.'])
    expect(toHome.check(toHome.family)).toEqual({ personal: -170_000, trip: -5_000 })
    expect(toHome.history()).toEqual({ personal: [-100_000, -120_000, -150_000, -170_000], trip: before.trip })
    toHome.deleteVisa()

    const toTrip = basic()
    expect(toTrip.act(toTrip.family, 'erase', { rows: 'move:trip' })).toEqual(['Family’s 2 transactions on Visa moved to Trip.', 'Family’s data was erased.'])
    expect(toTrip.check(toTrip.family)).toEqual({ personal: -128_000, trip: -47_000 })
    expect(toTrip.history()).toEqual({ personal: before.personal, family: null, trip: [0, 0, -35_000, -47_000] })
    // What it moved is Trip's now, with its category.
    expect(toTrip.trip.q.all('SELECT date, amount_minor AS amount, category_id AS category FROM transactions WHERE ledger_id = @ledger ORDER BY date')).toEqual([
      { date: '2026-08-10', amount: -30_000, category: categoryId(toTrip.trip, 'Groceries') },
      { date: '2026-08-12', amount: -5_000, category: categoryId(toTrip.trip, 'Groceries') },
      { date: '2026-09-15', amount: -12_000, category: categoryId(toTrip.trip, 'Groceries') },
    ])
    toTrip.deleteVisa()
  })

  it('takes the opening balance to the home when the opening ledger goes, after a home change', () => {
    const w = basic()
    changeHome(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    const before = w.history()
    // Family is the home, so there's no home to ask for. Personal still carries the opening balance.
    const asked = w.ask(w.personal, 'delete')
    expect(asked.questions.map((q) => q.id)).toEqual([`rows:${w.visa}`])
    expect(asked.questions[0]!.note).toBe(
      'Delete them: no other ledger’s balance on Visa changes. Move to Family: Family’s balance on Visa changes by -$280.00. Move to Trip: Trip’s balance on Visa changes by -$280.00.',
    )
    expect(asked.notices).toEqual(['Visa’s opening balance and recorded balances move to Family. Family’s balance on Visa changes by -$1,000.00 today, and earlier balances shift too.'])
    expect(w.act(w.personal, 'delete', { rows: 'move:family' })).toEqual([
      'Personal’s 2 transactions on Visa moved to Family.',
      'Visa’s opening balance and recorded balances moved to Family. Family’s balance on Visa changed by -$1,000.00, and earlier balances shifted too.',
      'Personal and all its data were deleted.',
    ])
    // Family −420 − 1,000 − 280.
    expect(w.check(w.personal)).toEqual({ family: -170_000, trip: -5_000 })
    expect(w.history()).toEqual({ family: [-100_000, -120_000, -150_000, -170_000], trip: before.trip })
    w.deleteVisa()
  })
})

describe('deleting a ledger that takes part in split payments', () => {
  /**
   * On top of `basic`, three payments, each split:
   * A, $100.00 on 22 September in Personal: $40.00 for Family, $10.00 for Trip.
   * B, $60.00 on 24 September in Trip, which keeps $30.00: $20.00 for Family, $10.00 for Personal.
   * C, $80.00 on 26 September in Family, which keeps $50.00: $20.00 for Trip, $10.00 for Personal.
   * Personal −1,280 + 100 − 50 + 10 + 10 = −1,210. Family −420 + 40 + 20 + 80 − 30 = −310.
   * Trip −50 + 10 + 60 − 30 + 20 = 10. Visa −1,510.
   */
  function split() {
    const w = basic()
    const a = w.payment(w.personal, '2026-09-22', 10_000, { family: 4_000, trip: 1_000 })
    const b = w.payment(w.trip, '2026-09-24', 6_000, { trip: 3_000, family: 2_000 })
    const c = w.payment(w.family, '2026-09-26', 8_000, { family: 5_000, trip: 2_000 })
    expect(w.check()).toEqual({ personal: -121_000, family: -31_000, trip: 1_000 })
    return { ...w, a, b, c }
  }
  const splitRows = (w: ReturnType<typeof split>) =>
    w.storage.sqlite
      .prepare('SELECT l.slug AS ledger, t.split_of AS payment, t.amount_minor AS amount FROM transactions t JOIN ledgers l ON l.id = t.ledger_id WHERE t.split_of IS NOT NULL ORDER BY t.split_of, t.amount_minor')
      .all()

  it('with "delete them", gives its shares back to the ledgers that hold the payments, and ends the split of its own', () => {
    const w = split()
    const before = w.history()
    expect(w.ask(w.family, 'delete').questions[0]).toMatchObject({
      text: 'Family has 6 transactions on Visa. Delete them or move them?',
      note: 'Delete them: Personal’s balance on Visa changes by +$40.00, and Trip’s balance on Visa changes by +$20.00. Move to Personal: Personal’s balance on Visa changes by -$310.00. Move to Trip: Trip’s balance on Visa changes by -$310.00.',
    })
    expect(w.act(w.family, 'delete', { rows: 'delete' })).toEqual([
      'Family’s share of $40.00 of the $100.00 payment on 2026-09-22 goes back to Personal, which holds the payment.',
      'Family’s share of $20.00 of the $60.00 payment on 2026-09-24 goes back to Trip, which holds the payment.',
      'The split of Family’s $80.00 payment on 2026-09-26 ends. Each share of it is an ordinary transaction where it is, and no balance changes.',
      'Family’s 4 transactions on Visa were deleted.',
      'Family and all its data were deleted.',
    ])
    // Personal −1,210 + 40. Trip 10 + 20.
    expect(w.check(w.family)).toEqual({ personal: -117_000, trip: 3_000 })
    // Before the payments, nobody's part moved.
    expect(w.history()).toEqual({ personal: before.personal!.map((v, i) => v + (i === 3 ? 4_000 : 0)), trip: before.trip!.map((v, i) => v + (i === 3 ? 2_000 : 0)) })
    // A is split between Personal and Trip still, B between Trip and Personal. C's shares are ordinary rows.
    expect(splitRows(w)).toEqual([
      { ledger: 'personal', payment: w.a, amount: -1_000 },
      { ledger: 'trip', payment: w.a, amount: 1_000 },
      { ledger: 'trip', payment: w.b, amount: -1_000 },
      { ledger: 'personal', payment: w.b, amount: 1_000 },
    ])
    w.deleteVisa()
  })

  it('with "move to Trip", gives back its share of Trip’s payment and keeps the rest as ordinary rows that move', () => {
    const w = split()
    const before = w.history()
    expect(w.act(w.family, 'erase', { rows: 'move:trip' })).toEqual([
      'Family’s share of $40.00 of Personal’s $100.00 payment on 2026-09-22 is an ordinary transaction now, and so is what Personal gave for it. No balance changes.',
      'Family’s share of $20.00 of the $60.00 payment on 2026-09-24 goes back to Trip, which holds the payment.',
      'The split of Family’s $80.00 payment on 2026-09-26 ends. Each share of it is an ordinary transaction where it is, and no balance changes.',
      'Family’s 5 transactions on Visa moved to Trip.',
      'Family’s data was erased.',
    ])
    // Trip 10 − 310. Personal as it was, today and before.
    expect(w.check(w.family)).toEqual({ personal: -121_000, trip: -30_000 })
    expect(w.history().personal).toEqual(before.personal)
    expect(splitRows(w)).toEqual([
      { ledger: 'personal', payment: w.a, amount: -1_000 },
      { ledger: 'trip', payment: w.a, amount: 1_000 },
      { ledger: 'trip', payment: w.b, amount: -1_000 },
      { ledger: 'personal', payment: w.b, amount: 1_000 },
    ])
    w.deleteVisa()
  })
})

describe('a synced account', () => {
  /**
   * Visa synced from a fake bank, with no opening balance. The bank has four charges: Grocer
   * −$100.00, Book Shop −$170.00, Cafe −$40.00 and Bakery −$25.00, and says −$335.00. Book Shop and
   * Bakery were moved to Family, which then deleted Bakery, and Cafe to Trip. Family also entered
   * −$30.00 by hand. A sync then leaves Personal with the difference:
   * Personal +5 − 100 = −95. Family −170 − 30 = −200. Trip −40. Visa −335, as the bank says.
   */
  async function synced() {
    const card: FakeCard = {
      balance: '-335.00',
      transactions: [
        fakeTx('b1', '2026-09-01', '-100.00', 'Grocer'),
        fakeTx('b2', '2026-09-05', '-170.00', 'Book Shop'),
        fakeTx('b3', '2026-09-08', '-40.00', 'Cafe'),
        fakeTx('b4', '2026-09-09', '-25.00', 'Bakery'),
      ],
    }
    const w = world({ opening: 0, fetch: fakeBridge(card) })
    const bank = new BankService(w.storage)
    const conn = await bank.connect({ setupToken: TOKEN })
    bank.linkAccount(w.personal, w.visa, { bankAccountId: conn.accounts.find((a) => a.remoteId === 'visa')!.id }, null)
    const sync = async (opts: { full?: boolean } = {}) => {
      const result = await bank.sync(conn.id, opts)
      expect(result.ok, result.error ?? '').toBe(true)
      const { added, updated, adopted, removed } = result.accounts[0]!
      return { added, updated, adopted, removed }
    }
    expect(await sync()).toMatchObject({ added: 4 })
    w.move(w.personal, [w.bankRow(w.personal, 'b2'), w.bankRow(w.personal, 'b4')], w.family)
    w.move(w.personal, [w.bankRow(w.personal, 'b3')], w.trip)
    deleteTransaction(w.family, w.bankRow(w.family, 'b4'))
    w.addTx(w.family, '2026-09-10', -3_000)
    expect(await sync()).toEqual(NOTHING)
    expect(w.parts()).toEqual({ personal: -9_500, family: -20_000, trip: -4_000 })
    return { ...w, sync }
  }
  const NOTHING = { added: 0, updated: 0, adopted: 0, removed: 0 }

  it('says what the next sync does, which then does it: Personal takes what Family’s deleted rows were', async () => {
    const w = await synced()
    expect(w.ask(w.family, 'delete').questions[0]!.note).toBe(
      'Delete them: at the next sync, Personal’s balance on Visa changes by -$200.00. Move to Personal: Personal’s balance on Visa changes by -$200.00. Move to Trip: Trip’s balance on Visa changes by -$200.00.',
    )
    expect(w.act(w.family, 'delete', { rows: 'delete' })).toEqual([
      'Family’s 2 transactions on Visa were deleted.',
      'Visa keeps the bank ids of 2 transactions Family had, deleted, so a sync doesn’t add them again.',
      'Family and all its data were deleted.',
    ])
    // At once nothing of Personal's or Trip's changes: Visa is −135 until the bank is asked.
    expect(w.check(w.family)).toEqual({ personal: -9_500, trip: -4_000 })
    expect(w.kept()).toEqual(['b2', 'b4'])

    // The bank still says −335 and sends the same four: nothing is added, and Personal is −95 − 200.
    expect(await w.sync()).toEqual(NOTHING)
    expect(w.check(w.family)).toEqual({ personal: -29_500, trip: -4_000 })
    expect(getAccount(w.personal, w.visa).sharing?.totalBalanceMinor).toBe(-33_500)
    // Again, and with everything fetched again, and after the purge at any age: nothing more.
    const settled = w.everything()
    expect(await w.sync()).toEqual(NOTHING)
    purgeDeleted(w.personal, -1)
    expect(await w.sync({ full: true })).toEqual(NOTHING)
    expect(w.kept()).toEqual(['b2', 'b4'])
    expect(w.everything()).toEqual(settled)
    expect(w.check(w.family)).toEqual({ personal: -29_500, trip: -4_000 })
    w.deleteVisa()
  })

  it('moves its rows where the bank still finds them, and a sync changes nothing', async () => {
    const w = await synced()
    expect(w.act(w.family, 'erase', { rows: 'move:trip' })).toEqual([
      'Family’s 2 transactions on Visa moved to Trip.',
      'Visa keeps the bank ids of 1 transaction Family had, deleted, so a sync doesn’t add it again.',
      'Family’s data was erased.',
    ])
    expect(w.check(w.family)).toEqual({ personal: -9_500, trip: -24_000 })
    expect(w.kept()).toEqual(['b4'])
    expect(await w.sync()).toEqual(NOTHING)
    purgeDeleted(w.personal, -1)
    expect(await w.sync({ full: true })).toEqual(NOTHING)
    expect(w.check(w.family)).toEqual({ personal: -9_500, trip: -24_000 })
    expect(w.bankRow(w.trip, 'b2')).toBeGreaterThan(0)
  })

  it('deletes the home: the link goes with the account to the new home, which takes what was deleted at the next sync', async () => {
    const w = await synced()
    const asked = w.ask(w.personal, 'delete')
    expect(asked.questions[1]!.note).toBe(
      'Delete it: at the next sync, the new home’s balance on Visa changes by -$100.00. Move to Family: Family’s balance on Visa changes by -$100.00. Move to Trip: Trip’s balance on Visa changes by -$100.00.',
    )
    // The opening balance is the +$5.00 the first sync left there.
    expect(asked.notices).toEqual(['Visa’s opening balance and recorded balances move to its new home. Its balance on Visa changes by +$5.00 today, and earlier balances shift too.'])
    w.act(w.personal, 'delete', { home: 'trip', rows: 'delete' })
    expect(w.check(w.personal)).toEqual({ trip: -3_500, family: -20_000 })
    expect(w.kept()).toEqual(['b1'])
    expect(await w.sync()).toEqual(NOTHING)
    // Trip −40 + 5 − 100.
    expect(w.check(w.personal)).toEqual({ trip: -13_500, family: -20_000 })
    purgeDeleted(w.trip, -1)
    expect(await w.sync({ full: true })).toEqual(NOTHING)
    expect(w.check(w.personal)).toEqual({ trip: -13_500, family: -20_000 })
  })
})

describe('a ledger with only deleted rows on the account, or an account split off from it', () => {
  it('leaves the bank ids of its deleted rows with the home, without a question', () => {
    const w = world({ shareWith: ['family'], opening: 0 })
    const sent = [remote('k1', '2026-09-20', -9_000, 'Book Shop'), remote('k2', '2026-09-21', -1_200, 'Gas Bar')]
    w.plaid(sent)
    w.move(w.personal, [w.bankRow(w.personal, 'k1')], w.family)
    deleteTransaction(w.family, w.bankRow(w.family, 'k1'))
    // One entered by hand and deleted has no bank id to keep.
    deleteTransaction(w.family, w.addTx(w.family, '2026-09-22', -700))
    expect(w.ask(w.family, 'delete')).toEqual({ questions: [], notices: [], blockers: [] })
    expect(w.act(w.family, 'delete')).toEqual(['Visa keeps the bank ids of 1 transaction Family had, deleted, so a sync doesn’t add it again.', 'Family and all its data were deleted.'])
    expect(w.check(w.family)).toEqual({ personal: -1_200 })
    expect(w.kept()).toEqual(['k1'])
    expect(w.plaid(sent)).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    purgeDeleted(w.personal, -1)
    expect(w.window(sent)).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    expect(w.kept()).toEqual(['k1'])
    deleteAccount(w.personal, w.ctxOf, w.visa)
  })

  for (const action of ['delete', 'erase'] as const) {
    it(`leaves the bank ids on its split-off account with the account it was split off from (${action})`, () => {
      const w = world({ shareWith: ['family'], opening: 0 })
      const sent = [remote('k1', '2026-09-20', -9_000, 'Book Shop'), remote('k2', '2026-09-21', -1_200, 'Gas Bar')]
      w.plaid(sent)
      w.move(w.personal, [w.bankRow(w.personal, 'k1')], w.family)
      setSharing(w.personal, w.ctxOf, w.visa, { ledgers: ['personal'], rows: { family: 'keep' } }, { actor: TESTER, usable: null })
      // Visa isn't shared any more, so nothing is asked. A key must still reach Personal, where the bank ids go.
      expect(w.ask(w.family, action)).toEqual({ questions: [], notices: [], blockers: [] })
      expect(w.ask(w.family, action, [w.family.ledger.id]).blockers).toEqual([
        `Family’s Visa was split off from Personal’s Visa, which keeps its bank ids. This key can’t use Personal, so it can’t ${action} Family. Do it in the app.`,
      ])
      expect(w.ask(w.family, 'archive', [w.family.ledger.id]).blockers).toEqual([])
      expect(w.act(w.family, action)).toEqual([
        'Personal’s Visa keeps the bank ids of 1 transaction on Family’s Visa, so a sync doesn’t add it again.',
        action === 'delete' ? 'Family and all its data were deleted.' : 'Family’s data was erased.',
      ])
      expect(w.kept()).toEqual(['k1'])
      expect(w.plaid(sent)).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
      purgeDeleted(w.personal, -1)
      expect(w.window(sent)).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
      // Visa is the whole bank balance since Family kept its row: −90 − 12.
      expect(getAccount(w.personal, w.visa).balanceMinor).toBe(-10_200)
      expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
      deleteAccount(w.personal, w.ctxOf, w.visa)
    })
  }
})

describe('archiving', () => {
  it('the home: another ledger becomes the home and takes the opening balance, and it keeps its rows, its part and its splits', () => {
    const w = basic()
    w.plaid([remote('k1', '2026-09-21', -9_000, 'Book Shop')])
    const a = w.payment(w.personal, '2026-09-22', 10_000, { family: 4_000, trip: 1_000 })
    // Personal −1,280 − 90 + 100 − 50. Family −420 + 40. Trip −50 + 10.
    expect(w.check()).toEqual({ personal: -132_000, family: -38_000, trip: -4_000 })
    const before = w.history()
    expect(w.act(w.personal, 'archive', { home: 'family', rows: 'delete' })).toEqual([
      'Family is Visa’s home now.',
      'Visa’s opening balance and recorded balances moved to Family. Family’s balance on Visa changed by -$1,000.00, and earlier balances shifted too.',
      'Personal was archived.',
    ])
    expect(w.storage.registry.get('personal').archivedAt).not.toBeNull()
    expect(w.family.accountWide.ledgers(w.visa).map((l) => [l.slug, l.isHome, l.isOpening, l.archived])).toEqual([
      ['family', true, true, false],
      ['personal', false, false, true],
      ['trip', false, false, false],
    ])
    // The −1,000 goes from Personal to Family, today and at every date. Trip is where it was.
    expect(w.check()).toEqual({ family: -138_000, personal: -32_000, trip: -4_000 })
    expect(w.history()).toEqual({ personal: before.personal!.map((v) => v + 100_000), family: before.family!.map((v) => v - 100_000), trip: before.trip })
    expect(w.storage.sqlite.prepare('SELECT count(*) FROM transactions WHERE split_of = ?').pluck().get(a)).toBe(3)

    // A sync, in the new home, still updates the row Personal holds, where it is.
    expect(w.plaid([remote('k1', '2026-09-21', -9_500, 'Book Shop')])).toMatchObject({ added: 0, updated: 1 })
    expect(w.personal.q.pluck('SELECT amount_minor FROM transactions WHERE ledger_id = @ledger AND external_id = ?', 'k1')).toBe(-9_500)
    expect(w.check()).toEqual({ family: -138_000, personal: -32_500, trip: -4_000 })
    // The nightly job skips it.
    const ran: string[] = []
    expect(runDailyJobs(w.storage, [(ctx) => (ran.push(ctx.ledger.name), null)])).toEqual([])
    expect(ran).toEqual(['Family', 'Trip'])
    // Restoring it needs nothing: it has the account still, and Family stays the home.
    expect(w.ask(w.personal, 'delete').questions.map((q) => q.id)).toEqual([`rows:${w.visa}`])
    w.storage.registry.update(w.personal.ledger.id, { archived: false })
    expect(w.storage.registry.get('personal').archivedAt).toBeNull()
    expect(w.check()).toEqual({ family: -138_000, personal: -32_500, trip: -4_000 })
  })

  it('the opening ledger, after a home change: the home takes the opening balance, with nothing to answer', () => {
    const w = basic({ recorded: true })
    changeHome(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    const before = w.history()
    const notice = 'Visa’s opening balance and recorded balances move to Family. Family’s balance on Visa changes by -$1,000.00 today, and earlier balances shift too.'
    expect(w.ask(w.personal, 'archive')).toEqual({ questions: [], notices: [notice], blockers: [] })
    expect(w.act(w.personal, 'archive')).toEqual([
      'Visa’s opening balance and recorded balances moved to Family. Family’s balance on Visa changed by -$1,000.00, and earlier balances shifted too.',
      'Personal was archived.',
    ])
    expect(w.check()).toEqual({ family: -142_000, personal: -28_000, trip: -5_000 })
    // Each is what it holds but Family, which is the rest of the total at every date.
    expect(w.history()).toEqual({ personal: [0, -20_000, -20_000, -28_000], family: [-100_000, -100_000, -130_000, -142_000], trip: before.trip })
    expect(w.family.q.column("SELECT summary FROM activity WHERE ledger_id = @ledger AND action = 'update' AND entity = 'account'")).toEqual([
      'Personal was archived, so Visa’s opening balance and recorded balances are this ledger’s now',
    ])
    // A ledger the account is only shared with is archived as it is.
    expect(w.act(w.trip, 'archive')).toEqual(['Trip was archived.'])
    expect(w.check()).toEqual({ family: -142_000, personal: -28_000, trip: -5_000 })
  })
})
