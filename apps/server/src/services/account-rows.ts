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
 * account's rows, each with the ledger that holds it, for four users only. The bank code: sync
 * matches against them and writes each row through its holder's context (bankRows, bankIds,
 * holder), and a switch pairs them the same way (switchRows), its review showing them only to a
 * caller allowed in every ledger that has the account. A CSV import's duplicate check
 * (importedRows), whose preview names no other ledger's row. And the all-ledgers list
 * (accountTransactions), for a caller allowed in every ledger that has the account, which shows
 * names and amounts but no other ledger's category, tag or link ids. Other than that list and the
 * switch's review, those never reach a response. And deleting a split-off account (splitOffHistory,
 * for accounts.ts), which leaves the account it was split off from the bank ids it must keep knowing.
 *
 * The reads a bank or a CSV matches against also cover the rows a ledger kept when it stopped
 * sharing the account: the rows of the accounts split off from it, at any depth (each names the one
 * it was split off from in accounts.split_from_id), that were the account's before they left it,
 * marked `frozen` (FROZEN). They still carry the bank's ids, so the account's sync and imports know
 * them and never add them again, and never change them either. Sums never count them.
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
 * A row with a bank id that a split-off account (or one split off from it in turn) kept, as the
 * account it was split off from must still know it once the split-off account goes. For accounts.ts only.
 */
export interface SplitOffHistoryRow {
  date: ISODate
  datetime: string | null
  amountMinor: number
  currency: string
  payee: string
  payeeKey: string
  status: 'cleared' | 'pending'
  origin: 'manual' | 'import' | 'sync'
  externalId: string
  deletedAt: string | null
  createdAt: string
}

/**
 * A row of a shared account as the all-ledgers list shows it, in whichever ledger holds it: its
 * category by name only, and no ids of what it's linked to there. For listAccountTransactions only.
 */
export interface AccountTransactionRow {
  id: number
  ledgerId: string
  ledgerSlug: string
  ledgerName: string
  date: ISODate
  datetime: string | null
  amountMinor: number
  currency: string
  payee: string
  /** Its own name, or its recurring item's when it's a payment of one with a name. */
  name: string | null
  category: string | null
  notes: string | null
  status: 'cleared' | 'pending'
  origin: 'manual' | 'import' | 'sync'
  /** Its place in the list, as a register's (the paging cursor). */
  sortKey: string
}

/**
 * The accounts split off from @accountId, at any depth, as `split_offs`: each split-off account
 * names the one it was split off from (split_from_id), so this walks down from the account. Each
 * comes with `bound`, when the account directly below @accountId on its way down was made: the
 * moment its rows left @accountId. A query that reads MATCHED starts with it.
 */
const SPLIT_OFFS = `WITH RECURSIVE split_offs(id, bound) AS (
    SELECT s.id, s.created_at FROM accounts s WHERE s.split_from_id = @accountId
    UNION SELECT s.id, b.bound FROM accounts s JOIN split_offs b ON s.split_from_id = b.id)`

/**
 * The rows a bank or a CSV matches against, as `t`: the account's own (named @accountId), and the
 * frozen ones, which were the account's before they went to an account split off from it
 * (SPLIT_OFFS). A split-off account takes the leaving ledger's rows in the transaction that makes
 * it, so those were created before it was. Rows added to it later, or to one split off from it in
 * turn, aren't the account's history: they're bounded by when the first split-off account below
 * @accountId on their way was made.
 */
const MATCHED = `(t.account_id = @accountId
  OR EXISTS (SELECT 1 FROM split_offs b WHERE b.id = t.account_id AND t.created_at <= b.bound))`

/** Of MATCHED, whether `t` is a frozen row (1) or the account's own (0). */
const FROZEN = '(t.account_id <> @accountId)'

/**
 * A shared account's place for each row in its all-ledgers list, as one string (the register's,
 * transactions.ts): its date; then, that day, money in without a time of day, then ones with a time
 * in time order, then money out without one (none for a credit card, which keeps the order they
 * were added); then the order they were added.
 */
