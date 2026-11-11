import { HTTPException } from 'hono/http-exception'
import { unusedColor, type Category, type CategoryGroup, type CategoryList, type CategoryMergeResult, type Label } from '@chipmunk/shared'
import { badRequest, notFound } from '../lib/http'
import type { Storage } from '../storage'
import { readCatalog, syncLedgerCategories, touchCatalog, usesSharedList, type Catalog } from './catalog'
import { mergeCategory } from './categories'
import type { MetaStore } from './context'

/**
 * Changes to the shared category list (App settings → Categories). Each one is copied into every
 * ledger afterwards; deleting or merging a category first deals with its transactions in each.
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

/** How many transactions use each shared category, across the ledgers that use the shared list. */
export function catalogUsage(storage: Storage, canUse: (ledgerId: string) => boolean = () => true): Map<number, number> {
  const used = new Map<number, number>()
  for (const l of storage.registry.list().filter((x) => canUse(x.id))) {
    const { sqlite } = storage.registry.context(l.id)
    if (!usesSharedList(sqlite)) continue
    const rows = sqlite
      .prepare('SELECT category_id AS id, count(*) AS n FROM transactions WHERE deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id')
      .all() as Array<{ id: number; n: number }>
    for (const r of rows) used.set(r.id, (used.get(r.id) ?? 0) + r.n)
  }
  return used
}

/** The shared list; with `usage`, how many transactions use each category across the ledgers that share it. */
export function listCatalog(meta: MetaStore, usage?: Map<number, number>): CategoryList {
  const catalog = readCatalog(meta)
  return {
    groups: catalog.groups,
    categories: catalog.categories.map((c) => ({ ...categoryDTO(catalog, c), ...(usage ? { transactionCount: usage.get(c.id) ?? 0 } : {}) })),
    labels: catalog.labels.map((l) => ({ ...l, categoryCount: catalog.links.filter((x) => x.labelId === l.id).length })),
  }
}

export function getCatalogCategory(meta: MetaStore, id: number): Category {
  const catalog = readCatalog(meta)
  const c = catalog.categories.find((x) => x.id === id)
  if (!c) notFound('Category not found')
  return categoryDTO(catalog, c)
}

export function getCatalogGroup(meta: MetaStore, id: number): CategoryGroup {
  const g = readCatalog(meta).groups.find((x) => x.id === id)
  if (!g) notFound('Group not found')
  return g
}

export function getCatalogLabel(meta: MetaStore, id: number): Label {
  const l = listCatalog(meta).labels.find((x) => x.id === id)
  if (!l) notFound('Label not found')
  return l
}

/** After a change to the list: copies it into every ledger that uses it (archived ones too). */
export function syncAllLedgers(storage: Storage) {
  touchCatalog(storage.meta)
  for (const l of storage.registry.list()) syncLedgerCategories(storage.meta, storage.registry.context(l.id).sqlite)
}

const nextSort = (meta: MetaStore, table: string, where = '1 = 1', ...params: unknown[]) =>
  (meta.sqlite.prepare(`SELECT coalesce(max(sort), -1) + 1 FROM ${table} WHERE ${where}`).pluck().get(...params) as number) ?? 0

function setLabels(meta: MetaStore, categoryId: number, labelIds: number[]) {
  const known = new Set(readCatalog(meta).labels.map((l) => l.id))
  const missing = labelIds.filter((id) => !known.has(id))
  if (missing.length) badRequest(`No such label: ${missing.join(', ')}`)
  meta.sqlite.prepare('DELETE FROM category_labels WHERE category_id = ?').run(categoryId)
  for (const id of new Set(labelIds)) meta.sqlite.prepare('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)').run(categoryId, id)
}

// Groups ---------------------------------------------------------------------------

/** A new group; without a colour it gets one no other group has yet. */
export function createCatalogGroup(storage: Storage, input: { name: string; color?: string }): CategoryGroup {
  const { meta } = storage
  const color = input.color ?? unusedColor(readCatalog(meta).groups.map((g) => g.color))
  const id = Number(
    meta.sqlite.prepare('INSERT INTO category_groups (name, color, sort) VALUES (?, ?, ?)').run(input.name, color, nextSort(meta, 'category_groups')).lastInsertRowid,
  )
  syncAllLedgers(storage)
  return getCatalogGroup(meta, id)
}

