import type { DB, MetaDB, SQLite } from '../db/client'
import type { LlmCategorizer } from '../ai/types'
import type { SecretBox } from '../lib/secrets'

/** The app-wide database: ledger list and app settings. */
export interface MetaStore {
  db: MetaDB
  sqlite: SQLite
  /** Encrypts what's secret in it (AI keys, Plaid's secret, bank access) with data/secret.key. */
  secrets: SecretBox
  /** Injectable fetch for app-wide outside services (signing in to ChatGPT, its models and requests). */
  fetch?: typeof fetch
}

/** Everything a service needs to work on one ledger. */
export interface AppContext {
  /** This ledger's database. */
  db: DB
  sqlite: SQLite
  /** App-wide settings (time zone, AI providers). */
  meta: MetaStore
  ledger: { id: string; name: string; slug: string }
  /** Injectable clock for tests. */
  now: () => Date
  /** Injectable LLM runner for tests; defaults to the configured providers. */
  llm?: LlmCategorizer
}
