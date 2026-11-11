import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { HTTPException } from 'hono/http-exception'
import type { SetupStatus } from '@chipmunk/shared'
import { appTables, isTooOld, lastAppliedMigration, shippedMigrations, snapshotDb } from '../db/client'
import { loadDemo } from '../db/seed-demo'
import { env } from '../env'
import { badRequest } from '../lib/http'
import { syncLedgerCategories, wouldAddToSharedList } from './catalog'
import type { AppContext } from './context'
import { unlinkBankAccounts } from './accounts'
import { dropAppSettings, getLedgerSetting, setLedgerSetting } from './settings'

const SETUP_KEY = 'setup.completed'
const SQLITE_HEADER = 'SQLite format 3\u0000'

function counts(ctx: AppContext) {
  const row = ctx.sqlite
    .prepare('SELECT (SELECT count(*) FROM accounts) AS accounts, (SELECT count(*) FROM transactions) AS transactions')
    .get() as { accounts: number; transactions: number }
  return row
}

export function setupStatus(ctx: AppContext): SetupStatus {
  const c = counts(ctx)
  const done = getLedgerSetting<boolean>(ctx, SETUP_KEY, false)
  return { needsSetup: !done && c.accounts === 0 && c.transactions === 0, ...c }
}

function complete(ctx: AppContext) {
  setLedgerSetting(ctx, SETUP_KEY, true)
}

/** "Start from scratch": nothing to load, just remember the choice. */
export function startEmpty(ctx: AppContext): SetupStatus {
  complete(ctx)
  return setupStatus(ctx)
}

export function startDemo(ctx: AppContext) {
  const { accounts, transactions } = counts(ctx)
  if (accounts || transactions) {
    throw new HTTPException(409, { message: 'There is already data here. Erase it in Settings → Data before loading the demo.' })
  }
  const result = loadDemo(ctx)
  complete(ctx)
  return result
}

/**
 * Replaces every table with the contents of an uploaded backup. The backup is copied to a temp
 * file, upgraded to the current schema, then copied in table by table inside one transaction, so
 * a bad file leaves the current data untouched. The current data is snapshotted first. Without
 * `addCategories` (a key limited to some ledgers), a backup that would add to the shared category list is refused.
 */
