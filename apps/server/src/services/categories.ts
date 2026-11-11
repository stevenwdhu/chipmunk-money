import { asc, eq, inArray } from 'drizzle-orm'
import { unusedColor, type Category, type CategoryCreate, type CategoryGroup, type CategoryList, type CategoryMergeResult, type CategoryUpdate, type Tag, type TagWithCount } from '@chipmunk/shared'
import { categories, categoryGroups, tags, transactionTags } from '../db/schema'
import { HTTPException } from 'hono/http-exception'
import { badRequest, notFound } from '../lib/http'
import type { AppContext } from './context'
import { remapCategoryRefs } from './custom-reports'
import { labelIdsByCategory, listLabels, setCategoryLabels } from './labels'

type CategoryRow = typeof categories.$inferSelect

export function categoryDTO(r: CategoryRow, labelIds: number[] = [], transactionCount?: number): Category {
  return {
    id: r.id,
    groupId: r.groupId,
    name: r.name,
    isIncome: r.isIncome,
    excludeFromTotals: r.excludeFromTotals,
    labelIds,
    archived: !!r.archivedAt,
    sort: r.sort,
    ...(transactionCount === undefined ? {} : { transactionCount }),
  }
}

export function listCategories(ctx: AppContext): CategoryList {
  const groups = ctx.db
    .select()
    .from(categoryGroups)
    .orderBy(asc(categoryGroups.sort), asc(categoryGroups.id))
    .all()
    .map((g) => ({ id: g.id, name: g.name, color: g.color, sort: g.sort }))
  const labelled = labelIdsByCategory(ctx)
  const used = new Map(
    (
      ctx.sqlite
        .prepare('SELECT category_id AS id, count(*) AS n FROM transactions WHERE deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id')
        .all() as Array<{ id: number; n: number }>
    ).map((r) => [r.id, r.n]),
  )
  const cats = ctx.db
    .select()
    .from(categories)
    .orderBy(asc(categories.sort), asc(categories.id))
    .all()
    .map((r) => categoryDTO(r, labelled.get(r.id), used.get(r.id) ?? 0))
  return { groups, categories: cats, labels: listLabels(ctx) }
}

export function getCategory(ctx: AppContext, id: number): Category {
  const row = ctx.db.select().from(categories).where(eq(categories.id, id)).get()
  if (!row) notFound('Category not found')
  return categoryDTO(row, labelIdsByCategory(ctx, id).get(id))
}

export function createCategory(ctx: AppContext, input: Required<Pick<CategoryCreate, 'name'>> & CategoryCreate) {
  const maxSort = ctx.sqlite
    .prepare('SELECT coalesce(max(sort), -1) AS m FROM categories WHERE group_id IS ?')
    .get(input.groupId ?? null) as { m: number }
  const row = ctx.db
    .insert(categories)
    .values({
      name: input.name,
      groupId: input.groupId ?? null,
      isIncome: input.isIncome ?? false,
      excludeFromTotals: input.excludeFromTotals ?? false,
      sort: maxSort.m + 1,
    })
    .returning()
    .get()
  if (input.labelIds?.length) setCategoryLabels(ctx, row.id, input.labelIds)
  return getCategory(ctx, row.id)
}

