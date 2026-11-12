import { HTTPException } from 'hono/http-exception'
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
import type { AppContext, CtxOf } from './context'
import { resolveInstitution } from './institutions'
import { today } from './settings'
import { monthToDate } from './totals'

interface AccountRow {
  id: number
  ledger_id: string
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
  home_ledger_id: string
  opening_ledger_id: string
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
 * A shared account's balance here is this ledger's part instead (sharedAccounts).
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

/**
 * Bank links for this ledger's accounts (a bank account is app-wide: its link is to one account, so
 * to that account's home). A shared account has none in the other ledgers that have it: it syncs
 * into its home.
 */
function bankLinks(ctx: AppContext): Map<number, BankLink> {
  const rows = ctx.q.all<BankLink & { accountId: number }>(
    `SELECT b.id AS bankAccountId, b.connection_id AS connectionId, c.provider, b.institution, b.name, b.account_id AS accountId,
       b.sync_from AS syncFrom, b.last_synced_at AS lastSyncedAt, b.error, b.balance_minor AS balanceMinor, b.balance_date AS balanceDate
     FROM bank_accounts b
     JOIN bank_connections c ON c.id = b.connection_id
     JOIN ledger_accounts a ON a.id = b.account_id AND a.ledger_id = @ledger AND a.home_ledger_id = @ledger`,
  )
  return new Map(rows.map(({ accountId, ...link }) => [accountId, link]))
}

/** Each account's transactions so far this month (to the month's end, like balances include later-dated ones). */
function thisMonth(ctx: AppContext, accountId?: number) {
  const end = monthRange(monthOf(today(ctx))).to
  const sums = monthToDate(ctx, [end], accountId)
  return (id: number) => sums.get(id)?.[0] ?? 0
}

/** What a shared account's home does for it, and the other ledgers that have it don't: said in the 409 of `requireHome`. */
const HOME_ONLY = {
  account: 'Its name, type, opening balance and notes are changed there.',
  balance: 'Its balance is updated there.',
  import: 'CSV files are imported into it there.',
  bank: 'Its bank sync is set up there.',
  sharing: 'Its sharing is changed there.',
} as const

/**
 * Refuses, with a 409 naming the home, what only a shared account's home does (HOME_ONLY), in another
 * ledger that has it. A 404 when this ledger doesn't have the account. Any account of this ledger
 * that isn't shared has it as its home.
 */
export function requireHome(ctx: AppContext, id: number, what: keyof typeof HOME_ONLY) {
  const row = ctx.q.mustGet<{ name: string; home: string }>(
    'SELECT name, home_ledger_id AS home FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?',
    'Account not found',
    id,
  )
  if (row.home === ctx.ledger.id) return
  const home = ctx.accountWide.ledgers(id).find((l) => l.isHome)!
  throw new HTTPException(409, { message: `${row.name}’s home is ${home.name}. ${HOME_ONLY[what]}` })
}

/** A synced account's balance is the bank's: only a manual account's can be set by hand, and only in its home. */
export function requireManualBalance(ctx: AppContext, id: number) {
  requireHome(ctx, id, 'balance')
  const a = getAccount(ctx, id)
  if (!a.bank) return
  throw new HTTPException(409, {
    message: `${a.name} syncs from ${a.bank.institution ?? 'your bank'}, so its balance is the bank’s. Switch it to manual to set the balance yourself.`,
  })
}

/**
 * A shared account's balance in each ledger that has it, and its total, counting every live row
 * (as LIST_SQL does). The total is the latest recorded balance (or the opening balance) plus every
 * ledger's rows dated after it. Each ledger's part is what it holds, except the opening ledger's,
 * which is the rest of the total: so it carries the opening balance and the recorded balances, and
 * the parts always sum to the total. That is the latest recorded balance, plus its own rows after
 * it, less the other ledgers' rows up to it (a recorded balance is the account's total on its day,
 * so they're in it); or, with none recorded, the opening balance plus its own rows. For an account
 * that isn't shared the total is its balance, so this is also what the bank's balance is checked
 * against.
 */
export function currentParts(ctx: AppContext, accountId: number): { totalMinor: number; parts: Map<string, number> } {
  const facts = ctx.accountWide.account(accountId)
  if (!facts) return { totalMinor: 0, parts: new Map() }
  const recorded = facts.recorded
  const held = ctx.accountWide.held(accountId, { split: recorded?.date })
  const totalMinor = (recorded?.balanceMinor ?? facts.openingBalanceMinor) + held.reduce((sum, h) => sum + (recorded ? h.afterMinor : h.totalMinor), 0)
  const others = held.filter((h) => h.ledgerId !== facts.openingLedgerId).reduce((sum, h) => sum + h.totalMinor, 0)
  return { totalMinor, parts: new Map(held.map((h) => [h.ledgerId, h.ledgerId === facts.openingLedgerId ? totalMinor - others : h.totalMinor])) }
}

interface Shared {
  sharing: NonNullable<Account['sharing']>
  /** This ledger's part. */
  balanceMinor: number
}

/** This ledger's shared accounts among `ids`: how each is shared, and this ledger's part of it. */
function sharedAccounts(ctx: AppContext, ids: number[]): Map<number, Shared> {
  const wanted = new Set(ids)
  const out = new Map<number, Shared>()
  for (const id of ctx.accountWide.sharedAccounts(ctx.ledger.id)) {
    if (!wanted.has(id)) continue
    const ledgers = ctx.accountWide.ledgers(id)
    const home = ledgers.find((l) => l.isHome)!
    const opening = ledgers.find((l) => l.isOpening) ?? home
    const { totalMinor, parts } = currentParts(ctx, id)
    out.set(id, {
      sharing: {
        home: { slug: home.slug, name: home.name },
        isHome: home.ledgerId === ctx.ledger.id,
        opening: { slug: opening.slug, name: opening.name },
        ledgers: ledgers.map((l) => ({ slug: l.slug, name: l.name })),
        totalBalanceMinor: totalMinor,
      },
      balanceMinor: parts.get(ctx.ledger.id) ?? 0,
    })
  }
  return out
}

function toDTO(r: AccountRow, links: Map<number, BankLink>, month: (id: number) => number, shared?: Shared): Account {
  const base = r.snap_balance ?? r.opening_balance_minor
  const balance = base + r.tx_after_snap
  // The opening balance and the recorded balances are the home's to show: the other ledgers that
  // have a shared account show what they hold.
  const own = r.home_ledger_id === r.ledger_id
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    currency: r.currency,
    openingBalanceMinor: own ? r.opening_balance_minor : 0,
    openingDate: r.opening_date,
    institutionId: r.institution_id,
    institution: r.institution_name,
    notes: r.notes,
    archived: !!r.archived_at,
    sort: r.sort,
    isLiability: accountTypeInfo(r.type).liability,
    balanceMinor: shared ? shared.balanceMinor : balance,
    monthMinor: month(r.id),
    balanceAsOf: own ? r.snap_date : null,
    transactionCount: r.tx_count,
    importMapping: r.import_mapping ? (JSON.parse(r.import_mapping) as ColumnMapping) : null,
    bank: links.get(r.id) ?? null,
    sharing: shared?.sharing ?? null,
  }
}

