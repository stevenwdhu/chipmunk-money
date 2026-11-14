import {
  accountTypeInfo,
  addMonths,
  addDays,
  monthOf,
  monthRange,
  monthsBetween,
  type AccountType,
  type CategoryAmount,
  type FilterSide,
  type FilteredOut,
  type ISODate,
  type MonthKey,
  type MonthSummary,
  type NetWorthReport,
  type PayeeTotal,
  type PeriodSummary,
  type ReportFilter,
  type ReportPurchases,
  type TrendReport,
  chartColor,
  UNGROUPED_COLOR,
} from '@chipmunk/shared'
import { balancesAt } from './accounts'
import { listLabels } from './labels'
import type { AppContext } from './context'
import { compileFilter, listScope, OWNER_JOIN, RECURRING, reportScope, shareOf, type CompiledFilter } from './filters'
import { payeeNameOf } from './payee-namer'
import { today } from './settings'
import { COUNTABLE, IS_INCOME, IS_SPENDING } from './totals'
import { getTransactions, transactionSpan } from './transactions'

/**
 * Totals rules:
 *  - Transfers and categories marked "exclude from totals" are ignored.
 *  - Spending = money out in non-income categories (refunds in the same category reduce it).
 *  - Income = income categories; uncategorized money in also counts as income, uncategorized money out as spending.
 *  - Money in linked to purchases or bills (refunds, paybacks) counts in their categories, a payback on
 *    the bill's date, and only the rest of it in its own: reports read `transaction_lines`, a view
 *    with a line per link, not `transactions`. Counts are of transactions, not lines. Linked to an
 *    uncategorized purchase, it lowers that spending: it isn't income.
 */
const FROM = `FROM transaction_lines t
  LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
  LEFT JOIN ledger_category_groups g ON g.id = c.group_id AND g.ledger_id = t.ledger_id`

/** The ledger's lines: every report query's first condition (the ledger handle binds @ledger). */
const PIN = 't.ledger_id = @ledger'

/** Uncategorized money, and categories without a group (which have no colour). */
const UNCATEGORIZED = { name: 'Uncategorized', color: UNGROUPED_COLOR }

/** A report's filter: left out, everything counts (see services/filters.ts). */
type Filter = ReportFilter | null | undefined

function totals(ctx: AppContext, from: ISODate, to: ISODate, filter?: Filter) {
  const s = reportScope(filter)
  return ctx.q.get<{ spent: number; income: number; n: number; uncategorized: number }>(
    `SELECT
       coalesce(sum(CASE WHEN ${IS_SPENDING} THEN -t.amount_minor ELSE 0 END), 0) AS spent,
       coalesce(sum(CASE WHEN ${IS_INCOME} THEN t.amount_minor ELSE 0 END), 0) AS income,
       count(DISTINCT t.id) AS n,
       count(DISTINCT CASE WHEN t.category_id IS NULL THEN t.id END) AS uncategorized
     ${FROM}${s.join} WHERE ${PIN} AND ${COUNTABLE} AND t.date BETWEEN ? AND ?${s.where}`,
    from,
    to,
    s.params,
  )!
}

export function byCategory(ctx: AppContext, from: ISODate, to: ISODate, kind: 'expense' | 'income' = 'expense', filter?: Filter): CategoryAmount[] {
  const side = kind === 'expense' ? IS_SPENDING : IS_INCOME
  const sign = kind === 'expense' ? '-' : ''
  const s = reportScope(filter)
  const rows = ctx.q.all<CategoryAmount & { name: string | null; color: string | null }>(
    `SELECT t.category_id AS categoryId, c.name, g.color, c.group_id AS groupId, g.name AS groupName,
       sum(${sign}t.amount_minor) AS amountMinor, count(DISTINCT t.id) AS count
     ${FROM}${s.join} WHERE ${PIN} AND ${COUNTABLE} AND ${side} AND t.date BETWEEN ? AND ?${s.where}
     GROUP BY t.category_id ORDER BY amountMinor DESC`,
    from,
    to,
    s.params,
  )
  return rows.map((r) => ({
    ...r,
    name: r.name ?? UNCATEGORIZED.name,
    color: r.color ?? UNCATEGORIZED.color,
  }))
}

