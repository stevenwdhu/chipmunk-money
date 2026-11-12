import type { DB } from '../db/client'
import type { LedgerQuery } from '../db/scope'
import type { LlmCategorizer } from '../ai/types'
import type { SecretBox } from '../lib/secrets'
import type { AccountWide } from './account-rows'

/** What the whole app shares: app settings, API keys, bank connections, payee names. */
export interface AppStore {
  /** Drizzle over the app-wide tables only: SQL naming a table of ledger data is refused. */
  db: DB
  /** Encrypts what's secret in it (AI keys, Plaid's secret, bank access) with data/secret.key. */
  secrets: SecretBox
  /** Injectable fetch for app-wide outside services (signing in to ChatGPT, its models and requests). */
  fetch?: typeof fetch
}

/** The name the app-wide store had when it was its own file; the same object as `app`. */
export type MetaStore = AppStore

/** Everything a service needs to work on one ledger. */
export interface AppContext {
  /** This ledger's queries: pin checked, with @ledger bound to it. */
  q: LedgerQuery
  /** App-wide settings (time zone, AI providers) and the other app-wide tables. */
  app: AppStore
  /** The same object as `app`, under its older name. */
  meta: AppStore
  ledger: { id: string; name: string; slug: string }
  /**
   * Reads of one account across every ledger that has it (account-rows.ts): sums, counts and
   * names, for a shared account. It isn't pinned to this ledger, so it hands out only those, and
   * the account's rows for three users only: the bank code (bankRows, bankIds, holder, switchRows),
   * whose rows reach a response only in a switch's review, a CSV import's duplicate check
   * (importedRows), and the all-ledgers list (accountTransactions). The review and the list show
   * them only to a caller allowed in every ledger that has the account. And the two writes that
   * span two ledgers, bound to this ledger: a move's UPDATE of this ledger's rows (moveRows), and a
   * home change of an account this ledger is the home of (changeHome), the other ledger a context
   * from ctxOf.
   */
  accountWide: AccountWide
  /** Injectable clock for tests. */
  now: () => Date
  /** Injectable LLM runner for tests; defaults to the configured providers. */
  llm?: LlmCategorizer
}

/**
 * Another ledger's context, by its id: for a service that writes in each ledger a shared account is
 * in, through that ledger's own handle. Passed to the services that need it, never kept on a context.
 */
export type CtxOf = (ledgerId: string) => AppContext
