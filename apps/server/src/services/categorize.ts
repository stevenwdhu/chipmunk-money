import { payeeSimilarity, type CategorySuggestion } from '@chipmunk/shared'
import { categorizeKey, recorded, type Asked } from '../ai/records'
import { aiEnabled, configuredCategorizer } from '../ai/runner'
import type { LlmCategoryRequest } from '../ai/types'
import type { AppContext } from './context'
import { payeeKeyOf, payeeNameOf } from './payee-namer'

/** The AI's pick is applied without review when it agrees with a bank that's sure, and is this sure itself. */
const AGREES_WITH_BANK_CONFIDENCE = 0.8
/** History this one-sided is a strong suggestion (still one to review: only a payee choice applies on its own). */
const STRONG_SHARE = 0.8
const STRONG_COUNT = 2
const FUZZY_THRESHOLD = 0.6

export interface SuggestionResult extends CategorySuggestion {
  /** True when the category can be applied without asking the user to review it. */
  autoApply: boolean
}

interface StatRow {
  payeeKey: string
  categoryId: number
  count: number
  name: string
  isIncome: number
}

export type Direction = 'in' | 'out'
/** Money in, or out (no amount counts as out). */
export const directionOf = (amountMinor: number | undefined): Direction => ((amountMinor ?? 0) > 0 ? 'in' : 'out')

/** History for a payee, the given way only when there's an amount. */
function statsFor(ctx: AppContext, payeeKey: string, amountMinor: number | undefined): StatRow[] {
  const oneWay = amountMinor !== undefined && amountMinor !== 0
  return ctx.q.all<StatRow>(
    `SELECT s.payee_key AS payeeKey, s.category_id AS categoryId, sum(s.count) AS count, c.name, c.is_income AS isIncome
     FROM payee_category_stats s JOIN ledger_categories c ON c.id = s.category_id AND c.ledger_id = s.ledger_id
     WHERE s.ledger_id = @ledger AND s.payee_key = ? AND c.archived_at IS NULL AND s.count > 0${oneWay ? ' AND s.direction = ?' : ''}
     GROUP BY s.category_id
     ORDER BY count DESC, max(s.last_used_at) DESC`,
    ...(oneWay ? [payeeKey, directionOf(amountMinor)] : [payeeKey]),
  )
}

function signFits(isIncome: number | boolean, amountMinor: number | undefined) {
  if (amountMinor === undefined || amountMinor === 0) return true
  return isIncome ? amountMinor > 0 : true
}

/** Records a category you confirmed, so it's suggested for this payee (money the same way) next time. */
export function learn(ctx: AppContext, payeeKey: string, amountMinor: number, categoryId: number | null, delta = 1) {
  if (!categoryId || !payeeKey || delta === 0) return
  const direction = directionOf(amountMinor)
  if (delta > 0) {
    ctx.q.run(
      `INSERT INTO payee_category_stats (ledger_id, payee_key, direction, category_id, count, last_used_at)
       VALUES (@ledger, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (ledger_id, payee_key, direction, category_id) DO UPDATE SET
         count = count + excluded.count,
         last_used_at = excluded.last_used_at`,
      payeeKey,
      direction,
      categoryId,
      delta,
    )
  } else {
    ctx.q.run(
      'UPDATE payee_category_stats SET count = max(count + ?, 0) WHERE ledger_id = @ledger AND payee_key = ? AND direction = ? AND category_id = ?',
      delta,
      payeeKey,
      direction,
      categoryId,
    )
  }
}

export interface PayeeRule {
  mode: 'always' | 'review'
  categoryId: number | null
}

/** What you chose for a payee, if anything. */
export function payeeRule(ctx: AppContext, payeeKey: string): PayeeRule | null {
  return (
    ctx.q.get<PayeeRule>('SELECT mode, category_id AS categoryId FROM payee_rules WHERE ledger_id = @ledger AND payee_key = ?', payeeKey) ?? null
  )
}

/** The category a payee is always set to, when it's on and fits the money's direction. */
function alwaysSuggestion(ctx: AppContext, payeeKey: string, amountMinor: number | undefined): SuggestionResult | null {
  const row = ctx.q.get<{ id: number; name: string; isIncome: number }>(
    `SELECT c.id, c.name, c.is_income AS isIncome FROM payee_rules r JOIN ledger_categories c ON c.id = r.category_id AND c.ledger_id = r.ledger_id
     WHERE r.ledger_id = @ledger AND r.payee_key = ? AND r.mode = 'always' AND c.archived_at IS NULL`,
    payeeKey,
  )
  if (!row || !signFits(row.isIncome, amountMinor)) return null
  return { categoryId: row.id, source: 'history', confidence: 1, reason: `You always put “${payeeKey}” in ${row.name}`, autoApply: true }
}