export function monthSummary(ctx: AppContext, month: MonthKey): MonthSummary {
  const { from, to } = monthRange(month)
  const cur = totals(ctx, from, to)
  const prev = totals(ctx, monthRange(addMonths(month, -1)).from, monthRange(addMonths(month, -1)).to)
  const avgFrom = monthRange(addMonths(month, -3)).from
  const avgTo = monthRange(addMonths(month, -1)).to
  const avg = totals(ctx, avgFrom, avgTo)
  const needsReview = ctx.q.get<{ n: number }>('SELECT count(*) AS n FROM transactions WHERE ledger_id = @ledger AND needs_review = 1 AND deleted_at IS NULL')!
  return {
    month,
    from,
    to,
    spentMinor: cur.spent,
    incomeMinor: cur.income,
    netMinor: cur.income - cur.spent,
    savingsRate: cur.income > 0 ? Number(((cur.income - cur.spent) / cur.income).toFixed(3)) : null,
    previousSpentMinor: prev.spent,
    averageSpentMinor: Math.round(avg.spent / 3),
    byCategory: byCategory(ctx, from, to),
    needsReviewCount: needsReview.n,
    transactionCount: cur.n,
    uncategorizedCount: cur.uncategorized,
  }
}

/**
 * Income, spending by group and category, and what was left out of totals for a period. Without
 * dates it covers everything: from the first transaction to today (or the last one, if later).
 * With a filter, all of it is what the filter counts, and `filteredOut` is what it filters out,
 * except `excluded`: transfers and what's left out of totals aren't the filter's to judge.
 */
export function periodSummary(ctx: AppContext, from?: ISODate, to?: ISODate, filter?: Filter): PeriodSummary {
  const now = today(ctx)
  const span = transactionSpan(ctx)
  const start = from ?? span.first ?? now
  const end = to ?? (span.last && span.last > now ? span.last : now)
  const s = reportScope(filter)
  const sums = totals(ctx, start, end, filter)

  const groupOrder = new Map(
    ctx.q.all<{ id: number; sort: number }>('SELECT id, sort FROM ledger_category_groups WHERE ledger_id = @ledger').map((g) => [g.id, g.sort]),
  )
  const groups = new Map<number | null, PeriodSummary['expenses'][number]>()
  for (const c of byCategory(ctx, start, end, 'expense', filter)) {
    const g = groups.get(c.groupId) ?? { groupId: c.groupId, name: c.groupName ?? 'Other', amountMinor: 0, categories: [] }
    g.amountMinor += c.amountMinor
    g.categories.push(c)
    groups.set(c.groupId, g)
  }
  const rank = (id: number | null) => (id === null ? Number.MAX_SAFE_INTEGER : (groupOrder.get(id) ?? 0))

  const excluded = ctx.q
    .all<CategoryAmount & { name: string | null; color: string | null }>(
      `SELECT t.category_id AS categoryId, c.name, g.color, c.group_id AS groupId, g.name AS groupName,
         sum(t.amount_minor) AS amountMinor, count(DISTINCT t.id) AS count
       ${FROM} WHERE ${PIN} AND t.deleted_at IS NULL AND (t.transfer_pair_id IS NOT NULL OR c.exclude_from_totals = 1)
         AND t.date BETWEEN ? AND ?
       GROUP BY t.category_id ORDER BY abs(sum(t.amount_minor)) DESC`,
      start,
      end,
    )
    .map((r) => ({ ...r, name: r.name ?? 'Transfer', color: r.color ?? '#9ca3af' }))

  // The same money by your category labels (a category with several labels counts under each).
  const byLabel = ctx.q.all<{ labelId: number; spentMinor: number; incomeMinor: number }>(
    `SELECT cl.label_id AS labelId,
       coalesce(sum(CASE WHEN ${IS_SPENDING} THEN -t.amount_minor ELSE 0 END), 0) AS spentMinor,
       coalesce(sum(CASE WHEN ${IS_INCOME} THEN t.amount_minor ELSE 0 END), 0) AS incomeMinor
     FROM transaction_lines t
       JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
       JOIN category_labels cl ON cl.category_id = c.id${s.join}
     WHERE ${PIN} AND ${COUNTABLE} AND t.date BETWEEN ? AND ?${s.where}
     GROUP BY cl.label_id`,
    start,
    end,
    s.params,
  )
  const labelItems = listLabels(ctx)
    .filter((l) => l.categoryCount > 0)
    .map((l) => {
      const sums = byLabel.find((r) => r.labelId === l.id)
      return { labelId: l.id, name: l.name, color: l.color, spentMinor: sums?.spentMinor ?? 0, incomeMinor: sums?.incomeMinor ?? 0 }
    })
  const unlabelled = ctx.q.get<{ spent: number }>(
    `SELECT coalesce(sum(-t.amount_minor), 0) AS spent ${FROM}${s.join}
     WHERE ${PIN} AND ${COUNTABLE} AND ${IS_SPENDING} AND t.date BETWEEN ? AND ?${s.where}
       AND NOT EXISTS (SELECT 1 FROM category_labels cl WHERE cl.category_id = c.id)`,
    start,
    end,
    s.params,
  )!

  return {
    from: start,
    to: end,
    months: monthsBetween(monthOf(start), monthOf(end)).length,
    incomeMinor: sums.income,
    spentMinor: sums.spent,
    netMinor: sums.income - sums.spent,
    income: byCategory(ctx, start, end, 'income', filter),
    expenses: [...groups.values()].sort((a, b) => rank(a.groupId) - rank(b.groupId)),
    excluded: { amountMinor: excluded.reduce((n, c) => n + c.amountMinor, 0), categories: excluded },
    labels: { items: labelItems, unlabelledSpentMinor: unlabelled.spent },
    transactionCount: sums.n,
    uncategorizedCount: sums.uncategorized,
    filteredOut: s.compiled && {
      spending: filteredOut(ctx, start, end, s.compiled, 'spending'),
      income: filteredOut(ctx, start, end, s.compiled, 'income'),
    },
  }
}