export function updateCategory(ctx: AppContext, id: number, input: CategoryUpdate & { archived?: boolean }) {
  getCategory(ctx, id)
  const { archived, labelIds, ...rest } = input
  if (labelIds) setCategoryLabels(ctx, id, labelIds)
  ctx.db
    .update(categories)
    .set({
      ...rest,
      ...(archived === undefined ? {} : { archivedAt: archived ? new Date().toISOString() : null }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(categories.id, id))
    .run()
  return getCategory(ctx, id)
}

export function deleteCategory(ctx: AppContext, id: number) {
  getCategory(ctx, id)
  // Transactions keep existing but become uncategorized (FK is ON DELETE SET NULL).
  ctx.db.delete(categories).where(eq(categories.id, id)).run()
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
    const used = ctx.sqlite.prepare('SELECT count(*) FROM transactions WHERE category_id = ? AND deleted_at IS NULL').pluck().get(id) as number
    if (used && input.moveTo === undefined) {
      throw new HTTPException(409, { message: `${used} transaction${used === 1 ? ' uses' : 's use'} ${before.name}. Choose another category for them, or leave them uncategorized.` })
    }
    if (input.moveTo !== undefined && input.moveTo !== null) {
      const target = getCategory(ctx, input.moveTo)
      if (target.id === id) badRequest('Choose a different category.')
      if (target.archived) badRequest(`${target.name} is off in this ledger. Turn it on first.`)
    }
    moved = used
    ctx.sqlite.transaction(() => {
      if (input.moveTo) {
        reports = moveCategoryUsage(ctx, id, input.moveTo).reports
      } else {
        ctx.sqlite
          .prepare(
            `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE category_id = ?`,
          )
          .run(id)
        ctx.sqlite.prepare('UPDATE recurring_items SET category_id = NULL WHERE category_id = ?').run(id)
        ctx.sqlite.prepare('DELETE FROM payee_category_stats WHERE category_id = ?').run(id)
        ctx.sqlite.prepare('DELETE FROM payee_rules WHERE category_id = ?').run(id)
      }
      ctx.sqlite.prepare("UPDATE categories SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id)
    })()
  } else if (input.enabled && before.archived) {
    ctx.sqlite.prepare('UPDATE categories SET archived_at = NULL WHERE id = ?').run(id)
  }
  return { category: getCategory(ctx, id), moved, reports }
}

/**
 * Moves what uses a category to another: its transactions (deleted ones too, so a restore lands in
 * the right place), recurring payments, what the app learned about payees, and custom reports.
 */
function moveCategoryUsage(ctx: AppContext, id: number, into: number) {
  const { n: transactions } = ctx.sqlite
    .prepare('SELECT count(*) AS n FROM transactions WHERE category_id = ? AND deleted_at IS NULL')
    .get(id) as { n: number }
  ctx.sqlite
    .prepare(`UPDATE transactions SET category_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE category_id = ?`)
    .run(into, id)
  const recurring = ctx.sqlite.prepare('UPDATE recurring_items SET category_id = ? WHERE category_id = ?').run(into, id).changes
  // Payees learned for this category now suggest the other one.
  ctx.sqlite
    .prepare(
      `INSERT INTO payee_category_stats (payee_key, direction, category_id, count, last_used_at)
       SELECT payee_key, direction, ?, count, last_used_at FROM payee_category_stats WHERE category_id = ?
       ON CONFLICT (payee_key, direction, category_id) DO UPDATE SET count = count + excluded.count, last_used_at = max(last_used_at, excluded.last_used_at)`,
    )
    .run(into, id)
  ctx.sqlite.prepare('DELETE FROM payee_category_stats WHERE category_id = ?').run(id)
  // Payees always set to it are always set to the other one.
  ctx.sqlite.prepare('UPDATE payee_rules SET category_id = ? WHERE category_id = ?').run(into, id)
  const reports = remapCategoryRefs(ctx, id, into)
  return { transactions, recurring, reports }
}

/**
 * Merges a category into another: its transactions (deleted ones too, so a restore lands in the
 * right place), recurring payments, what the app learned about payees and custom reports move over,
 * then it's deleted. The other category keeps its own name, group and labels.
 */
export function mergeCategory(ctx: AppContext, id: number, into: number): CategoryMergeResult & { from: Category; reports: number } {
  const from = getCategory(ctx, id)
  getCategory(ctx, into)
  if (from.id === into) badRequest('Choose a different category to merge into.')
  const counts = ctx.sqlite.transaction(() => {
    const moved = moveCategoryUsage(ctx, id, into)
    ctx.db.delete(categories).where(eq(categories.id, id)).run()
    return moved
  })()
  return { from, into: getCategory(ctx, into), ...counts }
}

function groupDTO(g: typeof categoryGroups.$inferSelect): CategoryGroup {
  return { id: g.id, name: g.name, color: g.color, sort: g.sort }
}

/** A new group; without a colour it gets one no other group has yet. */
export function createGroup(ctx: AppContext, input: { name: string; color?: string }): CategoryGroup {
  const maxSort = ctx.sqlite.prepare('SELECT coalesce(max(sort), -1) AS m FROM category_groups').get() as { m: number }
  const color = input.color ?? unusedColor(ctx.db.select({ color: categoryGroups.color }).from(categoryGroups).all().map((g) => g.color))
  const g = ctx.db.insert(categoryGroups).values({ name: input.name, color, sort: maxSort.m + 1 }).returning().get()
  return groupDTO(g)
}

export function updateGroup(ctx: AppContext, id: number, input: { name?: string; color?: string; sort?: number }) {
  getGroup(ctx, id)
  const row = ctx.db.update(categoryGroups).set(input).where(eq(categoryGroups.id, id)).returning().get()
  return groupDTO(row)
}

export function getGroup(ctx: AppContext, id: number): CategoryGroup {
  const g = ctx.db.select().from(categoryGroups).where(eq(categoryGroups.id, id)).get()
  if (!g) notFound('Group not found')
  return groupDTO(g)
}

/** Deletes a group with its categories (their transactions become uncategorized). Returns the categories it deleted. */
export function deleteGroup(ctx: AppContext, id: number): Category[] {
  getGroup(ctx, id)
  const labelled = labelIdsByCategory(ctx)
  const removed = ctx.db
    .select()
    .from(categories)
    .where(eq(categories.groupId, id))
    .orderBy(asc(categories.sort), asc(categories.id))
    .all()
    .map((r) => categoryDTO(r, labelled.get(r.id)))
  ctx.sqlite.transaction(() => {
    ctx.db.delete(categories).where(eq(categories.groupId, id)).run()
    ctx.db.delete(categoryGroups).where(eq(categoryGroups.id, id)).run()
  })()
  return removed
}

/**
 * Sets `sort` from the order of `ids` (first = 0). Ids not listed keep their place after the
 * listed ones. Shared by accounts, categories and groups.
 */
export function reorder(ctx: AppContext, table: 'accounts' | 'institutions' | 'categories' | 'category_groups', ids: number[]) {
  const known = new Set((ctx.sqlite.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: number }>).map((r) => r.id))
  const missing = ids.filter((id) => !known.has(id))
  if (missing.length) notFound(`Not found: ${missing.join(', ')}`)
  const set = ctx.sqlite.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?`)
  ctx.sqlite.transaction(() => {
    ids.forEach((id, i) => set.run(i, id))
    const rest = ctx.sqlite
      .prepare(`SELECT id FROM ${table} WHERE id NOT IN (SELECT value FROM json_each(?)) ORDER BY sort, id`)
      .all(JSON.stringify(ids)) as Array<{ id: number }>
    rest.forEach((r, i) => set.run(ids.length + i, r.id))
  })()
}

// Tags --------------------------------------------------------------------

export function listTags(ctx: AppContext): TagWithCount[] {
  return ctx.sqlite
    .prepare(
      `SELECT t.id, t.name, t.color,
         (SELECT count(*) FROM transaction_tags tt JOIN transactions x ON x.id = tt.transaction_id
          WHERE tt.tag_id = t.id AND x.deleted_at IS NULL) AS count
       FROM tags t ORDER BY t.name`,
    )
    .all() as TagWithCount[]
}

export function normalizeTagName(name: string) {
  return name.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')
}

/** Returns tag ids for the given names, creating any that don't exist yet. */
export function upsertTags(ctx: AppContext, names: string[]): number[] {
  const clean = [...new Set(names.map(normalizeTagName).filter(Boolean))]
  if (!clean.length) return []
  for (const name of clean) ctx.db.insert(tags).values({ name }).onConflictDoNothing().run()
  return ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(inArray(tags.name, clean))
    .all()
    .map((t) => t.id)
}

export function getTag(ctx: AppContext, id: number): Tag {
  const row = ctx.db.select({ id: tags.id, name: tags.name, color: tags.color }).from(tags).where(eq(tags.id, id)).get()
  if (!row) notFound('Tag not found')
  return row
}

export function createTag(ctx: AppContext, name: string, color?: string | null): Tag {
  const [id] = upsertTags(ctx, [name])
  if (color !== undefined) ctx.db.update(tags).set({ color }).where(eq(tags.id, id!)).run()
  return ctx.db.select({ id: tags.id, name: tags.name, color: tags.color }).from(tags).where(eq(tags.id, id!)).get()!
}

export function updateTag(ctx: AppContext, id: number, input: { name?: string; color?: string | null }) {
  const row = ctx.db
    .update(tags)
    .set({ ...input, ...(input.name ? { name: normalizeTagName(input.name) } : {}) })
    .where(eq(tags.id, id))
    .returning({ id: tags.id, name: tags.name, color: tags.color })
    .get()
  if (!row) notFound('Tag not found')
  return row
}

export function deleteTag(ctx: AppContext, id: number) {
  getTag(ctx, id)
  ctx.db.delete(transactionTags).where(eq(transactionTags.tagId, id)).run()
  ctx.db.delete(tags).where(eq(tags.id, id)).run()
}
