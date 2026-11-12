import { addDays, daysBetween, payeeSimilarity, type CategorySource } from '@chipmunk/shared'
import type { AppContext } from './context'
import { releaseTransactionLinks } from './links'
import { today } from './settings'

/** How far back a refund looks for the purchase it refunds. */
const REFUND_DAYS = 60
/** Money onto a card from a merchant you bought from in this many days isn't a card payment, refund or not. */
const MERCHANT_DAYS = 365
/** A card payment and the withdrawal that paid it are at most this many days apart. */
const PAYMENT_DAYS = 5
/** Payees this similar (after store numbers and the like are removed) are the same merchant. */
const SAME_MERCHANT = 0.8
/** Accounts a credit card is paid from. */
const PAYS_CARDS = ['chequing', 'savings', 'cash']
/** A partial refund smaller than this is an adjustment, not a refund. */
const MIN_PARTIAL_REFUND = 100

/** Money sent to or from a person (Interac e-Transfer): neither a merchant purchase nor a card payment. */
export const isPersonTransfer = (payee: string) => /e-?transfer|interac|\bemt\b/i.test(payee)
/** Cash back and rewards a card pays out: money onto the card that isn't a payment. */
export const isCardReward = (payee: string) => /cash ?back|reward|redeem|redemption|bonus|points/i.test(payee)

interface Row {
  id: number
  /** The rules may change its category (OPEN), not only pair it. */
  open: number
  accountId: number
  accountType: string
  date: string
  amount: number
  payee: string
  payeeKey: string
  categoryId: number | null
  source: CategorySource | null
  needsReview: number
}

export interface MatchResult {
  refunds: number
  /** Card payments paired with the withdrawal that paid them. */
  transfers: number
  /** Card payments without a withdrawal (yet), put in the payment category. */
  payments: number
  /** Earlier payment calls that no longer hold (cash back, a merchant's credit): uncategorized again. */
  cleared: number[]
}

/** From a bank or a CSV file, not deleted, and not already a transfer, a refund or a payback. */
const LINKABLE = `t.deleted_at IS NULL AND t.transfer_pair_id IS NULL AND t.origin IN ('sync', 'import')
  AND NOT EXISTS (SELECT 1 FROM transaction_links l WHERE l.money_in_id = t.id)`
/**
 * Rows the rules may still change: uncategorized, an earlier rule's, or a suggestion still waiting
 * for review. A category you chose or accepted, or that your history is sure of, stays.
 */
const OPEN = `${LINKABLE}
  AND (t.category_source IS NULL OR t.category_source = 'rule' OR (t.category_source IN ('history', 'ai') AND t.needs_review = 1))`
/** In a category left out of totals: money moving between accounts, like a card payment or a transfer. */
const MOVES_MONEY = 't.category_id IN (SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND exclude_from_totals = 1)'
/**
 * Money onto a card that you or your history already call money moving between accounts: still
 * paired with the withdrawal that paid it, keeping its category.
 */
const PAID = `${LINKABLE} AND a.type = 'credit' AND ${MOVES_MONEY}`

const SELECT = `SELECT t.id, t.account_id AS accountId, a.type AS accountType, t.date, t.amount_minor AS amount,
  t.payee, t.payee_key AS payeeKey, t.category_id AS categoryId, t.category_source AS source, t.needs_review AS needsReview,
  (${OPEN}) AS open
  FROM transactions t JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
  WHERE t.ledger_id = @ledger`

/**
 * A withdrawal that could have paid a card: not already a transfer, and categorized by the app, or
 * by you as money moving between accounts (a category left out of totals).
 */
const COULD_PAY = `t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
  AND (t.category_source IS NULL OR t.category_source IN ('history', 'ai', 'rule') OR ${MOVES_MONEY})`

const sameMerchant = (a: string, b: string) => a === b || payeeSimilarity(a, b) >= SAME_MERCHANT

/** The ledger's category for credit card payments: "Credit card payment", else "Transfer", else none. */
export function cardPaymentCategory(ctx: AppContext): number | null {
  for (const name of ['credit card payment', 'transfer']) {
    const id = ctx.q.pluck<number>('SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND lower(name) = ? AND archived_at IS NULL', name)
    if (id !== undefined) return id
  }
  return null
}

