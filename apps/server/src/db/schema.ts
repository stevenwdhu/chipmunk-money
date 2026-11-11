import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
// Type-only imports keep this file loadable by drizzle-kit without resolving workspace sources.
import type { AccountType, Cadence, CategorySource, ColumnMapping, LinkKind, ReportSpec } from '@st/shared'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

const timestamps = {
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
}

/** Banks and other places accounts are held. Every account belongs to one. */
export const institutions = sqliteTable(
  'institutions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
)

export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').$type<AccountType>().notNull(),
    currency: text('currency').notNull().default('CAD'),
    openingBalanceMinor: integer('opening_balance_minor').notNull().default(0),
    openingDate: text('opening_date'),
    // The column itself is nullable: it was added with ALTER TABLE, because rebuilding the accounts table
    // inside a migration would cascade-delete its transactions. The app always sets it.
    institutionId: integer('institution_id')
      .notNull()
      .references(() => institutions.id),
    notes: text('notes'),
    archivedAt: text('archived_at'),
    sort: integer('sort').notNull().default(0),
    externalId: text('external_id'),
    importMapping: text('import_mapping', { mode: 'json' }).$type<ColumnMapping>(),
    ...timestamps,
  },
  (t) => [index('accounts_institution').on(t.institutionId)],
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

export const categoryGroups = sqliteTable('category_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** Its categories show in this colour; categories have none of their own. */
  color: text('color').notNull().default('#64748b'),
  sort: integer('sort').notNull().default(0),
  ...timestamps,
})

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id').references(() => categoryGroups.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    isIncome: integer('is_income', { mode: 'boolean' }).notNull().default(false),
    excludeFromTotals: integer('exclude_from_totals', { mode: 'boolean' }).notNull().default(false),
    archivedAt: text('archived_at'),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('categories_group').on(t.groupId)],
)

/**
 * Labels you put on categories: your own way to sort spending across the groups, such as needs and
 * wants. A category can have several.
 */
export const labels = sqliteTable(
  'labels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#64748b'),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('labels_name').on(t.name)],
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

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    color: text('color'),
    ...timestamps,
  },
  (t) => [uniqueIndex('tags_name').on(t.name)],
)

export const importBatches = sqliteTable('import_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  fileName: text('file_name'),
  rowCount: integer('row_count').notNull().default(0),
  createdAt: timestamps.createdAt,
})

export const recurringItems = sqliteTable(
  'recurring_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
  (t) => [index('recurring_payee').on(t.payeeKey), index('recurring_status').on(t.status)],
)

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    ...timestamps,
  },
  (t) => [
    index('tx_date').on(t.date),
    index('tx_account_date').on(t.accountId, t.date),
    index('tx_category_date').on(t.categoryId, t.date),
    index('tx_payee_key').on(t.payeeKey),
    index('tx_recurring').on(t.recurringItemId),
    index('tx_needs_review')
      .on(t.needsReview)
      .where(sql`${t.needsReview} = 1`),
    uniqueIndex('tx_external_id')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
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
  (t) => [primaryKey({ columns: [t.inId, t.outId] })],
)

/** What you've picked for each payee, for money in and money out apart (a friend's e-transfer to you isn't one you send). */
export const payeeCategoryStats = sqliteTable(
  'payee_category_stats',
  {
    payeeKey: text('payee_key').notNull(),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(0),
    lastUsedAt: text('last_used_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.payeeKey, t.direction, t.categoryId] })],
)

/**
 * What you chose for a payee: `always` one category (applied without review), or `review` (never
 * applied on its own). Payees without a row ask each time.
 */
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
  (t) => [primaryKey({ columns: [t.itemId, t.transactionId] })],
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
  (t) => [primaryKey({ columns: [t.itemId, t.transactionId] })],
)

export const payeeRules = sqliteTable('payee_rules', {
  payeeKey: text('payee_key').primaryKey(),
  mode: text('mode').$type<'always' | 'review'>().notNull(),
  categoryId: integer('category_id').references(() => categories.id, { onDelete: 'cascade' }),
  ...timestamps,
})

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

export const aiCalls = sqliteTable('ai_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slot: text('slot').$type<'primary' | 'fallback'>().notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  latencyMs: integer('latency_ms').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  error: text('error'),
  createdAt: timestamps.createdAt,
})

/**
 * Reports you saved: a filter, range and comparison (a ReportSpec) under a name, unique whatever its
 * case. Ids in the filter aren't foreign keys: one that's gone matches nothing and the report says so.
 */
export const customReports = sqliteTable(
  'custom_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    spec: text('spec', { mode: 'json' }).$type<ReportSpec>().notNull(),
    /** Where you put it in the list. */
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('custom_reports_name').on(sql`lower(${t.name})`)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamps.updatedAt,
})

/** Every change made through the API (the web app included): who, what, and before/after. */
export const activity = sqliteTable(
  'activity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
  (t) => [index('activity_actor').on(t.actor), index('activity_entity').on(t.entity)],
)
