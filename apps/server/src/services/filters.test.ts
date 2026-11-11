import { describe, expect, it } from 'vitest'
import { filterSchema, type Condition, type ReportFilterInput } from '@chipmunk/shared'
import { checkPinned } from '../db/scope'
import { addTx, categoryId, twinAccounts, twinLedgers } from '../test/transaction-twins'
import type { AppContext } from './context'
import { compileFilter, listScope, reportScope } from './filters'
import { setLinks } from './links'
import { listTransactions } from './transactions'

/** One of every condition, for a ledger's ids. */
function everyCondition(ctx: AppContext, ids: { account: number; tag: number; purchase: number }): Condition[] {
  const groceries = categoryId(ctx, 'Groceries')
  const group = ctx.q.pluck<number>('SELECT group_id FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', groceries)!
  const label = ctx.q.pluck<number>('SELECT id FROM ledger_labels WHERE ledger_id = @ledger ORDER BY id LIMIT 1')
  return [
    { field: 'category', ids: [groceries, 'none'] },
    { field: 'group', ids: [group, 'none'] },
    { field: 'label', ids: label === undefined ? ['none'] : [label, 'none'] },
    { field: 'tag', ids: [ids.tag] },
    { field: 'payee', keys: ['loblaws'] },
    { field: 'text', words: ['lob'] },
    { field: 'text', words: ['lob'], in: ['payee', 'name', 'notes'] },
    { field: 'amount', min: 1, max: 1_000_000 },
    { field: 'account', ids: [ids.account] },
    { field: 'recurring', ids: 'any' },
    { field: 'recurring', ids: 'none' },
    { field: 'recurring', ids: [1] },
  ]
}

function filters(ctx: AppContext, ids: { account: number; tag: number; purchase: number }): ReportFilterInput[] {
  const all = everyCondition(ctx, ids)
  const side = (c: Condition) => ({ only: [], filterOut: [{ when: [c] }], picked: [ids.purchase], keep: [ids.purchase] })
  return [
    ...all.map((c) => ({ spending: side(c), income: side(c) })),
    ...all.filter((c) => c.field !== 'text' && c.field !== 'recurring').map((c) => ({ spending: { only: [c] }, income: { only: [c] } })),
  ]
}

/** A Loblaws purchase with a tag, and its refund, in a ledger. */
function world(ctx: AppContext) {
  const acc = twinAccounts(ctx)
  const purchase = addTx(ctx, acc.card, '2026-09-01', -8_000, 'Loblaws', { categoryId: categoryId(ctx, 'Groceries') })
  const refund = addTx(ctx, acc.card, '2026-09-05', 2_000, 'Loblaws')
  addTx(ctx, acc.chequing, '2026-09-02', 300_000, 'Acme payroll', { categoryId: categoryId(ctx, 'Salary') })
  setLinks(ctx, refund, [{ kind: 'refund', transactionId: purchase, amountMinor: 2_000 }])
  const tag = Number(ctx.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'trip')").lastInsertRowid)
  ctx.q.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', purchase, tag)
  return { account: acc.card, tag, purchase, refund }
}

describe('report filters as SQL', () => {
  it('pins every fragment to the ledger', () => {
    const { a } = twinLedgers()
    const ids = world(a)
    for (const input of filters(a, ids)) {
      const f = filterSchema.parse(input)
      const report = reportScope(f)
      const sql = `SELECT t.id FROM transaction_lines t${report.join}
        LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
        WHERE t.ledger_id = @ledger${report.where}`
      expect(() => checkPinned(sql), JSON.stringify(input)).not.toThrow()
      expect(() => a.q.all(sql, report.params)).not.toThrow()
      for (const opts of [{}, { filteredOut: true }, { side: 'spending' as const }]) {
        const scope = listScope(f, opts)!
        expect(() => checkPinned(`SELECT t.id FROM transactions t WHERE t.ledger_id = @ledger AND ${scope.sql}`)).not.toThrow()
      }
      expect(compileFilter(f)!.join).toContain('o.ledger_id = t.ledger_id')
    }
  })

  it('lists only the ledger’s own transactions for a filter, though the other’s look the same', () => {
    const { a, b } = twinLedgers()
    const [idsA, idsB] = [world(a), world(b)]
    for (const [ctx, ids, other] of [[a, idsA, idsB], [b, idsB, idsA]] as const) {
      const mine = new Set(listTransactions(ctx, { limit: 50 }).items.map((t) => t.id))
      expect(mine.has(other.purchase)).toBe(false)
      for (const input of filters(ctx, ids)) {
        const filter = filterSchema.parse(input)
        for (const opts of [{}, { filteredOut: true }, { side: 'spending' as const }, { side: 'income' as const }]) {
          for (const t of listTransactions(ctx, { limit: 50, filter, ...opts }).items) expect(mine.has(t.id), JSON.stringify({ input, opts })).toBe(true)
        }
      }
      // Only Loblaws: the purchase (and its refund, judged by it), not the other ledger's.
      const loblaws = filterSchema.parse({ spending: { only: [{ field: 'payee', keys: ['loblaws'] }] } })
      expect(listTransactions(ctx, { limit: 50, filter: loblaws, side: 'spending' }).items.map((t) => t.id).sort()).toEqual([ids.purchase, ids.refund].sort())
      // Filtered out by the other ledger's tag id: nothing here has it.
      const theirTag = filterSchema.parse({ spending: { filterOut: [{ when: [{ field: 'tag', ids: [other.tag] }] }] } })
      expect(listTransactions(ctx, { limit: 50, filter: theirTag, filteredOut: true }).items).toEqual([])
    }
  })
})
