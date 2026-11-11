import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { snapshotDb, type SQLite } from './client'
import { ledgerMaintenance } from './scope'
import { deleteLedgerRows } from './tables'

/**
 * Work on all of a ledger's rows at once (erasing it, clearing it for the demo), giving freed
 * pages back to the disk, and copies of the whole database: the full backup (databaseCopy) and
 * the safety copy taken before deleting, erasing or seeding a ledger (safetyCopy). There's no copy
 * of one ledger: a backup is always the whole database.
 */

const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

function keepPrivate(file: string) {
  try {
    chmodSync(file, PRIVATE_FILE)
  } catch {
    // Not every filesystem supports modes.
  }
}

/** A new private folder for temporary files: under DATA_DIR/.tmp, or the system's for an in-memory database. */
function tempDir(sqlite: SQLite): string {
  const root = sqlite.memory ? tmpdir() : path.join(path.dirname(sqlite.name), '.tmp')
  mkdirSync(root, { recursive: true, mode: PRIVATE_DIR })
  return mkdtempSync(path.join(root, 'chipmunk-'))
}

/** An empty file only you can read. */
function privateFile(file: string) {
  writeFileSync(file, '', { mode: PRIVATE_FILE, flag: 'wx' })
  keepPrivate(file)
}

/**
 * The safety copy before deleting, erasing or seeding a ledger: the whole database, every ledger
 * and the sealed bank sign-ins included, as data/backups/<label>-<time>.db (snapshotDb). Returns
 * its path. Skipped (null) for an in-memory database, and inside a transaction: a dry run runs the
 * whole handler in one, where VACUUM INTO can't run, and a dry run changes nothing anyway. Take it
 * before the action's own transaction.
 */
export function safetyCopy(sqlite: SQLite, label: string): string | null {
  if (sqlite.inTransaction) return null
  return snapshotDb(sqlite, label)
}

/**
 * Deletes a ledger's data but its ledger settings and activity log, and forgets that it was set
 * up. Every shared category is on again (its ledger_category_off rows go). Then the freed pages go
 * back to the disk.
 */
export function eraseLedger(sqlite: SQLite, ledgerId: string, setupKey: string) {
  ledgerMaintenance(sqlite, ledgerId, () =>
    sqlite.transaction(() => {
      deleteLedgerRows(sqlite, ledgerId, { keep: ['ledger_settings', 'activity'] })
      sqlite.prepare('DELETE FROM ledger_settings WHERE ledger_id = ? AND key = ?').run(ledgerId, setupKey)
    })(),
  )
  reclaimSpace(sqlite)
}

/** Clears a ledger for the demo data: its rows go, but these tables' (its settings, activity, categories). */
export function clearLedger(sqlite: SQLite, ledgerId: string, keep: readonly string[]) {
  ledgerMaintenance(sqlite, ledgerId, () => sqlite.transaction(() => deleteLedgerRows(sqlite, ledgerId, { keep }))())
}

/** Gives freed pages back to the disk (the database is auto_vacuum = INCREMENTAL). Only after a real commit: inside a transaction (a dry run) it does nothing. */
export function reclaimSpace(sqlite: SQLite) {
  if (sqlite.inTransaction) return
  sqlite.pragma('incremental_vacuum')
  if (!sqlite.memory) sqlite.pragma('wal_checkpoint(TRUNCATE)')
}

/** A consistent copy of the whole database (VACUUM INTO a private temp file), as bytes: the full backup. */
export function databaseCopy(sqlite: SQLite): Uint8Array {
  const dir = tempDir(sqlite)
  try {
    const file = path.join(dir, 'chipmunk.db')
    // VACUUM INTO fills an empty file and keeps its mode.
    privateFile(file)
    sqlite.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
    return new Uint8Array(readFileSync(file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
