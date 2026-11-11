import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../env'
import { addLedger, addSharedList, bareDatabase, bareWriter, fillLedger, type LedgerRows } from '../test/world'
import { APPLICATION_ID, appTables, lastAppliedMigration, openDatabase, shippedMigrations, snapshotDb, type SQLite } from './client'
import { ledgerMaintenance } from './scope'
import { TABLES } from './tables'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function tempFile(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-migrations-'))
  dirs.push(dir)
  return path.join(dir, name)
}

describe('openDatabase', () => {
  it('makes a new file with incremental auto-vacuum, its application id and WAL, and no snapshot', () => {
    const file = tempFile('chipmunk.db')
    const { sqlite } = openDatabase(file)
    expect(sqlite.pragma('auto_vacuum', { simple: true })).toBe(2)
    expect(sqlite.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    sqlite.close()
    expect(existsSync(path.join(path.dirname(file), 'backups'))).toBe(false)

    // Opening it again runs nothing new.
    const again = openDatabase(file).sqlite
    expect(again.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(1)
    again.close()
  })

  it("refuses a file that isn't a Chipmunk database", () => {
    const file = tempFile('chipmunk.db')
    const other = new Database(file)
    other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)')
    other.close()
    expect(() => openDatabase(file)).toThrow("isn't a Chipmunk database")
  })

  it('refuses a database from before the baseline', () => {
    const file = tempFile('chipmunk.db')
    openDatabase(file).sqlite.close()
    const old = new Database(file)
    old.prepare('UPDATE __drizzle_migrations SET created_at = ?').run(shippedMigrations().first - 1000)
    old.close()
    expect(() => openDatabase(file)).toThrow("is from an older version of Chipmunk that this one can't upgrade")
  })

  it('refuses a database from a newer version, before it writes anything', () => {
    const file = tempFile('chipmunk.db')
    openDatabase(file).sqlite.close()
    const newer = new Database(file)
    newer.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('newer', shippedMigrations().last + 1000)
    // Out of WAL mode, so turning it back on would change the file.
    newer.pragma('journal_mode = DELETE')
    newer.close()
    const bytes = readFileSync(file)
    expect(() => openDatabase(file)).toThrow('is from a newer version of Chipmunk than this one. Update the app to open it.')
    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(existsSync(path.join(path.dirname(file), 'backups'))).toBe(false)
  })

  it('opens an empty file as a new database', () => {
    const file = tempFile('chipmunk.db')
    writeFileSync(file, '')
    const { sqlite } = openDatabase(file)
    expect(sqlite.pragma('auto_vacuum', { simple: true })).toBe(2)
    sqlite.close()
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith('.db'))).toEqual(['chipmunk.db'])
  })
})

/**
 * Upgrading a database with data, as every migration after the baseline does on the real data the
 * first time it runs there. These tests build a database that ran the baseline alone, with two
 * ledgers that have a row in every table, apply the whole shipped folder through openDatabase,
 * and look for what a bad migration would break. They hold however many migrations the folder has.
 */

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

const shippedJournal = JSON.parse(readFileSync(path.join(env.migrations, 'meta/_journal.json'), 'utf8')) as { entries: JournalEntry[] }

