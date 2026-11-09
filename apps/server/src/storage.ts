import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { HTTPException } from 'hono/http-exception'
import type { Ledger, LedgerUpdate } from '@st/shared'
import { CATEGORY_COLORS } from '@st/shared'
import type { LlmCategorizer } from './ai/types'
import { openLedgerDb, openMetaDb, snapshotDb, type DB, type SQLite } from './db/client'
import { ledgers } from './db/meta-schema'
import { unlinkBankAccounts } from './services/accounts'
import { ledgerNeedsSync, seedCatalog, syncLedgerCategories } from './services/catalog'
import { slugify, ulid } from './lib/ids'
import { SecretBox } from './lib/secrets'
import type { AppContext, MetaStore } from './services/context'
import { getAppSetting, sealStoredSecrets, setAppSetting, today } from './services/settings'

type LedgerRow = typeof ledgers.$inferSelect

export interface Storage {
  meta: MetaStore
  registry: LedgerRegistry
  now: () => Date
  /** data/ directory, or null when everything is in memory (tests). */
  dataDir: string | null
  /** Encrypts stored bank access (key in data/secret.key). */
  secrets: SecretBox
  /** For talking to bank-data providers; replaceable in tests. */
  fetch: typeof fetch
}

const DEFAULT_LEDGER_KEY = 'defaultLedger'

/**
 * Knows every ledger and keeps one open connection per ledger file. Ledgers are opened lazily and
 * stay open; deleting a ledger closes its connection first.
 */
export class LedgerRegistry {
  private open = new Map<string, { db: DB; sqlite: SQLite }>()

  constructor(
    private meta: MetaStore,
    private dir: string | null,
    private now: () => Date,
    private llm?: LlmCategorizer,
  ) {}

  private rows(): LedgerRow[] {
    return this.meta.db.select().from(ledgers).orderBy(asc(ledgers.sort), asc(ledgers.createdAt)).all()
  }

  private fileFor(row: Pick<LedgerRow, 'file'>): string {
    return this.dir ? path.join(this.dir, 'ledgers', row.file) : ':memory:'
  }

  private connection(row: LedgerRow) {
    let conn = this.open.get(row.id)
    if (!conn) {
      conn = openLedgerDb(this.fileFor(row))
      this.open.set(row.id, conn)
    }
    return conn
  }

  find(idOrSlug: string): LedgerRow | undefined {
    return this.rows().find((r) => r.id === idOrSlug || r.slug === idOrSlug)
  }

  get(idOrSlug: string): LedgerRow {
    const row = this.find(idOrSlug)
    if (!row) throw new HTTPException(404, { message: `There's no ledger called “${idOrSlug}”` })
    return row
  }

  defaultLedger(): LedgerRow {
    const rows = this.rows()
    const preferred = getAppSetting<string | null>(this.meta, DEFAULT_LEDGER_KEY, null)
    const row =
      rows.find((r) => r.id === preferred && !r.archivedAt) ?? rows.find((r) => !r.archivedAt) ?? rows[0]
    if (!row) throw new HTTPException(404, { message: 'There are no ledgers yet' })
    return row
  }

  context(idOrSlug: string): AppContext {
    const row = this.get(idOrSlug)
    const { db, sqlite } = this.connection(row)
    // Its categories follow the shared list; catch up if the list changed since.
    if (ledgerNeedsSync(this.meta, sqlite)) syncLedgerCategories(this.meta, sqlite)
    return {
      db,
      sqlite,
      meta: this.meta,
      ledger: { id: row.id, name: row.name, slug: row.slug },
      now: this.now,
      llm: this.llm,
    }
  }

  defaultContext(): AppContext {
    return this.context(this.defaultLedger().id)
  }

