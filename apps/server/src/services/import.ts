import {
  addDays,
  daysBetween,
  payeeSimilarity,
  type AiJobStatus,
  type ImportBatch,
  type ImportPreviewRow,
  type ImportResult,
} from '@st/shared'
import type { z } from 'zod'
import type { importCommitSchema, importPreviewSchema } from '@st/shared'
import { aiEnabled } from '../ai/runner'
import { importBatches } from '../db/schema'
import { badRequest, notFound } from '../lib/http'
import { saveImportMapping } from './accounts'
import { aiSuggestion, historySuggestion, learn, payeeRule, type SuggestionResult } from './categorize'
import type { AppContext } from './context'
import { payeeKeyOf } from './payee-namer'
import { isCardReward, matchTransactions, releaseLinks } from './matching'
import { detectRecurring } from './recurring'
import { applyPayeeChoices } from './payees'
import { insertTransaction } from './transactions'

type PreviewInput = z.output<typeof importPreviewSchema>
type CommitInput = z.output<typeof importCommitSchema>

interface ExistingTx {
  id: number
  date: string
  amount: number
  payeeKey: string
  externalId: string | null
}

/**
 * For each row, the id of an existing transaction it duplicates, or null. A row with an
 * `externalId` matches the transaction with that id (deleted ones too, so a deleted transaction
 * isn't imported again); otherwise rows match on date, amount and payee, allowing a few days of
 * drift because pending dates often shift when they post.
 */
function findDuplicates(
  ctx: AppContext,
  accountId: number,
  rows: Array<{ date: string; amountMinor: number; payee: string; externalId?: string | null }>,
) {
  if (!rows.length) return []
  const externalIds = rows.map((r) => r.externalId).filter((x): x is string => !!x)
  if (new Set(externalIds).size !== externalIds.length) badRequest('Each externalId can only appear once per import')
  const byExternalId = new Map(
    externalIds.length
      ? (
          ctx.sqlite
            .prepare(
              `SELECT id, external_id AS externalId FROM transactions
               WHERE account_id = ? AND external_id IN (SELECT value FROM json_each(?))`,
            )
            .all(accountId, JSON.stringify(externalIds)) as Array<{ id: number; externalId: string }>
        ).map((r) => [r.externalId, r.id])
      : [],
  )

  const dates = rows.map((r) => r.date).sort()
  const existing = ctx.sqlite
    .prepare(
      `SELECT id, date, amount_minor AS amount, payee_key AS payeeKey, external_id AS externalId FROM transactions
       WHERE account_id = ? AND deleted_at IS NULL AND date BETWEEN ? AND ?`,
    )
    .all(accountId, addDays(dates[0]!, -3), addDays(dates[dates.length - 1]!, 3)) as ExistingTx[]
  const used = new Set<number>()

  return rows.map((row) => {
    if (row.externalId) {
      const id = byExternalId.get(row.externalId)
      if (id !== undefined) return id
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
    return near?.id ?? null
  })
}

export function previewImport(ctx: AppContext, input: PreviewInput): ImportPreviewRow[] {
  const account = ctx.sqlite.prepare('SELECT id FROM accounts WHERE id = ?').get(input.accountId)
  if (!account) badRequest('That account does not exist')
  const dupes = findDuplicates(ctx, input.accountId, input.rows)
  const cache = new Map<string, SuggestionResult | null>()
  return input.rows.map((row, i) => {
    const key = `${payeeKeyOf(ctx, row.payee)}|${Math.sign(row.amountMinor)}`
    if (!cache.has(key)) cache.set(key, historySuggestion(ctx, row.payee, row.amountMinor))
    const s = cache.get(key)
    return {
      ...row,
      notes: row.notes ?? null,
      category: row.category ?? null,
      duplicateOf: dupes[i] ?? null,
      suggestion: s
        ? { categoryId: s.categoryId, source: s.source, confidence: s.confidence, reason: s.reason }
        : { categoryId: null, source: 'none', confidence: 0, reason: 'No match yet' },
    }
  })
}

/**
 * Adds the rows that aren't duplicates as one import batch (which can be undone). With
 * `background: false` (dry runs), AI categorization isn't started afterwards.
 */
export function commitImport(ctx: AppContext, input: CommitInput, opts: { background?: boolean } = {}): ImportResult {
  const account = ctx.sqlite.prepare('SELECT id FROM accounts WHERE id = ?').get(input.accountId)
  if (!account) badRequest('That account does not exist')

  // Re-check duplicates server-side so a double submit can't import twice.
  const dupes = findDuplicates(ctx, input.accountId, input.rows)
  const fresh = input.rows.filter((_, i) => dupes[i] === null)
  const cache = new Map<string, SuggestionResult | null>()

  const result = ctx.sqlite.transaction(() => {
    const batch = ctx.db
      .insert(importBatches)
      .values({ accountId: input.accountId, fileName: input.fileName ?? null, rowCount: fresh.length })
      .returning()
      .get()
    let categorized = 0
    let needsReview = 0
    // The category the bank or another app gave it: its bank category, for AI to go by (like Plaid's).
    // Yours, not a guess, so AI agreeing with it applies its pick without review.
    const setBankCategory = ctx.sqlite.prepare('UPDATE transactions SET bank_category = ?, bank_category_confident = 1 WHERE id = ?')
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
        { origin: 'import', importBatchId: batch.id, suggestion },
      )
      if (row.category) setBankCategory.run(row.category, id)
      if (row.categoryId || suggestion?.categoryId) categorized++
      if (!row.categoryId && suggestion?.categoryId && !suggestion.autoApply) needsReview++
    }
    return {
      batchId: batch.id,
      imported: fresh.length,
      skippedDuplicates: input.rows.length - fresh.length,
      categorized,
      needsReview,
      dryRun: false,
    }
  })()

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
  return ctx.sqlite
    .prepare(
      `SELECT b.id, b.account_id AS accountId, a.name AS accountName, b.file_name AS fileName, b.row_count AS rowCount,
         b.created_at AS createdAt,
         (SELECT count(*) FROM transactions t WHERE t.import_batch_id = b.id AND t.deleted_at IS NULL) AS remaining
       FROM import_batches b JOIN accounts a ON a.id = b.account_id
       ORDER BY b.id DESC LIMIT 50`,
    )
    .all() as ImportBatch[]
}

