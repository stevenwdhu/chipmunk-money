import { eq } from 'drizzle-orm'
import {
  accountTypeInfo,
  type Account,
  type AccountCreate,
  type AccountUpdate,
  type BalanceSnapshot,
  type BalanceUpdate,
  type ColumnMapping,
  type ISODate,
  type AccountType,
  monthOf,
  monthRange,
} from '@chipmunk/shared'
import { accounts, balanceSnapshots } from '../db/schema'
import { notFound } from '../lib/http'
import type { AppContext } from './context'
import { resolveInstitution } from './institutions'
import { today } from './settings'
import { monthToDate } from './totals'

interface AccountRow {
  id: number
  name: string
  type: AccountType
  currency: string
  opening_balance_minor: number
  opening_date: string | null
  institution_id: number
  institution_name: string
  notes: string | null
  archived_at: string | null
  sort: number
  import_mapping: string | null
  tx_count: number
  snap_date: string | null
  snap_balance: number | null
  tx_after_snap: number
}

/**
 * One balance model for every account:
 *   balance = (latest snapshot, or the opening balance) + Σ transactions dated after that snapshot.
 * Investments, loans and property (revalued) mostly move through snapshots, the others mostly through
 * transactions, and any can have both.
 */
const LIST_SQL = `
  WITH snap AS (
    SELECT s.account_id, s.date, s.balance_minor
    FROM balance_snapshots s
    WHERE s.id = (
      SELECT s2.id FROM balance_snapshots s2
      WHERE s2.account_id = s.account_id
      ORDER BY s2.date DESC, s2.id DESC LIMIT 1
    )
  )
  SELECT a.*, i.name AS institution_name,
    (SELECT count(*) FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL) AS tx_count,
    snap.date AS snap_date,
    snap.balance_minor AS snap_balance,
    (SELECT coalesce(sum(t.amount_minor), 0) FROM transactions t
      WHERE t.account_id = a.id AND t.deleted_at IS NULL
        AND (snap.date IS NULL OR t.date > snap.date)) AS tx_after_snap
  FROM accounts a
  LEFT JOIN institutions i ON i.id = a.institution_id
  LEFT JOIN snap ON snap.account_id = a.id
`

type BankLink = NonNullable<Account['bank']>

/** Bank links for this ledger's accounts (they live in meta.db, since a connection can serve several ledgers). */
function bankLinks(ctx: AppContext): Map<number, BankLink> {
  const rows = ctx.meta.sqlite
    .prepare(
      `SELECT a.id AS bankAccountId, a.connection_id AS connectionId, c.provider, a.institution, a.name, a.account_id AS accountId,
         a.sync_from AS syncFrom, a.last_synced_at AS lastSyncedAt, a.error, a.balance_minor AS balanceMinor, a.balance_date AS balanceDate
       FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id
       WHERE a.ledger_id = ? AND a.account_id IS NOT NULL`,
    )
    .all(ctx.ledger.id) as Array<BankLink & { accountId: number }>
  return new Map(rows.map(({ accountId, ...link }) => [accountId, link]))
}

/** Each account's transactions so far this month (to the month's end, like balances include later-dated ones). */
function thisMonth(ctx: AppContext, accountId?: number) {
  const end = monthRange(monthOf(today(ctx))).to
  const sums = monthToDate(ctx, [end], accountId)
  return (id: number) => sums.get(id)?.[0] ?? 0
}

function toDTO(r: AccountRow, links: Map<number, BankLink>, month: (id: number) => number): Account {
  const base = r.snap_balance ?? r.opening_balance_minor
  const balance = base + r.tx_after_snap
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    currency: r.currency,
    openingBalanceMinor: r.opening_balance_minor,
    openingDate: r.opening_date,
    institutionId: r.institution_id,
    institution: r.institution_name,
    notes: r.notes,
    archived: !!r.archived_at,
    sort: r.sort,
    isLiability: accountTypeInfo(r.type).liability,
    balanceMinor: balance,
    monthMinor: month(r.id),
    balanceAsOf: r.snap_date,
    transactionCount: r.tx_count,
    importMapping: r.import_mapping ? (JSON.parse(r.import_mapping) as ColumnMapping) : null,
    bank: links.get(r.id) ?? null,
  }
}

export function listAccounts(ctx: AppContext): Account[] {
  const rows = ctx.sqlite
    .prepare(`${LIST_SQL} ORDER BY a.archived_at IS NOT NULL, a.sort, a.id`)
    .all() as AccountRow[]
  const links = bankLinks(ctx)
  const month = thisMonth(ctx)
  return rows.map((r) => toDTO(r, links, month))
}

export function getAccount(ctx: AppContext, id: number): Account {
  const row = ctx.sqlite.prepare(`${LIST_SQL} WHERE a.id = ?`).get(id) as AccountRow | undefined
  if (!row) notFound('Account not found')
  return toDTO(row, bankLinks(ctx), thisMonth(ctx, id))
}

export function createAccount(ctx: AppContext, input: Omit<AccountCreate, 'bank'> & { currency: string; openingBalanceMinor: number }) {
  const institution = resolveInstitution(ctx, input)
  const maxSort = ctx.sqlite.prepare('SELECT coalesce(max(sort), -1) AS m FROM accounts').get() as { m: number }
  const row = ctx.db
    .insert(accounts)
    .values({
      name: input.name,
      type: input.type,
      currency: input.currency,
      openingBalanceMinor: input.openingBalanceMinor,
      openingDate: input.openingDate ?? null,
      institutionId: institution.id,
      notes: input.notes ?? null,
      sort: maxSort.m + 1,
    })
    .returning()
    .get()
  return getAccount(ctx, row.id)
}

