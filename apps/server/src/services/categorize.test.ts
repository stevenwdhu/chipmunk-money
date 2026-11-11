import { describe, expect, it } from 'vitest'
import type { LlmCategoryRequest } from '../ai/types'
import { categoryId, countRows, twinAccounts, twinLedgers } from '../test/transaction-twins'
import { historySuggestion, learn, payeeRule, suggestCategory } from './categorize'

describe('categorizing in two ledgers', () => {
  it('learns from and suggests by its own ledger’s history', () => {
    const { a, b } = twinLedgers()
    const [groceries, dineOut] = [categoryId(a, 'Groceries'), categoryId(a, 'Dine out')]
    learn(a, 'loblaws', -5_000, groceries)
    learn(a, 'loblaws', -5_000, groceries)
    learn(b, 'loblaws', -5_000, dineOut)

    expect(historySuggestion(a, 'Loblaws', -1_000)).toMatchObject({ categoryId: groceries, reason: expect.stringContaining('2 times') })
    expect(historySuggestion(b, 'Loblaws', -1_000)).toMatchObject({ categoryId: dineOut, reason: expect.stringContaining('1 time') })
    // Fuzzy matches too: nothing like it in a ledger that never learned it.
    learn(a, 'corner cafe', -1_000, dineOut)
    expect(historySuggestion(a, 'Corner Cafe 2', -1_000)).toMatchObject({ categoryId: dineOut, source: 'fuzzy' })
    expect(historySuggestion(b, 'Corner Cafe 2', -1_000)).toBeNull()

    // Unlearning in one ledger leaves the other's count.
    learn(b, 'loblaws', -5_000, dineOut, -1)
    expect(historySuggestion(b, 'Loblaws', -1_000)).toBeNull()
    expect(historySuggestion(a, 'Loblaws', -1_000)?.categoryId).toBe(groceries)
    expect(countRows(a, 'payee_category_stats')).toBe(2)
    expect(countRows(b, 'payee_category_stats')).toBe(1)
  })

  it('breaks a tie between similar payees by what it learned first', () => {
    const { a } = twinLedgers()
    const [groceries, dineOut] = [categoryId(a, 'Groceries'), categoryId(a, 'Dine out')]
    expect(groceries).toBeLessThan(dineOut)
    for (let i = 0; i < 3; i++) learn(a, 'corner cafe downtown', -500, dineOut)
    for (let i = 0; i < 3; i++) learn(a, 'corner cafe downtown', -500, groceries)
    expect(historySuggestion(a, 'Corner Cafe', -500)).toMatchObject({ categoryId: dineOut, source: 'fuzzy' })
  })

  it('reads its own payee choices, and offers AI the categories it uses', async () => {
    const asked: LlmCategoryRequest[] = []
    const { a, b } = twinLedgers()
    const groceries = categoryId(a, 'Groceries')
    a.q.run("INSERT INTO payee_rules (ledger_id, payee_key, mode, category_id) VALUES (@ledger, 'fresh market', 'always', ?)", groceries)
    expect(payeeRule(a, 'fresh market')).toEqual({ mode: 'always', categoryId: groceries })
    expect(payeeRule(b, 'fresh market')).toBeNull()
    expect(historySuggestion(a, 'Fresh Market', -1_000)).toMatchObject({ categoryId: groceries, autoApply: true })
    expect(historySuggestion(b, 'Fresh Market', -1_000)).toBeNull()

    // Fuel is off in B: AI isn't offered it there, and its answer of Fuel isn't taken.
    b.q.run("INSERT INTO ledger_category_off (ledger_id, category_id, archived_at) VALUES (@ledger, ?, '2026-01-01')", categoryId(b, 'Fuel'))
    for (const ctx of [a, b]) {
      ctx.llm = async (req) => {
        asked.push(req)
        return { category: 'Fuel', confidence: 0.9, slot: 'primary', model: 'm' }
      }
    }
    const [accA, accB] = [twinAccounts(a), twinAccounts(b)]
    const inA = await suggestCategory(a, { payee: 'Shell', amountMinor: -4_000, accountId: accA.card })
    const inB = await suggestCategory(b, { payee: 'Shell', amountMinor: -4_000, accountId: accB.card })
    expect(inA).toMatchObject({ categoryId: categoryId(a, 'Fuel'), source: 'ai' })
    expect(inB.categoryId).toBeNull()
    expect(asked[0]!.categories.some((c) => c.name === 'Fuel')).toBe(true)
    expect(asked[1]!.categories.some((c) => c.name === 'Fuel')).toBe(false)
    expect(asked.map((r) => r.accountType)).toEqual(['credit', 'credit'])
    // The other ledger's account isn't one to describe.
    await suggestCategory(a, { payee: 'Shell', amountMinor: -4_000, accountId: accB.card })
    expect(asked[2]!.accountType).toBeNull()
  })
})