export function undoBatch(ctx: AppContext, batchId: number) {
  const batch = ctx.sqlite.prepare('SELECT id FROM import_batches WHERE id = ?').get(batchId)
  if (!batch) notFound('Import not found')
  ctx.sqlite.transaction(() => {
    releaseLinks(ctx, 'import_batch_id = ?', batchId)
    const removed = ctx.sqlite.prepare('DELETE FROM transactions WHERE import_batch_id = ?').run(batchId)
    ctx.sqlite.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId)
    return removed.changes
  })()
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

/**
 * Asks the configured LLM about uncategorized transactions, one request per distinct payee, and
 * applies the answer to every transaction from that payee (flagged for review).
 */
export async function categorizeUncategorized(ctx: AppContext, opts: { batchId?: number; ids?: number[]; limit?: number } = {}) {
  const aiJob = aiJobStatus(ctx)
  if (aiJob.running) return aiJob
  const candidates = ctx.sqlite
    .prepare(
      `SELECT id, account_id AS accountId, date, amount_minor AS amount, payee, payee_key AS payeeKey, notes,
         bank_category AS bankCategory, bank_category_confident AS bankConfident
       FROM transactions
       WHERE category_id IS NULL AND deleted_at IS NULL AND transfer_pair_id IS NULL AND category_source IS NOT 'linked'
         ${opts.batchId ? 'AND import_batch_id = ?' : ''}
         ${opts.ids ? 'AND id IN (SELECT value FROM json_each(?))' : ''}
       ORDER BY date DESC`,
    )
    .all(...(opts.batchId ? [opts.batchId] : []), ...(opts.ids ? [JSON.stringify(opts.ids)] : [])) as Array<{
    id: number
    accountId: number
    date: string
    amount: number
    payee: string
    payeeKey: string
    notes: string | null
    bankCategory: string | null
    bankConfident: number
  }>
  // Money onto a credit card is a payment (or a refund), never a guess for AI; cash back and rewards are.
  const cards = new Set(ctx.sqlite.prepare("SELECT id FROM accounts WHERE type = 'credit'").pluck().all() as number[])
  const rows = candidates.filter((r) => !(r.amount > 0 && cards.has(r.accountId) && !isCardReward(r.payee)))
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.payeeKey}|${Math.sign(r.amount)}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  const work = [...groups.values()].slice(0, opts.limit ?? 150)
  Object.assign(aiJob, { running: true, total: work.length, done: 0, categorized: 0, startedAt: new Date().toISOString() })

  const update = ctx.sqlite.prepare(
    `UPDATE transactions SET category_id = ?, category_source = ?, category_confidence = ?, needs_review = ?
     WHERE id = ? AND category_id IS NULL`,
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
              amountMinor: first.amount,
              accountId: first.accountId,
              date: first.date,
              notes: first.notes,
              bankCategory: first.bankCategory,
              bankConfident: !!first.bankConfident,
            }))
          if (s?.categoryId) {
            ctx.sqlite.transaction(() => {
              for (const r of list) update.run(s.categoryId, s.source === 'ai' ? 'ai' : 'history', s.confidence, s.autoApply ? 0 : 1, r.id)
            })()
            aiJob.categorized += list.length
          }
        } catch {
          // Provider errors are logged in ai_calls; keep going with the next payee.
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
 * follow their purchase, and payments a recurring item categorizes. `onDone` hears what changed. Throws
 * when AI isn't set up or is already at work in this ledger.
 */
export function recategorize(ctx: AppContext, ids: number[], onDone?: (changed: Recategorized[]) => void): AiJobStatus {
  if (!aiEnabled(ctx)) badRequest('Set up an AI provider first, in App settings → AI.')
  const aiJob = aiJobStatus(ctx)
  if (aiJob.running) badRequest('AI is already categorizing in this ledger. Try again when it’s done.')
  const selected = (
    ctx.sqlite
      .prepare(
        `SELECT id, account_id AS accountId, date, amount_minor AS amount, payee, payee_key AS payeeKey, notes,
           bank_category AS bankCategory, bank_category_confident AS bankConfident, category_id AS categoryId, category_source AS source
         FROM transactions
         WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND transfer_pair_id IS NULL
           AND COALESCE(category_source, '') NOT IN ('linked', 'recurring')
         ORDER BY date DESC`,
      )
      .all(JSON.stringify(ids)) as Array<{
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
    }>
  )
  const always = new Set(selected.filter((r) => payeeRule(ctx, r.payeeKey)?.mode === 'always').map((r) => r.payeeKey))
  const rows = selected.filter((r) => !always.has(r.payeeKey))
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = JSON.stringify([r.payeeKey, r.amount, r.notes ?? ''])
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const work = [...groups.values()]
  const set = ctx.sqlite.prepare('UPDATE transactions SET category_id = ?, category_source = ?, category_confidence = ?, needs_review = ? WHERE id = ?')
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
              amountMinor: first.amount,
              accountId: first.accountId,
              date: first.date,
              notes: first.notes,
              bankCategory: first.bankCategory,
              bankConfident: !!first.bankConfident,
            })
            const pick = s?.categoryId
            if (s && pick) {
              ctx.sqlite.transaction(() => {
                for (const r of list) {
                  if (r.categoryId === pick) continue
                  // What you picked before isn't learned any more: it's AI's pick, to review.
                  if (r.source === 'user' && r.categoryId) learn(ctx, r.payeeKey, r.amount, r.categoryId, -1)
                  set.run(pick, 'ai', s.confidence, s.autoApply ? 0 : 1, r.id)
                  changed.push({ id: r.id, before: r.categoryId, after: pick })
                  aiJob.categorized++
                }
              })()
            }
          } catch {
            // Provider errors are logged in ai_calls; keep going with the next one.
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
