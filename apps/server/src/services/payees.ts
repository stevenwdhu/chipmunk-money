import type { PayeeChoice, PayeeChoiceUpdate, PayeeRule, PayeeSearchResult } from '@chipmunk/shared'
import { badRequest } from '../lib/http'
import { getCategory } from './categories'
import type { AppContext } from './context'
import { payeeKeyOf, payeeNameOf } from './payee-namer'

/**
 * What you chose for each payee: `always` one category (set without review, now and from then on),
 * or `review` (never set on its own). Payees without a choice get a suggestion to review each time.
 */
export function listPayeeRules(ctx: AppContext): PayeeRule[] {
  const rows = ctx.sqlite
    .prepare(
      `SELECT r.payee_key AS payeeKey, r.mode, r.category_id AS categoryId, r.updated_at AS updatedAt,
         coalesce((SELECT t.payee FROM transactions t WHERE t.payee_key = r.payee_key AND t.deleted_at IS NULL ORDER BY t.date DESC, t.id DESC LIMIT 1), r.payee_key) AS payee,
         (SELECT count(*) FROM transactions t WHERE t.payee_key = r.payee_key AND t.deleted_at IS NULL) AS transactionCount
       FROM payee_rules r ORDER BY r.payee_key`,
    )
    .all() as PayeeRule[]
  // What the payee name rules call it.
  return rows.map((r) => ({ ...r, payee: payeeNameOf(ctx, r.payee).name }))
}

/**
 * The payee's transactions `always` would set: waiting for review or uncategorized, and not a
 * transfer or linked money in (a refund or payback follows what it pays back). An income category
 * only takes money in.
 */
function pendingIds(ctx: AppContext, payeeKey: string, categoryId: number): number[] {
  const { isIncome } = getCategory(ctx, categoryId)
  return ctx.sqlite
    .prepare(
      `SELECT id FROM transactions
       WHERE payee_key = ? AND deleted_at IS NULL AND transfer_pair_id IS NULL AND category_source IS NOT 'linked'
         AND (needs_review = 1 OR category_id IS NULL)${isIncome ? ' AND amount_minor > 0' : ''}`,
    )
    .pluck()
    .all(payeeKey) as number[]
}

export function getPayeeChoice(ctx: AppContext, payeeKey: string, categoryId?: number): PayeeChoice {
  const rule = ctx.sqlite.prepare('SELECT mode, category_id AS categoryId FROM payee_rules WHERE payee_key = ?').get(payeeKey) as
    | { mode: 'always' | 'review'; categoryId: number | null }
    | undefined
  const target = categoryId ?? (rule?.mode === 'always' ? rule.categoryId : null)
  return {
    payeeKey,
    mode: rule?.mode ?? 'ask',
    categoryId: rule?.categoryId ?? null,
    pending: target ? pendingIds(ctx, payeeKey, target).length : 0,
  }
}

/** Saves a choice; `always` also sets the category on the payee's transactions waiting for it. */
export function setPayeeChoice(ctx: AppContext, input: PayeeChoiceUpdate, opts: { dryRun?: boolean } = {}): PayeeChoice & { updated: number } {
  const { mode } = input
  // By its key, or by a payee as sent, as the payee name rules make it.
  const payeeKey = input.payeeKey ?? payeeKeyOf(ctx, input.payee!)
  if (mode !== 'always') {
    if (!opts.dryRun) {
      if (mode === 'ask') ctx.sqlite.prepare('DELETE FROM payee_rules WHERE payee_key = ?').run(payeeKey)
      else saveRule(ctx, payeeKey, 'review', null)
    }
    return { payeeKey, mode, categoryId: null, pending: 0, updated: 0 }
  }
  const category = getCategory(ctx, input.categoryId!)
  if (category.archived) badRequest(`${category.name} is off in this ledger. Turn it on first.`)
  const ids = pendingIds(ctx, payeeKey, category.id)
  if (!opts.dryRun) {
    ctx.sqlite.transaction(() => {
      saveRule(ctx, payeeKey, 'always', category.id)
      setChosen(ctx, ids, category.id)
    })()
  }
  return { payeeKey, mode, categoryId: category.id, pending: ids.length, updated: ids.length }
}

