import {
  accountTypeInfo,
  addDays,
  formatMoney,
  isEmptyFilter,
  payeeSimilarity,
  type BulkResult,
  type CategorySource,
  type LinkCandidate,
  type LinkedTransaction,
  type LinkKind,
  type Tag,
  type TransactionLink,
  type PayeeNaming,
  type RecurringPaymentCandidate,
  type Transaction,
  type TransactionPage,
  type TransactionSpan,
  type AccountTransactionPage,
} from '@chipmunk/shared'
import type { z } from 'zod'
import type { bulkUpdateSchema, transactionCreateSchema, transactionQuerySchema, transactionUpdateSchema } from '@chipmunk/shared'
import { HTTPException } from 'hono/http-exception'
import { badRequest, notFound } from '../lib/http'
import { currentParts, getAccount } from './accounts'
import { diff } from './activity'
import { listScope, positional, textLike } from './filters'
import { learn, suggestCategory, type SuggestionResult } from './categorize'
import { upsertTags } from './categories'
import type { UsableLedgers } from './bank/service'
import type { AppContext } from './context'
import { payeeKeyOf, payeeNamerFor } from './payee-namer'
import { linksFor } from './links'
import { isPersonTransfer, releaseLinks } from './matching'
import { cadenceInfo, getRecurring, matchRecurring, paidOff, recalculateRecurring, setItemCategory, updateRecurring } from './recurring'
import { checkSplitEdit, refuseSplitDelete, splitPartOf, splitsFor, type SplitEdit } from './splits'

type CreateInput = z.output<typeof transactionCreateSchema>
type UpdateInput = z.output<typeof transactionUpdateSchema>
type QueryInput = z.output<typeof transactionQuerySchema>
type BulkInput = z.output<typeof bulkUpdateSchema>

interface TxRow {
  id: number
  account_id: number
  date: string
  amount_minor: number
  currency: string
  payee: string
  payee_key: string
  /** Its own name; `item_name` is its recurring item's (see ROW). */
  name: string | null
  item_name: string | null
  datetime: string | null
  /** Its place in the order transactions are listed (see SORT_KEY). */
  sort_key: string
  category_id: number | null
  category_source: CategorySource | null
  category_confidence: number | null
  needs_review: number
  notes: string | null
  recurring_item_id: number | null
  transfer_pair_id: number | null
  bank_category: string | null
  /** The other side's origin, for a transfer (see ROW). */
  pair_origin: 'manual' | 'import' | 'sync' | null
  status: 'cleared' | 'pending'
  origin: 'manual' | 'import' | 'sync'
  external_id: string | null
  corrected_at: string | null
  deleted_at: string | null
  /** The payment it's a split row of (see ROW for `split_payment`). */
  split_of: number | null
  /** It's a payment that's split: its given row is beside it (see ROW). */
  split_payment: number
  created_at: string
  updated_at: string
}

/**
 * Money out not on a credit card: within a day, without a time of day, it's taken to come after money
 * in, so a balance doesn't dip below zero because the pay came in after the bills. (A credit card keeps
 * the order they were added.)
 */
const OUT = `(t.amount_minor < 0 AND t.account_id NOT IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND type = 'credit'))`

/**
 * A transaction's place in the list, oldest first, as one string (and the paging cursor): its date; then,
 * that day, money in without a time of day, then ones with a time in time order, then money out without
 * one (see OUT); then the order they were added.
 */
const SORT_KEY = `(t.date || '|' || CASE WHEN t.datetime IS NOT NULL THEN 1 WHEN ${OUT} THEN 2 ELSE 0 END || '|' || coalesce(t.datetime, '') || '|' || printf('%012d', t.id))`

/**
 * A transaction row with its transfer's other side's origin, which says whether the two are kept in step,
 * its recurring item's name, its place in the list (SORT_KEY), and whether it's a payment that's split
 * between ledgers (its given row is held where it is: splits.ts).
 */
const ROW = `t.*, (SELECT p.origin FROM transactions p WHERE p.id = t.transfer_pair_id AND p.ledger_id = t.ledger_id) AS pair_origin,
  (SELECT r.title FROM recurring_items r WHERE r.id = t.recurring_item_id AND r.ledger_id = t.ledger_id) AS item_name, ${SORT_KEY} AS sort_key,
  EXISTS (SELECT 1 FROM transactions g WHERE g.ledger_id = t.ledger_id AND g.split_of = t.id) AS split_payment`

/** Not a split row, nor a payment that's split: the rows a link or a recurring item can take. */
const UNSPLIT = 't.split_of IS NULL AND NOT EXISTS (SELECT 1 FROM transactions g WHERE g.ledger_id = t.ledger_id AND g.split_of = t.id)'

/**
 * A transfer you entered as one (both sides made here) keeps its sides in step. A matched one (a card
 * payment and the withdrawal that paid it, each from its own bank or file) doesn't: they're two records.
 */
const isMirroredTransfer = (row: TxRow) => !!row.transfer_pair_id && row.origin === 'manual' && row.pair_origin === 'manual'
/** Money in that's the refund of one purchase (and linked to nothing else): it has that one's name. */
const isRefundOfOne = (ctx: AppContext, id: number) =>
  !!ctx.q.pluck(
    "SELECT count(*) = 1 AND min(l.kind) = 'refund' FROM transaction_links l JOIN transactions t ON t.id = l.money_in_id WHERE t.ledger_id = @ledger AND t.id = ?",
    id,
  )

function tagsFor(ctx: AppContext, ids: number[]): Map<number, Tag[]> {
  const map = new Map<number, Tag[]>()
  if (!ids.length) return map
  const rows = ctx.q.all<Tag & { txId: number }>(
    `SELECT tt.transaction_id AS txId, g.id, g.name, g.color FROM transaction_tags tt
     JOIN tags g ON g.id = tt.tag_id
     WHERE g.ledger_id = @ledger AND tt.transaction_id IN (SELECT value FROM json_each(?))
     ORDER BY g.name`,
    JSON.stringify(ids),
  )
  for (const { txId, ...tag } of rows) {
    const list = map.get(txId) ?? []
    list.push(tag)
    map.set(txId, list)
  }
  return map
}

