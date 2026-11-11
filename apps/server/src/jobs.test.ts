import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAILY_TASKS, LAST_JOB_ERROR, runDailyJobs } from './jobs'
import type { AppContext } from './services/context'
import { getAppSetting } from './services/settings'
import { makeAccount, testLedger, testStorage } from './test/helpers'

afterEach(() => {
  vi.restoreAllMocks()
})

const tags = (ctx: AppContext) => ctx.q.column<string>('SELECT name FROM tags WHERE ledger_id = @ledger')
const addTag = (ctx: AppContext, name: string) => ctx.q.run('INSERT INTO tags (ledger_id, name) VALUES (@ledger, @name)', { name })

function twoLedgers() {
  const storage = testStorage()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return { storage, personal: storage.registry.defaultContext(), family: testLedger(storage) }
}

describe('daily jobs', () => {
  it('runs each ledger in its own transaction: one failing keeps none of its work and doesn’t stop the others', () => {
    const { storage, personal, family } = twoLedgers()
    const failed = runDailyJobs(storage, [
      (ctx) => {
        addTag(ctx, 'job')
        if (ctx.ledger.id === personal.ledger.id) throw new Error('boom')
        return null
      },
    ])
    expect(failed).toEqual([personal.ledger.id])
    expect([tags(personal), tags(family)]).toEqual([[], ['job']])
    expect(console.error).toHaveBeenCalledWith('[jobs] daily maintenance failed for Personal', expect.any(Error))
    // Only a query refused for its ledger pin is kept for App settings.
    expect(getAppSetting(storage.app, LAST_JOB_ERROR, null)).toBeNull()
  })

  it('keeps a query refused for a missing ledger pin where App settings can show it', () => {
    const { storage, family } = twoLedgers()
    const failed = runDailyJobs(storage, [
      (ctx) => {
        if (ctx.ledger.id === family.ledger.id) ctx.q.all('SELECT name FROM tags')
        return null
      },
    ])
    expect(failed).toEqual([family.ledger.id])
    expect(getAppSetting(storage.app, LAST_JOB_ERROR, null)).toEqual({ at: storage.now().toISOString(), ledger: 'Family', message: expect.stringContaining('tags') })
  })

  it('empties each active ledger’s trash, and leaves an archived ledger alone', () => {
    const { storage, personal, family } = twoLedgers()
    const trashed = (ctx: AppContext) =>
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, deleted_at)
         VALUES (@ledger, @account, '2026-01-01', -100, 'Old', 'old', '2026-01-02T00:00:00.000Z')`,
        { account: makeAccount(ctx) },
      )
    const archived = testLedger(storage, 'Old house')
    for (const ctx of [personal, family, archived]) trashed(ctx)
    storage.registry.update(archived.ledger.id, { archived: true })

    expect(runDailyJobs(storage, DAILY_TASKS)).toEqual([])
    const left = (ctx: AppContext) => ctx.q.pluck<number>('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')
    expect([left(personal), left(family), left(archived)]).toEqual([0, 0, 1])
  })

  it('gives the pages deleted rows freed back to the disk', () => {
    const { storage, personal } = twoLedgers()
    const account = makeAccount(personal)
    personal.q.transaction(() => {
      for (let i = 0; i < 2_000; i++) {
        personal.q.run(
          `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, notes)
           VALUES (@ledger, @account, '2026-01-01', -100, 'Shop', 'shop', @notes)`,
          { account, notes: 'x'.repeat(500) },
        )
      }
    })
    personal.q.run('DELETE FROM transactions WHERE ledger_id = @ledger')
    const free = () => storage.sqlite.pragma('freelist_count', { simple: true }) as number
    expect(free()).toBeGreaterThan(100)
    expect(runDailyJobs(storage, [])).toEqual([])
    expect(free()).toBe(0)
  })
})
