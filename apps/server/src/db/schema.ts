import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
// Type-only imports keep this file loadable by drizzle-kit without resolving workspace sources.
import type { AccountType, ApiScope, BankProviderKind, Cadence, CategorySource, ColumnMapping, LinkKind, ReportSpec } from '@chipmunk/shared'

/**
 * The one database (DATA_DIR/chipmunk.db): every ledger's data, side by side, and what the app
 * shares between ledgers. Ledger data carries the ledger it belongs to (`ledger_id`) on its root
 * tables; child tables belong to a ledger through their parent row. src/db/tables.ts lists which
 * table is which.
 *
 * Ids are global: one sequence per table for every ledger, so a row keeps its id whatever ledger
 * it's in.
 *
 * The views and triggers aren't here (drizzle-kit doesn't make them): they're written by hand at the
 * end of drizzle/0000_baseline.sql, and dropped and made again by later migrations as they change.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

const timestamps = {
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
}

// App-wide tables -----------------------------------------------------------------------

/** One row per ledger. Its data is in the other tables, under its id. */
export const ledgers = sqliteTable(
  'ledgers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color').notNull().default('#6366f1'),
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    /**
     * Which categories it uses: the shared list (rows with no ledger_id, turned off for it in
     * ledger_category_off), or its own (rows with its ledger_id).
     */
    categoryList: text('category_list').$type<'shared' | 'own'>().notNull().default('shared'),
    archivedAt: text('archived_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('ledgers_slug').on(t.slug), check('ledgers_category_list', sql`${t.categoryList} IN ('shared', 'own')`)],
)

/**
 * App-wide settings: time zone, AI providers, default ledger. Called app_settings so they're never
 * confused with ledger_settings.
 */
