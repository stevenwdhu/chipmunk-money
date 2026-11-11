/**
 * Loads the demo data from the command line. Kept apart from seed-demo.ts so importing that (the
 * welcome screen does) never runs this, bundled or not.
 *   pnpm seed:demo                     # into the default ledger; refuses if it already has data
 *   pnpm seed:demo --force             # saves a copy of the whole database to data/backups, then clears that ledger's data (not its settings, activity or categories)
 *   pnpm seed:demo --ledger family     # into another ledger (by slug or id)
 */
import { env } from '../env'
import { setLedgerSetting } from '../services/settings'
import { openStorage } from '../storage'
import { clearLedger, safetyCopy } from './maintenance'
import { loadDemo } from './seed-demo'

/** What --force keeps: the ledger's settings, its activity log, and the categories it uses (its own list, or what it turned off on the shared one). */
const KEPT = ['ledger_settings', 'activity', 'payee_rules', 'category_groups', 'categories', 'labels', 'category_labels', 'ledger_category_off']

function main() {
  const storage = openStorage({ dataDir: env.dataDir })
  try {
    const flag = process.argv.indexOf('--ledger')
    const ledger = flag > 0 ? storage.registry.get(process.argv[flag + 1] ?? '') : storage.registry.defaultLedger()
    const ctx = storage.registry.context(ledger.id)
    if (process.argv.includes('--force')) {
      const n = ctx.q.pluck<number>(
        `SELECT (SELECT count(*) FROM transactions WHERE ledger_id = @ledger) + (SELECT count(*) FROM ledger_accounts WHERE ledger_id = @ledger)
           + (SELECT count(*) FROM recurring_items WHERE ledger_id = @ledger) + (SELECT count(*) FROM custom_reports WHERE ledger_id = @ledger)
           + (SELECT count(*) FROM tags WHERE ledger_id = @ledger)`,
      )!
      if (n) {
        // The same safety net the app keeps before erasing a ledger.
        const backup = safetyCopy(storage.sqlite, `pre-seed-demo-${ledger.slug}`)
        if (backup) console.log(`Saved the database as it was to ${backup}`)
        clearLedger(storage.sqlite, ledger.id, KEPT)
      }
    }
    const { transactions, recurringSuggestions } = loadDemo(ctx)
    setLedgerSetting(ctx, 'setup.completed', true)
    console.log(`Seeded ${transactions} transactions and ${recurringSuggestions} recurring suggestions into the “${ledger.name}” ledger`)
  } finally {
    storage.close()
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
