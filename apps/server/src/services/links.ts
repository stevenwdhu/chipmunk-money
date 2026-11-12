import { formatMoney, type LinkKind, type TransactionLink, type TransactionLinksSet } from '@chipmunk/shared'
import { badRequest } from '../lib/http'
import type { AppContext } from './context'
import { refuseSplitLink } from './splits'

/**
 * Links between money in and the money out it pays back (`transaction_links`): a refund from the
 * merchant, or a payback (a friend's share of a bill you paid). One payback can cover several bills,
 * and a bill can be paid back by several, each link with how much of the money in it takes. Reports
 * count each link in its bill's category (the transaction_lines view).
 *
 * Money in linked in full to one bill takes its category and follows it (category source `linked`,
 * kept so by the links_follow_bill trigger). Linked in full to several, it has none of its own. Partly
 * linked, the rest is in its own category.
 */

interface Side {
  id: number
  amount_minor: number
  currency: string
  payee: string
  name: string | null
  date: string
  transfer_pair_id: number | null
  recurring_item_id: number | null
  category_id: number | null
  category_source: string | null
  /** Part of a split between ledgers: a split row, or a payment that's split. */
  split: number
}

const WORD: Record<LinkKind, string> = { refund: 'refund', payback: 'pay back' }

/** Each transaction's links (either side), by transaction, in the order they were made. */
export function linksFor(ctx: AppContext, ids: number[]): Map<number, TransactionLink[]> {
  const map = new Map<number, TransactionLink[]>()
  if (!ids.length) return map
  // A link's two sides are in one ledger (a guard trigger says so), so its money in pins it.
  const rows = ctx.q.all<{ id: number; kind: LinkKind; moneyIn: number; moneyOut: number; amount: number }>(
    `SELECT l.id, l.kind, l.money_in_id AS moneyIn, l.money_out_id AS moneyOut, l.amount_minor AS amount
     FROM transaction_links l JOIN transactions i ON i.id = l.money_in_id
     WHERE i.ledger_id = @ledger AND (l.money_in_id IN (SELECT value FROM json_each(@ids)) OR l.money_out_id IN (SELECT value FROM json_each(@ids)))
     ORDER BY l.id`,
    { ids: JSON.stringify(ids) },
  )
  const wanted = new Set(ids)
  const add = (txId: number, link: TransactionLink) => map.set(txId, [...(map.get(txId) ?? []), link])
  for (const r of rows) {
    if (wanted.has(r.moneyIn)) add(r.moneyIn, { id: r.id, kind: r.kind, transactionId: r.moneyOut, amountMinor: r.amount })
    if (wanted.has(r.moneyOut)) add(r.moneyOut, { id: r.id, kind: r.kind, transactionId: r.moneyIn, amountMinor: r.amount })
  }
  return map
}

function side(ctx: AppContext, id: number): Side {
  return ctx.q.mustGet<Side>(
    `SELECT t.id, t.amount_minor, t.currency, t.payee, t.name, t.date, t.transfer_pair_id, t.recurring_item_id, t.category_id, t.category_source,
       (t.split_of IS NOT NULL OR EXISTS (SELECT 1 FROM transactions g WHERE g.ledger_id = t.ledger_id AND g.split_of = t.id)) AS split
     FROM transactions t WHERE t.id = ? AND t.ledger_id = @ledger AND t.deleted_at IS NULL`,
    'Transaction not found',
    id,
  )
}

/**
 * Money in that can pay something back: not a transfer, nor a recurring item's payment (which has the
 * item's category), nor part of a split between ledgers (409).
 */
function checkMoneyIn(ctx: AppContext, t: Side) {
  if (t.split) refuseSplitLink(ctx, t.id)
  if (t.amount_minor <= 0) badRequest('Only money in can pay back a purchase or bill.')
  if (t.transfer_pair_id) badRequest('A transfer can’t pay anything back. Say it’s not a transfer first.')
  if (t.recurring_item_id) badRequest('A recurring item’s payment can’t pay anything back. Take it out of the item first.')
}

/** What can be paid back: money out that isn't a transfer, nor part of a split between ledgers (409). */
function checkBill(ctx: AppContext, t: Side) {
  if (t.split) refuseSplitLink(ctx, t.id)
  if (t.amount_minor >= 0 || t.transfer_pair_id) badRequest('Only a purchase or bill can be paid back: money out that isn’t a transfer.')
}

const describe = (t: Side) => `${t.name ?? t.payee} (${formatMoney(t.amount_minor, t.currency)} on ${t.date})`

/** How much of `t` is linked, leaving out its link with `except`. */
function linkedAmount(ctx: AppContext, t: Side, except: number) {
  const column = t.amount_minor > 0 ? 'money_in_id' : 'money_out_id'
  const other = t.amount_minor > 0 ? 'money_out_id' : 'money_in_id'
  return ctx.q.pluck<number>(
    `SELECT coalesce(sum(l.amount_minor), 0) FROM transaction_links l JOIN transactions o ON o.id = l.${other}
     WHERE o.ledger_id = @ledger AND l.${column} = ? AND l.${other} != ? AND o.deleted_at IS NULL`,
    t.id,
    except,
  )!
}

/**
 * Sets all of a transaction's links, from either side: money in's purchases or bills, or a bill's
 * money in. Together they can't be more than its amount, nor more than what's left on each other side.
 * Except a refund: all of it refunds its purchase, even more than the purchase has left (a currency's
 * rate moved, say), as long as it has something left.
 */