  toDTO(row: LedgerRow, withCounts = true): Ledger {
    let accounts = 0
    let transactions = 0
    if (withCounts) {
      const c = this.connection(row)
        .sqlite.prepare(
          `SELECT (SELECT count(*) FROM accounts) AS accounts,
             (SELECT count(*) FROM transactions WHERE deleted_at IS NULL) AS transactions`,
        )
        .get() as { accounts: number; transactions: number }
      accounts = c.accounts
      transactions = c.transactions
    }
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      color: row.color,
      icon: row.icon,
      sort: row.sort,
      archived: !!row.archivedAt,
      isDefault: this.defaultLedger().id === row.id,
      createdAt: row.createdAt,
      accounts,
      transactions,
    }
  }

  list(): Ledger[] {
    return this.rows().map((r) => this.toDTO(r))
  }

  private uniqueSlug(name: string, exceptId?: string): string {
    const base = slugify(name)
    const taken = new Set(this.rows().filter((r) => r.id !== exceptId).map((r) => r.slug))
    // "l" is reserved for web routes; keep slugs from colliding with it.
    if (!taken.has(base) && base !== 'l') return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  }

  /** Creates the ledger file (migrated, with the shared categories, all on) and registers it. */
  create(input: { name: string; color?: string; icon?: string | null; id?: string; file?: string }): LedgerRow {
    const id = input.id ?? ulid(this.now().getTime())
    const rows = this.rows()
    const row: LedgerRow = {
      id,
      name: input.name,
      slug: this.uniqueSlug(input.name),
      color: input.color ?? CATEGORY_COLORS[rows.length % CATEGORY_COLORS.length]!,
      icon: input.icon ?? null,
      sort: rows.length ? Math.max(...rows.map((r) => r.sort)) + 1 : 0,
      file: input.file ?? `${id}.db`,
      archivedAt: null,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    }
    const conn = this.connection(row)
    syncLedgerCategories(this.meta, conn.sqlite)
    this.meta.db.insert(ledgers).values(row).run()
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
    this.meta.db.update(ledgers).set(patch).where(eq(ledgers.id, row.id)).run()
    if (input.isDefault) setAppSetting(this.meta, DEFAULT_LEDGER_KEY, row.id)
    if (input.archived && this.defaultLedger().id === row.id) setAppSetting(this.meta, DEFAULT_LEDGER_KEY, null)
    return this.get(row.id)
  }

  /** Deletes a ledger and its file, after saving a snapshot to data/backups. */
  remove(idOrSlug: string): { backup: string | null } {
    const row = this.get(idOrSlug)
    if (this.rows().length === 1) {
      throw new HTTPException(409, { message: "You can't delete your only ledger. Erase its data instead." })
    }
    const conn = this.connection(row)
    const backup = snapshotDb(conn.sqlite, `deleted-${row.slug}`)
    conn.sqlite.close()
    this.open.delete(row.id)
    if (this.dir) {
      const file = this.fileFor(row)
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true })
    }
    this.meta.db.delete(ledgers).where(eq(ledgers.id, row.id)).run()
    unlinkBankAccounts(this.meta, row.id)
    if (getAppSetting(this.meta, DEFAULT_LEDGER_KEY, null) === row.id) setAppSetting(this.meta, DEFAULT_LEDGER_KEY, null)
    return { backup: backup ? path.basename(backup) : null }
  }

  /** A consistent copy of one ledger's database, as bytes. */
  serialize(idOrSlug: string): Buffer {
    return this.connection(this.get(idOrSlug)).sqlite.serialize()
  }

  closeAll() {
    for (const conn of this.open.values()) conn.sqlite.close()
    this.open.clear()
  }
}

/** A zip of meta.db and every ledger file, plus a manifest, for moving to another machine. */
export function fullBackup(storage: Storage): { bytes: Uint8Array; fileName: string } {
  const rows = storage.meta.db.select().from(ledgers).all()
  const files: Record<string, Uint8Array> = { 'meta.db': storage.meta.sqlite.serialize() }
  for (const row of rows) files[`ledgers/${row.file}`] = storage.registry.serialize(row.id)
  const manifest = {
    app: 'spending-tracker',
    createdAt: storage.now().toISOString(),
    ledgers: rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, file: `ledgers/${r.file}` })),
    restore: 'Stop the server, then unzip into the data directory (meta.db and ledgers/ side by side).',
  }
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  const date = today({ meta: storage.meta, now: storage.now })
  return { bytes: zipSync(files, { level: 6 }), fileName: `spending-tracker-full-${date}.zip` }
}

/** Opens meta.db and the ledger registry, creating a first ledger if needed. */
export function openStorage(opts: {
  dataDir: string | null
  now?: () => Date
  llm?: LlmCategorizer
  fetch?: typeof fetch
}): Storage {
  const now = opts.now ?? (() => new Date())
  const fetcher: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const meta = { ...openMetaDb(opts.dataDir ? path.join(opts.dataDir, 'meta.db') : ':memory:'), secrets: SecretBox.forDataDir(opts.dataDir), fetch: fetcher }
  // Keys saved before they were encrypted get encrypted now.
  sealStoredSecrets(meta)
  // The shared category list starts from the defaults.
  seedCatalog(meta)
  const registry = new LedgerRegistry(meta, opts.dataDir, now, opts.llm)
  // The single database from before ledgers existed is too old for this version to upgrade.
  if (opts.dataDir && existsSync(path.join(opts.dataDir, 'app.db'))) {
    console.warn(`[storage] ${path.join(opts.dataDir, 'app.db')} is from a version before ledgers, too old for this one to move into a ledger. Start a version from before November 2026 once to move it.`)
  }
  if (!registry.list().length) registry.create({ name: 'Personal' })
  return {
    meta,
    registry,
    now,
    dataDir: opts.dataDir,
    secrets: meta.secrets,
    fetch: fetcher,
  }
}
