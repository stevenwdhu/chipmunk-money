import type { AccountType, ISODate } from '@chipmunk/shared'
import type { SQLite } from '../db/client'
import { allLedgers, type UnscopedQuery } from '../db/scope'

/**
 * Reads of one account in every ledger that has it (by account_id, not by ledger): a shared
 * account's rows are held by its home and by the ledgers it's shared with. Everything that reads an
 * account across ledgers is here, under one reason in db/unscoped-sites.ts, and goes through
 * `everyLedger`, the module's one unscoped call. What leaves is sums, counts and names, never a row.
 *
 * A service reaches these through ctx.accountWide, bound to the connection (accountWideOn). To add a
 * read, add a function to READS: it takes the unscoped handle first, and is bound like the others.
 */

/** A ledger that has the account: its home, or one it's shared with. */
export interface AccountLedger {
  ledgerId: string
  slug: string
  name: string
  /** The ledger itself is archived. */
  archived: boolean
  isHome: boolean
  /** Its part carries the opening balance and the recorded balances. */
  isOpening: boolean
}

/** What one ledger holds on the account: its live rows, counted and summed. */
export interface Held {
  ledgerId: string
  count: number
  totalMinor: number
  /** The part of totalMinor dated on or before `split` (all of it without one). */
  onOrBeforeMinor: number
  /** The part of totalMinor dated after `split` (0 without one). */
  afterMinor: number
}

/** The account's own facts, the same in every ledger that has it. */
export interface AccountFacts {
  id: number
  name: string
  type: AccountType
  currency: string
  notes: string | null
  homeLedgerId: string
  openingLedgerId: string
  openingBalanceMinor: number
  openingDate: ISODate | null
  /** The latest recorded balance (on or before `asOf` when given), or null when there's none. */
  recorded: { date: ISODate; balanceMinor: number } | null
}

/** Everything a ledger still has of the account, deleted rows included: what keeps it from leaving. */
export interface Holdings {
  transactions: number
  deletedTransactions: number
  recurringItems: number
  importBatches: number
}

/** The module's one unscoped call: every read in READS runs through it. */
function everyLedger<T>(sqlite: SQLite, fn: (db: UnscopedQuery) => T): T {
  return allLedgers(sqlite, 'one account in every ledger', fn)
}

