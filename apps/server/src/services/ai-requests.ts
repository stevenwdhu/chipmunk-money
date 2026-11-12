import type { AiRecord, AiRetry, AiUsage } from '@chipmunk/shared'
import { HTTPException } from 'hono/http-exception'
import { askedAgain, namesOf, payeeOf } from '../ai/records'
import { aiEnabled } from '../ai/runner'
import { badRequest, notFound } from '../lib/http'
import type { AppContext } from './context'
import { aiJobStatus, askedAgainStands, categorizeUncategorized, payeesWaiting } from './import'
import type { PayeeWorld } from './payee-names'
import { retryNames, tidyAvailable, tidyRunning, unnamedPayees, type PayeeTidier } from './payee-tidy'

/**
 * Reading the record of what AI was asked (ai_calls), and asking again about what failed. Whether a
 * failure is still one is worked out as it's read, never written: a failed request to categorize a
 * payee is no longer needed once the payee has no uncategorized transaction left, and one to name
 * payees once they all have names. A retry asks about things as they are now, through the code a
 * normal request uses, which corrects the record.
 *
 * Two kinds of record stand apart. A request to name payees sits in one ledger but is about the
 * payees of every ledger, so a caller that can't use every ledger gets nothing of it: no row, no
 * count, no tokens, and its id is unknown to them. And “Ask AI again” about transactions that had a
 * category is never asked again from here: which transactions were asked about isn't kept, so
 * nothing here can ask about the same ones. It stays failed, to ask again there, until that's
 * answered or it's no longer needed: the payee has no such transaction left, always gets one
 * category, or had a category set by hand since (askedAgainStands).
 */

/** Who reads or retries: what they may do decides what can be retried. */
export interface AiCaller {
  /** May change the ledger's data (the write scope). */
  write: boolean
  /** May use every ledger. Payees are named across all of them, so only such a caller asks for names again. */
  everyLedger: boolean
  /** Payee names in every ledger, to tell which payees still wait for one. */
  world: PayeeWorld
}

interface Row {
  id: number
  kind: 'categorize' | 'names' | 'test' | null
  subject: string | null
  subjectKey: string | null
  slot: 'primary' | 'fallback'
  model: string
  ok: number
  outcome: string | null
  latencyMs: number
  tries: number
  createdAt: string
  triedAt: string | null
  firstFailedAt: string | null
  error: string | null
  primaryError: string | null
}

const COLUMNS = `id, kind, subject, subject_key AS subjectKey, slot, model, ok, outcome, latency_ms AS latencyMs, tries,
  created_at AS createdAt, tried_at AS triedAt, first_failed_at AS firstFailedAt, error, primary_error AS primaryError`

/** Leaves out what the caller gets nothing of: a request to name payees, for one that can't use every ledger. */
const seenBy = (who: AiCaller) => (who.everyLedger ? '' : " AND kind IS NOT 'names'")

const ASKED_AGAIN = 'It was asked with “Ask AI again”, about transactions that had a category. Select them and ask again there.'
const AGAIN_UNNEEDED =
  'This is no longer needed: the payee’s transactions that had a category are gone or were changed by hand since, or the payee always gets one category now.'
const ARCHIVED = 'This ledger is archived. Restore it first, then ask again.'

/** The records being asked again now, by ledger, each with its kind. */
const retrying = new Map<string, Map<number, Row['kind']>>()
const retryingIn = (ctx: AppContext) => {
  let ids = retrying.get(ctx.ledger.id)
  if (!ids) retrying.set(ctx.ledger.id, (ids = new Map()))
  return ids
}
/** How many of them the caller sees: a request to name payees only for one that can use every ledger. */
const retryingSeen = (ctx: AppContext, who: AiCaller) => [...retryingIn(ctx).values()].filter((kind) => who.everyLedger || kind !== 'names').length

/** Tells, for this ledger's records, which failures are still needed. What it reads, it reads once, and only when asked. */
function needs(ctx: AppContext, who: AiCaller) {
  let waiting: Set<string> | undefined
  let unnamed: ((payees: string[]) => string[]) | undefined
  return (row: Row): boolean => {
    if (row.kind === 'categorize' && askedAgain(row.subjectKey)) {
      // Asked about transactions that had a category, it isn't about the uncategorized ones.
      const { payeeKey, direction } = payeeOf(row.subjectKey ?? '')
      return askedAgainStands(ctx, payeeKey, direction, row.triedAt ?? row.createdAt)
    }
    if (row.kind === 'categorize') return (waiting ??= payeesWaiting(ctx)).has(row.subjectKey ?? '')
    if (row.kind === 'names') return (unnamed ??= unnamedPayees(who.world))(namesOf(row.subjectKey)).length > 0
    return true
  }
}

