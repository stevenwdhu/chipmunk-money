import {
  addDays,
  addMonthsToDate,
  CADENCES,
  daysBetween,
  instalmentStore,
  isInstalmentService,
  recurringLabel,
  PAY_IN_4,
  semiMonthlyPartner,
  type Cadence,
  type ISODate,
  type RecurringAlert,
  type RecurringItem,
  type RecurringStatus,
  type UpcomingPayment,
} from '@chipmunk/shared'
import type { z } from 'zod'
import type { recurringCreateSchema, recurringUpdateSchema } from '@chipmunk/shared'
import { payeeSimilarity } from '@chipmunk/shared'
import { badRequest, notFound } from '../lib/http'
import type { AppContext } from './context'
import { payeeKeyOf, payeeNameOf } from './payee-namer'
import { recurringDetection, today } from './settings'

type CreateInput = z.output<typeof recurringCreateSchema>
type UpdateInput = z.output<typeof recurringUpdateSchema>

export function cadenceInfo(c: Cadence) {
  return CADENCES.find((x) => x.value === c)!
}

/** Days either side of the due date in which a payment still counts as this occurrence. */
function matchWindow(c: Cadence) {
  return Math.max(5, cadenceInfo(c).tolerance + 3)
}

/** The due date after `date` (`step` 1) or before it (−1). Semi-monthly falls on two days of each month. */
export function advanceDate(date: ISODate, cadence: Cadence, anchorDay?: number, secondDay?: number | null, step: 1 | -1 = 1): ISODate {
  switch (cadence) {
    case 'weekly':
      return addDays(date, 7 * step)
    case 'biweekly':
      return addDays(date, 14 * step)
    case 'semimonthly': {
      const first = anchorDay ?? Number(date.slice(8, 10))
      return semiMonthly(date, first, secondDay ?? semiMonthlyPartner(first), step)
    }
    case 'monthly':
      return addMonthsToDate(date, step, anchorDay)
    case 'quarterly':
      return addMonthsToDate(date, 3 * step, anchorDay)
    case 'yearly':
      return addMonthsToDate(date, 12 * step, anchorDay)
  }
}

/** The day-`a` or day-`b` date (31: the month's last day) just after `date`, or (−1) just before it. */
function semiMonthly(date: ISODate, a: number, b: number, step: 1 | -1): ISODate {
  const monthStart = `${date.slice(0, 7)}-01`
  const dates = [-1, 0, 1].flatMap((m) => [a, b].map((d) => addMonthsToDate(monthStart, m, d))).sort()
  return step === 1 ? dates.find((d) => d > date)! : dates.reverse().find((d) => d < date)!
}

function anchorDayOf(item: { anchorDate: string; cadence: Cadence }) {
  return item.cadence === 'weekly' || item.cadence === 'biweekly' ? undefined : Number(item.anchorDate.slice(8, 10))
}

/** An item's schedule: its cadence, the day its anchor date sets, and semi-monthly's other day. */
interface Scheduled {
  cadence: Cadence
  anchorDate: string
  secondDay?: number | null
}
/** The item's due date after `date`, or (−1) before it. */
const stepDue = (item: Scheduled, date: ISODate, step: 1 | -1 = 1) => advanceDate(date, item.cadence, anchorDayOf(item), item.secondDay, step)

/**
 * A payment within this much of an item's amount is that item's (tighter checks drive the "price
 * changed" alert instead). With two items from one payee, the closer one.
 */
const SAME_ITEM_PCT = 50

export function amountWithin(amount: number, expected: number, tolerancePct: number) {
  if (Math.sign(amount) !== Math.sign(expected)) return false
  return Math.abs(amount - expected) <= Math.max(Math.abs(expected) * (tolerancePct / 100), 1)
}

interface ItemRow {
  id: number
  /** The payee as shown (the API's `payee`); `title` is what it is (the API's `name`). */
  name: string
  title: string | null
  payee_key: string
  category_id: number | null
  account_id: number | null
  expected_amount_minor: number
  amount_tolerance_pct: number
  cadence: Cadence
  anchor_date: string
  next_due_date: string
  status: RecurringStatus
  origin: 'detected' | 'manual'
  detection_score: number | null
  second_day: number | null
  total_payments: number | null
  paid_before: number
  full_price_minor: number | null
  occurrences: number
  paid_amount: number
  last_seen: string | null
  /** JSON arrays: the other payees' names, and their keys. */
  other_payees: string
  other_keys: string
  last_amount: number | null
}

// Linked payments; a suggestion's aren't linked yet, so `suggestedEvidence` finds them.
const ITEM_TX = 't.deleted_at IS NULL AND t.recurring_item_id = r.id'
/**
 * A payment added at its own amount (`addPayment`), like a plan's down payment: not its amount. In
 * recurring_payment_dues, one_off is 1, or 2 when it was one of the plan's payments from before your
 * history (taking it off gives that back).
 */
const ONE_OFF = (item: string, tx: string) => `${tx} IN (SELECT transaction_id FROM recurring_payment_dues WHERE item_id = ${item} AND one_off <> 0)`
const FROM_BEFORE = 2
const ITEM_SQL = `
  SELECT r.*,
    (SELECT count(*) FROM transactions t WHERE ${ITEM_TX}) AS occurrences,
    (SELECT coalesce(sum(t.amount_minor), 0) FROM transactions t WHERE ${ITEM_TX}) AS paid_amount,
    (SELECT json_group_array(p.name) FROM recurring_payees p WHERE p.item_id = r.id) AS other_payees,
    (SELECT json_group_array(p.payee_key) FROM recurring_payees p WHERE p.item_id = r.id) AS other_keys,
    (SELECT max(t.date) FROM transactions t WHERE ${ITEM_TX}) AS last_seen,
    (SELECT t.amount_minor FROM transactions t WHERE ${ITEM_TX} AND NOT ${ONE_OFF('r.id', 't.id')} ORDER BY t.date DESC, t.id DESC LIMIT 1) AS last_amount
  FROM recurring_items r`

/** A suggestion's payments, newest first: its payees' unlinked ones at about its amount, on its schedule. */
function suggestedPayments(ctx: AppContext, r: ItemRow): Array<{ id: number; date: string; amount: number }> {
  const item = {
    payeeKey: r.payee_key,
    expected: r.expected_amount_minor,
    tolerance: r.amount_tolerance_pct,
    cadence: r.cadence,
    anchorDate: r.anchor_date,
    secondDay: r.second_day,
    nextDueDate: r.next_due_date,
    total: r.total_payments,
  }
  return (
    ctx.sqlite
      .prepare(
        `SELECT id, date, amount_minor AS amount FROM transactions
         WHERE payee_key IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND recurring_item_id IS NULL AND transfer_pair_id IS NULL
         ORDER BY date DESC, id DESC`,
      )
      .all(JSON.stringify([r.payee_key, ...(JSON.parse(r.other_keys) as string[])])) as Array<{ id: number; date: string; amount: number }>
  ).filter((t) => amountWithin(t.amount, r.expected_amount_minor, r.amount_tolerance_pct) && onSchedule(item, t.date))
}

function suggestedEvidence(ctx: AppContext, r: ItemRow): Pick<ItemRow, 'occurrences' | 'paid_amount' | 'last_seen' | 'last_amount'> {
  const mine = suggestedPayments(ctx, r)
  return { occurrences: mine.length, paid_amount: mine.reduce((n, t) => n + t.amount, 0), last_seen: mine[0]?.date ?? null, last_amount: mine[0]?.amount ?? null }
}

/**
 * A plan's last payment, from its full price: what's left of it after the payments made (the linked ones
 * at what they were, ones from before your history at its amount) and the others to come at its amount.
 * Null without a full price, without payments to go, or when what's left isn't a payment (the full price
 * is less than its payments add up to).
 */
export function lastPaymentOf(p: { fullPrice: number | null; total: number | null; linked: number; paidAmount: number; paidBefore: number; expected: number }): number | null {
  if (p.fullPrice === null || p.total === null) return null
  const remaining = p.total - p.linked - p.paidBefore
  if (remaining < 1) return null
  const last = p.fullPrice - p.paidAmount - p.paidBefore * p.expected - (remaining - 1) * p.expected
  return last !== 0 && Math.sign(last) === Math.sign(p.expected) ? last : null
}

function toDTO(ctx: AppContext, row: ItemRow, todayDate: ISODate): RecurringItem {
  const r = row.status === 'suggested' ? { ...row, ...suggestedEvidence(ctx, row) } : row
  const info = cadenceInfo(r.cadence)
  const paid = r.occurrences + r.paid_before
  const remaining = r.total_payments === null ? null : Math.max(0, r.total_payments - paid)
  const schedule = { cadence: r.cadence, anchorDate: r.anchor_date, secondDay: r.second_day }
  let lastDue = r.next_due_date
  for (let i = 1; i < (remaining ?? 0); i++) lastDue = stepDue(schedule, lastDue)
  // The amount follows the latest payment while it's within the variation; beyond it, it's a price change.
  // (Not to a plan's final payment, which is often a little different.)
  const expected =
    r.last_amount !== null && remaining !== 0 && amountWithin(r.last_amount, r.expected_amount_minor, r.amount_tolerance_pct)
      ? r.last_amount
      : r.expected_amount_minor
  const lastPayment = lastPaymentOf({
    fullPrice: r.full_price_minor,
    total: r.total_payments,
    linked: r.occurrences,
    paidAmount: r.paid_amount,
    paidBefore: r.paid_before,
    expected,
  })
  const remainingAmount = remaining === null ? null : lastPayment !== null ? (remaining - 1) * expected + lastPayment : remaining * expected
  const alerts: RecurringAlert[] = []
  if (r.status === 'active') {
    if (daysBetween(r.next_due_date, todayDate) > matchWindow(r.cadence)) alerts.push('missing')
    if (r.last_amount !== null && !amountWithin(r.last_amount, r.expected_amount_minor, r.amount_tolerance_pct)) {
      alerts.push('price_changed')
    }
  }
  return {
    id: r.id,
    name: r.title,
    payee: r.name,
    payeeKey: r.payee_key,
    categoryId: r.category_id,
    accountId: r.account_id,
    expectedAmountMinor: expected,
    amountTolerancePct: r.amount_tolerance_pct,
    cadence: r.cadence,
    anchorDate: r.anchor_date,
    secondDay: r.second_day,
    nextDueDate: r.next_due_date,
    status: r.status,
    origin: r.origin,
    detectionScore: r.detection_score,
    occurrences: r.occurrences,
    lastSeenDate: r.last_seen,
    lastAmountMinor: r.last_amount,
    alerts,
    monthlyCostMinor: Math.round(expected * (30.44 / info.days)),
    totalPayments: r.total_payments,
    paidPayments: paid,
    remainingPayments: remaining,
    remainingAmountMinor: remainingAmount,
    totalAmountMinor: remainingAmount === null ? null : r.paid_amount + r.paid_before * expected + remainingAmount,
    endDate: remaining === null ? null : remaining > 0 ? lastDue : r.last_seen,
    fullPriceMinor: r.full_price_minor,
    lastPaymentMinor: lastPayment,
    instalmentService: isInstalmentService(r.payee_key),
    stopped: r.status === 'suggested' && (remaining === 0 || (r.last_seen !== null && !stillGoing(r.cadence, r.last_seen, todayDate))),
    otherPayees: (JSON.parse(r.other_payees) as string[]).sort(),
    possiblePayment: r.status === 'active' ? possiblePayment(ctx, r, todayDate) : null,
  }
}

