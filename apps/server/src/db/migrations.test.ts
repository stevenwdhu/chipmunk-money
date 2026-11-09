import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../env'
import { restoreBackup } from '../services/setup'
import { testContext } from '../test/helpers'
import { openLedgerDb, openMetaDb, shippedMigrations } from './client'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function tempFile(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-migrations-'))
  dirs.push(dir)
  return path.join(dir, name)
}

/**
 * A database as the migrations from before the squash left it: the baseline's schema, with a run
 * of earlier migrations recorded, the last one at `last`.
 */
function ranOldMigrations(file: string, folder: string, last: number) {
  const sqlite = new Database(file)
  migrate(drizzle(sqlite), { migrationsFolder: folder })
  sqlite.exec('DELETE FROM __drizzle_migrations')
  const insert = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
  for (let i = 34; i >= 0; i--) insert.run(`old-${i}`, last - i * 1000)
  sqlite.close()
}

describe('ledger migrations', () => {
  it('make a ledger whose lines say which transaction each belongs to', () => {
    const sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: env.ledgerMigrations })
    sqlite.exec(`
      INSERT INTO accounts (id, name, type) VALUES (1, 'Card', 'credit'), (2, 'Chequing', 'chequing');
      INSERT INTO categories (id, name) VALUES (10, 'Travel'), (11, 'Dining');
      INSERT INTO transactions (id, account_id, date, amount_minor, payee, payee_key, category_id, transfer_pair_id, deleted_at) VALUES
        (1, 1, '2026-08-01', -200000, 'Air', 'air', 10, NULL, NULL),
        (2, 1, '2026-08-20', 30000, 'Air', 'air', NULL, NULL, NULL),
        (3, 2, '2026-08-05', 150000, 'Sam', 'sam', NULL, NULL, NULL),
        (4, 1, '2026-08-03', -6000, 'Diner', 'diner', 11, NULL, NULL),
        (5, 2, '2026-08-04', -50000, 'Card payment', 'card payment', NULL, 6, NULL),
        (6, 1, '2026-08-04', 50000, 'Card payment', 'card payment', NULL, 5, NULL),
        (7, 1, '2026-08-09', -1000, 'Gone', 'gone', 11, NULL, '2026-08-10');
      INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES
        ('refund', 2, 1, 30000), ('payback', 3, 1, 100000), ('payback', 3, 4, 2000);
    `)
    // The triggers keep what each money in has linked, and the view reads it.
    expect(sqlite.prepare('SELECT id, linked_minor FROM transactions WHERE linked_minor > 0 ORDER BY id').all()).toEqual([
      { id: 2, linked_minor: 30000 },
      { id: 3, linked_minor: 102000 },
    ])
    expect(sqlite.prepare(`SELECT id, date, amount_minor, category_id, owner_id, link_kind FROM transaction_lines ORDER BY id, date, amount_minor`).all()).toEqual([
      { id: 1, date: '2026-08-01', amount_minor: -200000, category_id: 10, owner_id: 1, link_kind: null },
      { id: 2, date: '2026-08-20', amount_minor: 30000, category_id: 10, owner_id: 1, link_kind: 'refund' },
      // A payback is on its bill's date and in its category, and what isn't linked of it is its own.
      { id: 3, date: '2026-08-01', amount_minor: 100000, category_id: 10, owner_id: 1, link_kind: 'payback' },
      { id: 3, date: '2026-08-03', amount_minor: 2000, category_id: 11, owner_id: 4, link_kind: 'payback' },
      { id: 3, date: '2026-08-05', amount_minor: 48000, category_id: null, owner_id: 3, link_kind: null },
      { id: 4, date: '2026-08-03', amount_minor: -6000, category_id: 11, owner_id: 4, link_kind: null },
      { id: 5, date: '2026-08-04', amount_minor: -50000, category_id: null, owner_id: 5, link_kind: null },
      { id: 6, date: '2026-08-04', amount_minor: 50000, category_id: null, owner_id: 6, link_kind: null },
      { id: 7, date: '2026-08-09', amount_minor: -1000, category_id: 11, owner_id: 7, link_kind: null },
    ])
  })

  it('leave a ledger that ran every migration before the squash as it is', () => {
    const file = tempFile('ledger.db')
    ranOldMigrations(file, env.ledgerMigrations, shippedMigrations().first)
    const before = new Database(file).prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()

    const { sqlite } = openLedgerDb(file)
    expect(sqlite.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(before)
    expect(sqlite.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(35)
    sqlite.close()
    // Nothing to migrate, so nothing snapshotted.
    const backups = path.join(path.dirname(file), 'backups')
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([])
  })

  it('refuse a ledger or backup from before the squash that missed some migrations', () => {
    const file = tempFile('ledger.db')
    ranOldMigrations(file, env.ledgerMigrations, shippedMigrations().first - 1000)
    expect(() => openLedgerDb(file)).toThrow("is from an older version of Spending Tracker that this one can't upgrade")

    const ctx = testContext()
    expect(() => restoreBackup(ctx, new Uint8Array(readFileSync(file)))).toThrow(
      "This backup comes from an older version of Spending Tracker that this one can't upgrade. Restore it with a version from before November 2026 first.",
    )
  })

  it('refuse an app-wide database from before the squash that missed some migrations', () => {
    const file = tempFile('meta.db')
    ranOldMigrations(file, env.metaMigrations, shippedMigrations(env.metaMigrations).first - 1000)
    expect(() => openMetaDb(file)).toThrow("is from an older version of Spending Tracker that this one can't upgrade")
    const ok = tempFile('meta.db')
    ranOldMigrations(ok, env.metaMigrations, shippedMigrations(env.metaMigrations).first)
    openMetaDb(ok).sqlite.close()
  })
})