export const appSettings = sqliteTable('app_settings', {
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
 * different ledgers. `secret` (the Access URL, or Plaid's access token) is encrypted (lib/secrets.ts).
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

/**
 * An account at the provider, and the ledger account it syncs into (if linked). The ledger is the
 * account's, so there's one place that says which ledger a link is in; deleting the account unlinks it.
 */
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
    accountId: integer('account_id').references((): AnySQLiteColumn => accounts.id, { onDelete: 'set null' }),
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
      .on(t.accountId)
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

// Categories ------------------------------------------------------------------------------
// One shared list (rows with no ledger_id) that every ledger with category_list 'shared' uses, by
// the same ids, turning categories off for itself in ledger_category_off. A ledger with its own
// list has rows with its ledger_id instead. Reads go through the ledger_categories,
// ledger_category_groups and ledger_labels views, which give each ledger the list it uses.

export const categoryGroups = sqliteTable(
  'category_groups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Null: in the shared list. */
    ledgerId: text('ledger_id').references(() => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Its categories show in this colour; categories have none of their own. */
    color: text('color').notNull().default('#64748b'),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('category_groups_ledger').on(t.ledgerId)],
)

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Null: in the shared list. */
    ledgerId: text('ledger_id').references(() => ledgers.id, { onDelete: 'cascade' }),
    groupId: integer('group_id').references(() => categoryGroups.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    isIncome: integer('is_income', { mode: 'boolean' }).notNull().default(false),
    excludeFromTotals: integer('exclude_from_totals', { mode: 'boolean' }).notNull().default(false),
    /** Only on a ledger's own categories: a shared one is turned off per ledger (ledger_category_off). */
    archivedAt: text('archived_at'),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('categories_ledger').on(t.ledgerId),
    index('categories_group').on(t.groupId),
    check('categories_shared_not_archived', sql`${t.ledgerId} IS NOT NULL OR ${t.archivedAt} IS NULL`),
  ],
)

/**
 * Labels you put on categories: your own way to sort spending across the groups, such as needs and
 * wants. A category can have several.
 */
export const labels = sqliteTable(
  'labels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Null: in the shared list. */
    ledgerId: text('ledger_id').references(() => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#64748b'),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  // Names are unique within a list: the shared one, or a ledger's own.
  (t) => [
    uniqueIndex('labels_shared_name')
      .on(t.name)
      .where(sql`${t.ledgerId} IS NULL`),
    uniqueIndex('labels_ledger_name')
      .on(t.ledgerId, t.name)
      .where(sql`${t.ledgerId} IS NOT NULL`),
  ],
)

export const categoryLabels = sqliteTable(
  'category_labels',
  {
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    labelId: integer('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.labelId] }), index('category_labels_label').on(t.labelId)],
)

/** Shared categories a ledger turned off, and when: they stay on its old transactions but aren't offered. */
export const ledgerCategoryOff = sqliteTable(
  'ledger_category_off',
  {
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    archivedAt: text('archived_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ledgerId, t.categoryId] }), index('ledger_category_off_category').on(t.categoryId)],
)

// Ledger data ------------------------------------------------------------------------------
// The root tables have ledger_id, with no ON DELETE CASCADE from ledgers: a ledger's data is deleted
// on purpose (deleteLedgerRows), so a stray DELETE FROM ledgers fails instead of wiping it.

/** The ledger a row belongs to. */
const ledgerId = () =>
  text('ledger_id')
    .notNull()
    .references(() => ledgers.id)

/** Banks and other places accounts are held. Every account belongs to one. */
export const institutions = sqliteTable(
  'institutions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ledgerId: ledgerId(),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('institutions_ledger').on(t.ledgerId)],
)

/**
 * Read through the ledger_accounts view, which gives each account to its home ledger (ledger_id)
 * and to every ledger it's shared with (account_ledgers).
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Its home ledger: where new rows from sync and CSV land, and where its settings are changed. */
    ledgerId: ledgerId(),
    name: text('name').notNull(),
    type: text('type').$type<AccountType>().notNull(),
    currency: text('currency').notNull().default('CAD'),
    openingBalanceMinor: integer('opening_balance_minor').notNull().default(0),
    openingDate: text('opening_date'),
    institutionId: integer('institution_id')
      .notNull()
      .references(() => institutions.id),
    notes: text('notes'),
    archivedAt: text('archived_at'),
    sort: integer('sort').notNull().default(0),
    externalId: text('external_id'),
    importMapping: text('import_mapping', { mode: 'json' }).$type<ColumnMapping>(),
    ...timestamps,
    /**
     * The ledger whose part carries the opening balance and the recorded balances: null for the
     * home, otherwise a ledger it's shared with (after the home changed).
     */
    openingLedgerId: text('opening_ledger_id').references(() => ledgers.id),
    /**
     * On an account made when a ledger stopped sharing an account and kept its rows: the shared
     * account it came from. No foreign key, so deleting that account later leaves this one be.
     */
    splitFromId: integer('split_from_id'),
  },
  (t) => [index('accounts_ledger').on(t.ledgerId), index('accounts_institution').on(t.institutionId), index('accounts_opening_ledger').on(t.openingLedgerId)],
)

/**
 * The other ledgers an account is shared with, one row each (its home's is the accounts row): this
 * ledger's institution, sort order and archive for it. The account's own facts stay on accounts.
 */
export const accountLedgers = sqliteTable(
  'account_ledgers',
  {
    ledgerId: ledgerId(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    institutionId: integer('institution_id')
      .notNull()
      .references(() => institutions.id),
    sort: integer('sort').notNull().default(0),
    archivedAt: text('archived_at'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.ledgerId, t.accountId] }),
    index('account_ledgers_account').on(t.accountId),
    index('account_ledgers_institution').on(t.institutionId),
  ],
)

export const balanceSnapshots = sqliteTable(
  'balance_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    balanceMinor: integer('balance_minor').notNull(),
    source: text('source').$type<'manual' | 'sync'>().notNull().default('manual'),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex('balance_snapshots_account_date').on(t.accountId, t.date)],
)

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ledgerId: ledgerId(),
    name: text('name').notNull(),
    color: text('color'),
    ...timestamps,
  },
  (t) => [uniqueIndex('tags_name').on(t.ledgerId, t.name)],
)

export const importBatches = sqliteTable(
  'import_batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ledgerId: ledgerId(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    fileName: text('file_name'),
    rowCount: integer('row_count').notNull().default(0),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('import_batches_ledger').on(t.ledgerId), index('import_batches_account').on(t.accountId)],
)

