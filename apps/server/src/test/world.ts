import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { APPLICATION_ID, type SQLite } from '../db/client'
import { TABLES } from '../db/tables'
import { env } from '../env'

/**
 * Test worlds for the database's own rules: ledgers with a row in every table, written with plain
 * SQL so the schema's views and triggers are what's tested.
 */

/**
 * A migrated database without the write guards: the file's schema and nothing else. In memory
 * unless a file is given, and with another migrations folder only for the migration tests.
 */
export function bareDatabase(opts: { file?: string; migrations?: string } = {}): SQLite {
  const sqlite = new Database(opts.file ?? ':memory:')
  // As openDatabase makes a new file, so openDatabase takes it.
  if (opts.file) {
    sqlite.pragma('auto_vacuum = INCREMENTAL')
    sqlite.pragma(`application_id = ${APPLICATION_ID}`)
  }
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('recursive_triggers = ON')
  migrate(drizzle(sqlite), { migrationsFolder: opts.migrations ?? env.migrations })
  return sqlite
}

/** Runs one statement for a ledger: @ledger is that ledger's id. */
export type Writer = (sql: string, params?: Record<string, unknown>) => number

/** A writer on a bare connection, for a ledger. */
export const bareWriter =
  (sqlite: SQLite, ledger: string): Writer =>
  (sql, params = {}) =>
    Number(sqlite.prepare(sql).run({ ...params, ledger }).lastInsertRowid)

export function addLedger(sqlite: SQLite, id: string, categoryList: 'shared' | 'own' = 'shared') {
  sqlite.prepare('INSERT INTO ledgers (id, name, slug, category_list) VALUES (?, ?, ?, ?)').run(id, id, id.toLowerCase(), categoryList)
}

/** A small shared list: one group, two categories, one label. */
export function addSharedList(sqlite: SQLite) {
  const group = Number(sqlite.prepare("INSERT INTO category_groups (name) VALUES ('Everyday')").run().lastInsertRowid)
  const food = Number(sqlite.prepare("INSERT INTO categories (group_id, name) VALUES (?, 'Food')").run(group).lastInsertRowid)
  const fun = Number(sqlite.prepare("INSERT INTO categories (group_id, name) VALUES (?, 'Fun')").run(group).lastInsertRowid)
  const label = Number(sqlite.prepare("INSERT INTO labels (name) VALUES ('Needs')").run().lastInsertRowid)
  sqlite.prepare('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)').run(food, label)
  return { group, food, fun, label }
}

export interface LedgerRows {
  institution: number
  account: number
  savings: number
  tag: number
  batch: number
  item: number
  purchase: number
  refund: number
  transferOut: number
  transferIn: number
  payment: number
  report: number
}

/**
 * One of everything for a ledger on the shared list: accounts, a refund linked to its purchase, a
 * transfer pair, a recurring item with its child rows, tags, rules, activity and settings.
 * `category` and `offCategory` are shared categories (the second one turned off).
 *
 * It writes only the baseline's columns: migrations.test.ts fills a database that ran the baseline
 * alone with it, then upgrades it.
 */
