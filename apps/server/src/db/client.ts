import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { env } from '../env'
import * as metaSchema from './meta-schema'
import * as schema from './schema'

/** Owner-only, for the data directory and what's in it: they hold your finances. */
const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

function openSqlite(file: string): Database.Database {
  const fresh = file !== ':memory:' && !existsSync(file)
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR })
  const sqlite = new Database(file)
  // Before WAL mode: SQLite gives the -wal and -shm files the database file's mode.
  if (fresh) keepPrivate(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('synchronous = NORMAL')
  return sqlite
}

/** Opens (and migrates) one ledger's database file. */
export function openLedgerDb(file: string) {
  const sqlite = openSqlite(file)
  const db = drizzle(sqlite, { schema })
  checkUpgradable(sqlite, env.ledgerMigrations, file)
  if (hasPendingMigrations(sqlite, env.ledgerMigrations)) snapshotDb(sqlite, 'pre-migrate')
  migrate(db, { migrationsFolder: env.ledgerMigrations })
  return { db, sqlite }
}

/** Opens (and migrates) the app-wide database: the ledger list and app settings. */
export function openMetaDb(file: string) {
  const sqlite = openSqlite(file)
  const db = drizzle(sqlite, { schema: metaSchema })
  checkUpgradable(sqlite, env.metaMigrations, file)
  if (hasPendingMigrations(sqlite, env.metaMigrations)) snapshotDb(sqlite, 'pre-migrate-meta')
  migrate(db, { migrationsFolder: env.metaMigrations })
  return { db, sqlite }
}

export type DB = ReturnType<typeof openLedgerDb>['db']
export type MetaDB = ReturnType<typeof openMetaDb>['db']
export type SQLite = Database.Database

/**
 * The migrations this version of the app ships with (ledger schema by default), by timestamp: the
 * first is the baseline the earlier ones were squashed into, the last is the newest.
 */
export function shippedMigrations(folder = env.ledgerMigrations): { first: number; last: number } {
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
 * A database from before the migrations were squashed (one that ran some of them, not all) can't be
 * brought up to date: its migrations are gone, and the baseline would make tables it already has.
 */
export function isTooOld(sqlite: Database.Database, folder = env.ledgerMigrations): boolean {
  const last = lastAppliedMigration(sqlite)
  return last !== null && last < shippedMigrations(folder).first
}

function checkUpgradable(sqlite: Database.Database, folder: string, file: string) {
  if (isTooOld(sqlite, folder)) {
    sqlite.close()
    throw new Error(`${file} is from an older version of Chipmunk that this one can't upgrade. Upgrade it with a version from before November 2026 first.`)
  }
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

/** data/backups for files in data/ and in data/ledgers/. */
export function backupsDirFor(file: string): string {
  const dir = path.dirname(file)
  return path.join(path.basename(dir) === 'ledgers' ? path.dirname(dir) : dir, 'backups')
}

function keepPrivate(file: string) {
  try {
    chmodSync(file, PRIVATE_FILE)
  } catch {
    // Not every filesystem supports modes.
  }
}

/**
 * Writes a consistent copy of the database to `data/backups/<label>-<time>.db` (readable by you
 * only) and returns its path. Skipped (null) for in-memory databases.
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
