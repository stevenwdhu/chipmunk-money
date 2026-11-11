import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { env } from '../env'
import * as schema from './schema'
import { installWriteGuards } from './scope'

/**
 * The one database, chipmunk.db in the data directory: every ledger's data (each row with its
 * ledger_id, or in a child table under such a row) and the app-wide tables, in one SQLite file with
 * one schema (schema.ts) and one migrations folder (drizzle/). The app keeps one connection to it.
 * What may run on that connection, and for which ledger, is scope.ts's to say.
 */

/** The database's file name in the data directory. */
export const DB_FILE = 'chipmunk.db'

/** In the file's header (PRAGMA application_id), so a file can be told apart from other SQLite files: "CHMK". */
export const APPLICATION_ID = 0x43484d4b

/** Owner-only, for the data directory and what's in it: they hold your finances. */
const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

export type DB = BetterSQLite3Database<typeof schema>
export type SQLite = Database.Database

/**
 * Opens (and migrates) chipmunk.db, or an in-memory database when `file` is null (tests). The
 * connection has the write guards (scope.ts) once it's migrated. `migrations` is another folder
 * only in tests.
 */
export function openDatabase(file: string | null, migrations = env.migrations): { sqlite: SQLite; db: DB } {
  if (file) mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR })
  const existed = !!file && existsSync(file)
  const sqlite = new Database(file ?? ':memory:')
  try {
    // Before WAL mode: SQLite gives the -wal and -shm files the database file's mode.
    if (file && !existed) keepPrivate(file)
    const empty = !sqlite.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()
    if (empty) {
      // Only before the first table: without it, deleting a ledger would never give space back,
      // and it can't be turned on later without a full VACUUM.
      sqlite.pragma('auto_vacuum = INCREMENTAL')
      sqlite.pragma(`application_id = ${APPLICATION_ID}`)
    } else if (sqlite.pragma('application_id', { simple: true }) !== APPLICATION_ID) {
      throw new Error(`${file} isn't a Chipmunk database.`)
    } else {
      // Before anything writes to the file, WAL mode included.
      checkUpgradable(sqlite, file ?? ':memory:', migrations)
    }
    if (file) sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    // So a REPLACE that deletes the row it conflicts with fires that row's DELETE triggers: the
    // write guards (scope.ts) need them to see the delete. The content triggers stop on their own
    // (each changes a row only when its value differs), so letting them recurse changes nothing.
    sqlite.pragma('recursive_triggers = ON')
    sqlite.pragma('busy_timeout = 5000')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('journal_size_limit = 67108864')
    sqlite.pragma('cache_size = -20000')
    if (hasPendingMigrations(sqlite, migrations)) snapshotDb(sqlite, 'pre-migrate')
    // drizzle splits each file at "--> statement-breakpoint" and runs each piece as one statement
    // (better-sqlite3 refuses a piece with two). It runs every pending migration in one
    // transaction with foreign keys on, where PRAGMA foreign_keys = OFF does nothing: rebuilding a
    // table cascade-deletes its children. Pending means made after the newest one the database ran,
    // by the journal's time. Hashes aren't compared, so an edited migration never runs again. The
    // rules for migrations after the baseline are checked in static.test.ts and migrations.test.ts.
    migrate(drizzle(sqlite), { migrationsFolder: migrations })
    installWriteGuards(sqlite)
  } catch (err) {
    sqlite.close()
    throw err
  }
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

/**
 * The migrations this version of the app ships with, by timestamp: the first is the baseline,
 * the last is the newest.
 */
export function shippedMigrations(folder = env.migrations): { first: number; last: number } {
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ when: number }> }
  return { first: journal.entries[0]!.when, last: journal.entries[journal.entries.length - 1]!.when }
}

/** When the newest migration a database ran was made, or null when it ran none (a new database). */
export function lastAppliedMigration(sqlite: Database.Database): number | null {
  try {
    const last = sqlite.prepare('SELECT max(created_at) FROM __drizzle_migrations').pluck().get() as number | string | null
    return last === null ? null : Number(last)
  } catch {
    return null
  }
}

/**
 * A database from before a baseline (one that ran some of the migrations squashed into it, not
 * all) can't be brought up to date: those migrations are gone, and the baseline would make tables
 * it already has.
 */
export function isTooOld(sqlite: Database.Database, folder = env.migrations): boolean {
  const last = lastAppliedMigration(sqlite)
  return last !== null && last < shippedMigrations(folder).first
}

/**
 * A database that ran a migration made after the newest this version ships (a newer version
 * opened it) can't be opened: drizzle would run nothing, and this code doesn't know its schema.
 */
export function isTooNew(sqlite: Database.Database, folder = env.migrations): boolean {
  const last = lastAppliedMigration(sqlite)
  return last !== null && last > shippedMigrations(folder).last
}

function checkUpgradable(sqlite: Database.Database, file: string, folder: string) {
  if (isTooOld(sqlite, folder)) throw new Error(`${file} is from an older version of Chipmunk that this one can't upgrade.`)
  if (isTooNew(sqlite, folder)) throw new Error(`${file} is from a newer version of Chipmunk than this one. Update the app to open it.`)
}

function hasPendingMigrations(sqlite: Database.Database, folder: string): boolean {
  // A brand-new database has nothing worth backing up.
  const last = lastAppliedMigration(sqlite)
  if (sqlite.memory || last === null) return false
  try {
    return last < shippedMigrations(folder).last
  } catch {
    return false
  }
}

/** How many free pages the daily upkeep gives back to the disk at most (8 MB of 4 KB pages). */
const DAILY_VACUUM_PAGES = 2000

/**
 * Once a day, outside any transaction: lets SQLite refresh what its query planner knows of the
 * tables (PRAGMA optimize), and gives some of the pages deleted rows freed back to the disk.
 */
export function dailyUpkeep(sqlite: Database.Database) {
  if (sqlite.inTransaction) throw new Error('The daily upkeep runs outside a transaction')
  sqlite.pragma('optimize')
  sqlite.pragma(`incremental_vacuum(${DAILY_VACUUM_PAGES})`)
}

/** data/backups, beside the database file. */
export function backupsDirFor(file: string): string {
  return path.join(path.dirname(file), 'backups')
}

function keepPrivate(file: string) {
  try {
    chmodSync(file, PRIVATE_FILE)
  } catch {
    // Not every filesystem supports modes.
  }
}

/**
 * Writes a consistent copy of the whole database to `data/backups/<label>-<time>.db` (readable by
 * you only) and returns its path. Skipped (null) for in-memory databases. Before migrations, and
 * the safety copy before deleting, erasing or seeding a ledger (safetyCopy in maintenance.ts).
 * VACUUM INTO can't run inside a transaction.
 */
export function snapshotDb(sqlite: Database.Database, label: string): string | null {
  if (sqlite.memory) return null
  const dir = backupsDirFor(sqlite.name)
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR })
  const target = path.join(dir, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
  // VACUUM INTO fills an empty file and keeps its mode, so the copy is never readable by others.
  writeFileSync(target, '', { mode: PRIVATE_FILE, flag: 'wx' })
  keepPrivate(target)
  sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  return target
}

/** User tables (everything except SQLite internals and the migrations log). */
export function appTables(sqlite: Database.Database, schemaName = 'main'): string[] {
  return (
    sqlite
      .prepare(
        `SELECT name FROM ${schemaName}.sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}