export function updateCatalogGroup(storage: Storage, id: number, input: { name?: string; color?: string; sort?: number }): CategoryGroup {
  const { meta } = storage
  const g = getCatalogGroup(meta, id)
  meta.sqlite
    .prepare('UPDATE category_groups SET name = ?, color = ?, sort = ? WHERE id = ?')
    .run(input.name ?? g.name, input.color ?? g.color, input.sort ?? g.sort, id)
  syncAllLedgers(storage)
  return getCatalogGroup(meta, id)
}

/** Deletes a group with its categories: in every ledger, their transactions become uncategorized. */
export function deleteCatalogGroup(storage: Storage, id: number): Category[] {
  const { meta } = storage
  getCatalogGroup(meta, id)
  const catalog = readCatalog(meta)
  const removed = catalog.categories.filter((c) => c.groupId === id).map((c) => categoryDTO(catalog, c))
  meta.sqlite.transaction(() => {
    meta.sqlite.prepare('DELETE FROM categories WHERE group_id = ?').run(id)
    meta.sqlite.prepare('DELETE FROM category_groups WHERE id = ?').run(id)
  })()
  syncAllLedgers(storage)
  return removed
}

// Categories -----------------------------------------------------------------------

export function createCatalogCategory(
  storage: Storage,
  input: { name: string; groupId?: number | null; isIncome?: boolean; excludeFromTotals?: boolean; labelIds?: number[] },
): Category {
  const { meta } = storage
  const groupId = input.groupId ?? null
  if (groupId !== null) getCatalogGroup(meta, groupId)
  const id = meta.sqlite.transaction(() => {
    const id = Number(
      meta.sqlite
        .prepare('INSERT INTO categories (group_id, name, is_income, exclude_from_totals, sort) VALUES (?, ?, ?, ?, ?)')
        .run(groupId, input.name, input.isIncome ? 1 : 0, input.excludeFromTotals ? 1 : 0, nextSort(meta, 'categories', 'group_id IS ?', groupId)).lastInsertRowid,
    )
    if (input.labelIds?.length) setLabels(meta, id, input.labelIds)
    return id
  })()
  syncAllLedgers(storage)
  return getCatalogCategory(meta, id)
}

export function updateCatalogCategory(
  storage: Storage,
  id: number,
  input: { name?: string; groupId?: number | null; isIncome?: boolean; excludeFromTotals?: boolean; labelIds?: number[]; sort?: number },
): Category {
  const { meta } = storage
  const c = getCatalogCategory(meta, id)
  if (input.groupId) getCatalogGroup(meta, input.groupId)
  meta.sqlite.transaction(() => {
    meta.sqlite
      .prepare('UPDATE categories SET name = ?, group_id = ?, is_income = ?, exclude_from_totals = ?, sort = ? WHERE id = ?')
      .run(
        input.name ?? c.name,
        input.groupId === undefined ? c.groupId : input.groupId,
        (input.isIncome ?? c.isIncome) ? 1 : 0,
        (input.excludeFromTotals ?? c.excludeFromTotals) ? 1 : 0,
        input.sort ?? c.sort,
        id,
      )
    if (input.labelIds) setLabels(meta, id, input.labelIds)
  })()
  syncAllLedgers(storage)
  return getCatalogCategory(meta, id)
}

/** Deletes a category: in every ledger, its transactions become uncategorized. */
export function deleteCatalogCategory(storage: Storage, id: number): Category {
  const { meta } = storage
  const c = getCatalogCategory(meta, id)
  meta.sqlite.prepare('DELETE FROM categories WHERE id = ?').run(id)
  syncAllLedgers(storage)
  return c
}

/**
 * Merges a category into another in every ledger that uses the shared list: its transactions,
 * recurring payments and what the app learned about payees move over, then it's deleted. Where it
 * was on, the other one is turned on too.
 */
