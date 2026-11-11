import type { Activity, ActivityPage } from '@chipmunk/shared'
import type { z } from 'zod'
import type { activityQuerySchema } from '@chipmunk/shared'
import { badRequest } from '../lib/http'
import type { AppContext } from './context'

export interface ActivityEntry {
  /** What happened: create, update, delete, restore, bulk_update, import, … */
  action: string
  /** What it happened to: transaction, account, category, … */
  entity: string
  entityId?: string | number | null
  summary: string
  before?: unknown
  after?: unknown
}

export interface ActivityActor {
  name: string
  apiKeyId: string | null
}

export function recordActivity(ctx: Pick<AppContext, 'q' | 'now'>, actor: ActivityActor, entry: ActivityEntry) {
  ctx.q.run(
    `INSERT INTO activity (ledger_id, created_at, actor, api_key_id, action, entity, entity_id, summary, before, after)
     VALUES (@ledger, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.now().toISOString(),
    actor.name,
    actor.apiKeyId,
    entry.action,
    entry.entity,
    entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
    entry.summary,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
  )
}

/**
 * The fields that differ between two versions of a record, as `{ before, after }` holding only
 * those fields. `updatedAt` is ignored. Null when nothing changed.
 */
export function diff<T extends object>(before: T, after: T): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {}
  const a: Partial<T> = {}
  for (const key of Object.keys({ ...before, ...after }) as Array<keyof T>) {
    if (key === 'updatedAt') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key]
      a[key] = after[key]
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null
}

interface Row {
  id: number
  created_at: string
  actor: string
  action: string
  entity: string
  entity_id: string | null
  summary: string
  before: string | null
  after: string | null
}

const parse = (s: string | null) => (s === null ? null : (JSON.parse(s) as unknown))

export function listActivity(ctx: AppContext, q: z.output<typeof activityQuerySchema>): ActivityPage {
  const where = ['ledger_id = @ledger']
  const params: unknown[] = []
  if (q.actor) {
    where.push('actor = ?')
    params.push(q.actor)
  }
  if (q.entity) {
    where.push('entity = ?')
    params.push(q.entity)
  }
  if (q.cursor) {
    const id = Number(q.cursor)
    if (!Number.isInteger(id)) badRequest('Invalid cursor')
    where.push('id < ?')
    params.push(id)
  }
  const rows = ctx.q.all<Row>(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params, q.limit + 1)
  const page = rows.slice(0, q.limit)
  return {
    items: page.map(
      (r): Activity => ({
        id: r.id,
        createdAt: r.created_at,
        actor: r.actor,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        summary: r.summary,
        before: parse(r.before),
        after: parse(r.after),
      }),
    ),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null,
  }
}

/** Everyone who has changed something in this ledger, most active first (for the filter). */
export function activityActors(ctx: AppContext): string[] {
  return ctx.q.column<string>('SELECT actor FROM activity WHERE ledger_id = @ledger GROUP BY actor ORDER BY count(*) DESC')
}