/**
 * Rules for what arrives from a bank or a CSV file, run after each sync and import:
 *
 * 1. **Refund.** Money back on the same account from a merchant you bought from in the last 60 days
 *    is linked to that purchase (a refund link for all of it), so it takes the purchase's category,
 *    and always has it: when the purchase's changes, its refunds' do too (the database's
 *    links_follow_bill trigger). A smaller one counts too (a partial refund, $1 or more). Its category
 *    is the purchase's, so it isn't one to review: the Refund tag shows the link, to undo if it's wrong.
 *    Interac e-Transfers are money to and from people, not purchases, so they're never refunds.
 * 2. **Credit card payment.** Other money onto a credit card (but not cash back or rewards, or
 *    money from a merchant you bought from in the last year, in any ledger for a shared account)
 *    is a payment. It's paired as a transfer with the withdrawal from chequing or savings that paid
 *    it (the same amount, within 5 days); without one (yet) it goes in the ledger's "Credit card
 *    payment" category, or "Transfer", or stays uncategorized. Money back on a shared account whose
 *    purchase another ledger holds is neither: it stays an uncategorized credit where it is.
 *
 * Only what's uncategorized or still waiting for review changes (see OPEN): never a category you
 * chose or accepted, or one your history is sure of (cash back, say). Money onto a card you or your
 * history already put in a category left out of totals is still paired, keeping its category. A
 * payment matched before its withdrawal arrived is paired by a later pass; a pair you said isn't
 * one, never.
 *
 * It looks at the last 60 days, from `since` on instead when given, and from `earliest` on too: the
 * earliest date of what just arrived, however old (a CSV file of last year, a bank's first sync).
 */
