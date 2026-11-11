import { purgeIdempotencyKeys } from './api/idempotency'
import { dailyUpkeep } from './db/client'
import { LedgerScopeError } from './db/scope'
import type { BankService } from './services/bank/service'
import type { AppContext } from './services/context'
import { detectRecurring } from './services/recurring'
import { setAppSetting, today } from './services/settings'
import { purgeDeleted } from './services/transactions'
import type { Storage } from './storage'

/** Where the last daily run that a query refused (a missing ledger pin) is kept, for App settings. */
export const LAST_JOB_ERROR = 'jobs.lastError'

/** One ledger's daily maintenance: what it says it did, for the log. */
export type DailyTask = (ctx: AppContext) => string | null

/** Suggests new recurring items, then deletes what's been in the trash for 30 days. */
export const DAILY_TASKS: DailyTask[] = [
  (ctx) => {
    const { created } = detectRecurring(ctx)
    return created ? `${created} new recurring suggestion(s)` : null
  },
  (ctx) => {
    purgeDeleted(ctx)
    return null
  },
]

/**
 * Runs the daily maintenance for every active ledger, each in its own transaction: a ledger whose
 * run fails keeps none of it, and the others still run. Then the database's own upkeep (its query
 * planner's statistics, and freed pages back to the disk). Returns the ledgers that failed.
 */
export function runDailyJobs(storage: Storage, tasks: DailyTask[] = DAILY_TASKS): string[] {
  const failed: string[] = []
  for (const ledger of storage.registry.list().filter((l) => !l.archived)) {
    try {
      const ctx = storage.registry.context(ledger.id)
      const said = ctx.q.transaction(() => tasks.map((task) => task(ctx)))
      for (const line of said) if (line) console.log(`[jobs] ${ledger.name}: ${line}`)
    } catch (err) {
      failed.push(ledger.id)
      console.error(`[jobs] daily maintenance failed for ${ledger.name}`, err)
      // A query refused for a missing ledger pin fails closed: kept where App settings can show it,
      // so it doesn't hide in the logs.
      if (err instanceof LedgerScopeError) {
        setAppSetting(storage.app, LAST_JOB_ERROR, { at: storage.now().toISOString(), ledger: ledger.name, message: err.message })
      }
    }
  }
  try {
    dailyUpkeep(storage.sqlite)
  } catch (err) {
    console.error('[jobs] database upkeep failed', err)
  }
  return failed
}

/** Runs daily maintenance for every active ledger, once per local day (in the app's time zone). */
export function startJobs(storage: Storage) {
  let lastRun: string | null = null
  const run = () => {
    const day = today({ meta: storage.app, now: storage.now })
    if (day === lastRun) return
    runDailyJobs(storage)
    purgeIdempotencyKeys(storage.app, storage.now())
    // Only once it ran: when listing the ledgers failed, it's tried again on the next tick.
    lastRun = day
  }
  // A failure is logged and tried again on the next tick; it never takes the server down.
  const tick = () => {
    try {
      run()
    } catch (err) {
      console.error('[jobs] daily maintenance failed', err)
    }
  }
  const first = setTimeout(tick, 3_000)
  first.unref()
  const timer = setInterval(tick, 10 * 60_000)
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

/**
 * Syncs bank connections when they're due (as often as App settings → Bank sync says, sooner after
 * an error). Checks every 10 minutes; the first check is a minute after start, so syncs don't land
 * on the hour.
 */
export function startBankSync(bank: BankService) {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      for (const id of bank.due()) {
        try {
          const r = await bank.sync(id)
          const added = r.accounts.reduce((s, a) => s + a.added, 0)
          console.log(`[bank] ${r.ok ? `synced: ${added} new transaction(s)` : `sync failed: ${r.error}`}`)
        } catch (err) {
          console.error(`[bank] sync skipped: ${err instanceof Error ? err.message : err}`)
        }
      }
    } catch (err) {
      // Finding what's due failed: logged, and checked again on the next tick.
      console.error('[bank] sync check failed', err)
    } finally {
      busy = false
    }
  }
  const first = setTimeout(tick, 60_000)
  first.unref()
  const timer = setInterval(tick, 10 * 60_000)
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