function recordOf(ctx: AppContext, who: AiCaller, row: Row, needed: (row: Row) => boolean): AiRecord {
  const status = row.ok ? 'ok' : needed(row) ? 'failed' : 'unneeded'
  const again = row.kind === 'categorize' && askedAgain(row.subjectKey)
  const asksAgain = (row.kind === 'categorize' && !again) || (row.kind === 'names' && who.everyLedger)
  const noRetry = status !== 'failed' ? null : again ? ASKED_AGAIN : asksAgain && ctx.ledger.archived ? ARCHIVED : null
  return {
    id: row.id,
    kind: row.kind,
    subject: row.kind === 'categorize' ? row.subject : null,
    again,
    payees: row.kind === 'names' ? namesOf(row.subjectKey).length : null,
    ledger: ctx.ledger.name,
    ledgerSlug: ctx.ledger.slug,
    slot: row.slot,
    model: row.model,
    ok: !!row.ok,
    status,
    canRetry: status === 'failed' && asksAgain && who.write && !ctx.ledger.archived,
    noRetry,
    retrying: retryingIn(ctx).has(row.id),
    outcome: row.kind === 'names' ? null : row.outcome,
    named: row.kind === 'names' && row.outcome !== null ? Number(row.outcome) : null,
    latencyMs: row.latencyMs,
    tries: row.tries,
    createdAt: row.createdAt,
    triedAt: row.triedAt ?? row.createdAt,
    firstFailedAt: row.firstFailedAt,
    error: row.error,
    primaryError: row.primaryError,
  }
}

/** A record as kept, and as the caller sees it. */
interface Seen {
  row: Row
  record: AiRecord
}

/** The failed records of this ledger that are for something that can be asked again, as the caller sees them. */
function openFailures(ctx: AppContext, who: AiCaller, needed = needs(ctx, who)): Seen[] {
  return ctx.q
    .all<Row>(`SELECT ${COLUMNS} FROM ai_calls WHERE ledger_id = @ledger AND ok = 0 AND kind IN ('categorize', 'names')${seenBy(who)} ORDER BY id`)
    .map((row) => ({ row, record: recordOf(ctx, who, row, needed) }))
}

/** What AI was asked in this ledger: the totals, and the newest 20 records. */
export function ledgerAiUsage(ctx: AppContext, who: AiCaller): AiUsage {
  const totals = ctx.q.get<{ requests: number; inputTokens: number; outputTokens: number; closed: number }>(
    `SELECT count(*) AS requests, coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens,
       coalesce(sum(CASE WHEN ok = 0 AND (kind IS NULL OR kind = 'test') THEN 1 ELSE 0 END), 0) AS closed
     FROM ai_calls WHERE ledger_id = @ledger${seenBy(who)}`,
  )!
  const needed = needs(ctx, who)
  const open = openFailures(ctx, who, needed).map((x) => x.record)
  const recent = ctx.q.all<Row>(`SELECT ${COLUMNS} FROM ai_calls WHERE ledger_id = @ledger${seenBy(who)} ORDER BY id DESC LIMIT 20`)
  return {
    requests: totals.requests,
    // A connection test or a request from before that failed stays failed: nothing can be asked again.
    failed: totals.closed + open.filter((r) => r.status === 'failed').length,
    retryable: open.filter((r) => r.canRetry).length,
    retrying: retryingSeen(ctx, who),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    recent: recent.map((row) => recordOf(ctx, who, row, needed)),
  }
}

/** The same across ledgers: the totals added up, and the newest 20 of them all. */
export function aiUsage(ledgers: AppContext[], who: AiCaller): AiUsage {
  const usage: AiUsage = { requests: 0, failed: 0, retryable: 0, retrying: 0, inputTokens: 0, outputTokens: 0, recent: [] }
  for (const ctx of ledgers) {
    const one = ledgerAiUsage(ctx, who)
    usage.requests += one.requests
    usage.failed += one.failed
    usage.retryable += one.retryable
    usage.retrying += one.retrying
    usage.inputTokens += one.inputTokens
    usage.outputTokens += one.outputTokens
    usage.recent.push(...one.recent)
  }
  // The newest first, by when each was first asked: a record corrected later keeps its place.
  usage.recent = usage.recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id).slice(0, 20)
  return usage
}

const conflict = (message: string): never => {
  throw new HTTPException(409, { message })
}

/**
 * Asks again about these records, each one the caller can retry: the payees still without a name, as
 * one run of AI tidying for the records of every ledger given, then in each ledger the payees'
 * transactions still uncategorized, as one run of its AI categorization. While either is at work
 * already, its records are left (`working`), and nothing second is started. Returns at once, the
 * work going on in the background, with what started and what was left in each ledger. `given`
 * stands in for the configured providers when names are asked (a test's).
 */
