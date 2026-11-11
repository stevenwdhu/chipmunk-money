import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { HTTPException } from 'hono/http-exception'
import type { Ledger, LedgerUpdate } from '@chipmunk/shared'
import { CATEGORY_COLORS } from '@chipmunk/shared'
import type { LlmCategorizer } from './ai/types'
import { DB_FILE, openDatabase, type SQLite } from './db/client'
import { ledgers } from './db/schema'
import { allLedgers, appDatabase, ledgerMaintenance, LedgerQuery, type UnscopedQuery } from './db/scope'
import { databaseCopy, reclaimSpace, safetyCopy } from './db/maintenance'
import { deleteLedgerRows } from './db/tables'
import type { UnscopedReason } from './db/unscoped-sites'
import { seedCatalog } from './services/catalog'
import { slugify, ulid } from './lib/ids'
import { SecretBox } from './lib/secrets'
import type { AppContext, AppStore } from './services/context'
import { getAppSetting, sealStoredSecrets, setAppSetting, today } from './services/settings'

/**
 * Storage is chipmunk.db and what the app keeps beside it in the data directory (secret.key, and
 * backups/ for the safety copies). Ledgers are rows in `ledgers`, and their data is in the same
 * tables as every other ledger's, so a ledger's context is cheap: its handle (ctx.q) is pinned to
 * its rows, and ctx.app reaches the app-wide tables. Deleting a ledger deletes its rows
 * (deleteLedgerRows), after saving a copy of the whole database.
 */

type LedgerRow = typeof ledgers.$inferSelect

export interface Storage {
  /** The one connection to chipmunk.db. */
  sqlite: SQLite
  /** The app-wide tables. */
  app: AppStore
  registry: LedgerRegistry
  now: () => Date
  /** data/ directory, or null when everything is in memory (tests). */
  dataDir: string | null
  /** Encrypts stored bank access (key in data/secret.key). */
  secrets: SecretBox
  /** For talking to bank-data providers; replaceable in tests. */
  fetch: typeof fetch
  /** Runs fn with every ledger in scope and no pin checker; each call site is listed in db/unscoped-sites.ts. */
  allLedgers<T>(reason: UnscopedReason, fn: (db: UnscopedQuery) => T): T
  /** Closes the database (which checkpoints the WAL). */
  close(): void
}

const DEFAULT_LEDGER_KEY = 'defaultLedger'

/**
 * Knows every ledger. Ledgers are rows in the one database, so a context is a cheap object over
 * the shared connection.
 */
export class LedgerRegistry {
  constructor(
    private sqlite: SQLite,
    private app: AppStore,
    private now: () => Date,
    private llm?: LlmCategorizer,
  ) {}

  private rows(): LedgerRow[] {
    return this.app.db.select().from(ledgers).orderBy(asc(ledgers.sort), asc(ledgers.createdAt)).all()
  }

  find(idOrSlug: string): LedgerRow | undefined {
    return this.rows().find((r) => r.id === idOrSlug || r.slug === idOrSlug)
  }

  get(idOrSlug: string): LedgerRow {
    const row = this.find(idOrSlug)
    if (!row) throw new HTTPException(404, { message: `There's no ledger called “${idOrSlug}”` })
    return row
  }

  private defaultOf(rows: LedgerRow[]): LedgerRow {
    const preferred = getAppSetting<string | null>(this.app, DEFAULT_LEDGER_KEY, null)
    const row = rows.find((r) => r.id === preferred && !r.archivedAt) ?? rows.find((r) => !r.archivedAt) ?? rows[0]
    if (!row) throw new HTTPException(404, { message: 'There are no ledgers yet' })
    return row
  }

  defaultLedger(): LedgerRow {
    return this.defaultOf(this.rows())
  }

  context(idOrSlug: string): AppContext {
    const row = this.get(idOrSlug)
    return {
      q: new LedgerQuery(this.sqlite, row.id),
      app: this.app,
      meta: this.app,
      ledger: { id: row.id, name: row.name, slug: row.slug },
      now: this.now,
      llm: this.llm,
    }
  }

  defaultContext(): AppContext {
    return this.context(this.defaultLedger().id)
  }

