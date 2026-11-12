import { addDays, daysBetween, payeeSimilarity, type BankPayload, type BankProviderKind, type ISODate } from '@chipmunk/shared'
import { historySuggestion } from '../categorize'
import type { BankRow } from '../account-rows'
import type { AppContext, CtxOf } from '../context'
import { paidOff, recalculateRecurring } from '../recurring'
import { followBankPayee } from '../payee-names'
import { payeeKeyOf } from '../payee-namer'
import { insertTransaction } from '../transactions'
import type { RemoteTransaction } from './types'

/** What a sync changed, in all or in one ledger that holds the account's rows. */
export interface LedgerChanges {
  added: number
  updated: number
  /** Matched to a transaction you entered or imported, which now carries the bank's id. */
  adopted: number
  /** Pending transactions the bank no longer reports. */
  removed: number
}

export interface ApplyResult extends LedgerChanges {
  /** New transactions, for AI categorization afterwards. All in the home. */
  newIds: number[]
  /**
   * What changed, by the ledger that holds the rows (its id): new ones in the home, and the rest
   * where each row is. Only ledgers where something changed. For each one's activity and matching.
   */
  byLedger: Map<string, LedgerChanges>
}

type LocalRow = BankRow

/** How long a pending row the bank removed can still come back as itself, posted. */
const RESTORE_DAYS = 7

/** A pending charge often posts with a different amount (tips, gas holds) and date. */
function couldBePosted(pending: LocalRow, r: RemoteTransaction, key: string) {
  const sameSign = Math.sign(pending.amount) === Math.sign(r.amountMinor)
  const close = Math.abs(r.amountMinor - pending.amount) <= Math.max(500, Math.abs(pending.amount) * 0.25)
  const days = daysBetween(pending.date, r.date)
  return sameSign && close && days >= -1 && days <= 7 && (pending.payeeKey === key || payeeSimilarity(pending.payeeKey, key) >= 0.5)
}

/** The bank's row is one you already have (entered by hand or imported): same amount, close date, similar payee. */
function sameTransaction(local: LocalRow, r: RemoteTransaction, key: string) {
  if (local.amount !== r.amountMinor || Math.abs(daysBetween(local.date, r.date)) > 3) return false
  // A transfer you recorded rarely has the bank's wording ("PAYMENT - THANK YOU"), so the amount and date are enough.
  if (local.transferPairId !== null) return true
  return local.payeeKey === key || payeeSimilarity(local.payeeKey, key) >= 0.5
}

/** A write by id changes that one row: through the wrong ledger's context it would change none, and look done. */
function one(result: { changes: number }, what: string, id: number) {
  if (result.changes !== 1) throw new Error(`Bank sync's ${what} of transaction ${id} changed ${result.changes} rows, not 1`)
}

/**
 * What a sync brought for one account:
 * - SimpleFIN: everything the bank reports for [from, to]; a pending one it stopped reporting there is gone.
 * - Plaid: what's new or changed since the last sync, and the ids Plaid says were removed.
 */
export type ApplyScope =
  | { from: ISODate; to: ISODate; floor: ISODate | null }
  | { removed: Array<{ remoteId: string; raw?: unknown }>; floor: ISODate | null }

