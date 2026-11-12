import type { AppContext } from '../services/context'
import type { AiSlot } from '../services/settings'

/**
 * The record of what AI was asked to do (ai_calls): one row per thing asked, however many providers
 * were called for it. A thing that failed and is asked again (a retry, the next sync, by hand) has
 * its row corrected: there's one open (failed) row per thing in a ledger.
 *
 * A failed “Ask AI again” about transactions that had a category remembers which ones (`asked`): a
 * reference to each, the category it had and whether it waited for review, nothing else of them. It's
 * a failure while any of them is still open (stillOpen), and those are what a retry asks about.
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
  /** The open record this asks again, when it asks for a part of what that one did (the payees still without a name, the transactions still open). */
  record?: number
  /** The transactions asked about, when they had a category (“Ask AI again”): what the record remembers while it's failed. */
  asked?: Asked[]
}

/** A transaction a failed “Ask AI again” asked about: a reference to it, and how it was then. */
export interface Asked {
  id: number
  /** The category it had. */
  categoryId: number
  /** It waited for review. */
  review: boolean
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
/** The payee a `categorize` record is about, and the way the money went. */
export function payeeOf(key: string): { payeeKey: string; direction: 'in' | 'out' } {
  const plain = askedAgain(key) ? key.slice(AGAIN.length) : key
  const direction = plain.startsWith('in:') ? 'in' : 'out'
  return { payeeKey: plain.slice(direction.length + 1), direction }
}

/**
 * What “Ask AI again” leaves as it is, of a transaction `t`: a deleted one, a transfer, a refund or
 * payback that follows its purchase, a payment a recurring item categorizes, and a split row.
 */
export const ASKED_AGAIN_ABOUT = `t.deleted_at IS NULL AND t.transfer_pair_id IS NULL AND COALESCE(t.category_source, '') NOT IN ('linked', 'recurring') AND t.split_of IS NULL`

/** The transactions a record remembers (its `asked`). None on a record that keeps no list, one from before it was kept included. */
export function askedOf(list: string | null): Asked[] {
  try {
    const rows: unknown = JSON.parse(list ?? '[]')
    if (!Array.isArray(rows)) return []
    return (rows as Array<Partial<Asked> | null>).filter(
      (a): a is Asked => typeof a?.id === 'number' && typeof a.categoryId === 'number' && typeof a.review === 'boolean',
    )
  } catch {
    return []
  }
}

/** Two lists as one: each transaction once, as the first list has it. */
const joined = (first: Asked[], second: Asked[]) => [...first, ...second.filter((a) => !first.some((b) => b.id === a.id))]
const listed = (asked: Asked[]) => (asked.length ? JSON.stringify(asked.map(({ id, categoryId, review }) => ({ id, categoryId, review }))) : null)

/**
 * The remembered transactions that are still open: in this ledger and not deleted, with the category
 * each had when asked, still waiting for review if it was then (confirming AI's pick closes it), and
 * one “Ask AI again” would ask about now (ASKED_AGAIN_ABOUT, and its payee isn't always set one way).
 */
export function stillOpen(ctx: AppContext, asked: Asked[]): Asked[] {
  if (!asked.length) return []
  const now = new Map(
    ctx.q
      .all<{ id: number; categoryId: number | null; review: number }>(
        `SELECT t.id, t.category_id AS categoryId, t.needs_review AS review FROM transactions t
         WHERE t.ledger_id = @ledger AND t.id IN (SELECT value FROM json_each(?)) AND ${ASKED_AGAIN_ABOUT}
           AND NOT EXISTS (SELECT 1 FROM payee_rules r WHERE r.ledger_id = @ledger AND r.payee_key = t.payee_key AND r.mode = 'always')`,
        JSON.stringify(asked.map((a) => a.id)),
      )
      .map((t) => [t.id, t]),
  )
  return asked.filter((a) => {
    const t = now.get(a.id)
    return !!t && t.categoryId === a.categoryId && (!a.review || !!t.review)
  })
}

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
 * older), with the tries and tokens of both, and the transactions both remember.
 */
export function movePayeeRecords(ctx: AppContext, moves: PayeeMove[]) {
  if (!moves.length) return
  try {
    moveRecords(ctx, moves)
  } catch (err) {
    // The records are left as they were: naming a payee or a bank sync never fails over a note of what AI was asked.
    console.error(`[ai] the failed requests of ${ctx.ledger.name} couldn't follow their payees`, err)
  }
}