/**
 * What a side's filter filters out in a period, net of refunds (so it can be negative), and the
 * purchases (or deposits) it comes from. Each rule's and the picks' own share leaves out put back
 * ones, and rules can overlap, so they can add up to more than the total.
 */
function filteredOut(ctx: AppContext, from: ISODate, to: ISODate, f: CompiledFilter, side: FilterSide): FilteredOut {
  const s = f.sides[side]
  if (!s) return { amountMinor: 0, count: 0, byRule: [], picked: { amountMinor: 0, count: 0 } }
  const sign = side === 'spending' ? '-' : ''
  const notKept = s.keep ? ` AND NOT ${s.keep}` : ''
  const part = (when: string, as: string) =>
    `coalesce(sum(CASE WHEN ${when} THEN ${sign}t.amount_minor END), 0) AS ${as}_amount, count(DISTINCT CASE WHEN ${when} THEN t.owner_id END) AS ${as}_count`
  const parts = [
    part(s.filtered, 'total'),
    ...s.rules.map((r, i) => part(`(${s.only}) AND (${r})${notKept}`, `rule${i}`)),
    part(s.picked ? `(${s.only}) AND ${s.picked}${notKept}` : '0', 'picked'),
  ]
  const row = ctx.q.get<Record<string, number>>(
    `SELECT ${parts.join(',\n')} ${FROM}${f.join} WHERE ${PIN} AND ${COUNTABLE} AND ${side === 'spending' ? IS_SPENDING : IS_INCOME} AND t.date BETWEEN ? AND ?`,
    from,
    to,
    f.params,
  )!
  const of = (as: string) => ({ amountMinor: row[`${as}_amount`]!, count: row[`${as}_count`]! })
  return { ...of('total'), byRule: s.rules.map((_, i) => of(`rule${i}`)), picked: of('picked') }
}

