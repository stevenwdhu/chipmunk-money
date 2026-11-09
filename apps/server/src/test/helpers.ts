import type { LlmCategorizer } from '../ai/types'
import type { AppContext } from '../services/context'
import { resolveInstitution } from '../services/institutions'
import { setAppSetting } from '../services/settings'
import { openStorage, type Storage } from '../storage'

/** In-memory storage with one ledger ("Personal") and the time zone pinned for deterministic dates. */
export function testStorage(opts: { now?: string; llm?: LlmCategorizer; fetch?: typeof fetch } = {}): Storage {
  const now = new Date(opts.now ?? '2026-10-03T18:00:00Z')
  const storage = openStorage({ dataDir: null, now: () => now, llm: opts.llm, fetch: opts.fetch })
  setAppSetting(storage.meta, 'timezone', 'America/Toronto')
  return storage
}

/** A context for the default ledger of a fresh in-memory storage. */
export function testContext(opts: { now?: string; llm?: LlmCategorizer } = {}): AppContext {
  return testStorage(opts).registry.defaultContext()
}

export function categoryId(ctx: AppContext, name: string): number {
  const row = ctx.sqlite.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined
  if (!row) throw new Error(`No category ${name}`)
  return row.id
}

export function makeAccount(ctx: AppContext, name = 'TD Chequing', type = 'chequing', opening = 0, institution = 'TD'): number {
  return Number(
    ctx.sqlite
      .prepare(`INSERT INTO accounts (name, type, opening_balance_minor, institution_id) VALUES (?, ?, ?, ?)`)
      .run(name, type, opening, resolveInstitution(ctx, { institution }).id)
      .lastInsertRowid,
  )
}
