import { HTTPException } from 'hono/http-exception'
import { unusedColor, type Category, type CategoryCreate, type CategoryGroup, type CategoryList, type CategoryMergeResult, type CategoryUpdate, type Tag, type TagWithCount } from '@chipmunk/shared'
import { badRequest, notFound } from '../lib/http'
import { requireOwnList, usesSharedList } from './catalog'
import type { AppContext } from './context'
import { remapCategoryRefs } from './custom-reports'
import { labelIdsByCategory, listLabels, setCategoryLabels } from './labels'

/**
 * A ledger's categories: the list it uses (the shared one, or its own), read through the
 * ledger_categories and ledger_category_groups views. A ledger on the shared list only turns its
 * categories on and off here (ledger_category_off); one with its own list edits it here too.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

interface CategoryRow {
  id: number
  groupId: number | null
  name: string
  isIncome: number
  excludeFromTotals: number
  archivedAt: string | null
  sort: number
}

const CATEGORY_COLUMNS =
  'c.id, c.group_id AS groupId, c.name, c.is_income AS isIncome, c.exclude_from_totals AS excludeFromTotals, c.archived_at AS archivedAt, c.sort'

export function categoryDTO(r: CategoryRow, labelIds: number[] = [], transactionCount?: number): Category {
  return {
    id: r.id,
    groupId: r.groupId,
    name: r.name,
    isIncome: !!r.isIncome,
    excludeFromTotals: !!r.excludeFromTotals,
    labelIds,
    archived: !!r.archivedAt,
    sort: r.sort,
    ...(transactionCount === undefined ? {} : { transactionCount }),
  }
}

export function listCategories(ctx: AppContext): CategoryList {
  const groups = ctx.q.all<CategoryGroup>('SELECT id, name, color, sort FROM ledger_category_groups WHERE ledger_id = @ledger ORDER BY sort, id')
  const labelled = labelIdsByCategory(ctx)
  const used = new Map(
    ctx.q
      .all<{ id: number; n: number }>(
        `SELECT category_id AS id, count(*) AS n FROM transactions
         WHERE ledger_id = @ledger AND deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id`,
      )
      .map((r) => [r.id, r.n]),
  )
  const cats = ctx.q
    .all<CategoryRow>(`SELECT ${CATEGORY_COLUMNS} FROM ledger_categories c WHERE c.ledger_id = @ledger ORDER BY c.sort, c.id`)
    .map((r) => categoryDTO(r, labelled.get(r.id), used.get(r.id) ?? 0))
  return { groups, categories: cats, labels: listLabels(ctx) }
}

export function getCategory(ctx: AppContext, id: number): Category {
  const row = ctx.q.mustGet<CategoryRow>(`SELECT ${CATEGORY_COLUMNS} FROM ledger_categories c WHERE c.ledger_id = @ledger AND c.id = @id`, 'Category not found', { id })
  return categoryDTO(row, labelIdsByCategory(ctx, id).get(id))
}

/** A group of the ledger's own list, for a category to be in (404 otherwise). */
function requireGroup(ctx: AppContext, groupId: number | null | undefined) {
  if (groupId !== undefined && groupId !== null) getGroup(ctx, groupId)
}

/** A category in the ledger's own list. */
export function createCategory(ctx: AppContext, input: Required<Pick<CategoryCreate, 'name'>> & CategoryCreate) {
  requireOwnList(ctx)
  const groupId = input.groupId ?? null
  requireGroup(ctx, groupId)
  const id = ctx.q.transaction(() => {
    const sort = ctx.q.pluck<number>('SELECT coalesce(max(sort), -1) + 1 FROM categories WHERE ledger_id = @ledger AND group_id IS @groupId', { groupId })!
    const id = Number(
      ctx.q.run(
        `INSERT INTO categories (ledger_id, group_id, name, is_income, exclude_from_totals, sort)
         VALUES (@ledger, @groupId, @name, @isIncome, @excludeFromTotals, @sort)`,
        { groupId, name: input.name, isIncome: input.isIncome ? 1 : 0, excludeFromTotals: input.excludeFromTotals ? 1 : 0, sort },
      ).lastInsertRowid,
    )
    if (input.labelIds?.length) setCategoryLabels(ctx, id, input.labelIds)
    return id
  })
  return getCategory(ctx, id)
}

