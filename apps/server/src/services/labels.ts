import { HTTPException } from 'hono/http-exception'
import { CATEGORY_COLORS, type Label, type LabelCategories } from '@chipmunk/shared'
import { badRequest } from '../lib/http'
import { requireOwnList } from './catalog'
import type { AppContext } from './context'

/**
 * Labels you put on categories: your own way to sort spending across the groups, such as needs and
 * wants. A category can have any number of them, and a label any number of categories. A ledger
 * reads the labels of the list it uses (ledger_labels), and edits them here only when it has its
 * own list: shared labels are changed in App settings (catalog-edit.ts).
 */

const LIST_SQL = `SELECT l.id, l.name, l.color, l.sort,
  (SELECT count(*) FROM category_labels cl WHERE cl.label_id = l.id) AS categoryCount
  FROM ledger_labels l WHERE l.ledger_id = @ledger`

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

export function listLabels(ctx: AppContext): Label[] {
  return ctx.q.all<Label>(`${LIST_SQL} ORDER BY l.sort, l.id`)
}

export function getLabel(ctx: AppContext, id: number): Label {
  return ctx.q.mustGet<Label>(`${LIST_SQL} AND l.id = @id`, 'Label not found', { id })
}

/** Names are unique whatever their case. */
function checkName(ctx: AppContext, name: string, except?: number) {
  const clash = ctx.q.get<{ name: string }>('SELECT name FROM ledger_labels WHERE ledger_id = @ledger AND lower(name) = lower(@name) AND id IS NOT @except', {
    name,
    except: except ?? null,
  })
  if (clash) throw new HTTPException(409, { message: `There’s already a label called “${clash.name}”.` })
}

export function createLabel(ctx: AppContext, input: { name: string; color?: string }): Label {
  requireOwnList(ctx)
  checkName(ctx, input.name)
  const sort = ctx.q.pluck<number>('SELECT coalesce(max(sort), -1) + 1 FROM labels WHERE ledger_id = @ledger')!
  // Without a colour, the first one in the palette that no label has yet (so labels tell apart).
  const used = new Set(ctx.q.column<string>('SELECT color FROM labels WHERE ledger_id = @ledger').map((c) => c.toLowerCase()))
  const color = input.color ?? CATEGORY_COLORS.find((c) => !used.has(c.toLowerCase())) ?? CATEGORY_COLORS[sort % CATEGORY_COLORS.length]!
  const id = ctx.q.pluck<number>('INSERT INTO labels (ledger_id, name, color, sort) VALUES (@ledger, @name, @color, @sort) RETURNING id', {
    name: input.name,
    color,
    sort,
  })!
  return getLabel(ctx, id)
}

export function updateLabel(ctx: AppContext, id: number, input: { name?: string; color?: string; sort?: number }): Label {
  requireOwnList(ctx)
  getLabel(ctx, id)
  if (input.name !== undefined) checkName(ctx, input.name, id)
  const sets = Object.entries({ name: input.name, color: input.color, sort: input.sort }).filter(([, v]) => v !== undefined)
  if (sets.length) {
    ctx.q.run(`UPDATE labels SET ${sets.map(([k]) => `${k} = @${k}`).join(', ')}, updated_at = ${NOW} WHERE ledger_id = @ledger AND id = @id`, {
      ...Object.fromEntries(sets),
      id,
    })
  }
  return getLabel(ctx, id)
}

/** Deletes the label; its categories just lose it. */
export function deleteLabel(ctx: AppContext, id: number): Label {
  requireOwnList(ctx)
  const before = getLabel(ctx, id)
  ctx.q.run('DELETE FROM labels WHERE ledger_id = @ledger AND id = @id', { id })
  return before
}

/** Every one of these is a category of the ledger's own list. */
function checkCategories(ctx: AppContext, ids: number[]) {
  if (!ids.length) return
  const found = ctx.q.pluck<number>('SELECT count(*) FROM categories WHERE ledger_id = @ledger AND id IN (SELECT value FROM json_each(@ids))', {
    ids: JSON.stringify(ids),
  })
  if (found !== new Set(ids).size) badRequest('One of those categories doesn’t exist.')
}

/** Puts the label on some categories and takes it off others. */
export function applyLabel(ctx: AppContext, id: number, input: Required<LabelCategories>): Label {
  requireOwnList(ctx)
  getLabel(ctx, id)
  checkCategories(ctx, [...input.add, ...input.remove])
  ctx.q.transaction(() => {
    for (const c of input.add) ctx.q.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?) ON CONFLICT DO NOTHING', c, id)
    for (const c of input.remove) {
      ctx.q.run('DELETE FROM category_labels WHERE category_id = @c AND label_id = @id AND label_id IN (SELECT id FROM labels WHERE ledger_id = @ledger)', { c, id })
    }
  })
  return getLabel(ctx, id)
}

/** Gives a category of the ledger's own list exactly these labels. */
export function setCategoryLabels(ctx: AppContext, categoryId: number, labelIds: number[]) {
  requireOwnList(ctx)
  const ids = [...new Set(labelIds)]
  if (ids.length) {
    const found = ctx.q.pluck<number>('SELECT count(*) FROM labels WHERE ledger_id = @ledger AND id IN (SELECT value FROM json_each(@ids))', {
      ids: JSON.stringify(ids),
    })
    if (found !== ids.length) badRequest('One of those labels doesn’t exist.')
  }
  ctx.q.transaction(() => {
    ctx.q.run('DELETE FROM category_labels WHERE category_id = @categoryId AND category_id IN (SELECT id FROM categories WHERE ledger_id = @ledger)', {
      categoryId,
    })
    for (const l of ids) ctx.q.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)', categoryId, l)
  })
}

/** Each category's label ids, in the labels' order. */
export function labelIdsByCategory(ctx: AppContext, categoryId?: number): Map<number, number[]> {
  const rows = ctx.q.all<{ categoryId: number; labelId: number }>(
    `SELECT cl.category_id AS categoryId, cl.label_id AS labelId FROM category_labels cl JOIN ledger_labels l ON l.id = cl.label_id
     WHERE l.ledger_id = @ledger ${categoryId === undefined ? '' : 'AND cl.category_id = @categoryId'} ORDER BY l.sort, l.id`,
    ...(categoryId === undefined ? [] : [{ categoryId }]),
  )
  const out = new Map<number, number[]>()
  for (const r of rows) out.set(r.categoryId, [...(out.get(r.categoryId) ?? []), r.labelId])
  return out
}
