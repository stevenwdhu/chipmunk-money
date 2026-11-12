import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { transactionCreateSchema } from '@chipmunk/shared'
import type { LlmCategorizer } from '../ai/types'
import { categoryId, makeAccount } from '../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER } from '../test/shared-accounts'
import { ledgerRows } from '../test/world'
import { joinSharedList, leaveSharedList } from './catalog'
import { deleteCatalogCategory, deleteCatalogGroup, mergeCatalogCategory, updateCatalogCategory } from './catalog-edit'
import { historySuggestion } from './categorize'
import { deleteCategory, deleteGroup, getCategory, mergeCategory, moveCategoryUsage, setCategoryEnabled, updateCategory } from './categories'
import type { AppContext } from './context'
import { aiJobStatus, categorizeUncategorized, recategorize, type Recategorized } from './import'
import { moveTransactions } from './moves'
import { setPayeeChoice } from './payees'
import { periodSummary } from './reports'
import { setSplit, undoSplit } from './splits'
import { createTransaction, getTransaction } from './transactions'

/**
 * A split payment's split rows stay in a category left out of totals, whatever happens to that
 * category, and AI never files them. The worked example: on Visa, Personal (its home) and Family
 * each spent $200 in September, and Personal's $100 payment from chequing is split, $80 to Family.
 * So neither ledger has any income in September, and each spent $200. A share that lost its
 * category would be $80 of income in Family, and the given row $80 more spending in Personal.
 */

const CARD = 'Credit card payment'
const USED = 'Split payments use Credit card payment. Undo those splits first.'

/** An HTTP error with this status and message. */
function refused(fn: () => unknown, status: number, message: string) {
  let error: unknown
  try {
    fn()
  } catch (err) {
    error = err
  }
  expect(error, 'refused').toBeInstanceOf(HTTPException)
  expect({ status: (error as HTTPException).status, message: (error as HTTPException).message }).toEqual({ status, message })
}

