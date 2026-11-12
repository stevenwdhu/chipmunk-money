import {
  addDays,
  daysBetween,
  payeeSimilarity,
  type AiJobStatus,
  type ImportBatch,
  type ImportPreviewRow,
  type ImportResult,
} from '@chipmunk/shared'
import type { z } from 'zod'
import type { importCommitSchema, importPreviewSchema } from '@chipmunk/shared'
import { categorizeKey } from '../ai/records'
import { aiEnabled } from '../ai/runner'
import { badRequest } from '../lib/http'
import { requireHome, saveImportMapping } from './accounts'
import { aiSuggestion, directionOf, historySuggestion, learn, payeeRule, type SuggestionResult } from './categorize'
import type { AppContext } from './context'
import { payeeKeyOf } from './payee-namer'
import { isCardReward, matchTransactions } from './matching'
import { detectRecurring } from './recurring'
import { applyPayeeChoices } from './payees'
import { insertTransaction } from './transactions'

type PreviewInput = z.output<typeof importPreviewSchema>
type CommitInput = z.output<typeof importCommitSchema>

/** What an import's row duplicates: a transaction of the account, and whether another ledger holds it. */
interface Duplicate {
  id: number
  /**
   * Another ledger holds it (a shared account's), or an account split off from this one has it: still
   * a duplicate, but a preview doesn't name it.
   */
  elsewhere: boolean
}

/**
 * For each row, the existing transaction it duplicates, or null. A row with an `externalId` matches
 * the transaction with that id (deleted ones too, so a deleted transaction isn't imported again);
 * otherwise rows match on date, amount and payee, allowing a few days of drift because pending
 * dates often shift when they post. A shared account's transactions count in every ledger that
 * holds them (ctx.accountWide.importedRows), so one moved to another ledger isn't imported again.
 * So do the ones a ledger kept, on an account of its own, when it stopped sharing this one.
 */
function findDuplicates(
  ctx: AppContext,
  accountId: number,
  rows: Array<{ date: string; amountMinor: number; payee: string; externalId?: string | null }>,
): Array<Duplicate | null> {
  if (!rows.length) return []
  const externalIds = rows.map((r) => r.externalId).filter((x): x is string => !!x)
  if (new Set(externalIds).size !== externalIds.length) badRequest('Each externalId can only appear once per import')
  const dates = rows.map((r) => r.date).sort()
  const from = addDays(dates[0]!, -3)
  const to = addDays(dates[dates.length - 1]!, 3)
  const found = ctx.accountWide.importedRows(accountId, { externalIds, from, to })
  const wanted = new Set(externalIds)
  const byExternalId = new Map(found.filter((r) => r.externalId && wanted.has(r.externalId)).map((r) => [r.externalId!, r]))
  const existing = found.filter((r) => !r.deleted && r.date >= from && r.date <= to)
  const duplicate = (r: { id: number; ledgerId: string; frozen: boolean }): Duplicate => ({ id: r.id, elsewhere: r.frozen || r.ledgerId !== ctx.ledger.id })
  const used = new Set<number>()

  return rows.map((row) => {
    if (row.externalId) {
      const held = byExternalId.get(row.externalId)
      if (held) return duplicate(held)
    }
    // A transaction that came with its own id is only a duplicate of one that didn't, so two
    // identical coffees with different ids both count.
    const candidates = row.externalId ? existing.filter((e) => !e.externalId) : existing
    const key = payeeKeyOf(ctx, row.payee)
    // Exact match first, then a near match (pending → posted dates often shift by a day or two).
    const exact = candidates.find(
      (e) => !used.has(e.id) && e.date === row.date && e.amount === row.amountMinor && e.payeeKey === key,
    )
    const near =
      exact ??
      candidates.find(
        (e) =>
          !used.has(e.id) &&
          e.amount === row.amountMinor &&
          Math.abs(daysBetween(e.date, row.date)) <= 3 &&
          (e.payeeKey === key || payeeSimilarity(e.payeeKey, key) >= 0.5),
      )
    if (near) used.add(near.id)
    return near ? duplicate(near) : null
  })
}

const hasAccount = (ctx: AppContext, id: number) => ctx.q.pluck('SELECT 1 FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', id) !== undefined