export function restoreBackup(ctx: AppContext, bytes: Uint8Array, opts: { addCategories: boolean } = { addCategories: true }) {
  if (bytes.byteLength < 100 || Buffer.from(bytes.subarray(0, 16)).toString('latin1') !== SQLITE_HEADER) {
    badRequest("That file isn't a Chipmunk backup. Choose the .db file from Settings → Data → Download backup.")
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'st-restore-'))
  const file = path.join(dir, 'restore.db')
  writeFileSync(file, bytes)
  let attached = false
  try {
    const src = new Database(file)
    try {
      const tables = appTables(src)
      if (!tables.includes('accounts') || !tables.includes('transactions')) {
        badRequest("That database isn't a Chipmunk backup.")
      }
      if ((lastAppliedMigration(src) ?? 0) > shippedMigrations().last) {
        badRequest('This backup comes from a newer version of Chipmunk. Update the app, then try again.')
      }
      if (isTooOld(src)) {
        badRequest("This backup comes from an older version of Chipmunk that this one can't upgrade. Restore it with a version from before November 2026 first.")
      }
      // Bring older backups up to the current schema before copying.
      migrate(drizzle(src), { migrationsFolder: env.ledgerMigrations })
      if (!opts.addCategories && wouldAddToSharedList(ctx.meta, src)) {
        throw new HTTPException(403, {
          message: 'This backup has categories the shared list doesn’t, and a key limited to some ledgers can’t add to it. Restore it in the app.',
        })
      }
    } finally {
      src.close()
    }

    const before = counts(ctx)
    if (before.accounts || before.transactions) snapshotDb(ctx.sqlite, `pre-restore-${ctx.ledger.slug}`)

    ctx.sqlite.prepare('ATTACH DATABASE ? AS restore').run(file)
    attached = true
    // Foreign keys can only be toggled outside a transaction; they're re-checked before commit.
    ctx.sqlite.pragma('foreign_keys = OFF')
    try {
      ctx.sqlite.transaction(() => {
        // The activity log stays: it records the restore itself.
        const targets = appTables(ctx.sqlite).filter((t) => t !== 'activity')
        const available = new Set(appTables(ctx.sqlite, 'restore'))
        for (const t of targets) ctx.sqlite.exec(`DELETE FROM main."${t}"`)
        for (const t of targets) {
          if (!available.has(t)) continue
          const mainCols = (ctx.sqlite.prepare(`PRAGMA main.table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name)
          const srcCols = new Set(
            (ctx.sqlite.prepare(`PRAGMA restore.table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name),
          )
          const cols = mainCols.filter((c) => srcCols.has(c)).map((c) => `"${c}"`).join(', ')
          if (cols) ctx.sqlite.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM restore."${t}"`)
        }
        // Ids handed out before stay used, here or in the backup, so a saved report never points at something new.
        if (ctx.sqlite.prepare(`SELECT 1 FROM restore.sqlite_master WHERE name = 'sqlite_sequence'`).get()) {
          const backed = ctx.sqlite.prepare('SELECT name, seq FROM restore.sqlite_sequence').all() as Array<{ name: string; seq: number }>
          for (const { name, seq } of backed.filter((r) => targets.includes(r.name))) {
            const raised = ctx.sqlite.prepare('UPDATE main.sqlite_sequence SET seq = max(seq, ?) WHERE name = ?').run(seq, name)
            if (!raised.changes) ctx.sqlite.prepare('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq)
          }
        }
        // Backups from before groups had colours (categories did): each group takes its first category's, as the upgrade does.
        const columns = (table: string) => (ctx.sqlite.prepare(`PRAGMA restore.table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name)
        if (available.has('category_groups') && !columns('category_groups').includes('color') && columns('categories').includes('color')) {
          ctx.sqlite.exec(
            `UPDATE main.category_groups SET color = coalesce((SELECT c.color FROM restore.categories c WHERE c.group_id = main.category_groups.id ORDER BY c.sort, c.id LIMIT 1), color)`,
          )
        }
        const broken = ctx.sqlite.pragma('foreign_key_check') as unknown[]
        if (broken.length) badRequest('That backup has inconsistent data, so nothing was changed.')
      })()
    } finally {
      ctx.sqlite.pragma('foreign_keys = ON')
    }
  } finally {
    if (attached) ctx.sqlite.exec('DETACH DATABASE restore')
    rmSync(dir, { recursive: true, force: true })
  }

  // App-wide settings (time zone, AI) live in meta.db, never in a ledger: a backup that has them is ignored there.
  dropAppSettings(ctx.sqlite)
  // Account ids now belong to the backup, so bank links would point at the wrong accounts.
  unlinkBankAccounts(ctx.meta, ctx.ledger.id)
  // Its categories follow the shared list (matched by name if the backup came from elsewhere).
  syncLedgerCategories(ctx.meta, ctx.sqlite)
  complete(ctx)
  return counts(ctx)
}

/**
 * Deletes this ledger's accounts, transactions, recurring items, tags and learned categories, and
 * turns every shared category back on. App-wide settings live in meta.db and are untouched, and the
 * activity log is kept. A snapshot is saved first.
 */
export function eraseAll(ctx: AppContext) {
  const backup = snapshotDb(ctx.sqlite, `pre-erase-${ctx.ledger.slug}`)
  const keep = new Set(['settings', 'activity'])
  ctx.sqlite.pragma('foreign_keys = OFF')
  try {
    ctx.sqlite.transaction(() => {
      for (const t of appTables(ctx.sqlite)) if (!keep.has(t)) ctx.sqlite.exec(`DELETE FROM main."${t}"`)
      ctx.sqlite.prepare('DELETE FROM settings WHERE key = ?').run(SETUP_KEY)
    })()
  } finally {
    ctx.sqlite.pragma('foreign_keys = ON')
  }
  syncLedgerCategories(ctx.meta, ctx.sqlite)
  unlinkBankAccounts(ctx.meta, ctx.ledger.id)
  return { backup: backup ? path.basename(backup) : null }
}