function moveRecords(ctx: AppContext, moves: PayeeMove[]) {
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
    const { payeeKey: from, direction } = payeeOf(record.key)
    const tos = targets.get(categorizeKey(from, direction))
    if (!tos) continue
    // The ones it's about that are with the old payee now, less those that just came to it from another: they were never its own.
    const there = ctx.q.pluck<number>(
      `SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND payee_key = ? AND deleted_at IS NULL
         AND ${direction === 'in' ? 'amount_minor > 0' : 'amount_minor <= 0'}${again ? '' : ' AND category_id IS NULL'}`,
      from,
    )!
    const came = moves.filter((m) => m.to === from && m.direction === direction && (again || m.waiting)).length
    if (there > came) continue
    const count = (t: { rows: number; waiting: number }) => (again ? t.rows : t.waiting)
    const [best] = [...tos.values()].filter((t) => count(t) > 0).sort((a, b) => count(b) - count(a))
    if (best) after.set(record.id, { key: categorizeKey(best.to, direction, again), name: best.name })
  }
  // Who ends on each key, oldest first: the oldest keeps it, and the others become part of it.
  const ends = new Map<string, number[]>()
  for (const [id, a] of after) ends.set(a.key, [...(ends.get(a.key) ?? []), id])
  const parked = [...after].filter(([, a]) => a.name !== undefined || ends.get(a.key)!.length > 1).map(([id]) => id)
  if (!parked.length) return
  ctx.q.transaction(() => {
    // Off their keys first, each one that moves or shares the key it ends on: no two open ones share a key at any
    // time, whichever of them is the older, and a record may move to a key another one is about to leave.
    for (const id of parked) ctx.q.run("UPDATE ai_calls SET subject_key = 'moving:' || id WHERE ledger_id = @ledger AND id = ?", id)
    for (const [key, [keep, ...rest]] of ends) {
      if (!parked.includes(keep!)) continue
      for (const id of rest) {
        const { asked, ...other } = ctx.q.get<{
          tries: number
          inputTokens: number | null
          outputTokens: number | null
          firstFailedAt: string | null
          triedAt: string | null
          asked: string | null
        }>(
          `SELECT tries, input_tokens AS inputTokens, output_tokens AS outputTokens, first_failed_at AS firstFailedAt, tried_at AS triedAt, asked
           FROM ai_calls WHERE ledger_id = @ledger AND id = ?`,
          id,
        )!
        const mine = ctx.q.pluck<string | null>('SELECT asked FROM ai_calls WHERE ledger_id = @ledger AND id = ?', keep) ?? null
        ctx.q.run(
          `UPDATE ai_calls SET tries = tries + @tries,
             input_tokens = CASE WHEN @inputTokens IS NULL THEN input_tokens ELSE coalesce(input_tokens, 0) + @inputTokens END,
             output_tokens = CASE WHEN @outputTokens IS NULL THEN output_tokens ELSE coalesce(output_tokens, 0) + @outputTokens END,
             first_failed_at = CASE WHEN @firstFailedAt IS NOT NULL AND (first_failed_at IS NULL OR @firstFailedAt < first_failed_at) THEN @firstFailedAt ELSE first_failed_at END,
             tried_at = CASE WHEN @triedAt IS NOT NULL AND (tried_at IS NULL OR @triedAt > tried_at) THEN @triedAt ELSE tried_at END,
             asked = @asked
           WHERE ledger_id = @ledger AND id = @keep`,
          { ...other, keep, asked: listed(joined(askedOf(mine), askedOf(asked))) },
        )
        ctx.q.run('DELETE FROM ai_calls WHERE ledger_id = @ledger AND id = ?', id)
      }
      // Called what the payee is called now, when any of them moved to it.
      const name = [keep!, ...rest].map((id) => after.get(id)!.name).find((n) => n !== undefined)
      ctx.q.run('UPDATE ai_calls SET subject_key = ?, subject = coalesce(?, subject) WHERE ledger_id = @ledger AND id = ?', key, name ?? null, keep)
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
      // What it remembers that this didn't ask about and is still open: it's failed for those, whatever came of this.
      const about = ask.asked ?? []
      const rest = stillOpen(ctx, askedOf(ctx.q.pluck<string | null>('SELECT asked FROM ai_calls WHERE ledger_id = @ledger AND id = ?', open) ?? null)).filter(
        (a) => !about.some((b) => b.id === a.id),
      )
      if (result.ok && rest.length) {
        // Answered for these ones only: this try and its tokens are counted, and the record stays failed for the others.
        ctx.q.run(
          `UPDATE ai_calls SET asked = @asked, tries = tries + 1, tried_at = ${NOW},
             input_tokens = CASE WHEN @inputTokens IS NULL THEN input_tokens ELSE coalesce(input_tokens, 0) + @inputTokens END,
             output_tokens = CASE WHEN @outputTokens IS NULL THEN output_tokens ELSE coalesce(output_tokens, 0) + @outputTokens END
           WHERE ledger_id = @ledger AND id = @id`,
          { inputTokens: values.inputTokens, outputTokens: values.outputTokens, asked: listed(rest), id: open },
        )
        return
      }
      // The same record, corrected: it keeps when it first failed, and counts this try and its tokens.
      ctx.q.run(
        `UPDATE ai_calls SET slot = @slot, model = @model, latency_ms = @latencyMs, ok = @ok, error = @error, primary_error = @primaryError,
           outcome = @outcome, subject = coalesce(@subject, subject), tries = tries + 1, tried_at = ${NOW}, asked = @asked,
           input_tokens = CASE WHEN @inputTokens IS NULL THEN input_tokens ELSE coalesce(input_tokens, 0) + @inputTokens END,
           output_tokens = CASE WHEN @outputTokens IS NULL THEN output_tokens ELSE coalesce(output_tokens, 0) + @outputTokens END
         WHERE ledger_id = @ledger AND id = @id`,
        { ...values, id: open, asked: result.ok ? null : listed(joined(about, rest)) },
      )
      return
    }
    ctx.q.run(
      `INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok, error, primary_error, outcome, input_tokens, output_tokens,
         kind, subject, subject_key, tries, tried_at, first_failed_at, asked)
       VALUES (@ledger, @slot, @model, @latencyMs, @ok, @error, @primaryError, @outcome, @inputTokens, @outputTokens,
         @kind, @subject, @key, 1, ${NOW}, CASE WHEN @ok THEN NULL ELSE ${NOW} END, @asked)`,
      { ...values, kind: ask.kind, key: ask.key, asked: result.ok ? null : listed(ask.asked ?? []) },
    )
  })
}

/**
 * Asks AI one thing and records it in this ledger: `run` makes the calls, each one noted in the log
 * it's handed, and `answer` says what came of it. Answered, the record is successful, whichever
 * provider did it. Thrown, it's a failure with the reason, and the error goes on to the caller. A
 * thing with an open failed record has that one corrected, never a second row. A failed “Ask AI
 * again” remembers the transactions it asked about, joined with the ones it remembered that are still
 * open, and an answer leaves it failed while others of them are. `asked` as a function
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
