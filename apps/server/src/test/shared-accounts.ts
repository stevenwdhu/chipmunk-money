import type { ActivityActor } from '../services/activity'
import type { AppContext } from '../services/context'
import { addMember } from '../services/sharing'
import type { Storage } from '../storage'
import { makeAccount, testLedger, testStorage } from './helpers'

/** Who the shared-account tests act as, in each ledger's activity. */
export const TESTER: ActivityActor = { name: 'Tester', apiKeyId: null }

type Other = 'family' | 'trip'

export interface SharedWorld {
  storage: Storage
  /** The home of the card. */
  personal: AppContext
  family: AppContext
  trip: AppContext
  /** Personal's credit card Visa, at TD. */
  visa: number
  ctxOf: Storage['ctxOf']
  /** Shares Visa with another ledger, through the sharing service. */
  share: (with_: AppContext) => void
  /** A transaction a ledger holds on an account, entered as by hand. */
  addTx: (ctx: AppContext, date: string, amountMinor: number, opts?: { account?: number; deleted?: boolean; payee?: string }) => number
}

/**
 * Three ledgers, Personal, Family and Trip, and Personal's credit card Visa (at TD, opening balance
 * `opening`) shared with the ledgers in `shareWith` (Family by default). Trip has the card only
 * when it's listed, so it is also the ledger that doesn't share.
 */
export function sharedWorld(opts: { shareWith?: Other[]; opening?: number; now?: string } = {}): SharedWorld {
  const storage = testStorage({ now: opts.now })
  const personal = storage.registry.defaultContext()
  const family = testLedger(storage, 'Family')
  const trip = testLedger(storage, 'Trip')
  const visa = makeAccount(personal, 'Visa', 'credit', opts.opening ?? 0, 'TD')
  const share = (with_: AppContext) => void addMember(personal, storage.ctxOf, visa, with_.ledger.id, TESTER)
  for (const name of opts.shareWith ?? ['family']) share({ family, trip }[name])
  const addTx: SharedWorld['addTx'] = (ctx, date, amountMinor, more = {}) =>
    Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, deleted_at)
         VALUES (@ledger, @account, @date, @amountMinor, @payee, lower(@payee), @deletedAt)`,
        { account: more.account ?? visa, date, amountMinor, payee: more.payee ?? 'Shop', deletedAt: more.deleted ? '2026-10-01T00:00:00Z' : null },
      ).lastInsertRowid,
    )
  return { storage, personal, family, trip, visa, ctxOf: storage.ctxOf, share, addTx }
}
