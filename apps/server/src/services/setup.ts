import path from 'node:path'
import { HTTPException } from 'hono/http-exception'
import type { SetupStatus } from '@chipmunk/shared'
import { eraseLedger, reclaimSpace, safetyCopy } from '../db/maintenance'
import { loadDemo } from '../db/seed-demo'
import type { LedgerActionOptions, Storage } from '../storage'
import type { AppContext } from './context'
import { applyAnswers, categorizeMoved, requireAnswers } from './questions'
import { getLedgerSetting, setLedgerSetting } from './settings'

const SETUP_KEY = 'setup.completed'

function counts(ctx: AppContext) {
  return ctx.q.get<{ accounts: number; transactions: number }>(
    `SELECT (SELECT count(*) FROM ledger_accounts WHERE ledger_id = @ledger) AS accounts,
       (SELECT count(*) FROM transactions WHERE ledger_id = @ledger) AS transactions`,
  )!
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
 * Deletes this ledger's accounts, transactions, recurring items, tags, reports and learned
 * categories, and turns every shared category back on. Its ledger settings and activity log are
 * kept, and app-wide settings are untouched. A copy of the whole database is saved in
 * data/backups first (not in a dry run). What's asked first (questions.ts) is answered in
 * `opts.answers` and applied in the same transaction, before its rows go: a shared account it's the
 * home of gets another home, and its transactions on a shared account move to another ledger or are
 * deleted. Afterwards it has none of the accounts that were shared with it. Returns the copy's file
 * name and what was done, in words.
 */
export function eraseAll(storage: Storage, ctx: AppContext, opts: LedgerActionOptions = {}): { backup: string | null; changes: string[] } {
  const answers = opts.answers ?? {}
  const allowed = opts.allowed ?? null
  requireAnswers(ctx, 'erase', answers, allowed)
  const backup = safetyCopy(storage.sqlite, `pre-erase-${ctx.ledger.slug}`)
  const applied = storage.sqlite.transaction(() => {
    const applied = applyAnswers(ctx, storage.ctxOf, 'erase', answers, { allowed, actor: opts.actor ?? { name: 'web', apiKeyId: null } })
    // Bank accounts linked to its accounts are unlinked by their foreign key.
    eraseLedger(storage.sqlite, ctx.ledger.id, SETUP_KEY)
    return applied
  })()
  reclaimSpace(storage.sqlite)
  // Inside a transaction still: a dry run, which is rolled back.
  if (!storage.sqlite.inTransaction) categorizeMoved(storage.ctxOf, applied)
  return { backup: backup ? path.basename(backup) : null, changes: [...applied.changes, `${ctx.ledger.name}’s data was erased.`] }
}
