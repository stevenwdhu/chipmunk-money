import { DEFAULT_CATEGORY_GROUPS, DEFAULT_LABELS } from '@st/shared'
import type { SQLite } from '../db/client'
import { ulid } from '../lib/ids'
import type { MetaStore } from './context'
import { joinCategoryRefs } from './custom-reports'
import { getAppSetting, setAppSetting } from './settings'

/**
 * The shared category list (in meta.db) and each ledger's copy of it.
 *
 * Every ledger uses the shared list's categories, by the same ids, and turns each one on or off for
 * itself (`archived_at` in its copy). The copy keeps the ledger's reports and backups standing on
 * their own; `syncLedgerCategories` brings it in line after the list changes, and the first time a
 * ledger meets the list (or after restoring a backup from elsewhere) it matches the ledger's own
 * categories to the list by name and moves their transactions over.
 */

/** In meta.db: this list's id. In a ledger: the id of the list its categories follow. */
const TOKEN_KEY = 'categories.catalog'
/** In meta.db: bumped on every change to the list. In a ledger: the version its copy has. */
const VERSION_KEY = 'categories.version'

const catalogVersion = (meta: MetaStore) => getAppSetting<number>(meta, VERSION_KEY, 0)

/** Marks the list as changed, so each ledger's copy catches up the next time it's used. */
export function touchCatalog(meta: MetaStore) {
  setAppSetting(meta, VERSION_KEY, catalogVersion(meta) + 1)
}

function ledgerValue<T>(sqlite: SQLite, key: string): T | null {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as T) : null
}

function setLedgerValue(sqlite: SQLite, key: string, value: unknown) {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(key, JSON.stringify(value))
}

/** In a ledger: 'own' when it keeps its own list instead of the shared one. */
const MODE_KEY = 'categories.mode'

/** Whether a ledger uses the shared list (the default) rather than its own. */
export function usesSharedList(sqlite: SQLite): boolean {
  return ledgerValue<string>(sqlite, MODE_KEY) !== 'own'
}

/** Whether a ledger that uses the shared list has a copy that's behind it (or has never met it). */
export function ledgerNeedsSync(meta: MetaStore, sqlite: SQLite): boolean {
  if (!usesSharedList(sqlite)) return false
  return ledgerValue<string>(sqlite, TOKEN_KEY) !== catalogToken(meta) || ledgerValue<number>(sqlite, VERSION_KEY) !== catalogVersion(meta)
}

/**
 * What happens to one of a ledger's own categories when it joins the shared list: it becomes a
 * shared category (a number: matched, or its transactions moved there), is added to the shared list
 * ('add'), or goes, leaving its transactions uncategorized (null).
 */
export type JoinResolution = number | 'add' | null

/**
 * A ledger's own categories that the shared list doesn't have by name, for choosing what happens to
 * each when it joins: with how many transactions use it, and a shared category that seems to fit
 * (one the defaults used to call that, or one whose name is part of its name or the other way round).
 */
export function joinPreview(meta: MetaStore, sqlite: SQLite) {
  seedCatalog(meta)
  const catalog = readCatalog(meta)
  const local = sqlite
    .prepare(
      `SELECT c.id, c.name, g.name AS groupName,
         (SELECT count(*) FROM transactions t WHERE t.category_id = c.id AND t.deleted_at IS NULL) AS transactionCount
       FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id ORDER BY g.sort, c.sort, c.id`,
    )
    .all() as Array<{ id: number; name: string; groupName: string | null; transactionCount: number }>
  const byName = (name: string) => catalog.categories.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return local
    .filter((c) => !byName(c.name))
    .map((c) => {
      const former = FORMER_NAMES[c.name.toLowerCase()]
      let suggestion = former ? byName(former) : undefined
      if (!suggestion) {
        const mine = c.name.toLowerCase()
        suggestion = catalog.categories.find((x) => {
          const theirs = x.name.toLowerCase()
          return Math.min(theirs.length, mine.length) >= 4 && (mine.includes(theirs) || theirs.includes(mine))
        })
      }
      return { id: c.id, name: c.name, group: c.groupName, transactionCount: c.transactionCount, suggestion: suggestion?.id ?? null }
    })
}

/**
 * Switches a ledger between the shared list and its own. Leaving, it keeps its copy as its own list
 * (the shared list isn't changed). Joining, its categories are matched to the shared list by name;
 * `resolve` says what happens to ones the list doesn't have by name (left out: they're added to it).
 */