export function updateAccount(ctx: AppContext, id: number, input: AccountUpdate) {
  getAccount(ctx, id)
  const { archived, institutionId, institution, ...rest } = input
  const placed = institutionId !== undefined || institution !== undefined ? resolveInstitution(ctx, { institutionId, institution }) : null
  ctx.db
    .update(accounts)
    .set({
      ...rest,
      ...(placed ? { institutionId: placed.id } : {}),
      ...(archived === undefined ? {} : { archivedAt: archived ? new Date().toISOString() : null }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(accounts.id, id))
    .run()
  return getAccount(ctx, id)
}

export function deleteAccount(ctx: AppContext, id: number) {
  getAccount(ctx, id)
  ctx.db.delete(accounts).where(eq(accounts.id, id)).run()
  unlinkBankAccounts(ctx.meta, ctx.ledger.id, id)
}

/** Stops syncing into a ledger's accounts (one, or all of them) when they go away. */
export function unlinkBankAccounts(meta: AppContext['meta'], ledgerId: string, accountId?: number) {
  meta.sqlite
    .prepare(`UPDATE bank_accounts SET ledger_id = NULL, account_id = NULL WHERE ledger_id = ? ${accountId === undefined ? '' : 'AND account_id = ?'}`)
    .run(...(accountId === undefined ? [ledgerId] : [ledgerId, accountId]))
}

export function saveImportMapping(ctx: AppContext, id: number, mapping: ColumnMapping) {
  ctx.db.update(accounts).set({ importMapping: mapping }).where(eq(accounts.id, id)).run()
}

/** Records the account balance at the end of `date` (upserts one snapshot per day). */
export function setBalance(ctx: AppContext, id: number, input: BalanceUpdate, source: 'manual' | 'sync' = 'manual') {
  getAccount(ctx, id)
  ctx.db
    .insert(balanceSnapshots)
    .values({ accountId: id, date: input.date, balanceMinor: input.balanceMinor, source })
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.date],
      set: { balanceMinor: input.balanceMinor, source },
    })
    .run()
  return getAccount(ctx, id)
}

export function listSnapshots(ctx: AppContext, id: number): BalanceSnapshot[] {
  getAccount(ctx, id)
  return ctx.sqlite
    .prepare('SELECT id, date, balance_minor AS balanceMinor, source FROM balance_snapshots WHERE account_id = ? ORDER BY date DESC')
    .all(id) as BalanceSnapshot[]
}

/** Deletes a recorded balance and returns it. */
export function deleteSnapshot(ctx: AppContext, accountId: number, snapshotId: number): BalanceSnapshot {
  const row = ctx.sqlite
    .prepare('SELECT id, date, balance_minor AS balanceMinor, source FROM balance_snapshots WHERE id = ? AND account_id = ?')
    .get(snapshotId, accountId) as BalanceSnapshot | undefined
  if (!row) notFound('Balance update not found')
  ctx.sqlite.prepare('DELETE FROM balance_snapshots WHERE id = ?').run(snapshotId)
  return row
}

/**
 * Balances for every account at each requested date (dates ascending). Computed in memory from
 * per-day transaction sums and snapshots, so back-dated edits are always reflected.
 */
export function balancesAt(ctx: AppContext, dates: ISODate[]): Map<number, number[]> {
  const accs = ctx.sqlite
    .prepare('SELECT id, opening_balance_minor AS opening, opening_date AS openingDate FROM accounts')
    .all() as Array<{ id: number; opening: number; openingDate: string | null }>
  const sums = ctx.sqlite
    .prepare(
      `SELECT account_id AS accountId, date, sum(amount_minor) AS total
       FROM transactions WHERE deleted_at IS NULL GROUP BY account_id, date ORDER BY date`,
    )
    .all() as Array<{ accountId: number; date: string; total: number }>
  const snaps = ctx.sqlite
    .prepare('SELECT account_id AS accountId, date, balance_minor AS balance FROM balance_snapshots ORDER BY date')
    .all() as Array<{ accountId: number; date: string; balance: number }>

  const out = new Map<number, number[]>()
  for (const acc of accs) {
    const txs = sums.filter((s) => s.accountId === acc.id)
    const ss = snaps.filter((s) => s.accountId === acc.id)
    out.set(
      acc.id,
      dates.map((d) => {
        if (acc.openingDate && d < acc.openingDate) return 0
        const snap = [...ss].reverse().find((s) => s.date <= d)
        const base = snap ? snap.balance : acc.opening
        let total = base
        for (const t of txs) {
          if (t.date > d) break
          if (!snap || t.date > snap.date) total += t.total
        }
        return total
      }),
    )
  }
  return out
}

/** Month-end balances for one account over the last `months` months, ending today, with each month's own transactions. */
export function accountHistory(ctx: AppContext, id: number, months: number, todayDate: ISODate) {
  getAccount(ctx, id)
  const dates: ISODate[] = []
  const end = todayDate.slice(0, 7)
  for (let i = months - 1; i >= 1; i--) {
    const [y, m] = end.split('-').map(Number) as [number, number]
    const total = y * 12 + (m - 1) - i
    const yy = Math.floor(total / 12)
    const mm = (total % 12) + 1
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
    dates.push(`${yy}-${String(mm).padStart(2, '0')}-${String(last).padStart(2, '0')}`)
  }
  dates.push(todayDate)
  const values = balancesAt(ctx, dates).get(id) ?? []
  const monthly = monthToDate(ctx, dates, id).get(id) ?? []
  return dates.map((date, i) => ({ date, balanceMinor: values[i] ?? 0, monthMinor: monthly[i] ?? 0 }))
}
