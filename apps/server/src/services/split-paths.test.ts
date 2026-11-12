import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { categoryId } from '../test/helpers'
import {
  expectNoCrossLedgerReferences,
  expectPartsSumToAccount,
  sharedWorld,
  TESTER,
} from '../test/shared-accounts'
import { ledgerRows } from '../test/world'
import { balancesAt, deleteAccount, getAccount, setBalance } from './accounts'
import { applyRemoteTransactions, type ApplyScope } from './bank/apply'
import type { RemoteTransaction } from './bank/types'
import type { AppContext } from './context'
import { matchTransactions } from './matching'
import { moveTransactions, sendAsDeleted } from './moves'
import { eraseAll } from './setup'
import { periodSummary } from './reports'
import { changeHome, removeMember, setSharing, type SharingInput } from './sharing'
import {
  detachShare,
  detachSplit,
  dropShare,
  GIVEN_PAYEE,
  leaveLedgerSplits,
  setSplit,
  undoSplit,
} from './splits'
import { getTransaction, listAccountTransactions } from './transactions'

/**
 * A payment split between the ledgers that share its account, in the paths built before splits:
 * moving rows, stopping sharing (both choices), bank sync, the all-ledgers list, and deleting the
 * account or a ledger. Personal is Visa's home, and Family and Trip have it. A row a member holds
 * got there by a real move. Every number is worked out by hand in the comments.
 */

const PAYEE = 'PAYMENT THANK YOU'

/** Month-ends and the days around each payment, before today (2026-10-03). */
const DATES = [
  '2026-07-31',
  '2026-08-19',
  '2026-08-20',
  '2026-08-31',
  '2026-09-04',
  '2026-09-05',
  '2026-09-24',
  '2026-09-25',
  '2026-09-30',
]

