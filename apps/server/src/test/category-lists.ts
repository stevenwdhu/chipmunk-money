import type { AppContext } from '../services/context'
import { makeAccount } from './helpers'

/**
 * Rows that point at categories, written with plain SQL through the ledger handle, for the
 * category list tests: so they test the list, not the services that usually write these rows.
 */

/** A transaction in a category, marked as a rule set it and to be reviewed. */
export function spendIn(ctx: AppContext, categoryId: number | null, payee = 'Shop', opts: { deleted?: boolean } = {}): number {
  const account = ctx.q.pluck<number>("SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND name = 'Test card'") ?? makeAccount(ctx, 'Test card', 'credit')
  return Number(
    ctx.q.run(
      `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, category_source, category_confidence, needs_review, deleted_at)
       VALUES (@ledger, @account, '2026-09-01', -1000, @payee, lower(@payee), @categoryId, 'rule', 0.9, 1, @deleted)`,
      { account, payee, categoryId, deleted: opts.deleted ? '2026-09-02T00:00:00.000Z' : null },
    ).lastInsertRowid,
  )
}

/** A transaction's category columns. */
export function categoryOf(ctx: AppContext, id: number) {
  return ctx.q.get<{ categoryId: number | null; source: string | null; confidence: number | null; needsReview: number }>(
    `SELECT category_id AS categoryId, category_source AS source, category_confidence AS confidence, needs_review AS needsReview
     FROM transactions WHERE ledger_id = @ledger AND id = @id`,
    { id },
  )!
}

/** A recurring payment, a payee rule and what was learned about a payee, all in one category. */
export function learnIn(ctx: AppContext, categoryId: number, payee = 'shop') {
  const item = Number(
    ctx.q.run(
      `INSERT INTO recurring_items (ledger_id, name, payee_key, category_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
       VALUES (@ledger, @payee, @payee, @categoryId, -1000, 'monthly', '2026-01-01', '2026-11-01', 'active', 'manual')`,
      { payee, categoryId },
    ).lastInsertRowid,
  )
  ctx.q.run("INSERT INTO payee_rules (ledger_id, payee_key, mode, category_id) VALUES (@ledger, @payee, 'always', @categoryId)", { payee, categoryId })
  ctx.q.run("INSERT INTO payee_category_stats (ledger_id, payee_key, direction, category_id, count) VALUES (@ledger, @payee, 'out', @categoryId, 2)", {
    payee,
    categoryId,
  })
  return item
}

/** Where a ledger's recurring payment, payee rule and payee stats for a payee point. */
export function learnedOf(ctx: AppContext, payee = 'shop') {
  return {
    recurring: ctx.q.column<number | null>('SELECT category_id FROM recurring_items WHERE ledger_id = @ledger AND payee_key = @payee', { payee }),
    rule: ctx.q.column<number | null>('SELECT category_id FROM payee_rules WHERE ledger_id = @ledger AND payee_key = @payee', { payee }),
    stats: ctx.q.all<{ categoryId: number; count: number }>(
      'SELECT category_id AS categoryId, count FROM payee_category_stats WHERE ledger_id = @ledger AND payee_key = @payee ORDER BY category_id',
      { payee },
    ),
  }
}
