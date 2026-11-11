import { createHash } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { idempotencyKeys } from '../db/schema'
import type { AppStore, MetaStore } from '../services/context'
import { actorId, type Actor } from './auth'

const KEEP_MS = 24 * 60 * 60 * 1000

/** Forgets the keys older than 24 hours. */
export function purgeIdempotencyKeys(app: AppStore, now: Date) {
  app.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - KEEP_MS).toISOString())).run()
}

/**
 * `Idempotency-Key` on a POST: the first successful JSON response is stored for 24 hours, and a
 * retry with the same key gets that response back (with `Idempotent-Replayed: true`) instead of
 * doing the work again. Reusing a key for a different request is a conflict. Keys are per caller,
 * not per ledger: the same key sent to another ledger's path is a different request.
 */
export function idempotency(opts: { meta: MetaStore; now: () => Date }): MiddlewareHandler<{ Variables: { actor: Actor } }> {
  const { db } = opts.meta
  return async (c, next) => {
    const key = c.req.header('idempotency-key')
    if (c.req.method !== 'POST' || !key) return next()
    if (key.length > 200) throw new HTTPException(400, { message: 'Idempotency-Key must be at most 200 characters' })

    const actor = actorId(c.var.actor)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const url = new URL(c.req.url)
    const fingerprint = createHash('sha256').update(`POST ${url.pathname}${url.search}\n`).update(bytes).digest('hex')
    const now = opts.now()
    purgeIdempotencyKeys(opts.meta, now)

    const where = and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.actor, actor))
    const seen = db.select().from(idempotencyKeys).where(where).get()
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new HTTPException(409, { message: 'This Idempotency-Key was already used for a different request.' })
      }
      if (seen.status === null) {
        throw new HTTPException(409, { message: 'A request with this Idempotency-Key is still in progress.' })
      }
      return new Response(seen.body, {
        status: seen.status,
        headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
      })
    }

    db.insert(idempotencyKeys).values({ key, actor, fingerprint, createdAt: now.toISOString() }).run()
    let stored = false
    try {
      await next()
      const res = c.res
      if (res.status < 300 && res.headers.get('content-type')?.includes('application/json')) {
        const body = await res.clone().text()
        db.update(idempotencyKeys).set({ status: res.status, body }).where(where).run()
        stored = true
      }
    } finally {
      // Failures aren't remembered, so the caller can fix the request and retry with the same key.
      if (!stored) db.delete(idempotencyKeys).where(where).run()
    }
  }
}