export const recurringItems = sqliteTable(
  'recurring_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ledgerId: ledgerId(),
    /** The payee as shown, like "Klarna" (the API's `payee`). */
    name: text('name').notNull(),
    /** What it is, like "Dyson vacuum" (the API's `name`); null shows the payee. */
    title: text('title'),
    payeeKey: text('payee_key').notNull(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    expectedAmountMinor: integer('expected_amount_minor').notNull(),
    amountTolerancePct: real('amount_tolerance_pct').notNull().default(10),
    cadence: text('cadence').$type<Cadence>().notNull(),
    anchorDate: text('anchor_date').notNull(),
    nextDueDate: text('next_due_date').notNull(),
    status: text('status').$type<'suggested' | 'active' | 'dismissed' | 'ended'>().notNull(),
    origin: text('origin').$type<'detected' | 'manual'>().notNull(),
    detectionScore: real('detection_score'),
    /** Semi-monthly: the other day of the month it's due, besides the anchor date's (31: the last day). */
    secondDay: integer('second_day'),
    /** An instalment plan: how many payments it has (null: no end, like a bill or subscription). */
    totalPayments: integer('total_payments'),
    /** Payments made before the ones linked to it (from before your history). */
    paidBefore: integer('paid_before').notNull().default(0),
    /**
     * An instalment plan: the total of all its payments, as the lender shows it (signed like its amount).
     * Its last payment is what's left of it. Null: every payment is its amount.
     */
    fullPriceMinor: integer('full_price_minor'),
    ...timestamps,
  },
  (t) => [
    index('recurring_ledger_status').on(t.ledgerId, t.status),
    index('recurring_ledger_payee').on(t.ledgerId, t.payeeKey),
    index('recurring_account').on(t.accountId),
    index('recurring_category').on(t.categoryId),
  ],
)

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The ledger that holds it. */
    ledgerId: ledgerId(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    /**
     * When it happened, if known: local time in the app's time zone, like `date` and on the same day
     * (YYYY-MM-DDTHH:MM:SS). Orders a day's transactions; most banks only give the day.
     */
    datetime: text('datetime'),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull().default('CAD'),
    payee: text('payee').notNull(),
    payeeKey: text('payee_key').notNull(),
    /** What it is, like "Suitcase" (optional). A recurring item's payments go by the item's name instead. */
    name: text('name'),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    categorySource: text('category_source').$type<CategorySource>(),
    categoryConfidence: real('category_confidence'),
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    recurringItemId: integer('recurring_item_id').references(() => recurringItems.id, { onDelete: 'set null' }),
    transferPairId: integer('transfer_pair_id'),
    /**
     * Money in: how much of it is linked to purchases or bills it pays back (not deleted ones), kept by
     * triggers so the transaction_lines view reads it straight from the row.
     */
    linkedMinor: integer('linked_minor').notNull().default(0),
    /** The bank's own category (Plaid's, e.g. "Transportation › Gas"), and whether the bank is sure of it. */
    bankCategory: text('bank_category'),
    bankCategoryConfident: integer('bank_category_confident', { mode: 'boolean' }).notNull().default(false),
    status: text('status').$type<'cleared' | 'pending'>().notNull().default('cleared'),
    origin: text('origin').$type<'manual' | 'import' | 'sync'>().notNull().default('manual'),
    importBatchId: integer('import_batch_id').references(() => importBatches.id, { onDelete: 'set null' }),
    externalId: text('external_id'),
    /** When you corrected a synced transaction's amount or date; from then on syncs leave those alone. */
    correctedAt: text('corrected_at'),
    deletedAt: text('deleted_at'),
    /**
     * When a sync deleted it because the bank no longer has it; cleared when it's restored. A row
     * deleted with this unset was deleted by a person.
     */
    removedAt: text('removed_at'),
    /**
     * A split row: the id of the card payment (on the same account) it's a piece of. A payment split
     * between the ledgers that share its account keeps its amount, and each other ledger gets a share
     * row with its amount, while the ledger that holds the payment gets one row for everything it gave
     * (services/splits.ts). A payment's split rows sum to zero. No foreign key: triggers keep it to a
     * live payment that isn't a split row itself.
     */
    splitOf: integer('split_of'),
    /**
     * A row kept only so its account keeps knowing a bank id (external_id): what's left of one that
     * was the account's and went with an account split off from it, or with a ledger, that's gone.
     * It's no one's transaction any more, only what stops a sync, a bank switch or a CSV import from
     * adding it again. It's always deleted and stays so (triggers), the purge leaves it, and it goes
     * with its account.
     */
    bankIdOnly: integer('bank_id_only', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('tx_ledger_date').on(t.ledgerId, t.date),
    index('tx_ledger_category_date').on(t.ledgerId, t.categoryId, t.date),
    index('tx_ledger_payee_key').on(t.ledgerId, t.payeeKey),
    index('tx_ledger_needs_review')
      .on(t.ledgerId)
      .where(sql`${t.needsReview} = 1`),
    // The trash and the nightly purge.
    index('tx_ledger_deleted')
      .on(t.ledgerId, t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    index('tx_account_date').on(t.accountId, t.date),
    // For deleting a shared category, whose transactions are in every ledger.
    index('tx_category').on(t.categoryId),
    index('tx_recurring').on(t.recurringItemId),
    index('tx_import_batch')
      .on(t.importBatchId)
      .where(sql`${t.importBatchId} IS NOT NULL`),
    // What points at a row as its transfer's other side: a move checks there's nothing left.
    index('tx_transfer_pair')
      .on(t.transferPairId)
      .where(sql`${t.transferPairId} IS NOT NULL`),
    // Account-wide on purpose: the bank's id is unique on the account whatever ledger holds the row.
    uniqueIndex('tx_external_id')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    // One split row per ledger per payment, found by the payment's id whatever ledger holds them.
    uniqueIndex('tx_split')
      .on(t.splitOf, t.ledgerId)
      .where(sql`${t.splitOf} IS NOT NULL`),
  ],
)

/**
 * Money in that pays back money out, and how much of it: a refund from the merchant, or a payback (a
 * friend's share of a bill you paid). One payback can cover several bills, and a bill can be paid
 * back by several. Reports count each link in its bill's category (the transaction_lines view), a
 * payback on the bill's date. Money in linked in full to one bill follows its category
 * (links_follow_bill), and to several has none of its own. Triggers keep each money in's
 * `linked_minor` (links_sum_*), and a refund of one purchase with its name (refunds_*_name).
 */
export const transactionLinks = sqliteTable(
  'transaction_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<LinkKind>().notNull(),
    moneyInId: integer('money_in_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    moneyOutId: integer('money_out_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    amountMinor: integer('amount_minor').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('links_pair').on(t.moneyInId, t.moneyOutId), index('links_out').on(t.moneyOutId)],
)

export const transactionTags = sqliteTable(
  'transaction_tags',
  {
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] }), index('transaction_tags_tag').on(t.tagId)],
)

