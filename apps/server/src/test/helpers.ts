import type { LlmCategorizer } from '../ai/types'
import type { AppContext } from '../services/context'
import { setAppSetting } from '../services/settings'
import { openStorage, type Storage } from '../storage'

/** In-memory storage with one ledger ("Personal") and the time zone pinned for deterministic dates. */
export function testStorage(opts: { now?: string; llm?: LlmCategorizer; fetch?: typeof fetch } = {}): Storage {
  const now = new Date(opts.now ?? '2026-10-03T18:00:00Z')
  const storage = openStorage({ dataDir: null, now: () => now, llm: opts.llm, fetch: opts.fetch })
  setAppSetting(storage.app, 'timezone', 'America/Toronto')
  return storage
}

/** A context for the default ledger of a fresh in-memory storage. */
export function testContext(opts: { now?: string; llm?: LlmCategorizer } = {}): AppContext {
  return testStorage(opts).registry.defaultContext()
}

/** Adds a ledger to the storage, and returns its context. */
export function testLedger(storage: Storage, name = 'Family'): AppContext {
  return storage.registry.context(storage.registry.create({ name }).id)
}

/** A category the ledger uses, by name. */
export function categoryId(ctx: AppContext, name: string): number {
  const id = ctx.q.pluck<number>('SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND name = @name', { name })
  if (id === undefined) throw new Error(`No category ${name}`)
  return id
}

/** An institution of the ledger by name, added when it has none. */
function institutionId(ctx: AppContext, name: string): number {
  const id = ctx.q.pluck<number>('SELECT id FROM institutions WHERE ledger_id = @ledger AND name = @name', { name })
  if (id !== undefined) return id
  return Number(ctx.q.run('INSERT INTO institutions (ledger_id, name) VALUES (@ledger, @name)', { name }).lastInsertRowid)
}

export function makeAccount(ctx: AppContext, name = 'TD Chequing', type = 'chequing', opening = 0, institution = 'TD'): number {
  return Number(
    ctx.q.run(
      `INSERT INTO accounts (ledger_id, name, type, opening_balance_minor, institution_id) VALUES (@ledger, @name, @type, @opening, @institution)`,
      { name, type, opening, institution: institutionId(ctx, institution) },
    ).lastInsertRowid,
  )
}
