import type { SQLite } from './client'

/**
 * Every table in chipmunk.db, and how it belongs to a ledger:
 * - `app`: shared by the whole app, no ledger_id.
 * - `ledger`: a root table, every row with its ledger_id.
 * - `catalog`: a category table, ledger_id null for the shared list or a ledger's id for its own.
 * - `child`: no ledger_id, in the ledger of its parent rows (by these foreign keys).
 *
 * In insert order: a table comes after every table it refers to, so deleting goes the other way.
 * A test keeps this list equal to the database's tables.
 */
export type TableKind = 'app' | 'ledger' | 'catalog' | 'child'

export interface TableDef {
  name: string
  kind: TableKind
  /** A child's parents: the foreign keys that say which ledger its rows are in. */
  parents?: ReadonlyArray<{ column: string; table: string }>
}

export const TABLES: readonly TableDef[] = [
  { name: 'ledgers', kind: 'app' },
  { name: 'app_settings', kind: 'app' },
  { name: 'api_keys', kind: 'app' },
  { name: 'idempotency_keys', kind: 'app' },
  { name: 'bank_connections', kind: 'app' },
  { name: 'payee_name_rules', kind: 'app' },
  { name: 'payee_tidy', kind: 'app' },
  { name: 'institutions', kind: 'ledger' },
  { name: 'accounts', kind: 'ledger' },
  { name: 'bank_accounts', kind: 'app' },
  { name: 'bank_transactions', kind: 'app' },
  { name: 'category_groups', kind: 'catalog' },
  { name: 'categories', kind: 'catalog' },
  { name: 'labels', kind: 'catalog' },
  {
    name: 'category_labels',
    kind: 'child',
    parents: [
      { column: 'category_id', table: 'categories' },
      { column: 'label_id', table: 'labels' },
    ],
  },
  { name: 'ledger_category_off', kind: 'ledger' },
  { name: 'tags', kind: 'ledger' },
  { name: 'import_batches', kind: 'ledger' },
  { name: 'recurring_items', kind: 'ledger' },
  { name: 'transactions', kind: 'ledger' },
  {
    name: 'transaction_links',
    kind: 'child',
    parents: [
      { column: 'money_in_id', table: 'transactions' },
      { column: 'money_out_id', table: 'transactions' },
    ],
  },
  {
    name: 'transaction_tags',
    kind: 'child',
    parents: [
      { column: 'transaction_id', table: 'transactions' },
      { column: 'tag_id', table: 'tags' },
    ],
  },
  {
    name: 'transfer_rejections',
    kind: 'child',
    parents: [
      { column: 'in_id', table: 'transactions' },
      { column: 'out_id', table: 'transactions' },
    ],
  },
  { name: 'recurring_payees', kind: 'child', parents: [{ column: 'item_id', table: 'recurring_items' }] },
  {
    name: 'recurring_not_payments',
    kind: 'child',
    parents: [
      { column: 'item_id', table: 'recurring_items' },
      { column: 'transaction_id', table: 'transactions' },
    ],
  },
  { name: 'recurring_price_changes', kind: 'child', parents: [{ column: 'item_id', table: 'recurring_items' }] },
  {
    name: 'recurring_payment_dues',
    kind: 'child',
    parents: [
      { column: 'item_id', table: 'recurring_items' },
      { column: 'transaction_id', table: 'transactions' },
    ],
  },
  { name: 'balance_snapshots', kind: 'child', parents: [{ column: 'account_id', table: 'accounts' }] },
  {
    name: 'bank_payloads',
    kind: 'child',
    parents: [
      { column: 'account_id', table: 'accounts' },
      { column: 'transaction_id', table: 'transactions' },
    ],
  },
  { name: 'custom_reports', kind: 'ledger' },
  { name: 'payee_rules', kind: 'ledger' },
  { name: 'payee_category_stats', kind: 'ledger' },
  { name: 'activity', kind: 'ledger' },
  // ledger_id is null for calls made for the whole app.
  { name: 'ai_calls', kind: 'ledger' },
  { name: 'ledger_settings', kind: 'ledger' },
]

/** Views with ledger_id: a read of one is pinned to a ledger like a read of a ledger table. */
export const LEDGER_VIEWS = ['ledger_accounts', 'ledger_categories', 'ledger_category_groups', 'ledger_labels', 'transaction_lines'] as const

const byName = new Map(TABLES.map((t) => [t.name, t]))

export function tableDef(name: string): TableDef | undefined {
  return byName.get(name)
}

/** Tables and views whose rows carry a ledger_id: every reference to one needs a ledger pin. */
export const PINNED_NAMES: ReadonlySet<string> = new Set([
  ...TABLES.filter((t) => t.kind === 'ledger' || t.kind === 'catalog').map((t) => t.name),
  ...LEDGER_VIEWS,
])

export const CHILD_NAMES: ReadonlySet<string> = new Set(TABLES.filter((t) => t.kind === 'child').map((t) => t.name))

/**
 * Deletes every row of one ledger: its root rows, its own categories, and the child rows under
 * them, children before parents so foreign keys stay on (their actions, such as unlinking bank
 * accounts, keep firing). `keep` leaves those tables alone (restore keeps the activity log, say).
 * Rows of other ledgers and the shared list aren't touched.
 *
 * Run it in the ledger's write scope (ledgerMaintenance in scope.ts): the write guards refuse it otherwise.
 */
export function deleteLedgerRows(sqlite: SQLite, ledgerId: string, opts: { keep?: readonly string[] } = {}): Record<string, number> {
  if (sqlite.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('deleteLedgerRows needs foreign keys on')
  const keep = new Set(opts.keep ?? [])
  for (const name of keep) if (!byName.has(name)) throw new Error(`There's no table ${name}`)
  const deleted: Record<string, number> = {}
  sqlite.transaction(() => {
    for (const t of [...TABLES].reverse()) {
      if (t.kind === 'app' || keep.has(t.name)) continue
      const sql =
        t.kind === 'child'
          ? `DELETE FROM "${t.name}" WHERE ${t.parents!.map((p) => `"${p.column}" IN (SELECT id FROM "${p.table}" WHERE ledger_id = @ledger)`).join(' OR ')}`
          : `DELETE FROM "${t.name}" WHERE ledger_id = @ledger`
      deleted[t.name] = sqlite.prepare(sql).run({ ledger: ledgerId }).changes
    }
  })()
  return deleted
}