/**
 * Brings one account in line with what the bank reports, run in its home (`ctx`). A shared
 * account's rows are matched in every ledger that holds them (ctx.accountWide.bankRows), and each
 * row is written where it's held, through that ledger's context (`ctxOf`):
 *
 * 1. Known transactions (same externalId) get the bank's date, amount, pending status and payee
 *    (followBankPayee: one you entered keeps yours). Your category, notes and tags stay as you set
 *    them. Ones you deleted stay deleted.
 * 2. A transaction that comes back under a new id (posted replacing pending, or an id the provider
 *    re-issued) updates the earlier row, so your edits carry over. Plaid says which pending one a
 *    posted transaction replaces; otherwise it's matched by amount, date and payee.
 * 3. One you entered or imported yourself is adopted (it gets the bank's id) instead of being added twice.
 * 4. Anything else is added, in the home, categorized from its history.
 * 5. Pending transactions the bank no longer reports are deleted (soft, so they can be restored, with
 *    removed_at saying the bank removed them), and so is anything Plaid says was removed.
 *
 * A pending row another ledger holds that the bank removed in the last 7 days, and then sends again
 * (under its id, or posted under a new one), is restored where it is: otherwise the posted one would
 * land in the home, in the wrong ledger. Under a new id it's matched by its payee and amount, and
 * only after one you entered by hand had its chance. One a person deleted is never restored.
 *
 * A frozen row, which a ledger that stopped sharing the account kept on an account of its own
 * (`frozen`), is only known: nothing is added for its bank id, and it's never updated, adopted,
 * restored or removed.
 *
 * Transactions before `floor` (the account's "sync from" date), or well before a window's `from`, are ignored,
 * and so are trades (a buy or sell inside an investment account isn't money in or out).
 * What the provider sent for each one is logged (`logPayloads`).
 */