export function setCategorySharing(meta: MetaStore, sqlite: SQLite, shared: boolean, resolve?: Map<number, JoinResolution>) {
  if (shared === usesSharedList(sqlite)) return
  if (shared && resolve) {
    const known = new Set(readCatalog(meta).categories.map((c) => c.id))
    for (const to of resolve.values()) if (typeof to === 'number' && !known.has(to)) throw new Error(`The shared list has no category ${to}`)
  }
  for (const key of [MODE_KEY, TOKEN_KEY, VERSION_KEY]) sqlite.prepare('DELETE FROM settings WHERE key = ?').run(key)
  if (shared) syncLedgerCategories(meta, sqlite, resolve)
  else setLedgerValue(sqlite, MODE_KEY, 'own')
}

/** Names the defaults used to have, lowercased, and what they're called now. */
const FORMER_NAMES: Record<string, string> = {
  paycheque: 'Salary',
  'hydro & utilities': 'Electricity & heating',
  'hydro & heating': 'Electricity & heating',
  'water & sewer': 'Water',
  'phone & internet': 'Internet',
  'mobile phones': 'Phones',
  'home & household': 'Household supplies',
  'moving & relocation': 'Relocation',
  'furniture & renovations': 'Furniture & decorations',
  'dining out': 'Dine out',
  coffee: 'Drinks & treats',
  gas: 'Fuel',
  'fuel & charging': 'Fuel',
  'public transit': 'Transit',
  'car payment or lease': 'Car payment',
  parking: 'Parking & tolls',
  'ride share & taxi': 'Taxi',
  'home or tenant insurance': 'Home insurance',
  'life & disability insurance': 'Life insurance',
  'health & dental insurance': 'Health insurance',
  'health & pharmacy': 'Pharmacy',
  'pharmacy & prescriptions': 'Pharmacy',
  shopping: 'General shopping',
  fitness: 'Sports & fitness',
  subscriptions: 'Software & media',
  'streaming & media': 'Software & media',
  'apps & software': 'Software & media',
  'gifts & donations': 'Gifts',
  'fees & interest': 'Bank & card fees',
  taxes: 'Income tax',
}

export interface CatalogGroup {
  id: number
  name: string
  color: string
  sort: number
}
export interface CatalogCategory {
  id: number
  groupId: number | null
  name: string
  isIncome: number
  excludeFromTotals: number
  sort: number
}
export interface CatalogLabel {
  id: number
  name: string
  color: string
  sort: number
}
export interface Catalog {
  groups: CatalogGroup[]
  categories: CatalogCategory[]
  labels: CatalogLabel[]
  links: Array<{ categoryId: number; labelId: number }>
}

export function readCatalog(meta: MetaStore): Catalog {
  const all = <T>(sql: string) => meta.sqlite.prepare(sql).all() as T[]
  return {
    groups: all<CatalogGroup>('SELECT id, name, color, sort FROM category_groups ORDER BY sort, id'),
    categories: all<CatalogCategory>(
      'SELECT id, group_id AS groupId, name, is_income AS isIncome, exclude_from_totals AS excludeFromTotals, sort FROM categories ORDER BY sort, id',
    ),
    labels: all<CatalogLabel>('SELECT id, name, color, sort FROM labels ORDER BY sort, id'),
    links: all<{ categoryId: number; labelId: number }>('SELECT category_id AS categoryId, label_id AS labelId FROM category_labels'),
  }
}

/** The list's id, which a ledger's copy remembers so it knows its ids are the list's. */
export function catalogToken(meta: MetaStore): string {
  let token = getAppSetting<string | null>(meta, TOKEN_KEY, null)
  if (!token) {
    token = ulid()
    setAppSetting(meta, TOKEN_KEY, token)
  }
  return token
}

