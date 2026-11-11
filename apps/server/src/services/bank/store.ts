import { createHash } from 'node:crypto'
import { and, asc, eq, gte, isNull, lte, min, sql } from 'drizzle-orm'
import { addDays, type ISODate } from '@chipmunk/shared'
import { bankTransactions } from '../../db/schema'
import type { AppStore } from '../context'
import type { RemoteTransaction } from './types'

/**
 * Each bank account's transactions as its service last reported them (the app-wide `bank_transactions`),
 * linked or not. Syncs are the only thing that changes them. Switching or linking an account takes
 * them from here, so it never fetches.
 */

/** What one sync brought for one bank account. */
export interface Received {
  transactions: RemoteTransaction[]
  /**
   * SimpleFIN, Wealthsimple: the dates the request covered, so a pending one it stopped reporting
   * there is gone (it posted under another id, or fell off).
   */
  window: { from: ISODate; to: ISODate } | null
  /** Plaid: the ones it says were removed. */
  removed: Array<{ remoteId: string }>
}

/** Keeps what a sync brought: new ones and changed ones, and marks the ones that are gone. */
export function keepTransactions(app: AppStore, bankAccountId: string, received: Received, now: string) {
  const { db } = app
  const t = bankTransactions
  const ofAccount = eq(t.bankAccountId, bankAccountId)
  const upsert = db
    .insert(t)
    .values({
      bankAccountId,
      remoteId: sql.placeholder('remoteId'),
      date: sql.placeholder('date'),
      pending: sql.placeholder('pending'),
      data: sql.placeholder('data'),
      removedAt: null,
      firstSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [t.bankAccountId, t.remoteId],
      set: { date: sql`excluded.date`, pending: sql`excluded.pending`, data: sql`excluded.data`, removedAt: null, updatedAt: now },
    })
    .prepare()
  const remove = db
    .update(t)
    .set({ removedAt: now, updatedAt: now })
    .where(and(ofAccount, eq(t.remoteId, sql.placeholder('remoteId')), isNull(t.removedAt)))
    .prepare()
  db.transaction(() => {
    const before = new Map(
      db
        .select({ remoteId: t.remoteId, data: t.data, removedAt: t.removedAt })
        .from(t)
        .where(ofAccount)
        .all()
        .map((r) => [r.remoteId, r]),
    )
    for (const tx of received.transactions) {
      const data = JSON.stringify(tx)
      const kept = before.get(tx.remoteId)
      if (kept && kept.data === data && !kept.removedAt) continue
      upsert.run({ remoteId: tx.remoteId, date: tx.date, pending: tx.pending ? 1 : 0, data })
    }
    for (const r of received.removed) remove.run({ remoteId: r.remoteId })
    if (received.window) {
      const reported = new Set(received.transactions.map((tx) => tx.remoteId))
      // A day inside the window's start: it's a timestamp, and dates are local.
      const gone = db
        .select({ remoteId: t.remoteId })
        .from(t)
        .where(and(ofAccount, eq(t.pending, true), isNull(t.removedAt), gte(t.date, addDays(received.window.from, 1)), lte(t.date, received.window.to)))
        .all()
      for (const g of gone) if (!reported.has(g.remoteId)) remove.run({ remoteId: g.remoteId })
    }
  })
}

/** Kept, not trades: what an account can take in. */
const importable = () => and(isNull(bankTransactions.removedAt), sql`json_extract(${bankTransactions.data}, '$.trade') IS NOT 1`)

/** A bank account's transactions the service still reports, from `from` on, oldest first (not trades). */
export function storedTransactions(app: AppStore, bankAccountId: string, from?: ISODate | null): RemoteTransaction[] {
  const t = bankTransactions
  const rows = app.db
    .select({ data: t.data })
    .from(t)
    .where(and(eq(t.bankAccountId, bankAccountId), importable(), gte(t.date, from ?? '')))
    .orderBy(asc(t.date), asc(t.remoteId))
    .all()
  return rows.map((r) => JSON.parse(r.data) as RemoteTransaction)
}

/** The date of a bank account's oldest transaction kept (not trades), if any. */
export function oldestStored(app: AppStore, bankAccountId: string): ISODate | null {
  const t = bankTransactions
  const row = app.db
    .select({ oldest: min(t.date) })
    .from(t)
    .where(and(eq(t.bankAccountId, bankAccountId), importable()))
    .get()
  return row?.oldest ?? null
}

/** Changes whenever a sync changes what's kept for the bank account. */
export function storedStamp(app: AppStore, bankAccountId: string): string {
  const t = bankTransactions
  const rows = app.db
    .select({ remoteId: t.remoteId, updatedAt: t.updatedAt })
    .from(t)
    .where(eq(t.bankAccountId, bankAccountId))
    .orderBy(asc(t.remoteId))
    .all()
    .map((r) => [r.remoteId, r.updatedAt])
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex')
}
