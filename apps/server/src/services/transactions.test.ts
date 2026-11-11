import { describe, expect, it } from 'vitest'
import { recurringCreateSchema, transactionCreateSchema } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import { getAccount, setBalance } from './accounts'
import { deleteGroup, getCategory, getGroup, listCategories, mergeCategory } from './categories'
import { suggestCategory } from './categorize'
import { createRecurring, getRecurring } from './recurring'
import { acceptSuggestion, createTransaction, deleteTransaction, listTransactions, restoreTransaction, updateTransaction } from './transactions'

const tx = (input: Record<string, unknown>) => transactionCreateSchema.parse(input)

describe('transactions', () => {
  it('suggests what you picked for a payee before, to review', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const groceries = categoryId(ctx, 'Groceries')
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: -5000, payee: 'LOBLAWS #1032 TORONTO ON', categoryId: groceries }))

    const once = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-08', amountMinor: -4200, payee: 'Loblaws #88' }))
    expect(once).toMatchObject({ categoryId: groceries, needsReview: true })
    // However often: only a payee choice sets it without review.
    acceptSuggestion(ctx, once.id)
    const twice = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-15', amountMinor: -3900, payee: 'LOBLAWS' }))
    expect(twice).toMatchObject({ categoryId: groceries, needsReview: true, categorySource: 'history' })
  })

  it('uses the LLM when history has nothing and marks it for review', async () => {
    const ctx = testContext({
      llm: async (req) => {
        expect(req.categories.some((c) => c.name === 'Drinks & treats')).toBe(true)
        return { category: 'Drinks & treats', confidence: 0.9, slot: 'primary', model: 'test-model' }
      },
    })
    const acc = makeAccount(ctx)
    const t = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: -485, payee: 'BALZACS COFFEE' }))
    expect(t).toMatchObject({ categoryId: categoryId(ctx, 'Drinks & treats'), categorySource: 'ai', needsReview: true })
  })

  it('ignores LLM answers that are not in the category list or have the wrong direction', async () => {
    const ctx = testContext({ llm: async () => ({ category: 'Salary', confidence: 0.9, slot: 'primary', model: 'm' }) })
    const acc = makeAccount(ctx)
    const s = await suggestCategory(ctx, { payee: 'Mystery store', amountMinor: -1000, accountId: acc })
    expect(s.categoryId).toBeNull()
  })

  it('creates linked transfers that are excluded from spending categories', async () => {
    const ctx = testContext()
    const chequing = makeAccount(ctx, 'Chequing', 'chequing', 100_000)
    const card = makeAccount(ctx, 'Amex', 'credit', -20_000)
    const t = await createTransaction(ctx, tx({ accountId: chequing, date: '2026-09-20', amountMinor: -20_000, payee: 'Amex payment', transferAccountId: card }))
    expect(t.transferPairId).not.toBeNull()
    expect(t.categoryId).toBe(categoryId(ctx, 'Credit card payment'))
    expect(getAccount(ctx, chequing).balanceMinor).toBe(80_000)
    expect(getAccount(ctx, card).balanceMinor).toBe(0)

    updateTransaction(ctx, t.id, { amountMinor: -25_000 })
    expect(getAccount(ctx, card).balanceMinor).toBe(5_000)
    deleteTransaction(ctx, t.id)
    expect(getAccount(ctx, card).balanceMinor).toBe(-20_000)
    restoreTransaction(ctx, t.id)
    expect(getAccount(ctx, card).balanceMinor).toBe(5_000)
  })

  it('combines balance snapshots with later transactions', async () => {
    const ctx = testContext()
    const tfsa = makeAccount(ctx, 'TFSA', 'investment', 1_000_000)
    setBalance(ctx, tfsa, { date: '2026-09-30', balanceMinor: 2_841_000 })
    await createTransaction(ctx, tx({ accountId: tfsa, date: '2026-09-15', amountMinor: 50_000, payee: 'Contribution' }))
    await createTransaction(ctx, tx({ accountId: tfsa, date: '2026-10-01', amountMinor: 50_000, payee: 'Contribution' }))
    expect(getAccount(ctx, tfsa).balanceMinor).toBe(2_891_000)
  })

  it('filters, searches and paginates with a cursor', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    for (let d = 1; d <= 5; d++) {
      await createTransaction(ctx, tx({ accountId: acc, date: `2026-09-0${d}`, amountMinor: -100 * d, payee: d % 2 ? 'Netflix' : 'Spotify', tags: d === 3 ? ['trip-japan'] : [] }))
    }
    const page1 = listTransactions(ctx, { limit: 2 })
    expect(page1.items.map((t) => t.date)).toEqual(['2026-09-05', '2026-09-04'])
    const page2 = listTransactions(ctx, { limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.map((t) => t.date)).toEqual(['2026-09-03', '2026-09-02'])
    expect(listTransactions(ctx, { limit: 50, q: 'netflix' }).items).toHaveLength(3)
    expect(listTransactions(ctx, { limit: 50, q: '3.00' }).items).toHaveLength(1)
    const tagged = listTransactions(ctx, { limit: 50, q: undefined }).items.find((t) => t.tags.length)
    expect(tagged?.tags[0]?.name).toBe('trip-japan')
  })

  it('searches for % and _ as typed, not as wildcards', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: -100, payee: 'Shop', notes: '20% off' }))
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-02', amountMinor: -200, payee: 'Shop', notes: '20 dollars off' }))
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-03', amountMinor: -300, payee: 'ORDER_42' }))
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-04', amountMinor: -400, payee: 'ORDERX42' }))
    const found = (q: string) => listTransactions(ctx, { limit: 50, q }).items.map((t) => t.amountMinor)
    expect(found('20%')).toEqual([-100])
    expect(found('order_')).toEqual([-300])
    expect(found('off\\')).toEqual([])
  })

  it('unlearns the old category when the user corrects it', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const t = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: -2000, payee: 'Costco', categoryId: categoryId(ctx, 'General shopping') }))
    updateTransaction(ctx, t.id, { categoryId: categoryId(ctx, 'Groceries') })
    const s = await suggestCategory(ctx, { payee: 'COSTCO WHOLESALE', amountMinor: -100, useAi: false })
    expect(s.categoryId).toBe(categoryId(ctx, 'Groceries'))
  })

  it('orders a day’s transactions by their time when known, and keeps it when the date moves', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Chequing', 'chequing', 0)
    const add = (amountMinor: number, payee: string, datetime?: string) =>
      createTransaction(ctx, tx({ accountId: acc, date: '2026-09-15', amountMinor, payee, datetime }), { useAi: false })
    await add(-5_000, 'Groceries')
    const lunch = await add(-1_200, 'Lunch', '2026-09-15T12:30')
    await add(300_000, 'Payroll')
    await add(-450, 'Coffee', '2026-09-15T08:05')
    // Newest first: money out without a time at the end of the day, money in without one at the start.
    expect(listTransactions(ctx, { limit: 50, accountId: acc }).items.map((t) => [t.payee, t.datetime])).toEqual([
      ['Groceries', null],
      ['Lunch', '2026-09-15T12:30:00'],
      ['Coffee', '2026-09-15T08:05:00'],
      ['Payroll', null],
    ])
    // Pages follow it too.
    const page1 = listTransactions(ctx, { limit: 2, accountId: acc })
    expect(listTransactions(ctx, { limit: 2, accountId: acc, cursor: page1.nextCursor! }).items.map((t) => t.payee)).toEqual(['Coffee', 'Payroll'])
    // Moving the date keeps the time; a time is on its date.
    expect(updateTransaction(ctx, lunch.id, { date: '2026-09-16' }).datetime).toBe('2026-09-16T12:30:00')
    expect(() => updateTransaction(ctx, lunch.id, { datetime: '2026-09-15T12:30:00' })).toThrow(/on its date/)
  })

  it('puts a day’s money in before its money out, whatever order they were added in', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Chequing', 'chequing', 0)
    const add = (date: string, amountMinor: number, payee: string) => createTransaction(ctx, tx({ accountId: acc, date, amountMinor, payee }), { useAi: false })
    await add('2026-09-15', -80_000, 'Rent')
    await add('2026-09-15', -5_000, 'Groceries')
    await add('2026-09-15', 300_000, 'Payroll')
    await add('2026-09-16', -1_000, 'Coffee')
    // Newest first: the day's payments above its pay, so the balance never shows below zero.
    expect(listTransactions(ctx, { limit: 50, accountId: acc }).items.map((t) => [t.payee, t.balanceAfterMinor])).toEqual([
      ['Coffee', 214_000],
      ['Groceries', 215_000],
      ['Rent', 220_000],
      ['Payroll', 300_000],
    ])
    // Pages follow the same order, and so do their balances.
    const page1 = listTransactions(ctx, { limit: 2, accountId: acc })
    const page2 = listTransactions(ctx, { limit: 2, accountId: acc, cursor: page1.nextCursor! })
    expect(page2.items.map((t) => [t.payee, t.balanceAfterMinor])).toEqual([
      ['Rent', 220_000],
      ['Payroll', 300_000],
    ])

    // A credit card keeps the order they were added: a refund after its charge stays after it.
    const card = makeAccount(ctx, 'Visa', 'credit')
    await createTransaction(ctx, tx({ accountId: card, date: '2026-09-20', amountMinor: -15_000, payee: 'Gas' }), { useAi: false })
    await createTransaction(ctx, tx({ accountId: card, date: '2026-09-20', amountMinor: 15_000, payee: 'Gas refund' }), { useAi: false })
    expect(listTransactions(ctx, { limit: 50, accountId: card }).items.map((t) => t.payee)).toEqual(['Gas refund', 'Gas'])
  })

  it('shows a running balance for one account, like a statement', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Chequing', 'chequing', 100_000)
    const other = makeAccount(ctx, 'Savings', 'savings', 0)
    const add = (input: Record<string, unknown>) => createTransaction(ctx, tx({ accountId: acc, useAi: false, ...input }), { useAi: false })
    await add({ date: '2026-08-30', amountMinor: -10_000, payee: 'Rent' })
    await add({ date: '2026-09-02', amountMinor: 250_000, payee: 'Payroll' })
    await add({ date: '2026-09-02', amountMinor: -4_500, payee: 'Groceries' })
    await add({ date: '2026-09-10', amountMinor: -20_000, payee: 'To savings', transferAccountId: other })

    const balances = (q: Record<string, unknown>) => listTransactions(ctx, { limit: 50, accountId: acc, ...q }).items.map((t) => t.balanceAfterMinor)
    // Newest first, ending at the account's balance.
    expect(balances({})).toEqual([315_500, 335_500, 340_000, 90_000])
    expect(getAccount(ctx, acc).balanceMinor).toBe(315_500)
    // A month, or a later page, still counts everything around it.
    expect(balances({ from: '2026-09-01', to: '2026-09-05' })).toEqual([335_500, 340_000])
    const page1 = listTransactions(ctx, { limit: 2, accountId: acc })
    const page2 = listTransactions(ctx, { limit: 2, accountId: acc, cursor: page1.nextCursor! })
    expect(page2.items.map((t) => t.balanceAfterMinor)).toEqual([340_000, 90_000])
    // Filtered lists skip transactions, and lists across accounts have no one balance.
    expect(balances({ q: 'rent' })).toEqual([null])
    // An empty filter is no filter.
    expect(balances({ filter: { v: 1, spending: { only: [], filterOut: [], picked: [], keep: [] } } })).toEqual(balances({}))
    expect(listTransactions(ctx, { limit: 50 }).items.every((t) => t.balanceAfterMinor === null)).toBe(true)
  })


  it('merges a category into another, moving its transactions, recurring payments and learned payees', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const [treats, dineOut] = [categoryId(ctx, 'Drinks & treats'), categoryId(ctx, 'Dine out')]
    const add = (payee: string, categoryId: number) =>
      createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: -600, payee, categoryId }), { useAi: false })
    await add('Starbucks', treats)
    const gone = await add('Starbucks', treats)
    deleteTransaction(ctx, gone.id)
    await add('Pizza place', dineOut)
    const sub = createRecurring(
      ctx,
      recurringCreateSchema.parse({ payee: 'Coffee club', categoryId: treats, expectedAmountMinor: -2_000, cadence: 'monthly', anchorDate: '2026-09-05' }),
    )
    const labelsBefore = getCategory(ctx, dineOut).labelIds

    const result = mergeCategory(ctx, treats, dineOut)
    expect(result).toMatchObject({ transactions: 1, recurring: 1, into: { id: dineOut, name: 'Dine out', labelIds: labelsBefore } })
    expect(() => getCategory(ctx, treats)).toThrow(/not found/)
    expect(listTransactions(ctx, { limit: 50 }).items.map((t) => t.categoryId)).toEqual([dineOut, dineOut])
    expect(getRecurring(ctx, sub.id).categoryId).toBe(dineOut)
    // A deleted transaction comes back under the new category.
    expect(restoreTransaction(ctx, gone.id).categoryId).toBe(dineOut)
    // What was learned about the payee now points to the other category.
    expect((await suggestCategory(ctx, { payee: 'STARBUCKS #123', amountMinor: -500, useAi: false })).categoryId).toBe(dineOut)

    expect(() => mergeCategory(ctx, dineOut, dineOut)).toThrow(/different category/)
  })

  it('deletes a group with its categories, leaving their transactions uncategorized', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const treats = categoryId(ctx, 'Drinks & treats')
    const group = getCategory(ctx, treats).groupId!
    const inGroup = listCategories(ctx).categories.filter((c) => c.groupId === group)
    const t = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: -600, payee: 'Starbucks', categoryId: treats }), { useAi: false })

    expect(deleteGroup(ctx, group).map((c) => c.id)).toEqual(inGroup.map((c) => c.id))
    expect(() => getGroup(ctx, group)).toThrow(/not found/)
    expect(listCategories(ctx).categories.some((c) => c.groupId === group || inGroup.some((g) => g.id === c.id))).toBe(false)
    expect(listTransactions(ctx, { limit: 50 }).items.find((x) => x.id === t.id)?.categoryId).toBeNull()
  })
})

