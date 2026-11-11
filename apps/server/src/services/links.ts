import { formatMoney, type LinkKind, type TransactionLink, type TransactionLinksSet } from '@chipmunk/shared'
import { badRequest, notFound } from '../lib/http'
import type { AppContext } from './context'

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
}

const WORD: Record<LinkKind, string> = { refund: 'refund', payback: 'pay back' }

/** Each transaction's links (either side), by transaction, in the order they were made. */
export function linksFor(ctx: AppContext, ids: number[]): Map<number, TransactionLink[]> {
  const map = new Map<number, TransactionLink[]>()
  if (!ids.length) return map
  const list = JSON.stringify(ids)
  const rows = ctx.sqlite
    .prepare(
      `SELECT id, kind, money_in_id AS moneyIn, money_out_id AS moneyOut, amount_minor AS amount FROM transaction_links
       WHERE money_in_id IN (SELECT value FROM json_each(?)) OR money_out_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
    )
    .all(list, list) as Array<{ id: number; kind: LinkKind; moneyIn: number; moneyOut: number; amount: number }>
  const wanted = new Set(ids)
  const add = (txId: number, link: TransactionLink) => map.set(txId, [...(map.get(txId) ?? []), link])
  for (const r of rows) {
    if (wanted.has(r.moneyIn)) add(r.moneyIn, { id: r.id, kind: r.kind, transactionId: r.moneyOut, amountMinor: r.amount })
    if (wanted.has(r.moneyOut)) add(r.moneyOut, { id: r.id, kind: r.kind, transactionId: r.moneyIn, amountMinor: r.amount })
  }
  return map
}

function side(ctx: AppContext, id: number): Side {
  const row = ctx.sqlite
    .prepare(
      `SELECT id, amount_minor, currency, payee, name, date, transfer_pair_id, recurring_item_id, category_id, category_source
       FROM transactions WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as Side | undefined
  if (!row) notFound('Transaction not found')
  return row
}

/** Money in that can pay something back: not a transfer, nor a recurring item's payment (which has the item's category). */
function checkMoneyIn(t: Side) {
  if (t.amount_minor <= 0) badRequest('Only money in can pay back a purchase or bill.')
  if (t.transfer_pair_id) badRequest('A transfer can’t pay anything back. Say it’s not a transfer first.')
  if (t.recurring_item_id) badRequest('A recurring item’s payment can’t pay anything back. Take it out of the item first.')
}

/** What can be paid back: money out that isn't a transfer. */
function checkBill(t: Side) {
  if (t.amount_minor >= 0 || t.transfer_pair_id) badRequest('Only a purchase or bill can be paid back: money out that isn’t a transfer.')
}

const describe = (t: Side) => `${t.name ?? t.payee} (${formatMoney(t.amount_minor, t.currency)} on ${t.date})`

/** How much of `t` is linked, leaving out its link with `except`. */
function linkedAmount(ctx: AppContext, t: Side, except: number) {
  const column = t.amount_minor > 0 ? 'money_in_id' : 'money_out_id'
  const other = t.amount_minor > 0 ? 'money_out_id' : 'money_in_id'
  return ctx.sqlite
    .prepare(
      `SELECT coalesce(sum(l.amount_minor), 0) FROM transaction_links l JOIN transactions o ON o.id = l.${other}
       WHERE l.${column} = ? AND l.${other} != ? AND o.deleted_at IS NULL`,
    )
    .pluck()
    .get(t.id, except) as number
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
  if (isIn) checkMoneyIn(self)
  else checkBill(self)
  const seen = new Set<number>()
  const others = input.map((l) => {
    if (seen.has(l.transactionId) || l.transactionId === id) badRequest('Link each transaction once.')
    seen.add(l.transactionId)
    const other = side(ctx, l.transactionId)
    if (isIn) checkBill(other)
    else checkMoneyIn(other)
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
  ctx.sqlite.transaction(() => {
    const before = ctx.sqlite.prepare(`SELECT money_in_id FROM transaction_links WHERE ${column} = ?`).pluck().all(id) as number[]
    ctx.sqlite.prepare(`DELETE FROM transaction_links WHERE ${column} = ?`).run(id)
    const insert = ctx.sqlite.prepare('INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES (?, ?, ?, ?)')
    input.forEach((l, i) => insert.run(l.kind, isIn ? id : others[i]!.id, isIn ? others[i]!.id : id, l.amountMinor))
    for (const moneyIn of new Set(isIn ? [id] : [...before, ...others.map((o) => o.id)])) settleLinkedCategory(ctx, moneyIn)
  })()
}

/**
 * Sets the links of several money in at once (paybacks from a few people for the same bills, say):
 * all of them or, if one doesn't hold, none. Their links go first, so each is checked against the
 * others' new links, not their old ones.
 */
export function setLinksTogether(ctx: AppContext, sets: Array<{ id: number; links: TransactionLinksSet['links'] }>) {
  if (new Set(sets.map((s) => s.id)).size !== sets.length) badRequest('Set each transaction once.')
  for (const s of sets) checkMoneyIn(side(ctx, s.id))
  ctx.sqlite.transaction(() => {
    const clear = ctx.sqlite.prepare('DELETE FROM transaction_links WHERE money_in_id = ?')
    for (const s of sets) clear.run(s.id)
    for (const s of sets) setLinks(ctx, s.id, s.links)
  })()
}

/**
 * Money in's category after its links change: linked in full to one bill, that bill's (following it);
 * to several, none of its own. No longer linked in full: unlinked, it keeps its category as yours;
 * partly linked, the rest is uncategorized, for you (or AI) to say.
 */
export function settleLinkedCategory(ctx: AppContext, moneyInId: number) {
  const t = ctx.sqlite.prepare('SELECT amount_minor AS amount, category_id AS categoryId, category_source AS source FROM transactions WHERE id = ?').get(moneyInId) as
    | { amount: number; categoryId: number | null; source: string | null }
    | undefined
  if (!t) return
  const links = ctx.sqlite
    .prepare(
      `SELECT l.amount_minor AS amount, b.category_id AS categoryId FROM transaction_links l JOIN transactions b ON b.id = l.money_out_id
       WHERE l.money_in_id = ?`,
    )
    .all(moneyInId) as Array<{ amount: number; categoryId: number | null }>
  const total = links.reduce((sum, l) => sum + l.amount, 0)
  const set = ctx.sqlite.prepare(
    `UPDATE transactions SET category_id = @categoryId, category_source = @source, category_confidence = NULL, needs_review = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`,
  )
  if (links.length && total >= t.amount) {
    set.run({ id: moneyInId, categoryId: links.length === 1 ? links[0]!.categoryId : null, source: 'linked' })
  } else if (t.source === 'linked') {
    if (links.length) set.run({ id: moneyInId, categoryId: null, source: null })
    else set.run({ id: moneyInId, categoryId: t.categoryId, source: t.categoryId ? 'user' : null })
  }
}

/** Before transactions are deleted for good (`doomed` picks them): their links go, and the money in they paid back settles. */
export function releaseTransactionLinks(ctx: AppContext, doomed: string, ...params: unknown[]) {
  const ids = `SELECT id FROM transactions WHERE ${doomed}`
  const moneyIn = ctx.sqlite
    .prepare(`SELECT DISTINCT money_in_id FROM transaction_links WHERE money_out_id IN (${ids}) AND money_in_id NOT IN (${ids})`)
    .pluck()
    .all(...params, ...params) as number[]
  ctx.sqlite.prepare(`DELETE FROM transaction_links WHERE money_in_id IN (${ids}) OR money_out_id IN (${ids})`).run(...params, ...params)
  for (const id of moneyIn) settleLinkedCategory(ctx, id)
}
