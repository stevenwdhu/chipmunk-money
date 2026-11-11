import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { HTTPException } from 'hono/http-exception'
import { env } from '../env'
import { badRequest } from '../lib/http'
import { APPLICATION_ID, backupsDirFor, isTooOld, lastAppliedMigration, shippedMigrations, type SQLite } from './client'
import { ledgerMaintenance } from './scope'
import { deleteLedgerRows, TABLES, tableDef } from './tables'

/**
 * One ledger's backup: a SQLite file with the app's schema (and its application_id) that holds one
 * ledger. In it:
 * - the ledger's row, and every row of its data with their ids (activity, ledger settings, its
 *   AI calls and the categories it turned off included)
 * - the category list it uses: its own, or the shared list's rows (ledger_id null) with the shared
 *   list's token in app_settings, so a restore here can keep the category ids
 * Nothing app-wide besides the token: no API keys, bank connections, other app settings or secrets.
 *
 * The same file is the "Download backup", and the safety copy taken before a restore, an erase,
 * deleting a ledger and `seed:demo --force`. Only migrations copy the whole database (snapshotDb),
 * and the full backup (databaseCopy).
 */

const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600
const TOKEN_KEY = 'categories.catalog'
const SQLITE_HEADER = 'SQLite format 3\u0000'

type Row = Record<string, unknown>