function world() {
  const w = sharedWorld({ shareWith: ['family', 'trip'] })
  const { personal } = w
  const ledgers = [w.personal, w.family, w.trip]
  /** A row a ledger holds on Visa, entered as by hand unless `origin` says. */
  const row = (
    ctx: AppContext,
    date: string,
    amount: number,
    more: {
      payee?: string
      category?: string
      origin?: 'manual' | 'sync'
      externalId?: string
      status?: 'pending' | 'cleared'
    } = {},
  ) => {
    const category = more.category ? categoryId(ctx, more.category) : null
    return Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, category_source, origin, external_id, status)
         VALUES (@ledger, @account, @date, @amount, @payee, lower(@payee), @category, @source, @origin, @externalId, @status)`,
        {
          account: w.visa,
          date,
          amount,
          payee: more.payee ?? 'Shop',
          category,
          source: category ? 'user' : null,
          origin: more.origin ?? 'manual',
          externalId: more.externalId ?? null,
          status: more.status ?? 'cleared',
        },
      ).lastInsertRowid,
    )
  }
  const move = (from: AppContext, ids: number[], to: AppContext) =>
    moveTransactions(from, w.ctxOf, { ids, to: to.ledger.id }, TESTER)
  /** A purchase on Visa entered in Personal and moved to `to`. */
  const spentIn = (to: AppContext, date: string, amount: number) => {
    const id = row(personal, date, amount, { category: 'Groceries' })
    if (to !== personal) move(personal, [id], to)
    return id
  }
  const split = (ctx: AppContext, id: number, shares: Record<string, number>) =>
    setSplit(
      ctx,
      w.ctxOf,
      id,
      { shares: Object.entries(shares).map(([ledger, amountMinor]) => ({ ledger, amountMinor })) },
      { actor: TESTER, usable: null },
    )
  const set = (ctx: AppContext, input: SharingInput, dryRun = false) =>
    setSharing(ctx, w.ctxOf, w.visa, input, { dryRun, actor: TESTER, usable: null })
  /** Every split row in the database, on any account, by ledger slug. */
  const splitRows = () =>
    ledgers.flatMap((c) =>
      c.q
        .all<{ id: number; account: number; amount: number; splitOf: number }>(
          'SELECT id, account_id AS account, amount_minor AS amount, split_of AS splitOf FROM transactions WHERE ledger_id = @ledger AND split_of IS NOT NULL ORDER BY id',
        )
        .map((r) => ({ ledger: c.ledger.slug, ...r })),
    )
  /** The part of Visa at DATES of each ledger that has it, by slug. */
  const history = () => {
    const having = personal.accountWide.ledgers(w.visa).map((l) => l.ledgerId)
    return Object.fromEntries(
      ledgers
        .filter((c) => having.includes(c.ledger.id))
        .map((c) => [c.ledger.slug, [...balancesAt(c, DATES).get(w.visa)!]]),
    )
  }
  /**
   * What every case leaves: the parts sum to Visa (and to `accounts`), nothing refers across
   * ledgers, and every remaining split sums to zero. Returns Visa's parts today.
   */
  const check = (...accounts: number[]) => {
    const { parts } = expectPartsSumToAccount(w.storage, w.visa, { dates: DATES })
    for (const a of accounts) expectPartsSumToAccount(w.storage, a, { dates: DATES })
    expectNoCrossLedgerReferences(w.storage)
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
    const byPayment = new Map<number, number>()
    for (const r of splitRows()) byPayment.set(r.splitOf, (byPayment.get(r.splitOf) ?? 0) + r.amount)
    for (const [id, total] of byPayment) expect(total, `the split rows of ${id} sum to zero`).toBe(0)
    return parts
  }
  const everything = () => ledgers.map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
  /** The accounts split off from Visa, in whichever ledger kept its rows on one. */
  const splitOffs = () =>
    ledgers.flatMap((c) =>
      c.q.column<number>(
        'SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND split_from_id = ?',
        w.visa,
      ),
    )
  return { ...w, ledgers, row, move, spentIn, split, set, splitRows, history, check, everything, splitOffs }
}

/**
 * Personal −200, Family −200 and Trip −100 on Visa in August, then three card payments, each split
 * three ways:
 * - A, $100 on Aug 20, Personal's: $50 to Family, $30 to Trip, Personal keeps $20.
 * - B, $60 on Sep 5, moved to Trip: Trip keeps $20, Family gets $25, Personal the other $15.
 * - C, $40 on Sep 25, pending with a bank id, moved to Family: Family keeps $10, Trip gets $10,
 *   Personal the other $20.
 * Family, the ledger that leaves, holds a share of the home's payment (A), a share of a third
 * ledger's payment (B), and a split payment of its own (C).
 */
function three() {
  const w = world()
  const { personal, family, trip } = w
  w.spentIn(personal, '2026-08-10', -20_000)
  w.spentIn(family, '2026-08-11', -20_000)
  w.spentIn(trip, '2026-08-12', -10_000)
  const card = { payee: PAYEE, category: 'Credit card payment' }
  const a = w.row(personal, '2026-08-20', 10_000, card)
  w.split(personal, a, { family: 5_000, trip: 3_000 })
  const b = w.row(personal, '2026-09-05', 6_000, card)
  w.move(personal, [b], trip)
  w.split(trip, b, { trip: 2_000, family: 2_500 })
  const c = w.row(personal, '2026-09-25', 4_000, {
    ...card,
    origin: 'sync',
    externalId: 'c-pay',
    status: 'pending',
  })
  w.move(personal, [c], family)
  w.split(family, c, { family: 1_000, trip: 1_000 })
  // Personal −200 + 100 − 80 + 15 + 20. Family −200 + 50 + 25 + 40 − 30. Trip −100 + 30 + 60 − 40 + 10.
  expect(w.check()).toEqual({ personal: -14_500, family: -11_500, trip: -4_000 })
  const history = w.history()
  // On Aug 31: Personal −200 + 100 − 80, Family −200 + 50, Trip −100 + 30.
  expect(history.personal![3]).toBe(-18_000)
  expect(history.family![3]).toBe(-15_000)
  expect(history.trip![3]).toBe(-7_000)
  return { ...w, a, b, c, before: history }
}

/** An HTTP error with this status and message. */
function refused(fn: () => unknown, status: number, message: string) {
  let error: unknown
  try {
    fn()
  } catch (err) {
    error = err
  }
  expect(error, 'refused').toBeInstanceOf(HTTPException)
  expect({ status: (error as HTTPException).status, message: (error as HTTPException).message }).toEqual({
    status,
    message,
  })
}

const personalRef = { slug: 'personal', name: 'Personal' }
const familyRef = { slug: 'family', name: 'Family' }
const tripRef = { slug: 'trip', name: 'Trip' }

describe('moving part of a split', () => {
  it('refuses a split payment and its split rows, naming the payment, and moves nothing', () => {
    const w = three()
    const { personal, family, trip } = w
    const rows = w.splitRows()
    const of = (ledger: string, payment: number) =>
      rows.find((r) => r.ledger === ledger && r.splitOf === payment)!.id
    const before = w.everything()
    const A = 'Undo the split of the $100.00 payment onto Visa on 2026-08-20 first.'
    // The payment, and the row beside it of what it gave.
    refused(() => w.move(personal, [w.a], family), 400, A)
    refused(() => w.move(personal, [of('personal', w.a)], trip), 400, A)
    // A share names the ledger that holds the payment.
    refused(
      () => w.move(family, [of('family', w.a)], personal),
      400,
      'Undo the split of the payment onto Visa on 2026-08-20 in Personal first.',
    )
    refused(
      () => w.move(personal, [of('personal', w.b)], family),
      400,
      'Undo the split of the payment onto Visa on 2026-09-05 in Trip first.',
    )
    refused(
      () => w.move(trip, [w.b], personal),
      400,
      'Undo the split of the $60.00 payment onto Visa on 2026-09-05 first.',
    )
    // With an ordinary row beside it, and in a dry run.
    const groceries = family.q.pluck<number>(
      "SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND payee = 'Shop'",
      w.visa,
    )!
    refused(
      () => w.move(family, [groceries, w.c], personal),
      400,
      'Undo the split of the $40.00 payment onto Visa on 2026-09-25 first.',
    )
    refused(
      () =>
        moveTransactions(
          family,
          w.ctxOf,
          { ids: [of('family', w.a)], to: trip.ledger.id, dryRun: true },
          TESTER,
        ),
      400,
      'Undo the split of the payment onto Visa on 2026-08-20 in Personal first.',
    )
    expect(w.everything()).toEqual(before)

    // Sending rows away as deleted never takes one either.
    expect(() => sendAsDeleted(personal, w.ctxOf, { ids: [w.a], to: family.ledger.id })).toThrow(
      'part of a split',
    )
    expect(() =>
      sendAsDeleted(family, w.ctxOf, { ids: [groceries, of('family', w.b)], to: personal.ledger.id }),
    ).toThrow('part of a split')
    expect(w.everything()).toEqual(before)

    // Once the split is undone, the payment moves.
    undoSplit(personal, w.ctxOf, w.a, TESTER)
    w.move(personal, [w.a], family)
    w.check()
  })
})

/** Each way sharing can end, every ledger but the home taken out. */
const endings: Array<[string, (w: ReturnType<typeof three>) => AppContext]> = [
  [
    'one at a time, home',
    (w) => {
      removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER, { rows: 'home' })
      w.check()
      removeMember(w.personal, w.ctxOf, w.visa, w.trip.ledger.id, TESTER, { rows: 'home' })
      return w.personal
    },
  ],
  [
    'one at a time, keep',
    (w) => {
      removeMember(w.personal, w.ctxOf, w.visa, w.trip.ledger.id, TESTER, { rows: 'keep' })
      w.check()
      removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER, { rows: 'keep' })
      return w.personal
    },
  ],
  [
    'both in one go, home and keep',
    (w) => (
      w.set(w.personal, { ledgers: ['personal'], rows: { family: 'home', trip: 'keep' } }),
      w.personal
    ),
  ],
  [
    'Family made the home, Personal and Trip taken out',
    (w) => (
      w.set(w.personal, { ledgers: ['family'], home: 'family', rows: { personal: 'home', trip: 'keep' } }),
      w.family
    ),
  ],
]

describe('stopping sharing with a ledger that takes part in splits', () => {
  it('with “home”: drops its share of the home’s payment, detaches the rest, then moves its rows home', () => {
    const w = three()
    const { personal, family, trip } = w
    const input: SharingInput = { ledgers: ['personal', 'trip'], rows: { family: 'home' } }
    const unchanged = w.everything()
    const dry = w.set(personal, input, true)
    expect(w.everything()).toEqual(unchanged)
    const tripActivity = trip.q.pluck('SELECT count(*) FROM activity WHERE ledger_id = @ledger')

    const change = w.set(personal, input)
    expect(change).toEqual({ ...dry, dryRun: false })
    // In the order of Family's split rows: A's share, B's share, C's given row.
    expect(change.removed[0]!.splits).toEqual([
      {
        done: 'droppedShare',
        holder: personalRef,
        date: '2026-08-20',
        paymentMinor: 10_000,
        amountMinor: 5_000,
        currency: 'CAD',
      },
      {
        done: 'detachedShare',
        holder: tripRef,
        date: '2026-09-05',
        paymentMinor: 6_000,
        amountMinor: 2_500,
        currency: 'CAD',
      },
      {
        done: 'detachedSplit',
        holder: familyRef,
        date: '2026-09-25',
        paymentMinor: 4_000,
        amountMinor: 3_000,
        currency: 'CAD',
      },
    ])
    expect(change.notices).toEqual([
      'Family’s share of $50.00 of Personal’s payment on 2026-08-20 goes back to Personal.',
      'Family’s share of $25.00 of Trip’s payment on 2026-09-05 is an ordinary transaction now, and so is what Trip gave for it. No balance changes.',
      'The split of Family’s $40.00 payment on 2026-09-25 ends. Each share of it is an ordinary transaction where it is, and no balance changes.',
    ])
    // Personal takes Family's part, −115, less the $50 it gave Family back: −145 + 50 − 165.
    expect(change.parts).toEqual({
      before: { personal: -14_500, family: -11_500, trip: -4_000 },
      after: { personal: -26_000, trip: -4_000 },
    })
    expect(w.check()).toEqual({ personal: -26_000, trip: -4_000 })

    // Trip chose nothing: its part is as it was at every date. Personal's is its own and Family's.
    const after = w.history()
    expect(after.trip).toEqual(w.before.trip)
    expect(after.personal).toEqual(w.before.personal!.map((p, i) => p + w.before.family![i]!))
    expect(trip.q.pluck('SELECT count(*) FROM activity WHERE ledger_id = @ledger')).toBeGreaterThan(
      tripActivity as number,
    )

    // What's still split: A between Personal and Trip, B between Trip and Personal.
    expect(w.splitRows().map((r) => [r.ledger, r.splitOf, r.amount])).toEqual([
      ['personal', w.a, -3_000],
      ['personal', w.b, 1_500],
      ['trip', w.a, 3_000],
      ['trip', w.b, -1_500],
    ])
    expect(getTransaction(personal, w.a).split).toEqual({
      part: 'payment',
      keptMinor: 7_000,
      shares: [{ ledger: tripRef, amountMinor: 3_000 }],
    })
    expect(getTransaction(trip, w.b).split).toEqual({
      part: 'payment',
      keptMinor: 4_500,
      shares: [{ ledger: personalRef, amountMinor: 1_500 }],
    })
    // C and its given row came home as ordinary rows: still a card payment, and what it gave.
    expect(getTransaction(personal, w.c)).toMatchObject({
      amountMinor: 4_000,
      split: null,
      categoryId: categoryId(personal, 'Credit card payment'),
    })
    const plain = personal.q.all<{ amount: number; date: string }>(
      'SELECT amount_minor AS amount, date FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND payee = ? AND split_of IS NULL ORDER BY id',
      w.visa,
      GIVEN_PAYEE,
    )
    expect(plain).toEqual([{ amount: -3_000, date: '2026-09-25' }])
    // Trip's share of C is its own row now, and Trip gave Family's share of B as a row of its own, on B's day.
    expect(
      trip.q.all(
        'SELECT amount_minor AS amount, date, payee FROM transactions WHERE ledger_id = @ledger AND split_of IS NULL AND date >= ? ORDER BY id',
        '2026-09-05',
      ),
    ).toEqual([
      { amount: 6_000, date: '2026-09-05', payee: PAYEE },
      { amount: 1_000, date: '2026-09-25', payee: PAYEE },
      { amount: -2_500, date: '2026-09-05', payee: GIVEN_PAYEE },
    ])
    expect(family.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(0)
  })

  it('with “keep”: detaches every split, and its rows follow the ordinary rules', () => {
    const w = three()
    const { personal, family, trip } = w
    const input: SharingInput = { ledgers: ['personal', 'trip'], rows: { family: 'keep' } }
    const unchanged = w.everything()
    const dry = w.set(personal, input, true)
    expect(w.everything()).toEqual(unchanged)

    const change = w.set(personal, input)
    expect(change).toEqual({ ...dry, dryRun: false })
    expect(change.removed[0]!.splits).toEqual([
      {
        done: 'detachedShare',
        holder: personalRef,
        date: '2026-08-20',
        paymentMinor: 10_000,
        amountMinor: 5_000,
        currency: 'CAD',
      },
      {
        done: 'detachedShare',
        holder: tripRef,
        date: '2026-09-05',
        paymentMinor: 6_000,
        amountMinor: 2_500,
        currency: 'CAD',
      },
      {
        done: 'detachedSplit',
        holder: familyRef,
        date: '2026-09-25',
        paymentMinor: 4_000,
        amountMinor: 3_000,
        currency: 'CAD',
      },
    ])
    expect(change.notices.slice(0, 3)).toEqual([
      'Family’s share of $50.00 of Personal’s payment on 2026-08-20 is an ordinary transaction now, and so is what Personal gave for it. No balance changes.',
      'Family’s share of $25.00 of Trip’s payment on 2026-09-05 is an ordinary transaction now, and so is what Trip gave for it. No balance changes.',
      'The split of Family’s $40.00 payment on 2026-09-25 ends. Each share of it is an ordinary transaction where it is, and no balance changes.',
    ])
    // C, pending with a bank id, went home once ordinary. Its given row, which has no bank id, stayed.
    expect(change.removed[0]).toMatchObject({ moved: 1, kept: 4 })
    const own = w.splitOffs()[0]!
    // Family's own account: −200 + 50 + 25 − 30. With the $40 that went home, its old part, −115.
    expect(getAccount(family, own).balanceMinor).toBe(-15_500)
    expect(change.removed[0]!.account).toEqual({ id: own, name: 'Visa', balanceMinor: -15_500 })
    // Visa is the whole bank balance again, recorded today: −300, less Trip's −40.
    expect(w.check(own)).toEqual({ personal: -26_000, trip: -4_000 })

    // Trip chose nothing: its part is as it was at every date. Personal's is too, but for C from its date on.
    const after = w.history()
    expect(after.trip).toEqual(w.before.trip)
    expect(after.personal).toEqual(
      w.before.personal!.map((p, i) => p + (DATES[i]! >= '2026-09-25' ? 4_000 : 0)),
    )
    // Personal gave Family's share of A as a row of its own, on A's day.
    expect(
      personal.q.all(
        'SELECT amount_minor AS amount, date, split_of AS splitOf FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND payee = ? ORDER BY id',
        w.visa,
        GIVEN_PAYEE,
      ),
    ).toEqual([
      { amount: -3_000, date: '2026-08-20', splitOf: w.a },
      { amount: -5_000, date: '2026-08-20', splitOf: null },
    ])
    expect(getTransaction(personal, w.c)).toMatchObject({
      amountMinor: 4_000,
      status: 'pending',
      split: null,
    })
    expect(
      family.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND split_of IS NOT NULL'),
    ).toBe(0)
    expect(w.splitRows().map((r) => [r.ledger, r.splitOf, r.amount])).toEqual([
      ['personal', w.a, -3_000],
      ['personal', w.b, 1_500],
      ['trip', w.a, 3_000],
      ['trip', w.b, -1_500],
    ])
  })

  it.each(endings)('leaves no split row once sharing ends (%s), and the account can be deleted', (_, end) => {
    const w = three()
    const home = end(w)
    expect(home.accountWide.isShared(w.visa)).toBe(false)
    expect(w.splitRows()).toEqual([])
    w.check(...w.splitOffs())
    deleteAccount(home, w.ctxOf, w.visa)
    expect(
      home.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND account_id = ?', w.visa),
    ).toBe(0)
    expectNoCrossLedgerReferences(w.storage)
  })
})

/** A transaction as a provider hands it over. */
const remote = (
  remoteId: string,
  date: string,
  amountMinor: number,
  more: Partial<RemoteTransaction> = {},
): RemoteTransaction => ({
  remoteId,
  date,
  amountMinor,
  payee: PAYEE,
  description: PAYEE,
  pending: false,
  raw: { remoteId, date, amountMinor, ...more },
  ...more,
})

describe('when the bank changes a split payment', () => {
  function synced() {
    const w = world()
    const apply = (
      rows: RemoteTransaction[],
      scope: ApplyScope = { removed: [], floor: null },
      provider: 'plaid' | 'simplefin' = 'plaid',
    ) => {
      const result = applyRemoteTransactions(w.personal, w.ctxOf, w.visa, rows, scope, provider)
      for (const c of w.ledgers) matchTransactions(c)
      return result
    }
    w.spentIn(w.personal, '2026-08-10', -20_000)
    w.spentIn(w.family, '2026-08-11', -20_000)
    w.spentIn(w.trip, '2026-08-12', -10_000)
    const byBankId = (id: string) => w.personal.accountWide.holder(w.visa, id)!
    /** Each of the payment's split rows, by ledger slug: its amount, date and status. */
    const splitOf = (payment: number) =>
      w.ledgers.flatMap((c) =>
        c.q
          .all<{ amount: number; date: string; status: string; payee: string }>(
            'SELECT amount_minor AS amount, date, status, payee FROM transactions WHERE ledger_id = @ledger AND split_of = ?',
            payment,
          )
          .map((r) => ({ ledger: c.ledger.slug, ...r })),
      )
    return { ...w, apply, byBankId, splitOf }
  }

  it('follows its date and status, keeps its split when it posts under a new id, lets the holder absorb a new amount, and undoes the split when removed', () => {
    const w = synced()
    const { personal, family, trip } = w
    // Plaid sends the payment pending: filed as a card payment, then split $50 to Family and $30 to Trip.
    w.apply([remote('p1', '2026-08-20', 10_000, { pending: true })])
    const paid = w.byBankId('p1').id
    expect(getTransaction(personal, paid)).toMatchObject({
      status: 'pending',
      categoryId: categoryId(personal, 'Credit card payment'),
    })
    w.split(personal, paid, { family: 5_000, trip: 3_000 })
    expect(w.check()).toEqual({ personal: -18_000, family: -15_000, trip: -7_000 })

    // The bank unchanged: nothing changes.
    const before = w.everything()
    expect(w.apply([remote('p1', '2026-08-20', 10_000, { pending: true })])).toMatchObject({
      added: 0,
      updated: 0,
      removed: 0,
    })
    expect(w.everything()).toEqual(before)

    // A new date: the split rows take it, in each ledger, and each of those is one the sync changed.
    const moved = w.apply([remote('p1', '2026-08-21', 10_000, { pending: true })])
    expect(moved).toMatchObject({ updated: 1 })
    expect([...moved.byLedger.keys()]).toEqual([personal.ledger.id])
    expect([...moved.ledgers].sort()).toEqual([personal, family, trip].map((c) => c.ledger.id).sort())
    expect(w.splitOf(paid)).toEqual([
      { ledger: 'personal', amount: -8_000, date: '2026-08-21', status: 'pending', payee: GIVEN_PAYEE },
      { ledger: 'family', amount: 5_000, date: '2026-08-21', status: 'pending', payee: PAYEE },
      { ledger: 'trip', amount: 3_000, date: '2026-08-21', status: 'pending', payee: PAYEE },
    ])
    // On Aug 20 nobody has paid yet. On Aug 21 each has its share.
    expect(balancesAt(family, ['2026-08-20', '2026-08-21']).get(w.visa)).toEqual([-20_000, -15_000])
    w.check()

    // It posts under a new id (Plaid says which one it replaces), a day later: the same row, still split.
    expect(w.apply([remote('p2', '2026-08-22', 10_000, { replaces: 'p1' })])).toMatchObject({
      added: 0,
      updated: 1,
    })
    expect(w.byBankId('p2').id).toBe(paid)
    expect(getTransaction(personal, paid)).toMatchObject({ status: 'cleared', date: '2026-08-22' })
    expect(w.splitOf(paid).map((r) => [r.ledger, r.amount, r.date, r.status])).toEqual([
      ['personal', -8_000, '2026-08-22', 'cleared'],
      ['family', 5_000, '2026-08-22', 'cleared'],
      ['trip', 3_000, '2026-08-22', 'cleared'],
    ])
    expect(w.check()).toEqual({ personal: -18_000, family: -15_000, trip: -7_000 })

    // A new amount, $70: Personal, which holds the payment, absorbs it. It keeps −$10 now.
    expect([...w.apply([remote('p2', '2026-08-22', 7_000)]).ledgers]).toEqual([personal.ledger.id])
    expect(w.splitOf(paid).map((r) => r.amount)).toEqual([-8_000, 5_000, 3_000])
    expect(getTransaction(personal, paid).split).toEqual({
      part: 'payment',
      keptMinor: -1_000,
      shares: [
        { ledger: familyRef, amountMinor: 5_000 },
        { ledger: tripRef, amountMinor: 3_000 },
      ],
    })
    // Personal −200 + 70 − 80. The others as they were.
    expect(w.check()).toEqual({ personal: -21_000, family: -15_000, trip: -7_000 })

    // Plaid removes it: the split is undone first, each share back with Personal, then it's deleted.
    const removed = w.apply([], { removed: [{ remoteId: 'p2' }], floor: null })
    expect(removed).toMatchObject({ removed: 1 })
    expect([...removed.ledgers].sort()).toEqual([personal, family, trip].map((c) => c.ledger.id).sort())
    expect(w.splitOf(paid)).toEqual([])
    expect(
      personal.q.get(
        'SELECT deleted_at IS NOT NULL AS deleted, removed_at IS NOT NULL AS removed FROM transactions WHERE ledger_id = @ledger AND id = ?',
        paid,
      ),
    ).toEqual({
      deleted: 1,
      removed: 1,
    })
    expect(w.check()).toEqual({ personal: -20_000, family: -20_000, trip: -10_000 })
    for (const c of [personal, family, trip]) {
      const last = c.q.get<{ actor: string; summary: string }>(
        "SELECT actor, summary FROM activity WHERE ledger_id = @ledger AND action = 'split' ORDER BY id DESC LIMIT 1",
      )!
      expect(last.actor).toBe('Plaid sync')
      // The holder's log names the payment's amount, and the others' only their share.
      expect(last.summary).toBe(
        c === personal ? 'Undid the split of the $70.00 payment onto Visa on 2026-08-22' : `Personal undid the split of its payment onto Visa on 2026-08-22, and this ledger’s share of ${c === family ? '$50.00' : '$30.00'} with it`,
      )
    }
  })

  it('in a window: a pending one that posts under a new id keeps its split, and one that vanishes has it undone', () => {
    const w = synced()
    const { personal } = w
    const window = (from: string): ApplyScope => ({ from, to: '2026-10-03', floor: null })
    w.apply(
      [
        remote('q1', '2026-09-20', 5_000, { pending: true }),
        remote('q3', '2026-09-22', 2_000, { pending: true }),
      ],
      window('2026-09-15'),
      'simplefin',
    )
    const [q1, q3] = [w.byBankId('q1').id, w.byBankId('q3').id]
    w.split(personal, q1, { family: 2_000 })
    w.split(personal, q3, { trip: 500 })
    // Personal −200 + 50 − 20 + 20 − 5. Family −200 + 20. Trip −100 + 5.
    expect(w.check()).toEqual({ personal: -15_500, family: -18_000, trip: -9_500 })

    // q1 posts as q2 the next day, and q3 is gone.
    expect(w.apply([remote('q2', '2026-09-21', 5_000)], window('2026-09-15'), 'simplefin')).toMatchObject({
      added: 0,
      updated: 1,
      removed: 1,
    })
    expect(w.byBankId('q2').id).toBe(q1)
    expect(w.splitOf(q1).map((r) => [r.ledger, r.amount, r.date, r.status])).toEqual([
      ['personal', -2_000, '2026-09-21', 'cleared'],
      ['family', 2_000, '2026-09-21', 'cleared'],
    ])
    expect(w.splitOf(q3)).toEqual([])
    expect(
      personal.q.get(
        'SELECT deleted_at IS NOT NULL AS deleted, removed_at IS NOT NULL AS removed FROM transactions WHERE ledger_id = @ledger AND id = ?',
        q3,
      ),
    ).toEqual({
      deleted: 1,
      removed: 1,
    })
    // Personal −200 + 50 − 20. Family −200 + 20. Trip −100.
    expect(w.check()).toEqual({ personal: -17_000, family: -18_000, trip: -10_000 })
  })

  it('follows a payment a member holds where it is, the member absorbing a new amount', () => {
    const w = synced()
    const { personal, family } = w
    w.apply([remote('m1', '2026-09-10', 3_000)])
    const paid = w.byBankId('m1').id
    w.move(personal, [paid], family)
    // Family keeps $10, and Personal, the home, gets the other $20.
    w.split(family, paid, { family: 1_000 })
    expect(w.check()).toEqual({ personal: -18_000, family: -19_000, trip: -10_000 })

    w.apply([remote('m1', '2026-09-11', 2_500)])
    expect(w.splitOf(paid).map((r) => [r.ledger, r.amount, r.date])).toEqual([
      ['personal', 2_000, '2026-09-11'],
      ['family', -2_000, '2026-09-11'],
    ])
    expect(getTransaction(family, paid)).toMatchObject({
      amountMinor: 2_500,
      date: '2026-09-11',
      split: { part: 'payment', keptMinor: 500 },
    })
    // Family −200 + 25 − 20. Personal −200 + 20.
    expect(w.check()).toEqual({ personal: -18_000, family: -19_500, trip: -10_000 })
  })
})

describe('splits on an account with recorded balances', () => {
  /**
   * The three-payment fixture with Visa's balance recorded on Aug 31 (−$400: −500 + A) and on Sep 30
   * (−$300: + B and C), which is what its rows come to on those days. Personal, the opening ledger,
   * then has each recorded balance less what the others hold up to its day.
   */
  function recorded() {
    const w = three()
    setBalance(w.personal, w.visa, { date: '2026-08-31', balanceMinor: -40_000 })
    setBalance(w.personal, w.visa, { date: '2026-09-30', balanceMinor: -30_000 })
    expect(w.check()).toEqual({ personal: -14_500, family: -11_500, trip: -4_000 })
    const before = w.history()
    expect(before).toEqual(w.before)
    /** August and September in each ledger: what it spent and got. */
    const summaries = () =>
      w.ledgers.map((c) => {
        const s = periodSummary(c, '2026-08-01', '2026-09-30')
        return { spent: s.spentMinor, income: s.incomeMinor }
      })
    return { ...w, before, summaries }
  }

  it('stop sharing with “home”: Trip’s part is as it was at every date, and Personal’s is its own and Family’s', () => {
    const w = recorded()
    w.set(w.personal, { ledgers: ['personal', 'trip'], rows: { family: 'home' } })
    // Personal −145 − 115. (The $50 share of A it gave Family is its own again.)
    expect(w.check()).toEqual({ personal: -26_000, trip: -4_000 })
    const after = w.history()
    expect(after.trip).toEqual(w.before.trip)
    expect(after.personal).toEqual(w.before.personal!.map((p, i) => p + w.before.family![i]!))
  })

  it('stop sharing with “keep”: Trip’s part is as it was at every date, Personal’s but for the pending payment that came home, and no ledger’s spending changes', () => {
    const w = recorded()
    const summaries = w.summaries()
    w.set(w.personal, { ledgers: ['personal', 'trip'], rows: { family: 'keep' } })
    const own = w.splitOffs()[0]!
    // Visa is the whole bank balance again, −300, recorded today: Personal takes Family's −115. Trip −40.
    expect(w.check(own)).toEqual({ personal: -26_000, trip: -4_000 })
    // The recorded balances lost what Family kept up to their days, so the past is as it was, but
    // for C: pending with a bank id, it went home, and is Personal's from its date on.
    const after = w.history()
    expect(after.trip).toEqual(w.before.trip)
    expect(after.personal).toEqual(w.before.personal!.map((p, i) => p + (DATES[i]! >= '2026-09-25' ? 4_000 : 0)))
    expect(w.summaries()).toEqual(summaries)
  })

  it.each(endings)('leaves no split row once sharing ends (%s)', (_, end) => {
    const w = recorded()
    const home = end(w)
    expect(home.accountWide.isShared(w.visa)).toBe(false)
    expect(w.splitRows()).toEqual([])
    w.check(...w.splitOffs())
  })

  /**
   * Personal −200, Family −200 and Trip −100 in August, and a $100 payment on Aug 20 moved to
   * Family and split: Family keeps $20, Trip gets $30 and Personal, the home, the other $50. Visa's
   * balance is recorded on Aug 31 (−$400). Personal −200 + 50, Family −200 + 100 − 80, Trip −100 + 30.
   */
  function memberHeld() {
    const w = world()
    const { personal, family, trip } = w
    w.spentIn(personal, '2026-08-10', -20_000)
    w.spentIn(family, '2026-08-11', -20_000)
    w.spentIn(trip, '2026-08-12', -10_000)
    const paid = w.row(personal, '2026-08-20', 10_000, { payee: PAYEE, category: 'Credit card payment' })
    w.move(personal, [paid], family)
    w.split(family, paid, { family: 2_000, trip: 3_000 })
    setBalance(personal, w.visa, { date: '2026-08-31', balanceMinor: -40_000 })
    expect(w.check()).toEqual({ personal: -15_000, family: -18_000, trip: -7_000 })
    /** The parts today, which come to −$400 whatever is done to the split. */
    const parts = () => {
      const now = w.check()
      expect(Object.values(now).reduce((s, n) => s + n, 0)).toBe(-40_000)
      return now
    }
    return { ...w, paid, before: w.history(), parts }
  }

  it('undoSplit: each share goes back to the ledger that holds the payment', () => {
    const w = memberHeld()
    undoSplit(w.family, w.ctxOf, w.paid, TESTER)
    expect(w.parts()).toEqual({ personal: -20_000, family: -10_000, trip: -10_000 })
  })

  it('dropShare: one share goes back, and both do as an undo does', () => {
    const w = memberHeld()
    expect(dropShare(w.family, w.ctxOf, w.paid, w.trip.ledger.id, TESTER)).toEqual({ amountMinor: 3_000, last: false })
    expect(w.parts()).toEqual({ personal: -15_000, family: -15_000, trip: -10_000 })
    expect(dropShare(w.family, w.ctxOf, w.paid, w.personal.ledger.id, TESTER)).toEqual({ amountMinor: 5_000, last: true })
    expect(w.parts()).toEqual({ personal: -20_000, family: -10_000, trip: -10_000 })
    expect(w.splitRows()).toEqual([])
  })

  it('detachShare: no part changes at any date, for one share and for the last', () => {
    const w = memberHeld()
    expect(detachShare(w.family, w.ctxOf, w.paid, w.trip.ledger.id, TESTER)).toMatchObject({ amountMinor: 3_000, last: false })
    expect(w.parts()).toEqual({ personal: -15_000, family: -18_000, trip: -7_000 })
    expect(w.history()).toEqual(w.before)
    expect(detachShare(w.family, w.ctxOf, w.paid, w.personal.ledger.id, TESTER)).toMatchObject({ amountMinor: 5_000, last: true })
    expect(w.parts()).toEqual({ personal: -15_000, family: -18_000, trip: -7_000 })
    expect(w.history()).toEqual(w.before)
    expect(w.splitRows()).toEqual([])
  })

  it('detachSplit: no part changes at any date', () => {
    const w = memberHeld()
    expect(detachSplit(w.family, w.ctxOf, w.paid, TESTER)).toEqual({ detached: 3 })
    expect(w.parts()).toEqual({ personal: -15_000, family: -18_000, trip: -7_000 })
    expect(w.history()).toEqual(w.before)
    expect(w.splitRows()).toEqual([])
  })
})

describe('a split, then a home change', () => {
  it('keeps every part through the change, the bank moving the payment, a new split from the old home, and the old home leaving, Trip’s history as it was throughout', () => {
    const w = world()
    const { personal, family, trip } = w
    w.spentIn(personal, '2026-08-10', -20_000)
    w.spentIn(family, '2026-08-11', -20_000)
    w.spentIn(trip, '2026-08-12', -10_000)
    /** Plaid's changes, applied in Visa's home. */
    const bank = (home: AppContext, amountMinor: number) => {
      const result = applyRemoteTransactions(home, w.ctxOf, w.visa, [remote('p1', '2026-08-20', amountMinor)], { removed: [], floor: null }, 'plaid')
      for (const c of w.ledgers) matchTransactions(c)
      return result
    }
    // The bank's $100 payment, in Personal, split: $50 to Family, $30 to Trip. Visa's balance on Aug 31 is recorded: −$400.
    bank(personal, 10_000)
    const paid = personal.accountWide.holder(w.visa, 'p1')!.id
    w.split(personal, paid, { family: 5_000, trip: 3_000 })
    setBalance(personal, w.visa, { date: '2026-08-31', balanceMinor: -40_000 })
    // Personal −200 + 100 − 80. Family −200 + 50. Trip −100 + 30.
    const parts = { personal: -18_000, family: -15_000, trip: -7_000 }
    expect(w.check()).toEqual(parts)
    const tripBefore = w.history().trip
    const unchanged = () => expect(w.history().trip).toEqual(tripBefore)

    // Family becomes the home. Personal still holds the payment, and is still the opening ledger.
    changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
    expect(family.accountWide.ledgers(w.visa).map((l) => [l.slug, l.isHome, l.isOpening])).toEqual([
      ['family', true, false],
      ['personal', false, true],
      ['trip', false, false],
    ])
    expect(w.check()).toEqual(parts)
    unchanged()

    // The bank says $120, then $70: the row changes where it is, and the recorded balance pins the
    // total at −$400, so Personal's part, which has the recorded balance less the others', stays too.
    const up = bank(family, 12_000)
    expect(up).toMatchObject({ added: 0, updated: 1 })
    expect([...up.byLedger.keys()]).toEqual([personal.ledger.id])
    expect(getTransaction(personal, paid)).toMatchObject({ amountMinor: 12_000, split: { part: 'payment', keptMinor: 4_000 } })
    expect(w.check()).toEqual(parts)
    unchanged()
    expect(bank(family, 7_000)).toMatchObject({ added: 0, updated: 1 })
    expect(getTransaction(personal, paid)).toMatchObject({ amountMinor: 7_000, split: { part: 'payment', keptMinor: -1_000 } })
    expect(w.check()).toEqual(parts)
    unchanged()

    // Split again from the old home, which holds it: Personal keeps $10, Trip $30, and Family, the home now, the other $30.
    expect(w.split(personal, paid, { personal: 1_000, trip: 3_000 })).toMatchObject({
      keptMinor: 1_000,
      shares: [
        { ledger: familyRef, amountMinor: 3_000 },
        { ledger: tripRef, amountMinor: 3_000 },
      ],
    })
    // Family −200 + 30. Trip −100 + 30. Personal has the rest of −400.
    expect(w.check()).toEqual({ family: -17_000, personal: -16_000, trip: -7_000 })
    unchanged()

    // The old home leaves and keeps its rows: the split ends, Family takes the opening balance, and Visa is −$400 still.
    w.set(family, { ledgers: ['family', 'trip'], rows: { personal: 'keep' } })
    const own = w.splitOffs()[0]!
    expect(w.splitRows()).toEqual([])
    expect(w.check(own)).toEqual({ family: -33_000, trip: -7_000 })
    unchanged()
    // Personal's own account: −200 + 70 − 60.
    expect(getAccount(personal, own).balanceMinor).toBe(-19_000)
  })
})

describe('the all-ledgers list', () => {
  it('hides split rows and gives each payment its shares, its running balance still ending at the account’s total', () => {
    const w = three()
    const split = new Set(w.splitRows().map((r) => r.id))
    const items = []
    for (let cursor: string | undefined; ;) {
      const page = listAccountTransactions(w.trip, w.visa, { limit: 2, cursor }, null)
      items.push(...page.items)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    // The three purchases and the three payments, as the bank has them.
    expect(items.map((t) => [t.date, t.amountMinor, t.ledger.slug])).toEqual([
      ['2026-09-25', 4_000, 'family'],
      ['2026-09-05', 6_000, 'trip'],
      ['2026-08-20', 10_000, 'personal'],
      ['2026-08-12', -10_000, 'trip'],
      ['2026-08-11', -20_000, 'family'],
      ['2026-08-10', -20_000, 'personal'],
    ])
    for (const t of items) expect(split.has(t.id)).toBe(false)
    expect(items.map((t) => t.split)).toEqual([
      {
        keptMinor: 1_000,
        shares: [
          { ledger: personalRef, amountMinor: 2_000 },
          { ledger: tripRef, amountMinor: 1_000 },
        ],
      },
      {
        keptMinor: 2_000,
        shares: [
          { ledger: personalRef, amountMinor: 1_500 },
          { ledger: familyRef, amountMinor: 2_500 },
        ],
      },
      {
        keptMinor: 2_000,
        shares: [
          { ledger: familyRef, amountMinor: 5_000 },
          { ledger: tripRef, amountMinor: 3_000 },
        ],
      },
      null,
      null,
      null,
    ])
    // −300 at the top, like the bank's statement, and 0 before the first row.
    expect(items.map((t) => t.balanceAfterMinor)).toEqual([
      -30_000, -34_000, -40_000, -50_000, -40_000, -20_000,
    ])
    expect(items[0]!.balanceAfterMinor).toBe(expectPartsSumToAccount(w.storage, w.visa).totalMinor)
    // From a page that starts after a payment's split rows were listed, the same balances.
    const later = listAccountTransactions(w.trip, w.visa, { to: '2026-09-04' }, null)
    expect(later.items.map((t) => t.balanceAfterMinor)).toEqual([-40_000, -50_000, -40_000, -20_000])
    w.check()
  })
})

describe('deleting a ledger that takes part in a split', () => {
  it('asks its questions first, and with its splits let go of (leaveLedgerSplits) leaves the others’ splits whole', () => {
    const w = three()
    const { personal, family, trip } = w
    const message = 'Answer the questions first'
    refused(() => w.storage.registry.remove(family.ledger.id), 409, message)
    refused(() => eraseAll(w.storage, family), 409, message)

    // As the answer "delete them" does it: its shares dropped, as its rows are going, and its own payment's split detached.
    const left = leaveLedgerSplits(family, w.ctxOf, { actor: TESTER })
    expect([...left.keys()]).toEqual([w.visa])
    expect(left.get(w.visa)!.map((s) => s.done)).toEqual(['droppedShare', 'droppedShare', 'detachedSplit'])
    // Family −115 − 50 − 25. Personal −145 + 50. Trip −40 + 25.
    expect(w.check()).toEqual({ personal: -9_500, family: -19_000, trip: -1_500 })
    expect(
      family.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND split_of IS NOT NULL'),
    ).toBe(0)

    w.storage.registry.remove(family.ledger.id, { answers: { [`rows:${w.visa}`]: 'delete' } })
    // Visa is −300 less Family's −190: Personal −95 and Trip −15, A and B still split between them.
    expect(expectPartsSumToAccount(w.storage, w.visa, { dates: DATES }).parts).toEqual({
      personal: -9_500,
      trip: -1_500,
    })
    const remaining = [personal, trip].flatMap((c) =>
      c.q.all<{ splitOf: number; amount: number }>(
        'SELECT split_of AS splitOf, amount_minor AS amount FROM transactions WHERE ledger_id = @ledger AND split_of IS NOT NULL',
      ),
    )
    for (const id of [w.a, w.b])
      expect(
        remaining.filter((r) => r.splitOf === id).reduce((s, r) => s + r.amount, 0),
        `the split rows of ${id} sum to zero`,
      ).toBe(0)
    expect(new Set(remaining.map((r) => r.splitOf))).toEqual(new Set([w.a, w.b]))
    expectNoCrossLedgerReferences(w.storage)
  })
})
