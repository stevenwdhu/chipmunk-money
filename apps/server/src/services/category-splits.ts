import { formatMoney, type TransactionPart } from '@chipmunk/shared'
import { HTTPException } from 'hono/http-exception'
import { badRequest, notFound } from '../lib/http'
import { learn } from './categorize'
import type { AppContext } from './context'

/**
 * A transaction split into categories: its parts (`transaction_parts`), each with a category or
 * none, an amount and a note, adding up to its amount. It stays one transaction everywhere but in
 * reports, which count each part in its own category (the transaction_lines view).
 *
 * Not the split of a card payment between ledgers (splits.ts, `transactions.split_of`): that one
 * makes rows in other ledgers, this one makes none.
 *
 * While it's split, the transaction's own category is its largest part's (the first of them on a
 * tie), as yours, so what doesn't know about parts sees a categorized transaction. Nothing else sets
 * it: AI, history, payee rules, matching and recurring items leave a split transaction alone
 * (noParts), and nothing learns a payee's category from one. Setting one category undoes the split
 * (updateTransaction). No two parts are in the same category: ones that end up so become one, and a
 * split left with one part is undone (savePartsOf, settleParts). When the amount changes, the
 * largest part takes the difference, or the split is undone (the parts_follow_amount trigger).
 */

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

/** A transaction (by its alias, or `transactions`) that isn't split into categories. */
export const noParts = (alias: string) => `NOT EXISTS (SELECT 1 FROM transaction_parts sp WHERE sp.transaction_id = ${alias}.id)`

/** The parts of each of these transactions that's split into categories, in order, by transaction id. */
export function partsFor(ctx: AppContext, ids: number[]): Map<number, TransactionPart[]> {
  const out = new Map<number, TransactionPart[]>()
  if (!ids.length) return out
  const rows = ctx.q.all<TransactionPart & { txId: number }>(
    `SELECT p.transaction_id AS txId, p.category_id AS categoryId, p.amount_minor AS amountMinor, p.note
     FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.ledger_id = @ledger AND p.transaction_id IN (SELECT value FROM json_each(?))
     ORDER BY p.transaction_id, p.sort`,
    JSON.stringify(ids),
  )
  for (const { txId, ...part } of rows) out.set(txId, [...(out.get(txId) ?? []), part])
  return out
}

export const isSplitIntoCategories = (ctx: AppContext, id: number) => partsFor(ctx, [id]).has(id)

/** Parts in the same category (or both in none) as one: the first's place and note, or the other's note when it has none. */
function merged(parts: TransactionPart[]): TransactionPart[] {
  const out: TransactionPart[] = []
  for (const p of parts) {
    const twin = out.find((o) => o.categoryId === p.categoryId)
    if (twin) Object.assign(twin, { amountMinor: twin.amountMinor + p.amountMinor, note: twin.note ?? p.note })
    else out.push({ ...p })
  }
  return out
}

/** The largest part, the first of them on a tie. */
const largest = (parts: TransactionPart[]) => parts.reduce((a, b) => (Math.abs(b.amountMinor) > Math.abs(a.amountMinor) ? b : a))

/**
 * Checks a split of a transaction into `input`, for its amount now or the one it's about to have,
 * and returns the parts to save. 400 or 409, in plain words, for what can't be split (a transfer, a
 * card payment, money in that has the category of what it pays back, a row of a split between
 * ledgers) and for parts that don't hold: fewer than two categories, one that's zero or of the other
 * sign, a sum that isn't the amount, a category the ledger doesn't use, an income category for money
 * out. 404 for a deleted transaction. An empty list (undo) is always fine.
 */
