import { HTTPException } from 'hono/http-exception'
import { unusedColor, type Category, type CategoryGroup, type CategoryList, type CategoryMergeResult, type Label } from '@chipmunk/shared'
import { badRequest, notFound } from '../lib/http'
import type { Storage } from '../storage'
import { onSharedList, readCatalog, usesSharedList, type Catalog, type SharedList } from './catalog'
import { moveCategoryUsage } from './categories'

/**
 * Changes to the shared category list (App settings → Categories). The list is one set of rows
 * every ledger on it reads, so each change is one write that every such ledger sees at once.
 * Deleting or merging a category also deals with its transactions in each ledger, in the same
 * transaction. The routes log each change in every ledger's activity.
 */

const bool = (v: number) => !!v

function categoryDTO(catalog: Catalog, c: Catalog['categories'][number]): Category {
  return {
    id: c.id,
    groupId: c.groupId,
    name: c.name,
    isIncome: bool(c.isIncome),
    excludeFromTotals: bool(c.excludeFromTotals),
    labelIds: catalog.links.filter((l) => l.categoryId === c.id).map((l) => l.labelId),
    archived: false,
    sort: c.sort,
  }
}

/** How many transactions use each shared category, across the ledgers that use the shared list (and `canUse`). */
export function catalogUsage(storage: Storage, canUse: (ledgerId: string) => boolean = () => true): Map<number, number> {
  const used = new Map<number, number>()
  for (const l of storage.registry.list().filter((x) => canUse(x.id))) {
    const ctx = storage.registry.context(l.id)
    if (!usesSharedList(ctx)) continue
    const rows = ctx.q.all<{ id: number; n: number }>(
      `SELECT category_id AS id, count(*) AS n FROM transactions
       WHERE ledger_id = @ledger AND deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id`,
    )
    for (const r of rows) used.set(r.id, (used.get(r.id) ?? 0) + r.n)
  }
  return used
}

/** The shared list; with `usage`, how many transactions use each category across the ledgers that share it. */
export function listCatalog(storage: Storage, usage?: Map<number, number>): CategoryList {
  const catalog = onSharedList(storage, readCatalog)
  return {
    groups: catalog.groups,
    categories: catalog.categories.map((c) => ({ ...categoryDTO(catalog, c), ...(usage ? { transactionCount: usage.get(c.id) ?? 0 } : {}) })),
    labels: catalog.labels.map((l) => ({ ...l, categoryCount: catalog.links.filter((x) => x.labelId === l.id).length })),
  }
}

function categoryIn(db: SharedList, id: number): Category {
  const catalog = readCatalog(db)
  const c = catalog.categories.find((x) => x.id === id)
  if (!c) notFound('Category not found')
  return categoryDTO(catalog, c)
}

function groupIn(db: SharedList, id: number): CategoryGroup {
  const g = db.get<CategoryGroup>('SELECT id, name, color, sort FROM category_groups WHERE ledger_id IS NULL AND id = ?', id)
  if (!g) notFound('Group not found')
  return g
}

function labelIn(db: SharedList, id: number): Label {
  const l = db.get<Label>(
    `SELECT l.id, l.name, l.color, l.sort, (SELECT count(*) FROM category_labels cl WHERE cl.label_id = l.id) AS categoryCount
     FROM labels l WHERE l.ledger_id IS NULL AND l.id = ?`,
    id,
  )
  if (!l) notFound('Label not found')
  return l
}

export function getCatalogCategory(storage: Storage, id: number): Category {
  return onSharedList(storage, (db) => categoryIn(db, id))
}

export function getCatalogGroup(storage: Storage, id: number): CategoryGroup {
  return onSharedList(storage, (db) => groupIn(db, id))
}

export function getCatalogLabel(storage: Storage, id: number): Label {
  return onSharedList(storage, (db) => labelIn(db, id))
}

/** Runs fn on the shared list in one transaction. */
const edit = <T>(storage: Storage, fn: (db: SharedList) => T): T => onSharedList(storage, (db) => db.transaction(() => fn(db)))

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const TABLES = { categories: 'categories', category_groups: 'category_groups', labels: 'labels' } as const

/** The next `sort` in a table of the shared list (among the rows `where` picks). */
const nextSort = (db: SharedList, table: keyof typeof TABLES, where = '1 = 1', ...params: unknown[]) =>
  db.pluck<number>(`SELECT coalesce(max(sort), -1) + 1 FROM ${TABLES[table]} WHERE ledger_id IS NULL AND ${where}`, ...params) ?? 0

function setLabels(db: SharedList, categoryId: number, labelIds: number[]) {
  const known = new Set(readCatalog(db).labels.map((l) => l.id))
  const missing = labelIds.filter((id) => !known.has(id))
  if (missing.length) badRequest(`No such label: ${missing.join(', ')}`)
  db.run('DELETE FROM category_labels WHERE category_id = ?', categoryId)
  for (const id of new Set(labelIds)) db.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)', categoryId, id)
}

