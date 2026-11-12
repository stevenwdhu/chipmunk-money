import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { bulkUpdateSchema, importPreviewSchema, recurringCreateSchema, transactionCreateSchema, transactionUpdateSchema } from '@chipmunk/shared'
import { runDailyJobs } from '../jobs'
import { categoryId, makeAccount } from '../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER } from '../test/shared-accounts'
import { ledgerRows } from '../test/world'
import { balancesAt, deleteAccount } from './accounts'
import { applyRemoteTransactions } from './bank/apply'
import type { RemoteTransaction } from './bank/types'
import { setCategoryEnabled } from './categories'
import type { AppContext } from './context'
import { previewImport } from './import'
import { setLinks } from './links'
import { matchTransactions } from './matching'
import { moveTransactions } from './moves'
import { addPayment, createRecurring, getRecurring, recalculateRecurring, updateRecurring } from './recurring'
import { periodSummary } from './reports'
import { removeMember } from './sharing'
import {
  detachShare,
  detachSplit,
  dropShare,
  followPayment,
  GIVEN_PAYEE,
  leaveSplits,
  setSplit,
  undoSplit,
  type SplitInput,
} from './splits'
import {
  bulkUpdate,
  createTransaction,
  deleteTransaction,
  getTransaction,
  linkCandidates,
  listTransactions,
  recurringPaymentCandidates,
  updateTransaction,
} from './transactions'

/**
 * Splitting a card payment between the ledgers that share its account (splits.ts): Personal is
 * Visa's home, Family has it, and Trip has it when the test shares it. A row a member holds got
 * there by a real move.
 */

const PAYEE = 'PAYMENT THANK YOU'

