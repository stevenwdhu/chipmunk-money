/**
 * Loads the demo data from the command line. Kept apart from seed-demo.ts so importing that (the
 * welcome screen does) never runs this, bundled or not.
 *   pnpm seed:demo                     # into the default ledger; refuses if it already has data
 *   pnpm seed:demo --force             # snapshots that ledger to data/backups, then wipes its accounts, transactions and recurring items
 *   pnpm seed:demo --ledger family     # into another ledger (by slug or id)
 */
import { env } from '../env'
import { setLedgerSetting } from '../services/settings'
import { openStorage } from '../storage'
import { snapshotDb } from './client'
import { loadDemo } from './seed-demo'

function main() {
  const storage = openStorage({ dataDir: env.dataDir })
  try {
    const flag = process.argv.indexOf('--ledger')
    const ledger = flag > 0 ? storage.registry.get(process.argv[flag + 1] ?? '') : storage.registry.defaultLedger()
    const ctx = storage.registry.context(ledger.id)
    const force = process.argv.includes('--force')
    if (force) {
      const has = ctx.sqlite
        .prepare(
          `SELECT (SELECT count(*) FROM transactions) + (SELECT count(*) FROM accounts) + (SELECT count(*) FROM recurring_items)
             + (SELECT count(*) FROM custom_reports) + (SELECT count(*) FROM tags) AS n`,
        )
        .get() as { n: number }
      // The same safety net the app keeps before erasing a ledger.
      const backup = has.n ? snapshotDb(ctx.sqlite, `pre-seed-demo-${ledger.slug}`) : null
      if (backup) console.log(`Saved the “${ledger.name}” ledger as it was to ${backup}`)
    }
    const { transactions, recurringSuggestions } = loadDemo(ctx, { force })
    setLedgerSetting(ctx, 'setup.completed', true)
    console.log(`Seeded ${transactions} transactions and ${recurringSuggestions} recurring suggestions into the “${ledger.name}” ledger`)
  } finally {
    storage.registry.closeAll()
    storage.meta.sqlite.close()
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