/**
 * Shared categories that are going: in every ledger, their transactions become uncategorized (and
 * no longer say a rule, AI or a link categorized them, or that they need review), and their
 * recurring payments lose them. Then they're deleted.
 */
function forget(db: SharedList, ids: number[]) {
  if (!ids.length) return
  const list = JSON.stringify(ids)
  db.run(
    `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0
     WHERE category_id IN (SELECT value FROM json_each(?))`,
    list,
  )
  db.run('UPDATE recurring_items SET category_id = NULL WHERE category_id IN (SELECT value FROM json_each(?))', list)
  db.run('DELETE FROM categories WHERE ledger_id IS NULL AND id IN (SELECT value FROM json_each(?))', list)
}

// Groups ---------------------------------------------------------------------------

/** A new group; without a colour it gets one no other group has yet. */
export function createCatalogGroup(storage: Storage, input: { name: string; color?: string }): CategoryGroup {
  return edit(storage, (db) => {
    const color = input.color ?? unusedColor(readCatalog(db).groups.map((g) => g.color))
    const id = Number(db.run('INSERT INTO category_groups (name, color, sort) VALUES (?, ?, ?)', input.name, color, nextSort(db, 'category_groups')).lastInsertRowid)
    return groupIn(db, id)
  })
}

export function updateCatalogGroup(storage: Storage, id: number, input: { name?: string; color?: string; sort?: number }): CategoryGroup {
  return edit(storage, (db) => {
    const g = groupIn(db, id)
    db.run(
      `UPDATE category_groups SET name = ?, color = ?, sort = ?, updated_at = ${NOW} WHERE ledger_id IS NULL AND id = ?`,
      input.name ?? g.name,
      input.color ?? g.color,
      input.sort ?? g.sort,
      id,
    )
    return groupIn(db, id)
  })
}

/** Deletes a group with its categories: in every ledger, their transactions become uncategorized. */
export function deleteCatalogGroup(storage: Storage, id: number): Category[] {
  return edit(storage, (db) => {
    groupIn(db, id)
    const catalog = readCatalog(db)
    const removed = catalog.categories.filter((c) => c.groupId === id)
    forget(
      db,
      removed.map((c) => c.id),
    )
    db.run('DELETE FROM category_groups WHERE ledger_id IS NULL AND id = ?', id)
    return removed.map((c) => categoryDTO(catalog, c))
  })
}

// Categories -----------------------------------------------------------------------

/** A new shared category: on in every ledger that uses the list. */
export function createCatalogCategory(
  storage: Storage,
  input: { name: string; groupId?: number | null; isIncome?: boolean; excludeFromTotals?: boolean; labelIds?: number[] },
): Category {
  return edit(storage, (db) => {
    const groupId = input.groupId ?? null
    if (groupId !== null) groupIn(db, groupId)
    const id = Number(
      db.run(
        'INSERT INTO categories (group_id, name, is_income, exclude_from_totals, sort) VALUES (?, ?, ?, ?, ?)',
        groupId,
        input.name,
        input.isIncome ? 1 : 0,
        input.excludeFromTotals ? 1 : 0,
        nextSort(db, 'categories', 'group_id IS ?', groupId),
      ).lastInsertRowid,
    )
    if (input.labelIds?.length) setLabels(db, id, input.labelIds)
    return categoryIn(db, id)
  })
}

export function updateCatalogCategory(
  storage: Storage,
  id: number,
  input: { name?: string; groupId?: number | null; isIncome?: boolean; excludeFromTotals?: boolean; labelIds?: number[]; sort?: number },
): Category {
  return edit(storage, (db) => {
    const c = categoryIn(db, id)
    if (input.groupId) groupIn(db, input.groupId)
    db.run(
      `UPDATE categories SET name = ?, group_id = ?, is_income = ?, exclude_from_totals = ?, sort = ?, updated_at = ${NOW} WHERE ledger_id IS NULL AND id = ?`,
      input.name ?? c.name,
      input.groupId === undefined ? c.groupId : input.groupId,
      (input.isIncome ?? c.isIncome) ? 1 : 0,
      (input.excludeFromTotals ?? c.excludeFromTotals) ? 1 : 0,
      input.sort ?? c.sort,
      id,
    )
    if (input.labelIds) setLabels(db, id, input.labelIds)
    return categoryIn(db, id)
  })
}

/** Deletes a category: in every ledger, its transactions become uncategorized. */
export function deleteCatalogCategory(storage: Storage, id: number): Category {
  return edit(storage, (db) => {
    const c = categoryIn(db, id)
    forget(db, [id])
    return c
  })
}

