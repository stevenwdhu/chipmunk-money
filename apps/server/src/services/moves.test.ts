import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { addDays, recurringCreateSchema, transactionCreateSchema } from '@chipmunk/shared'
import type { LlmCategorizer } from '../ai/types'
import { runDailyJobs } from '../jobs'
import { categoryId, makeAccount } from '../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER } from '../test/shared-accounts'
import { ledgerRows } from '../test/world'
import { balancesAt } from './accounts'
import { leaveSharedList } from './catalog'
import { createTag, setCategoryEnabled, updateTag, upsertTags } from './categories'
import type { AppContext } from './context'
import { aiJobStatus, categorizeUncategorized } from './import'
import { setLinks } from './links'
import { matchTransactions } from './matching'
import { MOVE_LIMIT, moveTransactions, type MoveInput } from './moves'
import { addPayment, confirmRecurring, createRecurring, detectRecurring, getRecurring, listRecurring, updateRecurring } from './recurring'
import { createTransaction, deleteTransaction, getTransaction, updateTransaction } from './transactions'

/**
 * Moving transactions between the ledgers that have a shared account (moves.ts), in three ledgers:
 * Personal is Visa's home, Family has it, and Trip has it only when the test shares it.
 */

type Origin = 'manual' | 'import' | 'sync'

