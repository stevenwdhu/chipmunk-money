import type { DB, SQLite } from '../db/client'
import type { LedgerQuery } from '../db/scope'
import type { LlmCategorizer } from '../ai/types'
import type { SecretBox } from '../lib/secrets'

/** What the whole app shares: app settings, API keys, bank connections, payee names. */
export interface AppStore {
  /** Drizzle over the app-wide tables only: SQL naming a table of ledger data is refused. */
  db: DB
  /**
   * @deprecated Stage B converts every use to ctx.q (ledger data) or app.db (app-wide tables).
   * The raw connection: not pin checked, and writes to ledger data are refused outside a scope.
   */
  sqlite: SQLite
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
  /** @deprecated Stage B converts every use to ctx.q. Drizzle on the one connection, writes in this ledger's scope. */
  db: DB
  /** @deprecated Stage B converts every use to ctx.q. The one connection, writes in this ledger's scope, reads not pin checked. */
  sqlite: SQLite
  ledger: { id: string; name: string; slug: string }
  /** Injectable clock for tests. */
  now: () => Date
  /** Injectable LLM runner for tests; defaults to the configured providers. */
  llm?: LlmCategorizer
}
