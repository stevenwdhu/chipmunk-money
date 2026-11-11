import { HTTPException } from 'hono/http-exception'
import type { Institution } from '@chipmunk/shared'
import { badRequest } from '../lib/http'
import type { AppContext } from './context'

interface Row {
  id: number
  name: string
  sort: number
  account_count: number
}

/** This ledger's institutions, each with how many of its accounts are there (archived ones count). */
const LIST_SQL = `SELECT i.*,
    (SELECT count(*) FROM ledger_accounts a WHERE a.ledger_id = @ledger AND a.institution_id = i.id) AS account_count
  FROM institutions i WHERE i.ledger_id = @ledger`

function toDTO(r: Row): Institution {
  return {
    id: r.id,
    name: r.name,
    sort: r.sort,
    accountCount: r.account_count,
  }
}

export function listInstitutions(ctx: AppContext): Institution[] {
  return ctx.q.all<Row>(`${LIST_SQL} ORDER BY i.sort, i.id`).map(toDTO)
}

export function getInstitution(ctx: AppContext, id: number): Institution {
  return toDTO(ctx.q.mustGet<Row>(`${LIST_SQL} AND i.id = ?`, 'Institution not found', id))
}

/** Names are unique in a ledger, ignoring case and surrounding spaces. */
function idByName(ctx: AppContext, name: string): number | undefined {
  return ctx.q.pluck<number>('SELECT id FROM institutions WHERE ledger_id = @ledger AND lower(trim(name)) = lower(trim(?)) ORDER BY id LIMIT 1', name)
}

function assertNameFree(ctx: AppContext, name: string, except?: number) {
  const existing = idByName(ctx, name)
  if (existing !== undefined && existing !== except) throw new HTTPException(409, { message: `There’s already an institution called “${name.trim()}”.` })
}

export function createInstitution(ctx: AppContext, input: { name: string }): Institution {
  assertNameFree(ctx, input.name)
  const m = ctx.q.pluck<number>('SELECT coalesce(max(sort), -1) FROM institutions WHERE ledger_id = @ledger')!
  const { lastInsertRowid } = ctx.q.run('INSERT INTO institutions (ledger_id, name, sort) VALUES (@ledger, ?, ?)', input.name.trim(), m + 1)
  return getInstitution(ctx, Number(lastInsertRowid))
}

export function updateInstitution(ctx: AppContext, id: number, input: { name?: string; sort?: number }): Institution {
  getInstitution(ctx, id)
  if (input.name !== undefined) {
    assertNameFree(ctx, input.name, id)
    ctx.q.run('UPDATE institutions SET name = ? WHERE id = ? AND ledger_id = @ledger', input.name.trim(), id)
  }
  if (input.sort !== undefined) ctx.q.run('UPDATE institutions SET sort = ? WHERE id = ? AND ledger_id = @ledger', input.sort, id)
  ctx.q.run('UPDATE institutions SET updated_at = ? WHERE id = ? AND ledger_id = @ledger', new Date().toISOString(), id)
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
  ctx.q.transaction(() => {
    if (target) ctx.q.run('UPDATE accounts SET institution_id = ? WHERE institution_id = ? AND ledger_id = @ledger', target.id, id)
    ctx.q.run('DELETE FROM institutions WHERE id = ? AND ledger_id = @ledger', id)
  })
  return { before, movedTo: target ? getInstitution(ctx, target.id) : null }
}

/** Removes an institution once no account is under it (archived ones count). Returns it if it was removed. */
export function removeIfEmpty(ctx: AppContext, id: number): Institution | null {
  const row = ctx.q.get<Row>(`${LIST_SQL} AND i.id = ?`, id)
  if (!row || row.account_count) return null
  ctx.q.run('DELETE FROM institutions WHERE id = ? AND ledger_id = @ledger', id)
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