/** Payees that look like the same one: "PayHub" and "PayHub Tax" (the app's usual bar for the same merchant). */
const SIMILAR_PAYEE = 0.5

/**
 * An unlinked payment that may be the item's, and the due date it would be for. Near its next due date:
 * from a similar payee within its price variation (the bank started sending "PayHub" for "PayHub Tax"), or
 * from its own payee at a new amount (a price change). A plan's, also after its next due date's window
 * (it doesn't take a late payment without asking), and for its last payment at what's left of its full
 * price, or without one any amount up to half as much again (`role` last). Then a plan's first payment
 * that's missing (`role` first): its own payee's, in the period before its first one, at exactly what
 * makes its payments add up to its full price (a down payment). Otherwise, for a due date in its history
 * without a payment (newest first): its own payees' payment within half a period, within the price
 * variation of its nearest payment (one that came early or late, outside the date's window). The
 * closest amount, then date.
 */
function possiblePayment(ctx: AppContext, r: ItemRow, todayDate: ISODate): RecurringItem['possiblePayment'] {
  const keys = [r.payee_key, ...(JSON.parse(r.other_keys) as string[])]
  const window = matchWindow(r.cadence)
  const unlinked = (from: ISODate, to: ISODate) =>
    ctx.sqlite
      .prepare(
        `SELECT id, date, payee, payee_key AS payeeKey, amount_minor AS amount FROM transactions
         WHERE deleted_at IS NULL AND recurring_item_id IS NULL AND transfer_pair_id IS NULL AND date BETWEEN ? AND ?
           AND (? IS NULL OR account_id = ?)
           AND id NOT IN (SELECT transaction_id FROM recurring_not_payments WHERE item_id = ?)`,
      )
      .all(from, to, r.account_id, r.account_id, r.id) as Array<{ id: number; date: string; payee: string; payeeKey: string; amount: number }>
  const offer = (t: { id: number; date: string; payee: string; amount: number }, dueDate: ISODate, newAmount: boolean, role: 'first' | 'last' | null = null) => ({
    transactionId: t.id,
    date: t.date,
    payee: t.payee,
    amountMinor: t.amount,
    newAmount,
    role,
    dueDate,
  })
  const closest = <T extends { amount: number; date: string }>(rows: T[], amount: number, due: ISODate) =>
    rows.sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount) || Math.abs(daysBetween(a.date, due)) - Math.abs(daysBetween(b.date, due)))[0]

  const within = (t: { amount: number }) => amountWithin(t.amount, r.expected_amount_minor, r.amount_tolerance_pct)
  const plan = r.total_payments !== null
  const remaining = plan ? r.total_payments! - r.occurrences - r.paid_before : null
  const lastPayment = lastPaymentOf({
    fullPrice: r.full_price_minor,
    total: r.total_payments,
    linked: r.occurrences,
    paidAmount: r.paid_amount,
    paidBefore: r.paid_before,
    expected: r.expected_amount_minor,
  })
  // A plan's last payment is often what's left of its price: its full price says what, or else any amount up to half as much again.
  const isLast = remaining === 1
  const lastLike = (t: { amount: number }) =>
    Math.sign(t.amount) === Math.sign(r.expected_amount_minor) &&
    (Math.abs(t.amount) <= Math.abs(r.expected_amount_minor) * 1.5 || (lastPayment !== null && amountWithin(t.amount, lastPayment, r.amount_tolerance_pct)))
  const maybeNew = (t: { amount: number }) => (isLast ? lastLike(t) : amountWithin(t.amount, r.expected_amount_minor, SAME_ITEM_PCT))
  // A plan's payment after its due date's window: asked about, not linked on its own.
  const late = (t: { date: string }) => plan && t.date > addDays(r.next_due_date, window)
  const until = plan && todayDate > addDays(r.next_due_date, window) ? todayDate : addDays(r.next_due_date, window)
  const next = closest(
    unlinked(addDays(r.next_due_date, -window), until).filter((t) =>
      keys.includes(t.payeeKey)
        ? // Its own payee's, beyond the variation (but not wildly): maybe a new price, or a plan's last payment. Or a plan's late one.
          (!within(t) && maybeNew(t)) || (late(t) && within(t))
        : keys.some((k) => payeeSimilarity(k, t.payeeKey) >= SIMILAR_PAYEE) && within(t),
    ),
    isLast && lastPayment !== null ? lastPayment : r.expected_amount_minor,
    r.next_due_date,
  )
  if (next) {
    const role = isLast && !within(next) ? 'last' : null
    return offer(next, r.next_due_date, !within(next) && !role, role)
  }

  // A plan's first payment, missing before its others: one that makes its payments add up to its full price,
  // to the cent (a down payment), only while they don't (what's left isn't its amount).
  const schedule = { cadence: r.cadence, anchorDate: r.anchor_date, secondDay: r.second_day, nextDueDate: r.next_due_date }
  if (lastPayment !== null && r.paid_before === 0 && !amountWithin(lastPayment, r.expected_amount_minor, r.amount_tolerance_pct)) {
    const first = ctx.sqlite
      .prepare(
        `SELECT t.date, d.due_date AS due, coalesce(d.one_off, 0) AS oneOff FROM transactions t
         LEFT JOIN recurring_payment_dues d ON d.item_id = t.recurring_item_id AND d.transaction_id = t.id
         WHERE t.recurring_item_id = ? AND t.deleted_at IS NULL ORDER BY t.date, t.id LIMIT 1`,
      )
      .get(r.id) as { date: string; due: string | null; oneOff: number } | undefined
    if (first && !first.oneOff) {
      const period = Math.ceil(cadenceInfo(r.cadence).days)
      const found = unlinked(addDays(first.date, -(period + window)), first.date)
        .filter((t) => keys.includes(t.payeeKey) && Math.abs(t.amount - lastPayment) <= 1)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0]
      const firstDue = first.due ?? duesCovering(schedule, first.date, first.date, window).at(-1)!
      if (found) return offer(found, stepDue(schedule, firstDue, -1), false, 'first')
    }
  }

  // A gap in its history: a due date between its first and latest payments that has none.
  const paid = ctx.sqlite
    .prepare(
      `SELECT t.date, t.amount_minor AS amount, d.due_date AS due, coalesce(d.one_off, 0) AS oneOff FROM transactions t
       LEFT JOIN recurring_payment_dues d ON d.item_id = t.recurring_item_id AND d.transaction_id = t.id
       WHERE t.recurring_item_id = ? AND t.deleted_at IS NULL ORDER BY t.date`,
    )
    .all(r.id) as Array<{ date: string; amount: number; due: string | null; oneOff: number }>
  if (paid.length < 2) return null
  const dues = duesCovering(schedule, paid[0]!.date, paid[paid.length - 1]!.date, window)
  const periodOf = (date: string) => dues.find((d) => addDays(d, -window) <= date)
  const covered = new Set(paid.map((t) => t.due ?? periodOf(t.date)))
  const half = Math.floor(cadenceInfo(r.cadence).days / 2)
  for (const due of dues) {
    if (covered.has(due)) continue
    // Compared with its payment nearest in time (its amount then), not one at its own amount.
    const usual = paid.filter((t) => !t.oneOff)
    const nearest = [...(usual.length ? usual : paid)].sort((a, b) => Math.abs(daysBetween(a.date, due)) - Math.abs(daysBetween(b.date, due)))[0]!
    const found = closest(
      unlinked(addDays(due, -half), addDays(due, half)).filter((t) => keys.includes(t.payeeKey) && amountWithin(t.amount, nearest.amount, r.amount_tolerance_pct)),
      nearest.amount,
      due,
    )
    if (found) return offer(found, due, false)
  }
  return null
}

