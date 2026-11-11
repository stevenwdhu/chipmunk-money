import { isEmptyFilter, isEmptySide, type Condition, type FilterSide, type FilterSideFilter, type ReportFilter, type TextScope } from '@chipmunk/shared'
import { COUNTABLE, IS_INCOME, IS_SPENDING } from './totals'

/**
 * Report filters (ReportFilter, in @chipmunk/shared) as SQL over `transaction_lines t`, with its category `c`
 * and the transaction each line belongs to `o` (itself, or for a refund or payback, its purchase).
 * The category (and its group and labels) is the line's (a refund or payback is in its purchase's),
 * and everything else is the owner's: filtering out a purchase also filters out what's linked to it,
 * in any month or account.
 */

/** Binds a value to a placeholder, in the order the SQL is written, and returns the placeholder. */
export type Binder = (value: unknown) => string

export function positional(params: unknown[]): Binder {
  return (value) => {
    params.push(value)
    return '?'
  }
}

function named(params: Record<string, unknown>): Binder {
  let n = 0
  return (value) => {
    const key = `f${n++}`
    params[key] = value
    return `@${key}`
  }
}

/**
 * `alias` matches `text` as the search box has it: its payee (as sent, or its key), name, notes,
 * recurring item or exact amount. With `scope`, only in those: the payee, the name (its own, or its
 * recurring item's) or the notes.
 */
export function textLike(alias: string, text: string, bind: Binder, scope?: TextScope[]): string {
  // `%`, `_` and the escape itself match as typed.
  const pattern = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
  const asCents = text.replace(/[$,\s]/g, '')
  const like = (column: string) => `${alias}.${column} LIKE ${bind(pattern)} ESCAPE '\\'`
  const recurring = () => `${alias}.recurring_item_id IN (SELECT id FROM recurring_items WHERE title LIKE ${bind(pattern)} ESCAPE '\\')`
  if (scope) {
    const where: Record<TextScope, () => string[]> = {
      payee: () => [like('payee'), like('payee_key')],
      name: () => [like('name'), recurring()],
      notes: () => [like('notes')],
    }
    return `(${scope.flatMap((s) => where[s]()).join(' OR ')})`
  }
  return `(${like('payee')} OR ${like('notes')} OR ${like('payee_key')} OR ${like('name')}
    OR CAST(abs(${alias}.amount_minor) AS TEXT) = ${bind(/^\d+(\.\d{1,2})?$/.test(asCents) ? String(Math.round(Number(asCents) * 100)) : '')}
    OR ${recurring()})`
}

const inList = (bind: Binder, values: unknown[]) => `(SELECT value FROM json_each(${bind(JSON.stringify(values))}))`
/** `ids` by `sql` (given the list to match), and `none` by `none`. */
function anyOf(ids: Array<number | 'none'>, bind: Binder, sql: (list: string) => string, none: string) {
  const some = ids.filter((i) => i !== 'none')
  const any = some.length ? [sql(inList(bind, some))] : []
  if (ids.includes('none')) any.push(none)
  return any.join(' OR ')
}
/** Uncategorized: a transfer isn't, though it has no category. */
const UNCATEGORIZED = '(t.category_id IS NULL AND t.transfer_pair_id IS NULL)'
/** Each line's owner, as `o`. */
export const OWNER_JOIN = 'JOIN transactions o ON o.id = t.owner_id'
/** A recurring item's payment: not a suggestion's, nor a dismissed one's (their payments keep the link). */
export const RECURRING = `(SELECT id FROM recurring_items WHERE status IN ('active', 'ended'))`
/** The owner's refunds and paybacks, from money in that isn't deleted. */
const LINKED_IN = `coalesce((SELECT sum(l.amount_minor) FROM transaction_links l JOIN transactions m ON m.id = l.money_in_id
  WHERE l.money_out_id = o.id AND m.deleted_at IS NULL), 0)`
/** What the owner comes to (negative is money out): for a purchase, less its refunds and paybacks; for money in, less what's linked to bills. */
const NET = `(o.amount_minor - o.linked_minor + ${LINKED_IN})`
/** Your share of the owner: what a purchase cost less its refunds and paybacks, or what came in less what's linked to bills. */
export const shareOf = (side: FilterSide) => (side === 'spending' ? `-${NET}` : NET)

function conditionSql(c: Condition, side: FilterSide, bind: Binder): string {
  switch (c.field) {
    case 'category':
      return anyOf(c.ids, bind, (list) => `t.category_id IN ${list}`, UNCATEGORIZED)
    case 'group':
      return anyOf(c.ids, bind, (list) => `c.group_id IN ${list}`, `(${UNCATEGORIZED} OR (c.id IS NOT NULL AND c.group_id IS NULL))`)
    case 'label':
      // No label counts as the period summary's does: uncategorized, or a category with none.
      return anyOf(
        c.ids,
        bind,
        (list) => `t.category_id IN (SELECT category_id FROM category_labels WHERE label_id IN ${list})`,
        `(${UNCATEGORIZED} OR (t.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM category_labels cl WHERE cl.category_id = t.category_id)))`,
      )
    case 'tag':
      return `EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = o.id AND tt.tag_id IN ${inList(bind, c.ids)})`
    case 'payee':
      return `o.payee_key IN ${inList(bind, c.keys)}`
    case 'text':
      return c.words.map((w) => textLike('o', w, bind, c.in)).join(' OR ')
    case 'amount': {
      // A charge's (or a deposit's): an unlinked refund is neither.
      const share = shareOf(side)
      const bounds = [`o.amount_minor ${side === 'spending' ? '<' : '>'} 0`]
      if (c.min !== undefined) bounds.push(`${share} >= ${bind(c.min)}`)
      if (c.max !== undefined) bounds.push(`${share} <= ${bind(c.max)}`)
      return bounds.join(' AND ')
    }
    case 'account':
      return `o.account_id IN ${inList(bind, c.ids)}`
    case 'recurring':
      if (c.ids === 'any') return `o.recurring_item_id IN ${RECURRING}`
      if (c.ids === 'none') return `NOT coalesce(o.recurring_item_id IN ${RECURRING}, 0)`
      return `o.recurring_item_id IN ${inList(bind, c.ids)}`
  }
}