/** The worked example. `own`: each ledger has its own category list, not the shared one. */
async function world(opts: { own?: boolean; llm?: LlmCategorizer } = {}) {
  const w = sharedWorld({ llm: opts.llm })
  const { personal, family } = w
  if (opts.own) for (const c of [personal, family]) leaveSharedList(c)
  const spend = (ctx: AppContext, date: string) =>
    Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, category_source)
         VALUES (@ledger, @account, @date, -20000, 'Shop', 'shop', @category, 'user')`,
        { account: w.visa, date, category: categoryId(ctx, 'Groceries') },
      ).lastInsertRowid,
    )
  spend(personal, '2026-09-10')
  moveTransactions(personal, w.ctxOf, { ids: [spend(personal, '2026-09-11')], to: family.ledger.id }, TESTER)
  const chequing = makeAccount(personal, 'Chequing')
  const out = await createTransaction(
    personal,
    transactionCreateSchema.parse({ accountId: chequing, date: '2026-09-20', amountMinor: -10_000, payee: 'Visa payment', transferAccountId: w.visa }),
    { useAi: false },
  )
  const paid = out.transferPairId!
  setSplit(personal, w.ctxOf, paid, { shares: [{ ledger: 'family', amountMinor: 8_000 }] }, { actor: TESTER, usable: null })
  const splitRow = (ctx: AppContext) => ctx.q.pluck<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND split_of = ?', paid)!
  const [given, share] = [splitRow(personal), splitRow(family)]
  /** The category of each ledger's split row, by name. */
  const filed = () =>
    [personal, family].map(
      (c) =>
        c.q.pluck<string | null>(
          `SELECT (SELECT c.name FROM ledger_categories c WHERE c.id = t.category_id AND c.ledger_id = t.ledger_id) FROM transactions t
           WHERE t.ledger_id = @ledger AND t.split_of = ?`,
          paid,
        ) ?? null,
    )
  /** September in the holder and in the member: what each spent and got. */
  const september = () =>
    [personal, family].map((c) => {
      const s = periodSummary(c, '2026-09-01', '2026-09-30')
      return { spent: s.spentMinor, income: s.incomeMinor }
    })
  /**
   * What every change to a category must leave: each ledger spent $200 in September and got
   * nothing, each split row is in a category left out of totals, and the parts are as they were.
   */
  const check = (categories: Array<string | null>) => {
    expect(filed()).toEqual(categories)
    expect(september()).toEqual([
      { spent: 20_000, income: 0 },
      { spent: 20_000, income: 0 },
    ])
    for (const [c, id] of [
      [personal, given],
      [family, share],
    ] as const) {
      const category = getTransaction(c, id).categoryId
      expect(category === null ? null : getCategory(c, category).excludeFromTotals, 'left out of totals').toBe(true)
    }
    // Personal −200 + 100 − 80. Family −200 + 80.
    expect(expectPartsSumToAccount(w.storage, w.visa).parts).toEqual({ personal: -18_000, family: -12_000 })
    expectNoCrossLedgerReferences(w.storage)
  }
  const everything = () => [personal, family].map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
  const id = (ctx: AppContext, name: string) => categoryId(ctx, name)
  check([CARD, CARD])
  return { ...w, paid, given, share, filed, september, check, everything, id }
}

describe('a category that split rows use, in a ledger with its own list', () => {
  it('turned off with its transactions left uncategorized: the split rows go to the other category for card payments', async () => {
    const w = await world({ own: true })
    for (const c of [w.personal, w.family]) expect(setCategoryEnabled(c, w.id(c, CARD), { enabled: false, moveTo: null })).toMatchObject({ category: { archived: true } })
    w.check(['Transfer', 'Transfer'])
    // The payment itself is an ordinary row of that category: uncategorized, and still a transfer.
    expect(getTransaction(w.personal, w.paid)).toMatchObject({ categoryId: null, split: { part: 'payment', keptMinor: 2_000 } })

    // With no category left out of totals to go to, it's refused, and nothing changes.
    for (const c of [w.personal, w.family]) setCategoryEnabled(c, w.id(c, 'Savings & investments'), { enabled: false, moveTo: null })
    const before = w.everything()
    for (const c of [w.personal, w.family]) {
      refused(() => setCategoryEnabled(c, w.id(c, 'Transfer'), { enabled: false, moveTo: null }), 409, 'Split payments use Transfer. Undo those splits first.')
      refused(() => setCategoryEnabled(c, w.id(c, 'Transfer'), { enabled: false, moveTo: w.id(c, 'Groceries') }), 409, 'Split payments use Transfer. Undo those splits first.')
    }
    expect(w.everything()).toEqual(before)
    w.check(['Transfer', 'Transfer'])
  })

  it('turned off with its transactions moved to a category that counts: the split rows don’t follow', async () => {
    const w = await world({ own: true })
    for (const c of [w.personal, w.family]) setCategoryEnabled(c, w.id(c, CARD), { enabled: false, moveTo: w.id(c, 'Groceries') })
    w.check(['Transfer', 'Transfer'])
    // To one left out of totals, they go with the rest.
    for (const c of [w.personal, w.family]) setCategoryEnabled(c, w.id(c, 'Transfer'), { enabled: false, moveTo: w.id(c, 'Savings & investments') })
    w.check(['Savings & investments', 'Savings & investments'])
  })

  it('its transactions moved to a category that counts (moveCategoryUsage): the split rows don’t follow', async () => {
    const w = await world({ own: true })
    for (const c of [w.personal, w.family]) moveCategoryUsage(c, w.id(c, CARD), w.id(c, 'Groceries'))
    w.check(['Transfer', 'Transfer'])
  })

  it('merged into a category that counts: the split rows go to the other category for card payments', async () => {
    const w = await world({ own: true })
    for (const c of [w.personal, w.family]) mergeCategory(c, w.id(c, CARD), w.id(c, 'Groceries'))
    w.check(['Transfer', 'Transfer'])
    // Merged into one left out of totals, they go with the rest.
    for (const c of [w.personal, w.family]) mergeCategory(c, w.id(c, 'Transfer'), w.id(c, 'Savings & investments'))
    w.check(['Savings & investments', 'Savings & investments'])
    // And the last one can't be merged into one that counts.
    const before = w.everything()
    for (const c of [w.personal, w.family]) {
      refused(() => mergeCategory(c, w.id(c, 'Savings & investments'), w.id(c, 'Groceries')), 409, 'Split payments use Savings & investments. Undo those splits first.')
    }
    expect(w.everything()).toEqual(before)
  })

  it('deleted: the split rows go to the other category for card payments, and the last one can’t go', async () => {
    const w = await world({ own: true })
    for (const c of [w.personal, w.family]) deleteCategory(c, w.id(c, CARD))
    w.check(['Transfer', 'Transfer'])
    for (const c of [w.personal, w.family]) deleteCategory(c, w.id(c, 'Savings & investments'))
    const before = w.everything()
    for (const c of [w.personal, w.family]) refused(() => deleteCategory(c, w.id(c, 'Transfer')), 409, 'Split payments use Transfer. Undo those splits first.')
    expect(w.everything()).toEqual(before)
    w.check(['Transfer', 'Transfer'])
  })

  it('deleted with its group: refused while the group has every category left out of totals, and otherwise they go to the one outside it', async () => {
    const w = await world({ own: true })
    const group = (c: AppContext) => getCategory(c, w.id(c, CARD)).groupId!
    const before = w.everything()
    for (const c of [w.personal, w.family]) refused(() => deleteGroup(c, group(c)), 409, USED)
    expect(w.everything()).toEqual(before)

    for (const c of [w.personal, w.family]) {
      updateCategory(c, w.id(c, 'Savings & investments'), { groupId: null })
      expect(deleteGroup(c, group(c)).map((x) => x.name)).toEqual(['Transfer', CARD])
    }
    w.check(['Savings & investments', 'Savings & investments'])
  })

  it('made to count in totals: refused until the split is undone', async () => {
    const w = await world({ own: true })
    const before = w.everything()
    for (const c of [w.personal, w.family]) refused(() => updateCategory(c, w.id(c, CARD), { excludeFromTotals: false }), 409, USED)
    expect(w.everything()).toEqual(before)
    w.check([CARD, CARD])
    // Anything else of it may change.
    for (const c of [w.personal, w.family]) expect(updateCategory(c, w.id(c, CARD), { name: 'Card payments', excludeFromTotals: true }).name).toBe('Card payments')
    w.check(['Card payments', 'Card payments'])

    undoSplit(w.personal, w.ctxOf, w.paid, TESTER)
    for (const c of [w.personal, w.family]) expect(updateCategory(c, w.id(c, 'Card payments'), { excludeFromTotals: false }).excludeFromTotals).toBe(false)
  })

  it('gone or counted when the ledger joins the shared list: refused', async () => {
    const w = await world({ own: true })
    const before = w.everything()
    const shared = (name: string) => w.storage.allLedgers('the shared category list', (db) => db.pluck<number>('SELECT id FROM categories WHERE ledger_id IS NULL AND name = ?', name)!)
    for (const c of [w.personal, w.family]) {
      refused(() => joinSharedList(w.storage, c, new Map([[w.id(c, CARD), null]])), 409, USED)
      refused(() => joinSharedList(w.storage, c, new Map([[w.id(c, CARD), shared('Groceries')]])), 409, USED)
    }
    expect(w.everything()).toEqual(before)
    // Matched by name, or sent to another one left out of totals, it joins.
    joinSharedList(w.storage, w.personal)
    joinSharedList(w.storage, w.family, new Map([[w.id(w.family, CARD), shared('Transfer')]]))
    w.check([CARD, 'Transfer'])
  })
})

describe('a category that split rows use, on the shared list', () => {
  it('turned off in one ledger: its split rows go to the other category for card payments', async () => {
    const w = await world()
    setCategoryEnabled(w.family, w.id(w.family, CARD), { enabled: false, moveTo: null })
    w.check([CARD, 'Transfer'])
    setCategoryEnabled(w.personal, w.id(w.personal, CARD), { enabled: false, moveTo: w.id(w.personal, 'Groceries') })
    w.check(['Transfer', 'Transfer'])
  })

  it('merged into a category that counts: the split rows go to the other category for card payments, in every ledger', async () => {
    const w = await world()
    mergeCatalogCategory(w.storage, w.id(w.personal, CARD), w.id(w.personal, 'Groceries'))
    w.check(['Transfer', 'Transfer'])
    // A ledger with no other one left: refused for every ledger, and nothing changes.
    setCategoryEnabled(w.family, w.id(w.family, 'Savings & investments'), { enabled: false, moveTo: null })
    const before = w.everything()
    refused(() => mergeCatalogCategory(w.storage, w.id(w.personal, 'Transfer'), w.id(w.personal, 'Groceries')), 409, 'Split payments use Transfer. Undo those splits first.')
    expect(w.everything()).toEqual(before)
    w.check(['Transfer', 'Transfer'])
  })

  it('deleted: the split rows go to the other category for card payments, in every ledger', async () => {
    const w = await world()
    deleteCatalogCategory(w.storage, w.id(w.personal, CARD))
    w.check(['Transfer', 'Transfer'])
  })

  it('deleted with its group: refused while the group has every category left out of totals, and otherwise they go to the one outside it', async () => {
    const w = await world()
    const group = getCategory(w.personal, w.id(w.personal, CARD)).groupId!
    const before = w.everything()
    refused(() => deleteCatalogGroup(w.storage, group), 409, USED)
    expect(w.everything()).toEqual(before)
    updateCatalogCategory(w.storage, w.id(w.personal, 'Savings & investments'), { groupId: null })
    deleteCatalogGroup(w.storage, group)
    w.check(['Savings & investments', 'Savings & investments'])
  })

  it('made to count in totals: refused until the split is undone', async () => {
    const w = await world()
    const card = w.id(w.personal, CARD)
    const before = w.everything()
    refused(() => updateCatalogCategory(w.storage, card, { excludeFromTotals: false }), 409, USED)
    expect(w.everything()).toEqual(before)
    w.check([CARD, CARD])
    undoSplit(w.personal, w.ctxOf, w.paid, TESTER)
    expect(updateCatalogCategory(w.storage, card, { excludeFromTotals: false }).excludeFromTotals).toBe(false)
  })
})

describe('AI and a split payment’s split rows', () => {
  /** A fake LLM that answers Groceries, and says what it was asked about. */
  const groceries = (asked: string[]): LlmCategorizer => async (req) => {
    asked.push(req.payee)
    return { category: 'Groceries', confidence: 0.9, slot: 'primary', model: 'm' }
  }
  const settled = async (ctx: AppContext) => {
    for (let i = 0; i < 50 && aiJobStatus(ctx).running; i++) await new Promise((r) => setTimeout(r, 5))
  }

  it('asked again about a share and a given row: neither is asked about, both keep their category, and nothing is learned', async () => {
    const asked: string[] = []
    const w = await world({ llm: groceries(asked) })
    const { personal, family } = w
    const before = w.everything()
    const changed: Recategorized[] = []
    for (const [c, id] of [
      [family, w.share],
      [personal, w.given],
    ] as const) {
      expect(recategorize(c, [id], (list) => changed.push(...list))).toMatchObject({ total: 0 })
      await settled(c)
    }
    expect(asked).toEqual([])
    expect(changed).toEqual([])
    expect(w.everything()).toEqual(before)
    w.check([CARD, CARD])
    for (const [c, id] of [
      [family, w.share],
      [personal, w.given],
    ] as const) {
      const t = getTransaction(c, id)
      expect(t).toMatchObject({ categoryId: w.id(c, CARD), categorySource: 'user', needsReview: false })
      expect(historySuggestion(c, t.payee, t.amountMinor)).toBeNull()
    }

    // An ordinary row beside them is still asked about.
    const shop = family.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND payee = 'Shop'")!
    family.q.run('UPDATE transactions SET category_id = ? WHERE ledger_id = @ledger AND id = ?', w.id(family, 'Fuel'), shop)
    recategorize(family, [shop, w.share])
    await settled(family)
    expect(asked).toEqual(['Shop'])
    expect(getTransaction(family, shop)).toMatchObject({ categoryId: w.id(family, 'Groceries'), categorySource: 'ai' })
    expect(getTransaction(family, w.share).categoryId).toBe(w.id(family, CARD))
  })

  it('never files a split row that has no category, nor does a payee always set one way', async () => {
    const asked: string[] = []
    const w = await world({ llm: groceries(asked) })
    const { personal, family } = w
    // As a database from before this was guarded might have them.
    for (const c of [personal, family]) c.q.run('UPDATE transactions SET category_id = NULL, category_source = NULL WHERE ledger_id = @ledger AND split_of IS NOT NULL')
    for (const c of [personal, family]) {
      await categorizeUncategorized(c)
      await categorizeUncategorized(c, { ids: [w.share, w.given] })
    }
    expect(asked).toEqual([])
    expect(w.filed()).toEqual([null, null])

    const given = getTransaction(personal, w.given)
    expect(setPayeeChoice(personal, { payeeKey: given.payeeKey, mode: 'always', categoryId: w.id(personal, 'Groceries') })).toMatchObject({ pending: 0, updated: 0 })
    expect(w.filed()).toEqual([null, null])
  })
})