export function applyRemoteTransactions(
  ctx: AppContext,
  ctxOf: CtxOf,
  accountId: number,
  remote: RemoteTransaction[],
  scope: ApplyScope,
  provider: BankProviderKind,
): ApplyResult {
  const home = ctx.ledger.id
  const homeOf = ctx.accountWide.account(accountId)?.homeLedgerId
  if (homeOf !== undefined && homeOf !== home) throw new Error(`Account ${accountId} syncs in its home ${homeOf}, not in ${home}`)
  const result: ApplyResult = { added: 0, updated: 0, adopted: 0, removed: 0, newIds: [], byLedger: new Map() }
  /** Recurring items that lose a payment, and whether each was a paid-off plan before, by ledger. */
  const losing = new Map<string, Map<number, boolean>>()
  /** Recurring items that get a payment back (a row restored), by ledger. */
  const gaining = new Map<string, Set<number>>()
  const window = 'from' in scope ? scope : null
  // Only this account's window: when another account needs older data, the fetch reaches further
  // back, but what's older than this window was handled by earlier syncs.
  const earliest = window ? addDays(window.from, -3) : null
  const floor = earliest && (!scope.floor || scope.floor < earliest) ? earliest : scope.floor
  const incoming = remote.filter((r) => !r.trade && (!floor || r.date >= floor)).sort((a, b) => a.date.localeCompare(b.date))
  const reported = new Set(remote.map((r) => r.remoteId))
  const removedIds = new Set('removed' in scope ? scope.removed.map((r) => r.remoteId) : [])

  // Rows the bank's data can touch, in every ledger: anything with a bank id, and recent ones that could be adopted.
  const since = window ? addDays(window.from, -10) : incoming.length ? addDays(incoming[0]!.date, -10) : '9999-12-31'
  const local = ctx.accountWide.bankRows(accountId, since)
  // The account's own row first, should a frozen one have the same bank id.
  const byExternalId = new Map(
    [...local.filter((t) => t.frozen), ...local.filter((t) => !t.frozen)].filter((t) => t.externalId).map((t) => [t.externalId!, t]),
  )
  const used = new Set<number>()

  const contexts = new Map<string, AppContext>([[home, ctx]])
  /** The context of the ledger that holds a row: every write to it goes through that. */
  const holder = (row: { ledgerId: string }) => {
    let c = contexts.get(row.ledgerId)
    if (!c) contexts.set(row.ledgerId, (c = ctxOf(row.ledgerId)))
    return c
  }
  const counted = (ledgerId: string, what: keyof LedgerChanges) => {
    const changes = result.byLedger.get(ledgerId) ?? { added: 0, updated: 0, adopted: 0, removed: 0 }
    changes[what]++
    result.byLedger.set(ledgerId, changes)
    result[what]++
  }
  const restoreSince = new Date(ctx.now().getTime() - RESTORE_DAYS * 86_400_000).toISOString()
  /** A pending row another ledger holds, which the bank (not a person) removed in the last 7 days. */
  const restorable = (t: LocalRow) => t.ledgerId !== home && t.status === 'pending' && !!t.deletedAt && !!t.removedAt && t.removedAt >= restoreSince

  // The bank's category comes along when it has one (Plaid); otherwise what's there stays. An amount
  // and date you corrected stay too.
  const updateFromBank = `UPDATE transactions SET date = CASE WHEN corrected_at IS NULL THEN @date ELSE date END,
       datetime = CASE WHEN corrected_at IS NOT NULL THEN datetime WHEN @datetime IS NOT NULL THEN @datetime
         WHEN datetime IS NOT NULL THEN @date || substr(datetime, 11) END,
       amount_minor = CASE WHEN corrected_at IS NULL THEN @amount ELSE amount_minor END,
       status = @status, external_id = @externalId,
       bank_category = coalesce(@bankCategory, bank_category),
       bank_category_confident = CASE WHEN @bankCategory IS NULL THEN bank_category_confident ELSE @bankConfident END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id AND ledger_id = @ledger`
  const bank = (r: RemoteTransaction) => ({ bankCategory: r.category?.name ?? null, bankConfident: r.category?.confident ? 1 : 0 })
  const write = (row: LocalRow, r: RemoteTransaction) => {
    const at = holder(row)
    const values = { id: row.id, date: r.date, datetime: r.datetime ?? null, amount: r.amountMinor, status: r.pending ? 'pending' : 'cleared', externalId: r.remoteId, ...bank(r) }
    one(at.q.run(updateFromBank, values), 'update', row.id)
    followBankPayee(at, row, r.payee)
  }
  /** A row the bank removed, back where it is: no longer deleted, and its recurring item works it out again. */
  const restore = (row: LocalRow) => {
    const at = holder(row)
    one(at.q.run('UPDATE transactions SET deleted_at = NULL, removed_at = NULL WHERE id = @id AND ledger_id = @ledger AND deleted_at IS NOT NULL', { id: row.id }), 'restore', row.id)
    const itemId = at.q.pluck<number | null>('SELECT recurring_item_id FROM transactions WHERE id = @id AND ledger_id = @ledger', { id: row.id })
    if (itemId) gaining.set(row.ledgerId, (gaining.get(row.ledgerId) ?? new Set()).add(itemId))
  }
  const setBankCategory = (id: number, r: RemoteTransaction) =>
    one(ctx.q.run('UPDATE transactions SET bank_category = @bankCategory, bank_category_confident = @bankConfident WHERE id = @id AND ledger_id = @ledger', { id, ...bank(r) }), 'bank category', id)

  ctx.q.transaction(() => {
    const fresh: RemoteTransaction[] = []
    // 1. Known ones.
    for (const r of incoming) {
      const row = byExternalId.get(r.remoteId)
      if (!row) {
        fresh.push(r)
        continue
      }
      used.add(row.id)
      if (row.frozen || (row.deletedAt && !restorable(row))) continue
      const status = r.pending ? 'pending' : 'cleared'
      const differs =
        !!row.deletedAt ||
        (row.correctedAt ? row.status !== status : row.date !== r.date || row.amount !== r.amountMinor || row.status !== status) ||
        (row.origin !== 'manual' && row.payee !== r.payee)
      if (differs) {
        if (row.deletedAt) restore(row)
        write(row, r)
        counted(row.ledgerId, 'updated')
      }
    }

    // Rows whose id the bank no longer reports (inside the window we fetched), or that Plaid says were
    // removed: a pending one that posted under a new id (or was dropped), or one with a re-issued id.
    // And the pending ones other ledgers hold that the bank removed lately, which can come back.
    const own = local.filter((t) => !t.frozen)
    const orphaned = own.filter((t) =>
      window
        ? t.origin === 'sync' && !t.deletedAt && t.externalId && !reported.has(t.externalId) && t.date >= addDays(window.from, -3) && t.date <= window.to
        : !t.deletedAt && t.externalId && removedIds.has(t.externalId),
    )
    const returning = own.filter((t) => restorable(t) && !used.has(t.id))
    const candidates = own.filter((t) => !t.externalId && !t.deletedAt && t.origin !== 'sync')

    for (const r of fresh) {
      // 2. The same transaction under a new id. Plaid names the pending one a posted one replaces
      // (if you deleted that one, the posted one stays deleted too).
      const replaced = r.replaces ? byExternalId.get(r.replaces) : undefined
      if (replaced && !replaced.frozen && !used.has(replaced.id)) {
        used.add(replaced.id)
        const back = restorable(replaced)
        if (back) restore(replaced)
        write(replaced, r)
        if (!replaced.deletedAt || back) counted(replaced.ledgerId, 'updated')
        continue
      }
      // Otherwise: posted replacing pending, or a re-issued id, matched by amount, date and payee. Or,
      // when the payee is worded differently (another service's ids, after an account moves to it:
      // Plaid's "Golden Noodle" is Wealthsimple's "Tst-Golden Noodle House"), the only one with that amount
      // within 3 days.
      const key = payeeKeyOf(ctx, r.payee)
      const unused = orphaned.filter((p) => !used.has(p.id))
      const sameAmount = unused.filter((p) => p.amount === r.amountMinor && Math.abs(daysBetween(p.date, r.date)) <= 3)
      const previous =
        unused.find((p) => (p.status === 'pending' && !r.pending ? couldBePosted(p, r, key) : sameTransaction(p, r, key))) ??
        (sameAmount.length === 1 ? sameAmount[0] : undefined)
      if (previous) {
        used.add(previous.id)
        write(previous, r)
        counted(previous.ledgerId, 'updated')
        continue
      }
      // 3. Adopt what you entered or imported, in whichever ledger holds it.
      const mine = candidates.find((t) => !used.has(t.id) && sameTransaction(t, r, key))
      if (mine) {
        used.add(mine.id)
        write(mine, r)
        counted(mine.ledgerId, 'adopted')
        continue
      }
      // A pending row another ledger holds that the bank removed lately, back (posted, or under a new
      // id): only when nothing live is the bank's row, and only by its payee, never by the amount
      // alone. It was removed in an earlier sync, so any later charge of that amount could share it.
      const back = returning.find((p) => !used.has(p.id) && (!r.pending ? couldBePosted(p, r, key) : sameTransaction(p, r, key)))
      if (back) {
        used.add(back.id)
        restore(back)
        write(back, r)
        counted(back.ledgerId, 'updated')
        continue
      }
      // 4. New, in the home.
      const id = insertTransaction(
        ctx,
        {
          accountId,
          date: r.date,
          datetime: r.datetime ?? null,
          amountMinor: r.amountMinor,
          payee: r.payee,
          categoryId: null,
          notes: null,
          tags: [],
          status: r.pending ? 'pending' : 'cleared',
          transferAccountId: null,
          externalId: r.remoteId,
        },
        { origin: 'sync', suggestion: historySuggestion(ctx, r.payee, r.amountMinor) },
      )
      if (r.category) setBankCategory(id, r)
      counted(home, 'added')
      result.newIds.push(id)
    }

    // 5. Vanished pending ones inside the window we fetched. (Posted ones are kept: banks drop old
    // transactions from their listings, and a posted transaction doesn't un-happen.) Plaid says
    // outright what was removed, posted or not. Each is deleted where it's held.
    const now = ctx.now().toISOString()
    for (const p of orphaned) {
      if (used.has(p.id) || p.correctedAt) continue
      if (window && (p.status !== 'pending' || p.date < window.from)) continue
      const at = holder(p)
      const itemId = at.q.pluck<number | null>('SELECT recurring_item_id FROM transactions WHERE id = @id AND ledger_id = @ledger', { id: p.id })
      const items = losing.get(p.ledgerId) ?? new Map<number, boolean>()
      if (itemId && !items.has(itemId)) items.set(itemId, paidOff(at, itemId))
      losing.set(p.ledgerId, items)
      one(at.q.run('UPDATE transactions SET deleted_at = @now, removed_at = @now WHERE id = @id AND ledger_id = @ledger AND deleted_at IS NULL', { now, id: p.id }), 'removal', p.id)
      counted(p.ledgerId, 'removed')
    }

    logPayloads(ctx, accountId, provider, incoming, 'removed' in scope ? scope.removed : [])
  })
  // A removed payment of a recurring item: the item works its payments out again, in its own ledger.
  // So does one whose payment came back.
  for (const [ledgerId, items] of losing) {
    for (const [itemId, wasPaidOff] of items) recalculateRecurring(holder({ ledgerId }), itemId, { removed: true, followAmount: true, wasPaidOff })
  }
  for (const [ledgerId, items] of gaining) for (const itemId of items) recalculateRecurring(holder({ ledgerId }), itemId, { followAmount: true })
  return result
}

