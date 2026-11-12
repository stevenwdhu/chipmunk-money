import type { CategorySource } from '@chipmunk/shared'
import type { SQLite } from './client'
import { ledgerMove, twoLedgers, type UnscopedQuery } from './scope'

/**
 * The statements that touch two ledgers at once, which no one ledger's handle can run: a
 * transaction changing ledger (moveRows), a shared account changing home (changeHome), and the
 * check that nothing refers across ledgers afterwards (crossLedgerReferences). Services reach them
 * through ctx.accountWide, never by running SQL of their own.
 */

/** What a moved transaction's category is in the ledger it moves to. */
export interface MovedCategory {
  categoryId: number | null
  categorySource: CategorySource | null
  categoryConfidence: number | null
  needsReview: boolean
}

export interface RowsMove {
  /** The ledger that holds the rows. */
  from: string
  /** The ledger they go to: one that has their account (tx_move_keeps_refs says so). */
  to: string
  ids: readonly number[]
  /** Each row's category in `to`, by id: one for every id. */
  fields: ReadonlyMap<number, MovedCategory>
}

/**
 * The one place a transaction changes ledger: one UPDATE, in a write scope that lets through only
 * a row of `from` becoming one of `to` (ledgerMove). It sets each row's category in `to` and
 * clears its import batch, recurring item and transfer pair in the same statement, since
 * guard_transactions_update checks those against the new ledger. Whatever else is attached to a
 * row (links, tags, dues, not-payments, rejections, payloads, another row's pair) must be gone
 * already: tx_move_keeps_refs refuses the row otherwise. Throws unless it moved exactly the rows
 * asked for, all of them still in `from`. Returns how many moved.
 */
export function moveRows(sqlite: SQLite, move: RowsMove): number {
  const ids = [...new Set(move.ids)]
  if (ids.length !== move.ids.length) throw new Error('moveRows takes each row once')
  if (!ids.length) return 0
  const rows = ids.map((id) => {
    const f = move.fields.get(id)
    if (!f) throw new Error(`moveRows has no category for transaction ${id}`)
    return { id, categoryId: f.categoryId, source: f.categorySource, confidence: f.categoryConfidence, review: f.needsReview ? 1 : 0 }
  })
  if (move.fields.size !== ids.length) throw new Error('moveRows has categories for rows it isn’t moving')
  return ledgerMove(sqlite, move, () =>
    sqlite.transaction(() => {
      const { changes } = sqlite
        .prepare(
          `UPDATE transactions SET ledger_id = @to, category_id = f.categoryId, category_source = f.source, category_confidence = f.confidence,
             needs_review = f.review, import_batch_id = NULL, recurring_item_id = NULL, transfer_pair_id = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           FROM (SELECT j.value ->> 'id' AS id, j.value ->> 'categoryId' AS categoryId, j.value ->> 'source' AS source,
                   j.value ->> 'confidence' AS confidence, j.value ->> 'review' AS review
                 FROM json_each(@rows) j) AS f
           WHERE transactions.id = f.id AND transactions.ledger_id = @from`,
        )
        .run({ from: move.from, to: move.to, rows: JSON.stringify(rows) })
      if (changes !== ids.length) throw new Error(`Expected to move ${ids.length} transactions from ${move.from} to ${move.to}, moved ${changes}`)
      return changes
    })(),
  )
}

export interface HomeChange {
  accountId: number
  /** The account's home now. */
  from: string
  /** The ledger it's shared with that becomes its home. */
  to: string
}

/**
 * Changes a shared account's home, in a write scope of the two ledgers only (twoLedgers), with the
 * statements in the order the guards of migration 0001 allow:
 * 1. The account goes to `to`, with the institution, sort and archive of `to`'s member row
 *    (keep_ledger_accounts lets it, since `to` has one).
 * 2. `to`'s member row goes (guard_account_ledgers_delete steps aside, `to` being the home now), and
 *    `from` takes one with what the account had.
 * 3. The opening ledger stays the ledger it was: `from` when it was the home (null), null when it
 *    was `to`. Its own UPDATE, after step 2, since guard_accounts_opening_ledger needs `from` to be a
 *    member by then.
 * 4. Bank payloads pointing at rows `to` doesn't hold point at none: only the home's rows have them.
 * Every row stays in the ledger that holds it, and so does every import batch. Each step asserts the
 * rows it changes. Returns how many payloads let go of their row.
 */
