import { describe, expect, it } from 'vitest'
import { importCommitSchema, importPreviewSchema, transactionCreateSchema } from '@st/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import { suggestCategory } from './categorize'
import { commitImport, previewImport, recategorize, undoBatch, type Recategorized } from './import'
import { setPayeeChoice } from './payees'
import { createTransaction, getTransaction, listTransactions } from './transactions'

const rows = [
  { line: 2, date: '2026-09-30', payee: 'LOBLAWS #1032 TORONTO ON', amountMinor: -8432, notes: null },
  { line: 3, date: '2026-09-29', payee: 'ACME CORP PAYROLL', amountMinor: 307_500, notes: null },
  { line: 4, date: '2026-09-28', payee: 'NETFLIX.COM', amountMinor: -2099, notes: null },
]

describe('csv import', () => {
  it('previews duplicates and history suggestions, commits, skips re-imports and can be undone', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const groceries = categoryId(ctx, 'Groceries')
    // Already entered by hand, posted a day later than the bank's date.
    await createTransaction(ctx, transactionCreateSchema.parse({ accountId: acc, date: '2026-09-27', amountMinor: -2099, payee: 'Netflix' }), { useAi: false })
    await createTransaction(ctx, transactionCreateSchema.parse({ accountId: acc, date: '2026-08-02', amountMinor: -1000, payee: 'Loblaws', categoryId: groceries }))

    const preview = previewImport(ctx, importPreviewSchema.parse({ accountId: acc, rows }))
    expect(preview.map((r) => r.duplicateOf !== null)).toEqual([false, false, true])
    expect(preview[0]!.suggestion.categoryId).toBe(groceries)

    const result = commitImport(ctx, importCommitSchema.parse({ accountId: acc, fileName: 'td.csv', rows }))
    expect(result).toMatchObject({ imported: 2, skippedDuplicates: 1, categorized: 1 })

    const again = commitImport(ctx, importCommitSchema.parse({ accountId: acc, rows }))
    expect(again.imported).toBe(0)

    undoBatch(ctx, result.batchId!)
    expect(listTransactions(ctx, { limit: 50 }).items).toHaveLength(2)
  })

  it('keeps a row’s category from the file as its bank category, for AI to go by', () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const rows = [{ line: 2, date: '2026-07-23', payee: 'ROGERS', amountMinor: -2800, category: 'Utilities' }]
    commitImport(ctx, importCommitSchema.parse({ accountId: acc, rows }), { background: false })
    expect(listTransactions(ctx, { limit: 5 }).items[0]).toMatchObject({ payee: 'ROGERS', bankCategory: 'Utilities', categoryId: null })
  })
})

describe('asking AI again', () => {
  it('replaces a category with AI’s pick to review, and gives payees you always set one way your category', async () => {
    const asked: string[] = []
    const ctx = testContext({
      llm: async (req) => {
        asked.push(req.payee)
        return { category: 'Dine out', confidence: 0.8, slot: 'primary', model: 'm' }
      },
    })
    const acc = makeAccount(ctx)
    const [groceries, dineOut] = [categoryId(ctx, 'Groceries'), categoryId(ctx, 'Dine out')]
    const add = (payee: string, amountMinor: number, date: string, categoryId?: number) =>
      createTransaction(ctx, transactionCreateSchema.parse({ accountId: acc, date, amountMinor, payee, categoryId }), { useAi: false })
    const corner = [await add('CORNER CAFE', -1200, '2026-09-01', groceries), await add('CORNER CAFE', -1200, '2026-09-08', groceries)]
    const already = await add('BEAN BAR', -800, '2026-09-02', dineOut)
    const always = await add('FRESH MARKET', -5000, '2026-09-03', groceries)
    setPayeeChoice(ctx, { payeeKey: always.payeeKey, mode: 'always', categoryId: groceries })
    // Uncategorized, though its payee is always Groceries (it became that payee after the choice).
    const waiting = await add('FRESH MARKET', -3000, '2026-09-04')
    ctx.sqlite.prepare('UPDATE transactions SET category_id = NULL, category_source = NULL, needs_review = 0 WHERE id = ?').run(waiting.id)
    expect((await suggestCategory(ctx, { payee: 'CORNER CAFE', amountMinor: -1200, useAi: false })).categoryId).toBe(groceries)

    let changed: Recategorized[] = []
    expect(recategorize(ctx, [...corner, already, always, waiting].map((t) => t.id), (c) => (changed = c))).toMatchObject({ running: true, total: 2, categorized: 1 })
    expect(() => recategorize(ctx, [already.id])).toThrow('already categorizing')
    await new Promise((r) => setTimeout(r, 20))

    // Once per payee and amount; the payee you always set one way isn't asked about.
    expect(asked.sort()).toEqual(['BEAN BAR', 'CORNER CAFE'])
    for (const t of corner) expect(getTransaction(ctx, t.id)).toMatchObject({ categoryId: dineOut, categorySource: 'ai', needsReview: true })
    expect(getTransaction(ctx, already.id)).toMatchObject({ categoryId: dineOut, categorySource: 'user' })
    expect(getTransaction(ctx, always.id).categoryId).toBe(groceries)
    expect(getTransaction(ctx, waiting.id)).toMatchObject({ categoryId: groceries, needsReview: false })
    expect(changed.map((c) => [c.before, c.after])).toEqual([
      [null, groceries],
      [groceries, dineOut],
      [groceries, dineOut],
    ])
    // What you picked isn't learned any more.
    expect((await suggestCategory(ctx, { payee: 'CORNER CAFE', amountMinor: -1200, useAi: false })).categoryId).toBeNull()
  })

  it('needs an AI provider', () => {
    const ctx = testContext()
    expect(() => recategorize(ctx, [1])).toThrow('Set up an AI provider first')
  })
})