export function checkParts(ctx: AppContext, id: number, input: Array<{ categoryId: number | null; amountMinor: number; note?: string | null }>, amountMinor?: number): TransactionPart[] {
  const t = ctx.q.get<{ amount: number; currency: string; pairId: number | null; source: string | null; betweenLedgers: number; cardPayment: number }>(
    `SELECT t.amount_minor AS amount, t.currency, t.transfer_pair_id AS pairId, t.category_source AS source,
       (t.split_of IS NOT NULL OR EXISTS (SELECT 1 FROM transactions g WHERE g.ledger_id = t.ledger_id AND g.split_of = t.id)) AS betweenLedgers,
       (a.type = 'credit' AND t.amount_minor > 0 AND coalesce(c.exclude_from_totals, 0) = 1) AS cardPayment
     FROM transactions t JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
       LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.id = ? AND t.deleted_at IS NULL AND t.bank_id_only = 0`,
    id,
  )
  if (!t) notFound('Transaction not found')
  if (!input.length) return []
  if (t.betweenLedgers) throw new HTTPException(409, { message: 'It’s part of a payment split between ledgers, so it can’t be split into categories.' })
  if (t.pairId) badRequest('A transfer can’t be split into categories. Say it’s not a transfer first.')
  if (t.cardPayment) badRequest('A card payment can’t be split into categories.')
  if (t.source === 'linked') badRequest('It has the category of what it pays back. Unlink it to split it into categories.')

  const amount = amountMinor ?? t.amount
  const parts = merged(input.map((p) => ({ categoryId: p.categoryId, amountMinor: p.amountMinor, note: p.note?.trim() || null })))
  for (const p of parts) {
    if (p.categoryId === null) continue
    const c = ctx.q.get<{ name: string; isIncome: number }>('SELECT name, is_income AS isIncome FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', p.categoryId)
    if (!c) badRequest('One of the parts is in a category that doesn’t exist.')
    if (c.isIncome && amount < 0) badRequest(`${c.name} is an income category, so it can’t take part of money out.`)
  }
  if (input.some((p) => !p.amountMinor || p.amountMinor > 0 !== amount > 0)) {
    badRequest(`Each part is money ${amount > 0 ? 'in' : 'out'}, like the transaction, and not zero.`)
  }
  const sum = input.reduce((n, p) => n + p.amountMinor, 0)
  if (sum !== amount) badRequest(`The parts add up to ${formatMoney(sum, t.currency)}, not ${formatMoney(amount, t.currency)}.`)
  if (parts.length < 2) badRequest('Split it into at least two categories. For one category, set it on the transaction.')
  return parts
}

/**
 * Saves a transaction's parts as they are (checked, or carried from what it had), and its own
 * category with them: its largest part's, as yours. Parts in the same category become one. With
 * fewer than two the split is undone, and one part left gives the transaction its category.
 */
function savePartsOf(ctx: AppContext, id: number, given: TransactionPart[]) {
  const parts = merged(given)
  ctx.q.run('DELETE FROM transaction_parts WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?)', id)
  if (!parts.length) return
  if (parts.length > 1) {
    parts.forEach((p, sort) =>
      ctx.q.run('INSERT INTO transaction_parts (transaction_id, sort, category_id, amount_minor, note) VALUES (?, ?, ?, ?, ?)', id, sort, p.categoryId, p.amountMinor, p.note),
    )
  }
  const categoryId = largest(parts).categoryId
  ctx.q.run(
    `UPDATE transactions SET category_id = @categoryId, category_source = @source, category_confidence = NULL, needs_review = 0, updated_at = ${NOW}
     WHERE ledger_id = @ledger AND id = @id AND (category_id IS NOT @categoryId OR category_source IS NOT @source OR needs_review = 1)`,
    { id, categoryId, source: categoryId === null ? null : 'user' },
  )
}

/**
 * Saves the parts checkParts returned. None: the split is undone, and the transaction keeps its
 * category. What its payee learned is the caller's to keep right (setParts, updateTransaction).
 */
export function saveParts(ctx: AppContext, id: number, parts: TransactionPart[]) {
  ctx.q.transaction(() => savePartsOf(ctx, id, parts))
}

/**
 * The category you gave a transaction counts for its payee again (or with -1, no longer): a split
 * teaches its payee nothing, so it's taken away when the transaction is split, and given back when
 * the split is undone and it keeps the category as yours.
 */