/** Starts the list from the default categories and labels, the first time. */
export function seedCatalog(meta: MetaStore) {
  if (meta.sqlite.prepare('SELECT 1 FROM categories LIMIT 1').get()) return
  meta.sqlite.transaction(() => {
    const labelIds = new Map<string, number>()
    DEFAULT_LABELS.forEach((l, i) => {
      const id = Number(meta.sqlite.prepare('INSERT INTO labels (name, color, sort) VALUES (?, ?, ?)').run(l.name, l.color, i).lastInsertRowid)
      labelIds.set(l.name, id)
    })
    DEFAULT_CATEGORY_GROUPS.forEach((g, gi) => {
      const groupId = Number(meta.sqlite.prepare('INSERT INTO category_groups (name, color, sort) VALUES (?, ?, ?)').run(g.name, g.color, gi).lastInsertRowid)
      g.categories.forEach((c, ci) => {
        const id = Number(
          meta.sqlite
            .prepare('INSERT INTO categories (group_id, name, is_income, exclude_from_totals, sort) VALUES (?, ?, ?, ?, ?)')
            .run(groupId, c.name, c.isIncome ? 1 : 0, c.excludeFromTotals ? 1 : 0, ci).lastInsertRowid,
        )
        for (const name of c.labels ?? []) {
          const labelId = labelIds.get(name)
          if (labelId) meta.sqlite.prepare('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)').run(id, labelId)
        }
      })
    })
  })()
  catalogToken(meta)
}

interface LocalCategory {
  id: number
  name: string
  isIncome: number
  excludeFromTotals: number
  archivedAt: string | null
  groupName: string | null
  groupColor: string | null
}

/**
 * The list's category for one of a ledger's own: the same name, or what a former default name is
 * called now. One the list doesn't have is added to it (in the group of the same name), so nothing
 * a ledger has is lost.
 */
/** The shared category a ledger's category of this name becomes, by its name or a former one. */
function sharedByName(catalog: Catalog, name: string) {
  const byName = (n: string) => catalog.categories.find((x) => x.name.toLowerCase() === n.toLowerCase())
  const former = FORMER_NAMES[name.toLowerCase()]
  return byName(name) ?? (former ? byName(former) : undefined)
}

function matchOrAdd(meta: MetaStore, catalog: Catalog, c: LocalCategory, labels: Array<{ name: string; color: string }>): number {
  const found = sharedByName(catalog, c.name)
  if (found) return found.id

  let group = c.groupName ? catalog.groups.find((g) => g.name.toLowerCase() === c.groupName!.toLowerCase()) : undefined
  if (!group && c.groupName) {
    const sort = Math.max(-1, ...catalog.groups.map((g) => g.sort)) + 1
    const color = c.groupColor ?? '#64748b'
    const id = Number(meta.sqlite.prepare('INSERT INTO category_groups (name, color, sort) VALUES (?, ?, ?)').run(c.groupName, color, sort).lastInsertRowid)
    group = { id, name: c.groupName, color, sort }
    catalog.groups.push(group)
  }
  const sort = Math.max(-1, ...catalog.categories.filter((x) => x.groupId === (group?.id ?? null)).map((x) => x.sort)) + 1
  const id = Number(
    meta.sqlite
      .prepare('INSERT INTO categories (group_id, name, is_income, exclude_from_totals, sort) VALUES (?, ?, ?, ?, ?)')
      .run(group?.id ?? null, c.name, c.isIncome, c.excludeFromTotals, sort).lastInsertRowid,
  )
  catalog.categories.push({ id, groupId: group?.id ?? null, name: c.name, isIncome: c.isIncome, excludeFromTotals: c.excludeFromTotals, sort })
  for (const l of labels) {
    let label = catalog.labels.find((x) => x.name.toLowerCase() === l.name.toLowerCase())
    if (!label) {
      const lsort = Math.max(-1, ...catalog.labels.map((x) => x.sort)) + 1
      const labelId = Number(meta.sqlite.prepare('INSERT INTO labels (name, color, sort) VALUES (?, ?, ?)').run(l.name, l.color, lsort).lastInsertRowid)
      label = { id: labelId, name: l.name, color: l.color, sort: lsort }
      catalog.labels.push(label)
    }
    meta.sqlite.prepare('INSERT OR IGNORE INTO category_labels (category_id, label_id) VALUES (?, ?)').run(id, label.id)
    catalog.links.push({ categoryId: id, labelId: label.id })
  }
  return id
}

/**
 * Whether bringing this ledger (a backup, say) in line with the shared list would add categories to
 * it: the ledger uses the shared list, wasn't made from this one, and has categories it doesn't.
 */
export function wouldAddToSharedList(meta: MetaStore, sqlite: SQLite): boolean {
  if (!usesSharedList(sqlite)) return false
  if (ledgerValue<string>(sqlite, TOKEN_KEY) === catalogToken(meta)) return false
  const catalog = readCatalog(meta)
  const names = sqlite.prepare('SELECT name FROM categories').all() as Array<{ name: string }>
  return names.some((c) => !sharedByName(catalog, c.name))
}

