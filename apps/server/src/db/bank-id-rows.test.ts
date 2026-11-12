import { describe, expect, it } from 'vitest'
import { addLedger, addSharedList, bareDatabase, bareWriter, fillLedger } from '../test/world'

/**
 * Migration 0004: a row kept only so its account keeps knowing a bank id (bank_id_only). It's a
 * deleted row with a bank id (guard_transactions_bank_id_only) and stays one (keep_bank_id_only).
 * Raw SQL on a migrated database without the write guards, as in split-rows.test.ts.
 */

const IS = 'a row kept only for its bank id is a deleted row with one'
const STAYS = 'a row kept only for its bank id stays a deleted row with one'

function world() {
  const sqlite = bareDatabase()
  addLedger(sqlite, 'A')
  const shared = addSharedList(sqlite)
  const a = fillLedger(bareWriter(sqlite, 'A'), { category: shared.food, offCategory: shared.fun })
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  const row = (more: { externalId?: string | null; deleted?: string | null; only?: number } = {}) =>
    Number(
      run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, external_id, deleted_at, bank_id_only)
         VALUES ('A', ?, '2026-09-10', -500, 'Shop', 'shop', ?, ?, ?)`,
        a.account,
        more.externalId ?? null,
        more.deleted ?? null,
        more.only ?? 0,
      ).lastInsertRowid,
    )
  const get = (id: number) => sqlite.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  const update = (id: number, sets: string) => () => run(`UPDATE transactions SET ${sets} WHERE id = ?`, id)
  return { sqlite, a, run, row, get, update }
}

describe('a row kept only for its bank id', () => {
  it('is a deleted row with a bank id, and every other row is an ordinary one by default', () => {
    const w = world()
    expect(w.get(w.row())).toMatchObject({ bank_id_only: 0 })
    expect(w.get(w.row({ externalId: 'x1', deleted: '2026-10-01T00:00:00Z', only: 1 }))).toMatchObject({ bank_id_only: 1, external_id: 'x1' })
    expect(() => w.row({ externalId: 'x2', only: 1 })).toThrow(IS)
    expect(() => w.row({ deleted: '2026-10-01T00:00:00Z', only: 1 })).toThrow(IS)
  })

  it('stays one: not restored, never without a bank id, never an ordinary row again', () => {
    const w = world()
    const id = w.row({ externalId: 'x1', deleted: '2026-10-01T00:00:00Z', only: 1 })
    expect(w.update(id, 'deleted_at = NULL')).toThrow(STAYS)
    expect(w.update(id, 'external_id = NULL')).toThrow(STAYS)
    expect(w.update(id, 'bank_id_only = 0')).toThrow(STAYS)
    expect(w.update(id, 'bank_id_only = 0, deleted_at = NULL')).toThrow(STAYS)
    // A switch gives it the new bank id, and what the bank says replaces it changes its facts.
    w.update(id, "external_id = 'y1', date = '2026-09-11', amount_minor = -600, status = 'pending', deleted_at = '2026-10-02T00:00:00Z'")()
    expect(w.get(id)).toMatchObject({ external_id: 'y1', amount_minor: -600, bank_id_only: 1 })
  })

  it('is what a deleted row with a bank id can become, and no other row', () => {
    const w = world()
    const deleted = w.row({ externalId: 'x1', deleted: '2026-10-01T00:00:00Z' })
    w.update(deleted, 'bank_id_only = 1')()
    expect(w.get(deleted)).toMatchObject({ bank_id_only: 1 })
    expect(w.update(w.row({ externalId: 'x2' }), 'bank_id_only = 1')).toThrow(STAYS)
    expect(w.update(w.row({ deleted: '2026-10-01T00:00:00Z' }), 'bank_id_only = 1')).toThrow(STAYS)
    // Live and marked in one statement.
    const live = w.row({ externalId: 'x3' })
    w.update(live, "bank_id_only = 1, deleted_at = '2026-10-01T00:00:00Z'")()
    expect(w.get(live)).toMatchObject({ bank_id_only: 1 })
  })

  it('goes with its account, and can be deleted for good', () => {
    const w = world()
    const id = w.row({ externalId: 'x1', deleted: '2026-10-01T00:00:00Z', only: 1 })
    const other = w.row({ externalId: 'x2', deleted: '2026-10-01T00:00:00Z', only: 1 })
    w.run('DELETE FROM transactions WHERE id = ?', other)
    expect(w.get(other)).toBeUndefined()
    w.run('DELETE FROM accounts WHERE id = ?', w.a.account)
    expect(w.get(id)).toBeUndefined()
  })
})