/** NULL-safe, so it can be negated. */
const condition = (c: Condition, side: FilterSide, bind: Binder) => `coalesce((${conditionSql(c, side, bind)}), 0)`

export type CompiledSide = {
  /** All of Only count ('1' when there's none). */
  only: string
  /** Each Filter out rule. */
  rules: string[]
  picked: string | null
  keep: string | null
  /** Filtered out: a rule or a pick, unless put back ('0' when there's nothing to filter out). */
  out: string
  counted: string
  filtered: string
}

function compileSide(s: FilterSideFilter, side: FilterSide, bind: Binder): CompiledSide {
  const only = s.only.length ? s.only.map((c) => condition(c, side, bind)).join(' AND ') : '1'
  const rules = s.filterOut.map((r) => r.when.map((c) => condition(c, side, bind)).join(' AND '))
  const picked = s.picked.length ? `o.id IN ${inList(bind, s.picked)}` : null
  const keep = s.keep.length ? `o.id IN ${inList(bind, s.keep)}` : null
  const any = [...rules.map((r) => `(${r})`), ...(picked ? [picked] : [])]
  const out = any.length ? `((${any.join(' OR ')})${keep ? ` AND NOT ${keep}` : ''})` : '0'
  return { only, rules, picked, keep, out, counted: `((${only}) AND NOT ${out})`, filtered: `((${only}) AND ${out})` }
}

export type CompiledFilter = {
  /** Joins each line's owner as `o`. */
  join: string
  /** A line that counts: by its side's filter, spending or income. */
  counted: string
  /** A line its side's filter filters out (Only count applies). */
  filtered: string
  sides: Record<FilterSide, CompiledSide | null>
  /** Named parameters for all of the above (bind them with the statement's others). */
  params: Record<string, unknown>
}

/** Null without a filter: queries then stay as they were. */
export function compileFilter(f: ReportFilter | null | undefined): CompiledFilter | null {
  if (!f || isEmptyFilter(f)) return null
  const params: Record<string, unknown> = {}
  const bind = named(params)
  const sides = {
    spending: isEmptySide(f.spending) ? null : compileSide(f.spending!, 'spending', bind),
    income: isEmptySide(f.income) ? null : compileSide(f.income!, 'income', bind),
  }
  // A line on neither side (uncategorized and $0) counts only if both filters would count it, and is never filtered out.
  const neither = [sides.spending?.counted, sides.income?.counted].filter(Boolean).join(' AND ')
  const byLine = (which: 'counted' | 'filtered', otherwise: string, rest: string) =>
    `CASE WHEN ${IS_SPENDING} THEN ${sides.spending?.[which] ?? otherwise} WHEN ${IS_INCOME} THEN ${sides.income?.[which] ?? otherwise} ELSE ${rest} END`
  return { join: ` ${OWNER_JOIN}`, counted: byLine('counted', '1', neither), filtered: byLine('filtered', '0', '0'), sides, params }
}

/** For a report query on `transaction_lines t`: the owner join and what counts, to add after its WHERE. Nothing without a filter. */
export function reportScope(f: ReportFilter | null | undefined) {
  const compiled = compileFilter(f)
  return compiled
    ? { join: compiled.join, where: ` AND (${compiled.counted})`, params: compiled.params, compiled }
    : { join: '', where: '', params: {}, compiled: null }
}

/**
 * For the transaction list (`transactions t`): its transactions with a line that counts, by the
 * filter, or (`filteredOut`) one the filter filters out of totals. Transfers and what's left out of
 * totals aren't the filter's to judge, so they stay listed, unless `side` asks for only what reports
 * count as spending or as income.
 */
export function listScope(f: ReportFilter | null | undefined, opts: { filteredOut?: boolean; side?: FilterSide }) {
  const compiled = compileFilter(f)
  if (opts.filteredOut && !compiled) return { sql: '0', params: {} }
  const where = ['t.deleted_at IS NULL']
  if (opts.side) where.push(COUNTABLE, opts.side === 'spending' ? IS_SPENDING : IS_INCOME)
  if (opts.filteredOut) where.push(COUNTABLE, `(${compiled!.filtered})`)
  else if (compiled) where.push(opts.side ? `(${compiled.counted})` : `(NOT (${COUNTABLE}) OR (${compiled.counted}))`)
  else if (!opts.side) return null
  return {
    sql: `t.id IN (SELECT t.id FROM transaction_lines t${compiled?.join ?? ''} LEFT JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')})`,
    params: compiled?.params ?? {},
  }
}