export function setLinks(ctx: AppContext, id: number, input: TransactionLinksSet['links']) {
  const self = side(ctx, id)
  const isIn = self.amount_minor > 0
  if (isIn) checkMoneyIn(ctx, self)
  else checkBill(ctx, self)
  const seen = new Set<number>()
  const others = input.map((l) => {
    if (seen.has(l.transactionId) || l.transactionId === id) badRequest('Link each transaction once.')
    seen.add(l.transactionId)
    const other = side(ctx, l.transactionId)
    if (isIn) checkBill(ctx, other)
    else checkMoneyIn(ctx, other)
    if (other.currency !== self.currency) badRequest(`${describe(other)} is in another currency.`)
    const left = Math.abs(other.amount_minor) - linkedAmount(ctx, other, id)
    const overRefund = l.kind === 'refund' && isIn && left > 0
    if (l.amountMinor > left && !overRefund) {
      badRequest(left > 0 ? `Only ${formatMoney(left, other.currency)} of ${describe(other)} is left to ${WORD[l.kind]}.` : `Nothing of ${describe(other)} is left to ${WORD[l.kind]}.`)
    }
    return other
  })
  const total = input.reduce((sum, l) => sum + l.amountMinor, 0)
  // A bill's refunds can come to more than it cost: only its paybacks are held to it.
  const billOverRefunded = !isIn && input.every((l) => l.kind === 'refund')
  if (total > Math.abs(self.amount_minor) && !billOverRefunded) {
    badRequest(`That’s ${formatMoney(total, self.currency)}, more than the ${formatMoney(Math.abs(self.amount_minor), self.currency)} ${isIn ? 'that came in' : 'it cost'}.`)
  }

  const column = isIn ? 'money_in_id' : 'money_out_id'
  const mine = `${column} IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?)`
  ctx.q.transaction(() => {
    const before = ctx.q.column<number>(`SELECT money_in_id FROM transaction_links WHERE ${mine}`, id)
    ctx.q.run(`DELETE FROM transaction_links WHERE ${mine}`, id)
    input.forEach((l, i) =>
      ctx.q.run(
        'INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES (?, ?, ?, ?)',
        l.kind,
        isIn ? id : others[i]!.id,
        isIn ? others[i]!.id : id,
        l.amountMinor,
      ),
    )
    for (const moneyIn of new Set(isIn ? [id] : [...before, ...others.map((o) => o.id)])) settleLinkedCategory(ctx, moneyIn)
  })
}

/**
 * Sets the links of several money in at once (paybacks from a few people for the same bills, say):
 * all of them or, if one doesn't hold, none. Their links go first, so each is checked against the
 * others' new links, not their old ones.
 */
export function setLinksTogether(ctx: AppContext, sets: Array<{ id: number; links: TransactionLinksSet['links'] }>) {
  if (new Set(sets.map((s) => s.id)).size !== sets.length) badRequest('Set each transaction once.')
  for (const s of sets) checkMoneyIn(ctx, side(ctx, s.id))
  ctx.q.transaction(() => {
    for (const s of sets) ctx.q.run('DELETE FROM transaction_links WHERE money_in_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?)', s.id)
    for (const s of sets) setLinks(ctx, s.id, s.links)
  })
}

/**
 * Money in's category after its links change: linked in full to one bill, that bill's (following it);
 * to several, none of its own. No longer linked in full: unlinked, it keeps its category as yours;
 * partly linked, the rest is uncategorized, for you (or AI) to say.
 */
export function settleLinkedCategory(ctx: AppContext, moneyInId: number) {
  const t = ctx.q.get<{ amount: number; categoryId: number | null; source: string | null }>(
    'SELECT amount_minor AS amount, category_id AS categoryId, category_source AS source FROM transactions WHERE id = ? AND ledger_id = @ledger',
    moneyInId,
  )
  if (!t) return
  const links = ctx.q.all<{ amount: number; categoryId: number | null }>(
    `SELECT l.amount_minor AS amount, b.category_id AS categoryId FROM transaction_links l JOIN transactions b ON b.id = l.money_out_id
     WHERE b.ledger_id = @ledger AND l.money_in_id = ?`,
    moneyInId,
  )
  const total = links.reduce((sum, l) => sum + l.amount, 0)
  const set = (values: { id: number; categoryId: number | null; source: string | null }) =>
    ctx.q.run(
      `UPDATE transactions SET category_id = @categoryId, category_source = @source, category_confidence = NULL, needs_review = 0,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id AND ledger_id = @ledger`,
      values,
    )
  if (links.length && total >= t.amount) {
    set({ id: moneyInId, categoryId: links.length === 1 ? links[0]!.categoryId : null, source: 'linked' })
  } else if (t.source === 'linked') {
    if (links.length) set({ id: moneyInId, categoryId: null, source: null })
    else set({ id: moneyInId, categoryId: t.categoryId, source: t.categoryId ? 'user' : null })
  }
}

/**
 * Before transactions are deleted for good (`doomed` picks them, a condition on the ledger's
 * transactions with positional parameters): their links go, and the money in they paid back settles.
 */
export function releaseTransactionLinks(ctx: AppContext, doomed: string, ...params: unknown[]) {
  const ids = `SELECT id FROM transactions WHERE ledger_id = @ledger AND (${doomed})`
  const moneyIn = ctx.q.column<number>(
    `SELECT DISTINCT money_in_id FROM transaction_links WHERE money_out_id IN (${ids}) AND money_in_id NOT IN (${ids})`,
    ...params,
    ...params,
  )
  // Each side on its own: a pin can't be under OR. A link's sides are in one ledger, so it's the same rows.
  ctx.q.run(`DELETE FROM transaction_links WHERE money_in_id IN (${ids})`, ...params)
  ctx.q.run(`DELETE FROM transaction_links WHERE money_out_id IN (${ids})`, ...params)
  for (const id of moneyIn) settleLinkedCategory(ctx, id)
}