export function trend(ctx: AppContext, endMonth: MonthKey, count: number, groupBy: 'category' | 'group', filter?: Filter): TrendReport {
  const months = monthsBetween(addMonths(endMonth, -(count - 1)), endMonth)
  const { from } = monthRange(months[0]!)
  const { to } = monthRange(endMonth)
  const s = reportScope(filter)
  const keyExpr = groupBy === 'group' ? `coalesce('g' || c.group_id, 'none')` : `coalesce('c' || t.category_id, 'none')`
  const nameExpr = groupBy === 'group' ? 'g.name' : 'c.name'
  // Groups have their colour; categories get chart colours below.
  const colorExpr = '(SELECT g2.color FROM ledger_category_groups g2 WHERE g2.ledger_id = @ledger AND g2.id = c.group_id)'
  const rows = ctx.q.all<{ month: string; key: string | null; name: string | null; color: string | null; spent: number; income: number }>(
    `SELECT substr(t.date, 1, 7) AS month,
       CASE WHEN ${IS_SPENDING} THEN ${keyExpr} ELSE NULL END AS key,
       max(${nameExpr}) AS name, max(${colorExpr}) AS color,
       sum(CASE WHEN ${IS_SPENDING} THEN -t.amount_minor ELSE 0 END) AS spent,
       sum(CASE WHEN ${IS_INCOME} THEN t.amount_minor ELSE 0 END) AS income
     ${FROM}${s.join} WHERE ${PIN} AND ${COUNTABLE} AND t.date BETWEEN ? AND ?${s.where}
     GROUP BY month, key`,
    from,
    to,
    s.params,
  )
  // The spending each month filters out.
  const out = s.compiled?.sides.spending
    ? ctx.q.all<{ month: string; spent: number }>(
        `SELECT substr(t.date, 1, 7) AS month, sum(-t.amount_minor) AS spent ${FROM}${s.join}
         WHERE ${PIN} AND ${COUNTABLE} AND ${IS_SPENDING} AND t.date BETWEEN ? AND ? AND ${s.compiled.sides.spending.filtered}
         GROUP BY month`,
        from,
        to,
        s.params,
      )
    : []

  const points = months.map((m) => ({
    month: m,
    spentMinor: 0,
    incomeMinor: 0,
    netMinor: 0,
    filteredOutMinor: out.find((o) => o.month === m)?.spent ?? 0,
    byKey: {} as Record<string, number>,
  }))
  const series = new Map<string, { key: string; name: string; color: string; totalMinor: number }>()
  for (const r of rows) {
    const p = points.find((x) => x.month === r.month)
    if (!p) continue
    p.spentMinor += r.spent
    p.incomeMinor += r.income
    if (r.key && r.spent) {
      p.byKey[r.key] = (p.byKey[r.key] ?? 0) + r.spent
      const s = series.get(r.key) ?? {
        key: r.key,
        name: r.key === 'none' ? UNCATEGORIZED.name : (r.name ?? UNCATEGORIZED.name),
        color: r.key === 'none' ? UNCATEGORIZED.color : (r.color ?? UNCATEGORIZED.color),
        totalMinor: 0,
      }
      s.totalMinor += r.spent
      series.set(r.key, s)
    }
  }
  for (const p of points) p.netMinor = p.incomeMinor - p.spentMinor
  const sorted = [...series.values()].sort((a, b) => b.totalMinor - a.totalMinor)
  // Split by category, each one gets the next easy-to-tell-apart chart colour; groups keep their own.
  if (groupBy === 'category') sorted.filter((s) => s.key !== 'none').forEach((s, i) => (s.color = chartColor(i)))
  return { months, points, series: sorted }
}

/** Spending by payee: each purchase's, less its refunds and paybacks (a friend's payback lowers the restaurant's, not their own). */
export function topPayees(ctx: AppContext, from: ISODate, to: ISODate, limit = 15, filter?: Filter): PayeeTotal[] {
  const s = reportScope(filter)
  const rows = ctx.q.all<PayeeTotal>(
    `SELECT o.payee_key AS payeeKey,
       (SELECT t2.payee FROM transactions t2 WHERE t2.ledger_id = @ledger AND t2.payee_key = o.payee_key ORDER BY t2.date DESC LIMIT 1) AS payee,
       sum(-t.amount_minor) AS amountMinor, count(DISTINCT t.owner_id) AS count,
       (SELECT t3.category_id FROM transactions t3 WHERE t3.ledger_id = @ledger AND t3.payee_key = o.payee_key AND t3.category_id IS NOT NULL
          GROUP BY t3.category_id ORDER BY count(*) DESC LIMIT 1) AS categoryId
     ${FROM} ${OWNER_JOIN} WHERE ${PIN} AND ${COUNTABLE} AND ${IS_SPENDING} AND t.date BETWEEN ? AND ?${s.where}
     GROUP BY o.payee_key HAVING amountMinor > 0 ORDER BY amountMinor DESC LIMIT ?`,
    from,
    to,
    limit,
    s.params,
  )
  // As the payee name rules call it.
  return rows.map((r) => ({ ...r, payee: payeeNameOf(ctx, r.payee).name }))
}