const SORT_KEY = `(t.date || '|' || CASE WHEN t.datetime IS NOT NULL THEN 1 WHEN t.amount_minor < 0 AND a.type <> 'credit' THEN 2 ELSE 0 END
  || '|' || coalesce(t.datetime, '') || '|' || printf('%012d', t.id))`

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
        `${SPLIT_OFFS}
         SELECT t.id, t.ledger_id AS ledgerId, t.date, t.amount_minor AS amount, t.payee, t.payee_key AS payeeKey, t.status, t.origin,
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
    return db.column<string>(`${SPLIT_OFFS} SELECT t.external_id FROM transactions t WHERE ${MATCHED} AND t.external_id IS NOT NULL ORDER BY t.id`, { accountId })
  },

  /**
   * The row of the account that has this bank id, in whichever ledger holds it (deleted or not), or
   * undefined. A frozen row (MATCHED) counts, the account's own first.
   */
  holder(db: UnscopedQuery, accountId: number, externalId: string): BankIdHolder | undefined {
    const row = db.get<{ id: number; ledgerId: string; deleted: number; frozen: number }>(
      `${SPLIT_OFFS}
       SELECT t.id, t.ledger_id AS ledgerId, t.deleted_at IS NOT NULL AS deleted, ${FROZEN} AS frozen FROM transactions t
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
        `${SPLIT_OFFS}
         SELECT t.id, t.ledger_id AS ledgerId, t.date, t.amount_minor AS amount, t.payee_key AS payeeKey, t.external_id AS externalId,
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
   * The payees of the account's purchases dated from `from` to `to`, in every ledger, frozen ones
   * too (MATCHED): its debits that aren't deleted or a transfer. Matching asks only whether a
   * merchant has any, so that money back from it isn't filed as a card payment, also when the
   * purchase went to an account of its own with a ledger that stopped sharing the account.
   */
  purchasePayees(db: UnscopedQuery, accountId: number, from: ISODate, to: ISODate): Array<{ payee: string; payeeKey: string }> {
    // Split rows (the shares a payment gives other ledgers) are to be left out here: a share is a
    // debit, and counted as a purchase it would keep every later card payment from being filed as one.
    return db.all<{ payee: string; payeeKey: string }>(
      `${SPLIT_OFFS}
       SELECT DISTINCT t.payee, t.payee_key AS payeeKey FROM transactions t
       WHERE ${MATCHED} AND t.amount_minor < 0 AND t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
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
      `${SPLIT_OFFS}
       SELECT t.id, t.ledger_id AS ledgerId, t.date, t.amount_minor AS amountMinor, t.name, t.payee, t.payee_key AS payeeKey, t.origin,
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
        `${SPLIT_OFFS}
         SELECT t.id, t.ledger_id, t.account_id, t.date, t.amount_minor, t.payee, t.name, t.external_id, t.deleted_at IS NOT NULL AS deleted
         FROM transactions t WHERE ${MATCHED} ORDER BY t.id`,
        { accountId },
      )
      .map((r) => Object.values(r as Record<string, unknown>))
    return createHash('sha1').update(JSON.stringify(rows)).digest('hex')
  },

  /**
   * The accounts split off from this one, at any depth (SPLIT_OFFS): one a ledger kept its rows on,
   * and one split off from that in turn. Each in the ledger that kept its rows, oldest first.
   */
  splitOffs(db: UnscopedQuery, accountId: number): SplitOff[] {
    return db.all<SplitOff>(
      `${SPLIT_OFFS} SELECT s.id, s.name, s.ledger_id AS ledgerId FROM accounts s WHERE s.id IN (SELECT id FROM split_offs) ORDER BY s.id`,
      { accountId },
    )
  },

  /**
   * What a split-off account leaves the account it was split off from (split_from_id) when it goes:
   * that account and its home, or null when there's none (any more). And the rows with a bank id
   * that account matches through this one (MATCHED there): this one's and those of the accounts
   * split off from it in turn, created before it was made, deleted ones too, each bank id once, and
   * none the parent has a row with already. For accounts.ts's leaveSplitOffBankIds only.
   */
  splitOffHistory(db: UnscopedQuery, splitOffId: number): { parent: { id: number; homeLedgerId: string } | null; rows: SplitOffHistoryRow[] } {
    const parent = db.get<{ id: number; homeLedgerId: string }>(
      'SELECT p.id, p.ledger_id AS homeLedgerId FROM accounts s JOIN accounts p ON p.id = s.split_from_id WHERE s.id = ?',
      splitOffId,
    )
    if (!parent) return { parent: null, rows: [] }
    const rows = db.all<SplitOffHistoryRow>(
      `WITH RECURSIVE below(id) AS (SELECT @splitOffId UNION SELECT s.id FROM accounts s JOIN below b ON s.split_from_id = b.id)
       SELECT t.date, t.datetime, t.amount_minor AS amountMinor, t.currency, t.payee, t.payee_key AS payeeKey, t.status, t.origin,
         t.external_id AS externalId, t.deleted_at AS deletedAt, t.created_at AS createdAt
       FROM transactions t
       WHERE t.account_id IN (SELECT id FROM below) AND t.external_id IS NOT NULL
         AND t.created_at <= (SELECT a.created_at FROM accounts a WHERE a.id = @splitOffId)
         AND NOT EXISTS (SELECT 1 FROM transactions p WHERE p.account_id = @parentId AND p.external_id = t.external_id)
       ORDER BY t.id`,
      { splitOffId, parentId: parent.id },
    )
    const seen = new Set<string>()
    return { parent, rows: rows.filter((r) => !seen.has(r.externalId) && !!seen.add(r.externalId)) }
  },

  /**
   * One page of a shared account's rows in every ledger, live ones only (not the frozen ones), newest
   * first as a register lists them (SORT_KEY), from `from` to `to` and after `cursor` (a row's sort
   * key): `limit` of them. Each with the ledger that holds it, its category by name and nothing else
   * of that ledger's. For listAccountTransactions only.
   */
  accountTransactions(
    db: UnscopedQuery,
    accountId: number,
    opts: { from?: ISODate; to?: ISODate; cursor?: string; limit: number },
  ): AccountTransactionRow[] {
    // Split rows (a payment's shares and what its holder gave) are to be left out here, and the
    // payment to carry its shares instead.
    return db.all<AccountTransactionRow>(
      `SELECT t.id, t.ledger_id AS ledgerId, l.slug AS ledgerSlug, l.name AS ledgerName, t.date, t.datetime, t.amount_minor AS amountMinor,
         t.currency, t.payee, coalesce((SELECT r.title FROM recurring_items r WHERE r.id = t.recurring_item_id AND r.ledger_id = t.ledger_id), t.name) AS name,
         (SELECT c.name FROM categories c WHERE c.id = t.category_id) AS category, t.notes, t.status, t.origin, ${SORT_KEY} AS sortKey
       FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN ledgers l ON l.id = t.ledger_id
       WHERE t.account_id = @accountId AND t.deleted_at IS NULL
         AND (@from IS NULL OR t.date >= @from) AND (@to IS NULL OR t.date <= @to) AND (@cursor IS NULL OR ${SORT_KEY} < @cursor)
       ORDER BY ${SORT_KEY} DESC LIMIT @limit`,
      { accountId, from: opts.from ?? null, to: opts.to ?? null, cursor: opts.cursor ?? null, limit: opts.limit },
    )
  },

  /** The sum of a shared account's live rows in every ledger listed above `sortKey` in its all-ledgers list (SORT_KEY): newer, or later the same day. */
  sumAfter(db: UnscopedQuery, accountId: number, sortKey: string): number {
    return db.pluck<number>(
      `SELECT coalesce(sum(t.amount_minor), 0) FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE t.account_id = @accountId AND t.deleted_at IS NULL AND ${SORT_KEY} > @sortKey`,
      { accountId, sortKey },
    )!
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