export function previewImport(ctx: AppContext, input: PreviewInput): ImportPreviewRow[] {
  if (!hasAccount(ctx, input.accountId)) badRequest('That account does not exist')
  requireHome(ctx, input.accountId, 'import')
  const dupes = findDuplicates(ctx, input.accountId, input.rows)
  const cache = new Map<string, SuggestionResult | null>()
  return input.rows.map((row, i) => {
    const key = `${payeeKeyOf(ctx, row.payee)}|${Math.sign(row.amountMinor)}`
    if (!cache.has(key)) cache.set(key, historySuggestion(ctx, row.payee, row.amountMinor))
    const s = cache.get(key)
    const dupe = dupes[i]
    return {
      ...row,
      notes: row.notes ?? null,
      category: row.category ?? null,
      // Another ledger's transaction is a duplicate too, but its id isn't this ledger's to show.
      duplicateOf: dupe && !dupe.elsewhere ? dupe.id : null,
      duplicateElsewhere: !!dupe?.elsewhere,
      suggestion: s
        ? { categoryId: s.categoryId, source: s.source, confidence: s.confidence, reason: s.reason }
        : { categoryId: null, source: 'none', confidence: 0, reason: 'No match yet' },
    }
  })
}

/**
 * Adds the rows that aren't duplicates as one import batch, which is how the background AI
 * categorizing finds them. A wrong import is taken back by deleting its rows. With
 * `background: false` (dry runs), AI categorization isn't started afterwards.
 */
export function commitImport(ctx: AppContext, input: CommitInput, opts: { background?: boolean } = {}): ImportResult {
  if (!hasAccount(ctx, input.accountId)) badRequest('That account does not exist')
  requireHome(ctx, input.accountId, 'import')

  // Re-check duplicates server-side so a double submit can't import twice.
  const dupes = findDuplicates(ctx, input.accountId, input.rows)
  const fresh = input.rows.filter((_, i) => dupes[i] === null)
  const cache = new Map<string, SuggestionResult | null>()

  const result = ctx.q.transaction(() => {
    const batchId = Number(
      ctx.q.run(
        'INSERT INTO import_batches (ledger_id, account_id, file_name, row_count) VALUES (@ledger, ?, ?, ?)',
        input.accountId,
        input.fileName ?? null,
        fresh.length,
      ).lastInsertRowid,
    )
    let categorized = 0
    let needsReview = 0
    // The category the bank or another app gave it: its bank category, for AI to go by (like Plaid's).
    // Yours, not a guess, so AI agreeing with it applies its pick without review.
    const setBankCategory = (category: string, id: number) =>
      ctx.q.run('UPDATE transactions SET bank_category = ?, bank_category_confident = 1 WHERE id = ? AND ledger_id = @ledger', category, id)
    for (const row of fresh) {
      let suggestion: SuggestionResult | null = null
      if (!row.categoryId) {
        const key = `${payeeKeyOf(ctx, row.payee)}|${Math.sign(row.amountMinor)}`
        if (!cache.has(key)) cache.set(key, historySuggestion(ctx, row.payee, row.amountMinor))
        suggestion = cache.get(key) ?? null
      }
      const id = insertTransaction(
        ctx,
        {
          accountId: input.accountId,
          date: row.date,
          amountMinor: row.amountMinor,
          payee: row.payee,
          categoryId: row.categoryId ?? null,
          notes: row.notes ?? null,
          tags: row.tags ?? [],
          status: 'cleared',
          transferAccountId: null,
          externalId: row.externalId ?? null,
        },
        { origin: 'import', importBatchId: batchId, suggestion },
      )
      if (row.category) setBankCategory(row.category, id)
      if (row.categoryId || suggestion?.categoryId) categorized++
      if (!row.categoryId && suggestion?.categoryId && !suggestion.autoApply) needsReview++
    }
    return {
      batchId,
      imported: fresh.length,
      skippedDuplicates: input.rows.length - fresh.length,
      categorized,
      needsReview,
      dryRun: false,
    }
  })

  if (input.mapping) saveImportMapping(ctx, input.accountId, input.mapping)
  const earliest = fresh.reduce<string | null>((d, r) => (!d || r.date < d ? r.date : d), null)
  const { cleared } = matchTransactions(ctx, { earliest })
  detectRecurring(ctx)
  // AI categorization of whatever history couldn't place runs in the background.
  if (opts.background !== false && aiEnabled(ctx)) {
    void (async () => {
      await categorizeUncategorized(ctx, { batchId: result.batchId })
      if (cleared.length) await categorizeUncategorized(ctx, { ids: cleared })
    })()
  }
  return result
}

export function listBatches(ctx: AppContext): ImportBatch[] {
  return ctx.q.all<ImportBatch>(
    `SELECT b.id, b.account_id AS accountId, a.name AS accountName, b.file_name AS fileName, b.row_count AS rowCount,
       b.created_at AS createdAt
     FROM import_batches b JOIN ledger_accounts a ON a.id = b.account_id AND a.ledger_id = b.ledger_id
     WHERE b.ledger_id = @ledger
     ORDER BY b.id DESC LIMIT 50`,
  )
}

