import { describe, expect, it } from 'vitest'
import { importCommitSchema, transactionCreateSchema } from '@st/shared'
import type { LlmCategoryRequest } from '../ai/types'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import type { AppContext } from './context'
import { categorizeUncategorized, commitImport } from './import'
import { setLinks } from './links'
import { matchTransactions } from './matching'
import {
  acceptSuggestion,
  bulkUpdate,
  deleteTransaction,
  getTransaction,
  insertTransaction,
  linkCandidates,
  linkedTransactions,
  updateTransaction,
} from './transactions'

/** A transaction as a sync brings it: with the app's own category, if any, waiting for review. */
function synced(ctx: AppContext, accountId: number, date: string, amountMinor: number, payee: string, category?: { id: number; source: 'ai' | 'history'; review?: boolean }) {
  return insertTransaction(
    ctx,
    transactionCreateSchema.parse({ accountId, date, amountMinor, payee }),
    {
      origin: 'sync',
      skipRecurring: true,
      suggestion: category
        ? { categoryId: category.id, source: category.source, confidence: 0.7, reason: '', autoApply: category.review === false }
        : null,
    },
  )
}

describe('matching refunds and card payments', () => {
  it('gives a refund its purchase’s category and name, and it follows the purchase', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const [fuel, salary] = [categoryId(ctx, 'Fuel'), categoryId(ctx, 'Salary')]
    const hold = synced(ctx, card, '2026-10-02', -12_000, 'Westside Gas Bar', { id: fuel, source: 'history', review: false })
    const charge = synced(ctx, card, '2026-10-02', -4_850, 'Westside Gas Bar', { id: fuel, source: 'history', review: false })
    updateTransaction(ctx, hold, { name: 'Pump hold' })
    // What AI guessed for the money back.
    const back = synced(ctx, card, '2026-10-02', 12_000, 'WESTSIDE GAS BAR #52 P@', { id: salary, source: 'ai' })

    expect(matchTransactions(ctx)).toMatchObject({ refunds: 1, transfers: 0, payments: 0 })
    expect(getTransaction(ctx, back)).toMatchObject({
      links: [expect.objectContaining({ kind: 'refund', transactionId: hold, amountMinor: 12_000 })],
      name: 'Pump hold',
      categoryId: fuel,
      categorySource: 'linked',
      needsReview: false,
    })
    expect(getTransaction(ctx, hold).links).toEqual([expect.objectContaining({ kind: 'refund', transactionId: back })])
    expect(getTransaction(ctx, charge).links).toEqual([])

    const groceries = categoryId(ctx, 'Groceries')
    updateTransaction(ctx, hold, { categoryId: groceries, name: 'Gas hold' })
    expect(getTransaction(ctx, back)).toMatchObject({ categoryId: groceries, name: 'Gas hold' })
    // Its name isn't its own to change, but its notes are.
    expect(() => updateTransaction(ctx, back, { name: 'Mine' })).toThrow('It has the name of the purchase it refunds.')
    expect(updateTransaction(ctx, back, { notes: 'Came back in 3 days' })).toMatchObject({ name: 'Gas hold', notes: 'Came back in 3 days' })

    // "Not a refund": it keeps its category and name, now as yours, and a later pass leaves it alone.
    setLinks(ctx, back, [])
    expect(getTransaction(ctx, back)).toMatchObject({ links: [], categoryId: groceries, categorySource: 'user', name: 'Gas hold' })
    expect(updateTransaction(ctx, back, { name: 'Mine' }).name).toBe('Mine')
    expect(matchTransactions(ctx).refunds).toBe(0)
  })

  it('links a partial refund with its purchase’s category, not to review, and never refunds more than was spent', () => {
    const ctx = testContext()
    const chq = makeAccount(ctx, 'Chequing')
    const clothing = categoryId(ctx, 'Clothing & shoes')
    const order = synced(ctx, chq, '2026-09-20', -12_000, 'Old Navy', { id: clothing, source: 'history', review: false })
    const first = synced(ctx, chq, '2026-09-25', 8_000, 'OLD NAVY #1234')
    const second = synced(ctx, chq, '2026-09-28', 8_000, 'Old Navy')

    matchTransactions(ctx)
    expect(getTransaction(ctx, first)).toMatchObject({ links: [expect.objectContaining({ transactionId: order })], categoryId: clothing, categorySource: 'linked', needsReview: false })
    // Only $40 of the $120 is left to refund.
    expect(getTransaction(ctx, second).links).toEqual([])
  })

  it('links a refund you pick, from any account, and finds the purchases it could be for', () => {
    const ctx = testContext()
    const chq = makeAccount(ctx, 'Chequing')
    const card = makeAccount(ctx, 'Visa', 'credit')
    const [clothing, shopping] = [categoryId(ctx, 'Clothing & shoes'), categoryId(ctx, 'General shopping')]
    const jacket = synced(ctx, card, '2026-06-20', -12_000, 'Old Navy', { id: clothing, source: 'history', review: false })
    const socks = synced(ctx, card, '2026-08-02', -4_000, 'OLD NAVY #1234', { id: clothing, source: 'history', review: false })
    const cable = synced(ctx, card, '2026-09-01', -6_499, 'Amazon', { id: shopping, source: 'history', review: false })
    const belt = synced(ctx, card, '2026-09-10', -3_000, 'Old Navy')
    synced(ctx, chq, '2025-12-01', -9_000, 'Old Navy')
    synced(ctx, chq, '2026-09-20', -50_000, 'Jane - INTERAC e-Transfer®', { id: categoryId(ctx, 'Transfer'), source: 'history', review: false })
    // Back to chequing, months later: too far, and the wrong account, for the rules.
    const back = synced(ctx, chq, '2026-09-25', 4_000, 'OLD NAVY ONLINE')

    // The same payee first, the same amount first; then the rest, newest first. A smaller one too (it
    // would take what that has left). Older than 6 months isn't listed unless searched for.
    const ids = (q?: string) => linkCandidates(ctx, back, { kind: 'refund', q }).map((c) => c.transaction.id)
    expect(ids()).toEqual([socks, belt, jacket, cable])
    expect(linkCandidates(ctx, back, { kind: 'refund' })[0]).toMatchObject({ leftMinor: 4_000, likely: true })
    expect(ids('amazon')).toEqual([cable])
    expect(ids('old navy')).toHaveLength(4)

    setLinks(ctx, back, [{ transactionId: jacket, amountMinor: 4_000, kind: 'refund' }])
    expect(getTransaction(ctx, back)).toMatchObject({ categoryId: clothing, categorySource: 'linked', needsReview: false })
    expect(linkedTransactions(ctx, jacket).map((x) => [x.link.kind, x.transaction.id])).toEqual([['refund', back]])
    // It always has the purchase's category, however that changes, and can't have its own.
    updateTransaction(ctx, jacket, { categoryId: shopping })
    expect(getTransaction(ctx, back).categoryId).toBe(shopping)
    ctx.sqlite.prepare('UPDATE transactions SET category_id = NULL WHERE id = ?').run(jacket)
    expect(getTransaction(ctx, back)).toMatchObject({ categoryId: null, categorySource: 'linked' })
    updateTransaction(ctx, jacket, { categoryId: clothing })
    expect(() => updateTransaction(ctx, back, { categoryId: shopping })).toThrow('It has the category of what it pays back.')
    const groceries = categoryId(ctx, 'Groceries')
    bulkUpdate(ctx, { ids: [back, cable], categoryId: groceries })
    expect(getTransaction(ctx, back).categoryId).toBe(clothing)
    expect(getTransaction(ctx, cable).categoryId).toBe(groceries)

    // Only what's left to refund (it's listed with that), and only onto a purchase.
    const more = synced(ctx, chq, '2026-09-26', 9_000, 'Old Navy')
    expect(linkCandidates(ctx, more, { kind: 'refund' }).find((c) => c.transaction.id === jacket)).toMatchObject({ leftMinor: 8_000 })
    const refund = (from: number, to: number, amountMinor = 9_000) => () => setLinks(ctx, from, [{ transactionId: to, amountMinor, kind: 'refund' }])
    expect(refund(more, back)).toThrow('Only a purchase or bill can be paid back')
    // All of a refund refunds its purchase, even more than it had left (its $80 gets $90 back): it has
    // the purchase's category. Once nothing is left, it takes no more.
    refund(more, jacket)()
    expect(getTransaction(ctx, more)).toMatchObject({ categoryId: clothing, categorySource: 'linked' })
    const after = synced(ctx, chq, '2026-09-27', 500, 'Old Navy')
    expect(refund(after, jacket, 500)).toThrow('Nothing of Old Navy (-$120.00 on 2026-06-20) is left to refund.')
    // Paybacks stay within what's left.
    const friend = synced(ctx, chq, '2026-09-27', 5_000, 'Sam - INTERAC e-Transfer®')
    expect(() => setLinks(ctx, friend, [{ transactionId: cable, amountMinor: 5_000, kind: 'payback' }])).not.toThrow()
    expect(() => setLinks(ctx, friend, [{ transactionId: socks, amountMinor: 5_000, kind: 'payback' }])).toThrow('Only $40.00 of OLD NAVY #1234')
    expect(refund(socks, jacket)).toThrow('Only money in can pay back a purchase or bill.')
  })

  it('pairs a card payment with the withdrawal that paid it, even when that arrives later', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const payment = categoryId(ctx, 'Credit card payment')
    const salary = categoryId(ctx, 'Salary')
    const credit = synced(ctx, card, '2026-10-03', 50_000, 'PAYMENT - THANK YOU', { id: salary, source: 'ai' })

    expect(matchTransactions(ctx)).toMatchObject({ payments: 1, transfers: 0 })
    expect(getTransaction(ctx, credit)).toMatchObject({ categoryId: payment, categorySource: 'rule', needsReview: false, transferPairId: null })
    // Unchanged on the next pass.
    expect(matchTransactions(ctx)).toMatchObject({ payments: 0, transfers: 0 })

    // A same-amount withdrawal too far away isn't it; the one two days earlier is.
    synced(ctx, chq, '2026-09-20', -50_000, 'Rent')
    const withdrawal = synced(ctx, chq, '2026-10-01', -50_000, 'SCOTIA VISA PYMT')
    expect(matchTransactions(ctx).transfers).toBe(1)
    expect(getTransaction(ctx, credit)).toMatchObject({ transferPairId: withdrawal, categoryId: payment })
    expect(getTransaction(ctx, withdrawal)).toMatchObject({ transferPairId: credit, categoryId: payment, needsReview: false })

    // Editing one side doesn't change the other: they're two bank records.
    updateTransaction(ctx, withdrawal, { notes: 'October’s' })
    expect(getTransaction(ctx, credit).notes).toBeNull()

    // "Not a transfer": both keep their categories as yours, and aren't paired again.
    updateTransaction(ctx, credit, { transferPairId: null })
    expect(getTransaction(ctx, credit)).toMatchObject({ transferPairId: null, categorySource: 'user' })
    expect(getTransaction(ctx, withdrawal)).toMatchObject({ transferPairId: null, categorySource: 'user' })
    expect(matchTransactions(ctx)).toMatchObject({ transfers: 0, payments: 0 })
  })

  it('pairs a CSV file’s old card payments, and ones you or your history already call a payment', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Mastercard', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const payment = categoryId(ctx, 'Credit card payment')
    const salary = categoryId(ctx, 'Salary')
    // Paid from chequing over a year ago: older than the last 60 days a pass looks at.
    const paid = [
      synced(ctx, chq, '2025-07-14', -31_500, 'Card Bank - Bill payment', { id: payment, source: 'history', review: false }),
      synced(ctx, chq, '2025-08-12', -50_000, 'Card Bank - Bill payment'),
      synced(ctx, chq, '2026-10-01', -20_000, 'Card Bank - Bill payment'),
    ]
    const sure = synced(ctx, card, '2026-10-02', 20_000, 'Payment Thank You', { id: payment, source: 'history', review: false })
    const income = synced(ctx, card, '2026-10-02', 2_500, 'Payment Thank You', { id: salary, source: 'history', review: false })
    // Money back months after a purchase: too long ago for a refund, but not a payment either.
    synced(ctx, card, '2026-02-10', -39_000, 'Clearview Optometry')
    const late = synced(ctx, card, '2026-07-05', 39_000, 'CLEARVIEW OPTOMETRY')
    const { batchId } = commitImport(
      ctx,
      importCommitSchema.parse({
        accountId: card,
        rows: [
          { line: 2, date: '2025-08-13', payee: 'Payment Thank You', amountMinor: 50_000, categoryId: payment },
          { line: 3, date: '2025-07-14', payee: 'Payment Thank You', amountMinor: 31_500 },
        ],
      }),
      { background: false },
    )
    const [yours, rule] = ctx.sqlite.prepare('SELECT id FROM transactions WHERE import_batch_id = ? ORDER BY date DESC').pluck().all(batchId) as [number, number]

    expect(getTransaction(ctx, rule)).toMatchObject({ transferPairId: paid[0], categoryId: payment, categorySource: 'rule' })
    // Your category and your history's sure one stay, paired.
    expect(getTransaction(ctx, yours)).toMatchObject({ transferPairId: paid[1], categoryId: payment, categorySource: 'user' })
    expect(getTransaction(ctx, sure)).toMatchObject({ transferPairId: paid[2], categorySource: 'history' })
    expect(getTransaction(ctx, paid[1]!)).toMatchObject({ transferPairId: yours, categoryId: payment })
    // Money in your history calls income isn't a payment.
    expect(getTransaction(ctx, income)).toMatchObject({ transferPairId: null, categoryId: salary })
    expect(getTransaction(ctx, late)).toMatchObject({ transferPairId: null, links: [], categoryId: null })

    // "Not a transfer" is remembered, even with its payment category.
    updateTransaction(ctx, yours, { transferPairId: null })
    expect(matchTransactions(ctx, { since: '0000-01-01' })).toMatchObject({ transfers: 0, payments: 0 })
    expect(getTransaction(ctx, yours)).toMatchObject({ transferPairId: null, categoryId: payment, categorySource: 'user' })
  })

  it('leaves e-Transfers, cash back and tiny adjustments alone', async () => {
    const asked: string[] = []
    const ctx = testContext({
      llm: async (req) => {
        asked.push(req.payee)
        return { category: 'Other income', confidence: 0.9, slot: 'primary', model: 'm' }
      },
    })
    const chq = makeAccount(ctx, 'Chequing')
    const card = makeAccount(ctx, 'Visa', 'credit')
    const rent = categoryId(ctx, 'Rent')
    // Money between people: their names would match any e-Transfer.
    synced(ctx, chq, '2026-09-03', -420_000, 'Jane Doe CIBC - INTERAC e-Transfer®', { id: rent, source: 'history', review: false })
    const fromMe = synced(ctx, chq, '2026-09-04', 185_000, 'Jane Doe - INTERAC e-Transfer®')
    // A cent back on a bill isn't a refund.
    synced(ctx, card, '2026-09-11', -29_850, 'PayHub Utilities', { id: rent, source: 'history', review: false })
    const cent = synced(ctx, card, '2026-09-18', 81, 'PAYHUB UTILITIES TORONTO ON')
    // Cash back isn't a payment, and isn't paired with an e-Transfer of the same amount.
    const cashBack = synced(ctx, card, '2026-10-01', 5_430, 'CASH BACK REDEEMED')
    const branch = synced(ctx, card, '2026-10-01', 45_000, 'SCOTIABANK TRANSIT 01234 TORONTO ON')
    const toFriend = synced(ctx, chq, '2026-10-01', -45_000, 'John Smith - INTERAC e-Transfer®')

    matchTransactions(ctx)
    expect(getTransaction(ctx, fromMe).links).toEqual([])
    expect(getTransaction(ctx, cent).links).toEqual([])
    expect(getTransaction(ctx, cashBack)).toMatchObject({ categoryId: null, categorySource: null })
    expect(getTransaction(ctx, branch).transferPairId).toBeNull()
    expect(getTransaction(ctx, toFriend).transferPairId).toBeNull()
    // Cash back goes to AI like anything else; payments don't.
    await categorizeUncategorized(ctx, { ids: [cashBack, branch] })
    expect(asked).toEqual(['CASH BACK REDEEMED'])

    // An earlier pass that called cash back a payment is undone.
    const payment = categoryId(ctx, 'Credit card payment')
    const before = synced(ctx, card, '2026-10-02', 5_120, 'CASH BACK REDEEMED')
    ctx.sqlite.prepare("UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?").run(payment, before)
    expect(matchTransactions(ctx).cleared).toEqual([before])
    expect(getTransaction(ctx, before)).toMatchObject({ categoryId: null, categorySource: null })
  })

  it('deletes one side of a matched transfer without the other', () => {
    const ctx = testContext()
    const card = makeAccount(ctx, 'Visa', 'credit')
    const chq = makeAccount(ctx, 'Chequing')
    const credit = synced(ctx, card, '2026-10-03', 20_000, 'Payment')
    const withdrawal = synced(ctx, chq, '2026-10-03', -20_000, 'Visa payment')
    matchTransactions(ctx)
    deleteTransaction(ctx, credit)
    expect(getTransaction(ctx, withdrawal)).toMatchObject({ transferPairId: null })
  })

  it('falls back to Transfer, then uncategorized, and leaves your choices and sure history alone', async () => {
    const asked: LlmCategoryRequest[] = []
    const ctx = testContext({
      llm: async (req) => {
        asked.push(req)
        return { category: 'Salary', confidence: 0.9, slot: 'primary', model: 'm' }
      },
    })
    const card = makeAccount(ctx, 'Visa', 'credit')
    const transfer = categoryId(ctx, 'Transfer')
    ctx.sqlite.prepare("UPDATE categories SET archived_at = '2026-01-01' WHERE name = 'Credit card payment'").run()
    const a = synced(ctx, card, '2026-10-01', 1_000, 'Payment A')
    matchTransactions(ctx)
    expect(getTransaction(ctx, a).categoryId).toBe(transfer)

    ctx.sqlite.prepare("UPDATE categories SET archived_at = '2026-01-01' WHERE name = 'Transfer'").run()
    const b = synced(ctx, card, '2026-10-02', 2_000, 'Payment B')
    matchTransactions(ctx)
    expect(getTransaction(ctx, b)).toMatchObject({ categoryId: null, needsReview: false })
    // Card credits aren't guessed by AI.
    await categorizeUncategorized(ctx, { ids: [b] })
    expect(asked).toEqual([])
    expect(getTransaction(ctx, b).categoryId).toBeNull()

    // Cash back your history is sure of, a category you chose, and an AI pick you accepted, stay.
    const rewards = categoryId(ctx, 'Other income')
    const cashBack = synced(ctx, card, '2026-10-02', 500, 'Cash back', { id: rewards, source: 'history', review: false })
    const yours = synced(ctx, card, '2026-10-02', 700, 'Credit')
    updateTransaction(ctx, yours, { categoryId: rewards })
    const accepted = synced(ctx, card, '2026-10-02', 900, 'Bonus', { id: rewards, source: 'ai' })
    acceptSuggestion(ctx, accepted)
    matchTransactions(ctx)
    expect(getTransaction(ctx, cashBack).categoryId).toBe(rewards)
    expect(getTransaction(ctx, yours)).toMatchObject({ categoryId: rewards, categorySource: 'user' })
    expect(getTransaction(ctx, accepted)).toMatchObject({ categoryId: rewards, needsReview: false })
  })
})