/** Money in and money out you said aren't a transfer ("Not a transfer"): never paired again. */
export const transferRejections = sqliteTable(
  'transfer_rejections',
  {
    inId: integer('in_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    outId: integer('out_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.inId, t.outId] }), index('transfer_rejections_out').on(t.outId)],
)

/** What you've picked for each payee, for money in and money out apart (a friend's e-transfer to you isn't one you send). */
export const payeeCategoryStats = sqliteTable(
  'payee_category_stats',
  {
    ledgerId: ledgerId(),
    payeeKey: text('payee_key').notNull(),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(0),
    lastUsedAt: text('last_used_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.ledgerId, t.payeeKey, t.direction, t.categoryId] }),
    index('payee_category_stats_category').on(t.categoryId),
  ],
)

/**
 * More payees a recurring item's payments come from, besides its own: the bank started sending a
 * different name ("PayHub" for "PayHub Tax"), and you said it's the same item.
 */
export const recurringPayees = sqliteTable(
  'recurring_payees',
  {
    itemId: integer('item_id')
      .notNull()
      .references(() => recurringItems.id, { onDelete: 'cascade' }),
    payeeKey: text('payee_key').notNull(),
    /** As shown, like "PayHub". */
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.payeeKey] }), index('recurring_payees_key').on(t.payeeKey)],
)