/** A migrations folder with these entries of the shipped journal, then the extra ones given (tag and SQL). */
function migrationsFolder(entries: JournalEntry[], extra: Array<{ tag: string; sql: string }> = []): string {
  const dir = path.join(path.dirname(tempFile('x')), 'drizzle')
  mkdirSync(path.join(dir, 'meta'), { recursive: true })
  for (const e of entries) copyFileSync(path.join(env.migrations, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`))
  const last = entries[entries.length - 1]!
  const added = extra.map((x, i) => {
    writeFileSync(path.join(dir, `${x.tag}.sql`), x.sql)
    return { ...last, idx: last.idx + 1 + i, when: last.when + 1 + i, tag: x.tag }
  })
  writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...shippedJournal, entries: [...entries, ...added] }))
  return dir
}

/** chipmunk.db as the baseline alone made it, with ledgers A and B filled, closed. */
function baselineDatabase(file = tempFile('chipmunk.db')): { file: string; rows: Record<'A' | 'B', LedgerRows> } {
  const sqlite = bareDatabase({ file, migrations: migrationsFolder(shippedJournal.entries.slice(0, 1)) })
  addLedger(sqlite, 'A')
  addLedger(sqlite, 'B')
  const shared = addSharedList(sqlite)
  const rows = {
    A: fillLedger(bareWriter(sqlite, 'A'), { category: shared.food, offCategory: shared.fun }),
    B: fillLedger(bareWriter(sqlite, 'B'), { category: shared.food, offCategory: shared.food }),
  }
  sqlite.close()
  return { file, rows }
}

/**
 * How many rows each table holds in all, and in each ledger (child rows through their parents), as
 * `table` and `table@ledger`. Only the tables the database has: a later migration may add some.
 */
function rowCounts(sqlite: SQLite): Record<string, number> {
  const tables = new Set(appTables(sqlite))
  const count = (sql: string, params: Record<string, unknown> = {}) => sqlite.prepare(sql).pluck().get(params) as number
  const counts: Record<string, number> = {}
  for (const table of tables) counts[table] = count(`SELECT count(*) FROM "${table}"`)
  for (const t of TABLES) {
    if (t.kind === 'app' || !tables.has(t.name) || t.parents?.some((p) => !tables.has(p.table))) continue
    const where =
      t.kind === 'child' ? t.parents!.map((p) => `"${p.column}" IN (SELECT id FROM "${p.table}" WHERE ledger_id = @ledger)`).join(' OR ') : 'ledger_id = @ledger'
    for (const ledger of ['A', 'B']) counts[`${t.name}@${ledger}`] = count(`SELECT count(*) FROM "${t.name}" WHERE ${where}`, { ledger })
  }
  return counts
}

/** Whether a write was refused by a trigger (a guard), not for some other reason such as a missing column. */
function refusedByGuard(write: () => unknown): boolean {
  try {
    write()
    return false
  } catch (err) {
    return err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_TRIGGER'
  }
}

/**
 * Builds the baseline database, opens it with openDatabase and the given folder, and says what
 * went wrong, one line each: rows lost or added, broken foreign keys or pages, accounts the view
 * no longer gives its ledger, and guards that no longer refuse.
 */
function upgradeProblems(migrations: string): string[] {
  const { file, rows } = baselineDatabase()
  const raw = () => {
    const sqlite = new Database(file)
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('recursive_triggers = ON')
    return sqlite
  }
  const plain = raw()
  const before = rowCounts(plain)
  const ran = lastAppliedMigration(plain)
  plain.close()
  const lost = (sqlite: SQLite) =>
    Object.entries(rowCounts(sqlite)).flatMap(([key, n]) => (key in before && before[key] !== n ? [`${key}: ${before[key]} rows before, ${n} after`] : []))

  let opened: SQLite
  try {
    opened = openDatabase(file, migrations).sqlite
  } catch (err) {
    // drizzle's message names the statement, its cause says what was wrong with it.
    const failed = [`the migrations failed: ${(err as Error).message.trim()} ${((err as Error).cause as Error | undefined)?.message ?? ''}`]
    // Rolled back: the database is as the baseline left it.
    const after = raw()
    if (lastAppliedMigration(after) !== ran) failed.push('the migrations log changed')
    failed.push(...lost(after))
    after.close()
    return failed
  }
  const problems = lost(opened)
  for (const fk of opened.pragma('foreign_key_check') as Array<{ table: string; parent: string }>) problems.push(`foreign key: ${fk.table} → ${fk.parent}`)
  const integrity = opened.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') problems.push(`integrity: ${integrity}`)
  for (const ledger of ['A', 'B'] as const) {
    const ids = opened.prepare('SELECT id FROM ledger_accounts WHERE ledger_id = ? ORDER BY id').pluck().all(ledger)
    if (JSON.stringify(ids) !== JSON.stringify([rows[ledger].account, rows[ledger].savings])) problems.push(`ledger_accounts gives ${ledger} ${JSON.stringify(ids)}`)
  }

  // The connection's write guards (scope.ts).
  const tag = (ledger: string) => () => opened.prepare("INSERT INTO tags (ledger_id, name) VALUES (?, 'new')").run(ledger)
  if (!refusedByGuard(tag('A'))) problems.push('a write outside any ledger scope was let through')
  if (!refusedByGuard(() => ledgerMaintenance(opened, 'A', tag('B')))) problems.push("a write to B in A's scope was let through")
  try {
    ledgerMaintenance(opened, 'A', tag('A'))
  } catch (err) {
    problems.push(`a write in its own scope was refused: ${(err as Error).message}`)
  }
  opened.close()

  // The schema's guards, on a connection without the write guards, rolled back.
  const sqlite = raw()
  const { A, B } = rows
  const run = (sql: string, ...params: unknown[]) => () => sqlite.prepare(sql).run(...params)
  const transaction = (account: number) =>
    run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES ('A', ?, '2026-09-01', -100, 'x', 'x')", account)
  sqlite.exec('BEGIN')
  const guards: Array<[string, () => unknown]> = [
    ["a transaction on another ledger's account", transaction(B.account)],
    ["an account with another ledger's institution", run("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES ('A', 'x', 'cash', ?)", B.institution)],
    ['a transaction moved to another ledger', run("UPDATE transactions SET ledger_id = 'B' WHERE id = ?", A.purchase)],
    ['an account moved to another ledger', run("UPDATE accounts SET ledger_id = 'B' WHERE id = ?", A.account)],
    ["a refund linked to another ledger's purchase", run("INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('refund', ?, ?, 1)", A.refund, B.purchase)],
  ]
  for (const [what, write] of guards) if (!refusedByGuard(write)) problems.push(`${what} was let through`)
  try {
    transaction(A.account)()
  } catch (err) {
    problems.push(`a transaction on its own ledger's account was refused: ${(err as Error).message}`)
  }
  sqlite.exec('ROLLBACK')
  sqlite.close()
  return problems
}

/**
 * The kind of migration drizzle-kit writes to change a column: a new table, the rows copied, the
 * old table dropped and the new one renamed. The view on accounts is dropped and made again, as
 * the rules allow. SQLite refuses the rename while triggers name the old table, unless
 * `legacyRename` turns that check off. Built from the schema as shipped, so it fits after the
 * last migration.
 */
function rebuildAccounts(opts: { legacyRename?: boolean } = {}): string {
  const shipped = bareDatabase()
  const sqlOf = (name: string) => shipped.prepare('SELECT sql FROM sqlite_master WHERE name = ?').pluck().get(name) as string
  const table = sqlOf('accounts').replace(/^CREATE TABLE [`"]?accounts[`"]?/, 'CREATE TABLE `__new_accounts`')
  const view = sqlOf('ledger_accounts')
  shipped.close()
  return [
    'PRAGMA foreign_keys=OFF;',
    'DROP VIEW `ledger_accounts`;',
    `${table};`,
    'INSERT INTO `__new_accounts` SELECT * FROM `accounts`;',
    'DROP TABLE `accounts`;',
    ...(opts.legacyRename ? ['PRAGMA legacy_alter_table=ON;'] : []),
    'ALTER TABLE `__new_accounts` RENAME TO `accounts`;',
    'PRAGMA foreign_keys=ON;',
    `${view};`,
  ].join('\n--> statement-breakpoint\n')
}

describe('upgrading a database from the baseline', () => {
  it('keeps every row, foreign key, account and guard', () => {
    expect(upgradeProblems(env.migrations)).toEqual([])
  })

  it('catches a migration that rebuilds a table', () => {
    const problems = upgradeProblems(migrationsFolder(shippedJournal.entries, [{ tag: '9999_rebuild_accounts', sql: rebuildAccounts({ legacyRename: true }) }]))
    // Foreign keys stayed on, so dropping accounts cascade-deleted the rows under them. The
    // triggers on accounts went with the table.
    expect(problems).toEqual(
      expect.arrayContaining([
        'transactions@A: 5 rows before, 0 after',
        'transactions@B: 5 rows before, 0 after',
        'balance_snapshots@A: 1 rows before, 0 after',
        'import_batches@B: 1 rows before, 0 after',
        "an account with another ledger's institution was let through",
        'an account moved to another ledger was let through',
      ]),
    )
  })

  it('catches a migration that fails, and leaves the database as it was', () => {
    const problems = upgradeProblems(migrationsFolder(shippedJournal.entries, [{ tag: '9999_rebuild_accounts', sql: rebuildAccounts() }]))
    expect(problems).toEqual([expect.stringMatching(/^the migrations failed: .*RENAME TO `accounts`.* error in trigger \w+: no such table: main\.accounts$/s)])
  })

  it('opens a whole-database copy from the baseline put back by hand, with a snapshot first when it migrates', () => {
    const { file } = baselineDatabase()
    const source = new Database(file)
    const copy = snapshotDb(source, 'safety')!
    const before = rowCounts(source)
    source.close()

    const restored = tempFile('chipmunk.db')
    copyFileSync(copy, restored)
    const { sqlite } = openDatabase(restored)
    expect(sqlite.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(shippedJournal.entries.length)
    expect(lastAppliedMigration(sqlite)).toBe(shippedMigrations().last)
    expect(Object.entries(rowCounts(sqlite)).filter(([key]) => key in before)).toEqual(Object.entries(before))
    sqlite.close()
    // The baseline alone has nothing to migrate, so nothing to snapshot.
    expect(existsSync(path.join(path.dirname(restored), 'backups'))).toBe(shippedJournal.entries.length > 1)
  })
})
