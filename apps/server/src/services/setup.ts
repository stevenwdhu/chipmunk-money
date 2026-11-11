import path from 'node:path'
import { HTTPException } from 'hono/http-exception'
import type { SetupStatus } from '@chipmunk/shared'
import { eraseLedger, safetyCopy } from '../db/maintenance'
import { loadDemo } from '../db/seed-demo'
import type { Storage } from '../storage'
import type { AppContext } from './context'
import { refuseWhileSharing } from './sharing'
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
 * data/backups first (not in a dry run). Not while it's a shared account's home or opening ledger.
 */
export function eraseAll(storage: Storage, ctx: AppContext) {
  refuseWhileSharing(ctx)
  const backup = safetyCopy(storage.sqlite, `pre-erase-${ctx.ledger.slug}`)
  // Bank accounts linked to its accounts are unlinked by their foreign key.
  eraseLedger(storage.sqlite, ctx.ledger.id, SETUP_KEY)
  return { backup: backup ? path.basename(backup) : null }
}