/** What the provider sent for a transaction (deleted ones too), oldest first: logged on it, or under its bank id. */
/**
 * What its current sync service last sent for a transaction, as it sent it: the latest for the bank
 * id it has now (a service it was synced with before had other ids). Null when there's none.
 * Payloads are the account's, so a row a ledger the account is shared with holds finds them too.
 */
export function latestBankPayload(ctx: AppContext, transactionId: number): BankPayload | null {
  ctx.q.mustGet('SELECT 1 FROM transactions WHERE id = @id AND ledger_id = @ledger', 'Transaction not found', { id: transactionId })
  const row = ctx.q.get<Omit<BankPayload, 'payload'> & { payload: string }>(
    `SELECT p.id, p.provider, p.remote_id AS remoteId, p.event, p.received_at AS receivedAt, p.payload
     FROM transactions t
     JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
     JOIN bank_payloads p ON p.account_id = a.id AND p.remote_id = t.external_id
     WHERE t.id = @id AND t.ledger_id = @ledger
     ORDER BY p.id DESC LIMIT 1`,
    { id: transactionId },
  )
  return row ? { ...row, payload: JSON.parse(row.payload) as unknown } : null
}

/**
 * Keeps what the provider sent for each transaction: when it's new, and each time it's different
 * from what was last kept (SimpleFIN sends the same ones every sync), plus what Plaid said when
 * removing one. Payloads are the account's, written in its home (`ctx`). Each is tied to the
 * transaction it landed on when the home holds that one, and to none when another ledger holds it
 * (a payload can't point across ledgers): it's found by the account and the bank id instead. What's
 * sent for a frozen row's bank id isn't kept: that row is another account's, which nothing syncs.
 */
