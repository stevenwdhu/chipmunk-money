import path from 'node:path'
import { sql } from 'drizzle-orm'
import { serve } from '@hono/node-server'
import { PAYEE_RULES_VERSION } from '@chipmunk/shared'
import { createApp } from './app'
import { appSettings, bankConnections } from './db/schema'
import { env } from './env'
import { startBankSync, startJobs } from './jobs'
import { countUnreadable } from './lib/secrets'
import { BankService } from './services/bank/service'
import { effectiveTimezone, getAppSetting, setAppSetting } from './services/settings'
import { openStorage } from './storage'

// Logged, never fatal: one failed promise shouldn't take the app down.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason)
})

const storage = openStorage({ dataDir: env.dataDir })
warnUnreadableSecrets()
const bank = new BankService(storage)
// When the payee rules have changed (and the first time payees followed their connection), payees
// are made again from the bank data kept: nothing is fetched.
const payeesMadeBy = getAppSetting<number>(storage.app, 'payees.rulesVersion', 0)
if (payeesMadeBy < PAYEE_RULES_VERSION) {
  const changed = bank.refreshPayees(payeesMadeBy)
  setAppSetting(storage.app, 'payees.rulesVersion', PAYEE_RULES_VERSION)
  if (changed) console.log(`[payees] ${changed} transaction${changed === 1 ? '' : 's'} took the payee the current rules and connections give`)
}
const app = createApp(storage, { serveWeb: env.isProduction, log: !env.isProduction, bank })
const stopJobs = startJobs(storage)
const stopBankSync = startBankSync(bank)

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  const ledgers = storage.registry
    .list()
    .map((l) => l.name)
    .join(', ')
  console.log(
    `Chipmunk API on http://localhost:${info.port} · data ${env.dataDir} · ledgers: ${ledgers} · tz ${effectiveTimezone(storage.app)}`,
  )
})

/** Bank access and AI keys sealed with a secret.key that's gone can't be opened again: say so once, at start. */
function warnUnreadableSecrets() {
  const { db } = storage.app
  const stored = [
    ...db.select({ v: bankConnections.secret }).from(bankConnections).all(),
    // As stored (JSON text), where sealed values sit inside.
    ...db.select({ v: sql<string>`${appSettings.value}` }).from(appSettings).all(),
  ].map((r) => r.v)
  const unreadable = countUnreadable(storage.secrets, stored)
  if (!unreadable) return
  const keyFile = path.join(env.dataDir, 'secret.key')
  const why = storage.secrets.created ? `${keyFile} was missing, so a new one was made` : `${keyFile} isn't the key they were saved with`
  console.warn(
    `[secrets] ${why}: ${unreadable} saved secret${unreadable === 1 ? '' : 's'} (bank connections, AI keys) can't be read. Put the old secret.key back, or enter them again in App settings → Bank sync and AI.`,
  )
}

// Stops taking requests and stops the timers, then closes the database (which checkpoints the WAL).
let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  stopJobs()
  stopBankSync()
  const done = () => {
    storage.close()
    process.exit(0)
  }
  server.close(done)
  // Long-lived connections (an MCP stream, a keep-alive tab) don't hold up the exit for long.
  setTimeout(done, 5_000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