function world(opts: Parameters<typeof sharedWorld>[0] = {}) {
  const w = sharedWorld(opts)
  /** A row a ledger holds, Visa's unless `account` says, entered as by hand unless `origin` says. */
  const row = (
    ctx: AppContext,
    date: string,
    amount: number,
    more: { payee?: string; account?: number; category?: string; source?: string; origin?: Origin; batch?: number; externalId?: string } = {},
  ) => {
    const category = more.category ? categoryId(ctx, more.category) : null
    return Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, category_source, origin, import_batch_id, external_id)
         VALUES (@ledger, @account, @date, @amount, @payee, lower(@payee), @category, @source, @origin, @batch, @externalId)`,
        {
          account: more.account ?? w.visa,
          date,
          amount,
          payee: more.payee ?? 'Shop',
          category,
          source: category ? (more.source ?? 'user') : null,
          origin: more.origin ?? 'manual',
          batch: more.batch ?? null,
          externalId: more.externalId ?? null,
        },
      ).lastInsertRowid,
    )
  }
  const move = (from: AppContext, ids: number[], to: AppContext, more: Partial<MoveInput> = {}) => moveTransactions(from, w.ctxOf, { ids, to: to.ledger.id, ...more }, TESTER)
  /** What every move leaves: the parts sum to the account, and nothing refers across ledgers. */
  const check = () => {
    const parts = expectPartsSumToAccount(w.storage, w.visa)
    expectNoCrossLedgerReferences(w.storage)
    return parts
  }
  /** Every row of these ledgers, activity included. */
  const everything = (...ctxs: AppContext[]) => ctxs.map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
  return { ...w, row, move, check, everything }
}

/** A 400 with this message. */
function refused(fn: () => unknown, message: string | RegExp) {
  let error: unknown
  try {
    fn()
  } catch (err) {
    error = err
  }
  expect(error).toBeInstanceOf(HTTPException)
  expect((error as HTTPException).status).toBe(400)
  if (typeof message === 'string') expect((error as HTTPException).message).toBe(message)
  else expect((error as HTTPException).message).toMatch(message)
}

const ai = (asked: string[], category = 'Dine out'): LlmCategorizer => async (req) => {
  asked.push(req.payee)
  return { category, confidence: 0.9, slot: 'primary', model: 'm' }
}
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('moving transactions: categories', () => {
  it('keeps a category the other ledger uses too, takes the one of the same name, or leaves none', () => {
    const w = world()
    const { personal, family } = w
    const groceries = w.row(personal, '2026-09-01', -4000, { category: 'Groceries' })
    // Off in Family: none there, for Family to categorize.
    setCategoryEnabled(family, categoryId(family, 'Dine out'), { enabled: false })
    const dineOut = w.row(personal, '2026-09-02', -2500, { category: 'Dine out', source: 'history' })
    const none = w.row(personal, '2026-09-03', -1000)
    expect(w.move(personal, [groceries, dineOut, none], family)).toMatchObject({ moved: 3, recategorized: 1 })
    expect(getTransaction(family, groceries)).toMatchObject({ categoryId: categoryId(personal, 'Groceries'), categorySource: 'user' })
    expect(getTransaction(family, dineOut)).toMatchObject({ categoryId: null, categorySource: null, needsReview: false })
    expect(getTransaction(family, none).categoryId).toBeNull()
    w.check()

    // On its own list, Family has a Groceries of its own: the same name, as it was said.
    leaveSharedList(family)
    expect(categoryId(family, 'Groceries')).not.toBe(categoryId(personal, 'Groceries'))
    const more = w.row(personal, '2026-09-04', -3000, { category: 'Groceries', source: 'history' })
    expect(w.move(personal, [more], family)).toMatchObject({ moved: 1, recategorized: 0 })
    expect(getTransaction(family, more)).toMatchObject({ categoryId: categoryId(family, 'Groceries'), categorySource: 'history' })
    w.check()
  })

  it('gives a card payment or transfer the other ledger’s card payment category, never none', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, family, trip } = w
    const payment = w.row(personal, '2026-09-05', 5000, { payee: 'Payment thank you', category: 'Credit card payment', source: 'rule' })
    const transfer = w.row(personal, '2026-09-06', 2000, { payee: 'From savings', category: 'Transfer', source: 'history' })
    setCategoryEnabled(family, categoryId(family, 'Transfer'), { enabled: false })
    expect(w.move(personal, [payment, transfer], family)).toMatchObject({ moved: 2, recategorized: 1 })
    const card = categoryId(family, 'Credit card payment')
    expect(getTransaction(family, payment)).toMatchObject({ categoryId: card, categorySource: 'user' })
    // Transfer is off in Family: its card payment category instead, as yours.
    expect(getTransaction(family, transfer)).toMatchObject({ categoryId: card, categorySource: 'user' })
    w.check()

    // A ledger with no category left out of totals can't take it.
    for (const id of trip.q.column<number>('SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND exclude_from_totals = 1')) {
      setCategoryEnabled(trip, id, { enabled: false })
    }
    const before = w.everything(family, trip)
    refused(() => w.move(family, [payment], trip), `Trip has no category for card payments, so Payment thank you ($50.00 on 2026-09-05) can’t move there.`)
    expect(w.everything(family, trip)).toEqual(before)
  })

  it('has AI categorize what’s left without a category, after the commit, or leaves it to the caller', async () => {
    const asked: string[] = []
    const w = world({ llm: ai(asked) })
    const { personal, family } = w
    const cafe = w.row(personal, '2026-09-03', -1000, { payee: 'Corner Cafe' })
    const other = w.row(personal, '2026-09-04', -1500, { payee: 'Bean Bar' })

    // Deferred: the ids come back, and nothing is asked.
    const deferred = w.move(personal, [other], family, { defer: true })
    expect(deferred.deferred).toEqual([other])
    await settle()
    expect(asked).toEqual([])
    expect(aiJobStatus(family).running).toBe(false)
    expect(getTransaction(family, other).categoryId).toBeNull()

    // A dry run asks nothing either.
    expect(w.move(personal, [cafe], family, { dryRun: true }).deferred).toBeNull()
    await settle()
    expect(asked).toEqual([])

    expect(w.move(personal, [cafe], family).deferred).toBeNull()
    await settle()
    expect(asked).toEqual(['Corner Cafe'])
    expect(getTransaction(family, cafe)).toMatchObject({ categoryId: categoryId(family, 'Dine out'), categorySource: 'ai' })
    w.check()
  })
})

describe('moving transactions: links, pairs, recurring items, tags', () => {
  it('carries a refund over with its purchase, and lets it go when one moves alone', () => {
    const w = world()
    const { personal, family } = w
    const groceries = categoryId(personal, 'Groceries')
    const purchase = w.row(personal, '2026-09-10', -8000, { payee: 'Sport Store', category: 'Groceries' })
    const refund = w.row(personal, '2026-09-15', 2000, { payee: 'Sport Store' })
    setLinks(personal, refund, [{ transactionId: purchase, kind: 'refund', amountMinor: 2000 }])
    expect(getTransaction(personal, refund)).toMatchObject({ categoryId: groceries, categorySource: 'linked' })

    // The refund alone: the dry run says its link goes, and changes nothing.
    const before = w.everything(personal, family)
    expect(w.move(personal, [refund], family, { dryRun: true })).toMatchObject({
      moved: 1,
      carried: 0,
      unlinked: 1,
      dropped: { links: [{ moneyIn: refund, moneyOut: purchase, kind: 'refund', amountMinor: 2000 }], partlyLinked: [] },
    })
    expect(w.everything(personal, family)).toEqual(before)

    // Together, the link comes along and the refund still follows its purchase.
    expect(w.move(personal, [purchase, refund], family)).toMatchObject({ moved: 2, carried: 1, unlinked: 0 })
    expect(getTransaction(family, refund)).toMatchObject({
      links: [{ kind: 'refund', transactionId: purchase, amountMinor: 2000 }],
      categoryId: groceries,
      categorySource: 'linked',
    })
    w.check()

    // Back home alone: unlinked, it keeps its category as yours.
    expect(w.move(family, [refund], personal)).toMatchObject({ moved: 1, unlinked: 1 })
    expect(getTransaction(personal, refund)).toMatchObject({ links: [], categoryId: groceries, categorySource: 'user' })
    expect(getTransaction(family, purchase).links).toEqual([])
    w.check()
  })

  it('says when a payback is left partly linked, its rest counting as income where it stays', () => {
    const w = world()
    const { personal, family } = w
    const dinner = w.row(personal, '2026-09-20', -6000, { payee: 'Bistro', category: 'Dine out' })
    const lunch = w.row(personal, '2026-09-21', -3000, { payee: 'Cafe', category: 'Dine out' })
    const payback = w.row(personal, '2026-09-22', 4000, { payee: 'Jane e-Transfer' })
    setLinks(personal, payback, [
      { transactionId: dinner, kind: 'payback', amountMinor: 3000 },
      { transactionId: lunch, kind: 'payback', amountMinor: 1000 },
    ])
    const dry = w.move(personal, [dinner], family, { dryRun: true })
    expect(dry.dropped).toEqual({
      links: [{ moneyIn: payback, moneyOut: dinner, kind: 'payback', amountMinor: 3000 }],
      partlyLinked: [{ id: payback, ledger: 'personal', payee: 'Jane e-Transfer', leftMinor: 3000 }],
      pairs: [],
      recurring: [],
    })
    expect(w.move(personal, [dinner], family)).toMatchObject({ unlinked: 1 })
    expect(getTransaction(personal, payback)).toMatchObject({ links: [{ transactionId: lunch, amountMinor: 1000 }], categoryId: null, categorySource: null })
    w.check()
  })

  it('unpairs a card payment on both sides, and the other ledger pairs it with its own withdrawal', () => {
    const w = world()
    const { personal, family } = w
    const chequing = makeAccount(personal, 'TD Chequing')
    const joint = makeAccount(family, 'Joint Chequing')
    const payment = w.row(personal, '2026-09-20', 50_000, { payee: 'PAYMENT - THANK YOU', origin: 'sync', externalId: 'p1' })
    const withdrawal = w.row(personal, '2026-09-20', -50_000, { payee: 'TD VISA PREAUTH PYMT', account: chequing, origin: 'sync' })
    expect(matchTransactions(personal)).toMatchObject({ transfers: 1 })
    const theirs = w.row(family, '2026-09-21', -50_000, { payee: 'VISA PAYMENT', account: joint, origin: 'sync' })

    expect(w.move(personal, [payment], family)).toMatchObject({
      moved: 1,
      unpaired: 1,
      dropped: { pairs: [{ id: payment, pairId: withdrawal }] },
      matched: { transfers: 1, refunds: 0, payments: 0, cleared: 0 },
    })
    expect(getTransaction(family, payment)).toMatchObject({ transferPairId: theirs, categoryId: categoryId(family, 'Credit card payment'), categorySource: 'user' })
    expect(getTransaction(family, theirs).transferPairId).toBe(payment)
    // Left behind, it's no longer a transfer, keeps its category as yours, and isn't remembered as a rejected pair.
    expect(getTransaction(personal, withdrawal)).toMatchObject({ transferPairId: null, categoryId: categoryId(personal, 'Credit card payment'), categorySource: 'user' })
    expect(
      personal.q.pluck('SELECT count(*) FROM transfer_rejections WHERE out_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?)', withdrawal),
    ).toBe(0)
    w.check()
  })

  it('takes a payment off its recurring item, and the other ledger’s item takes it', async () => {
    const w = world()
    const { personal, family } = w
    const add = (date: string) =>
      createTransaction(personal, transactionCreateSchema.parse({ accountId: w.visa, date, amountMinor: -1199, payee: 'SPOTIFY' }), { useAi: false })
    const subs = categoryId(personal, 'Software & media')
    const mine = createRecurring(
      personal,
      recurringCreateSchema.parse({ payee: 'SPOTIFY', expectedAmountMinor: -1199, cadence: 'monthly', anchorDate: '2026-07-05', categoryId: subs, accountId: w.visa }),
    )
    const pays = [await add('2026-07-05'), await add('2026-08-05'), await add('2026-09-05')]
    expect(getRecurring(personal, mine.id)).toMatchObject({ occurrences: 3, nextDueDate: '2026-10-05' })
    expect(getTransaction(personal, pays[2]!.id)).toMatchObject({ recurringItemId: mine.id, categoryId: subs })
    const theirs = createRecurring(family, recurringCreateSchema.parse({ payee: 'SPOTIFY', expectedAmountMinor: -1199, cadence: 'monthly', anchorDate: '2026-09-05' }))

    const moved = pays[2]!.id
    expect(w.move(personal, [moved], family)).toMatchObject({ recurringDetached: 1, dropped: { recurring: [{ id: moved, itemId: mine.id }] } })
    expect(getRecurring(personal, mine.id)).toMatchObject({ occurrences: 2, nextDueDate: '2026-09-05' })
    expect(getTransaction(family, moved)).toMatchObject({ recurringItemId: theirs.id })
    expect(getRecurring(family, theirs.id)).toMatchObject({ occurrences: 1, nextDueDate: '2026-10-05' })
    w.check()
  })

  it('gives back a plan’s payment from before your history, and reopens a paid-off plan', async () => {
    const w = world()
    const { personal, family } = w
    const add = (date: string, amountMinor: number, payee: string) =>
      createTransaction(personal, transactionCreateSchema.parse({ accountId: w.visa, date, amountMinor, payee }), { useAi: false, skipRecurring: true })

    // Five payments of $100, three found, and you said four were paid: the down payment was one of them.
    const down = await add('2026-07-10', -30_000, 'AFFIRM')
    for (const date of ['2026-07-15', '2026-08-15', '2026-09-15']) await add(date, -10_000, 'AFFIRM')
    const sofa = createRecurring(
      personal,
      recurringCreateSchema.parse({ payee: 'AFFIRM', name: 'Sofa', expectedAmountMinor: -10_000, cadence: 'monthly', anchorDate: '2026-07-15', totalPayments: 5, accountId: w.visa }),
    )
    updateRecurring(personal, sofa.id, { paidPayments: 4 })
    expect(addPayment(personal, sofa.id, down.id)).toMatchObject({ paidPayments: 4, remainingPayments: 1 })
    expect(w.move(personal, [down.id], family)).toMatchObject({ recurringDetached: 1 })
    // Still four paid: the one from before your history counts as paid before again.
    expect(getRecurring(personal, sofa.id)).toMatchObject({ paidPayments: 4, remainingPayments: 1, occurrences: 3 })

    // Four payments, all made: the plan ended. Without its last one it's back on.
    const pays = []
    for (const date of ['2026-06-02', '2026-06-16', '2026-06-30', '2026-07-14']) pays.push(await add(date, -2500, 'KLARNA*SHOP'))
    detectRecurring(personal)
    const klarna = confirmRecurring(personal, listRecurring(personal, 'suggested').find((r) => r.expectedAmountMinor === -2500)!.id)
    expect(klarna).toMatchObject({ status: 'ended', paidPayments: 4 })
    w.move(personal, [pays[3]!.id], family)
    expect(getRecurring(personal, klarna.id)).toMatchObject({ status: 'active', paidPayments: 3, nextDueDate: '2026-07-14' })
    w.check()
  })

  it('moves tags by name, clears the import batch and the bank payloads, and is then not found where it was', () => {
    const w = world()
    const { personal, family } = w
    const batch = Number(personal.q.run("INSERT INTO import_batches (ledger_id, account_id, file_name, row_count) VALUES (@ledger, ?, 'visa.csv', 1)", w.visa).lastInsertRowid)
    const tx = w.row(personal, '2026-09-10', -700, { origin: 'import', batch })
    updateTransaction(personal, tx, { tags: ['trip', 'work'] })
    const [trip] = upsertTags(personal, ['trip'])
    updateTag(personal, trip!, { color: '#e11d48' })
    createTag(family, 'work')
    personal.q.run("INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (?, 'plaid', 'r1', ?, 'added', '{}')", w.visa, tx)

    expect(w.move(personal, [tx], family)).toMatchObject({ moved: 1, tagsCreated: 1 })
    expect(getTransaction(family, tx).tags.map((t) => [t.name, t.color])).toEqual([
      ['trip', '#e11d48'],
      ['work', null],
    ])
    expect(family.q.pluck('SELECT import_batch_id FROM transactions WHERE ledger_id = @ledger AND id = ?', tx)).toBeNull()
    // The batch stays where the import was made, and so does the payload, now pointing at no row.
    expect(personal.q.pluck('SELECT count(*) FROM import_batches WHERE ledger_id = @ledger AND id = ?', batch)).toBe(1)
    expect(personal.q.all('SELECT remote_id, transaction_id FROM bank_payloads WHERE account_id IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger)')).toEqual([
      { remote_id: 'r1', transaction_id: null },
    ])
    expect(() => getTransaction(personal, tx)).toThrow('Transaction not found')
    // Its tags stay in Personal, with no row.
    expect(personal.q.column('SELECT name FROM tags WHERE ledger_id = @ledger ORDER BY name')).toEqual(['trip', 'work'])
    w.check()
  })
})

describe('moving transactions: what is refused', () => {
  it('refuses a deleted row, another ledger’s row, a missing one, an unshared account, an archived or non-member ledger, all with nothing changed', () => {
    const w = world()
    const { personal, family, trip, storage } = w
    const mine = w.row(personal, '2026-09-10', -700)
    const theirs = w.row(family, '2026-09-11', -800)
    const gone = w.row(personal, '2026-09-12', -900)
    deleteTransaction(personal, gone)
    const cash = makeAccount(personal, 'Cash', 'cash')
    const onCash = w.row(personal, '2026-09-13', -1000, { account: cash, payee: 'Kiosk' })
    const before = w.everything(personal, family, trip)

    // Another ledger's and one that doesn't exist: the same answer.
    refused(() => w.move(personal, [mine, theirs], family), `There’s no transaction ${theirs} in Personal to move.`)
    refused(() => w.move(personal, [mine, 999_999], family), 'There’s no transaction 999999 in Personal to move.')
    refused(() => w.move(personal, [gone], family), 'Shop (-$9.00 on 2026-09-12) is deleted. Restore it to move it.')
    refused(() => w.move(personal, [onCash], family), 'Cash isn’t shared with Family, so Kiosk (-$10.00 on 2026-09-13) can’t move there.')
    refused(() => w.move(personal, [mine], trip), 'Visa isn’t shared with Trip, so Shop (-$7.00 on 2026-09-10) can’t move there.')
    refused(() => w.move(personal, [mine], personal), 'They’re in Personal already.')
    refused(() => w.move(personal, [], family), 'Pick the transactions to move.')
    storage.registry.update(family.ledger.id, { archived: true })
    refused(() => w.move(personal, [mine], family), 'Family is archived. Restore it to move transactions to it.')
    expect(w.everything(personal, family, trip)).toEqual(before)
  })

  it('moves 1000 at a time, and refuses 1001', () => {
    const w = world()
    const { personal, family } = w
    const ids = personal.q.transaction(() => Array.from({ length: MOVE_LIMIT + 1 }, (_, i) => w.row(personal, addDays('2026-01-01', i % 270), -100 - i)))
    const before = w.everything(personal, family)
    refused(() => w.move(personal, ids, family), 'Move at most 1000 transactions at a time.')
    expect(w.everything(personal, family)).toEqual(before)
    expect(w.move(personal, ids.slice(0, MOVE_LIMIT), family)).toMatchObject({ moved: MOVE_LIMIT })
    expect(family.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(MOVE_LIMIT)
    w.check()
  })
})

describe('moving transactions: dry runs and balances', () => {
  it('reports in a dry run what the move does, and changes nothing in either ledger', () => {
    const w = world()
    const { personal, family } = w
    const chequing = makeAccount(personal, 'TD Chequing')
    makeAccount(family, 'Joint Chequing')
    const payment = w.row(personal, '2026-09-20', 50_000, { payee: 'PAYMENT - THANK YOU', origin: 'sync' })
    w.row(personal, '2026-09-20', -50_000, { payee: 'TD VISA PREAUTH PYMT', account: chequing, origin: 'sync' })
    matchTransactions(personal)
    const purchase = w.row(personal, '2026-09-10', -8000, { payee: 'Sport Store', category: 'Groceries' })
    const refund = w.row(personal, '2026-09-15', 2000, { payee: 'Sport Store' })
    setLinks(personal, refund, [{ transactionId: purchase, kind: 'refund', amountMinor: 2000 }])
    updateTransaction(personal, purchase, { tags: ['sport'] })
    const ids = [payment, refund]

    const before = w.everything(personal, family)
    const dry = w.move(personal, ids, family, { dryRun: true })
    expect(w.everything(personal, family)).toEqual(before)
    expect(dry).toMatchObject({ moved: 2, unlinked: 1, unpaired: 1 })
    // What it said is what it does.
    expect(w.move(personal, ids, family)).toEqual(dry)
    expect(family.q.column("SELECT summary FROM activity WHERE ledger_id = @ledger AND action = 'move'")).toEqual(['Personal moved 2 transactions to this ledger'])
    expect(personal.q.column("SELECT summary FROM activity WHERE ledger_id = @ledger AND action = 'move'")).toEqual(['Moved 2 transactions to Family'])
    w.check()
  })

  it('leaves every part as it was when rows go away and come back, with and without a recorded balance', () => {
    for (const recorded of [false, true]) {
      const w = world({ shareWith: ['family', 'trip'], opening: -10_000 })
      const { personal, family, trip, storage } = w
      const rows = ['2026-01-20', '2026-03-05', '2026-05-15', '2026-06-10', '2026-07-02', '2026-08-18', '2026-09-25'].map((date, i) =>
        w.row(personal, date, -1000 * (i + 1)),
      )
      w.row(family, '2026-04-04', -5000)
      w.row(trip, '2026-08-08', -2000)
      if (recorded) personal.q.run("INSERT INTO balance_snapshots (account_id, date, balance_minor) VALUES (?, '2026-06-30', -27000)", w.visa)
      const dates = ['2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']
      const ctxs = [personal, family, trip]
      const partsAt = () => ctxs.map((c) => balancesAt(c, dates).get(w.visa))
      const before = { today: w.check(), past: partsAt() }

      // Away from home to a member, on to another member, and home again: before and after the recorded balance.
      const moving = [rows[1]!, rows[3]!, rows[5]!]
      w.move(personal, moving, family)
      w.check()
      w.move(family, moving, trip)
      w.check()
      w.move(trip, moving, personal)
      expect(w.check(), recorded ? 'with a recorded balance' : 'without').toEqual(before.today)
      expect(partsAt()).toEqual(before.past)
      expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
    }
  })

  it('leaves a ledger holding moved rows whose nightly job, purge, matching and categorizing all run', async () => {
    const asked: string[] = []
    const w = world({ llm: ai(asked, 'Software & media') })
    const { personal, family, storage } = w
    const months = ['2026-04-12', '2026-05-12', '2026-06-12', '2026-07-12', '2026-08-12', '2026-09-12']
    const ids = months.map((date, i) => w.row(personal, date, -1699, { payee: 'NETFLIX.COM', origin: 'sync', externalId: `n${i}` }))
    for (const [i, id] of ids.entries()) {
      personal.q.run("INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (?, 'simplefin', ?, ?, 'added', '{}')", w.visa, `n${i}`, id)
    }
    w.move(personal, ids, family, { defer: true })
    // One moved row deleted there long enough ago to be purged.
    deleteTransaction(family, ids[0]!)
    family.q.run("UPDATE transactions SET deleted_at = '2026-08-01T00:00:00Z' WHERE ledger_id = @ledger AND id = ?", ids[0])

    expect(runDailyJobs(storage)).toEqual([])
    expect(family.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND id = ?', ids[0])).toBe(0)
    expect(listRecurring(family, 'suggested')).toMatchObject([{ payeeKey: 'netflix.com' }])
    // As after a sync: matching, the recurring scan and AI for what's left.
    matchTransactions(family, { since: '0000-01-01' })
    detectRecurring(family)
    await categorizeUncategorized(family, { ids })
    expect(asked).toEqual(['NETFLIX.COM'])
    expect(getTransaction(family, ids[5]!).categoryId).toBe(categoryId(family, 'Software & media'))
    w.check()
  })
})