export function mergeCatalogCategory(storage: Storage, id: number, into: number): CategoryMergeResult & { from: Category; reports: number } {
  const { meta, registry } = storage
  const from = getCatalogCategory(meta, id)
  getCatalogCategory(meta, into)
  if (id === into) badRequest('Choose a different category to merge into.')
  let transactions = 0
  let recurring = 0
  let reports = 0
  for (const l of registry.list()) {
    const ctx = registry.context(l.id)
    if (!usesSharedList(ctx.sqlite)) continue
    const wasOn = !!ctx.sqlite.prepare('SELECT 1 FROM categories WHERE id = ? AND archived_at IS NULL').get(id)
    const r = mergeCategory(ctx, id, into)
    if (wasOn) ctx.sqlite.prepare('UPDATE categories SET archived_at = NULL WHERE id = ?').run(into)
    transactions += r.transactions
    recurring += r.recurring
    reports += r.reports
  }
  meta.sqlite.prepare('DELETE FROM categories WHERE id = ?').run(id)
  syncAllLedgers(storage)
  return { from, into: getCatalogCategory(meta, into), transactions, recurring, reports }
}

/** Sets `sort` from the order of `ids` (first = 0); ones not listed keep their place after them. */
export function reorderCatalog(storage: Storage, table: 'categories' | 'category_groups' | 'labels', ids: number[]) {
  const { meta } = storage
  const known = new Set(meta.sqlite.prepare(`SELECT id FROM ${table}`).pluck().all() as number[])
  const missing = ids.filter((id) => !known.has(id))
  if (missing.length) notFound(`Not found: ${missing.join(', ')}`)
  const set = meta.sqlite.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?`)
  meta.sqlite.transaction(() => {
    ids.forEach((id, i) => set.run(i, id))
    const rest = meta.sqlite
      .prepare(`SELECT id FROM ${table} WHERE id NOT IN (SELECT value FROM json_each(?)) ORDER BY sort, id`)
      .pluck()
      .all(JSON.stringify(ids)) as number[]
    rest.forEach((id, i) => set.run(ids.length + i, id))
  })()
  syncAllLedgers(storage)
}

// Labels ---------------------------------------------------------------------------

export function createCatalogLabel(storage: Storage, input: { name: string; color?: string }): Label {
  const { meta } = storage
  const catalog = readCatalog(meta)
  const clash = catalog.labels.find((l) => l.name.toLowerCase() === input.name.toLowerCase())
  if (clash) throw new HTTPException(409, { message: `There’s already a label called “${clash.name}”.` })
  const color = input.color ?? unusedColor(catalog.labels.map((l) => l.color))
  const id = Number(meta.sqlite.prepare('INSERT INTO labels (name, color, sort) VALUES (?, ?, ?)').run(input.name, color, nextSort(meta, 'labels')).lastInsertRowid)
  syncAllLedgers(storage)
  return getCatalogLabel(meta, id)
}

export function updateCatalogLabel(storage: Storage, id: number, input: { name?: string; color?: string; sort?: number }): Label {
  const { meta } = storage
  const l = getCatalogLabel(meta, id)
  const clash = input.name ? readCatalog(meta).labels.find((x) => x.id !== id && x.name.toLowerCase() === input.name!.toLowerCase()) : undefined
  if (clash) throw new HTTPException(409, { message: `There’s already a label called “${clash.name}”.` })
  meta.sqlite.prepare('UPDATE labels SET name = ?, color = ?, sort = ? WHERE id = ?').run(input.name ?? l.name, input.color ?? l.color, input.sort ?? l.sort, id)
  syncAllLedgers(storage)
  return getCatalogLabel(meta, id)
}

export function deleteCatalogLabel(storage: Storage, id: number): Label {
  const { meta } = storage
  const l = getCatalogLabel(meta, id)
  meta.sqlite.prepare('DELETE FROM labels WHERE id = ?').run(id)
  syncAllLedgers(storage)
  return l
}

/** Puts a label on some categories and takes it off others. */
export function applyCatalogLabel(storage: Storage, id: number, input: { add: number[]; remove: number[] }): Label {
  const { meta } = storage
  getCatalogLabel(meta, id)
  const known = new Set(readCatalog(meta).categories.map((c) => c.id))
  const missing = [...input.add, ...input.remove].filter((c) => !known.has(c))
  if (missing.length) notFound(`No such category: ${missing.join(', ')}`)
  meta.sqlite.transaction(() => {
    for (const c of input.add) meta.sqlite.prepare('INSERT OR IGNORE INTO category_labels (category_id, label_id) VALUES (?, ?)').run(c, id)
    for (const c of input.remove) meta.sqlite.prepare('DELETE FROM category_labels WHERE category_id = ? AND label_id = ?').run(c, id)
  })()
  syncAllLedgers(storage)
  return getCatalogLabel(meta, id)
}
