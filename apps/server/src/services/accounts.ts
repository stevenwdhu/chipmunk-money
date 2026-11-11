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
 * transactions, and any can have both. Only this ledger's accounts and the transactions it holds count.
 */
const LIST_SQL = `
  SELECT a.*, i.name AS institution_name,
    (SELECT count(*) FROM transactions t
      WHERE t.ledger_id = @ledger AND t.account_id = a.id AND t.deleted_at IS NULL) AS tx_count,
    snap.date AS snap_date,
    snap.balance_minor AS snap_balance,
    (SELECT coalesce(sum(t.amount_minor), 0) FROM transactions t
      WHERE t.ledger_id = @ledger AND t.account_id = a.id AND t.deleted_at IS NULL
        AND (snap.date IS NULL OR t.date > snap.date)) AS tx_after_snap
  FROM ledger_accounts a
  LEFT JOIN institutions i ON i.id = a.institution_id AND i.ledger_id = @ledger
  LEFT JOIN balance_snapshots snap ON snap.account_id = a.id AND snap.id = (
    SELECT s.id FROM balance_snapshots s
    WHERE s.account_id = a.id
    ORDER BY s.date DESC, s.id DESC LIMIT 1
  )
  WHERE a.ledger_id = @ledger`

type BankLink = NonNullable<Account['bank']>

/** Bank links for this ledger's accounts (a bank account is app-wide: its link is to one account, so to that account's ledger). */
function bankLinks(ctx: AppContext): Map<number, BankLink> {
  const rows = ctx.q.all<BankLink & { accountId: number }>(
    `SELECT b.id AS bankAccountId, b.connection_id AS connectionId, c.provider, b.institution, b.name, b.account_id AS accountId,
       b.sync_from AS syncFrom, b.last_synced_at AS lastSyncedAt, b.error, b.balance_minor AS balanceMinor, b.balance_date AS balanceDate
     FROM bank_accounts b
     JOIN bank_connections c ON c.id = b.connection_id
     JOIN ledger_accounts a ON a.id = b.account_id AND a.ledger_id = @ledger`,
  )
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
  const rows = ctx.q.all<AccountRow>(`${LIST_SQL} ORDER BY a.archived_at IS NOT NULL, a.sort, a.id`)
  const links = bankLinks(ctx)
  const month = thisMonth(ctx)
  return rows.map((r) => toDTO(r, links, month))
}

export function getAccount(ctx: AppContext, id: number): Account {
  const row = ctx.q.mustGet<AccountRow>(`${LIST_SQL} AND a.id = ?`, 'Account not found', id)
  return toDTO(row, bankLinks(ctx), thisMonth(ctx, id))
}

export function createAccount(ctx: AppContext, input: Omit<AccountCreate, 'bank'> & { currency: string; openingBalanceMinor: number }) {
  const institution = resolveInstitution(ctx, input)
  const maxSort = ctx.q.pluck<number>('SELECT coalesce(max(sort), -1) FROM ledger_accounts WHERE ledger_id = @ledger')!
  const { lastInsertRowid } = ctx.q.run(
    `INSERT INTO accounts (ledger_id, name, type, currency, opening_balance_minor, opening_date, institution_id, notes, sort)
     VALUES (@ledger, @name, @type, @currency, @opening, @openingDate, @institution, @notes, @sort)`,
    {
      name: input.name,
      type: input.type,
      currency: input.currency,
      opening: input.openingBalanceMinor,
      openingDate: input.openingDate ?? null,
      institution: institution.id,
      notes: input.notes ?? null,
      sort: maxSort + 1,
    },
  )
  return getAccount(ctx, Number(lastInsertRowid))
}

export function updateAccount(ctx: AppContext, id: number, input: AccountUpdate) {
  getAccount(ctx, id)
  const { archived, institutionId, institution, name, type, openingBalanceMinor, notes, sort } = input
  const placed = institutionId !== undefined || institution !== undefined ? resolveInstitution(ctx, { institutionId, institution }) : null
  // Only what's given changes (left out means unchanged; a null note clears it).
  const set: Record<string, unknown> = {
    name,
    type,
    opening_balance_minor: openingBalanceMinor,
    notes,
    sort,
    institution_id: placed?.id,
    archived_at: archived === undefined ? undefined : archived ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }
  const columns = Object.keys(set).filter((k) => set[k] !== undefined)
  ctx.q.run(
    `UPDATE accounts SET ${columns.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND ledger_id = @ledger`,
    Object.fromEntries([...columns.map((c) => [c, set[c]]), ['id', id]]),
  )
  return getAccount(ctx, id)
}