/** Spending and income by the tags of each purchase (or deposit): a purchase's less its refunds and paybacks. */
export function tagTotals(ctx: AppContext, from: ISODate, to: ISODate, filter?: Filter) {
  const s = reportScope(filter)
  return ctx.q.all<{ tagId: number; name: string; color: string | null; spentMinor: number; incomeMinor: number; count: number }>(
    `SELECT tg.id AS tagId, tg.name, tg.color,
       coalesce(sum(CASE WHEN ${IS_SPENDING} THEN -t.amount_minor ELSE 0 END), 0) AS spentMinor,
       coalesce(sum(CASE WHEN ${IS_INCOME} THEN t.amount_minor ELSE 0 END), 0) AS incomeMinor,
       count(DISTINCT t.owner_id) AS count
     FROM transaction_lines t
     ${OWNER_JOIN}
     JOIN transaction_tags tt ON tt.transaction_id = o.id
     JOIN tags tg ON tg.id = tt.tag_id AND tg.ledger_id = t.ledger_id
     LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
     WHERE ${PIN} AND ${COUNTABLE} AND t.date BETWEEN ? AND ?${s.where}
     GROUP BY tg.id ORDER BY spentMinor DESC`,
    from,
    to,
    s.params,
  )
}

/**
 * The biggest purchases (or deposits) a filter counts in a period, by your share, leaving out
 * recurring payments; or (`filtered-out`) what it filters out, by how much of it falls in the period.
 * Each with the rules that match it, and whether it's picked or put back.
 */
export function purchases(
  ctx: AppContext,
  q: { from: ISODate; to: ISODate; filter?: Filter; side?: FilterSide; set?: 'counted' | 'filtered-out'; limit?: number },
): ReportPurchases {
  const { side = 'spending', set = 'counted', limit = 20 } = q
  const compiled = compileFilter(q.filter)
  const s = compiled?.sides[side]
  const params = compiled?.params ?? {}
  const sign = side === 'spending' ? '-' : ''
  const lines = set === 'counted' ? (s?.counted ?? '1') : (s?.filtered ?? '0')
  // Counted: a purchase (or deposit) in the period, not a recurring payment.
  const own =
    set === 'counted'
      ? `HAVING max(t.id = t.owner_id AND t.link_kind IS NULL) = 1 AND o.amount_minor ${side === 'spending' ? '<' : '>'} 0
           AND NOT coalesce(o.recurring_item_id IN ${RECURRING}, 0)`
      : ''
  const rules = (s?.rules ?? []).map((r, i) => `max(${r}) AS rule${i}`)
  const sql = `SELECT t.owner_id AS id, sum(${sign}t.amount_minor) AS inRange, ${shareOf(side)} AS share,
       ${[...rules, `max(${s?.picked ?? '0'}) AS picked`, `max(${s?.keep ?? '0'}) AS kept`].join(', ')}
     ${FROM} ${OWNER_JOIN}
     WHERE ${PIN} AND ${COUNTABLE} AND ${side === 'spending' ? IS_SPENDING : IS_INCOME} AND t.date BETWEEN ? AND ? AND ${lines}
     GROUP BY t.owner_id ${own}`
  const all = ctx.q.all<Record<string, number>>(sql, q.from, q.to, params)
  const ranked = all.sort((a, b) => (set === 'counted' ? b.share! - a.share! : b.inRange! - a.inRange!) || b.id! - a.id!)
  const page = ranked.slice(0, limit)
  const txs = new Map(getTransactions(ctx, page.map((r) => r.id!)).map((t) => [t.id, t]))
  return {
    totalMinor: ranked.reduce((n, r) => n + r.inRange!, 0),
    count: ranked.length,
    items: page.flatMap((r) => {
      const transaction = txs.get(r.id!)
      if (!transaction) return []
      const matches = (s?.rules ?? []).flatMap((_, i) => (r[`rule${i}`] ? [i] : []))
      return [{ transaction, inRangeMinor: r.inRange!, shareMinor: r.share!, rules: matches, picked: !!r.picked, kept: !!r.kept && (matches.length > 0 || !!r.picked) }]
    }),
  }
}