function setChosen(ctx: AppContext, ids: number[], categoryId: number) {
  const set = ctx.sqlite.prepare(
    `UPDATE transactions SET category_id = ?, category_source = 'history', category_confidence = 1, needs_review = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  )
  for (const id of ids) set.run(categoryId, id)
}

/**
 * Payees you always set to one category (these, or all of them): their transactions waiting for review
 * or uncategorized get it, as when the choice was made. For ones that became the payee since (its name
 * changed, a rule or AI tidying named another wording the same). Returns the ones set, with what they had.
 */
export function applyPayeeChoices(ctx: AppContext, payeeKeys?: string[]): Array<{ id: number; before: number | null; after: number }> {
  const rules = ctx.sqlite
    .prepare(
      `SELECT r.payee_key AS payeeKey, r.category_id AS categoryId FROM payee_rules r JOIN categories c ON c.id = r.category_id
       WHERE r.mode = 'always' AND c.archived_at IS NULL ${payeeKeys ? 'AND r.payee_key IN (SELECT value FROM json_each(?))' : ''}`,
    )
    .all(...(payeeKeys ? [JSON.stringify([...new Set(payeeKeys)])] : [])) as Array<{ payeeKey: string; categoryId: number }>
  const before = ctx.sqlite.prepare('SELECT category_id FROM transactions WHERE id = ?').pluck()
  const out: Array<{ id: number; before: number | null; after: number }> = []
  ctx.sqlite.transaction(() => {
    for (const r of rules) {
      const ids = pendingIds(ctx, r.payeeKey, r.categoryId)
      for (const id of ids) out.push({ id, before: before.get(id) as number | null, after: r.categoryId })
      setChosen(ctx, ids, r.categoryId)
    }
  })()
  return out
}

function saveRule(ctx: AppContext, payeeKey: string, mode: 'always' | 'review', categoryId: number | null) {
  ctx.sqlite
    .prepare(
      `INSERT INTO payee_rules (payee_key, mode, category_id) VALUES (?, ?, ?)
       ON CONFLICT (payee_key) DO UPDATE SET mode = excluded.mode, category_id = excluded.category_id,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(payeeKey, mode, categoryId)
}

/**
 * Payees of your transactions (not transfers), most used first, named as the name rules call them:
 * those whose name (or name as sent) has `q` in it, or just these `keys`.
 */
export function searchPayees(ctx: AppContext, q: { q?: string; keys?: string[]; limit: number }): PayeeSearchResult[] {
  const rows = ctx.sqlite
    .prepare(
      `SELECT t.payee_key AS payeeKey, count(*) AS count, max(t.date) AS lastDate,
         (SELECT p.payee FROM transactions p WHERE p.payee_key = t.payee_key AND p.deleted_at IS NULL ORDER BY p.date DESC, p.id DESC LIMIT 1) AS payee
       FROM transactions t WHERE t.deleted_at IS NULL AND t.transfer_pair_id IS NULL${q.keys ? ' AND t.payee_key IN (SELECT value FROM json_each(?))' : ''}
       GROUP BY t.payee_key ORDER BY count DESC, lastDate DESC, t.payee_key`,
    )
    .all(...(q.keys ? [JSON.stringify(q.keys)] : [])) as PayeeSearchResult[]
  const words = q.q?.toLowerCase()
  const out: PayeeSearchResult[] = []
  for (const r of rows) {
    const named = { ...r, payee: payeeNameOf(ctx, r.payee).name }
    if (words && ![named.payee, r.payee, r.payeeKey].some((s) => s.toLowerCase().includes(words))) continue
    out.push(named)
    if (out.length === q.limit) break
  }
  return out
}
