import type { BankService } from './services/bank/service'
import { detectRecurring } from './services/recurring'
import { today } from './services/settings'
import { purgeDeleted } from './services/transactions'
import type { Storage } from './storage'

/** Runs daily maintenance for every active ledger, once per local day (in the app's time zone). */
export function startJobs(storage: Storage) {
  let lastRun: string | null = null
  const run = () => {
    const day = today({ meta: storage.meta, now: storage.now })
    if (day === lastRun) return
    const active = storage.registry.list().filter((l) => !l.archived)
    lastRun = day
    for (const ledger of active) {
      try {
        const ctx = storage.registry.context(ledger.id)
        const { created } = detectRecurring(ctx)
        purgeDeleted(ctx)
        if (created) console.log(`[jobs] ${ledger.name}: ${created} new recurring suggestion(s)`)
      } catch (err) {
        console.error(`[jobs] daily maintenance failed for ${ledger.name}`, err)
      }
    }
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
