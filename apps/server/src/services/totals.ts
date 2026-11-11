import type { ISODate } from '@chipmunk/shared'
import type { AppContext } from './context'

/** Transactions that count toward totals: not transfers, and not in a category marked "exclude from totals". */
export const COUNTABLE = `t.deleted_at IS NULL AND t.transfer_pair_id IS NULL AND COALESCE(c.exclude_from_totals, 0) = 0`

/** A `transaction_lines` line (t, with its category c) that's spending, or income (see reports.ts). */
export const IS_SPENDING = `(c.is_income = 0 OR (c.id IS NULL AND (t.amount_minor < 0 OR t.link_kind IS NOT NULL)))`
export const IS_INCOME = `(c.is_income = 1 OR (c.id IS NULL AND t.amount_minor > 0 AND t.link_kind IS NULL))`

/**
 * Each account's countable transactions from the 1st of the month up to each date (dates ascending).
 * For a credit card that's the month's spending, less refunds: payments are transfers, so they're left out.
 */
export function monthToDate(ctx: AppContext, dates: ISODate[], accountId?: number): Map<number, number[]> {
  const out = new Map<number, number[]>()
  if (!dates.length) return out
  const monthStart = (d: ISODate) => `${d.slice(0, 7)}-01`
  const rows = ctx.q.all<{ accountId: number; date: string; total: number }>(
    `SELECT t.account_id AS accountId, t.date, sum(t.amount_minor) AS total
     FROM transactions t LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND ${COUNTABLE} AND t.date BETWEEN ? AND ?${accountId === undefined ? '' : ' AND t.account_id = ?'}
     GROUP BY t.account_id, t.date`,
    monthStart(dates[0]!),
    dates[dates.length - 1]!,
    ...(accountId === undefined ? [] : [accountId]),
  )
  for (const r of rows) {
    const sums = out.get(r.accountId) ?? dates.map(() => 0)
    dates.forEach((d, i) => {
      if (r.date >= monthStart(d) && r.date <= d) sums[i]! += r.total
    })
    out.set(r.accountId, sums)
  }
  return out
}