// Background AI categorization ---------------------------------------------

const aiJobs = new Map<string, AiJobStatus>()

/** Status of the background AI categorization for one ledger. */
export function aiJobStatus(ctx: AppContext): AiJobStatus {
  let job = aiJobs.get(ctx.ledger.id)
  if (!job) {
    job = { running: false, total: 0, done: 0, categorized: 0, startedAt: null }
    aiJobs.set(ctx.ledger.id, job)
  }
  return job
}

interface Uncategorized {
  id: number
  accountId: number
  date: string
  amount: number
  payee: string
  payeeKey: string
  notes: string | null
  bankCategory: string | null
  bankConfident: number
}

/**
 * The transactions without a category that AI may be asked about, newest first: not a transfer,
 * money in that follows what it pays back, or a split row. Money onto a credit card is a payment
 * (or a refund), never a guess for AI, but cash back and rewards are.
 */
function uncategorized(ctx: AppContext, opts: { batchId?: number; ids?: number[] } = {}): Uncategorized[] {
  const candidates = ctx.q.all<Uncategorized>(
    `SELECT id, account_id AS accountId, date, amount_minor AS amount, payee, payee_key AS payeeKey, notes,
       bank_category AS bankCategory, bank_category_confident AS bankConfident
     FROM transactions
     WHERE ledger_id = @ledger AND category_id IS NULL AND deleted_at IS NULL AND transfer_pair_id IS NULL AND category_source IS NOT 'linked'
       AND split_of IS NULL
       ${opts.batchId ? 'AND import_batch_id = ?' : ''}
       ${opts.ids ? 'AND id IN (SELECT value FROM json_each(?))' : ''}
     ORDER BY date DESC`,
    ...(opts.batchId ? [opts.batchId] : []),
    ...(opts.ids ? [JSON.stringify(opts.ids)] : []),
  )
  const cards = new Set(ctx.q.column<number>("SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND type = 'credit'"))
  return candidates.filter((r) => !(r.amount > 0 && cards.has(r.accountId) && !isCardReward(r.payee)))
}

/** The payees with a transaction waiting for a category that AI may be asked about, as an AI record names them (categorizeKey). */
export function payeesWaiting(ctx: AppContext): Set<string> {
  return new Set(uncategorized(ctx).map((r) => categorizeKey(r.payeeKey, directionOf(r.amount))))
}

/**
 * Asks the configured LLM about uncategorized transactions, one request per distinct payee, and
 * applies the answer to every transaction from that payee (flagged for review). Never a split row
 * (a share of a split payment, or what its holder gave): its category is the split's. With `payees`
 * (as categorizeKey names them), only theirs, however many.
 */
export async function categorizeUncategorized(ctx: AppContext, opts: { batchId?: number; ids?: number[]; limit?: number; payees?: string[] } = {}) {
  const aiJob = aiJobStatus(ctx)
  if (aiJob.running) return aiJob
  const only = opts.payees && new Set(opts.payees)
  const rows = uncategorized(ctx, opts).filter((r) => !only || only.has(categorizeKey(r.payeeKey, directionOf(r.amount))))
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.payeeKey}|${Math.sign(r.amount)}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  const work = [...groups.values()].slice(0, only ? undefined : (opts.limit ?? 150))
  Object.assign(aiJob, { running: true, total: work.length, done: 0, categorized: 0, startedAt: new Date().toISOString() })

  const update = (...params: unknown[]) =>
    ctx.q.run(
      `UPDATE transactions SET category_id = ?, category_source = ?, category_confidence = ?, needs_review = ?
       WHERE id = ? AND ledger_id = @ledger AND category_id IS NULL AND split_of IS NULL`,
      ...params,
    )
  try {
    const queue = [...work]
    const worker = async () => {
      for (let list = queue.shift(); list; list = queue.shift()) {
        const first = list[0]!
        try {
          // History may have learned this payee while the job was running.
          const s =
            historySuggestion(ctx, first.payee, first.amount) ??
            (await aiSuggestion(ctx, {
              payee: first.payee,
              payeeKey: first.payeeKey,
              amountMinor: first.amount,
              accountId: first.accountId,
              date: first.date,
              notes: first.notes,
              bankCategory: first.bankCategory,
              bankConfident: !!first.bankConfident,
            }))
          if (s?.categoryId) {
            ctx.q.transaction(() => {
              for (const r of list) update(s.categoryId, s.source === 'ai' ? 'ai' : 'history', s.confidence, s.autoApply ? 0 : 1, r.id)
            })
            aiJob.categorized += list.length
          }
        } catch {
          // A failed request is recorded in ai_calls; keep going with the next payee.
        }
        aiJob.done++
      }
    }
    await Promise.all([worker(), worker(), worker()])
  } finally {
    aiJob.running = false
  }
  return aiJob
}