function retry(asked: Array<{ ctx: AppContext; records: Seen[] }>, who: AiCaller, given?: PayeeTidier): AiRetry[] {
  const each = asked.map(({ ctx, records }) => {
    const able = records.filter((x) => x.record.canRetry)
    return {
      ctx,
      categorize: able.filter((x) => x.record.kind === 'categorize'),
      names: able.filter((x) => x.record.kind === 'names'),
      result: { started: 0, working: 0 } as AiRetry,
    }
  })
  // Before anything starts: one ledger's run isn't left going when the next can't start.
  if (each.some((l) => l.categorize.length && !aiEnabled(l.ctx)) || (each.some((l) => l.names.length) && !given && !tidyAvailable(who.world))) {
    badRequest('Set up an AI provider first, in App settings → AI.')
  }
  /** Marks them as being asked again, and gives what unmarks them. */
  const mark = (ctx: AppContext, list: Seen[]) => {
    const marked = retryingIn(ctx)
    for (const x of list) marked.set(x.row.id, x.row.kind)
    return () => list.forEach((x) => marked.delete(x.row.id))
  }
  // Names are made across every ledger, one run at a time: every ledger's records go in the same one.
  const naming = each.filter((l) => l.names.length)
  if (naming.length && tidyRunning(who.world)) {
    for (const l of naming) l.result.working += l.names.length
  } else if (naming.length) {
    const unmark = naming.map((l) => mark(l.ctx, l.names))
    for (const l of naming) l.result.started += l.names.length
    retryNames(
      who.world,
      naming.flatMap((l) => l.names.map((x) => ({ id: x.row.id, ctx: l.ctx, payees: namesOf(x.row.subjectKey) }))),
      given,
      () => unmark.forEach((done) => done()),
    )
  }
  for (const l of each) {
    if (!l.categorize.length) continue
    if (aiJobStatus(l.ctx).running) {
      l.result.working += l.categorize.length
      continue
    }
    const done = mark(l.ctx, l.categorize)
    l.result.started += l.categorize.length
    void categorizeUncategorized(l.ctx, { payees: l.categorize.map((x) => x.row.subjectKey ?? '') }).finally(done)
  }
  return each.map((l) => l.result)
}

/**
 * Asks again about one failed record of this ledger. Refused (409), saying why, for a record that
 * was answered, is no longer needed, is a connection test, is from before requests were recorded or
 * was asked with “Ask AI again”, in an archived ledger, and while AI is already working on the same
 * kind of thing. A record the caller gets nothing of is not found, like an id that doesn't exist.
 */
export function retryRecord(ctx: AppContext, who: AiCaller, id: number, given?: PayeeTidier): AiRetry {
  const row = ctx.q.get<Row>(`SELECT ${COLUMNS} FROM ai_calls WHERE ledger_id = @ledger AND id = ?${seenBy(who)}`, id)
  if (!row) notFound('AI request not found')
  const record = recordOf(ctx, who, row, needs(ctx, who))
  if (record.kind === null) conflict('This request is from before the app kept what each one was for, so it can’t be asked again.')
  if (record.kind === 'test') conflict('A connection test isn’t asked again. Test the connection in App settings → AI.')
  if (record.status === 'ok') conflict('This request was answered, so there’s nothing to ask again.')
  if (record.status === 'unneeded') {
    conflict(
      record.again
        ? AGAIN_UNNEEDED
        : record.kind === 'categorize'
          ? 'This is no longer needed: the payee has no uncategorized transaction left.'
          : 'This is no longer needed: the payees all have names now.',
    )
  }
  if (record.noRetry) conflict(record.noRetry)
  const [result] = retry([{ ctx, records: [{ row, record }] }], who, given) as [AiRetry]
  if (result.working) {
    conflict(record.kind === 'names' ? 'AI is already naming payees. Try again when it’s done.' : 'AI is already working in this ledger. Try again when it’s done.')
  }
  return result
}

/**
 * Asks again about every failed record the caller can retry, in each of these ledgers that isn't
 * archived: the requests to name payees of all of them as one run, then each ledger's requests to
 * categorize. Where AI is already working, its records are left (`working`). `onStarted` hears each
 * ledger where something started, and how many records.
 */
export function retryAll(ledgers: AppContext[], who: AiCaller, onStarted?: (ctx: AppContext, count: number) => void, given?: PayeeTidier): AiRetry {
  const asked = ledgers.filter((ctx) => !ctx.ledger.archived).map((ctx) => ({ ctx, records: openFailures(ctx, who) }))
  const result: AiRetry = { started: 0, working: 0 }
  retry(asked, who, given).forEach((one, i) => {
    if (one.started) onStarted?.(asked[i]!.ctx, one.started)
    result.started += one.started
    result.working += one.working
  })
  return result
}