describe('the bank’s category as a second opinion', () => {
  it('applies an AI pick without review when a sure bank agrees', async () => {
    let agrees = true
    const asked: LlmCategoryRequest[] = []
    const ctx = testContext({
      llm: async (req) => {
        asked.push(req)
        return { category: 'Fuel', confidence: 0.9, agreesWithBank: agrees, slot: 'primary', model: 'm' }
      },
    })
    const card = makeAccount(ctx, 'Visa', 'credit')
    const setBank = ctx.sqlite.prepare('UPDATE transactions SET bank_category = ?, bank_category_confident = ? WHERE id = ?')
    const fuel = categoryId(ctx, 'Fuel')

    const sure = synced(ctx, card, '2026-10-01', -6_000, 'Shell')
    setBank.run('Transportation › Gas', 1, sure)
    await categorizeUncategorized(ctx, { ids: [sure] })
    expect(asked[0]).toMatchObject({ bankCategory: 'Transportation › Gas' })
    expect(asked[0]!.categories.find((c) => c.name === 'Credit card payment')).toMatchObject({ excluded: true })
    expect(getTransaction(ctx, sure)).toMatchObject({ categoryId: fuel, categorySource: 'ai', needsReview: false, bankCategory: 'Transportation › Gas' })

    // The bank unsure, or the AI disagreeing: it's a suggestion to review.
    const unsure = synced(ctx, card, '2026-10-01', -4_000, 'Esso')
    setBank.run('Transportation › Gas', 0, unsure)
    await categorizeUncategorized(ctx, { ids: [unsure] })
    expect(getTransaction(ctx, unsure).needsReview).toBe(true)
    agrees = false
    const other = synced(ctx, card, '2026-10-01', -3_000, 'Petro-Canada')
    setBank.run('Transportation › Gas', 1, other)
    await categorizeUncategorized(ctx, { ids: [other] })
    expect(getTransaction(ctx, other).needsReview).toBe(true)
  })
})