export function learnOwn(ctx: AppContext, id: number, delta: 1 | -1) {
  const t = ctx.q.get<{ payeeKey: string; amount: number; categoryId: number | null; source: string | null; pairId: number | null }>(
    `SELECT payee_key AS payeeKey, amount_minor AS amount, category_id AS categoryId, category_source AS source, transfer_pair_id AS pairId
     FROM transactions WHERE ledger_id = @ledger AND id = ?`,
    id,
  )
  if (t?.source === 'user' && !t.pairId) learn(ctx, t.payeeKey, t.amount, t.categoryId, delta)
}

/** Splits a transaction into categories (PUT /transactions/{id}/parts), or undoes the split with an empty list. */
export function setParts(ctx: AppContext, id: number, input: Parameters<typeof checkParts>[2]) {
  const parts = checkParts(ctx, id, input)
  ctx.q.transaction(() => {
    const wasSplit = isSplitIntoCategories(ctx, id)
    if (parts.length && !wasSplit) learnOwn(ctx, id, -1)
    savePartsOf(ctx, id, parts)
    if (!parts.length && wasSplit) learnOwn(ctx, id, 1)
  })
}

/** The ledger's parts (or these transactions'), by transaction, each with its category's name. */
function ledgerParts(ctx: AppContext, ids?: number[]): Map<number, Array<TransactionPart & { name: string | null }>> {
  const rows = ctx.q.all<TransactionPart & { txId: number; name: string | null }>(
    `SELECT p.transaction_id AS txId, p.category_id AS categoryId, p.amount_minor AS amountMinor, p.note,
       (SELECT c.name FROM ledger_categories c WHERE c.id = p.category_id AND c.ledger_id = t.ledger_id) AS name
     FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.ledger_id = @ledger${ids ? ' AND p.transaction_id IN (SELECT value FROM json_each(?))' : ''}
     ORDER BY p.transaction_id, p.sort`,
    ...(ids ? [JSON.stringify(ids)] : []),
  )
  const out = new Map<number, Array<TransactionPart & { name: string | null }>>()
  for (const { txId, ...part } of rows) out.set(txId, [...(out.get(txId) ?? []), part])
  return out
}

/**
 * After categories changed under the ledger's parts (one turned off, deleted, merged or moved):
 * each split is as its rules say again. Parts that ended in the same category are one, a split left
 * with one part is undone, and each split transaction has its largest part's category.
 */
export function settleParts(ctx: AppContext) {
  ctx.q.transaction(() => {
    for (const [id, parts] of ledgerParts(ctx)) {
      savePartsOf(ctx, id, parts)
      // Undone with one part left: that category is yours, and its payee learns it again.
      if (!isSplitIntoCategories(ctx, id)) learnOwn(ctx, id, 1)
    }
  })
}

/**
 * Parts follow their category as transactions do: those in `from` go to `to` (null: none), in this
 * ledger. settleParts comes after, once every category has moved.
 */
export function moveParts(ctx: AppContext, from: number, to: number | null) {
  ctx.q.run('UPDATE transaction_parts SET category_id = @to WHERE category_id = @from AND transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger)', { from, to })
}

/** How many of the ledger's transactions (not deleted) have a part in a category that isn't their own. */
export const USES_IN_PARTS = `(SELECT count(*) FROM transactions t WHERE t.ledger_id = @ledger AND t.deleted_at IS NULL AND t.category_id IS NOT @id
  AND EXISTS (SELECT 1 FROM transaction_parts sp WHERE sp.transaction_id = t.id AND sp.category_id = @id))`

/** Takes the parts off transactions before they leave the ledger (a transaction changes ledger with no parts), and returns them. */
export function takeParts(ctx: AppContext, ids: number[]) {
  const parts = ledgerParts(ctx, ids)
  ctx.q.run('DELETE FROM transaction_parts WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id IN (SELECT value FROM json_each(?)))', JSON.stringify(ids))
  return parts
}

/**
 * Gives moved transactions their parts back in the ledger they came to, each part in the category
 * `there` finds for it (the same category, else the one of the same name, else none).
 */
export function putParts(to: AppContext, taken: ReturnType<typeof takeParts>, there: (categoryId: number | null, name: string | null) => number | null) {
  for (const [id, parts] of taken) savePartsOf(to, id, parts.map((p) => ({ categoryId: there(p.categoryId, p.name), amountMinor: p.amountMinor, note: p.note })))
}