export function listAccounts(ctx: AppContext): Account[] {
  const rows = ctx.q.all<AccountRow>(`${LIST_SQL} ORDER BY a.archived_at IS NOT NULL, a.sort, a.id`)
  const links = bankLinks(ctx)
  const month = thisMonth(ctx)
  const shared = sharedAccounts(ctx, rows.map((r) => r.id))
  return rows.map((r) => toDTO(r, links, month, shared.get(r.id)))
}

export function getAccount(ctx: AppContext, id: number): Account {
  const row = ctx.q.mustGet<AccountRow>(`${LIST_SQL} AND a.id = ?`, 'Account not found', id)
  return toDTO(row, bankLinks(ctx), thisMonth(ctx, id), sharedAccounts(ctx, [id]).get(id))
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

/**
 * Changes what's given of an account (left out means unchanged; a null note clears it). Its name,
 * type, opening balance and notes are the account's own, the same in every ledger that has it, and
 * only its home changes them: another ledger may send them only as they are. Its institution, place
 * and archive are each ledger's own (in another ledger than the home, on its member row). A shared
 * account stays the type it is.
 */
export function updateAccount(ctx: AppContext, id: number, input: AccountUpdate) {
  const home = ctx.q.mustGet<{ id: string }>('SELECT home_ledger_id AS id FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', 'Account not found', id)
  const facts = ctx.accountWide.account(id)!
  const { archived, institutionId, institution, name, type, openingBalanceMinor, notes, sort } = input
  const changing = {
    name: name !== undefined && name.trim() !== facts.name,
    type: type !== undefined && type !== facts.type,
    opening: openingBalanceMinor !== undefined && openingBalanceMinor !== facts.openingBalanceMinor,
    notes: notes !== undefined && (notes?.trim() || null) !== facts.notes,
  }
  const isHome = home.id === ctx.ledger.id
  if (!isHome && Object.values(changing).some(Boolean)) requireHome(ctx, id, 'account')
  if (isHome && changing.type && ctx.accountWide.isShared(id)) {
    throw new HTTPException(409, { message: `${facts.name} is shared with other ledgers, so its type can’t change.` })
  }
  const placed = institutionId !== undefined || institution !== undefined ? resolveInstitution(ctx, { institutionId, institution }) : null
  const mine: Record<string, unknown> = {
    sort,
    institution_id: placed?.id,
    archived_at: archived === undefined ? undefined : archived ? new Date().toISOString() : null,
  }
  const set: Record<string, unknown> = isHome
    ? { name, type, opening_balance_minor: openingBalanceMinor, notes, ...mine, updated_at: new Date().toISOString() }
    : mine
  const columns = Object.keys(set).filter((k) => set[k] !== undefined)
  if (columns.length) {
    const { changes } = ctx.q.run(
      isHome
        ? `UPDATE accounts SET ${columns.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND ledger_id = @ledger`
        : `UPDATE account_ledgers SET ${columns.map((c) => `${c} = @${c}`).join(', ')} WHERE account_id = @id AND ledger_id = @ledger`,
      Object.fromEntries([...columns.map((c) => [c, set[c]]), ['id', id]]),
    )
    if (changes !== 1) throw new Error(`Expected to update account ${id} in ledger ${ctx.ledger.id}, updated ${changes}`)
  }
  return getAccount(ctx, id)
}

/**
 * Deletes one of this ledger's accounts. Its transactions, balances and imports go with it, and its
 * bank link is unlinked (foreign keys). A shared account is refused in every ledger that has it:
 * the other ledgers hold rows on it. An account a ledger kept its rows on when it stopped sharing
 * one leaves that one the bank ids it must keep knowing first (leaveSplitOffBankIds).
 */
export function deleteAccount(ctx: AppContext, ctxOf: CtxOf, id: number) {
  const a = getAccount(ctx, id)
  if (ctx.accountWide.isShared(id)) throw new HTTPException(409, { message: `Stop sharing ${a.name} first.` })
  ctx.q.transaction(() => {
    leaveSplitOffBankIds(ctx, ctxOf, id)
    ctx.q.run('DELETE FROM accounts WHERE id = ? AND ledger_id = @ledger', id)
  })
}

/**
 * Before a split-off account goes (one a ledger kept its rows on when it stopped sharing an
 * account), the account it was split off from must keep knowing the bank ids on those rows: they're
 * all that stops its sync, a switch or a CSV import from adding them again. For each one it matches
 * through this account (splitOffHistory), a row kept only for its bank id (bank_id_only) is left on
 * it, in its home, through the home's context: the bank id, the date, amount and payee, when it was
 * created (so the accounts above it still match it) and deleted (now, when it was live), and nothing
 * else of the row (no category, notes, tags, links or recurring item). Such a row is deleted and
 * stays so: the purge leaves it, it can't be restored, and it goes with the account. Nothing for an
 * account that isn't split off from one, or whose parent is gone. Run it in the caller's
 * transaction, before the account's rows go. Returns how many were left.
 *
 * Deleting or erasing the ledger that holds a split-off account must call this for each of its
 * split-off accounts first. That comes with the questions asked before a ledger goes, so nothing
 * calls it there yet: until then those bank ids go with the ledger.
 */
export function leaveSplitOffBankIds(ctx: AppContext, ctxOf: CtxOf, accountId: number): number {
  ctx.q.mustGet('SELECT 1 FROM ledger_accounts WHERE ledger_id = @ledger AND id = ? AND home_ledger_id = @ledger', 'Account not found', accountId)
  const { parent, rows } = ctx.accountWide.splitOffHistory(accountId)
  if (!parent || !rows.length) return 0
  const home = parent.homeLedgerId === ctx.ledger.id ? ctx : ctxOf(parent.homeLedgerId)
  const now = ctx.now().toISOString()
  for (const r of rows) {
    home.q.run(
      `INSERT INTO transactions (ledger_id, account_id, date, datetime, amount_minor, currency, payee, payee_key, status, origin, external_id, deleted_at, created_at, bank_id_only)
       VALUES (@ledger, @accountId, @date, @datetime, @amountMinor, @currency, @payee, @payeeKey, @status, @origin, @externalId, @deletedAt, @createdAt, 1)`,
      { ...r, accountId: parent.id, deletedAt: r.deletedAt ?? now },
    )
  }
  return rows.length
}

export function saveImportMapping(ctx: AppContext, id: number, mapping: ColumnMapping) {
  // Another ledger's account is left as it is. A shared account's mapping is its home's.
  if (ctx.q.pluck('SELECT 1 FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', id)) requireHome(ctx, id, 'import')
  ctx.q.run('UPDATE accounts SET import_mapping = ? WHERE id = ? AND ledger_id = @ledger', JSON.stringify(mapping), id)
}

/**
 * Records the account balance at the end of `date` (upserts one snapshot per day). It is the
 * account's total, so for a shared account it's recorded in its home, for every ledger that has it.
 */
export function setBalance(ctx: AppContext, id: number, input: BalanceUpdate, source: 'manual' | 'sync' = 'manual') {
  requireHome(ctx, id, 'balance')
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

/** The balances recorded on an account. None in a ledger a shared account is shared with: they're its home's, and the account's totals. */
export function listSnapshots(ctx: AppContext, id: number): BalanceSnapshot[] {
  getAccount(ctx, id)
  const home = ctx.q.pluck<string>('SELECT home_ledger_id FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', id)
  if (home !== ctx.ledger.id) return []
  return ctx.q.all<BalanceSnapshot>(`${SNAPSHOT_SQL} WHERE s.account_id = ? ORDER BY s.date DESC`, id)
}

/** Deletes a recorded balance and returns it. */
export function deleteSnapshot(ctx: AppContext, accountId: number, snapshotId: number): BalanceSnapshot {
  const row = ctx.q.mustGet<BalanceSnapshot>(`${SNAPSHOT_SQL} WHERE s.id = ? AND s.account_id = ?`, 'Balance update not found', snapshotId, accountId)
  requireHome(ctx, accountId, 'balance')
  ctx.q.run('DELETE FROM balance_snapshots WHERE id = ? AND account_id IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger)', snapshotId)
  return row
}

/**
 * Balances for every account of this ledger at each requested date (dates ascending). Computed in
 * memory from per-day transaction sums and snapshots, so back-dated edits are always reflected.
 * A shared account's is this ledger's part at each date (as currentParts, up to that date): in its
 * opening ledger, the latest balance recorded by then (or the opening balance) with the other
 * ledgers' rows up to that recorded balance taken out; in any other, what this ledger holds.
 */
export function balancesAt(ctx: AppContext, dates: ISODate[]): Map<number, number[]> {
  const accs = ctx.q.all<{ id: number; opening: number; openingDate: string | null; openingLedgerId: string }>(
    'SELECT id, opening_balance_minor AS opening, opening_date AS openingDate, opening_ledger_id AS openingLedgerId FROM ledger_accounts WHERE ledger_id = @ledger',
  )
  const sums = ctx.q.all<{ accountId: number; date: string; total: number }>(
    `SELECT account_id AS accountId, date, sum(amount_minor) AS total
     FROM transactions WHERE ledger_id = @ledger AND deleted_at IS NULL GROUP BY account_id, date ORDER BY date`,
  )
  const snaps = ctx.q.all<{ accountId: number; date: string; balance: number }>(
    `SELECT s.account_id AS accountId, s.date, s.balance_minor AS balance
     FROM balance_snapshots s JOIN ledger_accounts a ON a.id = s.account_id AND a.ledger_id = @ledger ORDER BY s.date`,
  )

  const shared = new Set(ctx.accountWide.sharedAccounts(ctx.ledger.id))

  const out = new Map<number, number[]>()
  for (const acc of accs) {
    const txs = sums.filter((s) => s.accountId === acc.id)
    const opening = acc.openingLedgerId === ctx.ledger.id
    const ss = opening ? snaps.filter((s) => s.accountId === acc.id) : []
    // The other ledgers' rows on a shared account up to each recorded balance, which is the account's total on its day.
    const elsewhere = new Map<string, number>()
    const othersTo = (date: string) => {
      if (!shared.has(acc.id)) return 0
      if (!elsewhere.has(date)) {
        const held = ctx.accountWide.held(acc.id, { to: date })
        elsewhere.set(date, held.filter((h) => h.ledgerId !== ctx.ledger.id).reduce((sum, h) => sum + h.totalMinor, 0))
      }
      return elsewhere.get(date)!
    }
    out.set(
      acc.id,
      dates.map((d) => {
        if (acc.openingDate && d < acc.openingDate) return 0
        const snap = [...ss].reverse().find((s) => s.date <= d)
        const base = snap ? snap.balance - othersTo(snap.date) : opening ? acc.opening : 0
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