function world(opts: Parameters<typeof sharedWorld>[0] = {}) {
  const w = sharedWorld(opts)
  const { personal, family, trip } = w
  const ledgers = [personal, family, trip]
  /** A row a ledger holds, Visa's unless `account` says, entered as by hand unless `origin` says. */
  const row = (
    ctx: AppContext,
    date: string,
    amount: number,
    more: { payee?: string; account?: number; category?: string; source?: string; origin?: 'manual' | 'sync'; externalId?: string; deletedAt?: string } = {},
  ) => {
    const category = more.category ? categoryId(ctx, more.category) : null
    return Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, category_source, origin, external_id, deleted_at)
         VALUES (@ledger, @account, @date, @amount, @payee, lower(@payee), @category, @source, @origin, @externalId, @deletedAt)`,
        {
          account: more.account ?? w.visa,
          date,
          amount,
          payee: more.payee ?? 'Shop',
          category,
          source: category ? (more.source ?? 'user') : null,
          origin: more.origin ?? 'manual',
          externalId: more.externalId ?? null,
          deletedAt: more.deletedAt ?? null,
        },
      ).lastInsertRowid,
    )
  }
  /** A card payment onto Visa, filed as one. */
  const payment = (ctx: AppContext, date: string, amount: number) => row(ctx, date, amount, { payee: PAYEE, category: 'Credit card payment', source: 'rule' })
  /** A purchase on Visa entered in Personal and moved to `to`. */
  const spentIn = (to: AppContext, date: string, amount: number) => {
    const id = row(personal, date, amount, { category: 'Groceries' })
    if (to !== personal) moveTransactions(personal, w.ctxOf, { ids: [id], to: to.ledger.id }, TESTER)
    return id
  }
  const move = (from: AppContext, ids: number[], to: AppContext) => moveTransactions(from, w.ctxOf, { ids, to: to.ledger.id }, TESTER)
  const split = (ctx: AppContext, id: number, shares: Record<string, number>, more: { dryRun?: boolean; usable?: readonly string[] | null } = {}) =>
    setSplit(ctx, w.ctxOf, id, { shares: Object.entries(shares).map(([ledger, amountMinor]) => ({ ledger, amountMinor })) }, { actor: TESTER, usable: null, ...more })
  /** Every split row on Visa, by ledger slug: its amount, payee and what it's a split of. */
  const splitRows = () =>
    ledgers.flatMap((c) =>
      c.q
        .all<{ id: number; amount: number; payee: string; splitOf: number }>(
          'SELECT id, amount_minor AS amount, payee, split_of AS splitOf FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND split_of IS NOT NULL ORDER BY id',
          w.visa,
        )
        .map((r) => ({ ledger: c.ledger.slug, ...r })),
    )
  /** What every split leaves: the parts sum to the account, nothing refers across ledgers, and each payment's split rows sum to zero. Returns today's parts. */
  const check = () => {
    const { parts } = expectPartsSumToAccount(w.storage, w.visa)
    expectNoCrossLedgerReferences(w.storage)
    const byPayment = new Map<number, number>()
    for (const r of splitRows()) byPayment.set(r.splitOf, (byPayment.get(r.splitOf) ?? 0) + r.amount)
    for (const [id, total] of byPayment) expect(total, `the split rows of ${id} sum to zero`).toBe(0)
    return parts
  }
  const everything = (...ctxs: AppContext[]) => ctxs.map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
  const activity = (ctx: AppContext) => ctx.q.column<string>("SELECT summary FROM activity WHERE ledger_id = @ledger AND action = 'split' ORDER BY id")
  return { ...w, ledgers, row, payment, spentIn, move, split, splitRows, check, everything, activity }
}

/** An HTTP error with this status and message. */
function refused(fn: () => unknown, status: number, message: string | RegExp) {
  let error: unknown
  try {
    fn()
  } catch (err) {
    error = err
  }
  expect(error, 'refused').toBeInstanceOf(HTTPException)
  expect((error as HTTPException).status).toBe(status)
  if (typeof message === 'string') expect((error as HTTPException).message).toBe(message)
  else expect((error as HTTPException).message).toMatch(message)
}

const SHARE_LOCK = 'It’s Family’s share of a payment in Personal. Change the split there.'
const GIVEN_LOCK = 'It’s what this ledger gave the others of a split payment. Change the split on the payment.'
const UNDO_FIRST = 'It’s split between ledgers. Undo the split first.'

/** The worked example: Personal −200 and Family −200 on Visa, then a $100 payment in Personal. */
function example(opts: Parameters<typeof sharedWorld>[0] = {}) {
  const w = world(opts)
  w.spentIn(w.personal, '2026-09-01', -20_000)
  w.spentIn(w.family, '2026-09-02', -20_000)
  const paid = w.payment(w.personal, '2026-09-20', 10_000)
  return { ...w, paid }
}

describe('splitting a card payment', () => {
  it('gives the worked example’s numbers: Personal −180, Family −120, Visa −300', () => {
    const w = example()
    const { personal, family } = w
    expect(w.check()).toEqual({ personal: -10_000, family: -20_000 })
    const before = { personal: periodSummary(personal, '2026-09-01', '2026-09-30'), family: periodSummary(family, '2026-09-01', '2026-09-30') }
    personal.q.run('UPDATE transactions SET needs_review = 1 WHERE ledger_id = @ledger AND id = ?', w.paid)

    const result = w.split(personal, w.paid, { family: 8_000 })
    expect(result).toMatchObject({ keptMinor: 2_000, shares: [{ ledger: { slug: 'family', name: 'Family' }, amountMinor: 8_000 }] })
    expect(w.check()).toEqual({ personal: -18_000, family: -12_000 })
    expect(expectPartsSumToAccount(w.storage, w.visa).totalMinor).toBe(-30_000)

    // The bank's row is as it was, marked reviewed, and shows its split.
    expect(result.transaction).toMatchObject({ id: w.paid, amountMinor: 10_000, payee: PAYEE, needsReview: false })
    expect(result.transaction.split).toEqual({ part: 'payment', keptMinor: 2_000, shares: [{ ledger: { slug: 'family', name: 'Family' }, amountMinor: 8_000 }] })
    const [share, given] = [w.splitRows().find((r) => r.ledger === 'family')!, w.splitRows().find((r) => r.ledger === 'personal')!]
    expect(getTransaction(family, share.id)).toMatchObject({
      amountMinor: 8_000,
      date: '2026-09-20',
      payee: PAYEE,
      origin: 'manual',
      status: 'cleared',
      categoryId: categoryId(family, 'Credit card payment'),
      categorySource: 'user',
      needsReview: false,
      recurringItemId: null,
      split: { part: 'share', from: { slug: 'personal', name: 'Personal' } },
    })
    expect(getTransaction(personal, given.id)).toMatchObject({
      amountMinor: -8_000,
      payee: GIVEN_PAYEE,
      origin: 'manual',
      categoryId: categoryId(personal, 'Credit card payment'),
      categorySource: 'user',
      split: { part: 'given', shares: [{ ledger: { slug: 'family', name: 'Family' }, amountMinor: 8_000 }] },
    })
    // Listed with the rest, the split rows too.
    expect(listTransactions(personal, { accountId: w.visa, limit: 10 } as never).items.find((t) => t.id === w.paid)?.split).toMatchObject({ part: 'payment' })

    // Neither ledger counts any of it as spending or income.
    expect(periodSummary(personal, '2026-09-01', '2026-09-30')).toMatchObject({ spentMinor: before.personal.spentMinor, incomeMinor: before.personal.incomeMinor })
    expect(periodSummary(family, '2026-09-01', '2026-09-30')).toMatchObject({ spentMinor: before.family.spentMinor, incomeMinor: before.family.incomeMinor })
    // Nothing was learnt from the split rows.
    for (const c of [personal, family]) expect(c.q.pluck('SELECT count(*) FROM payee_category_stats WHERE ledger_id = @ledger AND payee_key IN (?, ?)', 'payment thank you', 'split between ledgers')).toBe(0)

    expect(w.activity(personal)).toEqual(['Split the $100.00 payment onto Visa on 2026-09-20: Family $80.00, and Personal keeps $20.00'])
    expect(w.activity(family)).toEqual(['Personal gave this ledger a share of $80.00 of the $100.00 payment onto Visa on 2026-09-20'])
  })

  it('changes nothing in a dry run, and answers as the split would be', () => {
    const w = example()
    const before = w.everything(w.personal, w.family, w.trip)
    const result = w.split(w.personal, w.paid, { family: 8_000 }, { dryRun: true })
    expect(result).toMatchObject({ keptMinor: 2_000, transaction: { split: { part: 'payment', keptMinor: 2_000 } } })
    expect(w.everything(w.personal, w.family, w.trip)).toEqual(before)
  })

  it('splits a payment a member holds: the holder’s own amount is what it keeps, and the home gets the rest', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, family, trip } = w
    w.spentIn(personal, '2026-09-01', -10_000)
    w.spentIn(family, '2026-09-02', -10_000)
    w.spentIn(trip, '2026-09-03', -10_000)
    const paid = w.payment(personal, '2026-09-20', 10_000)
    w.move(personal, [paid], family)
    expect(w.check()).toEqual({ personal: -10_000, family: 0, trip: -10_000 })

    // Family keeps 30, Trip gets 20, and Personal (the home) the other 50.
    const result = w.split(family, paid, { family: 3_000, trip: 2_000 })
    expect(result).toMatchObject({
      keptMinor: 3_000,
      shares: [
        { ledger: { slug: 'personal' }, amountMinor: 5_000 },
        { ledger: { slug: 'trip' }, amountMinor: 2_000 },
      ],
    })
    expect(w.splitRows().map((r) => [r.ledger, r.amount, r.payee])).toEqual([
      ['personal', 5_000, PAYEE],
      ['family', -7_000, GIVEN_PAYEE],
      ['trip', 2_000, PAYEE],
    ])
    expect(w.check()).toEqual({ personal: -5_000, family: -7_000, trip: -8_000 })
    expect(getTransaction(personal, w.splitRows()[0]!.id).split).toEqual({ part: 'share', from: { slug: 'family', name: 'Family' } })

    // Family listed with nothing: it keeps nothing, so Personal gets all but Trip's.
    expect(w.split(family, paid, { trip: 2_000 })).toMatchObject({ keptMinor: 0 })
    expect(w.check()).toEqual({ personal: -2_000, family: -10_000, trip: -8_000 })
    // All of it kept: nothing given, the split is undone, as with an empty list.
    expect(w.split(family, paid, { family: 10_000 })).toMatchObject({ keptMinor: 10_000, shares: [], transaction: { split: null } })
    expect(w.splitRows()).toEqual([])
    w.split(family, paid, { trip: 1_000 })
    expect(w.split(family, paid, {})).toMatchObject({ keptMinor: 10_000, shares: [] })
    expect(w.check()).toEqual({ personal: -10_000, family: 0, trip: -10_000 })
  })

  it('changes the shares in three ledgers: lowered, raised, a ledger added and taken out, and undone', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, family, trip } = w
    w.spentIn(personal, '2026-09-01', -20_000)
    w.spentIn(family, '2026-09-02', -20_000)
    w.spentIn(trip, '2026-09-03', -10_000)
    const paid = w.payment(personal, '2026-09-20', 10_000)
    expect(w.check()).toEqual({ personal: -10_000, family: -20_000, trip: -10_000 })

    w.split(personal, paid, { family: 5_000, trip: 3_000 })
    expect(w.check()).toEqual({ personal: -18_000, family: -15_000, trip: -7_000 })
    const ids = () => w.splitRows().map((r) => r.id)
    const kept = ids()
    // Trip taken out, Family raised: Family's row and the given row are the same rows.
    w.split(personal, paid, { family: 6_000 })
    expect(w.check()).toEqual({ personal: -16_000, family: -14_000, trip: -10_000 })
    expect(ids()).toEqual(kept.filter((id) => w.splitRows().some((r) => r.id === id)))
    expect(w.splitRows().map((r) => r.ledger).sort()).toEqual(['family', 'personal'])
    // Trip added back, Family lowered.
    w.split(personal, paid, { family: 2_500, trip: 1_000 })
    expect(w.check()).toEqual({ personal: -13_500, family: -17_500, trip: -9_000 })
    // The whole payment given away.
    expect(w.split(personal, paid, { family: 7_000, trip: 3_000 })).toMatchObject({ keptMinor: 0 })
    expect(w.check()).toEqual({ personal: -20_000, family: -13_000, trip: -7_000 })
    // Undone with an empty list: each amount back with Personal.
    expect(w.split(personal, paid, {})).toMatchObject({ keptMinor: 10_000, shares: [], transaction: { split: null } })
    expect(w.splitRows()).toEqual([])
    expect(w.check()).toEqual({ personal: -10_000, family: -20_000, trip: -10_000 })
    expect(w.activity(trip).at(-1)).toBe('Personal undid the split of the $100.00 payment onto Visa on 2026-09-20, and this ledger’s share of $30.00 with it')
    expect(w.activity(family)).toContain('Personal changed this ledger’s share of the $100.00 payment onto Visa on 2026-09-20 from $25.00 to $70.00')
  })

  it('splits a payment paired with its withdrawal, and a pending one, and keeps the given row in the payment’s own category', () => {
    const w = world()
    const { personal, family } = w
    const chequing = makeAccount(personal, 'Chequing')
    const out = w.row(personal, '2026-09-19', -10_000, { account: chequing, payee: 'TD VISA', origin: 'sync' })
    const paid = w.row(personal, '2026-09-20', 10_000, { payee: PAYEE, category: 'Transfer', origin: 'sync' })
    personal.q.run("UPDATE transactions SET transfer_pair_id = ?, status = 'pending' WHERE ledger_id = @ledger AND id = ?", out, paid)
    personal.q.run('UPDATE transactions SET transfer_pair_id = ? WHERE ledger_id = @ledger AND id = ?', paid, out)
    w.split(personal, paid, { family: 4_000 })
    const [share, given] = [w.splitRows().find((r) => r.ledger === 'family')!, w.splitRows().find((r) => r.ledger === 'personal')!]
    expect(getTransaction(personal, given.id)).toMatchObject({ categoryId: categoryId(personal, 'Transfer'), status: 'pending' })
    expect(getTransaction(family, share.id)).toMatchObject({ categoryId: categoryId(family, 'Credit card payment'), status: 'pending' })
    expect(getTransaction(personal, paid)).toMatchObject({ transferPairId: out })
    w.check()
  })
})

describe('what can be split, and the shares', () => {
  it('refuses anything but a card payment on a shared account, with one 400', () => {
    const w = world()
    const { personal, family } = w
    const only = 'Only a card payment can be split.'
    const cash = makeAccount(personal, 'Cash', 'cash')
    const offShared = w.row(personal, '2026-09-20', 5_000, { account: cash, category: 'Transfer' })
    const purchase = w.row(personal, '2026-09-20', -5_000, { category: 'Credit card payment' })
    const refund = w.row(personal, '2026-09-21', 5_000)
    const income = w.row(personal, '2026-09-21', 5_000, { category: 'Groceries' })
    const deleted = w.row(personal, '2026-09-21', 5_000, { category: 'Credit card payment', deletedAt: '2026-10-01T00:00:00Z' })
    const linked = w.payment(personal, '2026-09-22', 5_000)
    const bill = w.row(personal, '2026-09-01', -6_000, { category: 'Groceries' })
    personal.q.run("INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('payback', ?, ?, 5000)", linked, bill)
    for (const id of [offShared, purchase, refund, income, deleted, linked]) refused(() => w.split(personal, id, { family: 100 }), 400, only)
    // A split row isn't a payment of its own.
    const paid = w.payment(personal, '2026-09-20', 10_000)
    w.split(personal, paid, { family: 1_000 })
    for (const r of w.splitRows()) refused(() => w.split(r.ledger === 'family' ? family : personal, r.id, { family: 100 }), 400, only)
    // Another ledger's row and one that isn't there: the same answer.
    const theirs = w.payment(family, '2026-09-20', 1_000)
    refused(() => w.split(personal, theirs, { family: 100 }), 400, `There’s no transaction ${theirs} in Personal to split.`)
    refused(() => w.split(personal, 999_999, { family: 100 }), 400, 'There’s no transaction 999999 in Personal to split.')
  })

  it('refuses each wrong share, and changes nothing', () => {
    const w = example({ shareWith: ['family'] })
    const { personal } = w
    const before = w.everything(personal, w.family, w.trip)
    const input = (shares: SplitInput['shares']) => () => setSplit(personal, w.ctxOf, w.paid, { shares }, { actor: TESTER, usable: null })
    refused(input([{ ledger: 'personal', amountMinor: 100 }]), 400, 'Personal is Visa’s home, so it keeps the rest. Leave it out.')
    refused(input([{ ledger: 'trip', amountMinor: 100 }]), 400, 'There’s no ledger “trip” that has Visa.')
    refused(input([{ ledger: 'nowhere', amountMinor: 100 }]), 400, 'There’s no ledger “nowhere” that has Visa.')
    for (const amountMinor of [0, -100, 10.5]) refused(input([{ ledger: 'family', amountMinor }]), 400, 'Give Family an amount in whole cents, above zero.')
    refused(
      input([
        { ledger: 'family', amountMinor: 100 },
        { ledger: 'family', amountMinor: 200 },
      ]),
      400,
      'Give Family one amount.',
    )
    refused(input([{ ledger: 'family', amountMinor: 10_001 }]), 400, 'The shares come to $100.01, more than $100.00 paid.')
    expect(w.everything(personal, w.family, w.trip)).toEqual(before)
  })

  it('changes, lowers and undoes the split of a payment that’s no longer a card payment, and still splits no other one', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, family, trip } = w
    w.spentIn(personal, '2026-09-10', -20_000)
    w.spentIn(family, '2026-09-11', -20_000)
    w.spentIn(trip, '2026-09-12', -10_000)
    const paid = w.payment(personal, '2026-09-20', 10_000)
    w.split(personal, paid, { family: 8_000 })
    // Its category may change to one that counts: it's no card payment any more, and never split it couldn't be split now.
    const groceries = categoryId(personal, 'Groceries')
    expect(updateTransaction(personal, paid, transactionUpdateSchema.parse({ categoryId: groceries }))).toMatchObject({ categoryId: groceries, split: { keptMinor: 2_000 } })
    const other = w.row(personal, '2026-09-21', 5_000, { payee: PAYEE, category: 'Groceries' })
    refused(() => w.split(personal, other, { family: 1_000 }), 400, 'Only a card payment can be split.')
    // Personal −200 + 100 − 80. Family −200 + 80. Trip −100. (And the $50 that isn't split, in Personal.)
    expect(w.check()).toEqual({ personal: -13_000, family: -12_000, trip: -10_000 })

    // Lowered, changed, raised, with a ledger added and one taken out.
    expect(w.split(personal, paid, { family: 5_000 })).toMatchObject({ keptMinor: 5_000, shares: [{ ledger: { slug: 'family' }, amountMinor: 5_000 }] })
    expect(w.check()).toEqual({ personal: -10_000, family: -15_000, trip: -10_000 })
    expect(w.split(personal, paid, { family: 8_000, trip: 1_000 })).toMatchObject({ keptMinor: 1_000 })
    expect(w.check()).toEqual({ personal: -14_000, family: -12_000, trip: -9_000 })
    expect(w.split(personal, paid, { trip: 1_000 }, { dryRun: true })).toMatchObject({ keptMinor: 9_000 })
    expect(w.split(personal, paid, { trip: 1_000 })).toMatchObject({ keptMinor: 9_000 })
    expect(w.check()).toEqual({ personal: -6_000, family: -20_000, trip: -9_000 })
    // What Personal gave is still filed as it was, left out of totals. Only the payment counts, as its category says.
    expect(w.splitRows().map((r) => [r.ledger, r.amount])).toEqual([
      ['personal', -1_000],
      ['trip', 1_000],
    ])
    expect(periodSummary(trip, '2026-09-01', '2026-09-30')).toMatchObject({ spentMinor: 10_000, incomeMinor: 0 })

    // Its amount can go down to its shares, and no lower until the split is.
    refused(() => updateTransaction(personal, paid, transactionUpdateSchema.parse({ amountMinor: 900 })), 409, 'Its shares come to $10.00. Lower the split first.')
    w.split(personal, paid, { trip: 500 })
    expect(updateTransaction(personal, paid, transactionUpdateSchema.parse({ amountMinor: 900 }))).toMatchObject({ amountMinor: 900, split: { keptMinor: 400 } })

    // Undone with an empty list: an ordinary row again, which can't be split as it is.
    expect(w.split(personal, paid, {})).toMatchObject({ keptMinor: 900, shares: [], transaction: { split: null } })
    expect(w.splitRows()).toEqual([])
    // Personal −200 + 9 + 50. The others have only what they spent.
    expect(w.check()).toEqual({ personal: -14_100, family: -20_000, trip: -10_000 })
    refused(() => w.split(personal, paid, { family: 100 }), 400, 'Only a card payment can be split.')
  })

  it('needs a category for card payments in every ledger that gets a new row, the holder’s for a payment without one', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, family, trip } = w
    const paid = w.payment(personal, '2026-09-20', 10_000)
    const offTotals = (ctx: AppContext) => {
      for (const id of ctx.q.column<number>('SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND exclude_from_totals = 1')) {
        setCategoryEnabled(ctx, id, { enabled: false, moveTo: null })
      }
    }
    offTotals(trip)
    const before = w.everything(personal, family, trip)
    refused(() => w.split(personal, paid, { family: 1_000, trip: 1_000 }), 400, 'Trip has no category for card payments.')
    expect(w.everything(personal, family, trip)).toEqual(before)
    // Personal has none either: a transfer with no category of its own would give a given row none.
    offTotals(personal)
    const chequing = makeAccount(personal, 'Chequing')
    const out = w.row(personal, '2026-09-24', -3_000, { account: chequing })
    const pairPaid = w.row(personal, '2026-09-25', 3_000, { payee: PAYEE })
    personal.q.run('UPDATE transactions SET transfer_pair_id = ? WHERE ledger_id = @ledger AND id = ?', out, pairPaid)
    personal.q.run('UPDATE transactions SET transfer_pair_id = ? WHERE ledger_id = @ledger AND id = ?', pairPaid, out)
    refused(() => w.split(personal, pairPaid, { family: 1_000 }), 400, 'Personal has no category for card payments.')
    w.check()
  })

  it('keeps an archived ledger’s share as it is: not added, changed or left out', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, storage } = w
    const paid = w.payment(personal, '2026-09-20', 10_000)
    w.split(personal, paid, { trip: 2_000 })
    storage.registry.update(w.trip.ledger.id, { archived: true })
    refused(() => w.split(personal, paid, { trip: 3_000 }), 400, 'Trip is archived, so its share stays at $20.00.')
    refused(() => w.split(personal, paid, { trip: 1_000 }), 400, 'Trip is archived, so its share stays at $20.00.')
    refused(() => w.split(personal, paid, { family: 1_000 }), 400, 'Trip is archived, so its share stays at $20.00.')
    // As it is, with Family's changing beside it.
    expect(w.split(personal, paid, { trip: 2_000, family: 1_000 })).toMatchObject({ keptMinor: 7_000 })
    const other = w.payment(personal, '2026-09-21', 5_000)
    refused(() => w.split(personal, other, { trip: 1_000 }), 400, 'Trip is archived, so it can’t be given a share.')
    w.check()
  })

  it('needs a key allowed in the holder and in every ledger with a share, before and after', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, family, trip } = w
    const paid = w.payment(personal, '2026-09-20', 10_000)
    const [p, f, t] = [personal.ledger.id, family.ledger.id, trip.ledger.id]
    refused(() => w.split(personal, paid, { trip: 1_000 }, { usable: [p, f] }), 403, 'This key can’t use Trip, so it can’t change how this payment is split.')
    refused(() => w.split(personal, paid, { family: 1_000 }, { usable: [f] }), 403, 'This key can’t use Personal, so it can’t change how this payment is split.')
    w.split(personal, paid, { family: 1_000 }, { usable: [p, f] })
    w.split(personal, paid, { trip: 1_000 }, { usable: [p, f, t] })
    // Taking Trip's share away writes in Trip too.
    refused(() => w.split(personal, paid, { family: 1_000 }, { usable: [p, f] }), 403, /can’t use Trip/)
    refused(() => w.split(personal, paid, {}, { usable: [p, f] }), 403, /can’t use Trip/)
    w.check()
  })
})

describe('locked while split', () => {
  const update = (ctx: AppContext, id: number, input: Record<string, unknown>) => () => updateTransaction(ctx, id, transactionUpdateSchema.parse(input))

  it('refuses what a split row takes from the split, and lets its notes, tags, name and category left out of totals change', async () => {
    const w = example()
    const { personal, family } = w
    w.split(personal, w.paid, { family: 8_000 })
    const share = w.splitRows().find((r) => r.ledger === 'family')!.id
    const given = w.splitRows().find((r) => r.ledger === 'personal')!.id
    const cash = makeAccount(family, 'Cash', 'cash')
    const item = createRecurring(
      family,
      recurringCreateSchema.parse({ payee: 'Gym', expectedAmountMinor: -5_000, cadence: 'monthly', anchorDate: '2026-09-01' }),
    ).id
    for (const [ctx, id, message] of [
      [family, share, SHARE_LOCK],
      [personal, given, GIVEN_LOCK],
    ] as const) {
      const amount = id === share ? 7_000 : -7_000
      for (const input of [
        { amountMinor: amount },
        { date: '2026-09-21' },
        { accountId: ctx === family ? cash : makeAccount(personal, 'Cash', 'cash') },
        { payee: 'Someone' },
        { status: 'pending' },
        { recurringItemId: ctx === family ? item : null },
        { categoryId: categoryId(ctx, 'Groceries') },
        { categoryId: null },
      ]) {
        if (input.recurringItemId === null) continue
        refused(update(ctx, id, input), 409, message)
      }
      refused(() => deleteTransaction(ctx, id), 409, message)
      refused(() => bulkUpdate(ctx, bulkUpdateSchema.parse({ ids: [id], delete: true })), 409, message)
      refused(() => bulkUpdate(ctx, bulkUpdateSchema.parse({ ids: [id], categoryId: categoryId(ctx, 'Groceries') })), 409, message)
      // Its notes, tags, name, and another category left out of totals.
      update(ctx, id, { notes: 'ours', tags: ['card'], name: 'Card', categoryId: categoryId(ctx, 'Transfer') })()
      bulkUpdate(ctx, bulkUpdateSchema.parse({ ids: [id], categoryId: categoryId(ctx, 'Credit card payment'), addTags: ['paid'] }))
      // What the form sends back unchanged saves.
      const t = getTransaction(ctx, id)
      update(ctx, id, { amountMinor: t.amountMinor, date: t.date, payee: t.payee, status: t.status, accountId: t.accountId, notes: 'again' })()
      expect(getTransaction(ctx, id)).toMatchObject({ notes: 'again', name: 'Card', amountMinor: amount === 7_000 ? 8_000 : -8_000 })
    }
    // A recurring item never takes one, by hand either.
    refused(() => addPayment(family, item, share), 409, SHARE_LOCK)
    // Links, from either side.
    const bill = w.row(family, '2026-09-15', -9_000, { category: 'Groceries' })
    refused(() => setLinks(family, share, [{ transactionId: bill, kind: 'payback', amountMinor: 1_000 }]), 409, SHARE_LOCK)
    refused(() => setLinks(family, bill, [{ transactionId: share, kind: 'payback', amountMinor: 1_000 }]), 409, SHARE_LOCK)
    refused(() => setLinks(personal, given, [{ transactionId: w.paid, kind: 'refund', amountMinor: 1_000 }]), 409, GIVEN_LOCK)
    expect(linkCandidates(family, share, { kind: 'payback' })).toEqual([])
    expect(linkCandidates(family, bill, { kind: 'payback' }).map((c) => c.transaction.id)).not.toContain(share)
    w.check()
  })

  it('refuses a split payment’s date, account, status, payee, delete in every path and an amount below its shares, and lets the rest change', async () => {
    const w = world()
    const { personal } = w
    const chequing = makeAccount(personal, 'Chequing')
    // Entered as a transfer from chequing: its two sides stay in step.
    const out = await createTransaction(
      personal,
      transactionCreateSchema.parse({ accountId: chequing, date: '2026-09-20', amountMinor: -10_000, payee: 'Visa payment', transferAccountId: w.visa }),
    )
    {
      const paid = out.transferPairId!
      w.split(personal, paid, { family: 8_000 })
      for (const [input, what] of [
        [{ date: '2026-09-21' }, 'date'],
        [{ datetime: '2026-09-20T09:00:00' }, 'date'],
        [{ accountId: makeAccount(personal, 'Other card', 'credit') }, 'account'],
        [{ status: 'pending' }, 'status'],
        [{ payee: 'Paid' }, 'payee'],
      ] as const) {
        refused(update(personal, paid, input), 409, `It’s split between ledgers. Undo the split to change its ${what}.`)
      }
      refused(update(personal, paid, { amountMinor: 7_999 }), 409, 'Its shares come to $80.00. Lower the split first.')
      // From the chequing side, which the payment follows.
      refused(update(personal, out.id, { date: '2026-09-21' }), 409, 'It’s split between ledgers. Undo the split to change its date.')
      refused(update(personal, out.id, { payee: 'Paid' }), 409, 'It’s split between ledgers. Undo the split to change its payee.')
      refused(update(personal, out.id, { amountMinor: -5_000 }), 409, 'Its shares come to $80.00. Lower the split first.')
      // Deleted: from the form, from the chequing side, and in bulk, where nothing goes.
      const other = w.row(personal, '2026-09-22', -1_000)
      refused(() => deleteTransaction(personal, paid), 409, UNDO_FIRST)
      refused(() => deleteTransaction(personal, out.id), 409, UNDO_FIRST)
      refused(() => bulkUpdate(personal, bulkUpdateSchema.parse({ ids: [other, out.id], delete: true })), 409, UNDO_FIRST)
      refused(() => bulkUpdate(personal, bulkUpdateSchema.parse({ ids: [other, paid], delete: true })), 409, UNDO_FIRST)
      expect(getTransaction(personal, other).id).toBe(other)
      // Nor linked as money in.
      refused(() => setLinks(personal, paid, [{ transactionId: other, kind: 'refund', amountMinor: 1_000 }]), 409, UNDO_FIRST)
      expect(linkCandidates(personal, paid, { kind: 'refund' })).toEqual([])

      // A larger amount, from either side: Personal takes it, the shares stay.
      update(personal, out.id, { amountMinor: -12_000 })()
      expect(getTransaction(personal, paid)).toMatchObject({ amountMinor: 12_000, split: { part: 'payment', keptMinor: 4_000 } })
      update(personal, paid, { amountMinor: 8_000, notes: 'all given', categoryId: categoryId(personal, 'Transfer') })()
      expect(getTransaction(personal, paid).split).toMatchObject({ keptMinor: 0 })
      expect(w.check()).toEqual({ personal: -1_000, family: 8_000 })
      // Not a transfer: allowed, and the split stays.
      update(personal, paid, { transferPairId: null })()
      expect(getTransaction(personal, paid)).toMatchObject({ transferPairId: null, split: { part: 'payment' } })
      expect(getTransaction(personal, out.id).transferPairId).toBeNull()
      w.check()
    }
  })
})

describe('the four ways a split ends or shrinks', () => {
  /** Personal −200, Family −200 and Trip −100 on Visa, and a $100 payment in Personal split $50 to Family and $30 to Trip. */
  function three() {
    const w = world({ shareWith: ['family', 'trip'] })
    w.spentIn(w.personal, '2026-09-01', -20_000)
    w.spentIn(w.family, '2026-09-02', -20_000)
    w.spentIn(w.trip, '2026-09-03', -10_000)
    const paid = w.payment(w.personal, '2026-09-20', 10_000)
    w.split(w.personal, paid, { family: 5_000, trip: 3_000 })
    expect(w.check()).toEqual({ personal: -18_000, family: -15_000, trip: -7_000 })
    /** Each ledger's part at past dates, for what detaching must not change. */
    const history = () => w.ledgers.map((c) => [...balancesAt(c, ['2026-08-31', '2026-09-19', '2026-09-20', '2026-09-30', '2026-10-03']).get(w.visa)!])
    return { ...w, paid, history }
  }

  it('undoSplit: every share back with the holder', () => {
    const w = three()
    expect(undoSplit(w.personal, w.ctxOf, w.paid, TESTER)).toEqual({ removed: 3 })
    expect(w.splitRows()).toEqual([])
    expect(w.check()).toEqual({ personal: -10_000, family: -20_000, trip: -10_000 })
    expect(getTransaction(w.personal, w.paid).split).toBeNull()
    expect(undoSplit(w.personal, w.ctxOf, w.paid, TESTER)).toEqual({ removed: 0 })
  })

  it('dropShare: that ledger’s share back with the holder, and with the last one the payment isn’t split', () => {
    const w = three()
    const familyBefore = w.everything(w.family)
    expect(dropShare(w.personal, w.ctxOf, w.paid, w.trip.ledger.id, TESTER)).toEqual({ amountMinor: 3_000, last: false })
    expect(w.check()).toEqual({ personal: -15_000, family: -15_000, trip: -10_000 })
    expect(w.splitRows().map((r) => [r.ledger, r.amount])).toEqual([
      ['personal', -5_000],
      ['family', 5_000],
    ])
    // Family's rows are as they were.
    expect(w.everything(w.family)[0]!.transactions).toEqual(familyBefore[0]!.transactions)
    expect(dropShare(w.personal, w.ctxOf, w.paid, w.family.ledger.id, TESTER)).toEqual({ amountMinor: 5_000, last: true })
    expect(w.splitRows()).toEqual([])
    expect(getTransaction(w.personal, w.paid).split).toBeNull()
    expect(w.check()).toEqual({ personal: -10_000, family: -20_000, trip: -10_000 })
    // The holder has no share of its own to drop, and a ledger without one none either.
    expect(() => dropShare(w.personal, w.ctxOf, w.paid, w.family.ledger.id, TESTER)).toThrow('has no share')
  })

  it('dropShare of the last share lets the account be deleted once the member has left', () => {
    const w = world()
    const paid = w.payment(w.personal, '2026-09-20', 10_000)
    w.split(w.personal, paid, { family: 8_000 })
    refused(() => deleteAccount(w.personal, w.ctxOf, w.visa), 409, 'Stop sharing Visa first.')
    refused(() => removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER), 400, /Say whether Family’s 1 transaction/)
    dropShare(w.personal, w.ctxOf, paid, w.family.ledger.id, TESTER)
    removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    deleteAccount(w.personal, w.ctxOf, w.visa)
    expect(w.personal.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND account_id = ?', w.visa)).toBe(0)
  })

  it('detachShare: the share is that ledger’s own row, with a plain row for it in the holder, and no part changes at any date', () => {
    const w = three()
    const history = w.history()
    const familyBefore = w.everything(w.family)
    const trip = w.splitRows().find((r) => r.ledger === 'trip')!
    const { plainId, last } = detachShare(w.personal, w.ctxOf, w.paid, w.trip.ledger.id, TESTER)
    expect(last).toBe(false)
    expect(w.check()).toEqual({ personal: -18_000, family: -15_000, trip: -7_000 })
    expect(w.history()).toEqual(history)
    // A ledger that chose nothing has nothing changed, not even its activity.
    expect(w.everything(w.family)).toEqual(familyBefore)
    expect(getTransaction(w.trip, trip.id)).toMatchObject({ amountMinor: 3_000, split: null, payee: PAYEE })
    expect(getTransaction(w.personal, plainId)).toMatchObject({
      amountMinor: -3_000,
      payee: GIVEN_PAYEE,
      date: '2026-09-20',
      origin: 'manual',
      categorySource: 'user',
      categoryId: categoryId(w.personal, 'Credit card payment'),
      split: null,
    })
    expect(w.splitRows().map((r) => [r.ledger, r.amount])).toEqual([
      ['personal', -5_000],
      ['family', 5_000],
    ])
    // An ordinary row from then on.
    updateTransaction(w.trip, trip.id, transactionUpdateSchema.parse({ amountMinor: 2_500 }))
    deleteTransaction(w.personal, plainId)

    // The last share: the given row itself becomes the plain row.
    const given = w.splitRows().find((r) => r.ledger === 'personal')!
    expect(detachShare(w.personal, w.ctxOf, w.paid, w.family.ledger.id, TESTER)).toMatchObject({ plainId: given.id, last: true })
    expect(w.splitRows()).toEqual([])
    expect(getTransaction(w.personal, w.paid).split).toBeNull()
    w.check()
  })

  it('detachSplit: every split row is an ordinary row where it is, and no part changes at any date', () => {
    const w = three()
    const history = w.history()
    const parts = w.check()
    const rows = w.splitRows()
    expect(detachSplit(w.personal, w.ctxOf, w.paid, TESTER)).toEqual({ detached: 3 })
    expect(w.splitRows()).toEqual([])
    expect(w.check()).toEqual(parts)
    expect(w.history()).toEqual(history)
    for (const r of rows) {
      const ctx = w.ledgers.find((c) => c.ledger.slug === r.ledger)!
      expect(getTransaction(ctx, r.id)).toMatchObject({ amountMinor: r.amount, split: null })
    }
    // The payment can be deleted now.
    deleteTransaction(w.personal, w.paid)
  })

  it('leaveSplits: a leaving ledger’s split payments detached, and its shares dropped or detached as asked', () => {
    const w = three()
    const { personal, family, trip } = w
    // Family holds a payment of its own, split with Trip.
    const theirs = w.payment(personal, '2026-09-25', 2_000)
    w.move(personal, [theirs], family)
    // Family keeps 10, Trip gets 5, and Personal the other 5.
    w.split(family, theirs, { family: 1_000, trip: 500 })
    const parts = w.check()
    expect(parts).toEqual({ personal: -17_500, family: -14_000, trip: -6_500 })
    // Trip leaves: its share of Personal's payment is dropped, of Family's detached.
    const done = leaveSplits(trip, w.ctxOf, w.visa, { shares: (holder) => (holder === personal.ledger.id ? 'drop' : 'detach'), actor: TESTER })
    expect(done).toMatchObject({ detachedSplits: 0, droppedShares: 1, detachedShares: 1 })
    expect(done.splits).toEqual([
      { done: 'droppedShare', holder: { slug: 'personal', name: 'Personal' }, date: '2026-09-20', paymentMinor: 10_000, amountMinor: 3_000, currency: 'CAD' },
      { done: 'detachedShare', holder: { slug: 'family', name: 'Family' }, date: '2026-09-25', paymentMinor: 2_000, amountMinor: 500, currency: 'CAD' },
    ])
    expect(w.check()).toEqual({ personal: -14_500, family: -14_000, trip: -9_500 })
    expect(trip.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND split_of IS NOT NULL')).toBe(0)
    // Family leaves: the payment it holds has its split detached, its share of Personal's is detached.
    expect(leaveSplits(family, w.ctxOf, w.visa, { shares: () => 'detach', actor: TESTER })).toMatchObject({ detachedSplits: 1, droppedShares: 0, detachedShares: 1 })
    expect(w.splitRows()).toEqual([])
    w.check()
  })
})

describe('when the bank changes the payment', () => {
  it('followPayment copies its date, time and status to the split rows, and its payee to the shares', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const paid = w.payment(w.personal, '2026-09-20', 10_000)
    w.split(w.personal, paid, { family: 2_000, trip: 1_000 })
    expect(followPayment(w.personal, w.ctxOf, paid)).toBe(0)
    // As apply.ts writes the bank's facts.
    w.personal.q.run("UPDATE transactions SET date = '2026-09-22', datetime = '2026-09-22T10:00:00', status = 'pending', payee = 'PAYMENT RECEIVED' WHERE ledger_id = @ledger AND id = ?", paid)
    expect(followPayment(w.personal, w.ctxOf, paid)).toBe(3)
    const rows = w.splitRows().map((r) => getTransaction(w.ledgers.find((c) => c.ledger.slug === r.ledger)!, r.id))
    for (const r of rows) expect(r).toMatchObject({ date: '2026-09-22', datetime: '2026-09-22T10:00:00', status: 'pending' })
    expect(rows.map((r) => r.payee)).toEqual([GIVEN_PAYEE, 'PAYMENT RECEIVED', 'PAYMENT RECEIVED'])
    w.check()
  })
})

/** Applied to Visa in its home as Plaid's changes. */
const remote = (remoteId: string, date: string, amountMinor: number, payee: string): RemoteTransaction => ({
  remoteId,
  date,
  amountMinor,
  payee,
  description: payee,
  pending: false,
  raw: { remoteId },
})

describe('split rows left out of matching', () => {
  const plaid = (w: ReturnType<typeof world>, changed: RemoteTransaction[]) => {
    const result = applyRemoteTransactions(w.personal, w.ctxOf, w.visa, changed, { removed: [], floor: null }, 'plaid')
    for (const c of w.ledgers) matchTransactions(c)
    return result
  }
  const synced = (w: ReturnType<typeof world>, externalId: string) => w.personal.q.get<{ id: number; categoryId: number | null; source: string | null }>(
    'SELECT id, category_id AS categoryId, category_source AS source FROM transactions WHERE ledger_id = @ledger AND external_id = ?',
    externalId,
  )!

  it('files the next payment as a card payment after a split and after a detach', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const card = categoryId(w.personal, 'Credit card payment')
    plaid(w, [remote('c1', '2026-09-01', -5_000, 'Corner Cafe'), remote('p1', '2026-09-10', 3_000, PAYEE)])
    expect(synced(w, 'p1')).toMatchObject({ categoryId: card, source: 'rule' })
    w.split(w.personal, synced(w, 'p1').id, { family: 1_000, trip: 500 })
    plaid(w, [remote('p2', '2026-09-20', 4_000, PAYEE)])
    expect(synced(w, 'p2')).toMatchObject({ categoryId: card, source: 'rule' })
    // A credit with the given row's payee is no refund of it.
    plaid(w, [remote('p3', '2026-09-21', 400, GIVEN_PAYEE)])
    expect(synced(w, 'p3')).toMatchObject({ categoryId: card, source: 'rule' })
    expect(w.personal.q.pluck('SELECT count(*) FROM transaction_links l JOIN transactions t ON t.id = l.money_in_id WHERE t.ledger_id = @ledger')).toBe(0)
    detachShare(w.personal, w.ctxOf, synced(w, 'p1').id, w.trip.ledger.id, TESTER)
    detachShare(w.personal, w.ctxOf, synced(w, 'p1').id, w.family.ledger.id, TESTER)
    plaid(w, [remote('p4', '2026-09-28', 2_000, PAYEE)])
    expect(synced(w, 'p4')).toMatchObject({ categoryId: card, source: 'rule' })
    w.check()
  })

  it('leaves a member’s given row out of the home’s merchant check', () => {
    const w = world()
    const card = categoryId(w.personal, 'Credit card payment')
    const paid = w.payment(w.personal, '2026-09-10', 3_000)
    w.move(w.personal, [paid], w.family)
    w.split(w.family, paid, { family: 1_000 })
    expect(w.personal.accountWide.purchasePayees(w.visa, '2026-01-01', '2026-12-31')).toEqual([])
    // Money back "from" the given row's payee, in the home: a payment still, not money back from a purchase elsewhere.
    plaid(w, [remote('p2', '2026-09-20', 700, GIVEN_PAYEE)])
    expect(synced(w, 'p2')).toMatchObject({ categoryId: card, source: 'rule' })
    w.check()
  })

  it('adds a later payment of a share’s amount as the bank’s, never adopting the share', () => {
    const w = example()
    w.split(w.personal, w.paid, { family: 8_000 })
    const share = w.splitRows().find((r) => r.ledger === 'family')!
    expect(plaid(w, [remote('p2', '2026-09-21', 8_000, PAYEE)])).toMatchObject({ added: 1, adopted: 0 })
    expect(w.family.q.get('SELECT external_id AS externalId, origin FROM transactions WHERE ledger_id = @ledger AND id = ?', share.id)).toEqual({ externalId: null, origin: 'manual' })
    expect(w.personal.accountWide.bankRows(w.visa, '2026-01-01').map((r) => r.id)).not.toContain(share.id)
    w.check()
  })

  it('finds no CSV duplicate in a split row', () => {
    const w = example()
    w.split(w.personal, w.paid, { family: 8_000 })
    const preview = previewImport(w.personal, importPreviewSchema.parse({ accountId: w.visa, rows: [{ line: 1, date: '2026-09-20', payee: PAYEE, amountMinor: 8_000 }] }))
    expect(preview[0]).toMatchObject({ duplicateOf: null, duplicateElsewhere: false })
    // The payment itself is still one.
    const again = previewImport(w.personal, importPreviewSchema.parse({ accountId: w.visa, rows: [{ line: 1, date: '2026-09-20', payee: PAYEE, amountMinor: 10_000 }] }))
    expect(again[0]).toMatchObject({ duplicateOf: w.paid })
  })

  it('gives a bank switch the payment and not its split rows, and its review the same version', () => {
    const w = example()
    const stamp = w.personal.accountWide.switchStamp(w.visa)
    w.split(w.personal, w.paid, { family: 8_000 })
    const ids = w.personal.accountWide.switchRows(w.visa, '2026-01-01').map((r) => r.id)
    expect(ids).toContain(w.paid)
    for (const r of w.splitRows()) expect(ids).not.toContain(r.id)
    expect(w.personal.accountWide.switchStamp(w.visa)).toBe(stamp)
  })

  it('never gives a split row to a recurring item: not suggested, offered, relinked or listed', () => {
    const w = example()
    const { personal, family } = w
    w.split(personal, w.paid, { family: 8_000 })
    const earlier = w.payment(personal, '2026-08-20', 10_000)
    w.split(personal, earlier, { family: 8_000 })
    const shares = w.splitRows().filter((r) => r.ledger === 'family').map((r) => r.id)
    const item = createRecurring(
      family,
      recurringCreateSchema.parse({ payee: PAYEE, expectedAmountMinor: 8_000, cadence: 'monthly', anchorDate: '2026-08-20', accountId: w.visa }),
    )
    recalculateRecurring(family, item.id, { followAmount: true })
    expect(getRecurring(family, item.id)).toMatchObject({ possiblePayment: null })
    for (const id of shares) expect(getTransaction(family, id).recurringItemId).toBeNull()
    expect(recurringPaymentCandidates(family, item.id, {}).map((c) => c.transaction.id)).toEqual([])
    expect(recurringPaymentCandidates(family, item.id, { q: 'payment' }).map((c) => c.transaction.id)).toEqual([])
    updateRecurring(family, item.id, { status: 'suggested' })
    expect(getRecurring(family, item.id)).toMatchObject({ occurrences: 0 })
    w.check()
  })
})

describe('ledgers holding split rows', () => {
  it('run the nightly job and the purge', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const paid = w.payment(w.personal, '2026-09-20', 10_000)
    w.split(w.personal, paid, { family: 2_000, trip: 1_000 })
    const old = [w.row(w.personal, '2026-08-01', -100, { deletedAt: '2026-08-02T00:00:00Z' }), w.row(w.family, '2026-08-01', -100, { deletedAt: '2026-08-02T00:00:00Z' })]
    expect(runDailyJobs(w.storage)).toEqual([])
    for (const c of w.ledgers) expect(c.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND id IN (?, ?)', ...old)).toBe(0)
    expect(w.splitRows()).toHaveLength(3)
    w.check()
  })
})
