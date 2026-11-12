import { createHash } from 'node:crypto'
import type { AccountType, ISODate } from '@chipmunk/shared'
import type { SQLite } from '../db/client'
import { changeHome, crossLedgerReferences, moveRows, type MovedCategory } from '../db/move-rows'
import { allLedgers, type UnscopedQuery } from '../db/scope'
import type { AppContext } from './context'

/**
 * Reads of one account in every ledger that has it (by account_id, not by ledger): a shared
 * account's rows are held by its home and by the ledgers it's shared with. Everything that reads an
 * account across ledgers is here, under one reason in db/unscoped-sites.ts, and goes through
 * `everyLedger`, the module's one unscoped call. What leaves is sums, counts and names, and the
 * account's rows, each with the ledger that holds it, for two users only. The bank code: sync
 * matches against them and writes each row through its holder's context (bankRows, bankIds,
 * holder), and a switch pairs them the same way (switchRows), its review showing them only to a
 * caller allowed in every ledger that has the account. And a CSV import's duplicate check
 * (importedRows), whose preview names no other ledger's row. Other than that review, those never
 * reach a response.
 *
 * The reads a bank or a CSV matches against also cover the rows a ledger kept when it stopped
 * sharing the account: the rows of its split-off accounts (accounts.split_from_id) that were there
 * when each was made, marked `frozen` (FROZEN). They still carry the bank's ids, so the account's
 * sync and imports know them and never add them again, and never change them either. Sums never
 * count them.
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
  /** A split-off account's row, kept by a ledger that stopped sharing the account: known by its bank id, never changed. */
  frozen: boolean
}

/** Which row of the account has a bank id, wherever it's held. For the bank code and findByExternalId only. */
export interface BankIdHolder {
  id: number
  ledgerId: string
  deleted: boolean
  /** It's on a split-off account (FROZEN), not on this one. */
  frozen: boolean
}

/**
 * A row of the account as a CSV import's duplicate check sees it, in whichever ledger holds it. For
 * import.ts only: a preview names the row only when the importing ledger holds it.
 */
export interface ImportedRow {
  id: number
  ledgerId: string
  date: ISODate
  amount: number
  payeeKey: string
  externalId: string | null
  deleted: boolean
  /** It's on a split-off account (FROZEN): a duplicate all the same. */
  frozen: boolean
}

/**
 * A row of the account as a bank switch pairs it, in whichever ledger holds it (deleted ones too).
 * For the switch only: its review shows another ledger's rows only to a caller allowed in every
 * ledger that has the account.
 */
export interface SwitchRow {
  id: number
  /** The ledger that holds it: the one its writes go through. */
  ledgerId: string
  date: ISODate
  amountMinor: number
  name: string | null
  payee: string
  payeeKey: string
  origin: 'manual' | 'import' | 'sync'
  externalId: string | null
  deletedAt: string | null
  /**
   * The split-off account it's on, by name, when it's a frozen row (FROZEN): a switch only gives it
   * the new bank id. Null for the account's own.
   */
  splitOff: string | null
}

/** An account split off from this one, when a ledger stopped sharing it and kept its rows: in that ledger. */
export interface SplitOff {
  id: number
  name: string
  ledgerId: string
}

/**
 * The rows a bank or a CSV matches against, as `t`: the account's own (named @accountId), and the
 * frozen ones, which a split-off account had when it was made. A split-off account is made with
 * split_from_id naming the account, and takes the leaving ledger's rows in the same transaction, so
 * those were created before it was. Rows added to it later aren't the account's history.
 */
const MATCHED = `(t.account_id = @accountId
  OR t.account_id IN (SELECT s.id FROM accounts s WHERE s.split_from_id = @accountId AND t.created_at <= s.created_at))`

