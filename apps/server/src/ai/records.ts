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

const AGAIN = 'again:'
/**
 * Which payee a `categorize` record is about: the payee key, and the way the money went. `again`
 * marks a request about transactions that had a category (“Ask AI again”): another thing than the
 * payee's uncategorized transactions, with a record of its own.
 */
export const categorizeKey = (payeeKey: string, direction: 'in' | 'out', again = false) => `${again ? AGAIN : ''}${direction}:${payeeKey}`
/** Whether a `categorize` record is for a request about transactions that had a category. */
export const askedAgain = (key: string | null) => !!key?.startsWith(AGAIN)

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

/** The open (failed) record for this thing, in the first of these ledgers that has one. */
export function openRecord(ledgers: AppContext[], kind: AiRequestKind, key: string): { ctx: AppContext; id: number } | undefined {
  for (const ctx of ledgers) {
    const id = ctx.q.pluck<number>('SELECT id FROM ai_calls WHERE ledger_id = @ledger AND kind = ? AND subject_key = ? AND ok = 0', kind, key)
    if (id !== undefined) return { ctx, id }
  }
  return undefined
}

/** A transaction that became another payee (its key): which way its money went, whether it waits for a category, and what the payee is called now. */
export interface PayeeMove {
  from: string
  to: string
  direction: 'in' | 'out'
  waiting: boolean
  name: string
}

/**
 * After transactions of this ledger moved to other payees (a payee was named, renamed or merged):
 * the open `categorize` records go with them, so a failure stays one while its transactions still
 * wait, and a retry finds them. A record follows the transactions it's about (the ones waiting for a
 * category, or for an “Ask AI again” record any of them) to the payee most of them became, unless
 * some stay with the old payee. Where that payee has an open record already, the two become one (the
 * older), with the tries and tokens of both.
 */
export function movePayeeRecords(ctx: AppContext, moves: PayeeMove[]) {
  if (!moves.length) return
  const open = ctx.q.all<{ id: number; key: string }>(
    "SELECT id, subject_key AS key FROM ai_calls WHERE ledger_id = @ledger AND kind = 'categorize' AND ok = 0 AND subject_key IS NOT NULL ORDER BY id",
  )
  if (!open.length) return
  const targets = new Map<string, Map<string, { to: string; name: string; rows: number; waiting: number }>>()
  for (const m of moves) {
    const from = categorizeKey(m.from, m.direction)
    const tos = targets.get(from) ?? new Map<string, { to: string; name: string; rows: number; waiting: number }>()
    const t = tos.get(m.to) ?? { to: m.to, name: m.name, rows: 0, waiting: 0 }
    t.rows++
    if (m.waiting) t.waiting++
    tos.set(m.to, t)
    targets.set(from, tos)
  }
  /** Each open record's key after the move, and the name to show for one that moved. */
  const after = new Map<number, { key: string; name?: string }>()
  for (const record of open) {
    after.set(record.id, { key: record.key })
    const again = askedAgain(record.key)
    const plain = again ? record.key.slice(AGAIN.length) : record.key
    const tos = targets.get(plain)
    if (!tos) continue
    const direction = plain.startsWith('in:') ? 'in' : 'out'
    const from = plain.slice(direction.length + 1)
    const stays = ctx.q.pluck(
      `SELECT 1 FROM transactions WHERE ledger_id = @ledger AND payee_key = ? AND deleted_at IS NULL
         AND ${direction === 'in' ? 'amount_minor > 0' : 'amount_minor <= 0'}${again ? '' : ' AND category_id IS NULL'} LIMIT 1`,
      from,
    )
    if (stays) continue
    const count = (t: { rows: number; waiting: number }) => (again ? t.rows : t.waiting)
    const [best] = [...tos.values()].filter((t) => count(t) > 0).sort((a, b) => count(b) - count(a))
    if (best) after.set(record.id, { key: categorizeKey(best.to, direction, again), name: best.name })
  }
  const kept = new Map<string, number>()
  ctx.q.transaction(() => {
    // Off their keys first: a record may move to a key another one is about to leave, and no two open ones share a key.
    for (const [id, a] of after) if (a.name !== undefined) ctx.q.run("UPDATE ai_calls SET subject_key = 'moving:' || id WHERE ledger_id = @ledger AND id = ?", id)
    for (const [id, a] of after) {
      const keep = kept.get(a.key)
      if (keep === undefined) {
        kept.set(a.key, id)
        if (a.name !== undefined) ctx.q.run('UPDATE ai_calls SET subject_key = ?, subject = ? WHERE ledger_id = @ledger AND id = ?', a.key, a.name, id)
        continue
      }
      const other = ctx.q.get<{ tries: number; inputTokens: number | null; outputTokens: number | null; firstFailedAt: string | null }>(
        'SELECT tries, input_tokens AS inputTokens, output_tokens AS outputTokens, first_failed_at AS firstFailedAt FROM ai_calls WHERE ledger_id = @ledger AND id = ?',
        id,
      )!
      ctx.q.run(
        `UPDATE ai_calls SET tries = tries + @tries, subject = coalesce(@name, subject),
           input_tokens = CASE WHEN @inputTokens IS NULL THEN input_tokens ELSE coalesce(input_tokens, 0) + @inputTokens END,
           output_tokens = CASE WHEN @outputTokens IS NULL THEN output_tokens ELSE coalesce(output_tokens, 0) + @outputTokens END,
           first_failed_at = CASE WHEN @firstFailedAt IS NOT NULL AND (first_failed_at IS NULL OR @firstFailedAt < first_failed_at) THEN @firstFailedAt ELSE first_failed_at END
         WHERE ledger_id = @ledger AND id = @keep`,
        { ...other, keep, name: a.name ?? null },
      )
      ctx.q.run('DELETE FROM ai_calls WHERE ledger_id = @ledger AND id = ?', id)
    }
  })
}

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
 * thing with an open failed record has that one corrected, never a second row. `asked` as a function
 * is read when the answer is in: what the thing is called by then.
 */
export async function recorded<T>(ctx: AppContext, asked: AiAsk | (() => AiAsk), run: (log: AiAttempt[]) => Promise<T>, answer: (value: T) => AiAnswer): Promise<T> {
  const started = Date.now()
  const log: AiAttempt[] = []
  const ask = () => (typeof asked === 'function' ? asked() : asked)
  let value: T
  try {
    value = await run(log)
  } catch (err) {
    write(ctx, ask(), log, Date.now() - started, { ok: false, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
  write(ctx, ask(), log, Date.now() - started, { ok: true, answer: answer(value) })
  return value
}