const READS = {
  /** The ledgers that have the account, the home first, then the others in the ledgers' order. Empty for an account that isn't there. */
  ledgers(db: UnscopedQuery, accountId: number): AccountLedger[] {
    return db
      .all<{ ledgerId: string; slug: string; name: string; archived: number; isHome: number; isOpening: number }>(
        `SELECT l.id AS ledgerId, l.slug, l.name, l.archived_at IS NOT NULL AS archived,
           a.ledger_id = l.id AS isHome, coalesce(a.opening_ledger_id, a.ledger_id) = l.id AS isOpening
         FROM accounts a
         JOIN ledgers l ON l.id = a.ledger_id OR l.id IN (SELECT m.ledger_id FROM account_ledgers m WHERE m.account_id = a.id)
         WHERE a.id = ?
         ORDER BY a.ledger_id = l.id DESC, l.sort, l.created_at`,
        accountId,
      )
      .map((r) => ({ ...r, archived: !!r.archived, isHome: !!r.isHome, isOpening: !!r.isOpening }))
  },

  /**
   * What each ledger that has the account holds on it, live rows only, one entry per ledger (in the
   * order of `ledgers`, with zeros for one that holds nothing). `to`: only rows dated on or before
   * it. `split`: each sum also split into rows dated on or before it and after it.
   */
  held(db: UnscopedQuery, accountId: number, opts: { to?: ISODate; split?: ISODate } = {}): Held[] {
    const sums = new Map(
      db
        .all<Held>(
          `SELECT t.ledger_id AS ledgerId, count(*) AS count, coalesce(sum(t.amount_minor), 0) AS totalMinor,
             coalesce(sum(CASE WHEN @split IS NULL OR t.date <= @split THEN t.amount_minor ELSE 0 END), 0) AS onOrBeforeMinor
           FROM transactions t
           WHERE t.account_id = @accountId AND t.deleted_at IS NULL AND (@to IS NULL OR t.date <= @to)
           GROUP BY t.ledger_id`,
          { accountId, to: opts.to ?? null, split: opts.split ?? null },
        )
        .map((r) => [r.ledgerId, r]),
    )
    return READS.ledgers(db, accountId).map(({ ledgerId }) => {
      const s = sums.get(ledgerId)
      const totalMinor = s?.totalMinor ?? 0
      const onOrBeforeMinor = s?.onOrBeforeMinor ?? 0
      return { ledgerId, count: s?.count ?? 0, totalMinor, onOrBeforeMinor, afterMinor: totalMinor - onOrBeforeMinor }
    })
  },

  /** The account's own facts, with its latest recorded balance (on or before `asOf` when given). Undefined when there's no such account. */
  account(db: UnscopedQuery, accountId: number, asOf?: ISODate): AccountFacts | undefined {
    const row = db.get<Omit<AccountFacts, 'recorded'>>(
      `SELECT a.id, a.name, a.type, a.currency, a.notes, a.ledger_id AS homeLedgerId, coalesce(a.opening_ledger_id, a.ledger_id) AS openingLedgerId,
         a.opening_balance_minor AS openingBalanceMinor, a.opening_date AS openingDate
       FROM accounts a WHERE a.id = ?`,
      accountId,
    )
    if (!row) return undefined
    const recorded = db.get<{ date: ISODate; balanceMinor: number }>(
      `SELECT s.date, s.balance_minor AS balanceMinor FROM balance_snapshots s
       WHERE s.account_id = @accountId AND (@asOf IS NULL OR s.date <= @asOf)
       ORDER BY s.date DESC, s.id DESC LIMIT 1`,
      { accountId, asOf: asOf ?? null },
    )
    return { ...row, recorded: recorded ?? null }
  },

  /** What a ledger has of the account, deleted transactions included. */
  holdings(db: UnscopedQuery, accountId: number, ledgerId: string): Holdings {
    return db.get<Holdings>(
      `SELECT (SELECT count(*) FROM transactions t WHERE t.account_id = @accountId AND t.ledger_id = @ledgerId AND t.deleted_at IS NULL) AS transactions,
         (SELECT count(*) FROM transactions t WHERE t.account_id = @accountId AND t.ledger_id = @ledgerId AND t.deleted_at IS NOT NULL) AS deletedTransactions,
         (SELECT count(*) FROM recurring_items r WHERE r.account_id = @accountId AND r.ledger_id = @ledgerId) AS recurringItems,
         (SELECT count(*) FROM import_batches b WHERE b.account_id = @accountId AND b.ledger_id = @ledgerId) AS importBatches`,
      { accountId, ledgerId },
    )!
  },

  /** Whether the account is shared: some other ledger than its home has it. */
  isShared(db: UnscopedQuery, accountId: number): boolean {
    return db.pluck('SELECT 1 FROM account_ledgers m WHERE m.account_id = ? LIMIT 1', accountId) !== undefined
  },

  /** The shared accounts a ledger has, as their home or as a ledger they're shared with. */
  sharedAccounts(db: UnscopedQuery, ledgerId: string): number[] {
    return db.column<number>(
      `SELECT DISTINCT m.account_id FROM account_ledgers m JOIN accounts a ON a.id = m.account_id
       WHERE m.ledger_id = @ledgerId OR a.ledger_id = @ledgerId ORDER BY m.account_id`,
      { ledgerId },
    )
  },
}

type Bound<F> = F extends (db: UnscopedQuery, ...args: infer A) => infer R ? (...args: A) => R : never

/** This module's reads, bound to one connection (ctx.accountWide). It holds no connection of its own to hand out. */
export type AccountWide = { readonly [K in keyof typeof READS]: Bound<(typeof READS)[K]> }

/** The reads of READS on this connection, each run with every ledger in scope. */
export function accountWideOn(sqlite: SQLite): AccountWide {
  const bound: Record<string, unknown> = {}
  for (const [name, read] of Object.entries(READS) as Array<[string, (db: UnscopedQuery, ...args: unknown[]) => unknown]>) {
    bound[name] = (...args: unknown[]) => everyLedger(sqlite, (db) => read(db, ...args))
  }
  return Object.freeze(bound) as AccountWide
}