/** A payment to link to an item: one that isn't another item's, or a transfer. */
function paymentToLink(ctx: AppContext, txId: number) {
  const tx = ctx.sqlite
    .prepare(
      `SELECT payee, payee_key AS payeeKey, date, account_id AS accountId, amount_minor AS amount, recurring_item_id AS recurringItemId,
         transfer_pair_id AS transferPairId
       FROM transactions WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(txId) as
    | { payee: string; payeeKey: string; date: string; accountId: number; amount: number; recurringItemId: number | null; transferPairId: number | null }
    | undefined
  if (!tx) notFound('Transaction not found')
  if (tx.recurringItemId) badRequest('That payment already belongs to a recurring item')
  if (tx.transferPairId) badRequest('That’s a transfer, not a payment')
  return tx
}

/**
 * Says a payment is the item's, for the due date it was offered for (`possiblePayment`), which it stays
 * even if it came early or late. From another payee: the payee becomes one of its own (its payments
 * match from then on), and others like it are linked. At a new amount: that's the item's amount from
 * this due date on, and its earlier payments are checked against the old one. But a plan's last
 * payment at another amount is its remainder, not a new price: it's added at its own (`addPayment`).
 */
export function linkPossiblePayment(ctx: AppContext, itemId: number, txId: number): RecurringItem {
  const item = getRecurring(ctx, itemId)
  const tx = paymentToLink(ctx, txId)
  const stored = ctx.sqlite.prepare('SELECT expected_amount_minor FROM recurring_items WHERE id = ?').pluck().get(itemId) as number
  const row = ctx.sqlite.prepare(`${ITEM_SQL} WHERE r.id = ?`).get(itemId) as ItemRow
  const offered = item.status === 'active' ? possiblePayment(ctx, row, today(ctx)) : null
  // A plan's first or last payment it asked about, or its last at another amount: at its own amount.
  if (offered?.transactionId === txId && offered.role) return addPayment(ctx, itemId, txId)
  if (item.remainingPayments === 1 && !amountWithin(tx.amount, stored, item.amountTolerancePct)) return addPayment(ctx, itemId, txId)
  // The due date it's for: the one it was offered for, or the one whose window it's in.
  const window = matchWindow(item.cadence)
  const due = offered?.transactionId === txId ? offered.dueDate : duesCovering(item, tx.date, tx.date, window).at(-1)!
  ctx.sqlite.transaction(() => {
    if (tx.payeeKey !== item.payeeKey) {
      ctx.sqlite.prepare('INSERT OR IGNORE INTO recurring_payees (item_id, payee_key, name) VALUES (?, ?, ?)').run(itemId, tx.payeeKey, tx.payee)
    }
    if (!amountWithin(tx.amount, stored, item.amountTolerancePct)) {
      ctx.sqlite
        .prepare('INSERT OR REPLACE INTO recurring_price_changes (item_id, from_date, previous_amount_minor) VALUES (?, ?, ?)')
        .run(itemId, due, stored)
      ctx.sqlite.prepare('UPDATE recurring_items SET expected_amount_minor = ? WHERE id = ?').run(tx.amount, itemId)
    }
    ctx.sqlite.prepare('DELETE FROM recurring_not_payments WHERE item_id = ? AND transaction_id = ?').run(itemId, txId)
    ctx.sqlite.prepare('INSERT OR REPLACE INTO recurring_payment_dues (item_id, transaction_id, due_date) VALUES (?, ?, ?)').run(itemId, txId, due)
    ctx.sqlite.prepare('UPDATE transactions SET recurring_item_id = ? WHERE id = ?').run(itemId, txId)
  })()
  recalculateRecurring(ctx, itemId, { followAmount: true })
  return getRecurring(ctx, itemId)
}

/**
 * Adds a payment to an item by hand, at its own amount: a plan's down payment, a first payment that
 * covers part of a period, its last one (the remainder), or any the app didn't link. It's a payment
 * like the others, counted and categorized, but the item's amount stays: it's no price change, and
 * later payments still match the usual amount. Its payee isn't added to the item's.
 *
 * It's for the due date whose period it's in, and an extra payment there: the one due then is still
 * expected (a down payment a few days before the first payment, a charge besides the bill). A plan takes
 * no more payments than it has, and one from before its other payments and its next due date was one of
 * those paid before your history, if you said there were some. An active or ended item, in the item's
 * account and the same way (money out or in).
 */
export function addPayment(ctx: AppContext, itemId: number, txId: number): RecurringItem {
  const item = getRecurring(ctx, itemId)
  if (item.status !== 'active' && item.status !== 'ended') badRequest('Confirm it first, then add its payments')
  const tx = paymentToLink(ctx, txId)
  if (Math.sign(tx.amount) !== Math.sign(item.expectedAmountMinor)) {
    badRequest(item.expectedAmountMinor < 0 ? 'That’s money in, and this item is money out' : 'That’s money out, and this item is money in')
  }
  if (item.accountId !== null && tx.accountId !== item.accountId) badRequest('That’s from another account than the item’s')
  const paidBefore = ctx.sqlite.prepare('SELECT paid_before FROM recurring_items WHERE id = ?').pluck().get(itemId) as number
  const linked = ctx.sqlite
    .prepare(
      `SELECT t.date, d.due_date AS due FROM transactions t
       LEFT JOIN recurring_payment_dues d ON d.item_id = t.recurring_item_id AND d.transaction_id = t.id
       WHERE t.recurring_item_id = ? AND t.deleted_at IS NULL ORDER BY t.date, t.id`,
    )
    .all(itemId) as Array<{ date: string; due: string | null }>
  const plan = item.totalPayments
  const window = matchWindow(item.cadence)
  // Before the plan's other payments, and its next one isn't due yet: one of those paid before your history.
  const fromBefore =
    plan !== null && paidBefore > 0 && tx.date < addDays(item.nextDueDate, -window) && (!linked.length || tx.date < linked[0]!.date)
  if (plan !== null && linked.length + paidBefore - (fromBefore ? 1 : 0) >= plan) {
    badRequest(`${recurringLabel(item)} has all ${plan} payments already. Take one off first, or change how many it has.`)
  }
  const due = duesCovering(item, tx.date, tx.date, window).at(-1)!

  const wasPaidOff = paidOff(ctx, itemId)
  ctx.sqlite.transaction(() => {
    if (fromBefore) ctx.sqlite.prepare('UPDATE recurring_items SET paid_before = paid_before - 1 WHERE id = ?').run(itemId)
    ctx.sqlite.prepare('DELETE FROM recurring_not_payments WHERE item_id = ? AND transaction_id = ?').run(itemId, txId)
    ctx.sqlite
      .prepare('INSERT OR REPLACE INTO recurring_payment_dues (item_id, transaction_id, due_date, one_off) VALUES (?, ?, ?, ?)')
      .run(itemId, txId, due, fromBefore ? FROM_BEFORE : 1)
    ctx.sqlite.prepare('UPDATE transactions SET recurring_item_id = ? WHERE id = ?').run(itemId, txId)
  })()
  recalculateRecurring(ctx, itemId, { wasPaidOff })
  return getRecurring(ctx, itemId)
}

/**
 * Says a payment isn't the item's: one of its payments that shouldn't be (it's taken off and left
 * uncategorized), or one offered as a possible payment. It isn't linked or offered again.
 */
export function notItsPayment(ctx: AppContext, itemId: number, txId: number): RecurringItem {
  getRecurring(ctx, itemId)
  const linked = ctx.sqlite.prepare('SELECT recurring_item_id FROM transactions WHERE id = ?').pluck().get(txId) === itemId
  const wasPaidOff = paidOff(ctx, itemId)
  ctx.sqlite.transaction(() => {
    ctx.sqlite.prepare('INSERT OR IGNORE INTO recurring_not_payments (item_id, transaction_id) VALUES (?, ?)').run(itemId, txId)
    giveBackPaidBefore(ctx, itemId, [txId])
    ctx.sqlite.prepare('DELETE FROM recurring_payment_dues WHERE item_id = ? AND transaction_id = ?').run(itemId, txId)
    if (linked) unlinkPayment(ctx, itemId, txId)
  })()
  if (linked) recalculateRecurring(ctx, itemId, { removed: true, followAmount: true, wasPaidOff })
  return getRecurring(ctx, itemId)
}

/**
 * Added payments taken off (or deleted) that were among a plan's payments from before your history:
 * they count as paid before again.
 */
function giveBackPaidBefore(ctx: AppContext, itemId: number, txIds: number[]) {
  const n = ctx.sqlite
    .prepare(`SELECT count(*) FROM recurring_payment_dues WHERE item_id = ? AND one_off = ${FROM_BEFORE} AND transaction_id IN (SELECT value FROM json_each(?))`)
    .pluck()
    .get(itemId, JSON.stringify(txIds)) as number
  if (n) ctx.sqlite.prepare('UPDATE recurring_items SET paid_before = paid_before + ? WHERE id = ?').run(n, itemId)
}

export function listRecurring(ctx: AppContext, status?: RecurringStatus): RecurringItem[] {
  const rows = (
    status
      ? ctx.sqlite.prepare(`${ITEM_SQL} WHERE r.status = ? ORDER BY r.next_due_date`).all(status)
      : ctx.sqlite.prepare(`${ITEM_SQL} ORDER BY r.next_due_date`).all()
  ) as ItemRow[]
  const t = today(ctx)
  return rows.map((r) => toDTO(ctx, r, t))
}

export function getRecurring(ctx: AppContext, id: number): RecurringItem {
  const row = ctx.sqlite.prepare(`${ITEM_SQL} WHERE r.id = ?`).get(id) as ItemRow | undefined
  if (!row) notFound('Recurring item not found')
  return toDTO(ctx, row, today(ctx))
}

/** An item's payments, newest first: the linked ones, or for a suggestion, the ones the scan found. */
export function recurringPaymentIds(ctx: AppContext, id: number): number[] {
  const row = ctx.sqlite.prepare(`${ITEM_SQL} WHERE r.id = ?`).get(id) as ItemRow | undefined
  if (!row) notFound('Recurring item not found')
  if (row.status === 'suggested') return suggestedPayments(ctx, row).map((t) => t.id)
  return ctx.sqlite
    .prepare('SELECT id FROM transactions WHERE recurring_item_id = ? AND deleted_at IS NULL ORDER BY date DESC, id DESC')
    .pluck()
    .all(id) as number[]
}

/** Links an unlinked transaction to a matching active recurring item. Returns the item id. */
export function matchRecurring(ctx: AppContext, txId: number): number | null {
  const tx = ctx.sqlite
    .prepare(
      `SELECT id, account_id AS accountId, date, amount_minor AS amount, payee_key AS payeeKey, category_id AS categoryId,
         recurring_item_id AS recurringItemId, transfer_pair_id AS transferPairId
       FROM transactions WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(txId) as
    | { id: number; accountId: number; date: string; amount: number; payeeKey: string; categoryId: number | null; recurringItemId: number | null; transferPairId: number | null }
    | undefined
  if (!tx || tx.recurringItemId || tx.transferPairId) return null

  const items = ctx.sqlite
    .prepare(
      `SELECT r.id, payee_key AS payeeKey, cadence, anchor_date AS anchorDate, second_day AS secondDay, next_due_date AS nextDueDate,
         expected_amount_minor AS expected, amount_tolerance_pct AS tolerance, category_id AS categoryId, total_payments AS total,
         paid_before AS paidBefore, full_price_minor AS fullPrice,
         (SELECT count(*) FROM transactions t WHERE t.recurring_item_id = r.id AND t.deleted_at IS NULL) AS linked,
         (SELECT coalesce(sum(t.amount_minor), 0) FROM transactions t WHERE t.recurring_item_id = r.id AND t.deleted_at IS NULL) AS paidAmount
       FROM recurring_items r
       WHERE status = 'active' AND (payee_key = @key OR id IN (SELECT item_id FROM recurring_payees WHERE payee_key = @key))
         AND (account_id IS NULL OR account_id = @account)`,
    )
    .all({ key: tx.payeeKey, account: tx.accountId }) as Array<{
    id: number
    payeeKey: string
    tolerance: number
    cadence: Cadence
    anchorDate: string
    secondDay: number | null
    nextDueDate: string
    expected: number
    categoryId: number | null
    total: number | null
    paidBefore: number
    fullPrice: number | null
    linked: number
    paidAmount: number
  }>

  // What each expects next: its amount, and a plan with one payment to go also what's left of its full price.
  const expecting = new Map(
    items.map((i) => {
      const last = i.total !== null && i.total - i.linked - i.paidBefore === 1 ? lastPaymentOf({ ...i }) : null
      return [i.id, last === null ? [i.expected] : [i.expected, last]] as const
    }),
  )
  const gapTo = (item: (typeof items)[number]) => Math.min(...expecting.get(item.id)!.map((e) => Math.abs(tx.amount - e)))
  // With several items from one payee (iCloud and Apple Music, two Klarna plans), the closest amount first.
  items.sort((a, b) => gapTo(a) - gapTo(b))
  for (const item of items) {
    const window = matchWindow(item.cadence)
    // Early payments within the window, or any later payment (a late or missed-then-paid bill). A plan's
    // much later than its due date is asked about instead (`possiblePayment`): it may be another plan's.
    if (daysBetween(tx.date, item.nextDueDate) > window) continue
    if (item.total !== null && daysBetween(item.nextDueDate, tx.date) > window) continue
    // Further off is a new amount, to ask about (`possiblePayment`).
    if (!expecting.get(item.id)!.some((e) => amountWithin(tx.amount, e, item.tolerance))) continue

    let next = item.nextDueDate
    while (daysBetween(tx.date, next) <= window) next = stepDue(item, next)

    ctx.sqlite.transaction(() => {
      ctx.sqlite.prepare('UPDATE transactions SET recurring_item_id = ? WHERE id = ?').run(item.id, tx.id)
      ctx.sqlite.prepare('UPDATE recurring_items SET next_due_date = ? WHERE id = ?').run(next, item.id)
      applyItemCategory(ctx, item.id)
      followLatestAmount(ctx, item.id)
      settleInstalments(ctx, item.id)
    })()
    return item.id
  }
  return null
}

/**
 * Works out which payments are the item's from what it is now (its payees, amount, price variation,
 * schedule, account, number of payments), and its next due date from them. Runs after every change to
 * the item or its payments.
 *
 * Each due date has a period, from `window` days before it until `window` days before the next one, and
 * at most one payment: from one of its payees, within the price variation, the closest to the amount.
 * Going back in time the amount follows the payments found (prices drift), except a plan's, and before a
 * price change you accepted it's the old one. A plan keeps no more than it has. Payments from another account than the
 * item's, ones closer to another item's amount from the same payee, and ones you said aren't its are left
 * out; a stopped item only loses payments. The next due date is the one after the latest payment's (it
 * only moves back when a payment was taken off, and not before one you just set). Returns how many were unlinked.
 */
function relink(ctx: AppContext, itemId: number, opts: { keepNextDue?: boolean; removed?: boolean } = {}): number {
  const item = ctx.sqlite
    .prepare(
      `SELECT payee_key AS payeeKey, account_id AS accountId, expected_amount_minor AS expected, cadence, status,
         anchor_date AS anchorDate, second_day AS secondDay, next_due_date AS nextDueDate, amount_tolerance_pct AS tolerance, total_payments AS total,
         paid_before AS paidBefore, full_price_minor AS fullPrice
       FROM recurring_items WHERE id = ?`,
    )
    .get(itemId) as
    | (KnownItem & { accountId: number | null; tolerance: number; paidBefore: number; fullPrice: number | null; status: RecurringStatus })
    | undefined
  if (!item || (item.status !== 'active' && item.status !== 'ended')) return 0
  // An added payment that was deleted: if it was one paid before your history, it's that again.
  const gone = ctx.sqlite
    .prepare(
      `SELECT d.transaction_id FROM recurring_payment_dues d JOIN transactions t ON t.id = d.transaction_id
       WHERE d.item_id = ? AND d.one_off <> 0 AND t.deleted_at IS NOT NULL`,
    )
    .pluck()
    .all(itemId) as number[]
  if (gone.length) {
    giveBackPaidBefore(ctx, itemId, gone)
    item.paidBefore = ctx.sqlite.prepare('SELECT paid_before FROM recurring_items WHERE id = ?').pluck().get(itemId) as number
    ctx.sqlite.prepare('DELETE FROM recurring_payment_dues WHERE item_id = ? AND transaction_id IN (SELECT value FROM json_each(?))').run(itemId, JSON.stringify(gone))
  }
  const others = ctx.sqlite
    .prepare(`SELECT expected_amount_minor FROM recurring_items WHERE payee_key = ? AND status = 'active' AND id <> ?`)
    .pluck()
    .all(item.payeeKey, itemId) as number[]
  const keys = [item.payeeKey, ...(ctx.sqlite.prepare('SELECT payee_key FROM recurring_payees WHERE item_id = ?').pluck().all(itemId) as string[])]
  // Its payees' payments: linked to it, or to nothing yet.
  const txs = ctx.sqlite
    .prepare(
      `SELECT id, date, amount_minor AS amount, payee_key AS payeeKey, account_id AS accountId, recurring_item_id AS itemId FROM transactions
       WHERE deleted_at IS NULL AND transfer_pair_id IS NULL AND (recurring_item_id IS NULL OR recurring_item_id = ?)
         AND payee_key IN (SELECT value FROM json_each(?))
         AND id NOT IN (SELECT transaction_id FROM recurring_not_payments WHERE item_id = ?)
       ORDER BY date, id`,
    )
    .all(itemId, JSON.stringify(keys), itemId) as Array<{ id: number; date: string; amount: number; payeeKey: string; accountId: number; itemId: number | null }>
  const linking = item.status === 'active'
  const candidates = txs.filter((t) => (item.accountId === null || t.accountId === item.accountId) && (linking || t.itemId === itemId))
  // Payments linked to it another way (by hand, from another payee) keep their due dates.
  const fixed = ctx.sqlite
    .prepare(
      'SELECT id, date, amount_minor AS amount FROM transactions WHERE recurring_item_id = ? AND deleted_at IS NULL AND payee_key NOT IN (SELECT value FROM json_each(?))',
    )
    .all(itemId, JSON.stringify(keys)) as Array<{ id: number; date: string; amount: number }>
  // Payments added at their own amount (`addPayment`): extra ones, kept, that don't take a due date's place.
  const oneOff = new Set(
    ctx.sqlite.prepare('SELECT transaction_id FROM recurring_payment_dues WHERE item_id = ? AND one_off <> 0').pluck().all(itemId) as number[],
  )
  const extras = candidates.filter((t) => oneOff.has(t.id))
  const window = matchWindow(item.cadence)
  const gap = (t: { amount: number }, expected: number) => Math.abs(t.amount - expected)
  // Payments you said are its, each for a due date (one that came early or late stays that date's).
  const pinned = new Map(
    (ctx.sqlite.prepare('SELECT transaction_id AS id, due_date AS due FROM recurring_payment_dues WHERE item_id = ?').all(itemId) as Array<{ id: number; due: string }>).map(
      (p) => [p.id, p.due],
    ),
  )

  let matching: typeof candidates = []
  const dates = [...candidates.map((t) => t.date), ...fixed.map((f) => f.date), ...pinned.values()].sort()
  if (dates.length) {
    const dues = duesCovering(item, dates[0]!, dates[dates.length - 1]!, window)
    const periodOf = (date: string) => dues.find((d) => addDays(d, -window) <= date)
    const byDue = new Map<string, typeof candidates>()
    for (const t of candidates) {
      if (oneOff.has(t.id)) continue
      const due = pinned.get(t.id) ?? periodOf(t.date)
      if (due) byDue.set(due, [...(byDue.get(due) ?? []), t])
    }
    const taken = new Set(fixed.filter((f) => !oneOff.has(f.id)).map((f) => pinned.get(f.id) ?? periodOf(f.date)))
    // A plan's payment much later than its due date isn't taken without asking (`possiblePayment`): it may be another plan's.
    const onTime = (t: { date: string }, due: ISODate) => item.total === null || daysBetween(due, t.date) <= window
    const changes = ctx.sqlite
      .prepare('SELECT from_date AS fromDate, previous_amount_minor AS previous FROM recurring_price_changes WHERE item_id = ? ORDER BY from_date DESC')
      .all(itemId) as Array<{ fromDate: string; previous: number }>
    let amount = item.expected
    let change = 0
    for (const due of dues) {
      while (change < changes.length && due < changes[change]!.fromDate) amount = changes[change++]!.previous
      if (taken.has(due)) continue
      const ref = amount
      const here = byDue.get(due) ?? []
      // One you said is this date's comes first; otherwise the closest within the variation.
      const best =
        here.filter((t) => pinned.get(t.id) === due).sort((a, b) => gap(a, ref) - gap(b, ref))[0] ??
        here
          .filter(
            (t) => !pinned.has(t.id) && onTime(t, due) && amountWithin(t.amount, ref, item.tolerance) && others.every((o) => gap(t, o) >= gap(t, ref)),
          )
          .sort((a, b) => gap(a, ref) - gap(b, ref) || a.id - b.id)[0]
      if (!best) continue
      const newestFound = matching.length === 0
      matching.push(best)
      // Going back, the amount follows the payments found (prices drift), within the variation. Not a
      // plan's newest: its last payment is often a little different, and isn't what the ones before it
      // are compared with.
      if (amountWithin(best.amount, ref, item.tolerance) && !(item.total !== null && newestFound)) amount = best.amount
    }
    matching.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))

    // A plan with a full price and one payment to go: its last is what's left of the price (after all its
    // payments: the ones found, added ones and ones from other payees), in the period after its latest's.
    const newest = matching[matching.length - 1]
    const besides = [...extras, ...fixed]
    if (newest && item.total !== null && item.fullPrice !== null && item.paidBefore + besides.length + matching.length === item.total - 1) {
      const paid = [...matching, ...besides].reduce((n, t) => n + t.amount, 0)
      const last = item.fullPrice - paid - item.paidBefore * item.expected
      const due = stepDue(item, pinned.get(newest.id) ?? periodOf(newest.date)!)
      const found = (taken.has(due) ? [] : (byDue.get(due) ?? []))
        .filter((t) => !pinned.has(t.id) && onTime(t, due) && Math.sign(last) === Math.sign(item.expected) && amountWithin(t.amount, last, item.tolerance))
        .sort((a, b) => gap(a, last) - gap(b, last) || a.id - b.id)[0]
      if (found) matching.push(found)
    }
  }
  // A plan keeps no more payments than it has: the newest, besides its added ones and other payees'.
  if (item.total !== null) matching = matching.slice(-Math.max(0, item.total - item.paidBefore - extras.length - fixed.length))
  matching.push(...extras)
  const wanted = new Set(matching.map((t) => t.id))
  const unlink = txs.filter((t) => t.itemId === itemId && !wanted.has(t.id))
  const link = matching.filter((t) => t.itemId !== itemId)

  ctx.sqlite.transaction(() => {
    for (const t of unlink) unlinkPayment(ctx, itemId, t.id)
    const add = ctx.sqlite.prepare('UPDATE transactions SET recurring_item_id = ? WHERE id = ?')
    for (const t of link) add.run(itemId, t.id)
    const latest = ctx.sqlite.prepare('SELECT max(date) FROM transactions WHERE recurring_item_id = ? AND deleted_at IS NULL').pluck().get(itemId) as string | null
    if (!latest) return
    const after = stepDue(item, duesCovering(item, latest, latest, window).at(-1)!)
    const back = (unlink.length > 0 || !!opts.removed) && !opts.keepNextDue
    const next = back || after > item.nextDueDate ? after : item.nextDueDate
    ctx.sqlite.prepare('UPDATE recurring_items SET next_due_date = ? WHERE id = ?').run(next, itemId)
  })()
  return unlink.length
}

