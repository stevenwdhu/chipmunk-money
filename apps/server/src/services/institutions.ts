import { HTTPException } from 'hono/http-exception'
import type { Institution } from '@chipmunk/shared'
import { badRequest, notFound } from '../lib/http'
import type { AppContext } from './context'

interface Row {
  id: number
  name: string
  sort: number
  account_count: number
}

const LIST_SQL = `SELECT i.*, (SELECT count(*) FROM accounts a WHERE a.institution_id = i.id) AS account_count FROM institutions i`

function toDTO(r: Row): Institution {
  return {
    id: r.id,
    name: r.name,
    sort: r.sort,
    accountCount: r.account_count,
  }
}

export function listInstitutions(ctx: AppContext): Institution[] {
  return (ctx.sqlite.prepare(`${LIST_SQL} ORDER BY i.sort, i.id`).all() as Row[]).map(toDTO)
}

export function getInstitution(ctx: AppContext, id: number): Institution {
  const row = ctx.sqlite.prepare(`${LIST_SQL} WHERE i.id = ?`).get(id) as Row | undefined
  if (!row) notFound('Institution not found')
  return toDTO(row)
}

/** Names are unique, ignoring case and surrounding spaces. */
function idByName(ctx: AppContext, name: string): number | undefined {
  const row = ctx.sqlite.prepare('SELECT id FROM institutions WHERE lower(trim(name)) = lower(trim(?))').get(name) as { id: number } | undefined
  return row?.id
}

function assertNameFree(ctx: AppContext, name: string, except?: number) {
  const existing = idByName(ctx, name)
  if (existing !== undefined && existing !== except) throw new HTTPException(409, { message: `There’s already an institution called “${name.trim()}”.` })
}

export function createInstitution(ctx: AppContext, input: { name: string }): Institution {
  assertNameFree(ctx, input.name)
  const { m } = ctx.sqlite.prepare('SELECT coalesce(max(sort), -1) AS m FROM institutions').get() as { m: number }
  const { lastInsertRowid } = ctx.sqlite.prepare('INSERT INTO institutions (name, sort) VALUES (?, ?)').run(input.name.trim(), m + 1)
  return getInstitution(ctx, Number(lastInsertRowid))
}

export function updateInstitution(ctx: AppContext, id: number, input: { name?: string; sort?: number }): Institution {
  getInstitution(ctx, id)
  if (input.name !== undefined) {
    assertNameFree(ctx, input.name, id)
    ctx.sqlite.prepare('UPDATE institutions SET name = ? WHERE id = ?').run(input.name.trim(), id)
  }
  if (input.sort !== undefined) ctx.sqlite.prepare('UPDATE institutions SET sort = ? WHERE id = ?').run(input.sort, id)
  ctx.sqlite.prepare(`UPDATE institutions SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
  return getInstitution(ctx, id)
}

/** Deletes an institution. One with accounts needs `moveTo`: its accounts move there first. */
export function deleteInstitution(ctx: AppContext, id: number, moveTo?: number): { before: Institution; movedTo: Institution | null } {
  const before = getInstitution(ctx, id)
  const target = moveTo === undefined ? null : getInstitution(ctx, moveTo)
  if (target?.id === id) badRequest('Choose a different institution to move the accounts to.')
  if (before.accountCount && !target) {
    throw new HTTPException(409, {
      message: `${before.name} still has ${before.accountCount} account${before.accountCount === 1 ? '' : 's'}. Move them to another institution first.`,
    })
  }
  ctx.sqlite.transaction(() => {
    if (target) ctx.sqlite.prepare('UPDATE accounts SET institution_id = ? WHERE institution_id = ?').run(target.id, id)
    ctx.sqlite.prepare('DELETE FROM institutions WHERE id = ?').run(id)
  })()
  return { before, movedTo: target ? getInstitution(ctx, target.id) : null }
}

/** Removes an institution once no account is under it (archived ones count). Returns it if it was removed. */
export function removeIfEmpty(ctx: AppContext, id: number): Institution | null {
  const row = ctx.sqlite.prepare(`${LIST_SQL} WHERE i.id = ?`).get(id) as Row | undefined
  if (!row || row.account_count) return null
  ctx.sqlite.prepare('DELETE FROM institutions WHERE id = ?').run(id)
  return toDTO(row)
}

/** The institution an account goes under: by id, or by name (created if it's new). */
export function resolveInstitution(ctx: AppContext, input: { institutionId?: number; institution?: string }): { id: number; created: boolean } {
  if (input.institutionId !== undefined) return { id: getInstitution(ctx, input.institutionId).id, created: false }
  if (input.institution === undefined) badRequest('Choose the institution the account is at.')
  const existing = idByName(ctx, input.institution)
  if (existing !== undefined) return { id: existing, created: false }
  return { id: createInstitution(ctx, { name: input.institution }).id, created: true }
}