  private dto(row: LedgerRow, defaultId: string, counts: { accounts: number; transactions: number }): Ledger {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      color: row.color,
      icon: row.icon,
      sort: row.sort,
      archived: !!row.archivedAt,
      isDefault: defaultId === row.id,
      createdAt: row.createdAt,
      accounts: counts.accounts,
      transactions: counts.transactions,
    }
  }

  toDTO(row: LedgerRow, withCounts = true): Ledger {
    const counts = withCounts
      ? new LedgerQuery(this.sqlite, row.id).get<{ accounts: number; transactions: number }>(
          `SELECT (SELECT count(*) FROM ledger_accounts WHERE ledger_id = @ledger) AS accounts,
             (SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND deleted_at IS NULL) AS transactions`,
        )!
      : { accounts: 0, transactions: 0 }
    return this.dto(row, this.defaultLedger().id, counts)
  }

  list(): Ledger[] {
    const rows = this.rows()
    const defaultId = rows.length ? this.defaultOf(rows).id : ''
    const counts = allLedgers(this.sqlite, 'ledger counts', (db) => {
      const count = (sql: string) => new Map(db.all<{ id: string; n: number }>(sql).map((r) => [r.id, r.n]))
      return {
        accounts: count('SELECT ledger_id AS id, count(*) AS n FROM ledger_accounts GROUP BY ledger_id'),
        transactions: count('SELECT ledger_id AS id, count(*) AS n FROM transactions WHERE deleted_at IS NULL GROUP BY ledger_id'),
      }
    })
    return rows.map((r) => this.dto(r, defaultId, { accounts: counts.accounts.get(r.id) ?? 0, transactions: counts.transactions.get(r.id) ?? 0 }))
  }

  uniqueSlug(name: string, exceptId?: string): string {
    const base = slugify(name)
    const taken = new Set(this.rows().filter((r) => r.id !== exceptId).map((r) => r.slug))
    // "l" is reserved for web routes; keep slugs from colliding with it.
    if (!taken.has(base) && base !== 'l') return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  }

  /**
   * Adds a ledger, with these ledger settings, in one transaction. It starts on the shared
   * category list, every category on.
   */
  create(input: { name: string; color?: string; icon?: string | null; id?: string; settings?: Record<string, unknown> }): LedgerRow {
    const id = input.id ?? ulid(this.now().getTime())
    const rows = this.rows()
    const row: LedgerRow = {
      id,
      name: input.name,
      slug: this.uniqueSlug(input.name),
      color: input.color ?? CATEGORY_COLORS[rows.length % CATEGORY_COLORS.length]!,
      icon: input.icon ?? null,
      sort: rows.length ? Math.max(...rows.map((r) => r.sort)) + 1 : 0,
      categoryList: 'shared',
      archivedAt: null,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    }
    const q = new LedgerQuery(this.sqlite, id)
    q.transaction(() => {
      this.app.db.insert(ledgers).values(row).run()
      for (const [key, value] of Object.entries(input.settings ?? {})) {
        q.run('INSERT INTO ledger_settings (ledger_id, key, value) VALUES (@ledger, @key, @value)', { key, value: JSON.stringify(value) })
      }
    })
    return row
  }

  update(idOrSlug: string, input: LedgerUpdate): LedgerRow {
    const row = this.get(idOrSlug)
    const active = this.rows().filter((r) => !r.archivedAt)
    if (input.archived && !row.archivedAt && active.length === 1) {
      throw new HTTPException(409, { message: "You can't archive your only ledger. Create another one first." })
    }
    const patch: Partial<LedgerRow> = { updatedAt: this.now().toISOString() }
    if (input.name !== undefined && input.name !== row.name) {
      patch.name = input.name
      patch.slug = this.uniqueSlug(input.name, row.id)
    }
    if (input.color !== undefined) patch.color = input.color
    if (input.icon !== undefined) patch.icon = input.icon ?? null
    if (input.sort !== undefined) patch.sort = input.sort
    if (input.archived !== undefined) patch.archivedAt = input.archived ? this.now().toISOString() : null
    this.app.db.update(ledgers).set(patch).where(eq(ledgers.id, row.id)).run()
    if (input.isDefault) setAppSetting(this.app, DEFAULT_LEDGER_KEY, row.id)
    if (input.archived && this.defaultLedger().id === row.id) setAppSetting(this.app, DEFAULT_LEDGER_KEY, null)
    return this.get(row.id)
  }

  /**
   * Deletes a ledger and all its data, after saving a copy of the whole database as
   * data/backups/pre-delete-<slug>-<time>.db (safetyCopy, not in a dry run). Bank accounts linked
   * to its accounts are unlinked (their foreign key). Then the freed pages go back to the disk.
   */
  remove(idOrSlug: string): { backup: string | null } {
    const row = this.get(idOrSlug)
    if (this.rows().length === 1) {
      throw new HTTPException(409, { message: "You can't delete your only ledger. Erase its data instead." })
    }
    const backup = safetyCopy(this.sqlite, `pre-delete-${row.slug}`)
    ledgerMaintenance(this.sqlite, row.id, () =>
      this.sqlite.transaction(() => {
        deleteLedgerRows(this.sqlite, row.id)
        this.app.db.delete(ledgers).where(eq(ledgers.id, row.id)).run()
        if (getAppSetting(this.app, DEFAULT_LEDGER_KEY, null) === row.id) setAppSetting(this.app, DEFAULT_LEDGER_KEY, null)
      })(),
    )
    reclaimSpace(this.sqlite)
    return { backup: backup ? path.basename(backup) : null }
  }

  /** Whether there's any ledger yet. */
  hasLedgers(): boolean {
    return !!this.app.db.select({ id: ledgers.id }).from(ledgers).limit(1).get()
  }
}

