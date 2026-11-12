import type { AppContext } from '../services/context'
import type { AiSlot } from '../services/settings'

/**
 * The record of what AI was asked to do (ai_calls): one row per thing asked, however many providers
 * were called for it. A thing that failed and is asked again (a retry, the next sync, by hand) has
 * its row corrected: there's one open (failed) row per thing in a ledger.
 */

export type AiRequestKind = 'categorize' | 'names' | 'test'

/** One call to one provider, made for a request. */
export interface AiAttempt {
  slot: AiSlot
  model: string
  ok: boolean
  error?: string
  inputTokens?: number | null
  outputTokens?: number | null
}

/** What is asked, as its record says it. */
export interface AiAsk {
  kind: AiRequestKind
  /** What it's about, to show: the payee as the ledger calls it. */
  subject: string | null
  /** Which thing it is, so asking again finds its open record. Null: never the same thing twice (a connection test). */
  key: string | null
  /** The open record this asks again, when it asks for a part of what that one did (the payees still without a name). */
  record?: number
}

/** What came of it, and who answered when no call was logged (a test's stand-in). */
export interface AiAnswer {
  outcome: string | null
  slot?: AiSlot
  model?: string | null
}

/** Which payee a `categorize` record is about: the payee key, and the way the money went. */
export const categorizeKey = (payeeKey: string, direction: 'in' | 'out') => `${direction}:${payeeKey}`

/** Which payees a `names` record is about: the payees as sent, in a fixed order. */
export const namesKey = (payees: string[]) => JSON.stringify([...new Set(payees)].sort())
/** The payees of a `names` record. */
export function namesOf(key: string | null): string[] {
  try {
    const list: unknown = JSON.parse(key ?? '[]')
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

function write(ctx: AppContext, ask: AiAsk, log: AiAttempt[], latencyMs: number, result: { ok: true; answer: AiAnswer } | { ok: false; error: string }) {
  const last = log[log.length - 1]
  const tokens = (of: 'inputTokens' | 'outputTokens') => (log.some((a) => a[of] != null) ? log.reduce((n, a) => n + (a[of] ?? 0), 0) : null)
  const primary = log.find((a) => a.slot === 'primary' && !a.ok)
  const values = {
    slot: (result.ok ? result.answer.slot : undefined) ?? last?.slot ?? 'primary',
    model: (result.ok ? result.answer.model : undefined) ?? last?.model ?? '',
    latencyMs,
    ok: result.ok ? 1 : 0,
    error: result.ok ? null : result.error.slice(0, 500),
    // Only when the fallback was asked after it: alone, its error is the record's.
    primaryError: primary && last !== primary ? (primary.error?.slice(0, 500) ?? null) : null,
    outcome: result.ok ? result.answer.outcome : null,
    inputTokens: tokens('inputTokens'),
    outputTokens: tokens('outputTokens'),
    subject: ask.subject,
  }
  ctx.q.transaction(() => {
    const open =
      (ask.record !== undefined
        ? ctx.q.pluck<number>('SELECT id FROM ai_calls WHERE ledger_id = @ledger AND id = ? AND kind = ? AND ok = 0', ask.record, ask.kind)
        : undefined) ??
      (ask.key !== null
        ? ctx.q.pluck<number>('SELECT id FROM ai_calls WHERE ledger_id = @ledger AND kind = ? AND subject_key = ? AND ok = 0', ask.kind, ask.key)
        : undefined)
    if (open !== undefined) {
      // The same record, corrected: it keeps when it first failed, and counts this try and its tokens.
      ctx.q.run(
        `UPDATE ai_calls SET slot = @slot, model = @model, latency_ms = @latencyMs, ok = @ok, error = @error, primary_error = @primaryError,
           outcome = @outcome, subject = coalesce(@subject, subject), tries = tries + 1, tried_at = ${NOW},
           input_tokens = CASE WHEN @inputTokens IS NULL THEN input_tokens ELSE coalesce(input_tokens, 0) + @inputTokens END,
           output_tokens = CASE WHEN @outputTokens IS NULL THEN output_tokens ELSE coalesce(output_tokens, 0) + @outputTokens END
         WHERE ledger_id = @ledger AND id = @id`,
        { ...values, id: open },
      )
      return
    }
    ctx.q.run(
      `INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok, error, primary_error, outcome, input_tokens, output_tokens,
         kind, subject, subject_key, tries, tried_at, first_failed_at)
       VALUES (@ledger, @slot, @model, @latencyMs, @ok, @error, @primaryError, @outcome, @inputTokens, @outputTokens,
         @kind, @subject, @key, 1, ${NOW}, CASE WHEN @ok THEN NULL ELSE ${NOW} END)`,
      { ...values, kind: ask.kind, key: ask.key },
    )
  })
}

/**
 * Asks AI one thing and records it in this ledger: `run` makes the calls, each one noted in the log
 * it's handed, and `answer` says what came of it. Answered, the record is successful, whichever
 * provider did it. Thrown, it's a failure with the reason, and the error goes on to the caller. A
 * thing with an open failed record has that one corrected, never a second row.
 */
export async function recorded<T>(ctx: AppContext, ask: AiAsk, run: (log: AiAttempt[]) => Promise<T>, answer: (value: T) => AiAnswer): Promise<T> {
  const started = Date.now()
  const log: AiAttempt[] = []
  let value: T
  try {
    value = await run(log)
  } catch (err) {
    write(ctx, ask, log, Date.now() - started, { ok: false, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
  write(ctx, ask, log, Date.now() - started, { ok: true, answer: answer(value) })
  return value
}
