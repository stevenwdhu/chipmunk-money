import type { SQLite } from '../db/client'
import { TABLES } from '../db/tables'
import type { AppContext } from '../services/context'
import { categoryId } from './helpers'
import { fillLedger, type LedgerRows, type Writer } from './world'

/** For tests of ledger backups: a ledger with a row in every table, and its rows to compare. */

/** A writer through a ledger's handle. */
export const handleWriter =
  (ctx: AppContext): Writer =>
  (sql, params = {}) =>
    Number(ctx.q.run(sql, params).lastInsertRowid)

/**
 * One of everything in a ledger (world.ts's fillLedger), on its shared list, plus what a restore
 * has to carry as it is: a refund renamed apart from its purchase, a custom report and activity
 * entries that name rows by id. `mark` goes into its free text, to tell ledgers apart.
 */
export function fullLedger(ctx: AppContext, mark = ''): LedgerRows {
  const write = handleWriter(ctx)
  const rows = fillLedger(write, { category: categoryId(ctx, 'Groceries'), offCategory: categoryId(ctx, 'Gifts') })
  write(`UPDATE transactions SET name = @name, notes = @notes WHERE id = @id AND ledger_id = @ledger`, { id: rows.refund, name: `Returned${mark}`, notes: `note${mark}` })
  const spec = {
    filter: {
      spending: { only: [{ field: 'tag', ids: [rows.tag] }, { field: 'account', ids: [rows.account] }], filterOut: [], picked: [rows.purchase], keep: [rows.refund] },
    },
    names: { tag: { [rows.tag]: 'trip' }, account: { [rows.account]: 'Card' } },
    range: '12m',
  }
  write('UPDATE custom_reports SET spec = @spec WHERE id = @id AND ledger_id = @ledger', { id: rows.report, spec: JSON.stringify(spec) })
  write(
    `INSERT INTO activity (ledger_id, actor, action, entity, entity_id, summary, before, after)
     VALUES (@ledger, 'web', 'update', 'transaction', @entity, @summary, @before, @after)`,
    {
      entity: String(rows.purchase),
      summary: `Edited Shop${mark}`,
      before: JSON.stringify({ id: rows.purchase, accountId: rows.account, tags: [{ id: rows.tag, name: 'trip' }] }),
      after: JSON.stringify({ id: rows.purchase, accountId: rows.savings, transferPairId: rows.transferIn }),
    },
  )
  return rows
}

/** Every row of a ledger, table by table (child rows through their parents), in a fixed order. */
export function ledgerRows(sqlite: SQLite, ledger: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const t of TABLES) {
    if (t.kind === 'app') continue
    const where =
      t.kind === 'child' ? t.parents!.map((p) => `"${p.column}" IN (SELECT id FROM "${p.table}" WHERE ledger_id = @ledger)`).join(' OR ') : 'ledger_id = @ledger'
    const columns = (sqlite.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>).map((c) => `"${c.name}"`)
    out[t.name] = sqlite.prepare(`SELECT * FROM "${t.name}" WHERE ${where} ORDER BY ${columns.join(', ')}`).all({ ledger })
  }
  return out
}

/** A ledger's rows with its id taken out, to compare two ledgers' copies of the same data. */
export function withoutLedger(rows: Record<string, unknown[]>): Record<string, unknown[]> {
  return Object.fromEntries(
    Object.entries(rows).map(([t, rs]) => [
      t,
      rs.map((r) => {
        const { ledger_id: _, ...rest } = r as Record<string, unknown>
        return rest
      }),
    ]),
  )
}