/** Deletes one of this ledger's accounts. Its transactions, balances and imports go with it, and its bank link is unlinked (foreign keys). */
export function deleteAccount(ctx: AppContext, id: number) {
  getAccount(ctx, id)
  ctx.q.run('DELETE FROM accounts WHERE id = ? AND ledger_id = @ledger', id)
}

/**
 * Stops syncing into a ledger's accounts (one, or all of them). Deleting an account unlinks it by
 * itself (bank_accounts.account_id is ON DELETE SET NULL): this is for accounts that stay.
 */
export function unlinkBankAccounts(ctx: Pick<AppContext, 'q'>, accountId?: number) {
  const { q } = ctx
  const mine = 'account_id IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger)'
  if (accountId === undefined) q.run(`UPDATE bank_accounts SET account_id = NULL WHERE ${mine}`)
  else q.run(`UPDATE bank_accounts SET account_id = NULL WHERE account_id = ? AND ${mine}`, accountId)
}

export function saveImportMapping(ctx: AppContext, id: number, mapping: ColumnMapping) {
  ctx.q.run('UPDATE accounts SET import_mapping = ? WHERE id = ? AND ledger_id = @ledger', JSON.stringify(mapping), id)
}

/** Records the account balance at the end of `date` (upserts one snapshot per day). */
export function setBalance(ctx: AppContext, id: number, input: BalanceUpdate, source: 'manual' | 'sync' = 'manual') {
  getAccount(ctx, id)
  ctx.q.run(
    `INSERT INTO balance_snapshots (account_id, date, balance_minor, source) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id, date) DO UPDATE SET balance_minor = excluded.balance_minor, source = excluded.source`,
    id,
    input.date,
    input.balanceMinor,
    source,
  )
  return getAccount(ctx, id)
}

const SNAPSHOT_SQL = `SELECT s.id, s.date, s.balance_minor AS balanceMinor, s.source
  FROM balance_snapshots s JOIN ledger_accounts a ON a.id = s.account_id AND a.ledger_id = @ledger`

export function listSnapshots(ctx: AppContext, id: number): BalanceSnapshot[] {
  getAccount(ctx, id)
  return ctx.q.all<BalanceSnapshot>(`${SNAPSHOT_SQL} WHERE s.account_id = ? ORDER BY s.date DESC`, id)
}

/** Deletes a recorded balance and returns it. */
export function deleteSnapshot(ctx: AppContext, accountId: number, snapshotId: number): BalanceSnapshot {
  const row = ctx.q.mustGet<BalanceSnapshot>(`${SNAPSHOT_SQL} WHERE s.id = ? AND s.account_id = ?`, 'Balance update not found', snapshotId, accountId)
  ctx.q.run('DELETE FROM balance_snapshots WHERE id = ? AND account_id IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger)', snapshotId)
  return row
}

/**
 * Balances for every account of this ledger at each requested date (dates ascending). Computed in
 * memory from per-day transaction sums and snapshots, so back-dated edits are always reflected.
 */
export function balancesAt(ctx: AppContext, dates: ISODate[]): Map<number, number[]> {
  const accs = ctx.q.all<{ id: number; opening: number; openingDate: string | null }>(
    'SELECT id, opening_balance_minor AS opening, opening_date AS openingDate FROM ledger_accounts WHERE ledger_id = @ledger',
  )
  const sums = ctx.q.all<{ accountId: number; date: string; total: number }>(
    `SELECT account_id AS accountId, date, sum(amount_minor) AS total
     FROM transactions WHERE ledger_id = @ledger AND deleted_at IS NULL GROUP BY account_id, date ORDER BY date`,
  )
  const snaps = ctx.q.all<{ accountId: number; date: string; balance: number }>(
    `SELECT s.account_id AS accountId, s.date, s.balance_minor AS balance
     FROM balance_snapshots s JOIN ledger_accounts a ON a.id = s.account_id AND a.ledger_id = @ledger ORDER BY s.date`,
  )

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
