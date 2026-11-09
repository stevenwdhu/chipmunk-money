import { HTTPException } from 'hono/http-exception'
import { CATEGORY_COLORS, type Label, type LabelCategories } from '@st/shared'
import { badRequest, notFound } from '../lib/http'
import type { AppContext } from './context'

/**
 * Labels you put on categories: your own way to sort spending across the groups, such as needs and
 * wants. A category can have any number of them, and a label any number of categories.
 */

const LIST_SQL = `SELECT l.id, l.name, l.color, l.sort,
  (SELECT count(*) FROM category_labels cl WHERE cl.label_id = l.id) AS categoryCount
  FROM labels l`

export function listLabels(ctx: AppContext): Label[] {
  return ctx.sqlite.prepare(`${LIST_SQL} ORDER BY l.sort, l.id`).all() as Label[]
}

export function getLabel(ctx: AppContext, id: number): Label {
  const row = ctx.sqlite.prepare(`${LIST_SQL} WHERE l.id = ?`).get(id) as Label | undefined
  if (!row) notFound('Label not found')
  return row
}

/** Names are unique whatever their case. */
function checkName(ctx: AppContext, name: string, except?: number) {
  const clash = ctx.sqlite.prepare('SELECT name FROM labels WHERE lower(name) = lower(?) AND id IS NOT ?').get(name, except ?? null) as
    | { name: string }
    | undefined
  if (clash) throw new HTTPException(409, { message: `There’s already a label called “${clash.name}”.` })
}

export function createLabel(ctx: AppContext, input: { name: string; color?: string }): Label {
  checkName(ctx, input.name)
  const { sort } = ctx.sqlite.prepare('SELECT coalesce(max(sort), -1) + 1 AS sort FROM labels').get() as { sort: number }
  // Without a colour, the first one in the palette that no label has yet (so labels tell apart).
  const used = new Set((ctx.sqlite.prepare('SELECT color FROM labels').all() as Array<{ color: string }>).map((r) => r.color.toLowerCase()))
  const color = input.color ?? CATEGORY_COLORS.find((c) => !used.has(c.toLowerCase())) ?? CATEGORY_COLORS[sort % CATEGORY_COLORS.length]!
  const { id } = ctx.sqlite
    .prepare('INSERT INTO labels (name, color, sort) VALUES (?, ?, ?) RETURNING id')
    .get(input.name, color, sort) as { id: number }
  return getLabel(ctx, id)
}

export function updateLabel(ctx: AppContext, id: number, input: { name?: string; color?: string; sort?: number }): Label {
  getLabel(ctx, id)
  if (input.name !== undefined) checkName(ctx, input.name, id)
  const sets = Object.entries({ name: input.name, color: input.color, sort: input.sort }).filter(([, v]) => v !== undefined)
  if (sets.length) {
    ctx.sqlite
      .prepare(`UPDATE labels SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...sets.map(([, v]) => v), id)
  }
  return getLabel(ctx, id)
}

/** Deletes the label; its categories just lose it. */
export function deleteLabel(ctx: AppContext, id: number): Label {
  const before = getLabel(ctx, id)
  ctx.sqlite.prepare('DELETE FROM labels WHERE id = ?').run(id)
  return before
}

function checkCategories(ctx: AppContext, ids: number[]) {
  if (!ids.length) return
  const found = ctx.sqlite.prepare(`SELECT count(*) AS n FROM categories WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as {
    n: number
  }
  if (found.n !== new Set(ids).size) badRequest('One of those categories doesn’t exist.')
}

/** Puts the label on some categories and takes it off others. */
export function applyLabel(ctx: AppContext, id: number, input: Required<LabelCategories>): Label {
  getLabel(ctx, id)
  checkCategories(ctx, [...input.add, ...input.remove])
  const add = ctx.sqlite.prepare('INSERT OR IGNORE INTO category_labels (category_id, label_id) VALUES (?, ?)')
  const remove = ctx.sqlite.prepare('DELETE FROM category_labels WHERE category_id = ? AND label_id = ?')
  ctx.sqlite.transaction(() => {
    for (const c of input.add) add.run(c, id)
    for (const c of input.remove) remove.run(c, id)
  })()
  return getLabel(ctx, id)
}

/** Gives a category exactly these labels. */
export function setCategoryLabels(ctx: AppContext, categoryId: number, labelIds: number[]) {
  const ids = [...new Set(labelIds)]
  if (ids.length) {
    const found = ctx.sqlite.prepare(`SELECT count(*) AS n FROM labels WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }
    if (found.n !== ids.length) badRequest('One of those labels doesn’t exist.')
  }
  ctx.sqlite.transaction(() => {
    ctx.sqlite.prepare('DELETE FROM category_labels WHERE category_id = ?').run(categoryId)
    const add = ctx.sqlite.prepare('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)')
    for (const l of ids) add.run(categoryId, l)
  })()
}

/** Each category's label ids, in the labels' order. */
export function labelIdsByCategory(ctx: AppContext, categoryId?: number): Map<number, number[]> {
  const rows = ctx.sqlite
    .prepare(
      `SELECT cl.category_id AS categoryId, cl.label_id AS labelId FROM category_labels cl JOIN labels l ON l.id = cl.label_id
       ${categoryId === undefined ? '' : 'WHERE cl.category_id = ?'} ORDER BY l.sort, l.id`,
    )
    .all(...(categoryId === undefined ? [] : [categoryId])) as Array<{ categoryId: number; labelId: number }>
  const out = new Map<number, number[]>()
  for (const r of rows) out.set(r.categoryId, [...(out.get(r.categoryId) ?? []), r.labelId])
  return out
}
