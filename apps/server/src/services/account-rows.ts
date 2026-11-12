import type { AccountType, ISODate } from '@chipmunk/shared'
import type { SQLite } from '../db/client'
import { changeHome, crossLedgerReferences, moveRows, type MovedCategory } from '../db/move-rows'
import { allLedgers, type UnscopedQuery } from '../db/scope'
import type { AppContext } from './context'

/**
 * Reads of one account in every ledger that has it (by account_id, not by ledger): a shared
 * account's rows are held by its home and by the ledgers it's shared with. Everything that reads an
 * account across ledgers is here, under one reason in db/unscoped-sites.ts, and goes through
 * `everyLedger`, the module's one unscoped call. What leaves is sums, counts and names, and for the
 * bank code only, the account's rows the bank's data can touch, each with the ledger that holds it
 * (bankRows, bankIds, holder): sync matches against them and writes each row through its holder's
 * context. Those never reach a response.
 *
 * A service reaches these through ctx.accountWide: the reads bound to the connection once
 * (accountReadsOn), shared by every context. To add a read, add a function to READS: it takes the
 * unscoped handle first, and is bound like the others. Beside them are the two writes that span two
 * ledgers, a move's UPDATE (moveRows in db/move-rows.ts) and a home change's statements (changeHome
 * there), each in its own two-ledger scope, not with every ledger in scope. Those are bound to the
 * context's own ledger (accountWideOf): it is the ledger the rows move from, or the home that
 * changes, and the other ledger is a context its caller got from ctxOf.
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

/**
 * A row of the account as bank sync matches it, in whichever ledger holds it (deleted ones too).
 * For the bank code only: it never reaches a response.
 */
export interface BankRow {
  id: number
  /** The ledger that holds it: the one its writes go through. */
  ledgerId: string
  date: ISODate
  amount: number
  payee: string
  payeeKey: string
  status: 'cleared' | 'pending'
  origin: 'manual' | 'import' | 'sync'
  externalId: string | null
  /** You corrected its amount or date: the bank's don't replace them, and it isn't removed. */
  correctedAt: string | null
  deletedAt: string | null
  /** When a sync deleted it because the bank no longer has it. Null when a person deleted it, or it's live. */
  removedAt: string | null
  transferPairId: number | null
}

/** Which row of the account has a bank id, wherever it's held. For the bank code and findByExternalId only. */
export interface BankIdHolder {
  id: number
  ledgerId: string
  deleted: boolean
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

  /**
   * What refers across ledgers from or to the rows these ledgers hold, by what it is, with how
   * many: empty when nothing does (crossLedgerReferences). A move checks its two ledgers with it.
   */
  crossings(db: UnscopedQuery, ledgerIds: readonly string[]): Record<string, number> {
    return crossLedgerReferences(db, ledgerIds)
  },

  /** The shared accounts a ledger has, as their home or as a ledger they're shared with. */
  sharedAccounts(db: UnscopedQuery, ledgerId: string): number[] {
    return db.column<number>(
      `SELECT DISTINCT m.account_id FROM account_ledgers m JOIN accounts a ON a.id = m.account_id
       WHERE m.ledger_id = @ledgerId OR a.ledger_id = @ledgerId ORDER BY m.account_id`,
      { ledgerId },
    )
  },

  /**
   * The account's rows a sync can touch, in every ledger, deleted ones included: each with a bank
   * id, and each dated on or after `since` (what can be adopted, or matched to a bank's row under a
   * new id). For the bank code only.
   */
  bankRows(db: UnscopedQuery, accountId: number, since: ISODate): BankRow[] {
    return db.all<BankRow>(
      `SELECT t.id, t.ledger_id AS ledgerId, t.date, t.amount_minor AS amount, t.payee, t.payee_key AS payeeKey, t.status, t.origin,
         t.external_id AS externalId, t.corrected_at AS correctedAt, t.deleted_at AS deletedAt, t.removed_at AS removedAt,
         t.transfer_pair_id AS transferPairId
       FROM transactions t
       WHERE t.account_id = @accountId AND (t.date >= @since OR t.external_id IS NOT NULL)
       ORDER BY t.id`,
      { accountId, since },
    )
  },

