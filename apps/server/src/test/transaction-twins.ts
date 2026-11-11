import { transactionCreateSchema } from '@chipmunk/shared'
import type { AppContext } from '../services/context'
import { insertTransaction } from '../services/transactions'
import type { Storage } from '../storage'
import { categoryId, makeAccount, testLedger, testStorage } from './helpers'

/**
 * Two ledgers in one database with rows that look alike (the same account names, payees, amounts
 * and dates), for checking that each ledger's transactions, links, imports, stats and activity
 * see only its own.
 */
export interface TwinLedgers {
  storage: Storage
  a: AppContext
  b: AppContext
}

export function twinLedgers(opts: { now?: string } = {}): TwinLedgers {
  const storage = testStorage(opts)
  return { storage, a: storage.registry.defaultContext(), b: testLedger(storage, 'Family') }
}

/** A transaction added the way a sync or import adds one: no suggestion, no recurring match. */
export function addTx(
  ctx: AppContext,
  accountId: number,
  date: string,
  amountMinor: number,
  payee: string,
  opts: { categoryId?: number | null; origin?: 'manual' | 'import' | 'sync'; transferAccountId?: number } = {},
): number {
  return insertTransaction(
    ctx,
    transactionCreateSchema.parse({ accountId, date, amountMinor, payee, categoryId: opts.categoryId ?? null, transferAccountId: opts.transferAccountId }),
    { origin: opts.origin ?? 'manual', skipRecurring: true, suggestion: null },
  )
}

/** The same accounts in a ledger: a chequing account and a credit card. */
export function twinAccounts(ctx: AppContext) {
  return { chequing: makeAccount(ctx, 'Chequing', 'chequing', 100_000), card: makeAccount(ctx, 'Visa', 'credit') }
}

/** A ledger's rows of one table, counted with its pin (for checking another ledger's writes left it alone). */
export function countRows(ctx: AppContext, table: 'transactions' | 'import_batches' | 'activity' | 'payee_category_stats'): number {
  return ctx.q.pluck<number>(`SELECT count(*) FROM ${table} WHERE ledger_id = @ledger`)!
}

export { categoryId }
