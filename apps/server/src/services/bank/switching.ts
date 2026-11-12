import { addDays, daysBetween, payeeKey, payeeSimilarity, type BankProviderKind, type ISODate, type SwitchResult } from '@chipmunk/shared'
import type { accountBankSwitchSchema } from '@chipmunk/shared'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { badRequest } from '../../lib/http'
import { historySuggestion } from '../categorize'
import type { SwitchRow } from '../account-rows'
import type { AppContext, CtxOf } from '../context'
import { deleteTransaction, insertTransaction } from '../transactions'
import { followBankPayee } from '../payee-names'
import { followPayment, undoSplitFirst } from '../splits'
import { logPayloads } from './apply'
import type { RemoteTransaction } from './types'

/**
 * Switching an account to sync from another bank account (another service, or until now by hand):
 * its transactions are paired with the bank's, and you review what's left before anything changes.
 *
 * Pairs have the same amount within a day (time zones move dates by one). The payee only tells
 * apart several with the same amount and day, since services word it differently (Plaid's
 * "Golden Noodle" is Wealthsimple's "Tst-Golden Noodle House").
 */

export interface SwitchLocal {
  id: number
  date: ISODate
  amountMinor: number
  payeeKey: string
  /** Deleted ones are paired too, so they stay deleted instead of coming back. */
  deleted: boolean
}

export interface SwitchPlan {
  /** `guessed`: others had the same amount and day, and the payee couldn't tell them apart. */
  pairs: Array<{ localId: number; remoteId: string; guessed: boolean }>
  /** The same day and a like payee, but another amount (one you corrected?): shown together, not paired. */
  near: Array<{ localId: number; remoteId: string }>
  /** Yours the bank doesn't have (not deleted ones). */
  localOnly: number[]
  remoteOnly: string[]
}

/** A payee this much closer than the others with the same amount and day decides it. */
const CLEARLY_CLOSER = 0.3
/** Payees this alike are the same merchant, for a near pair. */
const ALIKE = 0.5

const alike = (a: string, b: string) => (a === b ? 1 : payeeSimilarity(a, b))

function groupBy<T, K>(list: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of list) map.set(key(item), [...(map.get(key(item)) ?? []), item])
  return map
}

/**
 * Pairs them as a whole: the most alike payees and closest dates first, each transaction in one pair
 * at most, so an early pick can't take one that belongs to the next.
 */
export function planSwitch(local: SwitchLocal[], remote: RemoteTransaction[], keyOf: (payee: string) => string = payeeKey): SwitchPlan {
  const keys = new Map(remote.map((r) => [r.remoteId, keyOf(r.payee)]))
  const edges: Array<{ l: SwitchLocal; r: RemoteTransaction; days: number; sim: number }> = []
  for (const r of remote) {
    for (const l of local) {
      if (l.amountMinor !== r.amountMinor) continue
      const days = Math.abs(daysBetween(l.date, r.date))
      if (days <= 1) edges.push({ l, r, days, sim: alike(l.payeeKey, keys.get(r.remoteId)!) })
    }
  }
  const byLocal = groupBy(edges, (e) => e.l.id)
  const byRemote = groupBy(edges, (e) => e.r.remoteId)
  edges.sort((a, b) => b.sim - a.sim || a.days - b.days || a.l.id - b.l.id)

  const usedLocal = new Set<number>()
  const usedRemote = new Set<string>()
  const pairs: SwitchPlan['pairs'] = []
  for (const e of edges) {
    if (usedLocal.has(e.l.id) || usedRemote.has(e.r.remoteId)) continue
    usedLocal.add(e.l.id)
    usedRemote.add(e.r.remoteId)
    // Others it could have been, and how alike their payees are.
    const rivals = [...byRemote.get(e.r.remoteId)!.filter((x) => x.l.id !== e.l.id), ...byLocal.get(e.l.id)!.filter((x) => x.r.remoteId !== e.r.remoteId)]
    const best = Math.max(-1, ...rivals.map((x) => x.sim))
    pairs.push({ localId: e.l.id, remoteId: e.r.remoteId, guessed: rivals.length > 0 && e.sim - best < CLEARLY_CLOSER })
  }

  // Left over: the same day and payee but another amount is worth showing side by side.
  const leftLocal = local.filter((l) => !usedLocal.has(l.id) && !l.deleted)
  const leftRemote = remote.filter((r) => !usedRemote.has(r.remoteId))
  const nearEdges: Array<{ l: SwitchLocal; r: RemoteTransaction; days: number; sim: number; diff: number }> = []
  for (const r of leftRemote) {
    for (const l of leftLocal) {
      if (Math.sign(l.amountMinor) !== Math.sign(r.amountMinor)) continue
      const days = Math.abs(daysBetween(l.date, r.date))
      const sim = alike(l.payeeKey, keys.get(r.remoteId)!)
      if (days <= 1 && sim >= ALIKE) nearEdges.push({ l, r, days, sim, diff: Math.abs(l.amountMinor - r.amountMinor) })
    }
  }
  nearEdges.sort((a, b) => b.sim - a.sim || a.days - b.days || a.diff - b.diff)
  const near: SwitchPlan['near'] = []
  for (const e of nearEdges) {
    if (usedLocal.has(e.l.id) || usedRemote.has(e.r.remoteId)) continue
    usedLocal.add(e.l.id)
    usedRemote.add(e.r.remoteId)
    near.push({ localId: e.l.id, remoteId: e.r.remoteId })
  }
  return {
    pairs,
    near,
    localOnly: leftLocal.filter((l) => !usedLocal.has(l.id)).map((l) => l.id),
    remoteOnly: leftRemote.filter((r) => !usedRemote.has(r.remoteId)).map((r) => r.remoteId),
  }
}