export function changeHome(sqlite: SQLite, change: HomeChange): { payloadsCleared: number } {
  const { accountId, from, to } = change
  const one = (what: string, changes: number) => {
    if (changes !== 1) throw new Error(`Changing account ${accountId}'s home from ${from} to ${to}: expected one ${what}, changed ${changes}`)
  }
  return twoLedgers(sqlite, change, () =>
    sqlite.transaction(() => {
      const was = sqlite
        .prepare('SELECT institution_id AS institutionId, sort, archived_at AS archivedAt, opening_ledger_id AS openingLedgerId FROM accounts WHERE id = ? AND ledger_id = ?')
        .get(accountId, from) as { institutionId: number; sort: number; archivedAt: string | null; openingLedgerId: string | null } | undefined
      if (!was) throw new Error(`Account ${accountId}'s home isn't ${from}`)
      const params = { accountId, from, to }

      // 1. An opening ledger that names the home itself is the same as null: written as null, so the
      // guard doesn't take `from` for a ledger that isn't a member yet.
      one(
        'account',
        sqlite
          .prepare(
            `UPDATE accounts SET ledger_id = m.ledger_id, institution_id = m.institution_id, sort = m.sort, archived_at = m.archived_at,
               opening_ledger_id = nullif(accounts.opening_ledger_id, @from), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             FROM account_ledgers m
             WHERE m.account_id = accounts.id AND m.ledger_id = @to AND accounts.id = @accountId AND accounts.ledger_id = @from`,
          )
          .run(params).changes,
      )

      // 2. The member rows change places.
      one('member row of the new home', sqlite.prepare('DELETE FROM account_ledgers WHERE ledger_id = @to AND account_id = @accountId').run(params).changes)
      one(
        'member row of the old home',
        sqlite
          .prepare('INSERT INTO account_ledgers (ledger_id, account_id, institution_id, sort, archived_at) VALUES (@from, @accountId, @institutionId, @sort, @archivedAt)')
          .run({ ...params, institutionId: was.institutionId, sort: was.sort, archivedAt: was.archivedAt }).changes,
      )

      // 3. The opening ledger.
      const opening = was.openingLedgerId ?? from
      const want = opening === to ? null : opening
      const now = was.openingLedgerId === from ? null : was.openingLedgerId
      if (want !== now) {
        one('opening ledger', sqlite.prepare('UPDATE accounts SET opening_ledger_id = @want WHERE id = @accountId AND ledger_id = @to').run({ ...params, want }).changes)
      }

      // 4. Payloads.
      const payloadsCleared = sqlite
        .prepare(
          `UPDATE bank_payloads SET transaction_id = NULL
           WHERE account_id = @accountId AND transaction_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = bank_payloads.transaction_id AND t.ledger_id = @to)`,
        )
        .run(params).changes
      return { payloadsCleared }
    })(),
  )
}

/** Only rows held by these ledgers (a JSON array of ids), or every row when @ledgers is null. */
const HELD = (column: string) => `(@ledgers IS NULL OR ${column} IN (SELECT value FROM json_each(@ledgers)))`

/** An account its ledger doesn't have: not its home, and no member row. */
const NOT_ITS_ACCOUNT = (row: string) => `${row}.account_id IN (SELECT a.id FROM accounts a WHERE a.ledger_id <> ${row}.ledger_id
  AND NOT EXISTS (SELECT 1 FROM account_ledgers m WHERE m.account_id = a.id AND m.ledger_id = ${row}.ledger_id))`