/** A transaction whose category AI changed when asked again. */
export interface Recategorized {
  id: number
  before: number | null
  after: number
}

/**
 * Asks AI again about these transactions' categories, in the background: AI only, not your history,
 * once per payee, amount and notes. A different pick replaces the category as a suggestion to review
 * (applied, when the bank's category backs it). A payee you always set one way isn't asked about: its
 * transactions waiting for a category get yours. Left as they are: transfers, refunds and paybacks that
 * follow their purchase, payments a recurring item categorizes, and split rows (a share of a split
 * payment, or what its holder gave), whose category must stay left out of totals. `onDone` hears what changed. Throws
 * when AI isn't set up or is already at work in this ledger.
 */
export function recategorize(ctx: AppContext, ids: number[], onDone?: (changed: Recategorized[]) => void): AiJobStatus {
  if (!aiEnabled(ctx)) badRequest('Set up an AI provider first, in App settings → AI.')
  const aiJob = aiJobStatus(ctx)
  if (aiJob.running) badRequest('AI is already categorizing in this ledger. Try again when it’s done.')
  const selected = ctx.q.all<{
      id: number
      accountId: number
      date: string
      amount: number
      payee: string
      payeeKey: string
      notes: string | null
      bankCategory: string | null
      bankConfident: number
      categoryId: number | null
      source: string | null
    }>(
    `SELECT id, account_id AS accountId, date, amount_minor AS amount, payee, payee_key AS payeeKey, notes,
       bank_category AS bankCategory, bank_category_confident AS bankConfident, category_id AS categoryId, category_source AS source
     FROM transactions
     WHERE ledger_id = @ledger AND id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND transfer_pair_id IS NULL
       AND COALESCE(category_source, '') NOT IN ('linked', 'recurring') AND split_of IS NULL
     ORDER BY date DESC`,
    JSON.stringify(ids),
  )
  const always = new Set(selected.filter((r) => payeeRule(ctx, r.payeeKey)?.mode === 'always').map((r) => r.payeeKey))
  const rows = selected.filter((r) => !always.has(r.payeeKey))
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = JSON.stringify([r.payeeKey, r.amount, r.notes ?? ''])
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const work = [...groups.values()]
  const set = (...params: unknown[]) =>
    ctx.q.run(
      'UPDATE transactions SET category_id = ?, category_source = ?, category_confidence = ?, needs_review = ? WHERE id = ? AND ledger_id = @ledger AND split_of IS NULL',
      ...params,
    )
  const changed: Recategorized[] = always.size ? applyPayeeChoices(ctx, [...always]) : []
  Object.assign(aiJob, { running: true, total: work.length, done: 0, categorized: changed.length, startedAt: new Date().toISOString() })
  void (async () => {
    try {
      const queue = [...work]
      const worker = async () => {
        for (let list = queue.shift(); list; list = queue.shift()) {
          const first = list[0]!
          try {
            const s = await aiSuggestion(ctx, {
              payee: first.payee,
              payeeKey: first.payeeKey,
              amountMinor: first.amount,
              accountId: first.accountId,
              date: first.date,
              notes: first.notes,
              bankCategory: first.bankCategory,
              bankConfident: !!first.bankConfident,
              // About a category that's there, it isn't the payee's uncategorized transactions that were asked about.
              again: list.some((r) => r.categoryId !== null),
            })
            const pick = s?.categoryId
            if (s && pick) {
              ctx.q.transaction(() => {
                for (const r of list) {
                  if (r.categoryId === pick) continue
                  // What you picked before isn't learned any more: it's AI's pick, to review.
                  if (r.source === 'user' && r.categoryId) learn(ctx, r.payeeKey, r.amount, r.categoryId, -1)
                  set(pick, 'ai', s.confidence, s.autoApply ? 0 : 1, r.id)
                  changed.push({ id: r.id, before: r.categoryId, after: pick })
                  aiJob.categorized++
                }
              })
            }
          } catch {
            // A failed request is recorded in ai_calls; keep going with the next one.
          }
          aiJob.done++
        }
      }
      await Promise.all([worker(), worker(), worker()])
    } finally {
      aiJob.running = false
      onDone?.(changed)
    }
  })()
  return { ...aiJob }
}