/**
 * Changes whenever the account's transactions change in a way a switch's review shows: in every
 * ledger that holds them, and when one moves between them.
 */
export function localStamp(ctx: AppContext, accountId: number): string {
  return ctx.accountWide.switchStamp(accountId)
}

type SwitchInput = z.output<typeof accountBankSwitchSchema>

/**
 * A switch can't delete a row of an account split off from this one (a frozen row): a 400 naming
 * it, before anything changes, the link included.
 */
export function refuseSplitOffRemoval(ctx: AppContext, accountId: number, input: Pick<SwitchInput, 'from' | 'remove'>): void {
  if (!input.remove.length) return
  const remove = new Set(input.remove)
  const row = ctx.accountWide.switchRows(accountId, addDays(input.from, -1)).find((r) => r.splitOff !== null && remove.has(r.id))
  if (row) badRequest(`${row.name ?? row.payee} on ${row.date} is on ${row.splitOff} in another ledger now, so the switch can’t delete it. Pair it or keep it.`)
}

/**
 * A switch can pair a payment split between the ledgers, and not delete it: a 409 naming it ("Undo
 * the split of <payment> first"), before anything changes, the link included. Its split rows are
 * never offered (switchRows leaves them out).
 */
export function refuseSplitRemoval(ctx: AppContext, ctxOf: CtxOf, accountId: number, input: Pick<SwitchInput, 'from' | 'remove'>): void {
  if (!input.remove.length) return
  const remove = new Set(input.remove)
  const row = ctx.accountWide.switchRows(accountId, addDays(input.from, -1)).find((r) => r.splitPayment && remove.has(r.id))
  if (row) throw new HTTPException(409, { message: undoSplitFirst(row.ledgerId === ctx.ledger.id ? ctx : ctxOf(row.ledgerId), row.id)! })
}

/** What a switch changed, and the ledgers whose rows it changed (its home, where new ones land, always). */
export type AppliedSwitch = SwitchResult & { newIds: number[]; ledgers: Set<string> }

/** A write by id changes that one row: through the wrong ledger's context it would change none, and look done. */
function one(result: { changes: number }, what: string, id: number) {
  if (result.changes !== 1) throw new Error(`The switch's ${what} of transaction ${id} changed ${result.changes} rows, not 1`)
}

/**
 * Applies what you decided in the review, for the account's transactions from `from` on, run in
 * its home (`ctx`). A shared account's rows are paired in every ledger that holds them, and each is
 * written where it's held, through that ledger's context (`ctxOf`):
 * - paired: yours takes the bank's id, date, time and status (and amount, unless you keep yours,
 *   which syncs then leave alone);
 * - only the bank's: added in the home, or (skipped) kept deleted, so a sync doesn't bring it back.
 *   One whose bank id a row already has, in any ledger, isn't added again;
 * - only yours: deleted (`remove`), or kept as they are, where syncs leave them alone.
 * A frozen row, which a ledger that stopped sharing the account kept on an account of its own, is
 * paired too, and only ever given the new bank id: never changed or removed. A payment split between
 * the ledgers is paired like any other, its split rows following its new date and status
 * (followPayment), and never removed (refuseSplitRemoval).
 */