/** Net worth at the end of each month in range, plus today: every account's balance, with debts owed counted as liabilities. */
export function netWorth(ctx: AppContext, months = 12): NetWorthReport {
  const t = today(ctx)
  const endMonth = monthOf(t)
  const dates = monthsBetween(addMonths(endMonth, -(months - 1)), addMonths(endMonth, -1)).map((m) => monthRange(m).to)
  dates.push(t)
  const accs = ctx.q.all<{ id: number; name: string; type: AccountType; archivedAt: string | null }>(
    'SELECT id, name, type, archived_at AS archivedAt FROM ledger_accounts WHERE ledger_id = @ledger ORDER BY sort, id',
  )
  const balances = balancesAt(ctx, dates)
  const value = (a: (typeof accs)[number], i: number) => balances.get(a.id)?.[i] ?? 0
  const points = dates.map((date, i) => {
    let assets = 0
    let liabilities = 0
    for (const a of accs) {
      const v = value(a, i)
      if (accountTypeInfo(a.type).liability) liabilities += -v
      else assets += v
    }
    return { date, assetsMinor: assets, liabilitiesMinor: liabilities, netWorthMinor: assets - liabilities }
  })
  return {
    points,
    current: points[points.length - 1]!,
    byAccount: accs
      .filter((a) => !a.archivedAt)
      .map((a) => ({
        accountId: a.id,
        name: a.name,
        type: a.type,
        balanceMinor: value(a, dates.length - 1),
        isLiability: accountTypeInfo(a.type).liability,
      })),
  }
}

export function incomeVsExpense(ctx: AppContext, endMonth: MonthKey, count: number) {
  const months = monthsBetween(addMonths(endMonth, -(count - 1)), endMonth)
  return months.map((m) => {
    const { from, to } = monthRange(m)
    const x = totals(ctx, from, to)
    return { month: m, incomeMinor: x.income, spentMinor: x.spent, netMinor: x.income - x.spent }
  })
}

/**
 * Rows for CSV export of transactions in a date range: oldest first, in the order they're listed (a
 * day's money in, then ones with a time of day, then money out, the other way round on a credit card).
 * With a filter, the ones it counts.
 */
export function exportRows(ctx: AppContext, from?: ISODate, to?: ISODate, filter?: Filter) {
  const scope = listScope(filter, {})
  return ctx.q.all<Record<string, string | number | null>>(
    `SELECT t.date, a.name AS account, t.payee, t.amount_minor AS amountMinor, t.currency, c.name AS category,
       g.name AS categoryGroup, t.notes, t.status,
       (SELECT group_concat(tg.name, ' ' ORDER BY tt.tag_id) FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id AND tg.ledger_id = @ledger
        WHERE tt.transaction_id = t.id) AS tags
     FROM transactions t
     JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
     LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
     LEFT JOIN ledger_category_groups g ON g.id = c.group_id AND g.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.deleted_at IS NULL AND t.date BETWEEN ? AND ?${scope ? ` AND ${scope.sql}` : ''}
     ORDER BY t.date, CASE WHEN t.datetime IS NOT NULL THEN 1 WHEN (CASE WHEN a.type = 'credit' THEN t.amount_minor > 0 ELSE t.amount_minor < 0 END) THEN 2 ELSE 0 END, t.datetime, t.id`,
    from ?? '0000-01-01',
    to ?? addDays(today(ctx), 3650),
    scope?.params ?? {},
  )
}