/** Changes a category of the ledger's own list (`archived`: whether it's off). */
export function updateCategory(ctx: AppContext, id: number, input: CategoryUpdate & { archived?: boolean }) {
  requireOwnList(ctx)
  getCategory(ctx, id)
  const { archived, labelIds, ...rest } = input
  requireGroup(ctx, rest.groupId)
  const columns = { name: 'name', groupId: 'group_id', isIncome: 'is_income', excludeFromTotals: 'exclude_from_totals', sort: 'sort' } as const
  const values: Record<string, unknown> = {}
  const sets: string[] = []
  for (const [key, column] of Object.entries(columns) as Array<[keyof typeof columns, string]>) {
    const value = rest[key]
    if (value === undefined) continue
    sets.push(`${column} = @${key}`)
    values[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value
  }
  if (archived !== undefined) {
    sets.push('archived_at = @archivedAt')
    values.archivedAt = archived ? ctx.now().toISOString() : null
  }
  ctx.q.transaction(() => {
    if (labelIds) setCategoryLabels(ctx, id, labelIds)
    ctx.q.run(`UPDATE categories SET ${[...sets, `updated_at = ${NOW}`].join(', ')} WHERE ledger_id = @ledger AND id = @id`, { ...values, id })
  })
  return getCategory(ctx, id)
}

/** Deletes a category of the ledger's own list. */
export function deleteCategory(ctx: AppContext, id: number) {
  requireOwnList(ctx)
  getCategory(ctx, id)
  // Transactions keep existing but become uncategorized (FK is ON DELETE SET NULL).
  ctx.q.run('DELETE FROM categories WHERE ledger_id = @ledger AND id = @id', { id })
}

/** Turns a category on or off for this ledger: in ledger_category_off for a shared one, its archived_at for its own. */
function setArchived(ctx: AppContext, id: number, archived: boolean) {
  if (usesSharedList(ctx)) {
    if (archived) {
      ctx.q.run(
        `INSERT INTO ledger_category_off (ledger_id, category_id, archived_at) VALUES (@ledger, @id, ${NOW})
         ON CONFLICT (ledger_id, category_id) DO NOTHING`,
        { id },
      )
    } else {
      ctx.q.run('DELETE FROM ledger_category_off WHERE ledger_id = @ledger AND category_id = @id', { id })
    }
  } else {
    ctx.q.run(`UPDATE categories SET archived_at = ${archived ? NOW : 'NULL'}, updated_at = ${NOW} WHERE ledger_id = @ledger AND id = @id`, { id })
  }
}

/**
 * Turns a category on or off in this ledger (the shared list says what categories there are). One
 * that's off isn't offered when you categorize. Turning off one that transactions use needs
 * `moveTo`: another category for them (and its recurring payments), or null to leave them
 * uncategorized.
 */
export function setCategoryEnabled(
  ctx: AppContext,
  id: number,
  input: { enabled: boolean; moveTo?: number | null },
): { category: Category; moved: number; reports: number } {
  const before = getCategory(ctx, id)
  let moved = 0
  let reports = 0
  if (!input.enabled && !before.archived) {
    const used = ctx.q.pluck<number>('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND category_id = @id AND deleted_at IS NULL', { id })!
    if (used && input.moveTo === undefined) {
      throw new HTTPException(409, { message: `${used} transaction${used === 1 ? ' uses' : 's use'} ${before.name}. Choose another category for them, or leave them uncategorized.` })
    }
    if (input.moveTo !== undefined && input.moveTo !== null) {
      const target = getCategory(ctx, input.moveTo)
      if (target.id === id) badRequest('Choose a different category.')
      if (target.archived) badRequest(`${target.name} is off in this ledger. Turn it on first.`)
    }
    moved = used
    ctx.q.transaction(() => {
      if (input.moveTo) {
        reports = moveCategoryUsage(ctx, id, input.moveTo).reports
      } else {
        ctx.q.run(
          `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0,
             updated_at = ${NOW} WHERE ledger_id = @ledger AND category_id = @id`,
          { id },
        )
        ctx.q.run('UPDATE recurring_items SET category_id = NULL WHERE ledger_id = @ledger AND category_id = @id', { id })
        ctx.q.run('DELETE FROM payee_category_stats WHERE ledger_id = @ledger AND category_id = @id', { id })
        ctx.q.run('DELETE FROM payee_rules WHERE ledger_id = @ledger AND category_id = @id', { id })
      }
      setArchived(ctx, id, true)
    })
  } else if (input.enabled && before.archived) {
    setArchived(ctx, id, false)
  }
  return { category: getCategory(ctx, id), moved, reports }
}

/**
 * Moves what uses a category in this ledger to another: its transactions (deleted ones too, so a
 * restore lands in the right place), recurring payments, what the app learned about payees, and
 * custom reports. Merging a shared category does this in every ledger on the list.
 */
export function moveCategoryUsage(ctx: AppContext, id: number, into: number) {
  return ctx.q.transaction(() => {
    const ids = { id, into }
    const transactions = ctx.q.pluck<number>('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND category_id = @id AND deleted_at IS NULL', { id })!
    ctx.q.run(`UPDATE transactions SET category_id = @into, updated_at = ${NOW} WHERE ledger_id = @ledger AND category_id = @id`, ids)
    const recurring = ctx.q.run('UPDATE recurring_items SET category_id = @into WHERE ledger_id = @ledger AND category_id = @id', ids).changes
    // Payees learned for this category now suggest the other one.
    ctx.q.run(
      `INSERT INTO payee_category_stats (ledger_id, payee_key, direction, category_id, count, last_used_at)
       SELECT s.ledger_id, s.payee_key, s.direction, @into, s.count, s.last_used_at FROM payee_category_stats s
       WHERE s.ledger_id = @ledger AND s.category_id = @id
       ON CONFLICT (ledger_id, payee_key, direction, category_id) DO UPDATE SET count = count + excluded.count, last_used_at = max(last_used_at, excluded.last_used_at)`,
      ids,
    )
    ctx.q.run('DELETE FROM payee_category_stats WHERE ledger_id = @ledger AND category_id = @id', ids)
    // Payees always set to it are always set to the other one.
    ctx.q.run('UPDATE payee_rules SET category_id = @into WHERE ledger_id = @ledger AND category_id = @id', ids)
    const reports = remapCategoryRefs(ctx, id, into)
    return { transactions, recurring, reports }
  })
}

/**
 * Merges a category of the ledger's own list into another: its transactions (deleted ones too, so
 * a restore lands in the right place), recurring payments, what the app learned about payees and
 * custom reports move over, then it's deleted. The other category keeps its own name, group and
 * labels. (Shared categories are merged in App settings, for every ledger: mergeCatalogCategory.)
 */
export function mergeCategory(ctx: AppContext, id: number, into: number): CategoryMergeResult & { from: Category; reports: number } {
  requireOwnList(ctx)
  const from = getCategory(ctx, id)
  getCategory(ctx, into)
  if (from.id === into) badRequest('Choose a different category to merge into.')
  const counts = ctx.q.transaction(() => {
    const moved = moveCategoryUsage(ctx, id, into)
    ctx.q.run('DELETE FROM categories WHERE ledger_id = @ledger AND id = @id', { id })
    return moved
  })
  return { from, into: getCategory(ctx, into), ...counts }
}

/** A new group in the ledger's own list; without a colour it gets one no other group has yet. */
export function createGroup(ctx: AppContext, input: { name: string; color?: string }): CategoryGroup {
  requireOwnList(ctx)
  const id = ctx.q.transaction(() => {
    const sort = ctx.q.pluck<number>('SELECT coalesce(max(sort), -1) + 1 FROM category_groups WHERE ledger_id = @ledger')!
    const color = input.color ?? unusedColor(ctx.q.column<string>('SELECT color FROM category_groups WHERE ledger_id = @ledger'))
    return Number(
      ctx.q.run('INSERT INTO category_groups (ledger_id, name, color, sort) VALUES (@ledger, @name, @color, @sort)', { name: input.name, color, sort })
        .lastInsertRowid,
    )
  })
  return getGroup(ctx, id)
}

export function updateGroup(ctx: AppContext, id: number, input: { name?: string; color?: string; sort?: number }) {
  requireOwnList(ctx)
  const g = getGroup(ctx, id)
  ctx.q.run(`UPDATE category_groups SET name = @name, color = @color, sort = @sort, updated_at = ${NOW} WHERE ledger_id = @ledger AND id = @id`, {
    id,
    name: input.name ?? g.name,
    color: input.color ?? g.color,
    sort: input.sort ?? g.sort,
  })
  return getGroup(ctx, id)
}

export function getGroup(ctx: AppContext, id: number): CategoryGroup {
  return ctx.q.mustGet<CategoryGroup>('SELECT id, name, color, sort FROM ledger_category_groups WHERE ledger_id = @ledger AND id = @id', 'Group not found', { id })
}

/** Deletes a group of the ledger's own list with its categories (their transactions become uncategorized). Returns the categories it deleted. */
export function deleteGroup(ctx: AppContext, id: number): Category[] {
  requireOwnList(ctx)
  getGroup(ctx, id)
  const labelled = labelIdsByCategory(ctx)
  const removed = ctx.q
    .all<CategoryRow>(`SELECT ${CATEGORY_COLUMNS} FROM categories c WHERE c.ledger_id = @ledger AND c.group_id = @id ORDER BY c.sort, c.id`, { id })
    .map((r) => categoryDTO(r, labelled.get(r.id)))
  ctx.q.transaction(() => {
    ctx.q.run('DELETE FROM categories WHERE ledger_id = @ledger AND group_id = @id', { id })
    ctx.q.run('DELETE FROM category_groups WHERE ledger_id = @ledger AND id = @id', { id })
  })
  return removed
}

/** Where reorder reads a table's ids (accounts through their view). */
const REORDER_SOURCE = { accounts: 'ledger_accounts', institutions: 'institutions', categories: 'categories', category_groups: 'category_groups' } as const

/**
 * Sets `sort` from the order of `ids` (first = 0). Ids not listed keep their place after the
 * listed ones. Shared by accounts, institutions, and the categories and groups of a ledger's own list.
 */
export function reorder(ctx: AppContext, table: keyof typeof REORDER_SOURCE, ids: number[]) {
  if (table === 'categories' || table === 'category_groups') requireOwnList(ctx)
  const source = REORDER_SOURCE[table]
  ctx.q.transaction(() => {
    const known = new Set(ctx.q.column<number>(`SELECT id FROM ${source} WHERE ledger_id = @ledger`))
    const missing = ids.filter((id) => !known.has(id))
    if (missing.length) notFound(`Not found: ${missing.join(', ')}`)
    const set = (sort: number, id: number) => ctx.q.run(`UPDATE ${table} SET sort = @sort WHERE ledger_id = @ledger AND id = @id`, { sort, id })
    ids.forEach((id, i) => set(i, id))
    const rest = ctx.q.column<number>(`SELECT id FROM ${source} WHERE ledger_id = @ledger AND id NOT IN (SELECT value FROM json_each(@ids)) ORDER BY sort, id`, {
      ids: JSON.stringify(ids),
    })
    rest.forEach((id, i) => set(ids.length + i, id))
  })
}

// Tags --------------------------------------------------------------------

export function listTags(ctx: AppContext): TagWithCount[] {
  return ctx.q.all<TagWithCount>(
    `SELECT t.id, t.name, t.color,
       (SELECT count(*) FROM transaction_tags tt JOIN transactions x ON x.id = tt.transaction_id
        WHERE tt.tag_id = t.id AND x.ledger_id = t.ledger_id AND x.deleted_at IS NULL) AS count
     FROM tags t WHERE t.ledger_id = @ledger ORDER BY t.name`,
  )
}

export function normalizeTagName(name: string) {
  return name.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')
}

/** Returns tag ids for the given names, creating any that don't exist yet. */
export function upsertTags(ctx: AppContext, names: string[]): number[] {
  const clean = [...new Set(names.map(normalizeTagName).filter(Boolean))]
  if (!clean.length) return []
  return ctx.q.transaction(() => {
    for (const name of clean) ctx.q.run('INSERT INTO tags (ledger_id, name) VALUES (@ledger, @name) ON CONFLICT DO NOTHING', { name })
    return ctx.q.column<number>('SELECT id FROM tags WHERE ledger_id = @ledger AND name IN (SELECT value FROM json_each(@names)) ORDER BY name', {
      names: JSON.stringify(clean),
    })
  })
}

const TAG_SQL = 'SELECT id, name, color FROM tags WHERE ledger_id = @ledger AND id = @id'

export function getTag(ctx: AppContext, id: number): Tag {
  return ctx.q.mustGet<Tag>(TAG_SQL, 'Tag not found', { id })
}

export function createTag(ctx: AppContext, name: string, color?: string | null): Tag {
  const [id] = upsertTags(ctx, [name])
  if (color !== undefined) ctx.q.run('UPDATE tags SET color = @color WHERE ledger_id = @ledger AND id = @id', { id, color })
  return getTag(ctx, id!)
}

export function updateTag(ctx: AppContext, id: number, input: { name?: string; color?: string | null }) {
  getTag(ctx, id)
  const sets: string[] = []
  const values: Record<string, unknown> = { id }
  if (input.name !== undefined) {
    sets.push('name = @name')
    values.name = input.name ? normalizeTagName(input.name) : input.name
  }
  if (input.color !== undefined) {
    sets.push('color = @color')
    values.color = input.color
  }
  if (sets.length) ctx.q.run(`UPDATE tags SET ${sets.join(', ')} WHERE ledger_id = @ledger AND id = @id`, values)
  return getTag(ctx, id)
}

export function deleteTag(ctx: AppContext, id: number) {
  getTag(ctx, id)
  ctx.q.transaction(() => {
    ctx.q.run('DELETE FROM transaction_tags WHERE tag_id = @id AND tag_id IN (SELECT id FROM tags WHERE ledger_id = @ledger)', { id })
    ctx.q.run('DELETE FROM tags WHERE ledger_id = @ledger AND id = @id', { id })
  })
}
