import { createHash } from 'node:crypto'
import { addDays, daysBetween, payeeKey, payeeSimilarity, type BankProviderKind, type ISODate, type SwitchResult } from '@chipmunk/shared'
import type { accountBankSwitchSchema } from '@chipmunk/shared'
import type { z } from 'zod'
import { historySuggestion } from '../categorize'
import type { AppContext } from '../context'
import { deleteTransaction, insertTransaction } from '../transactions'
import { followBankPayee } from '../payee-names'
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

/** Changes whenever the account's transactions change in a way a switch's review shows. */
export function localStamp(ctx: AppContext, accountId: number): string {
  const rows = ctx.sqlite
    .prepare('SELECT id, date, amount_minor, payee, name, external_id, deleted_at IS NOT NULL FROM transactions WHERE account_id = ? ORDER BY id')
    .raw()
    .all(accountId)
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex')
}

type SwitchInput = z.output<typeof accountBankSwitchSchema>

/**
 * Applies what you decided in the review, for the account's transactions from `from` on:
 * - paired: yours takes the bank's id, date, time and status (and amount, unless you keep yours,
 *   which syncs then leave alone);
 * - only the bank's: added, or (skipped) kept deleted, so a sync doesn't bring it back;
 * - only yours: deleted (`remove`), or kept as they are, where syncs leave them alone.
 */
export function applySwitch(ctx: AppContext, accountId: number, provider: BankProviderKind, remote: RemoteTransaction[], input: SwitchInput) {
  const result: SwitchResult & { newIds: number[] } = { matched: 0, added: 0, skipped: 0, removed: 0, kept: 0, newIds: [] }
  const local = ctx.sqlite
    .prepare(
      `SELECT id, date, payee, payee_key AS payeeKey, origin, external_id AS externalId, deleted_at AS deletedAt
       FROM transactions WHERE account_id = ? AND date >= ?`,
    )
    .all(accountId, addDays(input.from, -1)) as Array<{
    id: number
    date: string
    payee: string
    payeeKey: string
    origin: 'manual' | 'import' | 'sync'
    externalId: string | null
    deletedAt: string | null
  }>
  const localById = new Map(local.map((l) => [l.id, l]))
  const byRemote = new Map(remote.map((r) => [r.remoteId, r]))
  /** Which transaction of this account already has a bank id. */
  const holder = ctx.sqlite.prepare('SELECT id FROM transactions WHERE account_id = ? AND external_id = ?').pluck()
  const update = ctx.sqlite.prepare(
    `UPDATE transactions SET external_id = @externalId,
       date = CASE WHEN corrected_at IS NULL THEN @date ELSE date END,
       datetime = CASE WHEN corrected_at IS NOT NULL THEN datetime WHEN @datetime IS NOT NULL THEN @datetime
         WHEN datetime IS NOT NULL THEN @date || substr(datetime, 11) END,
       amount_minor = CASE WHEN corrected_at IS NULL AND @keepAmount = 0 THEN @amount ELSE amount_minor END,
       corrected_at = CASE WHEN @keepAmount = 1 AND corrected_at IS NULL AND amount_minor != @amount THEN @now ELSE corrected_at END,
       status = @status,
       bank_category = coalesce(@bankCategory, bank_category),
       bank_category_confident = CASE WHEN @bankCategory IS NULL THEN bank_category_confident ELSE @bankConfident END,
       updated_at = @now WHERE id = @id`,
  )
  const setBankCategory = ctx.sqlite.prepare('UPDATE transactions SET bank_category = ?, bank_category_confident = ? WHERE id = ?')
  const forget = ctx.sqlite.prepare('UPDATE transactions SET external_id = NULL WHERE id = ?')
  const markDeleted = ctx.sqlite.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?')
  const now = ctx.now().toISOString()
  const skip = new Set(input.skip)
  const remove = new Set(input.remove)

  ctx.sqlite.transaction(() => {
    const paired = new Set<number>()
    const pairedRemote = new Set<string>()
    for (const p of input.pairs) {
      const r = byRemote.get(p.remoteId)
      const l = localById.get(p.transactionId)
      if (!r || !l || paired.has(l.id) || pairedRemote.has(r.remoteId)) continue
      const held = holder.get(accountId, r.remoteId) as number | undefined
      if (held !== undefined && held !== l.id) continue
      update.run({
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
      // Its payee is the new service's now.
      followBankPayee(ctx, l, r.payee)
      paired.add(l.id)
      pairedRemote.add(r.remoteId)
      result.matched++
    }

    for (const r of remote) {
      if (pairedRemote.has(r.remoteId) || r.date < input.from || holder.get(accountId, r.remoteId) !== undefined) continue
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
      if (r.category) setBankCategory.run(r.category.name, r.category.confident ? 1 : 0, id)
      if (skipped) {
        markDeleted.run(now, id)
        result.skipped++
      } else {
        result.added++
        result.newIds.push(id)
      }
    }

    for (const l of local) {
      if (paired.has(l.id) || l.deletedAt || l.date < input.from) continue
      if (remove.has(l.id)) {
        deleteTransaction(ctx, l.id)
        result.removed++
      } else {
        // Kept as yours: no other service's id, so syncs leave it alone.
        if (l.externalId) forget.run(l.id)
        result.kept++
      }
    }

    logPayloads(ctx, accountId, provider, remote, [])
  })()
  return result
}