/** Of MATCHED, whether `t` is a frozen row (1) or the account's own (0). */
const FROZEN = '(t.account_id <> @accountId)'

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
   * new id). And the frozen rows with a bank id (MATCHED), which a sync only knows. For the bank code only.
   */
  bankRows(db: UnscopedQuery, accountId: number, since: ISODate): BankRow[] {
    return db
      .all<Omit<BankRow, 'frozen'> & { frozen: number }>(
        `SELECT t.id, t.ledger_id AS ledgerId, t.date, t.amount_minor AS amount, t.payee, t.payee_key AS payeeKey, t.status, t.origin,
           t.external_id AS externalId, t.corrected_at AS correctedAt, t.deleted_at AS deletedAt, t.removed_at AS removedAt,
           t.transfer_pair_id AS transferPairId, ${FROZEN} AS frozen
         FROM transactions t
         WHERE ${MATCHED} AND (t.external_id IS NOT NULL OR (t.account_id = @accountId AND t.date >= @since))
         ORDER BY t.id`,
        { accountId, since },
      )
      .map((r) => ({ ...r, frozen: !!r.frozen }))
  },

  /** The bank ids the account's rows carry, in every ledger, deleted ones and frozen ones (MATCHED) included. For the bank code only. */
  bankIds(db: UnscopedQuery, accountId: number): string[] {
    return db.column<string>(`SELECT t.external_id FROM transactions t WHERE ${MATCHED} AND t.external_id IS NOT NULL ORDER BY t.id`, { accountId })
  },

  /**
   * The row of the account that has this bank id, in whichever ledger holds it (deleted or not), or
   * undefined. A frozen row (MATCHED) counts, the account's own first.
   */
  holder(db: UnscopedQuery, accountId: number, externalId: string): BankIdHolder | undefined {
    const row = db.get<{ id: number; ledgerId: string; deleted: number; frozen: number }>(
      `SELECT t.id, t.ledger_id AS ledgerId, t.deleted_at IS NOT NULL AS deleted, ${FROZEN} AS frozen FROM transactions t
       WHERE ${MATCHED} AND t.external_id = @externalId ORDER BY ${FROZEN}, t.id LIMIT 1`,
      { accountId, externalId },
    )
    return row ? { ...row, deleted: !!row.deleted, frozen: !!row.frozen } : undefined
  },

  /** The date of the account's oldest live row in any ledger, or null when it has none. */
  firstDate(db: UnscopedQuery, accountId: number): ISODate | null {
    return db.pluck<ISODate | null>('SELECT min(t.date) FROM transactions t WHERE t.account_id = ? AND t.deleted_at IS NULL', accountId) ?? null
  },

  /**
   * The account's rows a CSV import can duplicate, in every ledger, frozen ones too (MATCHED): each
   * with one of these bank ids (deleted ones too), and each live one dated from `from` to `to`. For
   * import.ts only.
   */
  importedRows(db: UnscopedQuery, accountId: number, opts: { externalIds: readonly string[]; from: ISODate; to: ISODate }): ImportedRow[] {
    return db
      .all<Omit<ImportedRow, 'deleted' | 'frozen'> & { deleted: number; frozen: number }>(
        `SELECT t.id, t.ledger_id AS ledgerId, t.date, t.amount_minor AS amount, t.payee_key AS payeeKey, t.external_id AS externalId,
           t.deleted_at IS NOT NULL AS deleted, ${FROZEN} AS frozen
         FROM transactions t
         WHERE ${MATCHED}
           AND (t.external_id IN (SELECT value FROM json_each(@externalIds)) OR (t.deleted_at IS NULL AND t.date BETWEEN @from AND @to))
         ORDER BY t.id`,
        { accountId, externalIds: JSON.stringify(opts.externalIds), from: opts.from, to: opts.to },
      )
      .map((r) => ({ ...r, deleted: !!r.deleted, frozen: !!r.frozen }))
  },

  /**
   * The payees of the account's purchases dated from `from` to `to`, in every ledger: its debits
   * that aren't deleted or a transfer. Matching asks only whether a merchant has any, so that money
   * back from it isn't filed as a card payment.
   */
  purchasePayees(db: UnscopedQuery, accountId: number, from: ISODate, to: ISODate): Array<{ payee: string; payeeKey: string }> {
    // Split rows (the shares a payment gives other ledgers) are to be left out here: a share is a
    // debit, and counted as a purchase it would keep every later card payment from being filed as one.
    return db.all<{ payee: string; payeeKey: string }>(
      `SELECT DISTINCT t.payee, t.payee_key AS payeeKey FROM transactions t
       WHERE t.account_id = @accountId AND t.amount_minor < 0 AND t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
         AND t.date BETWEEN @from AND @to
       ORDER BY t.payee_key, t.payee`,
      { accountId, from, to },
    )
  },

  /**
   * The account's rows dated on or after `from`, in every ledger, deleted ones and frozen ones
   * (MATCHED) too: what a bank switch pairs. For the switch only.
   */
  switchRows(db: UnscopedQuery, accountId: number, from: ISODate): SwitchRow[] {
    return db.all<SwitchRow>(
      `SELECT t.id, t.ledger_id AS ledgerId, t.date, t.amount_minor AS amountMinor, t.name, t.payee, t.payee_key AS payeeKey, t.origin,
         t.external_id AS externalId, t.deleted_at AS deletedAt,
         CASE WHEN ${FROZEN} THEN (SELECT s.name FROM accounts s WHERE s.id = t.account_id) END AS splitOff
       FROM transactions t
       WHERE ${MATCHED} AND t.date >= @from
       ORDER BY t.id`,
      { accountId, from },
    )
  },

  /**
   * A hash of the account's rows in every ledger, each with its ledger and account, deleted ones and
   * frozen ones (MATCHED) too: it changes when one is added, edited in a way a switch's review shows,
   * deleted or moved.
   */
  switchStamp(db: UnscopedQuery, accountId: number): string {
    const rows = db
      .all(
        `SELECT t.id, t.ledger_id, t.account_id, t.date, t.amount_minor, t.payee, t.name, t.external_id, t.deleted_at IS NOT NULL AS deleted
         FROM transactions t WHERE ${MATCHED} ORDER BY t.id`,
        { accountId },
      )
      .map((r) => Object.values(r as Record<string, unknown>))
    return createHash('sha1').update(JSON.stringify(rows)).digest('hex')
  },

  /** The accounts split off from this one (accounts.split_from_id), each in the ledger that kept its rows, oldest first. */
  splitOffs(db: UnscopedQuery, accountId: number): SplitOff[] {
    return db.all<SplitOff>('SELECT s.id, s.name, s.ledger_id AS ledgerId FROM accounts s WHERE s.split_from_id = ? ORDER BY s.id', accountId)
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