export function matchTransactions(ctx: AppContext, opts: { since?: string; earliest?: string | null } = {}): MatchResult {
  const result: MatchResult = { refunds: 0, transfers: 0, payments: 0, cleared: [] }
  const recent = addDays(today(ctx), -REFUND_DAYS)
  const since = opts.since ?? (opts.earliest && opts.earliest < recent ? opts.earliest : recent)
  const credits = ctx.q.all<Row>(`${SELECT} AND (${OPEN} OR ${PAID}) AND t.amount_minor > 0 AND t.date >= ? ORDER BY t.date, t.id`, since)
  if (!credits.length) return result

  const purchases = (accountId: number, from: string, to: string) =>
    ctx.q.all<Row>(
      `${SELECT} AND t.account_id = ? AND t.amount_minor < 0 AND t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
         AND t.date BETWEEN ? AND ?
       ORDER BY t.date DESC, t.id DESC`,
      accountId,
      from,
      to,
    )
  /** What's already been paid back of a purchase: refunds and paybacks. */
  const refunded = (purchaseId: number) =>
    ctx.q.pluck<number>(
      `SELECT coalesce(sum(l.amount_minor), 0) FROM transaction_links l JOIN transactions m ON m.id = l.money_in_id
       WHERE m.ledger_id = @ledger AND l.money_out_id = ? AND m.deleted_at IS NULL`,
      purchaseId,
    )!
  const linkRefund = (values: { id: number; purchase: number; amount: number }) =>
    ctx.q.run(`INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('refund', @id, @purchase, @amount)`, values)
  const markRefund = (values: { id: number; categoryId: number | null }) =>
    ctx.q.run(
      `UPDATE transactions SET category_id = @categoryId, category_source = 'linked',
         category_confidence = NULL, needs_review = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id AND ledger_id = @ledger`,
      values,
    )
  const withdrawals = (...params: unknown[]) =>
    ctx.q.all<Row>(
      `${SELECT} AND ${COULD_PAY} AND t.amount_minor = ? AND t.account_id != ? AND a.type IN (${PAYS_CARDS.map(() => '?').join(', ')})
         AND t.date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM transfer_rejections r WHERE r.in_id = ? AND r.out_id = t.id)`,
      ...params,
    )
  const setPayment = (values: { id: number; pair: number | null; categoryId: number | null; source: string | null }) =>
    ctx.q.run(
      `UPDATE transactions SET transfer_pair_id = @pair, category_id = @categoryId, category_source = @source,
         category_confidence = NULL, needs_review = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id AND ledger_id = @ledger`,
      values,
    )
  const clear = (id: number) =>
    ctx.q.run(
      `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND ledger_id = @ledger`,
      id,
    )
  const paymentCategory = cardPaymentCategory(ctx)
  const shared = new Map<number, boolean>()
  /**
   * A shared account's purchases from this merchant that other ledgers hold (one moved there): money
   * back from it is still no card payment, though it can't be linked to them across ledgers.
   */
  const boughtElsewhere = (c: Row) => {
    if (!shared.has(c.accountId)) shared.set(c.accountId, ctx.accountWide.isShared(c.accountId))
    if (!shared.get(c.accountId)) return false
    return ctx.accountWide
      .purchasePayees(c.accountId, addDays(c.date, -MERCHANT_DAYS), c.date)
      .some((p) => !isPersonTransfer(p.payee) && sameMerchant(p.payeeKey, c.payeeKey))
  }

  ctx.q.transaction(() => {
    const paired = new Set<number>()
    for (const c of credits) {
      if (paired.has(c.id)) continue
      // 1. A refund of a recent purchase from the same merchant, on the same account. (Money to and from
      // people isn't: their names would match any e-Transfer.)
      const fromMerchant = !c.open || isPersonTransfer(c.payee)
        ? []
        : purchases(c.accountId, addDays(c.date, -MERCHANT_DAYS), c.date).filter(
            (p) => !isPersonTransfer(p.payee) && sameMerchant(p.payeeKey, c.payeeKey),
          )
      const refundFrom = addDays(c.date, -REFUND_DAYS)
      const purchase = fromMerchant
        .filter((p) => p.date >= refundFrom && -p.amount - refunded(p.id) >= c.amount && (-p.amount === c.amount || c.amount >= MIN_PARTIAL_REFUND))
        // The exact amount first, then the most recent.
        .sort((a, b) => Number(-b.amount === c.amount) - Number(-a.amount === c.amount))[0]
      if (purchase) {
        linkRefund({ id: c.id, purchase: purchase.id, amount: c.amount })
        markRefund({ id: c.id, categoryId: purchase.categoryId })
        result.refunds++
        continue
      }

      // 2. Money onto a credit card: a payment. Cash back, rewards and other credits from a merchant
      // you buy from (on a shared account, in any ledger) aren't; an earlier pass that called them
      // payments is undone. One whose purchase another ledger holds stays an ordinary credit here.
      if (c.accountType !== 'credit') continue
      if (isCardReward(c.payee) || fromMerchant.length || (c.open && !isPersonTransfer(c.payee) && boughtElsewhere(c))) {
        if (c.source === 'rule' && !paired.has(c.id)) {
          clear(c.id)
          result.cleared.push(c.id)
        }
        continue
      }
      const withdrawal = withdrawals(-c.amount, c.accountId, ...PAYS_CARDS, addDays(c.date, -PAYMENT_DAYS), addDays(c.date, PAYMENT_DAYS), c.id)
        .filter((w) => !paired.has(w.id) && !isPersonTransfer(w.payee))
        .sort((a, b) => Math.abs(daysBetween(a.date, c.date)) - Math.abs(daysBetween(b.date, c.date)) || a.id - b.id)[0]
      const category: { categoryId: number | null; source: string | null } = { categoryId: paymentCategory, source: paymentCategory ? 'rule' : null }
      if (withdrawal) {
        // One you or your history already call a payment keeps its category.
        setPayment({ id: c.id, pair: withdrawal.id, ...(c.open ? category : { categoryId: c.categoryId, source: c.source }) })
        setPayment({ id: withdrawal.id, pair: c.id, ...category })
        paired.add(withdrawal.id)
        result.transfers++
      } else if (c.open && (c.categoryId !== category.categoryId || c.source !== category.source || c.needsReview)) {
        // Not paired yet: a later pass pairs it once the withdrawal arrives.
        setPayment({ id: c.id, pair: null, ...category })
        result.payments++
      }
    }
  })
  return result
}

/**
 * Before transactions are deleted for good (`doomed` picks them, a condition on the ledger's
 * transactions with positional parameters), what points at them lets go: a transfer's other side
 * stops being a transfer, and refunds and paybacks stop following them.
 */
export function releaseLinks(ctx: AppContext, doomed: string, ...params: unknown[]) {
  const ids = `SELECT id FROM transactions WHERE ledger_id = @ledger AND (${doomed})`
  ctx.q.run(`UPDATE transactions SET transfer_pair_id = NULL WHERE ledger_id = @ledger AND transfer_pair_id IN (${ids})`, ...params)
  releaseTransactionLinks(ctx, doomed, ...params)
}