export function fillLedger(write: Writer, opts: { category: number; offCategory: number }): LedgerRows {
  const institution = write("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Bank')")
  const account = write("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES (@ledger, 'Card', 'credit', @institution)", { institution })
  const savings = write("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES (@ledger, 'Savings', 'savings', @institution)", { institution })
  const tag = write("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'trip')")
  const batch = write("INSERT INTO import_batches (ledger_id, account_id, file_name) VALUES (@ledger, @account, 'card.csv')", { account })
  const item = write(
    `INSERT INTO recurring_items (ledger_id, name, payee_key, category_id, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
     VALUES (@ledger, 'Gym', 'gym', @category, @account, -5000, 'monthly', '2026-01-01', '2026-11-01', 'active', 'manual')`,
    { category: opts.category, account },
  )
  const tx = (values: { account: number; date: string; amount: number; payee: string; category?: number | null; item?: number | null; batch?: number | null }) =>
    write(
      `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, recurring_item_id, import_batch_id)
       VALUES (@ledger, @account, @date, @amount, @payee, lower(@payee), @category, @item, @batch)`,
      { category: null, item: null, batch: null, ...values },
    )
  const purchase = tx({ account, date: '2026-08-01', amount: -10000, payee: 'Shop', category: opts.category })
  const refund = tx({ account, date: '2026-08-05', amount: 4000, payee: 'Shop' })
  const transferOut = tx({ account: savings, date: '2026-08-02', amount: -2500, payee: 'Card payment' })
  const transferIn = tx({ account, date: '2026-08-02', amount: 2500, payee: 'Card payment' })
  write('UPDATE transactions SET transfer_pair_id = @b WHERE id = @a AND ledger_id = @ledger', { a: transferOut, b: transferIn })
  write('UPDATE transactions SET transfer_pair_id = @b WHERE id = @a AND ledger_id = @ledger', { a: transferIn, b: transferOut })
  const payment = tx({ account, date: '2026-08-03', amount: -5000, payee: 'Gym', category: opts.category, item, batch })

  write("INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('refund', @refund, @purchase, 4000)", { refund, purchase })
  write('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (@purchase, @tag)', { purchase, tag })
  write('INSERT INTO transfer_rejections (in_id, out_id) VALUES (@refund, @payment)', { refund, payment })
  write("INSERT INTO recurring_payees (item_id, payee_key, name) VALUES (@item, 'gym co', 'Gym Co')", { item })
  write('INSERT INTO recurring_not_payments (item_id, transaction_id) VALUES (@item, @purchase)', { item, purchase })
  write("INSERT INTO recurring_price_changes (item_id, from_date, previous_amount_minor) VALUES (@item, '2026-06-01', -4500)", { item })
  write("INSERT INTO recurring_payment_dues (item_id, transaction_id, due_date) VALUES (@item, @payment, '2026-08-01')", { item, payment })
  write("INSERT INTO balance_snapshots (account_id, date, balance_minor) VALUES (@account, '2026-08-31', -8500)", { account })
  write("INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (@account, 'plaid', 'r1', @purchase, 'added', '{}')", {
    account,
    purchase,
  })
  const report = write(`INSERT INTO custom_reports (ledger_id, name, spec) VALUES (@ledger, 'Trips', '{}')`)
  write("INSERT INTO payee_rules (ledger_id, payee_key, mode, category_id) VALUES (@ledger, 'shop', 'always', @category)", { category: opts.category })
  write("INSERT INTO payee_category_stats (ledger_id, payee_key, direction, category_id, count) VALUES (@ledger, 'shop', 'out', @category, 1)", { category: opts.category })
  write("INSERT INTO activity (ledger_id, actor, action, entity, summary) VALUES (@ledger, 'web', 'create', 'transaction', 'Added Shop')")
  write("INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok) VALUES (@ledger, 'primary', 'm', 10, 1)")
  write("INSERT INTO ledger_settings (ledger_id, key, value) VALUES (@ledger, 'setup.completed', 'true')")
  write("INSERT INTO ledger_category_off (ledger_id, category_id, archived_at) VALUES (@ledger, @category, '2026-09-01')", { category: opts.offCategory })
  return { institution, account, savings, tag, batch, item, purchase, refund, transferOut, transferIn, payment, report }
}

/** How many rows of a ledger each table holds (child rows through their parents). */
export function ledgerRowCounts(sqlite: SQLite, ledger: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of TABLES) {
    if (t.kind === 'app') continue
    const where =
      t.kind === 'child' ? t.parents!.map((p) => `"${p.column}" IN (SELECT id FROM "${p.table}" WHERE ledger_id = @ledger)`).join(' OR ') : 'ledger_id = @ledger'
    counts[t.name] = sqlite.prepare(`SELECT count(*) FROM "${t.name}" WHERE ${where}`).pluck().get({ ledger }) as number
  }
  return counts
}