export function applySwitch(
  ctx: AppContext,
  ctxOf: CtxOf,
  accountId: number,
  provider: BankProviderKind,
  remote: RemoteTransaction[],
  input: SwitchInput,
): AppliedSwitch {
  const home = ctx.ledger.id
  const result: AppliedSwitch = { matched: 0, added: 0, skipped: 0, removed: 0, kept: 0, newIds: [], ledgers: new Set([home]) }
  const local = ctx.accountWide.switchRows(accountId, addDays(input.from, -1))
  const localById = new Map(local.map((l) => [l.id, l]))
  const byRemote = new Map(remote.map((r) => [r.remoteId, r]))
  const contexts = new Map<string, AppContext>([[home, ctx]])
  /** The context of the ledger that holds a row: every write to it goes through that. */
  const holderOf = (row: SwitchRow) => {
    let c = contexts.get(row.ledgerId)
    if (!c) contexts.set(row.ledgerId, (c = ctxOf(row.ledgerId)))
    result.ledgers.add(row.ledgerId)
    return c
  }
  /** Which transaction of this account already has a bank id, in any ledger. */
  const holder = (remoteId: string) => ctx.accountWide.holder(accountId, remoteId)?.id
  const updateFromBank = `UPDATE transactions SET external_id = @externalId,
       date = CASE WHEN corrected_at IS NULL THEN @date ELSE date END,
       datetime = CASE WHEN corrected_at IS NOT NULL THEN datetime WHEN @datetime IS NOT NULL THEN @datetime
         WHEN datetime IS NOT NULL THEN @date || substr(datetime, 11) END,
       amount_minor = CASE WHEN corrected_at IS NULL AND @keepAmount = 0 THEN @amount ELSE amount_minor END,
       corrected_at = CASE WHEN @keepAmount = 1 AND corrected_at IS NULL AND amount_minor != @amount THEN @now ELSE corrected_at END,
       status = @status,
       bank_category = coalesce(@bankCategory, bank_category),
       bank_category_confident = CASE WHEN @bankCategory IS NULL THEN bank_category_confident ELSE @bankConfident END,
       updated_at = @now WHERE id = @id AND ledger_id = @ledger`
  const setBankCategory = (id: number, category: NonNullable<RemoteTransaction['category']>) =>
    ctx.q.run('UPDATE transactions SET bank_category = @name, bank_category_confident = @confident WHERE id = @id AND ledger_id = @ledger', {
      id,
      name: category.name,
      confident: category.confident ? 1 : 0,
    })
  const now = ctx.now().toISOString()
  const frozenId = `UPDATE transactions SET external_id = @externalId, updated_at = @now WHERE id = @id AND ledger_id = @ledger`
  const forget = (l: SwitchRow) =>
    one(holderOf(l).q.run('UPDATE transactions SET external_id = NULL WHERE id = @id AND ledger_id = @ledger', { id: l.id }), 'kept bank id', l.id)
  const markDeleted = (id: number) => ctx.q.run('UPDATE transactions SET deleted_at = @now WHERE id = @id AND ledger_id = @ledger', { id, now })
  const skip = new Set(input.skip)
  const remove = new Set(input.remove)

  ctx.q.transaction(() => {
    const paired = new Set<number>()
    const pairedRemote = new Set<string>()
    for (const p of input.pairs) {
      const r = byRemote.get(p.remoteId)
      const l = localById.get(p.transactionId)
      if (!r || !l || paired.has(l.id) || pairedRemote.has(r.remoteId)) continue
      const held = holder(r.remoteId)
      if (held !== undefined && held !== l.id) continue
      const at = holderOf(l)
      if (l.splitOff !== null) {
        // A split-off account's row: the new bank id, so syncs know it, and nothing else.
        one(at.q.run(frozenId, { id: l.id, externalId: r.remoteId, now }), 'bank id', l.id)
        paired.add(l.id)
        pairedRemote.add(r.remoteId)
        result.matched++
        continue
      }
      const changed = at.q.run(updateFromBank, {
        id: l.id,
        externalId: r.remoteId,
        date: r.date,
        datetime: r.datetime ?? null,
        amount: r.amountMinor,
        keepAmount: p.keepAmount ? 1 : 0,
        status: r.pending ? 'pending' : 'cleared',
        bankCategory: r.category?.name ?? null,
        bankConfident: r.category?.confident ? 1 : 0,
        now,
      })
      one(changed, 'update', l.id)
      // Its payee is the new service's now.
      followBankPayee(at, l, r.payee)
      // A split payment's split rows follow it.
      if (l.splitPayment) followPayment(at, ctxOf, l.id)
      paired.add(l.id)
      pairedRemote.add(r.remoteId)
      result.matched++
    }

    for (const r of remote) {
      if (pairedRemote.has(r.remoteId) || r.date < input.from || holder(r.remoteId) !== undefined) continue
      const skipped = skip.has(r.remoteId)
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
        { origin: 'sync', skipRecurring: skipped, suggestion: skipped ? null : historySuggestion(ctx, r.payee, r.amountMinor) },
      )
      if (r.category) setBankCategory(id, r.category)
      if (skipped) {
        markDeleted(id)
        result.skipped++
      } else {
        result.added++
        result.newIds.push(id)
      }
    }

    for (const l of local) {
      if (paired.has(l.id) || l.deletedAt || l.date < input.from) continue
      if (l.splitOff !== null) {
        if (remove.has(l.id)) throw new Error(`The switch can't delete transaction ${l.id}, which is on a split-off account (refuseSplitOffRemoval)`)
        result.kept++
        continue
      }
      if (remove.has(l.id)) {
        if (l.splitPayment) throw new Error(`The switch can't delete transaction ${l.id}, a split payment (refuseSplitRemoval)`)
        // Deleted where it's held.
        deleteTransaction(holderOf(l), l.id)
        result.removed++
      } else {
        // Kept as yours: no other service's id, so syncs leave it alone.
        if (l.externalId) forget(l)
        result.kept++
      }
    }

    logPayloads(ctx, accountId, provider, remote, [])
  })
  return result
}