/** Due dates, newest first: from the one whose period holds `to` back to the one whose period holds `from`. */
function duesCovering(item: Scheduled & { nextDueDate: string }, from: ISODate, to: ISODate, window: number): ISODate[] {
  let due = item.nextDueDate
  while (addDays(due, -window) <= to) due = stepDue(item, due)
  const out: ISODate[] = []
  do {
    due = stepDue(item, due, -1)
    out.push(due)
  } while (addDays(due, -window) > from)
  return out
}

/** Takes a payment off its recurring item. The item's category comes off too: it's uncategorized (and so are its refunds). */
function unlinkPayment(ctx: AppContext, itemId: number, txId: number) {
  const itemCategory = ctx.sqlite.prepare('SELECT category_id FROM recurring_items WHERE id = ?').pluck().get(itemId) as number | null
  const tx = ctx.sqlite.prepare('SELECT category_id AS categoryId, category_source AS source FROM transactions WHERE id = ?').get(txId) as {
    categoryId: number | null
    source: string | null
  }
  ctx.sqlite.prepare('UPDATE transactions SET recurring_item_id = NULL WHERE id = ?').run(txId)
  if (tx.source === 'recurring' || (itemCategory !== null && tx.categoryId === itemCategory)) {
    ctx.sqlite
      .prepare(
        `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(txId)
  }
}

/**
 * After a change to a recurring item or its payments: its payments, next due date and category, its
 * amount following the latest payment (`followAmount`), and whether a plan is paid off. A plan that
 * was paid off and lost a payment is active again; one you stopped stays stopped. A caller that took
 * a payment off first says whether it was paid off before (`wasPaidOff`).
 */
export function recalculateRecurring(
  ctx: AppContext,
  itemId: number,
  opts: { keepNextDue?: boolean; removed?: boolean; followAmount?: boolean; wasPaidOff?: boolean } = {},
) {
  const wasPaidOff = opts.wasPaidOff ?? paidOff(ctx, itemId)
  relink(ctx, itemId, opts)
  settleInstalments(ctx, itemId, wasPaidOff)
  // Back to active: it can take its payments again.
  if (wasPaidOff && !paidOff(ctx, itemId)) relink(ctx, itemId)
  applyItemCategory(ctx, itemId)
  if (opts.followAmount) followLatestAmount(ctx, itemId)
  settleInstalments(ctx, itemId)
}

/** A plan with all its payments made. */
export function paidOff(ctx: AppContext, id: number) {
  const row = ctx.sqlite.prepare('SELECT total_payments AS total, paid_before AS paidBefore FROM recurring_items WHERE id = ?').get(id) as
    | { total: number | null; paidBefore: number }
    | undefined
  return !!row && row.total !== null && linkedCount(ctx, id) + row.paidBefore >= row.total
}

/**
 * A recurring item's payments share one category: setting it on one of them (or none) sets it on the
 * item and on all the others.
 */
export function setItemCategory(ctx: AppContext, itemId: number, categoryId: number | null) {
  ctx.sqlite.prepare('UPDATE recurring_items SET category_id = ? WHERE id = ?').run(categoryId, itemId)
  if (categoryId) return applyItemCategory(ctx, itemId)
  const ids = ctx.sqlite.prepare('SELECT id FROM transactions WHERE recurring_item_id = ? AND category_id IS NOT NULL').pluck().all(itemId) as number[]
  const clear = ctx.sqlite.prepare(
    `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  )
  for (const id of ids) clear.run(id)
}

/**
 * An item's category is on all its payments: set when they're linked and whenever it changes, over
 * a payee's, AI's or one set by hand. Their refunds follow them. An item without one leaves them be.
 */
function applyItemCategory(ctx: AppContext, itemId: number) {
  const categoryId = ctx.sqlite.prepare('SELECT category_id FROM recurring_items WHERE id = ?').pluck().get(itemId) as number | null
  if (!categoryId) return
  const ids = ctx.sqlite
    .prepare('SELECT id FROM transactions WHERE recurring_item_id = ? AND (category_id IS NOT ? OR needs_review = 1)')
    .pluck()
    .all(itemId, categoryId) as number[]
  const set = ctx.sqlite.prepare(
    `UPDATE transactions SET category_id = ?, category_source = 'recurring', category_confidence = NULL, needs_review = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  )
  for (const id of ids) set.run(categoryId, id)
}

/**
 * The item's amount becomes its latest payment's while that's within the price variation, so it
 * follows small changes (a bill that varies, a cent of rounding). Beyond it, it stays: that's a
 * price change, flagged until you update the amount. An instalment plan's final payment (often a
 * little different) doesn't count, and nor does one added at its own amount (`addPayment`).
 */
function followLatestAmount(ctx: AppContext, id: number) {
  ctx.sqlite
    .prepare(
      `UPDATE recurring_items SET expected_amount_minor = latest.amount
       FROM (SELECT amount_minor AS amount FROM transactions t WHERE recurring_item_id = ? AND deleted_at IS NULL AND NOT ${ONE_OFF('?', 't.id')}
             ORDER BY date DESC, id DESC LIMIT 1) AS latest
       WHERE id = ? AND (latest.amount > 0) = (expected_amount_minor > 0)
         AND abs(latest.amount - expected_amount_minor) <= max(abs(expected_amount_minor) * amount_tolerance_pct / 100.0, 1)
         AND (total_payments IS NULL
           OR paid_before + (SELECT count(*) FROM transactions WHERE recurring_item_id = ? AND deleted_at IS NULL) < total_payments)`,
    )
    .run(id, id, id, id)
}

/**
 * Semi-monthly needs its other day: the one you gave, or one that goes with the first (if the first
 * moved onto the other day, they swap). Other schedules have none.
 */
function settleSecondDay(ctx: AppContext, id: number, before: RecurringItem) {
  const row = ctx.sqlite.prepare('SELECT cadence, anchor_date AS anchorDate, second_day AS secondDay FROM recurring_items WHERE id = ?').get(id) as Scheduled
  const set = ctx.sqlite.prepare('UPDATE recurring_items SET second_day = ? WHERE id = ?')
  if (row.cadence !== 'semimonthly') {
    if (row.secondDay !== null) set.run(null, id)
    return
  }
  const first = Number(row.anchorDate.slice(8, 10))
  const same = row.secondDay === first || (row.secondDay === 31 && isMonthEnd(row.anchorDate))
  if (row.secondDay !== null && !same) return
  const was = before.cadence === 'semimonthly' ? Number(before.anchorDate.slice(8, 10)) : null
  set.run(same && was !== null && was !== first ? was : semiMonthlyPartner(first), id)
}

/** Linked payments of an item. */
function linkedCount(ctx: AppContext, id: number) {
  return ctx.sqlite.prepare('SELECT count(*) FROM transactions WHERE recurring_item_id = ? AND deleted_at IS NULL').pluck().get(id) as number
}

/** "Paid so far" for an instalment plan: what isn't linked came before your history. */
function setPaidSoFar(ctx: AppContext, id: number, paid: number) {
  ctx.sqlite.prepare('UPDATE recurring_items SET paid_before = ? WHERE id = ?').run(Math.max(0, paid - linkedCount(ctx, id)), id)
}

/**
 * An instalment plan whose last payment is made ends. With `reopen` (its payments changed), an
 * ended one with payments to go is back on.
 */
function settleInstalments(ctx: AppContext, id: number, reopen = false) {
  const row = ctx.sqlite.prepare('SELECT status, total_payments AS total, paid_before AS paidBefore FROM recurring_items WHERE id = ?').get(id) as
    | { status: RecurringStatus; total: number | null; paidBefore: number }
    | undefined
  if (!row || row.total === null) return
  const paid = linkedCount(ctx, id) + row.paidBefore
  if (paid >= row.total && row.status === 'active') ctx.sqlite.prepare("UPDATE recurring_items SET status = 'ended' WHERE id = ?").run(id)
  else if (reopen && paid < row.total && row.status === 'ended') ctx.sqlite.prepare("UPDATE recurring_items SET status = 'active' WHERE id = ?").run(id)
}

/** A full price is a plan's, the same way as its amount (money out or in). */
function checkFullPrice(fullPrice: number | null | undefined, plan: { total: number | null; expected: number }) {
  if (fullPrice == null) return
  if (plan.total === null) badRequest('Only an instalment plan has a full price. Say how many payments it has.')
  if (Math.sign(fullPrice) !== Math.sign(plan.expected)) badRequest(`The full price is money ${plan.expected < 0 ? 'out' : 'in'}, like its payments.`)
}

/** The account and category an item is given exist (an archived one is fine: it's the item's already). */
function checkReferences(ctx: AppContext, input: { accountId?: number | null; categoryId?: number | null }) {
  if (input.accountId != null && !ctx.sqlite.prepare('SELECT 1 FROM accounts WHERE id = ?').get(input.accountId)) badRequest('That account does not exist')
  if (input.categoryId != null && !ctx.sqlite.prepare('SELECT 1 FROM categories WHERE id = ?').get(input.categoryId)) {
    badRequest('That category does not exist')
  }
}

export function createRecurring(ctx: AppContext, input: CreateInput): RecurringItem {
  checkReferences(ctx, input)
  checkFullPrice(input.fullPriceMinor, { total: input.totalPayments, expected: input.expectedAmountMinor })
  const payeeKey = payeeKeyOf(ctx, input.payee)
  const id = Number(
    ctx.sqlite
      .prepare(
        `INSERT INTO recurring_items (name, title, payee_key, category_id, account_id, expected_amount_minor, amount_tolerance_pct,
           cadence, anchor_date, second_day, next_due_date, status, origin, total_payments, full_price_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'manual', ?, ?)`,
      )
      .run(
        input.payee,
        input.name,
        payeeKey,
        input.categoryId,
        input.accountId,
        input.expectedAmountMinor,
        input.amountTolerancePct,
        input.cadence,
        input.anchorDate,
        input.cadence === 'semimonthly' ? (input.secondDay ?? semiMonthlyPartner(Number(input.anchorDate.slice(8, 10)))) : null,
        input.anchorDate,
        input.totalPayments,
        input.totalPayments === null ? null : (input.fullPriceMinor ?? null),
      ).lastInsertRowid,
  )
  relink(ctx, id)
  followLatestAmount(ctx, id)
  applyItemCategory(ctx, id)
  if (input.paidPayments !== undefined) setPaidSoFar(ctx, id, input.paidPayments)
  settleInstalments(ctx, id)
  return getRecurring(ctx, id)
}

export function updateRecurring(ctx: AppContext, id: number, input: UpdateInput): RecurringItem {
  const before = getRecurring(ctx, id)
  checkReferences(ctx, input)
  const stored = ctx.sqlite.prepare('SELECT expected_amount_minor FROM recurring_items WHERE id = ?').pluck().get(id) as number
  checkFullPrice(input.fullPriceMinor, {
    total: input.totalPayments !== undefined ? input.totalPayments : before.totalPayments,
    expected: input.expectedAmountMinor ?? stored,
  })
  const cols: Record<string, string> = {
    name: 'title',
    payee: 'name',
    categoryId: 'category_id',
    accountId: 'account_id',
    expectedAmountMinor: 'expected_amount_minor',
    amountTolerancePct: 'amount_tolerance_pct',
    cadence: 'cadence',
    nextDueDate: 'next_due_date',
    status: 'status',
    totalPayments: 'total_payments',
    fullPriceMinor: 'full_price_minor',
    secondDay: 'second_day',
  }
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const [key, col] of Object.entries(cols)) {
    const value = input[key as keyof UpdateInput]
    if (value === undefined) continue
    sets.push(`${col} = @${key}`)
    params[key] = value
  }
  if (input.nextDueDate) {
    sets.push('anchor_date = @nextDueDate')
  }
  if (sets.length) {
    sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    ctx.sqlite.prepare(`UPDATE recurring_items SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  // No longer a plan: no payments from before your history, and no full price.
  if (input.totalPayments === null) ctx.sqlite.prepare('UPDATE recurring_items SET paid_before = 0, full_price_minor = NULL WHERE id = ?').run(id)
  if (input.otherPayees) setOtherPayees(ctx, id, before.payeeKey, input.otherPayees)
  settleSecondDay(ctx, id, before)
  // Every change: its payments again from what it is now. The amount follows the latest payment when
  // it's confirmed, not when you just set it; the next due date stays where you put it.
  const wasPaidOff = before.remainingPayments === 0
  relink(ctx, id, { keepNextDue: input.nextDueDate !== undefined && input.nextDueDate !== before.nextDueDate })
  if (input.status === 'active' || input.expectedAmountMinor === undefined) followLatestAmount(ctx, id)
  if (input.paidPayments !== undefined) setPaidSoFar(ctx, id, input.paidPayments)
  // A plan you gave more payments is active again once it isn't paid off; one you stopped stays stopped.
  settleInstalments(ctx, id, wasPaidOff && input.status !== 'ended')
  if (wasPaidOff && !paidOff(ctx, id)) relink(ctx, id)
  // A suggestion whose payments have stopped, confirmed: its payments linked, it's kept as ended.
  if (before.stopped && input.status === 'active') {
    ctx.sqlite.prepare("UPDATE recurring_items SET status = 'ended' WHERE id = ? AND status = 'active'").run(id)
  }
  applyItemCategory(ctx, id)
  return getRecurring(ctx, id)
}

function setOtherPayees(ctx: AppContext, id: number, ownKey: string, names: string[]) {
  ctx.sqlite.transaction(() => {
    ctx.sqlite.prepare('DELETE FROM recurring_payees WHERE item_id = ?').run(id)
    const add = ctx.sqlite.prepare('INSERT OR IGNORE INTO recurring_payees (item_id, payee_key, name) VALUES (?, ?, ?)')
    for (const name of names) {
      const key = payeeKeyOf(ctx, name)
      if (key && key !== ownKey) add.run(id, key, name)
    }
  })()
}

export function confirmRecurring(ctx: AppContext, id: number) {
  return updateRecurring(ctx, id, { status: 'active' })
}

export function dismissRecurring(ctx: AppContext, id: number) {
  return updateRecurring(ctx, id, { status: 'dismissed' })
}

export function deleteRecurring(ctx: AppContext, id: number) {
  ctx.sqlite.prepare('DELETE FROM recurring_items WHERE id = ?').run(id)
}


const weekday = (d: ISODate) => new Date(`${d}T00:00:00Z`).getUTCDay()
const isWeekend = (d: ISODate) => weekday(d) === 0 || weekday(d) === 6
const isMonthEnd = (d: ISODate) => addDays(d, 1).slice(8, 10) === '01'
const monthsPer: Partial<Record<Cadence, number>> = { monthly: 1, quarterly: 3, yearly: 12 }

/**
 * Where a payment `k` periods before `anchor` should be: its expected dates (two when the anchor
 * is the last day of a short month: the same day, and that month's end) and the window around
 * them, ± `days`, stretched over a weekend to the business day either side. A payment on a Monday
 * may have been due on the weekend before it, so its windows start two days earlier.
 */
/** `k` −1 looks one period after `anchor` instead (a plan's final payment). */
function lookback(anchor: ISODate, cadence: Cadence, k: number, days: number) {
  // Semi-monthly: the other payday half a month back (13 to 17 days, as months differ), and whole months
  // back from each, in turn: the same day every other step.
  const half = cadence === 'semimonthly'
  if (half && k > 0 && k % 2 === 0) return lookback(anchor, 'monthly', k / 2, days)
  const months = monthsPer[cadence]
  const expected = months
    ? [...new Set([addMonthsToDate(anchor, -k * months), ...(isMonthEnd(anchor) ? [addMonthsToDate(anchor, -k * months, 31)] : [])])]
    : half
      ? [addMonthsToDate(addDays(anchor, -15), -(k - 1) / 2)]
      : [addDays(anchor, -k * cadenceInfo(cadence).days)]
  const slack = half ? 2 : 0
  let from = addDays(expected[0]!, -days - slack - (weekday(anchor) === 1 ? 2 : 0))
  let to = addDays(expected[expected.length - 1]!, days + slack)
  while (isWeekend(from)) from = addDays(from, -1)
  while (isWeekend(to)) to = addDays(to, 1)
  return { expected, from, to }
}

/** How many due dates before the latest payment a pattern is looked for in: 3 in a row there, or 4 in all, make one. */
const LOOKBACK = 6

/** Payments still going: the next one, after `last`, isn't overdue by more than about half a period. */
const stillGoing = (cadence: Cadence, last: ISODate, todayDate: ISODate) => {
  const c = cadenceInfo(cadence)
  return daysBetween(last, todayDate) <= c.days * 1.5 + c.tolerance
}

interface DetectRow {
  id: number
  payeeKey: string
  payee: string
  date: string
  amount: number
  categoryId: number | null
  accountId: number
  recurringItemId: number | null
}

/**
 * Finds payments that repeat on a schedule and records them as suggestions. From each payee's latest
 * payment it tries every schedule, looking only where earlier payments would be: up to 6 due dates back,
 * give or take the date variation. A due date's payment is the closest one within the price variation of
 * the payment found after it (prices drift); one without is a gap (a payment that came early, say). A
 * schedule with 3 payments in a row, or 4 in all (weekly: 3 in a row), is suggested: of those, the one
 * that covers the most of its due dates. One that's stopped is too, for your history (`stopped`). Other payments from the payee (another
 * subscription, say) don't matter, unless payments of that amount are as common between the windows as
 * in them (a coffee you buy every few days isn't a schedule). Payments that already belong to an item, or
 * match one in any status (a dismissed one too), are skipped.
 */
export function detectRecurring(ctx: AppContext): { created: number } {
  const { priceVariationPct: pct, dateVariationDays: days } = recurringDetection(ctx.meta)
  const todayDate = today(ctx)
  const rows = ctx.sqlite
    .prepare(
      `SELECT t.id, t.payee_key AS payeeKey, t.payee, t.date, t.amount_minor AS amount, t.category_id AS categoryId,
         t.account_id AS accountId, t.recurring_item_id AS recurringItemId
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.deleted_at IS NULL AND t.transfer_pair_id IS NULL AND COALESCE(c.exclude_from_totals, 0) = 0
         AND t.date <= ? AND t.payee_key <> '' AND t.amount_minor <> 0
       ORDER BY t.payee_key, t.date, t.id`,
    )
    .all(todayDate) as DetectRow[]
  const items = ctx.sqlite
    .prepare(
      `SELECT payee_key AS payeeKey, expected_amount_minor AS expected, amount_tolerance_pct AS tolerance, cadence, anchor_date AS anchorDate,
         second_day AS secondDay, next_due_date AS nextDueDate, total_payments AS total
       FROM recurring_items`,
    )
    .all() as KnownItem[]
  const otherPayees = ctx.sqlite
    .prepare(
      `SELECT p.payee_key AS payeeKey, r.expected_amount_minor AS expected, r.amount_tolerance_pct AS tolerance, r.cadence, r.anchor_date AS anchorDate,
         r.second_day AS secondDay, r.next_due_date AS nextDueDate, r.total_payments AS total
       FROM recurring_payees p JOIN recurring_items r ON r.id = p.item_id`,
    )
    .all() as KnownItem[]
  // An item's payment: from its payee (or another you said is its), within its price variation, on its
  // schedule. Another amount from the payee is a series of its own (or a price change, asked about).
  const known = (r: DetectRow) =>
    [...items, ...otherPayees].some((i) => i.payeeKey === r.payeeKey && amountWithin(r.amount, i.expected, i.tolerance) && onSchedule(i, r.date))

  // Each payee's money in and money out apart, oldest first.
  const groups = new Map<string, DetectRow[]>()
  for (const r of rows) {
    const key = `${r.payeeKey}|${Math.sign(r.amount)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }

  const addPayee = ctx.sqlite.prepare('INSERT OR IGNORE INTO recurring_payees (item_id, payee_key, name) VALUES (?, ?, ?)')
  // What the payee is called: by your rule, by AI tidying, or as sent.
  const shownPayee = (raw: string) => payeeNameOf(ctx, raw).name
  const insert = ctx.sqlite.prepare(
    `INSERT INTO recurring_items (name, title, payee_key, category_id, account_id, expected_amount_minor, amount_tolerance_pct,
       cadence, anchor_date, second_day, next_due_date, status, origin, detection_score, total_payments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', 'detected', ?, ?)`,
  )
  let created = 0
  const used = new Set<number>()
  /** `history`: series that have stopped too, after every one still going has been found. */
  const scanGroup = (list: DetectRow[], history: boolean) => {
    const dates = list.map((r) => r.date)
    const first = dates[0]!
    const within = (from: string, to: string) => list.slice(lowerBound(dates, from), lowerBound(dates, addDays(to, 1)))
    for (let i = list.length - 1; i >= 0; i--) {
      const anchor = list[i]!
      if (used.has(anchor.id) || anchor.recurringItemId || known(anchor)) continue
      // Still going: the next payment isn't overdue by more than about half a period.
      const going = (cadence: Cadence) => stillGoing(cadence, anchor.date, todayDate)
      // An instalment plan: the anchor and up to `earlier` payments before it, each one period before the
      // one found after it (a plan's payments are scheduled from the last, so a day late each time doesn't
      // add up), until a window is empty.
      const seriesFor = (cadence: Cadence, earlier: number) => {
        const series = [anchor]
        let daysOff = 0
        for (let k = 1; k <= earlier; k++) {
          const w = lookback(series[series.length - 1]!.date, cadence, 1, days)
          const off = (t: DetectRow) => Math.min(...w.expected.map((e) => Math.abs(daysBetween(e, t.date))))
          const hit = within(w.from, w.to)
            .filter((t) => !used.has(t.id) && !t.recurringItemId && !series.includes(t) && amountWithin(t.amount, anchor.amount, pct))
            .sort((a, b) => off(a) - off(b) || Math.abs(a.amount - anchor.amount) - Math.abs(b.amount - anchor.amount))[0]
          if (!hit) break
          series.push(hit)
          daysOff += off(hit)
        }
        return { series, daysOff }
      }
      /**
       * The anchor and, up to `LOOKBACK` due dates back, each one's payment: the closest to it, within the
       * price variation of the one found after it (prices drift). A due date without one is a gap; ones
       * before the payee's first payment don't count. `run`: the most in a row; `coverage`: the share paid.
       */
      const scan = (cadence: Cadence) => {
        const hits: Array<{ k: number; t: DetectRow }> = [{ k: 0, t: anchor }]
        let amount = anchor.amount
        let daysOff = 0
        let dues = 1
        // Monthly and longer: at least the schedule's own leeway (a bill paid on the 25th to the 28th).
        // Shorter ones keep the date variation, or their windows would cover most days.
        const spread = monthsPer[cadence] ? Math.max(days, cadenceInfo(cadence).tolerance) : days
        for (let k = 1; k <= LOOKBACK; k++) {
          const w = lookback(anchor.date, cadence, k, spread)
          if (w.to < first) break
          dues++
          const ref = amount
          const off = (t: DetectRow) => Math.min(...w.expected.map((e) => Math.abs(daysBetween(e, t.date))))
          const hit = within(w.from, w.to)
            .filter((t) => !used.has(t.id) && !t.recurringItemId && !hits.some((h) => h.t === t) && amountWithin(t.amount, ref, pct))
            .sort((a, b) => off(a) - off(b) || Math.abs(a.amount - ref) - Math.abs(b.amount - ref))[0]
          if (!hit) continue
          hits.push({ k, t: hit })
          amount = hit.amount
          daysOff += off(hit)
        }
        let run = 0
        for (let i = 0, streak = 0; i < hits.length; i++) {
          streak = i > 0 && hits[i]!.k === hits[i - 1]!.k + 1 ? streak + 1 : 1
          run = Math.max(run, streak)
        }
        return { hits, daysOff, run, coverage: hits.length / dues }
      }
      // Payments of this amount as often between the windows as in them: frequent, not scheduled.
      // (Not counting another item's: PayHub's tax payments near its utilities' amount are the tax.)
      const frequent = (series: DetectRow[]) =>
        within(series[series.length - 1]!.date, anchor.date).filter(
          (t) => !used.has(t.id) && !series.includes(t) && !t.recurringItemId && !known(t) && amountWithin(t.amount, anchor.amount, pct),
        ).length >= series.length
      /**
       * Payments of this amount that a weekly, biweekly or semi-monthly schedule can't account for. A coffee
       * bought on most weekdays lands in such a schedule's windows often enough to make one, but anywhere in
       * them, and on other days as often. A bill lands on its date, and there are no others. So: over the
       * due dates looked back at, more payments of this amount besides the schedule's than a quarter of its
       * own. Or its payments on average more than 0.4 of the date variation from their dates (one day off in
       * three is fine, every other one isn't), or the whole variation for semi-monthly, whose dates are
       * approximate. One due on a weekend and paid the Friday before or the Monday after is on its date.
       * Monthly and longer schedules have windows a coffee rarely fits: they're left as they were.
       */
      const scattered = (cadence: Cadence, series: DetectRow[]) => {
        if (cadence !== 'weekly' && cadence !== 'biweekly' && cadence !== 'semimonthly') return false
        const spread = monthsPer[cadence] ? Math.max(days, cadenceInfo(cadence).tolerance) : days
        const windows: Array<ReturnType<typeof lookback>> = []
        // The anchor's own window, then each due date's before it (semi-monthly's lookback starts at the other payday).
        for (let k = 0; k <= LOOKBACK; k++) {
          const w = lookback(anchor.date, k === 0 && cadence === 'semimonthly' ? 'monthly' : cadence, k, spread)
          if (w.to < first) break
          windows.push(w)
        }
        const from = windows.reduce((d, w) => (w.from < d ? w.from : d), anchor.date)
        // All of them, also ones another suggestion took (it's how often you pay this), but not another item's.
        const others = within(from, anchor.date).filter((t) => !series.includes(t) && !t.recurringItemId && amountWithin(t.amount, anchor.amount, pct))
        if (others.length > series.length / 4) return true
        const limit = (cadence === 'semimonthly' ? 1 : 0.4) * Math.max(1, days)
        const onDate = (due: ISODate, date: ISODate) => {
          const dates = weekday(due) === 6 ? [due, addDays(due, -1), addDays(due, 2)] : weekday(due) === 0 ? [due, addDays(due, -2), addDays(due, 1)] : [due]
          return Math.min(...dates.map((d) => Math.abs(daysBetween(d, date))))
        }
        const offs = series.filter((t) => t !== anchor).map((t) => Math.min(...windows.flatMap((w) => w.expected.map((e) => onDate(e, t.date)))))
        return offs.length > 0 && offs.reduce((a, b) => a + b, 0) / offs.length > limit
      }
      /**
       * `finished`: a plan that's been paid off, which ends at `last` (its final payment, which may be a
       * little different) and is suggested at its usual amount.
       */
      const suggest = (
        series: DetectRow[],
        daysOff: number,
        cadence: Cadence,
        total: number | null,
        finished?: { last: DetectRow; amount: number; tolerance: number },
        otherPayday?: DetectRow,
      ) => {
        const day = Number(anchor.date.slice(8, 10))
        const anchorDay = !monthsPer[cadence] ? undefined : isMonthEnd(anchor.date) ? Math.max(...series.map((t) => Number(t.date.slice(8, 10)))) : day
        // Semi-monthly: the latest payday and the one half a month before (a month's end stands for its last day, 31).
        let schedule: Scheduled = { cadence, anchorDate: anchor.date }
        if (cadence === 'semimonthly') {
          const other = (otherPayday ?? series[1]!).date
          schedule = isMonthEnd(anchor.date)
            ? { cadence, anchorDate: other, secondDay: 31 }
            : { cadence, anchorDate: anchor.date, secondDay: isMonthEnd(other) ? 31 : Number(other.slice(8, 10)) }
        }
        if (finished) schedule = { cadence, anchorDate: finished.last.date }
        const payee = shownPayee(anchor.payee)
        // A buy-now-pay-later plan is named after the store, when its description says ("KLARNA*DYSON").
        const store = isInstalmentService(anchor.payeeKey) ? (series.map((t) => instalmentStore(t.payee)).find((s) => s) ?? null) : null
        const score = 1 - 0.5 * (daysOff / (series.length - 1) / (days + 2))
        const nextDueDate = finished
          ? stepDue(schedule, finished.last.date)
          : cadence === 'semimonthly'
            ? stepDue(schedule, anchor.date)
            : advanceDate(anchor.date, cadence, anchorDay)
        const amount = finished?.amount ?? anchor.amount
        const all = finished ? [...series, finished.last] : series
        // Paid from more than one account: from any.
        const accountId = all.every((t) => t.accountId === anchor.accountId) ? anchor.accountId : null
        const itemId = insert.run(
          payee,
          store,
          anchor.payeeKey,
          anchor.categoryId ?? series.find((t) => t.categoryId)?.categoryId ?? null,
          accountId,
          amount,
          finished?.tolerance ?? pct,
          cadence,
          schedule.anchorDate,
          schedule.secondDay ?? null,
          nextDueDate,
          Number(Math.max(0.5, score).toFixed(2)),
          total,
        ).lastInsertRowid
        // Its payments under other names (the bank's description changed) are its other payees.
        const tolerance = finished?.tolerance ?? pct
        const others = new Map(all.filter((t) => t.payeeKey !== anchor.payeeKey).map((t) => [t.payeeKey, shownPayee(t.payee)]))
        for (const [key, name] of others) {
          addPayee.run(itemId, key, name)
          otherPayees.push({ payeeKey: key, expected: amount, tolerance, ...schedule, nextDueDate, total })
        }
        for (const t of all) used.add(t.id)
        items.push({ payeeKey: anchor.payeeKey, expected: amount, tolerance, ...schedule, nextDueDate, total })
        created++
      }

      /**
       * A buy-now-pay-later plan that's been paid off, to keep in your history: Pay in 4 (4 payments
       * 2 weeks apart) or a monthly plan of 3 or more, counted back to its first payment. A final payment
       * a month after these, of a different amount (the plan's remainder), is its last.
       */
      const finishedPlan = (cadence: 'biweekly' | 'monthly') => {
        const { series, daysOff } = seriesFor(cadence, cadence === 'biweekly' ? PAY_IN_4 - 1 : 120)
        const w = lookback(anchor.date, cadence, -1, days)
        const final =
          cadence === 'monthly'
            ? within(w.from, w.to).find((t) => !used.has(t.id) && !t.recurringItemId && t.date > anchor.date && amountWithin(t.amount, anchor.amount, SAME_ITEM_PCT))
            : undefined
        const payments = series.length + (final ? 1 : 0)
        if ((cadence === 'biweekly' ? payments !== PAY_IN_4 : payments < 3) || frequent(series)) return false
        const last = final ?? anchor
        // Pay in 4 is done after its 4th payment; a monthly plan, once its payments have stopped.
        if (cadence === 'monthly' && daysBetween(last.date, todayDate) <= cadenceInfo(cadence).days * 1.5 + cadenceInfo(cadence).tolerance) return false
        const amounts = series.map((t) => t.amount).sort((a, b) => a - b)
        const amount = amounts[Math.floor(amounts.length / 2)]!
        const off = Math.max(...[...series, last].map((t) => Math.abs(t.amount - amount) / Math.abs(amount)))
        suggest(series, daysOff, cadence, payments, { last, amount, tolerance: Math.max(pct, Math.ceil(off * 100)) })
        return true
      }

      if (isInstalmentService(anchor.payeeKey)) {
        // Pay in 4 from a buy-now-pay-later service: found after 2 payments 2 weeks apart.
        if (going('biweekly')) {
          const { series, daysOff } = seriesFor('biweekly', PAY_IN_4 - 1)
          if (series.length >= 2 && series.length < PAY_IN_4 && !frequent(series)) {
            suggest(series, daysOff, 'biweekly', PAY_IN_4)
            continue
          }
        }
        if (finishedPlan('biweekly') || finishedPlan('monthly')) continue
      }
      // Every schedule, still going or stopped: the one that covers the most of its due dates (the shorter
      // on a tie: a monthly payment also pays every other semi-monthly date), with 3 payments in a row
      // or 4 in all. Weekly needs 3 in a row: its windows cover most days, so 4 scattered ones are luck.
      let best: (ReturnType<typeof scan> & { cadence: Cadence }) | null = null
      for (const { value: cadence } of CADENCES) {
        if (!history && !going(cadence)) continue
        const found = scan(cadence)
        const enough = found.run >= 3 || (cadence !== 'weekly' && found.hits.length >= 4)
        // Semi-monthly needs its other payday (an odd number of half months back).
        if (!enough || (cadence === 'semimonthly' && !found.hits.some((h) => h.k % 2 === 1))) continue
        if (frequent(found.hits.map((h) => h.t)) || scattered(cadence, found.hits.map((h) => h.t))) continue
        if (!best || found.coverage > best.coverage) best = { ...found, cadence }
      }
      if (best) {
        const other = best.hits.find((h) => h.k % 2 === 1)?.t
        suggest(
          best.hits.map((h) => h.t),
          best.daysOff,
          best.cadence,
          null,
          undefined,
          other,
        )
      }
    }
  }
  // Each payee, then payees with alike names together, for a series that the bank's changing description
  // split up. What's still going first. Then what's stopped, alike names first: an older wording on its
  // own has stopped too, and would cut the series at the change.
  const alike = alikeGroups(groups)
  for (const list of groups.values()) scanGroup(list, false)
  for (const list of alike) scanGroup(list, false)
  for (const list of alike) scanGroup(list, true)
  for (const list of groups.values()) scanGroup(list, true)
  return { created }
}

/**
 * Payees whose names are alike ("PayHub Utilities", "PayHub" and "PayHub Rent": the bank's description
 * changed), money in and out apart, joined into one list each (oldest first) where there's more than one
 * name. Alike: `payeeSimilarity` of 0.5 or more (the app's bar for the same merchant), directly or through
 * another of the names. Amounts still keep their payments apart (PayHub's tax, utilities and insurance).
 */
function alikeGroups(groups: Map<string, DetectRow[]>): DetectRow[][] {
  const keys = [...groups.keys()]
  const parent = new Map(keys.map((k) => [k, k]))
  const root = (k: string): string => {
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(k, r)
    return r
  }
  // Only names that share a word can be alike.
  const byWord = new Map<string, string[]>()
  for (const key of keys) {
    const [payee, sign] = key.split('|') as [string, string]
    for (const word of new Set(payee.split(' ').filter((w) => w.length > 1))) byWord.set(`${word}|${sign}`, [...(byWord.get(`${word}|${sign}`) ?? []), key])
  }
  for (const names of byWord.values()) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i]!, names[j]!]
        if (root(a) !== root(b) && payeeSimilarity(a.split('|')[0]!, b.split('|')[0]!) >= SIMILAR_PAYEE) parent.set(root(a), root(b))
      }
    }
  }
  const joined = new Map<string, string[]>()
  for (const key of keys) joined.set(root(key), [...(joined.get(root(key)) ?? []), key])
  return [...joined.values()]
    .filter((names) => names.length > 1)
    .map((names) => names.flatMap((k) => groups.get(k)!).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)))
}

