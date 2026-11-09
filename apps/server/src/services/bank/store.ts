import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { addDays, type ISODate } from '@st/shared'
import type { RemoteTransaction } from './types'

/**
 * Each bank account's transactions as its service last reported them (meta.db `bank_transactions`),
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
export function keepTransactions(meta: Database.Database, bankAccountId: string, received: Received, now: string) {
  const existing = meta.prepare('SELECT data, removed_at AS removedAt FROM bank_transactions WHERE bank_account_id = ? AND remote_id = ?')
  const upsert = meta.prepare(
    `INSERT INTO bank_transactions (bank_account_id, remote_id, date, pending, data, removed_at, first_seen_at, updated_at)
     VALUES (@bankAccountId, @remoteId, @date, @pending, @data, NULL, @now, @now)
     ON CONFLICT (bank_account_id, remote_id) DO UPDATE SET date = @date, pending = @pending, data = @data, removed_at = NULL, updated_at = @now`,
  )
  const remove = meta.prepare('UPDATE bank_transactions SET removed_at = ?, updated_at = ? WHERE bank_account_id = ? AND remote_id = ? AND removed_at IS NULL')
  meta.transaction(() => {
    for (const t of received.transactions) {
      const data = JSON.stringify(t)
      const before = existing.get(bankAccountId, t.remoteId) as { data: string; removedAt: string | null } | undefined
      if (before && before.data === data && !before.removedAt) continue
      upsert.run({ bankAccountId, remoteId: t.remoteId, date: t.date, pending: t.pending ? 1 : 0, data, now })
    }
    for (const r of received.removed) remove.run(now, now, bankAccountId, r.remoteId)
    if (received.window) {
      const reported = new Set(received.transactions.map((t) => t.remoteId))
      // A day inside the window's start: it's a timestamp, and dates are local.
      const gone = meta
        .prepare(
          `SELECT remote_id AS remoteId FROM bank_transactions
           WHERE bank_account_id = ? AND pending = 1 AND removed_at IS NULL AND date >= ? AND date <= ?`,
        )
        .all(bankAccountId, addDays(received.window.from, 1), received.window.to) as Array<{ remoteId: string }>
      for (const g of gone) if (!reported.has(g.remoteId)) remove.run(now, now, bankAccountId, g.remoteId)
    }
  })()
}

/** Kept, not trades: what an account can take in. */
const IMPORTABLE = "removed_at IS NULL AND json_extract(data, '$.trade') IS NOT 1"

/** A bank account's transactions the service still reports, from `from` on, oldest first (not trades). */
export function storedTransactions(meta: Database.Database, bankAccountId: string, from?: ISODate | null): RemoteTransaction[] {
  const rows = meta
    .prepare(`SELECT data FROM bank_transactions WHERE bank_account_id = ? AND ${IMPORTABLE} AND date >= ? ORDER BY date, remote_id`)
    .pluck()
    .all(bankAccountId, from ?? '') as string[]
  return rows.map((d) => JSON.parse(d) as RemoteTransaction)
}

/** The date of a bank account's oldest transaction kept (not trades), if any. */
export function oldestStored(meta: Database.Database, bankAccountId: string): ISODate | null {
  return meta.prepare(`SELECT min(date) FROM bank_transactions WHERE bank_account_id = ? AND ${IMPORTABLE}`).pluck().get(bankAccountId) as ISODate | null
}

/** Changes whenever a sync changes what's kept for the bank account. */
export function storedStamp(meta: Database.Database, bankAccountId: string): string {
  const rows = meta
    .prepare('SELECT remote_id, updated_at FROM bank_transactions WHERE bank_account_id = ? ORDER BY remote_id')
    .raw()
    .all(bankAccountId)
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex')
}