  /** The bank ids the account's rows carry, in every ledger, deleted ones included. For the bank code only. */
  bankIds(db: UnscopedQuery, accountId: number): string[] {
    return db.column<string>('SELECT t.external_id FROM transactions t WHERE t.account_id = ? AND t.external_id IS NOT NULL ORDER BY t.id', accountId)
  },

  /** The row of the account that has this bank id, in whichever ledger holds it (deleted or not), or undefined. */
  holder(db: UnscopedQuery, accountId: number, externalId: string): BankIdHolder | undefined {
    const row = db.get<{ id: number; ledgerId: string; deleted: number }>(
      'SELECT t.id, t.ledger_id AS ledgerId, t.deleted_at IS NOT NULL AS deleted FROM transactions t WHERE t.account_id = ? AND t.external_id = ?',
      accountId,
      externalId,
    )
    return row ? { ...row, deleted: !!row.deleted } : undefined
  },

  /** The date of the account's oldest live row in any ledger, or null when it has none. */
  firstDate(db: UnscopedQuery, accountId: number): ISODate | null {
    return db.pluck<ISODate | null>('SELECT min(t.date) FROM transactions t WHERE t.account_id = ? AND t.deleted_at IS NULL', accountId) ?? null
  },
}

type Bound<F> = F extends (db: UnscopedQuery, ...args: infer A) => infer R ? (...args: A) => R : never

/** This module's reads, bound to one connection: the same for every context. */
export type AccountReads = { readonly [K in keyof typeof READS]: Bound<(typeof READS)[K]> }

/**
 * The reads, and the two writes that span two ledgers, bound to one context's ledger (ctx.accountWide).
 * It holds no connection of its own to hand out.
 */
export type AccountWide = AccountReads & {
  /**
   * Moves this ledger's transactions to `to`, another ledger that has their account (moveRows): the
   * move's one UPDATE. Each row's category in `to` is in `fields`, by id. Returns how many moved.
   */
  readonly moveRows: (move: { to: AppContext; ids: readonly number[]; fields: ReadonlyMap<number, MovedCategory> }) => number
  /**
   * Makes `to`, a ledger the account is shared with, its home (changeHome): the home change's
   * statements. Throws unless this ledger is the account's home.
   */
  readonly changeHome: (accountId: number, to: AppContext) => { payloadsCleared: number }
}

/** The reads of READS on this connection, each run with every ledger in scope. Built once per connection. */
export function accountReadsOn(sqlite: SQLite): AccountReads {
  const bound: Record<string, unknown> = {}
  for (const [name, read] of Object.entries(READS) as Array<[string, (db: UnscopedQuery, ...args: unknown[]) => unknown]>) {
    bound[name] = (...args: unknown[]) => everyLedger(sqlite, (db) => read(db, ...args))
  }
  return Object.freeze(bound) as AccountReads
}

/** One ledger's ctx.accountWide: the shared reads, and the two writes with this ledger as the one they act from, each in its own scope. */
export function accountWideOf(sqlite: SQLite, reads: AccountReads, ledgerId: string): AccountWide {
  return Object.freeze({
    ...reads,
    moveRows: (move: { to: AppContext; ids: readonly number[]; fields: ReadonlyMap<number, MovedCategory> }) =>
      moveRows(sqlite, { from: ledgerId, to: move.to.ledger.id, ids: move.ids, fields: move.fields }),
    changeHome: (accountId: number, to: AppContext) => {
      const home = reads.account(accountId)?.homeLedgerId
      if (home !== ledgerId) throw new Error(`Account ${accountId}'s home isn't ${ledgerId}`)
      return changeHome(sqlite, { accountId, from: ledgerId, to: to.ledger.id })
    },
  })
}