export function historySuggestion(
  ctx: AppContext,
  payee: string,
  amountMinor?: number,
): SuggestionResult | null {
  const key = payeeKeyOf(ctx, payee)
  const always = alwaysSuggestion(ctx, key, amountMinor)
  if (always) return always
  const stats = statsFor(ctx, key, amountMinor).filter((s) => signFits(s.isIncome, amountMinor))
  const total = stats.reduce((n, s) => n + s.count, 0)
  const top = stats[0]
  if (top && total > 0) {
    const share = top.count / total
    const strong = top.count >= STRONG_COUNT && share >= STRONG_SHARE
    return {
      categoryId: top.categoryId,
      source: 'history',
      confidence: Number((strong ? share : share * 0.8).toFixed(2)),
      reason: `You picked ${top.name} ${top.count} time${top.count === 1 ? '' : 's'} for “${key}”`,
      autoApply: false,
    }
  }

  // Fuzzy: similar payee keys the user has categorized before (money the same way). A tie goes to
  // what was learned first.
  const keys = ctx.q.all<StatRow>(
    `SELECT s.payee_key AS payeeKey, s.category_id AS categoryId, s.count, c.name, c.is_income AS isIncome
     FROM payee_category_stats s JOIN ledger_categories c ON c.id = s.category_id AND c.ledger_id = s.ledger_id
     WHERE s.ledger_id = @ledger AND c.archived_at IS NULL AND s.count > 0 AND s.direction = ?
     ORDER BY s.rowid`,
    directionOf(amountMinor),
  )
  let best: { row: StatRow; score: number } | null = null
  for (const row of keys) {
    if (!signFits(row.isIncome, amountMinor)) continue
    const score = payeeSimilarity(key, row.payeeKey) * Math.min(1, 0.7 + row.count * 0.1)
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) best = { row, score }
  }
  if (best) {
    return {
      categoryId: best.row.categoryId,
      source: 'fuzzy',
      confidence: Number((best.score * 0.75).toFixed(2)),
      reason: `Similar to “${best.row.payeeKey}”, which you put in ${best.row.name}`,
      autoApply: false,
    }
  }
  return null
}

/** What's known about a transaction when asking AI; `bankCategory` is the bank's own (Plaid's), if any. */
export interface AiInput {
  payee: string
  /** Which payee it is, as its transaction keeps it. Default: what the payee name rules make of `payee`. */
  payeeKey?: string
  amountMinor?: number
  accountId?: number
  date?: string
  notes?: string | null
  bankCategory?: string | null
  /** The bank says it's sure of its category. */
  bankConfident?: boolean
  /**
   * Asked about these transactions, which had a category (“Ask AI again”): recorded apart from the
   * payee's uncategorized ones, in a record that remembers them while it's failed.
   */
  again?: Asked[]
  /** The failed record this asks again (a retry): corrected whatever its payee is called now. */
  record?: number
}