export function logPayloads(
  ctx: AppContext,
  accountId: number,
  provider: BankProviderKind,
  incoming: RemoteTransaction[],
  removed: Array<{ remoteId: string; raw?: unknown }>,
) {
  const last = (remoteId: string) =>
    ctx.q.get<{ event: string; payload: string; transactionId: number | null }>(
      `SELECT p.event, p.payload, p.transaction_id AS transactionId
       FROM ledger_accounts a JOIN bank_payloads p ON p.account_id = a.id
       WHERE a.ledger_id = @ledger AND a.id = @accountId AND p.remote_id = @remoteId
       ORDER BY p.id DESC LIMIT 1`,
      { accountId, remoteId },
    )
  const receivedAt = ctx.now().toISOString()
  const keep = (remoteId: string, raw: unknown, removal: boolean) => {
    if (raw === undefined) return
    const payload = JSON.stringify(raw)
    const before = last(remoteId)
    if (before?.payload === payload && (before.event === 'removed') === removal) return
    const event = removal ? 'removed' : before ? 'changed' : 'added'
    // A pending one that posted under a new id isn't found by its old id any more: it's where it was.
    const landed = ctx.accountWide.holder(accountId, remoteId)
    if (landed?.frozen) return
    const transactionId = landed ? (landed.ledgerId === ctx.ledger.id ? landed.id : null) : (before?.transactionId ?? null)
    ctx.q.run(
      `INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload, received_at)
       VALUES (@accountId, @provider, @remoteId, @transactionId, @event, @payload, @receivedAt)`,
      { accountId, provider, remoteId, transactionId, event, payload, receivedAt },
    )
  }
  for (const r of incoming) keep(r.remoteId, r.raw, false)
  for (const r of removed) keep(r.remoteId, r.raw, true)
}