/** Payments you said aren't a recurring item's, when one from a similar payee looked like it. */
export const recurringNotPayments = sqliteTable(
  'recurring_not_payments',
  {
    itemId: integer('item_id')
      .notNull()
      .references(() => recurringItems.id, { onDelete: 'cascade' }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.transactionId] }), index('recurring_not_payments_transaction').on(t.transactionId)],
)

/**
 * A recurring item's amount before a price change you accepted ("Is this it?" on a payment at a new
 * amount): payments due before `fromDate` are checked against it, so they stay its payments.
 */
export const recurringPriceChanges = sqliteTable(
  'recurring_price_changes',
  {
    itemId: integer('item_id')
      .notNull()
      .references(() => recurringItems.id, { onDelete: 'cascade' }),
    /** The due date the new amount starts at. */
    fromDate: text('from_date').notNull(),
    previousAmountMinor: integer('previous_amount_minor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.fromDate] })],
)

/**
 * Payments you said are a recurring item's ("Is this it?"), and the due date each is for: one that
 * came early or late, outside its due date's window (Aug 24 for Sep 1), stays that date's payment.
 */
export const recurringPaymentDues = sqliteTable(
  'recurring_payment_dues',
  {
    itemId: integer('item_id')
      .notNull()
      .references(() => recurringItems.id, { onDelete: 'cascade' }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    dueDate: text('due_date').notNull(),
    /**
     * A payment you added at its own amount, like a plan's down payment or its last payment (the
     * remainder): it doesn't change the item's amount or count as a price change.
     */
    oneOff: integer('one_off', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.transactionId] }), index('recurring_payment_dues_transaction').on(t.transactionId)],
)

/**
 * What you chose for a payee: `always` one category (applied without review), or `review` (never
 * applied on its own). Payees without a row ask each time.
 */
export const payeeRules = sqliteTable(
  'payee_rules',
  {
    ledgerId: ledgerId(),
    payeeKey: text('payee_key').notNull(),
    mode: text('mode').$type<'always' | 'review'>().notNull(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.ledgerId, t.payeeKey] }), index('payee_rules_category').on(t.categoryId)],
)

/**
 * What the bank sent for each transaction, as it sent it (Plaid's or SimpleFIN's JSON): when it was
 * new, each time it changed, and when Plaid removed it. Kept to look into where a transaction's
 * data came from.
 */
export const bankPayloads = sqliteTable(
  'bank_payloads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'simplefin' | 'plaid'>().notNull(),
    /** The provider's id for the transaction. */
    remoteId: text('remote_id').notNull(),
    /** The transaction it landed on, if any. */
    transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
    event: text('event').$type<'added' | 'changed' | 'removed'>().notNull(),
    /** JSON, exactly as the provider sent it. */
    payload: text('payload').notNull(),
    receivedAt: text('received_at').notNull().default(now),
  },
  (t) => [index('bank_payloads_remote').on(t.accountId, t.remoteId), index('bank_payloads_transaction').on(t.transactionId)],
)