/**
 * Merges a category into another in every ledger that uses the shared list: its transactions,
 * recurring payments, what the app learned about payees and custom reports move over, then it's
 * deleted. Where it was on, the other one is turned on too.
 */
export function mergeCatalogCategory(
  storage: Storage,
  id: number,
  into: number,
): CategoryMergeResult & { from: Category; reports: number } {
  return edit(storage, (db) => {
    const from = categoryIn(db, id)
    categoryIn(db, into)
    if (id === into) badRequest('Choose a different category to merge into.')
    let transactions = 0
    let recurring = 0
    let reports = 0
    for (const l of storage.registry.list()) {
      const ctx = storage.registry.context(l.id)
      if (!usesSharedList(ctx)) continue
      const wasOn = !ctx.q.pluck('SELECT 1 FROM ledger_category_off WHERE ledger_id = @ledger AND category_id = @id', { id })
      const r = moveCategoryUsage(ctx, id, into)
      if (wasOn) ctx.q.run('DELETE FROM ledger_category_off WHERE ledger_id = @ledger AND category_id = @into', { into })
      transactions += r.transactions
      recurring += r.recurring
      reports += r.reports
    }
    // Nothing uses it now; its off state and labels go with it.
    db.run('DELETE FROM categories WHERE ledger_id IS NULL AND id = ?', id)
    return { from, into: categoryIn(db, into), transactions, recurring, reports }
  })
}

/** Sets `sort` from the order of `ids` (first = 0); ones not listed keep their place after them. */
export function reorderCatalog(storage: Storage, table: 'categories' | 'category_groups' | 'labels', ids: number[]) {
  const name = TABLES[table]
  edit(storage, (db) => {
    const known = new Set(db.all<{ id: number }>(`SELECT id FROM ${name} WHERE ledger_id IS NULL`).map((r) => r.id))
    const missing = ids.filter((id) => !known.has(id))
    if (missing.length) notFound(`Not found: ${missing.join(', ')}`)
    const set = (sort: number, id: number) => db.run(`UPDATE ${name} SET sort = ? WHERE ledger_id IS NULL AND id = ?`, sort, id)
    ids.forEach((id, i) => set(i, id))
    const rest = db
      .all<{ id: number }>(`SELECT id FROM ${name} WHERE ledger_id IS NULL AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY sort, id`, JSON.stringify(ids))
      .map((r) => r.id)
    rest.forEach((id, i) => set(ids.length + i, id))
  })
}

// Labels ---------------------------------------------------------------------------

function clashing(db: SharedList, name: string, except?: number) {
  const clash = readCatalog(db).labels.find((l) => l.id !== except && l.name.toLowerCase() === name.toLowerCase())
  if (clash) throw new HTTPException(409, { message: `There’s already a label called “${clash.name}”.` })
}

export function createCatalogLabel(storage: Storage, input: { name: string; color?: string }): Label {
  return edit(storage, (db) => {
    clashing(db, input.name)
    const color = input.color ?? unusedColor(readCatalog(db).labels.map((l) => l.color))
    const id = Number(db.run('INSERT INTO labels (name, color, sort) VALUES (?, ?, ?)', input.name, color, nextSort(db, 'labels')).lastInsertRowid)
    return labelIn(db, id)
  })
}

export function updateCatalogLabel(storage: Storage, id: number, input: { name?: string; color?: string; sort?: number }): Label {
  return edit(storage, (db) => {
    const l = labelIn(db, id)
    if (input.name) clashing(db, input.name, id)
    db.run(
      `UPDATE labels SET name = ?, color = ?, sort = ?, updated_at = ${NOW} WHERE ledger_id IS NULL AND id = ?`,
      input.name ?? l.name,
      input.color ?? l.color,
      input.sort ?? l.sort,
      id,
    )
    return labelIn(db, id)
  })
}

export function deleteCatalogLabel(storage: Storage, id: number): Label {
  return edit(storage, (db) => {
    const l = labelIn(db, id)
    db.run('DELETE FROM labels WHERE ledger_id IS NULL AND id = ?', id)
    return l
  })
}

/** Puts a label on some categories and takes it off others. */
export function applyCatalogLabel(storage: Storage, id: number, input: { add: number[]; remove: number[] }): Label {
  return edit(storage, (db) => {
    labelIn(db, id)
    const known = new Set(readCatalog(db).categories.map((c) => c.id))
    const missing = [...input.add, ...input.remove].filter((c) => !known.has(c))
    if (missing.length) notFound(`No such category: ${missing.join(', ')}`)
    for (const c of input.add) db.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?) ON CONFLICT DO NOTHING', c, id)
    for (const c of input.remove) db.run('DELETE FROM category_labels WHERE category_id = ? AND label_id = ?', c, id)
    return labelIn(db, id)
  })
}