/**
 * Brings a ledger's copy of the categories in line with the shared list. Its categories that are
 * off stay off; ones new to it are on. Called when a ledger is used after the list changed, and when
 * it's created, erased or restored. A ledger with its own list is left alone.
 */
export function syncLedgerCategories(meta: MetaStore, sqlite: SQLite, resolve?: Map<number, JoinResolution>) {
  seedCatalog(meta)
  if (!usesSharedList(sqlite)) return
  const token = catalogToken(meta)
  const local = sqlite
    .prepare(
      `SELECT c.id, c.name, c.is_income AS isIncome, c.exclude_from_totals AS excludeFromTotals, c.archived_at AS archivedAt,
         g.name AS groupName, g.color AS groupColor
       FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id ORDER BY c.id`,
    )
    .all() as LocalCategory[]

  if (ledgerValue<string>(sqlite, TOKEN_KEY) === token) {
    // Its ids are the list's: update what changed, add what's new, drop what's gone.
    const catalog = readCatalog(meta)
    const known = new Set(catalog.categories.map((c) => c.id))
    sqlite.transaction(() => {
      const gone = local.filter((c) => !known.has(c.id)).map((c) => c.id)
      if (gone.length) forget(sqlite, gone)
      write(sqlite, catalog, new Map(local.filter((c) => known.has(c.id)).map((c) => [c.id, c.archivedAt])))
      setLedgerValue(sqlite, VERSION_KEY, catalogVersion(meta))
    })()
    return
  }

  // First time (or a backup from another list): match the ledger's categories to the list by name.
  if (sqlite.inTransaction) throw new Error('A ledger’s categories can’t be matched to the shared list inside a transaction')
  const localLabels = sqlite
    .prepare('SELECT cl.category_id AS categoryId, l.name, l.color FROM category_labels cl JOIN labels l ON l.id = cl.label_id')
    .all() as Array<{ categoryId: number; name: string; color: string }>
  const catalog = readCatalog(meta)
  // Each of the ledger's categories → the shared one it becomes, or null: it goes, uncategorizing its transactions.
  const map = new Map<number, number | null>()
  meta.sqlite.transaction(() => {
    const before = catalog.categories.length
    for (const c of local) {
      const chosen = resolve?.get(c.id)
      map.set(c.id, chosen === undefined || chosen === 'add' ? matchOrAdd(meta, catalog, c, localLabels.filter((l) => l.categoryId === c.id)) : chosen)
    }
    // Other ledgers pick up what this one added.
    if (catalog.categories.length > before) touchCatalog(meta)
  })()
  // On if any of the ledger's categories that became it was on; new ones are on.
  const archived = new Map<number, string | null>()
  for (const c of local) {
    const target = map.get(c.id)
    if (target === null || target === undefined) continue
    archived.set(target, archived.has(target) && archived.get(target) === null ? null : c.archivedAt)
  }

  // Ids change, so foreign keys are off while everything that points at a category moves.
  sqlite.pragma('foreign_keys = OFF')
  try {
    sqlite.transaction(() => {
      sqlite.exec('CREATE TEMP TABLE category_map (old INTEGER PRIMARY KEY, new INTEGER)')
      const insert = sqlite.prepare('INSERT INTO category_map (old, new) VALUES (?, ?)')
      for (const [old, next] of map) insert.run(old, next)
      // Categories that go: their transactions and recurring payments become uncategorized.
      const going = 'SELECT old FROM category_map WHERE new IS NULL'
      sqlite.exec(`UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0 WHERE category_id IN (${going})`)
      sqlite.exec(`UPDATE recurring_items SET category_id = NULL WHERE category_id IN (${going})`)
      sqlite.exec(`DELETE FROM payee_rules WHERE category_id IN (${going})`)
      const moved = '(SELECT new FROM category_map WHERE old = category_id)'
      sqlite.exec(`UPDATE transactions SET category_id = ${moved} WHERE category_id IS NOT NULL`)
      sqlite.exec(`UPDATE recurring_items SET category_id = ${moved} WHERE category_id IS NOT NULL`)
      sqlite.exec(`UPDATE payee_rules SET category_id = ${moved} WHERE category_id IS NOT NULL`)
      // What was learned about payees adds up where two categories became one.
      sqlite.exec(`CREATE TEMP TABLE learned AS
        SELECT s.payee_key, s.direction, m.new AS category_id, sum(s.count) AS count, max(s.last_used_at) AS last_used_at
        FROM payee_category_stats s JOIN category_map m ON m.old = s.category_id WHERE m.new IS NOT NULL GROUP BY s.payee_key, s.direction, m.new`)
      sqlite.exec('DELETE FROM payee_category_stats')
      sqlite.exec(
        'INSERT INTO payee_category_stats (payee_key, direction, category_id, count, last_used_at) SELECT payee_key, direction, category_id, count, last_used_at FROM learned',
      )
      // Groups and labels are matched by name: the ledger's, before they go.
      const names = (table: string) => new Map((sqlite.prepare(`SELECT id, name FROM ${table}`).all() as Array<{ id: number; name: string }>).map((r) => [r.id, r.name]))
      const [groups, labels] = [names('category_groups'), names('labels')]
      sqlite.exec('DELETE FROM category_labels; DELETE FROM categories; DELETE FROM category_groups; DELETE FROM labels')
      const shared = readCatalog(meta)
      write(sqlite, shared, archived)
      const byName = (former: Map<number, string>, now: Array<{ id: number; name: string }>) =>
        new Map([...former].map(([id, name]) => [id, now.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null]))
      // Custom reports follow, losing the categories, groups and labels that went (shared ones may have their ids).
      joinCategoryRefs(sqlite, {
        category: { to: map, names: new Map(local.map((c) => [c.id, c.name])) },
        group: { to: byName(groups, shared.groups), names: groups },
        label: { to: byName(labels, shared.labels), names: labels },
      })
      sqlite.exec('DROP TABLE category_map; DROP TABLE learned')
      const broken = sqlite.pragma('foreign_key_check') as unknown[]
      if (broken.length) throw new Error(`Matching the categories left ${broken.length} broken references`)
      setLedgerValue(sqlite, TOKEN_KEY, token)
      setLedgerValue(sqlite, VERSION_KEY, catalogVersion(meta))
    })()
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
}

/** Categories the list no longer has: their transactions and recurring payments become uncategorized. */
function forget(sqlite: SQLite, ids: number[]) {
  const list = JSON.stringify(ids)
  sqlite
    .prepare(
      `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0
       WHERE category_id IN (SELECT value FROM json_each(?))`,
    )
    .run(list)
  sqlite.prepare('UPDATE recurring_items SET category_id = NULL WHERE category_id IN (SELECT value FROM json_each(?))').run(list)
  sqlite.prepare('DELETE FROM categories WHERE id IN (SELECT value FROM json_each(?))').run(list)
}

/**
 * Writes the list into a ledger's copy, keeping each category's on/off (`archived`: when it was
 * turned off, or null; categories not in it are new, so on).
 */
function write(sqlite: SQLite, catalog: Catalog, archived: Map<number, string | null>) {
  const upsertGroup = sqlite.prepare(
    `INSERT INTO category_groups (id, name, color, sort) VALUES (@id, @name, @color, @sort)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color, sort = excluded.sort`,
  )
  for (const g of catalog.groups) upsertGroup.run(g)
  const upsertCategory = sqlite.prepare(
    `INSERT INTO categories (id, group_id, name, is_income, exclude_from_totals, sort, archived_at)
     VALUES (@id, @groupId, @name, @isIncome, @excludeFromTotals, @sort, @archivedAt)
     ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, name = excluded.name, is_income = excluded.is_income,
       exclude_from_totals = excluded.exclude_from_totals, sort = excluded.sort`,
  )
  for (const c of catalog.categories) upsertCategory.run({ ...c, archivedAt: archived.get(c.id) ?? null })
  const groupIds = JSON.stringify(catalog.groups.map((g) => g.id))
  sqlite.prepare('DELETE FROM category_groups WHERE id NOT IN (SELECT value FROM json_each(?))').run(groupIds)
  // Labels have nothing pointing at them but category_labels, so they're simply rewritten.
  sqlite.exec('DELETE FROM category_labels; DELETE FROM labels')
  const insertLabel = sqlite.prepare('INSERT INTO labels (id, name, color, sort) VALUES (@id, @name, @color, @sort)')
  for (const l of catalog.labels) insertLabel.run(l)
  const link = sqlite.prepare('INSERT INTO category_labels (category_id, label_id) VALUES (@categoryId, @labelId)')
  for (const l of catalog.links) link.run(l)
}