interface KnownItem extends Scheduled {
  payeeKey: string
  expected: number
  /** Price variation (%): an instalment plan's payments are within it. */
  tolerance: number
  nextDueDate: string
  /** An instalment plan: it covers only as many periods either side of its next payment as it has payments. */
  total: number | null
}

/** Whether `date` is within the matching window of one of the item's due dates, before or after its next one. */
function onSchedule(item: KnownItem, date: ISODate) {
  const window = matchWindow(item.cadence)
  const limit = item.total ?? Infinity
  for (let k = 0, due = item.nextDueDate; k <= limit && due >= addDays(date, -window); k++, due = stepDue(item, due, -1)) {
    if (Math.abs(daysBetween(due, date)) <= window) return true
  }
  for (let k = 0, due = item.nextDueDate; k <= limit && due <= addDays(date, window); k++, due = stepDue(item, due)) {
    if (Math.abs(daysBetween(due, date)) <= window) return true
  }
  return false
}

/** The first index whose date is on or after `date` (dates ascending). */
function lowerBound(dates: string[], date: string) {
  let lo = 0
  let hi = dates.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid]! < date) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function upcomingPayments(ctx: AppContext, days = 30): UpcomingPayment[] {
  const todayDate = today(ctx)
  const horizon = addDays(todayDate, days)
  const items = listRecurring(ctx, 'active')
  const out: UpcomingPayment[] = []
  for (const item of items) {
    let due = item.nextDueDate
    // An instalment plan stops at its last payment.
    const left = item.remainingPayments ?? Infinity
    for (let i = 0; i < 12 && i < left && due <= horizon; i++) {
      out.push({
        recurringItemId: item.id,
        name: item.name,
        payee: item.payee,
        dueDate: due,
        // A plan's last payment: what's left of its full price, when it has one.
        amountMinor: i === left - 1 && item.lastPaymentMinor !== null ? item.lastPaymentMinor : item.expectedAmountMinor,
        categoryId: item.categoryId,
        accountId: item.accountId,
        overdue: due < todayDate,
        paymentNumber: item.totalPayments === null ? null : item.paidPayments + i + 1,
        totalPayments: item.totalPayments,
      })
      due = stepDue(item, due)
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}