function toDTO(r: TxRow, tags: Tag[], links: TransactionLink[], payee: PayeeNaming, split: Transaction['split']): Transaction {
  return {
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    amountMinor: r.amount_minor,
    currency: r.currency,
    payee: r.payee,
    payeeKey: r.payee_key,
    // What it's called: by the payee name rules, worked out as it's read.
    payeeName: payee.name,
    payeeNameRule: payee.ruleId,
    datetime: r.datetime,
    // Like its category: a recurring item's payments share the item's name (one without a name leaves theirs).
    name: r.item_name ?? r.name,
    categoryId: r.category_id,
    categorySource: r.category_source,
    categoryConfidence: r.category_confidence,
    needsReview: !!r.needs_review,
    notes: r.notes,
    recurringItemId: r.recurring_item_id,
    transferPairId: r.transfer_pair_id,
    transferMatched: !!r.transfer_pair_id && !isMirroredTransfer(r),
    links,
    bankCategory: r.bank_category,
    status: r.status,
    origin: r.origin,
    externalId: r.external_id,
    correctedAt: r.corrected_at,
    tags,
    split,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Transactions as the API shows them: with their tags, links, payee names and splits. */
function dtos(ctx: AppContext, rows: TxRow[]): Transaction[] {
  const ids = rows.map((r) => r.id)
  const tags = tagsFor(ctx, ids)
  const links = linksFor(ctx, ids)
  const name = payeeNamerFor(ctx)
  const splits = splitsFor(
    ctx,
    rows.filter((r) => r.split_of !== null || r.split_payment).map((r) => ({ id: r.id, amount: r.amount_minor, splitOf: r.split_of, isPayment: !!r.split_payment })),
  )
  return rows.map((r) => toDTO(r, tags.get(r.id) ?? [], links.get(r.id) ?? [], name(r.payee), splits.get(r.id) ?? null))
}

function getRow(ctx: AppContext, id: number, includeDeleted = false): TxRow {
  const row = ctx.q.get<TxRow>(`SELECT ${ROW} FROM transactions t WHERE t.id = ? AND t.ledger_id = @ledger`, id)
  if (!row || (!includeDeleted && row.deleted_at)) notFound('Transaction not found')
  return row
}

/**
 * The transaction in `accountId` that has this external id, if any (deleted ones included). An
 * external id is the account's, in every ledger that has it: when another ledger holds that
 * transaction (a shared account's), it's a 409 that doesn't say which one it is. So is one an account
 * split off from it has, which a ledger kept when it stopped sharing it.
 */
export function findByExternalId(ctx: AppContext, accountId: number, externalId: string) {
  const row = ctx.q.get<{ id: number; deletedAt: string | null }>(
    'SELECT id, deleted_at AS deletedAt FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND external_id = ?',
    accountId,
    externalId,
  )
  if (row) return { id: row.id, deleted: !!row.deletedAt }
  const held = ctx.q.pluck('SELECT 1 FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', accountId) ? ctx.accountWide.holder(accountId, externalId) : undefined
  if (held?.frozen) throw new HTTPException(409, { message: 'Another account has this transaction' })
  if (held) throw new HTTPException(409, { message: 'Another ledger has this transaction' })
  return null
}

/** The dates of the earliest and latest transactions (deleted ones aside). */
export function transactionSpan(ctx: AppContext): TransactionSpan {
  return ctx.q.get<TransactionSpan>('SELECT min(date) AS first, max(date) AS last FROM transactions WHERE ledger_id = @ledger AND deleted_at IS NULL')!
}

/** A refund looks back this far for purchases, unless you search. */
const REFUND_LOOKBACK_DAYS = 183
/** A payback looks for bills this far before it, and this far after (a friend can pay before the bill posts). */
const PAYBACK_BEFORE_DAYS = 60
const PAYBACK_AFTER_DAYS = 7
/** Payees this similar are likely the same merchant. */
const LIKELY_MERCHANT = 0.5

/** One amount is a whole share of the other: a bill split 2 to 10 ways, within a cent a share. */
function isShare(bill: number, share: number) {
  for (let ways = 2; ways <= 10; ways++) if (Math.abs(bill - share * ways) <= ways) return true
  return false
}

/**
 * What a transaction could be linked to, with something left to link (not money moving between
 * accounts, in a category left out of totals, nor part of a split), in the same currency and any account:
 * - money in, as a refund: purchases from the 6 months before it, of any amount (all of a refund
 *   refunds one, even more than it has left). The same or a similar payee first (the same amount
 *   first), then the most recent.
 * - money in, as a payback: bills from 60 days before it to 7 days after. Ones whose amounts fit first
 *   (it's a whole share of the bill, or exactly what's left of it), then the nearest.
 * - money out (a bill): money in from 7 days before it to 60 days after, not a recurring item's
 *   payment. Fitting amounts first, then e-Transfers, then the nearest, and ones in an income
 *   category (pay, interest) last.
 * With `q`, or `categoryId` (any of these categories), any that match instead, at any date: fitting ones
 * first still, then the newest. Up to 50.
 */
/**
 * How many link candidates are ranked: around its date, few are; at any date (searched, or by category),
 * enough that an old one whose amount fits isn't left out before the ranking sees it.
 */
const AROUND_ROWS = 300
const LOOKING_ROWS = 5000
export function linkCandidates(ctx: AppContext, id: number, opts: { kind: LinkKind; q?: string; categoryId?: Array<number | 'none'> }): LinkCandidate[] {
  const self = getRow(ctx, id)
  if (!self.amount_minor || self.transfer_pair_id || self.split_of !== null || self.split_payment) return []
  const isIn = self.amount_minor > 0
  const refund = isIn && opts.kind === 'refund'
  const where = [
    't.ledger_id = @ledger',
    't.deleted_at IS NULL',
    't.transfer_pair_id IS NULL',
    UNSPLIT,
    '(t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND exclude_from_totals = 1))',
    't.currency = ?',
    't.id != ?',
    isIn ? 't.amount_minor < 0' : 't.amount_minor > 0 AND t.recurring_item_id IS NULL',
  ]
  const params: unknown[] = [self.currency, self.id]
  // Searched, or by category: at any date.
  const looking = !!opts.q || !!opts.categoryId?.length
  if (opts.q) {
    const [sql, ...search] = textSearch(opts.q)
    where.push(sql)
    params.push(...search)
  }
  if (opts.categoryId?.length) inCategories(opts.categoryId, where, params)
  if (!looking) {
    where.push('t.date BETWEEN ? AND ?')
    if (refund) params.push(addDays(self.date, -REFUND_LOOKBACK_DAYS), self.date)
    else if (isIn) params.push(addDays(self.date, -PAYBACK_BEFORE_DAYS), addDays(self.date, PAYBACK_AFTER_DAYS))
    else params.push(addDays(self.date, -PAYBACK_AFTER_DAYS), addDays(self.date, PAYBACK_BEFORE_DAYS))
  }
  // What's left of each to link: its amount, less its links to others (not this one).
  const [mine, theirs] = isIn ? ['money_in_id', 'money_out_id'] : ['money_out_id', 'money_in_id']
  const rows = ctx.q.all<TxRow & { left_minor: number; income: number }>(
    `SELECT * FROM (
       SELECT ${ROW}, abs(t.amount_minor) - coalesce((SELECT sum(l.amount_minor) FROM transaction_links l
         JOIN transactions o ON o.id = l.${mine} WHERE l.${theirs} = t.id AND l.${mine} != ? AND o.ledger_id = t.ledger_id AND o.deleted_at IS NULL), 0) AS left_minor,
         coalesce((SELECT c.is_income FROM ledger_categories c WHERE c.id = t.category_id AND c.ledger_id = t.ledger_id), 0) AS income
       FROM transactions t WHERE ${where.join(' AND ')})
     WHERE left_minor > 0 ORDER BY sort_key DESC LIMIT ${looking ? LOOKING_ROWS : AROUND_ROWS}`,
    self.id,
    ...params,
  )
  // What's left of this one to link.
  const myLeft =
    Math.abs(self.amount_minor) -
    ctx.q.pluck<number>(
      `SELECT coalesce(sum(l.amount_minor), 0) FROM transaction_links l JOIN transactions o ON o.id = l.${theirs}
       WHERE o.ledger_id = @ledger AND l.${mine} = ? AND o.deleted_at IS NULL`,
      self.id,
    )!
  const days = (r: TxRow) => Math.abs(Date.parse(r.date) - Date.parse(self.date))
  const ranked = rows
    .map((r) => {
      const likely = refund
        ? r.payee_key === self.payee_key || payeeSimilarity(r.payee_key, self.payee_key) >= LIKELY_MERCHANT
        : r.left_minor === myLeft || (isIn ? isShare(-r.amount_minor, self.amount_minor) : isShare(-self.amount_minor, r.amount_minor))
      return { r, likely, exact: Math.abs(r.amount_minor) === Math.abs(self.amount_minor), person: !isIn && isPersonTransfer(r.payee), pay: !isIn && !!r.income }
    })
    .sort((a, b) =>
      refund
        ? Number(b.likely) - Number(a.likely) || (a.likely ? Number(b.exact) - Number(a.exact) : 0)
        : Number(b.likely) - Number(a.likely) ||
          Number(b.person) - Number(a.person) ||
          Number(a.pay) - Number(b.pay) ||
          // Searched, at any date: newest first, as they came (the nearest is only for the dates around it).
          (looking ? 0 : days(a.r) - days(b.r)),
    )
    .slice(0, 50)
  const list = dtos(
    ctx,
    ranked.map(({ r }) => r),
  )
  return ranked.map(({ r, likely }, i) => ({ transaction: list[i]!, leftMinor: r.left_minor, likely }))
}

/**
 * Payments you could add to a recurring item by hand (`addPayment`): not linked to an item, not
 * transfers or split rows, the same way as it (money out or in), from its account if it has one, at any amount.
 * From around its dates: its first payment (or next due date) back 3 periods, until a period after
 * its next due date. Searched, at any date. Its payees' and ones like them first, then the newest.
 */
export function recurringPaymentCandidates(ctx: AppContext, itemId: number, opts: { q?: string }): RecurringPaymentCandidate[] {
  const item = getRecurring(ctx, itemId)
  const where = [
    't.ledger_id = @ledger',
    't.deleted_at IS NULL',
    't.transfer_pair_id IS NULL',
    't.recurring_item_id IS NULL',
    't.split_of IS NULL',
    item.expectedAmountMinor < 0 ? 't.amount_minor < 0' : 't.amount_minor > 0',
  ]
  const params: unknown[] = []
  if (item.accountId !== null) {
    where.push('t.account_id = ?')
    params.push(item.accountId)
  }
  if (opts.q) {
    const [sql, ...search] = textSearch(opts.q)
    where.push(sql)
    params.push(...search)
  } else {
    const first = ctx.q.pluck<string | null>('SELECT min(date) FROM transactions WHERE ledger_id = @ledger AND recurring_item_id = ? AND deleted_at IS NULL', itemId) ?? null
    const period = cadenceInfo(item.cadence).days
    const from = first && first < item.nextDueDate ? first : item.nextDueDate
    where.push('t.date BETWEEN ? AND ?')
    params.push(addDays(from, -3 * period), addDays(item.nextDueDate, period))
  }
  const keys = [
    item.payeeKey,
    ...ctx.q.column<string>('SELECT payee_key FROM recurring_payees WHERE item_id IN (SELECT id FROM recurring_items WHERE ledger_id = @ledger AND id = ?)', itemId),
  ]
  // Its payees' first, so a busy card's other payments don't crowd them out of the rows read.
  const rows = ctx.q.all<TxRow>(
    `SELECT ${ROW} FROM transactions t WHERE ${where.join(' AND ')}
     ORDER BY t.payee_key IN (SELECT value FROM json_each(?)) DESC, sort_key DESC LIMIT ${opts.q ? LOOKING_ROWS : AROUND_ROWS}`,
    ...params,
    JSON.stringify(keys),
  )
  const ranked = rows
    .map((r) => ({ r, likely: keys.some((k) => k === r.payee_key || payeeSimilarity(k, r.payee_key) >= LIKELY_MERCHANT) }))
    .sort((a, b) => Number(b.likely) - Number(a.likely))
    .slice(0, 50)
  const list = dtos(
    ctx,
    ranked.map(({ r }) => r),
  )
  return ranked.map(({ likely }, i) => ({ transaction: list[i]!, likely }))
}

/** A transaction's links, each with the transaction on its other side. */
export function linkedTransactions(ctx: AppContext, id: number): LinkedTransaction[] {
  getRow(ctx, id, true)
  const links = linksFor(ctx, [id]).get(id) ?? []
  if (!links.length) return []
  const rows = ctx.q.all<TxRow>(
    `SELECT ${ROW} FROM transactions t WHERE t.ledger_id = @ledger AND t.id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(links.map((l) => l.transactionId)),
  )
  const byId = new Map(dtos(ctx, rows).map((t) => [t.id, t]))
  return links.flatMap((link) => {
    const transaction = byId.get(link.transactionId)
    return transaction ? [{ link, transaction }] : []
  })
}

export function getTransaction(ctx: AppContext, id: number): Transaction {
  return dtos(ctx, [getRow(ctx, id)])[0]!
}

/** These transactions, in this order (ones that aren't there left out). */
export function getTransactions(ctx: AppContext, ids: number[]): Transaction[] {
  if (!ids.length) return []
  const rows = ctx.q.all<TxRow>(`SELECT ${ROW} FROM transactions t WHERE t.ledger_id = @ledger AND t.id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
  const byId = new Map(dtos(ctx, rows).map((t) => [t.id, t]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/** Money in linked to a bill (not a deleted one) that matches `bill` (on `b`). */
const linkedTo = (bill: string) =>
  `EXISTS (SELECT 1 FROM transaction_links l JOIN transactions b ON b.id = l.money_out_id
    WHERE l.money_in_id = t.id AND b.ledger_id = t.ledger_id AND b.deleted_at IS NULL AND ${bill})`

/**
 * Adds a condition (to `where`, and its values to `params`): in any of these categories, `none` for
 * uncategorized. Money in linked in full to several bills has no category of its own: it's in each
 * of theirs, and so is a refund of an uncategorized purchase.
 */
function inCategories(categories: Array<number | 'none'>, where: string[], params: unknown[]) {
  const any: string[] = []
  for (const c of new Set(categories)) {
    if (c === 'none') {
      any.push(`(t.category_id IS NULL AND t.transfer_pair_id IS NULL AND (t.category_source IS NOT 'linked' OR ${linkedTo('b.category_id IS NULL')}))`)
    } else {
      any.push(`(t.category_id = ? OR (t.category_source = 'linked' AND t.category_id IS NULL AND EXISTS (
        SELECT 1 FROM transaction_links l JOIN transactions b ON b.id = l.money_out_id
        WHERE l.money_in_id = t.id AND b.ledger_id = t.ledger_id AND b.category_id = ?)))`)
      params.push(c, c)
    }
  }
  where.push(`(${any.join(' OR ')})`)
}

export function listTransactions(ctx: AppContext, q: QueryInput): TransactionPage {
  const where = ['t.ledger_id = @ledger', 't.deleted_at IS NULL']
  const params: unknown[] = []
  if (q.from) {
    where.push('t.date >= ?')
    params.push(q.from)
  }
  if (q.to) {
    where.push('t.date <= ?')
    params.push(q.to)
  }
  if (q.accountId) {
    where.push('t.account_id = ?')
    params.push(q.accountId)
  }
  if (q.categoryId?.length) inCategories(q.categoryId, where, params)
  if (q.tagId) {
    where.push('EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id = ?)')
    params.push(q.tagId)
  }
  if (q.recurringItemId) {
    where.push('t.recurring_item_id = ?')
    params.push(q.recurringItemId)
  }
  if (q.needsReview) where.push('t.needs_review = 1')
  if (q.labelId === 'none') {
    // Spending in categories without a label, as the summary counts it: with refunds and paybacks of it.
    const unlabelled = `SELECT c.id FROM ledger_categories c WHERE c.ledger_id = @ledger AND c.is_income = 0 AND c.exclude_from_totals = 0
      AND NOT EXISTS (SELECT 1 FROM category_labels cl WHERE cl.category_id = c.id)`
    where.push(
      `t.transfer_pair_id IS NULL AND ((t.category_id IS NULL AND t.amount_minor < 0) OR t.category_id IN (${unlabelled})
         OR (t.category_id IS NULL AND t.category_source = 'linked' AND ${linkedTo(`(b.category_id IS NULL OR b.category_id IN (${unlabelled}))`)}))`,
    )
  } else if (q.labelId) {
    where.push(
      't.transfer_pair_id IS NULL AND t.category_id IN (SELECT cl.category_id FROM category_labels cl JOIN ledger_labels b ON b.id = cl.label_id WHERE b.ledger_id = @ledger AND cl.label_id = ?)',
    )
    params.push(q.labelId)
  }
  if (q.q) {
    const [sql, ...search] = textSearch(q.q)
    where.push(sql)
    params.push(...search)
  }
  const scope = listScope(q.filter, { filteredOut: q.filteredOut, side: q.side })
  if (scope) where.push(scope.sql)
  if (q.cursor) {
    // The last row's place in the list (SORT_KEY).
    if (!/^\d{4}-\d{2}-\d{2}\|[012]\|[\d:T-]*\|\d{12}$/.test(q.cursor)) badRequest('Invalid cursor')
    where.push(`${SORT_KEY} < ?`)
    params.push(q.cursor)
  }
  const rows = ctx.q.all<TxRow>(
    `SELECT ${ROW} FROM transactions t WHERE ${where.join(' AND ')}
     ORDER BY ${SORT_KEY} DESC LIMIT ?`,
    ...params,
    q.limit + 1,
    scope?.params ?? {},
  )
  const page = rows.slice(0, q.limit)
  const items = dtos(ctx, page)
  const last = page[page.length - 1]
  const balances = runningBalances(ctx, q, page)
  return {
    items: items.map((t, i) => ({ ...t, balanceAfterMinor: balances?.[i] ?? null })),
    nextCursor: rows.length > q.limit && last ? last.sort_key : null,
  }
}

/** A row's place in a list (SORT_KEY), as a paging cursor has it. */
const CURSOR = /^\d{4}-\d{2}-\d{2}\|[012]\|[\d:T-]*\|\d{12}$/

/**
 * A shared account's transactions in every ledger that has it, one page at a time, newest first as
 * the register lists them, from `from` to `to`: each with the ledger that holds it (`here` when it's
 * this one), its category by name, and the account's total balance after it, so the list reads like
 * the bank's statement and its newest row ends at the account's total. Nothing else of another
 * ledger's: no ids of its categories, tags, links or recurring items. Only for a shared account
 * (409 otherwise), and only for a caller allowed in every ledger that has it (`allowed`, null for
 * every ledger): 403 otherwise. Besides a bank switch's review, the one place another ledger's rows
 * reach a response.
 */
export function listAccountTransactions(
  ctx: AppContext,
  accountId: number,
  q: { from?: string; to?: string; limit?: number; cursor?: string },
  allowed: UsableLedgers,
): AccountTransactionPage {
  const { name } = getAccount(ctx, accountId)
  if (!ctx.accountWide.isShared(accountId)) throw new HTTPException(409, { message: `${name} isn’t shared, so all its transactions are in this ledger.` })
  if (allowed && !ctx.accountWide.ledgers(accountId).every((l) => allowed.includes(l.ledgerId))) {
    throw new HTTPException(403, { message: `This key can’t see every ledger that has ${name}` })
  }
  const limit = q.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) badRequest('Ask for 1 to 500 transactions at a time')
  if (q.cursor && !CURSOR.test(q.cursor)) badRequest('Invalid cursor')
  const rows = ctx.accountWide.accountTransactions(accountId, { from: q.from, to: q.to, cursor: q.cursor, limit: limit + 1 })
  const page = rows.slice(0, limit)
  const first = page[0]
  // The account's total less everything listed above the first row (newer, or later the same day), in every ledger.
  let after = first ? currentParts(ctx, accountId).totalMinor - ctx.accountWide.sumAfter(accountId, first.sortKey) : 0
  const named = payeeNamerFor(ctx)
  const items = page.map((r) => {
    const balanceAfterMinor = after
    after -= r.amountMinor
    return {
      id: r.id,
      ledger: { slug: r.ledgerSlug, name: r.ledgerName },
      here: r.ledgerId === ctx.ledger.id,
      date: r.date,
      datetime: r.datetime,
      amountMinor: r.amountMinor,
      currency: r.currency,
      payee: r.payee,
      payeeName: named(r.payee).name,
      name: r.name,
      category: r.category,
      notes: r.notes,
      status: r.status,
      origin: r.origin,
      balanceAfterMinor,
    }
  })
  return { items, nextCursor: rows.length > limit && page.length ? page[page.length - 1]!.sortKey : null }
}

/**
 * A condition (and its parameters) for transactions whose payee (as sent, or its key: what the rules
 * call it), name, notes, recurring item or amount match `text`.
 */
function textSearch(text: string): [string, ...unknown[]] {
  const params: unknown[] = []
  return [textLike('t', text, positional(params)), ...params]
}

/**
 * The account's balance after each transaction on the page, like a bank statement: worked back from
 * its current balance, so the newest one matches what the account shows. Only for one account's list
 * with no filter but dates (a filtered list skips transactions, so its balances wouldn't add up), and
 * not for an investment, loan or property, whose value also moves on its own.
 */
function runningBalances(ctx: AppContext, q: QueryInput, page: TxRow[]): number[] | null {
  const first = page[0]
  if (!q.accountId || !first || q.categoryId || q.tagId || q.recurringItemId || q.needsReview || q.labelId || q.q || !isEmptyFilter(q.filter) || q.filteredOut || q.side) return null
  const account = getAccount(ctx, q.accountId)
  if (accountTypeInfo(account.type).revalued) return null
  // Everything listed above the first row: newer, or later the same day (see SORT_KEY).
  const later = ctx.q.pluck<number>(
    `SELECT coalesce(sum(t.amount_minor), 0) FROM transactions t WHERE t.ledger_id = @ledger AND t.account_id = ? AND t.deleted_at IS NULL AND ${SORT_KEY} > ?`,
    q.accountId,
    first.sort_key,
  )!
  let after = account.balanceMinor - later
  return page.map((r) => {
    const balance = after
    after -= r.amount_minor
    return balance
  })
}

function setTags(ctx: AppContext, txId: number, names: string[]) {
  ctx.q.run('DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?)', txId)
  const ids = upsertTags(ctx, names)
  for (const tagId of ids) ctx.q.run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', txId, tagId)
}

/**
 * "Not a transfer": a transfer's two sides are no longer paired, and each keeps its category, now as
 * yours. With `reject`, the pair is remembered as not one (transfer_rejections), so matching never
 * pairs them again. Returns the other side's id, or null when it isn't a transfer.
 */
export function unpairTransfer(ctx: AppContext, id: number, opts: { reject: boolean }): number | null {
  const row = ctx.q.get<{ amount: number; pairId: number | null }>(
    'SELECT amount_minor AS amount, transfer_pair_id AS pairId FROM transactions WHERE ledger_id = @ledger AND id = ?',
    id,
  )
  if (!row?.pairId) return null
  ctx.q.run(
    `UPDATE transactions SET transfer_pair_id = NULL, needs_review = 0,
       category_source = CASE WHEN category_id IS NULL THEN NULL ELSE 'user' END WHERE ledger_id = @ledger AND id IN (?, ?)`,
    id,
    row.pairId,
  )
  if (opts.reject) {
    const [inId, outId] = row.amount > 0 ? [id, row.pairId] : [row.pairId, id]
    ctx.q.run('INSERT OR IGNORE INTO transfer_rejections (in_id, out_id) VALUES (?, ?)', inId, outId)
  }
  return row.pairId
}

/**
 * The ledger's category for money moving between accounts, left out of totals: "Credit card
 * payment" for a payment onto a credit card (`targetType` credit), else its first such category.
 */
export function transferCategoryId(ctx: AppContext, targetType?: string): number | null {
  const name = targetType === 'credit' ? 'Credit card payment' : 'Transfer'
  return (
    ctx.q.pluck<number>('SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND exclude_from_totals = 1 AND archived_at IS NULL AND name = ?', name) ??
    ctx.q.pluck<number>('SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND exclude_from_totals = 1 AND archived_at IS NULL ORDER BY id LIMIT 1') ??
    null
  )
}

export interface CreateOptions {
  origin?: 'manual' | 'import' | 'sync'
  importBatchId?: number | null
  /** Pre-computed suggestion (import); `undefined` computes one now. */
  suggestion?: SuggestionResult | null
  useAi?: boolean
  skipRecurring?: boolean
}

interface ResolvedCategory {
  categoryId: number | null
  source: CategorySource | null
  confidence: number | null
  needsReview: boolean
}

export async function createTransaction(ctx: AppContext, input: CreateInput, opts: CreateOptions = {}): Promise<Transaction> {
  let suggestion = opts.suggestion
  if (suggestion === undefined && !input.categoryId && !input.transferAccountId) {
    suggestion = await suggestCategory(ctx, {
      payee: input.payee,
      amountMinor: input.amountMinor,
      accountId: input.accountId,
      date: input.date,
      notes: input.notes,
      useAi: opts.useAi,
    })
  }
  const id = insertTransaction(ctx, input, { ...opts, suggestion: suggestion ?? null })
  return getTransaction(ctx, id)
}

/** Synchronous insert used directly by imports (inside one SQLite transaction) and by createTransaction. */
export function insertTransaction(ctx: AppContext, input: CreateInput, opts: CreateOptions & { suggestion: SuggestionResult | null }): number {
  const account = ctx.q.get<{ id: number; name: string; currency: string }>(
    'SELECT id, name, currency FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?',
    input.accountId,
  )
  if (!account) badRequest('That account does not exist')
  const target = input.transferAccountId
    ? ctx.q.get<{ id: number; name: string; type: string; currency: string }>(
        'SELECT id, name, type, currency FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?',
        input.transferAccountId,
      )
    : undefined
  if (input.transferAccountId && !target) badRequest('The transfer account does not exist')
  if (target && target.id === account.id) badRequest('Pick a different account to transfer to')
  if (input.externalId && findByExternalId(ctx, account.id, input.externalId)) {
    throw new HTTPException(409, { message: `This account already has a transaction with externalId “${input.externalId}”` })
  }

  if (input.datetime && input.datetime.slice(0, 10) !== input.date) badRequest('Its time must be on its date')
  const payeeKey = payeeKeyOf(ctx, input.payee)
  const resolved: ResolvedCategory = { categoryId: input.categoryId ?? null, source: null, confidence: null, needsReview: false }
  if (resolved.categoryId) resolved.source = 'user'
  if (target) {
    resolved.categoryId = resolved.categoryId ?? transferCategoryId(ctx, target.type)
    resolved.source = 'user'
  } else if (!resolved.categoryId && opts.suggestion?.categoryId) {
    const s = opts.suggestion
    resolved.categoryId = s.categoryId
    resolved.source = s.source === 'ai' ? 'ai' : 'history'
    resolved.confidence = s.confidence
    resolved.needsReview = !s.autoApply
  }

  const insert = (values: Record<string, unknown>) =>
    Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, datetime, amount_minor, currency, payee, payee_key, name, category_id, category_source,
           category_confidence, needs_review, notes, status, origin, import_batch_id, external_id)
         VALUES (@ledger, @accountId, @date, @datetime, @amount, @currency, @payee, @payeeKey, @name, @categoryId, @source, @confidence, @needsReview,
           @notes, @status, @origin, @batch, @externalId)`,
        values,
      ).lastInsertRowid,
    )

  const id = ctx.q.transaction(() => {
    const base = {
      date: input.date,
      datetime: input.datetime ?? null,
      payee: input.payee,
      payeeKey,
      name: input.name?.trim() || null,
      categoryId: resolved.categoryId,
      source: resolved.source,
      confidence: resolved.confidence,
      needsReview: resolved.needsReview ? 1 : 0,
      notes: input.notes ?? null,
      status: input.status,
      origin: opts.origin ?? 'manual',
      batch: opts.importBatchId ?? null,
    }
    const txId = insert({
      ...base,
      accountId: account.id,
      amount: input.amountMinor,
      currency: account.currency,
      externalId: input.externalId ?? null,
    })
    if (target) {
      const pairId = insert({ ...base, accountId: target.id, amount: -input.amountMinor, currency: target.currency, externalId: null })
      ctx.q.run('UPDATE transactions SET transfer_pair_id = ? WHERE id = ? AND ledger_id = @ledger', pairId, txId)
      ctx.q.run('UPDATE transactions SET transfer_pair_id = ? WHERE id = ? AND ledger_id = @ledger', txId, pairId)
      if (input.tags.length) setTags(ctx, pairId, input.tags)
    }
    if (input.tags.length) setTags(ctx, txId, input.tags)
    return txId
  })

  if (resolved.source === 'user' && !target) learn(ctx, payeeKey, input.amountMinor, resolved.categoryId)
  if (!opts.skipRecurring && !target) matchRecurring(ctx, id)
  return id
}

export function updateTransaction(ctx: AppContext, id: number, input: UpdateInput): Transaction {
  const row = getRow(ctx, id)
  const itemWasPaidOff = row.recurring_item_id ? paidOff(ctx, row.recurring_item_id) : false
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  const set = (col: string, key: string, value: unknown) => {
    sets.push(`${col} = @${key}`)
    params[key] = value
  }

  if (input.accountId !== undefined && input.accountId !== row.account_id) {
    const acc = ctx.q.get<{ id: number; currency: string }>('SELECT id, currency FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', input.accountId)
    if (!acc) badRequest('That account does not exist')
    if (row.transfer_pair_id && acc.id === getRow(ctx, row.transfer_pair_id, true).account_id) {
      badRequest('A transfer needs two different accounts')
    }
    set('account_id', 'accountId', acc.id)
    set('currency', 'currency', acc.currency)
  }
  if (input.date !== undefined) set('date', 'date', input.date)
  // Its time of day, on its date: moving the date keeps the time.
  const datetime =
    input.datetime !== undefined ? input.datetime : row.datetime && input.date !== undefined ? `${input.date}${row.datetime.slice(10)}` : undefined
  if (datetime && datetime.slice(0, 10) !== (input.date ?? row.date)) badRequest('Its time must be on its date')
  if (datetime !== undefined) set('datetime', 'datetime', datetime)
  if (input.amountMinor !== undefined) set('amount_minor', 'amount', input.amountMinor)
  if (input.notes !== undefined) set('notes', 'notes', input.notes)
  // A recurring item's payments share its name (renamed below); any other transaction has its own.
  const nameItemId = input.recurringItemId !== undefined ? input.recurringItemId : row.recurring_item_id
  const newName = input.name === undefined ? undefined : input.name?.trim() || null
  // A refund of one purchase has its name (the refunds_follow_name trigger keeps it so).
  if (newName !== undefined && newName !== row.name && isRefundOfOne(ctx, id)) {
    badRequest('It has the name of the purchase it refunds. Rename that one, or unlink it.')
  }
  if (newName !== undefined && !nameItemId) set('name', 'name', newName)
  if (input.status !== undefined) set('status', 'status', input.status)
  if (input.recurringItemId !== undefined) set('recurring_item_id', 'recurringItemId', input.recurringItemId)

  let payeeKey = row.payee_key
  // A synced or imported one's payee is what the bank or file sent: matching and learning go by it.
  if (input.payee !== undefined && input.payee !== row.payee && row.origin !== 'manual') {
    badRequest('Its payee is what the bank or file sent. Give the payee an alias instead: it shows on all its transactions.')
  }
  if (input.payee !== undefined && input.payee !== row.payee) {
    payeeKey = payeeKeyOf(ctx, input.payee)
    set('payee', 'payee', input.payee)
    set('payee_key', 'payeeKey', payeeKey)
  }

  // A synced transaction you correct keeps your amount and date: syncs leave them alone from then on.
  const corrects = (input.amountMinor !== undefined && input.amountMinor !== row.amount_minor) || (input.date !== undefined && input.date !== row.date)
  if (input.corrected === false) set('corrected_at', 'correctedAt', null)
  else if (!row.corrected_at && (input.corrected || (row.external_id && corrects))) set('corrected_at', 'correctedAt', ctx.now().toISOString())

  const categoryChanged = input.categoryId !== undefined && input.categoryId !== row.category_id
  // Money in linked in full has its bill's category (the links_follow_bill trigger keeps it so), or its bills'.
  if (categoryChanged && row.category_source === 'linked') {
    badRequest('It has the category of what it pays back. Change that one’s, or unlink it.')
  }
  const confirmsSuggestion = input.categoryId !== undefined && !categoryChanged && !!row.needs_review
  if (categoryChanged) {
    set('category_id', 'categoryId', input.categoryId)
    set('category_source', 'source', input.categoryId ? 'user' : null)
    set('category_confidence', 'confidence', null)
  }
  if (categoryChanged || confirmsSuggestion) set('needs_review', 'needsReview', 0)
  // "Not a transfer": both sides keep their categories, now as yours, and aren't paired again.
  const unlinksTransfer = input.transferPairId === null && row.transfer_pair_id !== null
  const mirrored = isMirroredTransfer(row)

  // A split payment and its split rows keep what the split goes by (splits.ts), and so does a split
  // payment on the other side of a transfer you entered, which follows this one.
  const amountChanges = input.amountMinor !== undefined && input.amountMinor !== row.amount_minor
  const dateChanges = (input.date !== undefined && input.date !== row.date) || (datetime !== undefined && datetime !== row.datetime)
  const payeeChanges = input.payee !== undefined && input.payee !== row.payee
  const part = row.split_of !== null || row.split_payment ? splitPartOf(ctx, id) : null
  if (part) {
    checkSplitEdit(ctx, part, {
      amountMinor: amountChanges ? input.amountMinor : undefined,
      date: dateChanges,
      account: input.accountId !== undefined && input.accountId !== row.account_id,
      payee: payeeChanges,
      status: input.status !== undefined && input.status !== row.status,
      recurringItem: input.recurringItemId !== undefined && input.recurringItemId !== row.recurring_item_id,
      categoryId: categoryChanged ? (input.categoryId ?? null) : undefined,
    })
  }
  const pairPart = mirrored && !unlinksTransfer ? splitPartOf(ctx, row.transfer_pair_id!) : null
  if (pairPart) checkSplitEdit(ctx, pairPart, { amountMinor: amountChanges ? -input.amountMinor! : undefined, date: dateChanges, payee: payeeChanges })

  ctx.q.transaction(() => {
    if (sets.length) {
      sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      ctx.q.run(`UPDATE transactions SET ${sets.join(', ')} WHERE id = @id AND ledger_id = @ledger`, params)
    }
    if (input.tags !== undefined) setTags(ctx, id, input.tags)
    if (unlinksTransfer) unpairTransfer(ctx, id, { reject: true })
    // Keep both sides of a transfer you entered in step.
    else if (mirrored) {
      const pairSets: string[] = []
      const pairParams: Record<string, unknown> = { id: row.transfer_pair_id }
      if (input.date !== undefined) {
        pairSets.push('date = @date')
        pairParams.date = input.date
      }
      if (datetime !== undefined) {
        pairSets.push('datetime = @datetime')
        pairParams.datetime = datetime
      }
      if (input.amountMinor !== undefined) {
        pairSets.push('amount_minor = @amount')
        pairParams.amount = -input.amountMinor
      }
      if (input.payee !== undefined) {
        pairSets.push('payee = @payee, payee_key = @payeeKey')
        pairParams.payee = input.payee
        pairParams.payeeKey = payeeKey
      }
      if (pairSets.length) {
        ctx.q.run(`UPDATE transactions SET ${pairSets.join(', ')} WHERE id = @id AND ledger_id = @ledger`, pairParams)
      }
    }
  })

  // A recurring item's payments share one category: this one's goes to the item and its other payments.
  const itemId = input.recurringItemId !== undefined ? input.recurringItemId : row.recurring_item_id
  if (categoryChanged && itemId) setItemCategory(ctx, itemId, input.categoryId ?? null)
  // And one name: naming this one renames the item.
  if (newName !== undefined && nameItemId && newName !== row.item_name) updateRecurring(ctx, nameItemId, { name: newName })

  // A split row is the split's: nothing learns from it, and no recurring item takes it.
  if (!row.transfer_pair_id && row.split_of === null) {
    if (categoryChanged) {
      if (row.category_source === 'user' && row.category_id) learn(ctx, row.payee_key, row.amount_minor, row.category_id, -1)
      learn(ctx, payeeKey, input.amountMinor ?? row.amount_minor, input.categoryId ?? null)
    } else if (confirmsSuggestion) {
      learn(ctx, payeeKey, input.amountMinor ?? row.amount_minor, row.category_id)
    }
    const moved = input.amountMinor !== undefined || input.date !== undefined || input.payee !== undefined
    if (moved && !row.recurring_item_id && input.recurringItemId === undefined) matchRecurring(ctx, id)
    // A payment of an item that changed: the item works its payments out again.
    else if (moved && row.recurring_item_id && input.recurringItemId === undefined) {
      recalculateRecurring(ctx, row.recurring_item_id, { removed: true, followAmount: true, wasPaidOff: itemWasPaidOff })
    }
  }
  // Moved to another item, or taken off one: the old one doesn't take it back, and both recalculate.
  if (input.recurringItemId !== undefined && input.recurringItemId !== row.recurring_item_id) {
    if (row.recurring_item_id) {
      ctx.q.run('INSERT OR IGNORE INTO recurring_not_payments (item_id, transaction_id) VALUES (?, ?)', row.recurring_item_id, id)
      ctx.q.run(
        'DELETE FROM recurring_payment_dues WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?) AND item_id = ?',
        id,
        row.recurring_item_id,
      )
      recalculateRecurring(ctx, row.recurring_item_id, { removed: true, followAmount: true, wasPaidOff: itemWasPaidOff })
    }
    if (input.recurringItemId) {
      ctx.q.run(
        'DELETE FROM recurring_not_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?) AND item_id = ?',
        id,
        input.recurringItemId,
      )
      recalculateRecurring(ctx, input.recurringItemId, { followAmount: true })
    }
  }
  return getTransaction(ctx, id)
}

export function acceptSuggestion(ctx: AppContext, id: number): Transaction {
  const row = getRow(ctx, id)
  if (row.needs_review) {
    ctx.q.run('UPDATE transactions SET needs_review = 0 WHERE id = ? AND ledger_id = @ledger', id)
    learn(ctx, row.payee_key, row.amount_minor, row.category_id)
  }
  return getTransaction(ctx, id)
}

export function acceptAllSuggestions(ctx: AppContext): number {
  const rows = ctx.q.all<{ id: number; payeeKey: string; amountMinor: number; categoryId: number | null }>(
    `SELECT id, payee_key AS payeeKey, amount_minor AS amountMinor, category_id AS categoryId FROM transactions
     WHERE ledger_id = @ledger AND needs_review = 1 AND deleted_at IS NULL`,
  )
  ctx.q.transaction(() => {
    for (const r of rows) {
      ctx.q.run('UPDATE transactions SET needs_review = 0 WHERE id = ? AND ledger_id = @ledger', r.id)
      learn(ctx, r.payeeKey, r.amountMinor, r.categoryId)
    }
  })
  return rows.length
}

/**
 * Deletes it (soft, so it can be restored), with the other side of a transfer you entered as one.
 * Not a split payment or a split row, nor a transfer you entered with a split payment on its other
 * side: 409 (refuseSplitDelete).
 */
export function deleteTransaction(ctx: AppContext, id: number) {
  const row = getRow(ctx, id)
  refuseSplitDeletes(ctx, row)
  const itemWasPaidOff = row.recurring_item_id ? paidOff(ctx, row.recurring_item_id) : false
  const stamp = new Date().toISOString()
  if (row.transfer_pair_id && !isMirroredTransfer(row)) {
    // One side of a matched transfer: the other is its own bank record, which stays (no longer a transfer).
    ctx.q.transaction(() => {
      ctx.q.run('UPDATE transactions SET deleted_at = ?, transfer_pair_id = NULL WHERE id = ? AND ledger_id = @ledger', stamp, id)
      ctx.q.run('UPDATE transactions SET transfer_pair_id = NULL WHERE id = ? AND ledger_id = @ledger', row.transfer_pair_id)
    })
    return
  }
  ctx.q.run('UPDATE transactions SET deleted_at = ? WHERE ledger_id = @ledger AND id IN (?, ?)', stamp, id, row.transfer_pair_id ?? -1)
  if (row.recurring_item_id) recalculateRecurring(ctx, row.recurring_item_id, { removed: true, followAmount: true, wasPaidOff: itemWasPaidOff })
}

export function restoreTransaction(ctx: AppContext, id: number): Transaction {
  const row = getRow(ctx, id, true)
  ctx.q.run('UPDATE transactions SET deleted_at = NULL, removed_at = NULL WHERE ledger_id = @ledger AND id IN (?, ?)', id, row.transfer_pair_id ?? -1)
  if (row.recurring_item_id) recalculateRecurring(ctx, row.recurring_item_id, { followAmount: true })
  return getTransaction(ctx, id)
}

/** Refuses (409) deleting a split payment or a split row, or a transfer you entered whose other side is a split payment. */
function refuseSplitDeletes(ctx: AppContext, row: TxRow) {
  refuseSplitDelete(ctx, row.id)
  if (row.transfer_pair_id && isMirroredTransfer(row)) refuseSplitDelete(ctx, row.transfer_pair_id)
}

export function bulkUpdate(ctx: AppContext, input: BulkInput): { updated: number } {
  // What a split refuses, for any of them, before anything changes: deleting, or a split row's category counted in totals.
  if (input.delete || input.categoryId !== undefined) {
    for (const id of input.ids) {
      const row = ctx.q.get<TxRow>(`SELECT ${ROW} FROM transactions t WHERE t.id = ? AND t.ledger_id = @ledger AND t.deleted_at IS NULL`, id)
      if (!row) continue
      if (input.delete) refuseSplitDeletes(ctx, row)
      else if (row.split_of !== null && row.category_source !== 'linked') {
        const edit: SplitEdit = { categoryId: input.categoryId ?? null }
        checkSplitEdit(ctx, splitPartOf(ctx, id)!, edit)
      }
    }
  }
  let updated = 0
  for (const id of input.ids) {
    const row = ctx.q.get<{ id: number; deleted_at: string | null; category_source: string | null }>(
      'SELECT id, deleted_at, category_source FROM transactions WHERE id = ? AND ledger_id = @ledger',
      id,
    )
    if (!row || row.deleted_at) continue
    if (input.delete) {
      deleteTransaction(ctx, id)
      updated++
      continue
    }
    // Money in linked in full keeps what it pays back's category.
    if (input.categoryId !== undefined && row.category_source !== 'linked') updateTransaction(ctx, id, { categoryId: input.categoryId })
    if (input.acceptSuggestions) acceptSuggestion(ctx, id)
    if (input.addTags?.length || input.removeTags?.length) {
      const current = (tagsFor(ctx, [id]).get(id) ?? []).map((t) => t.name)
      const remove = new Set((input.removeTags ?? []).map((t) => t.replace(/^#/, '').toLowerCase()))
      const next = [...new Set([...current.filter((t) => !remove.has(t)), ...(input.addTags ?? [])])]
      setTags(ctx, id, next)
    }
    updated++
  }
  return { updated }
}

/** Every transaction (deleted ones included) by id, in id order, for before/after comparisons. */
function snapshot(ctx: AppContext, ids: number[]): Map<number, Transaction & { deleted: boolean }> {
  const out = new Map<number, Transaction & { deleted: boolean }>()
  if (!ids.length) return out
  const rows = ctx.q.all<TxRow>(
    `SELECT ${ROW} FROM transactions t WHERE t.ledger_id = @ledger AND t.id IN (SELECT value FROM json_each(?)) ORDER BY t.id`,
    JSON.stringify(ids),
  )
  const list = dtos(ctx, rows)
  rows.forEach((r, i) => out.set(r.id, { ...list[i]!, deleted: !!r.deleted_at }))
  return out
}

/** Applies `fn` to the given transactions and reports exactly which fields changed on each. */
export function withChanges(ctx: AppContext, ids: number[], fn: () => void): Omit<BulkResult, 'dryRun'> {
  const before = snapshot(ctx, ids)
  fn()
  const after = snapshot(ctx, ids)
  const changes: BulkResult['changes'] = []
  for (const [id, b] of before) {
    const a = after.get(id)
    if (!a || b.deleted) continue
    const d = diff(b, a)
    if (!d) continue
    changes.push({ id, payee: b.payee, date: b.date, amountMinor: b.amountMinor, deleted: a.deleted, before: d.before, after: d.after })
  }
  return { updated: changes.length, changes }
}

/** Purges soft-deleted transactions older than `days` (called by the nightly job). */
export function purgeDeleted(ctx: AppContext, days = 30) {
  const cutoff = new Date(ctx.now().getTime() - days * 86_400_000).toISOString()
  ctx.q.transaction(() => {
    releaseLinks(ctx, 'deleted_at IS NOT NULL AND deleted_at < ?', cutoff)
    ctx.q.run('DELETE FROM transactions WHERE ledger_id = @ledger AND deleted_at IS NOT NULL AND deleted_at < ?', cutoff)
  })
}