/**
 * What AI was asked to do, one row per thing asked: a payee to categorize, a set of payees to name,
 * a connection test. The primary failing and the fallback answering is one row. A row that failed
 * stays open (`ok` 0) until the same thing is asked again and answered, which corrects that row:
 * there's one open row per thing (`ai_calls_open`). A row from before requests were recorded has no
 * `kind`: it's one call to one provider.
 */
export const aiCalls = sqliteTable(
  'ai_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The ledger the request was for; null for calls made for the whole app. */
    ledgerId: text('ledger_id').references(() => ledgers.id),
    /** The provider that answered, or the last one tried. */
    slot: text('slot').$type<'primary' | 'fallback'>().notNull(),
    model: text('model').notNull(),
    /** Of every call made for it: a failed primary's and each try's count too. */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** How long the last try took, all its calls together. */
    latencyMs: integer('latency_ms').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    /** Why the last try failed. */
    error: text('error'),
    createdAt: timestamps.createdAt,
    kind: text('kind').$type<'categorize' | 'names' | 'test'>(),
    /** What it was about, to show: the payee as the ledger calls it (`categorize`). */
    subject: text('subject'),
    /**
     * Which thing it is: `out:` or `in:` and the payee key (`categorize`), or the payees as sent, a
     * sorted JSON list (`names`). Null for a connection test, which is never the same thing twice.
     */
    subjectKey: text('subject_key'),
    /** What came of it: the category picked (`categorize`, `test`), or how many payees got a name (`names`). */
    outcome: text('outcome'),
    /** How many times it was asked, the first one counted. */
    tries: integer('tries').notNull().default(1),
    /** When it first failed, kept when a later try answers. */
    firstFailedAt: text('first_failed_at'),
    /** Why the primary failed, when the fallback was asked after it. */
    primaryError: text('primary_error'),
    /** When it was last asked; null on a row from before. */
    triedAt: text('tried_at'),
    /**
     * The transactions a failed “Ask AI again” asked about, a JSON list of each one's id, the category
     * it had and whether it waited for review then: what a retry asks about again, while they are as
     * they were. Null on every other record, and on one that was answered.
     */
    asked: text('asked'),
  },
  (t) => [
    index('ai_calls_ledger_created').on(t.ledgerId, t.createdAt),
    // One open (failed) row per thing asked: asking again corrects it.
    uniqueIndex('ai_calls_open')
      .on(t.ledgerId, t.kind, t.subjectKey)
      .where(sql`${t.ok} = 0 AND ${t.subjectKey} IS NOT NULL`),
  ],
)

/**
 * Reports you saved: a filter, range and comparison (a ReportSpec) under a name, unique in its ledger
 * whatever its case. Ids in the filter aren't foreign keys: one that's gone matches nothing and the
 * report says so.
 */
export const customReports = sqliteTable(
  'custom_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ledgerId: ledgerId(),
    name: text('name').notNull(),
    spec: text('spec', { mode: 'json' }).$type<ReportSpec>().notNull(),
    /** Where you put it in the list. */
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('custom_reports_name').on(t.ledgerId, sql`lower(${t.name})`)],
)

/** Each ledger's own settings (such as whether its setup is done). App-wide ones are in app_settings. */
export const ledgerSettings = sqliteTable(
  'ledger_settings',
  {
    ledgerId: ledgerId(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [primaryKey({ columns: [t.ledgerId, t.key] })],
)

/** Every change made through the API (the web app included): who, what, and before/after. */
export const activity = sqliteTable(
  'activity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ledgerId: ledgerId(),
    createdAt: timestamps.createdAt,
    /** "web" or the API key's name at the time. */
    actor: text('actor').notNull(),
    apiKeyId: text('api_key_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    summary: text('summary').notNull(),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
  },
  (t) => [
    index('activity_ledger_id').on(t.ledgerId, t.id),
    index('activity_ledger_actor').on(t.ledgerId, t.actor),
    index('activity_ledger_entity').on(t.ledgerId, t.entity),
  ],
)