/**
 * A zip of the whole database (every ledger and the app-wide tables), plus a manifest, for moving
 * to another machine. secret.key isn't in it: without that file the bank access and AI keys in the
 * database can't be read, so it's copied separately.
 */
export function fullBackup(storage: Storage): { bytes: Uint8Array; fileName: string } {
  const rows = storage.app.db.select().from(ledgers).all()
  const files: Record<string, Uint8Array> = { [DB_FILE]: allLedgers(storage.sqlite, 'full backup', () => databaseCopy(storage.sqlite)) }
  const manifest = {
    app: 'chipmunk',
    format: 2,
    createdAt: storage.now().toISOString(),
    ledgers: rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug })),
    restore: `Stop the server, remove ${DB_FILE}-wal and ${DB_FILE}-shm from the data directory if they are there, then unzip ${DB_FILE} into it.`,
    secretKey: `secret.key isn't in this zip. Copy it from the old data directory into the new one as well, or bank access and AI provider keys stop working.`,
  }
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  const date = today({ meta: storage.app, now: storage.now })
  return { bytes: zipSync(files, { level: 6 }), fileName: `chipmunk-full-${date}.zip` }
}

/** Opens chipmunk.db (in memory when dataDir is null), creating the first ledger on a fresh install. */
export function openStorage(opts: {
  dataDir: string | null
  now?: () => Date
  llm?: LlmCategorizer
  fetch?: typeof fetch
}): Storage {
  const now = opts.now ?? (() => new Date())
  const fetcher: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const { sqlite } = openDatabase(opts.dataDir ? path.join(opts.dataDir, DB_FILE) : null)
  const secrets = SecretBox.forDataDir(opts.dataDir)
  const app: AppStore = { db: appDatabase(sqlite), secrets, fetch: fetcher }
  // Keys saved before they were encrypted get encrypted now.
  sealStoredSecrets(app)
  // The shared category list starts from the defaults.
  allLedgers(sqlite, 'seed the shared category list', (db) => seedCatalog(db))
  const registry = new LedgerRegistry(sqlite, app, now, opts.llm)
  if (!registry.hasLedgers()) registry.create({ name: 'Personal' })
  return {
    sqlite,
    app,
    registry,
    now,
    dataDir: opts.dataDir,
    secrets,
    fetch: fetcher,
    allLedgers: (reason, fn) => allLedgers(sqlite, reason, fn),
    close: () => sqlite.close(),
  }
}
