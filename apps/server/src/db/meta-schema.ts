import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
// Type-only import keeps this file loadable by drizzle-kit without resolving workspace sources.
import type { ApiScope, BankProviderKind } from '@chipmunk/shared'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

/** One row per ledger. The ledger's data lives in its own SQLite file (`file`, under data/ledgers). */
export const ledgers = sqliteTable(
  'ledgers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color').notNull().default('#6366f1'),
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    file: text('file').notNull(),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('ledgers_slug').on(t.slug)],
)

/** App-wide settings: time zone, AI providers, default ledger. Per-ledger settings live in each ledger file. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().default(now),
})

/** API keys for scripts and agents. Only a SHA-256 hash of each key is stored. */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<ApiScope[]>().notNull(),
    /** Ledger ids the key may use; null for every ledger. */
    ledgers: text('ledgers', { mode: 'json' }).$type<string[] | null>(),
    expiresAt: text('expires_at'),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('api_keys_hash').on(t.hash)],
)

/**
 * Responses to POST requests that carried an Idempotency-Key, kept for 24 hours so a retry gets
 * the same answer instead of doing the work twice. `status` is null while the first request runs.
 */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    /** "web" or the API key's id: keys from different callers never collide. */
    actor: text('actor').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: integer('status'),
    body: text('body'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.key, t.actor] }), index('idempotency_keys_created').on(t.createdAt)],
)

/**
 * A bank-data provider connection: one SimpleFIN Access URL (all the banks you add there), or one
 * Plaid Item (one bank login), side by side. App-wide, because one connection can hold accounts for
 * different ledgers. `secret`
 * (the Access URL, or Plaid's access token) is encrypted (lib/secrets.ts).
 */
export const bankConnections = sqliteTable('bank_connections', {
  id: text('id').primaryKey(),
  provider: text('provider').$type<BankProviderKind>().notNull(),
  /** Plaid's id for the bank login (its item_id); Wealthsimple's for you (your identity). */
  remoteId: text('remote_id'),
  /** Plaid: where the last transactions sync left off, so the next one gets only what changed. */
  cursor: text('cursor'),
  name: text('name').notNull(),
  secret: text('secret').notNull(),
  status: text('status').$type<'ok' | 'attention' | 'error'>().notNull().default('ok'),
  /** Problems the provider reported on the last sync: [{ code, message, remoteAccountId? }]. */
  errors: text('errors', { mode: 'json' }).$type<Array<{ code: string; message: string; remoteAccountId?: string }>>().notNull().default(sql`'[]'`),
  /** A note from the provider (e.g. a rate-limit warning). */
  notice: text('notice'),
  /** Times of recent requests, for staying within the provider's daily limit. */
  requestLog: text('request_log', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  lastAttemptAt: text('last_attempt_at'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').notNull().default(now),
})

/** An account at the provider, and the ledger account it syncs into (if linked). */
export const bankAccounts = sqliteTable(
  'bank_accounts',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => bankConnections.id, { onDelete: 'cascade' }),
    remoteId: text('remote_id').notNull(),
    name: text('name').notNull(),
    institution: text('institution'),
    /** The provider's id for the institution (SimpleFIN's org id). */
    remoteInstitutionId: text('remote_institution_id'),
    currency: text('currency').notNull(),
    balanceMinor: integer('balance_minor'),
    availableMinor: integer('available_minor'),
    balanceDate: text('balance_date'),
    ledgerId: text('ledger_id'),
    accountId: integer('account_id'),
    /** Transactions before this date are never imported. */
    syncFrom: text('sync_from'),
    /** When its ledger account last took in the bank's transactions. */
    lastSyncedAt: text('last_synced_at'),
    /** When its transactions were last fetched into `bank_transactions` (null: never, so the next sync gets all of them). */
    fetchedAt: text('fetched_at'),
    error: text('error'),
    createdAt: text('created_at').notNull().default(now),
  },
  // A ledger account syncs from one bank account at most, so from one service.
  (t) => [
    uniqueIndex('bank_accounts_remote').on(t.connectionId, t.remoteId),
    uniqueIndex('bank_accounts_link')
      .on(t.ledgerId, t.accountId)
      .where(sql`${t.accountId} IS NOT NULL`),
  ],
)

/**
 * Each bank account's transactions as its service last reported them, linked or not: what switching
 * or linking an account compares and takes in, without fetching. Only syncs change them. `data` is
 * the transaction in the app's terms (RemoteTransaction), with what the service sent as `raw`.
 */
export const bankTransactions = sqliteTable(
  'bank_transactions',
  {
    bankAccountId: text('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    remoteId: text('remote_id').notNull(),
    date: text('date').notNull(),
    pending: integer('pending', { mode: 'boolean' }).notNull(),
    data: text('data').notNull(),
    /** The service stopped reporting it (a pending one that posted or fell off), or said it was removed (Plaid). */
    removedAt: text('removed_at'),
    firstSeenAt: text('first_seen_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bankAccountId, t.remoteId] }), index('bank_transactions_date').on(t.bankAccountId, t.date)],
)

// The shared category list -------------------------------------------------------------
// Every ledger uses these categories (by the same ids) and turns each one on or off for itself.
// Each ledger keeps a copy (its own categories, category_groups, labels and category_labels tables)
// so its reports and backups stand on their own; App settings → Categories changes this list, and
// the copies follow.

export const catalogGroups = sqliteTable('category_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** Its categories show in this colour. */
  color: text('color').notNull().default('#64748b'),
  sort: integer('sort').notNull().default(0),
})

export const catalogCategories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id').references(() => catalogGroups.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    isIncome: integer('is_income', { mode: 'boolean' }).notNull().default(false),
    excludeFromTotals: integer('exclude_from_totals', { mode: 'boolean' }).notNull().default(false),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [index('categories_group').on(t.groupId)],
)

/** Labels (such as Needs and Wants): another way to sort spending, across the groups. */
export const catalogLabels = sqliteTable(
  'labels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#64748b'),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('labels_name').on(t.name)],
)

export const catalogCategoryLabels = sqliteTable(
  'category_labels',
  {
    categoryId: integer('category_id')
      .notNull()
      .references(() => catalogCategories.id, { onDelete: 'cascade' }),
    labelId: integer('label_id')
      .notNull()
      .references(() => catalogLabels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.labelId] }), index('category_labels_label').on(t.labelId)],
)

/**
 * Your rules for what payees are called, in every ledger (see payeeNamer): names that are one payee,
 * or a regex on the payee as sent. They apply before AI tidying, in `sort` order. A transaction's
 * payee_key is what they make of its payee: kept, and made again when they change.
 */
export const payeeNameRules = sqliteTable('payee_name_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').$type<'same' | 'regex'>().notNull(),
  match: text('match').$type<'is' | 'starts' | 'contains'>(),
  /** JSON: the patterns (the names that are one payee, or one regex). */
  patterns: text('patterns').notNull(),
  name: text('name'),
  enabled: integer('enabled').notNull().default(1),
  sort: integer('sort').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * What AI tidying called each payee as sent (“Walmart” for “Wal-Mart Supercenter#4217”): asked once,
 * then used for every transaction with that payee, in every ledger.
 */
export const payeeTidy = sqliteTable('payee_tidy', {
  original: text('original').primaryKey(),
  tidied: text('tidied').notNull(),
  /** The model that named it. */
  model: text('model'),
  /** The version of AI tidying's instructions it was named by (PAYEE_TIDY_PROMPT): older ones are asked again. */
  prompt: integer('prompt').notNull().default(1),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
})