const NOT_A_BACKUP_FILE = "That file isn't a Chipmunk backup. Choose the .db file from Settings → Data → Download backup."
const NOT_A_BACKUP_DB = "That database isn't a Chipmunk backup."
const WHOLE_DATABASE = 'That file is a whole Chipmunk database, not one ledger’s backup. Choose the .db file from Settings → Data → Download backup.'
const NEWER = 'This backup comes from a newer version of Chipmunk. Update the app, then try again.'
const OLDER = "This backup comes from an older version of Chipmunk that this one can't upgrade. Restore it with a version from before November 2026 first."
const INCONSISTENT = 'That backup has inconsistent data, so nothing was changed.'

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
function privateFile(file: string, bytes: Uint8Array | string = '') {
  writeFileSync(file, bytes, { mode: PRIVATE_FILE, flag: 'wx' })
  keepPrivate(file)
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

// Tables ---------------------------------------------------------------------------

/** The tables a ledger's rows are in, in insert order: links before transactions, so the content triggers find nothing to change. */
function copyOrder(): string[] {
  const names = TABLES.filter((t) => t.kind !== 'app').map((t) => t.name)
  const links = names.indexOf('transaction_links')
  names.splice(links, 1)
  names.splice(names.indexOf('transactions'), 0, 'transaction_links')
  return names
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`

function columnsOf(db: SQLite, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string }>).map((c) => c.name)
}

interface Ref {
  /** The table it refers to. */
  table: string
  /** What deleting the row it refers to does to this one: 'SET NULL', 'CASCADE' or another action. */
  onDelete: string
}

/** Which table each integer column refers to: its foreign keys, and transfer_pair_id. */
function refsOf(db: SQLite, table: string): Map<string, Ref> {
  const refs = new Map<string, Ref>()
  for (const fk of db.prepare(`PRAGMA foreign_key_list(${q(table)})`).all() as Array<{ from: string; table: string; on_delete: string }>) {
    if (fk.table !== 'ledgers') refs.set(fk.from, { table: fk.table, onDelete: fk.on_delete.toUpperCase() })
  }
  if (table === 'transactions') refs.set('transfer_pair_id', { table: 'transactions', onDelete: 'SET NULL' })
  return refs
}

function hasIntegerId(db: SQLite, table: string): boolean {
  return (db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string; type: string; pk: number }>).some(
    (c) => c.name === 'id' && c.pk === 1 && c.type.toUpperCase() === 'INTEGER',
  )
}

/**
 * Which of a table's rows belong to the ledger @ledger: its own rows, the shared list's too when
 * `shared` (category tables), and a child's rows through its parents.
 */
function whereOf(table: string, shared: boolean): string {
  const t = tableDef(table)!
  if (t.kind === 'ledger') return 'ledger_id = @ledger'
  if (t.kind === 'catalog') return shared ? '(ledger_id = @ledger OR ledger_id IS NULL)' : 'ledger_id = @ledger'
  return t.parents!.map((p) => `${q(p.column)} IN (SELECT id FROM ${q(p.table)} WHERE ${whereOf(p.table, shared)})`).join(' OR ')
}

// Export ---------------------------------------------------------------------------

/** A new, migrated file with the app's schema, for a ledger's rows. */
function newBackupFile(file: string): SQLite {
  privateFile(file)
  const db = new Database(file)
  try {
    db.pragma(`application_id = ${APPLICATION_ID}`)
    db.pragma('foreign_keys = ON')
    migrate(drizzle(db), { migrationsFolder: env.migrations })
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

/** Copies one ledger's rows from the database into a new backup file. */
function writeExport(sqlite: SQLite, ledgerId: string, file: string) {
  const ledger = sqlite.prepare('SELECT * FROM ledgers WHERE id = ?').get(ledgerId) as Row | undefined
  if (!ledger) throw new HTTPException(404, { message: `There's no ledger called “${ledgerId}”` })
  const shared = ledger.category_list === 'shared'
  const dst = newBackupFile(file)
  try {
    const insert = (table: string, columns: string[], rows: Iterable<Row>) => {
      const stmt = dst.prepare(`INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      for (const row of rows) stmt.run(...columns.map((c) => row[c]))
    }
    // One read transaction here, so the copy is of one moment.
    const copy = () =>
      dst.transaction(() => {
        // Rows go in out of order (links before the transactions they link): checked at commit.
        dst.pragma('defer_foreign_keys = ON')
        insert('ledgers', columnsOf(sqlite, 'ledgers'), [ledger])
        if (shared) insert('app_settings', ['key', 'value', 'updated_at'], sqlite.prepare('SELECT * FROM app_settings WHERE key = ?').all(TOKEN_KEY) as Row[])
        for (const table of copyOrder()) {
          const columns = columnsOf(sqlite, table)
          // In rowid order, so a table's rows keep their order (what was learned first wins a tie).
          insert(table, columns, sqlite.prepare(`SELECT * FROM ${q(table)} WHERE ${whereOf(table, shared)} ORDER BY rowid`).iterate({ ledger: ledgerId }) as Iterable<Row>)
        }
      })()
    sqlite.inTransaction ? copy() : sqlite.transaction(copy)()
  } finally {
    dst.close()
  }
}

/** One ledger's backup, as the bytes of its file. */
export function exportLedger(sqlite: SQLite, ledgerId: string): Uint8Array {
  const dir = tempDir(sqlite)
  try {
    const file = path.join(dir, 'ledger.db')
    writeExport(sqlite, ledgerId, file)
    return new Uint8Array(readFileSync(file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Saves one ledger's backup as data/backups/<label>-<time>.db (readable by you only) and returns
 * its path: the safety copy before a restore, an erase or deleting a ledger. Skipped (null) for an
 * in-memory database.
 */
export function saveLedgerExport(sqlite: SQLite, ledgerId: string, label: string): string | null {
  if (sqlite.memory) return null
  const dir = tempDir(sqlite)
  try {
    const file = path.join(dir, 'ledger.db')
    writeExport(sqlite, ledgerId, file)
    const backups = backupsDirFor(sqlite.name)
    mkdirSync(backups, { recursive: true, mode: PRIVATE_DIR })
    const target = path.join(backups, `${label}-${stamp()}.db`)
    renameSync(file, target)
    return target
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Import ---------------------------------------------------------------------------

/** How a backup's categories come in. */
export type CategoryPath =
  /**
   * Its ledger uses the shared list, this install's (the token matches): by id. A category the list
   * no longer has is gone from the restore too: its transactions and recurring items come in
   * uncategorized, the rest of its rows don't come in, and the list stays as it is.
   */
  | 'id'
  /** Its ledger used a shared list that isn't this one's: as the ledger's own, then matched to this list by name. */
  | 'name'
  /** Its ledger has its own list: as it is. */
  | 'own'

/** An uploaded backup, checked and brought up to this version's schema, in a temp file. Close it when done. */
export interface LedgerBackup {
  /** The backup's ledger id (rows in it carry it). */
  ledgerId: string
  categoryList: 'shared' | 'own'
  /** How its categories would come into this database now. */
  categoryPath(sqlite: SQLite): CategoryPath
  /** The names of the categories it uses. */
  categoryNames(): string[]
  /** Removes the temp file. */
  close(): void
  /** @internal */
  db: SQLite
}

/**
 * Checks an uploaded file is one ledger's backup (a SQLite file with Chipmunk's application_id,
 * holding one ledger, from this version or an older one it can upgrade), and copies it to a temp
 * file brought up to the current schema. A bad file throws a 400 and leaves no temp file behind.
 */
export function readLedgerBackup(sqlite: SQLite, bytes: Uint8Array): LedgerBackup {
  if (bytes.byteLength < 100 || Buffer.from(bytes.subarray(0, 16)).toString('latin1') !== SQLITE_HEADER) badRequest(NOT_A_BACKUP_FILE)
  const dir = tempDir(sqlite)
  let db: SQLite | null = null
  try {
    const file = path.join(dir, 'restore.db')
    privateFile(file, bytes)
    db = new Database(file)
    const src = db
    let ledger: { id: string; category_list: string }
    try {
      if (src.pragma('application_id', { simple: true }) !== APPLICATION_ID) badRequest(NOT_A_BACKUP_DB)
      const last = lastAppliedMigration(src)
      if (last === null) badRequest(NOT_A_BACKUP_DB)
      if (last > shippedMigrations().last) badRequest(NEWER)
      if (isTooOld(src)) badRequest(OLDER)
      migrate(drizzle(src), { migrationsFolder: env.migrations })
      const ledgers = src.prepare('SELECT id, category_list FROM ledgers').all() as Array<{ id: string; category_list: string }>
      if (ledgers.length > 1) badRequest(WHOLE_DATABASE)
      if (!ledgers[0]) badRequest(NOT_A_BACKUP_DB)
      ledger = ledgers[0]
    } catch (err) {
      if (err instanceof HTTPException) throw err
      // Not a database, or not one of ours (a damaged file, another app's tables).
      badRequest(NOT_A_BACKUP_DB)
    }
    const shared = ledger.category_list === 'shared'
    const backup: LedgerBackup = {
      ledgerId: ledger.id,
      categoryList: shared ? 'shared' : 'own',
      db: src,
      categoryPath(main) {
        if (!shared) return 'own'
        const token = (t: SQLite) => t.prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(TOKEN_KEY) as string | undefined
        const mine = token(main)
        // This install's list, even if some of its categories have gone since (their transactions come in uncategorized).
        return mine && token(src) === mine ? 'id' : 'name'
      },
      categoryNames() {
        return src.prepare(`SELECT name FROM categories WHERE ${whereOf('categories', shared)} ORDER BY id`).pluck().all({ ledger: ledger.id }) as string[]
      },
      close() {
        src.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
    return backup
  } catch (err) {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

/** The largest id a JS number holds exactly: a backup's ids above it (or below 1) are refused. */
const MAX_ID = Number.MAX_SAFE_INTEGER

/**
 * How a backup's ids come in, table by table. Ids are global across ledgers, so the file never
 * decides where this database's ids continue:
 * - A table keeps its ids when none of its rows' ids is taken here and every id it has or names
 *   (in reports, the activity log, transfer pairs) is one this database has handed out already
 *   (no more than its sqlite_sequence): restoring your own backup, or a deleted ledger's.
 * - Otherwise its ids are numbered again from past every id the table has had here, in their
 *   order, ids it only names (a deleted tag a report still names) included, so those aren't
 *   handed out to anything else. The table's sequence moves up by as many ids as that, no more.
 * The file's own sqlite_sequence is never read. On the id path the shared list's ids are kept as
 * they are.
 */
interface IdPlan {
  map(table: string, id: number): number
  /** Tables whose ids were numbered again, with the sequence each now needs. */
  moved: Map<string, number>
  /** Activity entries this ledger already has (the same ones, by id). */
  sameActivity: Set<number>
}

function planIds(
  main: SQLite,
  src: SQLite,
  backupLedger: string,
  target: string,
  rowIds: Map<string, Set<number>>,
  named: Map<string, Set<number>>,
  shared: Map<string, Set<number>>,
): IdPlan {
  const maps = new Map<string, Map<number, number>>()
  const moved = new Map<string, number>()
  const sameActivity = new Set<number>()
  for (const [table, own] of rowIds) {
    const all = new Set(own)
    for (const id of named.get(table) ?? []) if (!shared.get(table)?.has(id)) all.add(id)
    if (!all.size) continue
    const sorted = [...all].sort((x, y) => x - y)
    const json = JSON.stringify([...own])
    let taken = false
    if (table === 'activity') {
      // The log is kept through a restore: an entry it already has (the same one, in this ledger) isn't a clash.
      const theirs = new Map(
        (src.prepare('SELECT id, created_at, action, summary FROM activity WHERE ledger_id = ?').all(backupLedger) as Row[]).map((r) => [r.id as number, r]),
      )
      for (const r of main.prepare('SELECT id, ledger_id, created_at, action, summary FROM activity WHERE id IN (SELECT value FROM json_each(?))').all(json) as Row[]) {
        const t = theirs.get(r.id as number)
        if (t && r.ledger_id === target && r.created_at === t.created_at && r.action === t.action && r.summary === t.summary) sameActivity.add(r.id as number)
        else taken = true
      }
    } else {
      taken = !!main.prepare(`SELECT 1 FROM ${q(table)} WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(json)
    }
    const seq = (main.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').pluck().get(table) as number | undefined) ?? 0
    if (!taken && sorted[0]! >= 1 && sorted[sorted.length - 1]! <= seq) continue
    const max = (main.prepare(`SELECT max(id) FROM ${q(table)}`).pluck().get() as number | null) ?? 0
    const base = Math.max(seq, max)
    maps.set(table, new Map(sorted.map((id, i) => [id, base + i + 1])))
    moved.set(table, base + sorted.length)
  }
  // A clash moves the whole table, so the activity it already has can't be told apart by id any more.
  if (moved.has('activity')) sameActivity.clear()
  return {
    moved,
    sameActivity,
    map: (table, id) => (shared.get(table)?.has(id) ? id : (maps.get(table)?.get(id) ?? id)),
  }
}

export interface ImportResult {
  /** Tables whose ids were numbered again (none when the backup's ids were free here). */
  moved: string[]
}

/**
 * Replaces one ledger's data with a backup's, in one transaction in that ledger's write scope:
 * - Its rows go, except the activity log (which records the restore, and keeps entries the backup
 *   has too).
 * - The backup's rows come in with their ids, or numbered again past every id here (planIds),
 *   with the ids inside custom reports and the activity log moved to match.
 * - Links go in before transactions, so the content triggers change nothing (a refund renamed
 *   apart from its bill keeps its name).
 * - Categories follow `categoryPath`: by id, as the ledger's own, or (`joinShared`, the shared list
 *   by name) as its own and then joined to the shared list, which can add to it.
 * A file whose rows don't fit together, or whose ids aren't ones a JS number holds, changes nothing (400).
 */
export function importLedger(sqlite: SQLite, ledgerId: string, backup: LedgerBackup, opts: { joinShared: () => void }): ImportResult {
  const src = backup.db
  const route = backup.categoryPath(sqlite)
  const readShared = route === 'name'
  const tables = copyOrder().filter((t) => !(route === 'name' && t === 'ledger_category_off'))
  // On the id path the shared list's rows are this install's: they stay as they are, and the ones
  // it no longer has are gone.
  const shared = new Map<string, Set<number>>()
  const gone = new Map<string, Set<number>>()
  if (route === 'id') {
    for (const t of ['category_groups', 'categories', 'labels']) {
      const ids = src.prepare(`SELECT id FROM ${q(t)} WHERE ledger_id IS NULL`).pluck().all() as number[]
      const here = new Set(sqlite.prepare(`SELECT id FROM ${q(t)} WHERE ledger_id IS NULL AND id IN (SELECT value FROM json_each(?))`).pluck().all(JSON.stringify(ids)) as number[])
      shared.set(t, new Set(ids))
      gone.set(t, new Set(ids.filter((id) => !here.has(id))))
    }
  }
  const off =
    route === 'name'
      ? new Map((src.prepare('SELECT category_id, archived_at FROM ledger_category_off WHERE ledger_id = ?').all(backup.ledgerId) as Row[]).map((r) => [r.category_id as number, r.archived_at]))
      : new Map<number, unknown>()

  const shapes = new Map(
    tables.map((table) => [table, { columns: columnsOf(sqlite, table), refs: refsOf(sqlite, table), intId: hasIntegerId(sqlite, table), def: tableDef(table)! }]),
  )
  const rowsOf = (table: string) => src.prepare(`SELECT * FROM ${q(table)} WHERE ${whereOf(table, readShared)} ORDER BY rowid`).iterate({ ledger: backup.ledgerId }) as Iterable<Row>

  /** A backup row as it goes in here, with `map` for its ids (null: it doesn't come in). `json`: the ids inside its JSON too. */
  const rowFor = (table: string, row: Row, map: (table: string, id: number) => number, json: boolean): Row | null => {
    const { refs, intId, def } = shapes.get(table)!
    const out: Row = { ...row }
    if (def.kind !== 'child') out.ledger_id = ledgerId
    if (intId) out.id = map(table, row.id as number)
    for (const [col, ref] of refs) {
      const v = row[col]
      if (typeof v !== 'number') continue
      if (gone.get(ref.table)?.has(v)) {
        // A category the shared list no longer has: as deleting it would have done.
        if (ref.onDelete !== 'SET NULL') return null
        out[col] = null
        if (table === 'transactions' && col === 'category_id') Object.assign(out, { category_source: null, category_confidence: null, needs_review: 0 })
      } else {
        out[col] = map(ref.table, v)
      }
    }
    if (table === 'categories' && route === 'name' && row.ledger_id === null) out.archived_at = off.get(row.id as number) ?? null
    if (!json) return out
    const maps: IdMaps = { id: (kind, id) => map(KIND_TABLE[kind], id) }
    if (table === 'custom_reports') out.spec = remapText(row.spec, (v) => remapSpec(v, maps))
    if (table === 'activity') {
      const at = { entity: String(row.entity), action: String(row.action) }
      out.entity_id = remapEntityId(row.entity_id, maps, at)
      out.before = remapText(row.before, (v) => remapActivityValue(v, maps, at))
      out.after = remapText(row.after, (v) => remapActivityValue(v, maps, at))
    }
    return out
  }

  // Every id the backup's rows have, and every one they name, table by table.
  const rowIds = new Map<string, Set<number>>()
  const named = new Map<string, Set<number>>()
  for (const table of tables) {
    if (!shapes.get(table)!.intId) continue
    if (src.prepare(`SELECT 1 FROM ${q(table)} WHERE typeof(id) <> 'integer' OR id < 1 OR id > ${MAX_ID} LIMIT 1`).get()) badRequest(INCONSISTENT)
    const ids = new Set(src.prepare(`SELECT id FROM ${q(table)} WHERE ${whereOf(table, readShared)}`).pluck().all({ ledger: backup.ledgerId }) as number[])
    for (const id of shared.get(table) ?? []) ids.delete(id)
    rowIds.set(table, ids)
  }
  const note = (table: string, id: number) => {
    if (!rowIds.has(table) || !Number.isSafeInteger(id) || id < 1) return id
    let set = named.get(table)
    if (!set) named.set(table, (set = new Set()))
    set.add(id)
    return id
  }
  for (const table of tables) for (const row of rowsOf(table)) rowFor(table, row, note, true)

  try {
    return ledgerMaintenance(sqlite, ledgerId, () =>
      sqlite.transaction(() => {
        // Rows go in out of order (links before the transactions they link): checked at commit, and below.
        sqlite.pragma('defer_foreign_keys = ON')
        deleteLedgerRows(sqlite, ledgerId, { keep: ['activity'] })
        sqlite.prepare("UPDATE ledgers SET category_list = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(route === 'id' ? 'shared' : 'own', ledgerId)

        const plan = planIds(sqlite, src, backup.ledgerId, ledgerId, rowIds, named, shared)
        const moved = plan.moved.size > 0
        for (const table of tables) {
          const { columns } = shapes.get(table)!
          const conflict = table === 'activity' && plan.sameActivity.size ? ' ON CONFLICT (id) DO NOTHING' : ''
          const stmt = sqlite.prepare(`INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})${conflict}`)
          for (const row of rowsOf(table)) {
            const out = rowFor(table, row, plan.map, moved)
            if (out) stmt.run(...columns.map((c) => out[c]))
          }
        }

        // Ids numbered again that only a report or the activity log names aren't handed out to anything else.
        for (const [name, seq] of plan.moved) {
          if (!sqlite.prepare('UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?').run(seq, name).changes) {
            sqlite.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq)
          }
        }
        for (const table of tables) {
          if ((sqlite.pragma(`foreign_key_check(${q(table)})`) as unknown[]).length) badRequest(INCONSISTENT)
        }
        if (route === 'name') opts.joinShared()
        return { moved: [...plan.moved.keys()] }
      })(),
    )
  } catch (err) {
    // A guard trigger (a row pointing into another ledger) or a constraint the rows break.
    if (err instanceof Database.SqliteError && /^SQLITE_CONSTRAINT/.test(err.code)) badRequest(INCONSISTENT)
    throw err
  }
}

// Erase, delete, the whole database --------------------------------------------------

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

/** Gives freed pages back to the disk (the database is auto_vacuum = INCREMENTAL). */
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

// Ids inside JSON ------------------------------------------------------------------
// When a backup's ids move, so do the ids its custom reports and activity log name. A walk over
// the raw JSON (never re-parsed through zod, which would add defaults), rewriting only the ids it
// knows by place.

/** What an id names, and the table its rows are in. */
const KIND_TABLE = {
  transaction: 'transactions',
  account: 'accounts',
  institution: 'institutions',
  category: 'categories',
  group: 'category_groups',
  label: 'labels',
  tag: 'tags',
  recurring: 'recurring_items',
  custom_report: 'custom_reports',
  import: 'import_batches',
  link: 'transaction_links',
  snapshot: 'balance_snapshots',
} as const
type IdKind = keyof typeof KIND_TABLE

interface IdMaps {
  id(kind: IdKind, id: number): number
}

interface ActivityAt {
  entity: string
  action: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** JSON text with its ids rewritten; text that isn't JSON stays as it is. */
function remapText(text: unknown, fn: (v: unknown) => unknown): unknown {
  if (typeof text !== 'string') return text
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return text
  }
  return JSON.stringify(fn(value))
}

const CONDITION_KIND: Record<string, IdKind> = { category: 'category', group: 'group', label: 'label', tag: 'tag', account: 'account', recurring: 'recurring' }

function mapIds(ids: unknown, kind: IdKind, maps: IdMaps): unknown {
  return Array.isArray(ids) ? ids.map((v) => (isInt(v) ? maps.id(kind, v) : v)) : ids
}

function remapCondition(c: unknown, maps: IdMaps): unknown {
  if (!isObj(c) || typeof c.field !== 'string') return c
  const kind = CONDITION_KIND[c.field]
  // recurring's ids may be 'any' or 'none' instead of a list.
  if (!kind || !Array.isArray(c.ids)) return c
  return { ...c, ids: mapIds(c.ids, kind, maps) }
}

function remapSide(s: unknown, maps: IdMaps): unknown {
  if (!isObj(s)) return s
  const out: Obj = { ...s }
  if (Array.isArray(s.only)) out.only = s.only.map((c) => remapCondition(c, maps))
  // A rule's `label` is what you call it, not a label id.
  if (Array.isArray(s.filterOut)) out.filterOut = s.filterOut.map((r) => (isObj(r) && Array.isArray(r.when) ? { ...r, when: r.when.map((c) => remapCondition(c, maps)) } : r))
  if ('picked' in s) out.picked = mapIds(s.picked, 'transaction', maps)
  if ('keep' in s) out.keep = mapIds(s.keep, 'transaction', maps)
  return out
}

function remapFilter(f: unknown, maps: IdMaps): unknown {
  if (!isObj(f)) return f
  const out: Obj = { ...f }
  for (const side of ['spending', 'income']) if (side in f) out[side] = remapSide(f[side], maps)
  return out
}

function remapNames(names: unknown, maps: IdMaps): unknown {
  if (!isObj(names)) return names
  const out: Obj = {}
  for (const [kind, byId] of Object.entries(names)) {
    const idKind = CONDITION_KIND[kind]
    if (!idKind || !isObj(byId)) {
      out[kind] = byId
      continue
    }
    out[kind] = Object.fromEntries(Object.entries(byId).map(([key, name]) => [/^\d+$/.test(key) ? String(maps.id(idKind, Number(key))) : key, name]))
  }
  return out
}

function remapSpec(spec: unknown, maps: IdMaps): unknown {
  if (!isObj(spec)) return spec
  const out: Obj = { ...spec }
  if ('filter' in spec) out.filter = remapFilter(spec.filter, maps)
  if ('names' in spec) out.names = remapNames(spec.names, maps)
  return out
}

/** The kind of row an entry is about; ledger and payee entries name no row by number. */
const ENTITY_KIND: Record<string, IdKind | null> = {
  transaction: 'transaction',
  account: 'account',
  institution: 'institution',
  category: 'category',
  category_group: 'group',
  label: 'label',
  tag: 'tag',
  recurring: 'recurring',
  custom_report: 'custom_report',
  import: 'import',
  ledger: null,
  payee: null,
}
/** Keys that hold one id of a kind, wherever they are. */
const KEY_KIND: Record<string, IdKind> = {
  accountId: 'account',
  institutionId: 'institution',
  recurringItemId: 'recurring',
  tagId: 'tag',
  batchId: 'import',
  importBatchId: 'import',
  categoryId: 'category',
  groupId: 'group',
  transferPairId: 'transaction',
  transactionId: 'transaction',
  moneyInId: 'transaction',
  moneyOutId: 'transaction',
}
/** Keys that hold a list of ids of a kind. */
const KEY_LIST_KIND: Record<string, IdKind> = { tagIds: 'tag', labelIds: 'label', categoryIds: 'category', transactionIds: 'transaction' }
/** Lists of objects whose `id` is of a kind: a transaction's tags and links. */
const NESTED_KIND: Record<string, IdKind> = { tags: 'tag', links: 'link' }
/** Ids that aren't a ledger's rows (app-wide, or text), and values copied as they are (a CSV mapping, what a bank sent). */
const LEAVE = new Set(['payeeNameRule', 'ruleId', 'connectionId', 'bankAccountId', 'ledgerId', 'ledgerIds', 'apiKeyId', 'importMapping', 'payload'])

function remapEntityId(value: unknown, maps: IdMaps, at: ActivityAt): unknown {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return value
  const kind = ENTITY_KIND[at.entity]
  return kind ? String(maps.id(kind, Number(value))) : value
}

function remapActivityValue(value: unknown, maps: IdMaps, at: ActivityAt): unknown {
  // A deleted balance's id is a snapshot's.
  const kind = at.action === 'delete_balance' ? 'snapshot' : (ENTITY_KIND[at.entity] ?? null)
  if (Array.isArray(value) && value.length && value.every(isInt)) {
    // Reorder entries log the ids in their new order.
    const entityKind = ENTITY_KIND[at.entity]
    return at.action === 'reorder' && entityKind ? value.map((n) => maps.id(entityKind, n as number)) : value
  }
  return walk(value, kind, maps, at)
}

/** Which kind a key that depends on the entry names: moveTo and into are the entity's own kind, a label's add and remove are categories. */
function byEntity(key: string, at: ActivityAt): IdKind | 'list:category' | null {
  if (key === 'moveTo' || key === 'into') {
    const k = ENTITY_KIND[at.entity]
    return k === 'category' || k === 'group' || k === 'institution' ? k : null
  }
  if ((key === 'add' || key === 'remove') && at.entity === 'label') return 'list:category'
  return null
}

function walk(value: unknown, idKind: IdKind | null, maps: IdMaps, at: ActivityAt): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, idKind, maps, at))
  if (!isObj(value)) return value
  const out: Obj = {}
  for (const [key, v] of Object.entries(value)) {
    const entity = byEntity(key, at)
    if (LEAVE.has(key)) out[key] = v
    else if (key === 'id') out[key] = idKind && isInt(v) ? maps.id(idKind, v) : v
    else if (key in KEY_KIND) out[key] = isInt(v) ? maps.id(KEY_KIND[key]!, v) : v
    else if (key in KEY_LIST_KIND) out[key] = mapIds(v, KEY_LIST_KIND[key]!, maps)
    else if (key in NESTED_KIND && Array.isArray(v)) out[key] = v.map((x) => walk(x, NESTED_KIND[key]!, maps, at))
    else if (key === 'spec') out[key] = remapSpec(v, maps)
    else if (key === 'filter' && at.entity === 'custom_report') out[key] = remapFilter(v, maps)
    else if (entity === 'list:category') out[key] = mapIds(v, 'category', maps)
    else if (entity) out[key] = isInt(v) ? maps.id(entity, v) : v
    // Something else nested (a bank link, a possible payment): its own `id` isn't the entity's.
    else if (isObj(v) || Array.isArray(v)) out[key] = walk(v, null, maps, at)
    else out[key] = v
  }
  return out
}
