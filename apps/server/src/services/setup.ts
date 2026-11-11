import path from 'node:path'
import { HTTPException } from 'hono/http-exception'
import type { SetupStatus } from '@chipmunk/shared'
import { eraseLedger, importLedger, readLedgerBackup, saveLedgerExport } from '../db/ledger-backup'
import { loadDemo } from '../db/seed-demo'
import type { Storage } from '../storage'
import { joinSharedList, wouldAddToSharedList } from './catalog'
import type { AppContext } from './context'
import { unlinkBankAccounts } from './accounts'
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
 * Replaces this ledger's data with a backup's (a file from Download backup, db/ledger-backup.ts).
 * The file is checked and upgraded in a temp copy, then its rows replace the ledger's in one
 * transaction, so a bad file leaves the current data untouched. The current data is saved in
 * data/backups first. The activity log stays. Without `addCategories` (a key limited to some
 * ledgers), a backup that would add to the shared category list is refused.
 */
export function restoreBackup(storage: Storage, ctx: AppContext, bytes: Uint8Array, opts: { addCategories: boolean } = { addCategories: true }) {
  const backup = readLedgerBackup(storage.sqlite, bytes)
  try {
    if (!opts.addCategories && backup.categoryPath(storage.sqlite) === 'name' && wouldAddToSharedList(storage, backup.categoryNames())) {
      throw new HTTPException(403, {
        message: 'This backup has categories the shared list doesn’t, and a key limited to some ledgers can’t add to it. Restore it in the app.',
      })
    }
    const before = counts(ctx)
    if (before.accounts || before.transactions) saveLedgerExport(storage.sqlite, ctx.ledger.id, `pre-restore-${ctx.ledger.slug}`)
    // From another category list, its categories come in as the ledger's own and join this list by name.
    importLedger(storage.sqlite, ctx.ledger.id, backup, { joinShared: () => joinSharedList(storage, ctx) })
  } finally {
    backup.close()
  }
  // Its accounts aren't the ones bank accounts were linked to (deleting those unlinked them).
  unlinkBankAccounts(ctx)
  complete(ctx)
  return counts(ctx)
}

/**
 * Deletes this ledger's accounts, transactions, recurring items, tags, reports and learned
 * categories, and turns every shared category back on. Its ledger settings and activity log are
 * kept, and app-wide settings are untouched. A copy is saved in data/backups first.
 */
export function eraseAll(storage: Storage, ctx: AppContext) {
  const backup = saveLedgerExport(storage.sqlite, ctx.ledger.id, `pre-erase-${ctx.ledger.slug}`)
  // Bank accounts linked to its accounts are unlinked by their foreign key.
  eraseLedger(storage.sqlite, ctx.ledger.id, SETUP_KEY)
  return { backup: backup ? path.basename(backup) : null }
}