function buildLlmRequest(ctx: AppContext, input: AiInput): LlmCategoryRequest {
  // Categories left out of totals (transfers, card payments) are offered too, marked as such.
  const cats = ctx.q.all<{ id: number; name: string; groupName: string | null; isIncome: number; excluded: number }>(
    `SELECT c.id, c.name, g.name AS groupName, c.is_income AS isIncome, c.exclude_from_totals AS excluded
     FROM ledger_categories c LEFT JOIN ledger_category_groups g ON g.id = c.group_id AND g.ledger_id = c.ledger_id
     WHERE c.ledger_id = @ledger AND c.archived_at IS NULL
     ORDER BY g.sort, c.sort`,
  )
  const examples = ctx.q.all<{ payee: string; category: string }>(
    `SELECT s.payee_key AS payee, c.name AS category
     FROM payee_category_stats s JOIN ledger_categories c ON c.id = s.category_id AND c.ledger_id = s.ledger_id
     WHERE s.ledger_id = @ledger AND s.count > 0 AND c.archived_at IS NULL AND s.direction = ?
     ORDER BY s.last_used_at DESC LIMIT 40`,
    directionOf(input.amountMinor),
  )
  const key = payeeKeyOf(ctx, input.payee)
  // Most similar examples first, then the most recent ones.
  const ranked = examples
    .map((e) => ({ ...e, score: payeeSimilarity(key, e.payee) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(({ payee, category }) => ({ payee, category }))
  const accountType = input.accountId
    ? (ctx.q.pluck<string>('SELECT type FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', input.accountId) ?? null)
    : null
  return {
    payee: input.payee,
    // What you named it, when a rule of yours did.
    payeeName: payeeNameOf(ctx, input.payee).ruleId !== null ? payeeNameOf(ctx, input.payee).name : null,
    amountMinor: input.amountMinor ?? null,
    date: input.date ?? null,
    accountType,
    notes: input.notes ?? null,
    bankCategory: input.bankCategory ?? null,
    // Only ones that fit: an income category is for money in.
    categories: cats.filter((c) => signFits(c.isIncome, input.amountMinor)).map((c) => ({ name: c.name, group: c.groupName, isIncome: !!c.isIncome, excluded: !!c.excluded })),
    examples: ranked,
  }
}

/**
 * AI's pick, to review, unless the bank's own category backs it up: when the bank is sure, the AI
 * agrees with it and is fairly sure itself, it's applied without review. The request is recorded in
 * the ledger's AI usage. Throws when no provider answered, and null when the answer is no category
 * the ledger uses.
 */
export async function aiSuggestion(ctx: AppContext, input: AiInput): Promise<SuggestionResult | null> {
  if (!aiEnabled(ctx)) return null
  const req = buildLlmRequest(ctx, input)
  if (!req.categories.length) return null
  const named = payeeKeyOf(ctx, input.payee)
  const payeeKey = input.payeeKey ?? named
  // One record per payee and way the money went: only the payee's name is kept of the transaction.
  const { res, match } = await recorded(
    ctx,
    () => {
      // Named otherwise while AI was asked, the payee's open record went with it: this is for the payee as it's called now.
      const now = payeeNameOf(ctx, input.payee)
      return {
        kind: 'categorize',
        subject: now.name,
        key: categorizeKey(now.key !== named ? now.key : payeeKey, directionOf(input.amountMinor), !!input.again),
        record: input.record,
        asked: input.again,
      }
    },
    async (log) => {
      const res = await (ctx.llm ?? configuredCategorizer(ctx, log))(req)
      if (!res) throw new Error('AI gave no answer.')
      const match = ctx.q.get<{ id: number; name: string; isIncome: number }>(
        'SELECT id, name, is_income AS isIncome FROM ledger_categories WHERE ledger_id = @ledger AND lower(name) = lower(?) AND archived_at IS NULL',
        res.category,
      )
      return { res, match: match && signFits(match.isIncome, input.amountMinor) ? match : null }
    },
    ({ res, match }) => ({ outcome: match?.name ?? null, slot: res.slot, model: res.model }),
  )
  if (!match) return null
  // Not for a payee you always review yourself.
  const backedByBank =
    !!input.bankCategory &&
    !!input.bankConfident &&
    !!res.agreesWithBank &&
    res.confidence >= AGREES_WITH_BANK_CONFIDENCE &&
    payeeRule(ctx, payeeKey)?.mode !== 'review'
  return {
    categoryId: match.id,
    source: 'ai',
    confidence: Number(Math.min(res.confidence, 0.95).toFixed(2)),
    reason: backedByBank ? `Suggested by ${res.model}, matching your bank’s category (${input.bankCategory})` : `Suggested by ${res.model}`,
    provider: res.slot,
    autoApply: backedByBank,
  }
}

export async function suggestCategory(
  ctx: AppContext,
  input: { payee: string; amountMinor?: number; accountId?: number; date?: string; notes?: string | null; useAi?: boolean },
): Promise<SuggestionResult> {
  const fromHistory = historySuggestion(ctx, input.payee, input.amountMinor)
  if (fromHistory?.autoApply) return fromHistory
  if (input.useAi !== false) {
    const fromAi = await aiSuggestion(ctx, input).catch(() => null)
    // Prefer AI over a weak history guess, but keep a strong single-use history match.
    if (fromAi && (!fromHistory || fromHistory.confidence < 0.6)) return fromAi
  }
  if (fromHistory) return fromHistory
  return { categoryId: null, source: 'none', confidence: 0, reason: 'No match yet', autoApply: false }
}