/** Each way a row can refer across ledgers, counted. */
const CROSSINGS: Record<string, string> = {
  'transaction on an account its ledger doesn’t have': `SELECT count(*) FROM transactions t WHERE ${NOT_ITS_ACCOUNT('t')} AND ${HELD('t.ledger_id')}`,
  'recurring item on an account its ledger doesn’t have': `SELECT count(*) FROM recurring_items r WHERE ${NOT_ITS_ACCOUNT('r')} AND ${HELD('r.ledger_id')}`,
  'transaction in a category its ledger doesn’t use': `SELECT count(*) FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE c.ledger_id IS NOT t.ledger_id AND NOT (c.ledger_id IS NULL AND (SELECT k.category_list FROM ledgers k WHERE k.id = t.ledger_id) = 'shared')
      AND ${HELD('t.ledger_id')}`,
  'transaction with another ledger’s recurring item': `SELECT count(*) FROM transactions t JOIN recurring_items r ON r.id = t.recurring_item_id
    WHERE r.ledger_id <> t.ledger_id AND (${HELD('t.ledger_id')} OR ${HELD('r.ledger_id')})`,
  'transaction with another ledger’s import batch': `SELECT count(*) FROM transactions t JOIN import_batches b ON b.id = t.import_batch_id
    WHERE b.ledger_id <> t.ledger_id AND (${HELD('t.ledger_id')} OR ${HELD('b.ledger_id')})`,
  'transfer paired across ledgers': `SELECT count(*) FROM transactions t JOIN transactions p ON p.id = t.transfer_pair_id
    WHERE p.ledger_id <> t.ledger_id AND (${HELD('t.ledger_id')} OR ${HELD('p.ledger_id')})`,
  'link across ledgers': `SELECT count(*) FROM transaction_links l JOIN transactions i ON i.id = l.money_in_id JOIN transactions o ON o.id = l.money_out_id
    WHERE i.ledger_id <> o.ledger_id AND (${HELD('i.ledger_id')} OR ${HELD('o.ledger_id')})`,
  'rejected pair across ledgers': `SELECT count(*) FROM transfer_rejections x JOIN transactions i ON i.id = x.in_id JOIN transactions o ON o.id = x.out_id
    WHERE i.ledger_id <> o.ledger_id AND (${HELD('i.ledger_id')} OR ${HELD('o.ledger_id')})`,
  'tag of another ledger': `SELECT count(*) FROM transaction_tags g JOIN transactions t ON t.id = g.transaction_id JOIN tags x ON x.id = g.tag_id
    WHERE x.ledger_id <> t.ledger_id AND (${HELD('t.ledger_id')} OR ${HELD('x.ledger_id')})`,
  'recurring due across ledgers': `SELECT count(*) FROM recurring_payment_dues d JOIN transactions t ON t.id = d.transaction_id JOIN recurring_items r ON r.id = d.item_id
    WHERE r.ledger_id <> t.ledger_id AND (${HELD('t.ledger_id')} OR ${HELD('r.ledger_id')})`,
  'not-payment across ledgers': `SELECT count(*) FROM recurring_not_payments n JOIN transactions t ON t.id = n.transaction_id JOIN recurring_items r ON r.id = n.item_id
    WHERE r.ledger_id <> t.ledger_id AND (${HELD('t.ledger_id')} OR ${HELD('r.ledger_id')})`,
  'bank payload pointing at a row held outside the home': `SELECT count(*) FROM bank_payloads x JOIN transactions t ON t.id = x.transaction_id JOIN accounts a ON a.id = x.account_id
    WHERE t.ledger_id <> a.ledger_id AND (${HELD('t.ledger_id')} OR ${HELD('a.ledger_id')})`,
}

/**
 * Every reference that crosses ledgers, by what it is, with how many there are: none is how it
 * should be. A transaction's account, category, recurring item, import batch and transfer pair,
 * a recurring item's account, links, rejected pairs, tags, dues and not-payments, and bank
 * payloads (which point only at rows the account's home holds). With `ledgers`, only references
 * from or to rows those ledgers hold. Read with every ledger in scope (`db`).
 */
export function crossLedgerReferences(db: Pick<UnscopedQuery, 'pluck'>, ledgers?: readonly string[]): Record<string, number> {
  const found: Record<string, number> = {}
  const params = { ledgers: ledgers ? JSON.stringify(ledgers) : null }
  for (const [what, sql] of Object.entries(CROSSINGS)) {
    const n = db.pluck<number>(sql, params)!
    if (n) found[what] = n
  }
  return found
}