describe('transaction names', () => {
  const tx = (input: Record<string, unknown>) => transactionCreateSchema.parse(input)

  it('has its own, which search finds', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const t = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-20', amountMinor: -12_000, payee: 'MUJI', name: 'Suitcase' }), { useAi: false })
    expect(t.name).toBe('Suitcase')
    expect(listTransactions(ctx, { q: 'suitcase', limit: 10 }).items.map((x) => x.id)).toEqual([t.id])
    expect(updateTransaction(ctx, t.id, { name: '  ' }).name).toBeNull()
  })

  it('is shared with its recurring item, like its category', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const item = createRecurring(
      ctx,
      recurringCreateSchema.parse({ payee: 'PayHub Tax', name: 'Property tax', expectedAmountMinor: -31_044, cadence: 'monthly', anchorDate: '2026-09-20' }),
    )
    const a = await createTransaction(ctx, tx({ accountId: acc, date: '2026-08-20', amountMinor: -31_044, payee: 'PayHub Tax' }), { useAi: false })
    const b = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-20', amountMinor: -31_044, payee: 'PayHub Tax' }), { useAi: false })
    expect([a, b].map((t) => t.recurringItemId)).toEqual([null, item.id])
    updateTransaction(ctx, a.id, { recurringItemId: item.id })
    expect(listTransactions(ctx, { q: 'property', limit: 10 }).items.map((x) => x.name)).toEqual(['Property tax', 'Property tax'])

    // Naming one payment renames the item, and so all its payments.
    expect(updateTransaction(ctx, b.id, { name: 'City tax' }).name).toBe('City tax')
    expect(getRecurring(ctx, item.id).name).toBe('City tax')
    expect(listTransactions(ctx, { q: 'city tax', limit: 10 }).items).toHaveLength(2)

    // Taken off the item, it has no name (it never had one of its own).
    expect(updateTransaction(ctx, b.id, { recurringItemId: null }).name).toBeNull()
  })
})
