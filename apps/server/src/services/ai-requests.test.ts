import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiRecord, AiUsage, ApiKeyCreated } from '@chipmunk/shared'
import { recorded } from '../ai/records'
import type { LlmCategorizer } from '../ai/types'
import { createApp } from '../app'
import type { Storage } from '../storage'
import { categoryId, makeAccount, testLedger, testStorage } from '../test/helpers'
import { addTx } from '../test/transaction-twins'
import { aiUsage, ledgerAiUsage, retryAll, retryRecord, type AiCaller } from './ai-requests'
import type { AppContext } from './context'
import { aiJobStatus } from './import'
import { followBankPayee, nameWordings, renamePayee, worldOf } from './payee-names'
import { previewTidy, setAiTidy, tidyNewPayees, tidyStatus, type PayeeTidier } from './payee-tidy'
import { setPayeeChoice } from './payees'
import { updateSettings } from './settings'
import { deleteTransaction, updateTransaction } from './transactions'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

/** The providers' HTTP calls, stood in for: a model named here fails, every other one answers, and a request for names waits while `hold` is set. */
const provider = { down: new Set<string>(), asked: [] as string[], hold: null as Promise<void> | null }
vi.mock('../ai/providers', async (original) => ({
  ...(await original<typeof import('../ai/providers')>()),
  callProvider: vi.fn(async (cfg: { model: string }) => {
    provider.asked.push(cfg.model)
    if (provider.down.has(cfg.model)) throw new Error(`${cfg.model} is down`)
    return { category: 'Groceries', confidence: 0.8, inputTokens: 10, outputTokens: 5 }
  }),
  callStructured: vi.fn(async (cfg: { model: string }, call: { user: string }) => {
    provider.asked.push(cfg.model)
    if (provider.hold) await provider.hold
    if (provider.down.has(cfg.model)) throw new Error(`${cfg.model} is down`)
    const { payees } = JSON.parse(call.user) as { payees: string[] }
    return { data: { names: payees.map((payee) => ({ payee, name: `Tidy ${payee.toLowerCase()}` })) }, inputTokens: 100, outputTokens: 40 }
  }),
}))
beforeEach(() => {
  provider.down.clear()
  provider.asked.length = 0
  provider.hold = null
})

/** A stand-in for the AI that answers Groceries, fails while `down`, says nothing while `silent`, waits while `hold` is set, and says what it was asked. */
function fakeLlm() {
  const ai = {
    down: false,
    silent: false,
    hold: null as Promise<void> | null,
    asked: [] as string[],
    llm: (async (req) => {
      ai.asked.push(req.payee)
      if (ai.hold) await ai.hold
      if (ai.down) throw new Error('The provider took too long to answer.')
      if (ai.silent) return null
      return { category: 'Groceries', confidence: 0.8, slot: 'primary', model: 'fake-model' }
    }) as LlmCategorizer,
  }
  return ai
}

/** A stand-in for the AI that names payees, fails while `down`, and says what it was asked. */
function fakeTidier() {
  const ai = {
    down: false,
    asked: [] as string[][],
    tidier: (async (payees) => {
      ai.asked.push(payees)
      if (ai.down) throw new Error('The provider took too long to answer.')
      return { names: payees.map((payee) => ({ payee, name: `Tidy ${payee.toLowerCase()}` })), model: 'fake-model' }
    }) as PayeeTidier,
  }
  return ai
}

function setup(opts: { llm?: LlmCategorizer } = {}) {
  const storage = testStorage({ llm: opts.llm })
  const app = createApp(storage, { trustedHeader: null })
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as Json }
  }
  const key = async (input: { scopes: string[]; ledgers?: string[] }) => {
    const res = await call('POST', '/api-keys', { name: `${input.scopes.join('+')} key`, ...input })
    expect(res.status).toBe(201)
    return { authorization: `Bearer ${(res.body as ApiKeyCreated).key}` }
  }
  const usage = async (headers?: Record<string, string>) => (await call('GET', '/ai/usage', undefined, headers)).body as AiUsage
  const personal = storage.registry.defaultContext()
  return { storage, call, key, usage, personal }
}

const settle = async (done: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await done()); i++) await new Promise((r) => setTimeout(r, 5))
  expect(await done()).toBe(true)
}
/** The ledger's AI categorization, run to its end. */
async function categorize(s: ReturnType<typeof setup>, ctx: AppContext = s.personal) {
  expect((await s.call('POST', `/ledgers/${ctx.ledger.slug}/categorize/run`)).status).toBe(202)
  await settle(() => !aiJobStatus(ctx).running)
}
const idle = (s: ReturnType<typeof setup>) => settle(async () => (await s.usage()).retrying === 0)
const records = (ctx: AppContext) => ctx.q.all<Json>('SELECT * FROM ai_calls WHERE ledger_id = @ledger ORDER BY id')
const categoriesOf = (ctx: AppContext) =>
  ctx.q.all(
    `SELECT t.payee, c.name AS category, t.category_source AS source, t.category_confidence AS confidence, t.needs_review AS review
     FROM transactions t LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger ORDER BY t.date, t.id`,
  )
const useProviders = (storage: Storage, primary: string, fallback?: string) =>
  updateSettings(storage.app, {
    ai: {
      primary: { kind: 'anthropic', model: primary },
      ...(fallback && { fallback: { kind: 'openai-compatible', model: fallback, baseUrl: 'http://localhost:11434/v1' } }),
    },
  })

describe('AI request records: a payee to categorize', () => {
  it('corrects a failed request when it’s retried, and leaves the transactions as a request that worked does', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    const acc = makeAccount(s.personal)
    const add = (ctx: AppContext, account: number) => {
      addTx(ctx, account, '2026-09-01', -4_200, 'METRO #412')
      addTx(ctx, account, '2026-09-08', -1_900, 'METRO #412')
    }
    add(s.personal, acc)
    ai.down = true
    await categorize(s)

    const failed = await s.usage()
    expect(failed).toMatchObject({ requests: 1, failed: 1, retryable: 1, retrying: 0 })
    const [before] = failed.recent
    expect(before).toMatchObject({
      kind: 'categorize',
      subject: 'METRO #412',
      payees: null,
      ledger: 'Personal',
      ledgerSlug: 'personal',
      ok: false,
      status: 'failed',
      canRetry: true,
      outcome: null,
      tries: 1,
      error: 'The provider took too long to answer.',
      primaryError: null,
    })
    expect(before!.firstFailedAt).toBe(before!.triedAt)
    expect(categoriesOf(s.personal).map((r: Json) => r.category)).toEqual([null, null])

    ai.down = false
    const retry = await s.call('POST', `/ledgers/personal/ai/usage/${before!.id}/retry`)
    expect([retry.status, retry.body]).toEqual([202, { started: 1, working: 0 }])
    await idle(s)

    const after = await s.usage()
    expect(after).toMatchObject({ requests: 1, failed: 0, retryable: 0 })
    expect(after.recent).toHaveLength(1)
    expect(after.recent[0]).toMatchObject({
      id: before!.id,
      ok: true,
      status: 'ok',
      canRetry: false,
      outcome: 'Groceries',
      model: 'fake-model',
      tries: 2,
      firstFailedAt: before!.firstFailedAt,
      createdAt: before!.createdAt,
      error: null,
    })
    // One request for the payee each time, however many transactions it has.
    expect(ai.asked).toEqual(['METRO #412', 'METRO #412'])

    // The same as where it worked the first time.
    const fine = setup({ llm: fakeLlm().llm })
    add(fine.personal, makeAccount(fine.personal))
    await categorize(fine)
    expect(categoriesOf(s.personal)).toEqual(categoriesOf(fine.personal))
    expect(categoriesOf(s.personal)).toEqual([
      { payee: 'METRO #412', category: 'Groceries', source: 'ai', confidence: 0.8, review: 1 },
      { payee: 'METRO #412', category: 'Groceries', source: 'ai', confidence: 0.8, review: 1 },
    ])
    // Answered, it isn't asked again.
    const again = await s.call('POST', `/ledgers/personal/ai/usage/${before!.id}/retry`)
    expect([again.status, again.body.error.message]).toEqual([409, 'This request was answered, so there’s nothing to ask again.'])
  })

  it('records the primary failing and the fallback answering as one request that worked', async () => {
    const s = setup()
    useProviders(s.storage, 'broken', 'llama')
    provider.down.add('broken')
    addTx(s.personal, makeAccount(s.personal), '2026-09-01', -4_200, 'METRO #412')
    await categorize(s)

    expect(provider.asked).toEqual(['broken', 'llama'])
    const usage = await s.usage()
    expect(usage).toMatchObject({ requests: 1, failed: 0, retryable: 0, inputTokens: 10, outputTokens: 5 })
    expect(usage.recent).toEqual([
      expect.objectContaining({ kind: 'categorize', ok: true, status: 'ok', slot: 'fallback', model: 'llama', outcome: 'Groceries', primaryError: 'broken is down', error: null, tries: 1, firstFailedAt: null }),
    ])

    // Both down: one failed record, with each one's reason.
    provider.down.add('llama')
    addTx(s.personal, makeAccount(s.personal, 'Visa', 'credit'), '2026-09-02', -900, 'BEAN BAR')
    await categorize(s)
    expect((await s.usage()).recent[0]).toMatchObject({ subject: 'BEAN BAR', ok: false, slot: 'fallback', model: 'llama', error: 'llama is down', primaryError: 'broken is down' })
    expect(records(s.personal)).toHaveLength(2)
  })

  it('counts the tokens of every call made for a request, a failed one’s and each try’s', async () => {
    const { personal } = setup()
    const ask = { kind: 'categorize' as const, subject: 'Metro', key: 'out:metro' }
    const failing = recorded(
      personal,
      ask,
      async (log) => {
        log.push({ slot: 'primary', model: 'a', ok: false, error: 'not JSON', inputTokens: 7, outputTokens: 1 })
        log.push({ slot: 'fallback', model: 'b', ok: false, error: 'timed out' })
        throw new Error('timed out')
      },
      () => ({ outcome: null }),
    )
    await expect(failing).rejects.toThrow('timed out')
    expect(records(personal)).toEqual([expect.objectContaining({ ok: 0, tries: 1, input_tokens: 7, output_tokens: 1, error: 'timed out', primary_error: 'not JSON' })])
    await recorded(
      personal,
      ask,
      async (log) => {
        log.push({ slot: 'primary', model: 'a', ok: false, error: 'not JSON', inputTokens: 7, outputTokens: 2 })
        log.push({ slot: 'fallback', model: 'b', ok: true, inputTokens: 10, outputTokens: 5 })
      },
      () => ({ outcome: 'Groceries' }),
    )
    expect(records(personal)).toEqual([
      expect.objectContaining({ ok: 1, tries: 2, input_tokens: 24, output_tokens: 8, slot: 'fallback', model: 'b', error: null, primary_error: 'not JSON', outcome: 'Groceries' }),
    ])
  })

  it('corrects an open failure when a later run answers, and keeps the newest error until then', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    const acc = makeAccount(s.personal)
    addTx(s.personal, acc, '2026-09-01', -4_200, 'METRO #412')
    ai.down = true
    await categorize(s)
    const [first] = records(s.personal)
    // It fails again, another way: the same record, with the newest reason.
    ai.down = false
    ai.silent = true
    await categorize(s)
    expect(records(s.personal)).toEqual([expect.objectContaining({ id: first.id, ok: 0, tries: 2, error: 'AI gave no answer.', first_failed_at: first.first_failed_at })])
    // A suggestion asked for the same payee while typing fails too: still the one record.
    const typed = await s.call('POST', '/ledgers/personal/categorize/suggest', { payee: 'METRO #412', amountMinor: -500, accountId: acc })
    expect([typed.status, typed.body.categoryId]).toEqual([200, null])
    expect(records(s.personal)).toEqual([expect.objectContaining({ id: first.id, ok: 0, tries: 3 })])

    // More of the payee comes with a sync, and “Categorize uncategorized now” gets an answer.
    ai.silent = false
    addTx(s.personal, acc, '2026-09-15', -2_000, 'METRO #412', { origin: 'sync' })
    await categorize(s)
    expect(records(s.personal)).toEqual([
      expect.objectContaining({ id: first.id, ok: 1, tries: 4, outcome: 'Groceries', error: null, first_failed_at: first.first_failed_at, created_at: first.created_at }),
    ])
    expect(await s.usage()).toMatchObject({ requests: 1, failed: 0, retryable: 0 })
    expect(categoriesOf(s.personal).map((r: Json) => r.category)).toEqual(['Groceries', 'Groceries'])
  })

  it('reads a failure as no longer needed once the payee is categorized by hand, without writing anything', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    const acc = makeAccount(s.personal)
    const id = addTx(s.personal, acc, '2026-09-01', -4_200, 'METRO #412')
    ai.down = true
    await categorize(s)
    // A suggestion for a payee with nothing uncategorized fails: never needed again.
    await s.call('POST', '/ledgers/personal/categorize/suggest', { payee: 'BEAN BAR', amountMinor: -500, accountId: acc })
    expect(await s.usage()).toMatchObject({ requests: 2, failed: 1, retryable: 1 })

    const patched = await s.call('PATCH', `/ledgers/personal/transactions/${id}`, { categoryId: categoryId(s.personal, 'Dine out') })
    expect(patched.status).toBe(200)
    const kept = records(s.personal)
    const changes = () => s.storage.sqlite.prepare('SELECT total_changes()').pluck().get()
    const writes = changes()
    const usage = await s.usage()
    const own = (await s.call('GET', '/ledgers/personal/ai/usage')).body as AiUsage
    expect(changes()).toBe(writes)
    expect(records(s.personal)).toEqual(kept)
    expect(kept.map((r: Json) => r.ok)).toEqual([0, 0])

    expect(usage).toMatchObject({ requests: 2, failed: 0, retryable: 0 })
    expect(own).toEqual(usage)
    expect(usage.recent.map((r) => [r.subject, r.status, r.canRetry, r.ok])).toEqual([
      ['BEAN BAR', 'unneeded', false, false],
      ['METRO #412', 'unneeded', false, false],
    ])
    const retry = await s.call('POST', `/ledgers/personal/ai/usage/${usage.recent[1]!.id}/retry`)
    expect([retry.status, retry.body.error.message]).toEqual([409, 'This is no longer needed: the payee has no uncategorized transaction left.'])
    expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 0, working: 0 })
    expect(ai.asked).toEqual(['METRO #412', 'BEAN BAR'])

    // Uncategorized again, it's a failure again, to retry.
    await s.call('PATCH', `/ledgers/personal/transactions/${id}`, { categoryId: null })
    expect((await s.usage()).recent.map((r) => [r.subject, r.status, r.canRetry])).toEqual([
      ['BEAN BAR', 'unneeded', false],
      ['METRO #412', 'failed', true],
    ])
  })

  it('answers that AI is already working while the ledger’s job runs, and starts nothing', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    const acc = makeAccount(s.personal)
    addTx(s.personal, acc, '2026-09-01', -4_200, 'METRO #412')
    ai.down = true
    await categorize(s)
    const [failed] = (await s.usage()).recent

    let release!: () => void
    ai.hold = new Promise<void>((r) => (release = r))
    ai.asked.length = 0
    expect((await s.call('POST', '/ledgers/personal/categorize/run')).status).toBe(202)
    expect(aiJobStatus(s.personal).running).toBe(true)
    const one = await s.call('POST', `/ledgers/personal/ai/usage/${failed!.id}/retry`)
    expect([one.status, one.body.error.message]).toEqual([409, 'AI is already working in this ledger. Try again when it’s done.'])
    const all = await s.call('POST', '/ai/usage/retry')
    expect([all.status, all.body]).toEqual([202, { started: 0, working: 1 }])
    expect((await s.usage()).retrying).toBe(0)
    release()
    await settle(() => !aiJobStatus(s.personal).running)
    // Only the run that was going asked.
    expect(ai.asked).toEqual(['METRO #412'])
    expect(records(s.personal)).toEqual([expect.objectContaining({ id: failed!.id, tries: 2 })])
  })

  it('retries every open failure in the ledgers a key can use, and shows it nothing of the others', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    const family = testLedger(s.storage)
    addTx(s.personal, makeAccount(s.personal), '2026-09-01', -4_200, 'METRO #412')
    const acc = makeAccount(family)
    // More failures than the list shows.
    for (let i = 0; i < 22; i++) addTx(family, acc, '2026-09-02', -900 - i, `FAMILY SHOP ${i}`)
    ai.down = true
    await categorize(s)
    await categorize(s, family)
    expect(await s.usage()).toMatchObject({ requests: 23, failed: 23, retryable: 23 })

    const limited = await s.key({ scopes: ['write'], ledgers: [family.ledger.id] })
    const reader = await s.key({ scopes: ['read'], ledgers: [family.ledger.id] })
    const theirs = await s.usage(limited)
    expect(theirs).toMatchObject({ requests: 22, failed: 22, retryable: 22 })
    expect(theirs.recent).toHaveLength(20)
    expect(JSON.stringify(theirs)).not.toContain('METRO')
    expect(new Set(theirs.recent.map((r) => r.ledgerSlug))).toEqual(new Set(['family']))
    // A key that only reads sees them, and can retry none.
    expect(await s.usage(reader)).toMatchObject({ failed: 22, retryable: 0 })
    expect((await s.call('POST', '/ai/usage/retry', undefined, reader)).status).toBe(403)
    expect((await s.call('POST', `/ledgers/personal/ai/usage/${records(s.personal)[0].id}/retry`, undefined, limited)).status).toBe(403)

    ai.down = false
    ai.asked.length = 0
    const retry = await s.call('POST', '/ai/usage/retry', undefined, limited)
    expect([retry.status, retry.body]).toEqual([202, { started: 22, working: 0 }])
    expect((await s.usage(limited)).retrying).toBe(22)
    await idle(s)
    expect(ai.asked).toHaveLength(22)
    expect(ai.asked.every((p) => p.startsWith('FAMILY SHOP'))).toBe(true)
    expect(await s.usage(limited)).toMatchObject({ requests: 22, failed: 0, retryable: 0, retrying: 0 })
    expect(records(family).every((r: Json) => r.ok === 1 && r.tries === 2)).toBe(true)
    // Personal's failure is as it was, until someone who can use it asks.
    expect(records(s.personal)).toEqual([expect.objectContaining({ ok: 0, tries: 1 })])
    expect(await s.usage()).toMatchObject({ requests: 23, failed: 1, retryable: 1 })
    expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 1, working: 0 })
    await idle(s)
    expect(await s.usage()).toMatchObject({ failed: 0, retryable: 0 })
  })
})

describe('AI request records: connection tests and requests from before', () => {
  it('records a connection test, which is never asked again', async () => {
    const s = setup()
    useProviders(s.storage, 'claude', 'llama')
    provider.down.add('llama')
    expect((await s.call('POST', '/settings/ai/test', { slot: 'primary' })).body).toMatchObject({ ok: true, category: 'Groceries', model: 'claude' })
    expect((await s.call('POST', '/settings/ai/test', { slot: 'fallback' })).body).toMatchObject({ ok: false, error: 'llama is down' })
    expect((await s.call('POST', '/settings/ai/test', { slot: 'fallback' })).body).toMatchObject({ ok: false })

    const usage = await s.usage()
    expect(usage).toMatchObject({ requests: 3, failed: 2, retryable: 0, inputTokens: 10 })
    expect(usage.recent.map((r) => [r.kind, r.slot, r.model, r.status, r.canRetry, r.outcome, r.subject])).toEqual([
      ['test', 'fallback', 'llama', 'failed', false, null, null],
      ['test', 'fallback', 'llama', 'failed', false, null, null],
      ['test', 'primary', 'claude', 'ok', false, 'Groceries', null],
    ])
    const retry = await s.call('POST', `/ledgers/personal/ai/usage/${usage.recent[0]!.id}/retry`)
    expect([retry.status, retry.body.error.message]).toEqual([409, 'A connection test isn’t asked again. Test the connection in App settings → AI.'])
    expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 0, working: 0 })
    expect(provider.asked).toEqual(['claude', 'llama', 'llama'])
  })

  it('lists the rows from before as they were, and retries none of them', async () => {
    const s = setup({ llm: fakeLlm().llm })
    const old = (ok: number, at: string, error: string | null) =>
      Number(
        s.personal.q.run(
          `INSERT INTO ai_calls (ledger_id, created_at, slot, model, latency_ms, ok, error, input_tokens, output_tokens)
           VALUES (@ledger, @at, 'primary', 'old-model', 321, @ok, @error, 50, 4)`,
          { ok, at, error },
        ).lastInsertRowid,
      )
    const worked = old(1, '2026-09-01T10:00:00.000Z', null)
    const failed = old(0, '2026-09-01T11:00:00.000Z', '429 · Too many requests, or the account is out of credit.')
    const usage = await s.usage()
    expect(usage).toMatchObject({ requests: 2, failed: 1, retryable: 0, inputTokens: 100, outputTokens: 8 })
    const legacy = { kind: null, subject: null, payees: null, outcome: null, named: null, tries: 1, firstFailedAt: null, primaryError: null, canRetry: false, retrying: false, slot: 'primary', model: 'old-model', latencyMs: 321 }
    expect(usage.recent).toEqual([
      expect.objectContaining({ ...legacy, id: failed, ok: false, status: 'failed', error: '429 · Too many requests, or the account is out of credit.', createdAt: '2026-09-01T11:00:00.000Z', triedAt: '2026-09-01T11:00:00.000Z' }),
      expect.objectContaining({ ...legacy, id: worked, ok: true, status: 'ok', error: null, createdAt: '2026-09-01T10:00:00.000Z', triedAt: '2026-09-01T10:00:00.000Z' }),
    ])
    for (const id of [failed, worked]) {
      const retry = await s.call('POST', `/ledgers/personal/ai/usage/${id}/retry`)
      expect([retry.status, retry.body.error.message]).toEqual([409, 'This request is from before the app kept what each one was for, so it can’t be asked again.'])
    }
    expect((await s.call('POST', '/ledgers/personal/ai/usage/999999/retry')).status).toBe(404)
    expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 0, working: 0 })
    expect(records(s.personal).map((r: Json) => [r.id, r.ok, r.tries, r.kind, r.tried_at])).toEqual([
      [worked, 1, 1, null, null],
      [failed, 0, 1, null, null],
    ])
  })
})

describe('AI request records: payees to name', () => {
  const PAYEES = ['SHOP A #1', 'SHOP B #2', 'SHOP C #3']
  function world() {
    const storage = testStorage()
    const ctx = storage.registry.defaultContext()
    const acc = makeAccount(ctx)
    PAYEES.forEach((payee, i) => addTx(ctx, acc, '2026-09-01', -100 - i, payee, { categoryId: categoryId(ctx, 'Groceries') }))
    const all = worldOf(storage)
    const who: AiCaller = { write: true, everyLedger: true, world: all }
    const done = () => settle(() => !tidyStatus(all).running && ledgerAiUsage(ctx, who).retrying === 0)
    return { storage, ctx, all, who, done, recent: () => ledgerAiUsage(ctx, who).recent }
  }

  it('corrects a failed request when it’s retried', async () => {
    const w = world()
    const ai = fakeTidier()
    ai.down = true
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow('The provider took too long to answer.')
    expect(ledgerAiUsage(w.ctx, w.who)).toMatchObject({ requests: 1, failed: 1, retryable: 1 })
    const [before] = w.recent()
    expect(before).toMatchObject({ kind: 'names', subject: null, payees: 3, ok: false, status: 'failed', canRetry: true, named: null, outcome: null, tries: 1 })

    ai.down = false
    expect(retryRecord(w.ctx, w.who, before!.id, ai.tidier)).toEqual({ started: 1, working: 0 })
    expect(w.recent()[0]).toMatchObject({ retrying: true })
    await w.done()
    expect(w.recent()).toEqual([
      expect.objectContaining({ id: before!.id, ok: true, status: 'ok', canRetry: false, named: 3, payees: 3, model: 'fake-model', tries: 2, firstFailedAt: before!.firstFailedAt, error: null, retrying: false }),
    ])
    expect(ai.asked).toEqual([PAYEES, PAYEES])
    expect(tidyStatus(w.all).names.map((n) => n.tidied)).toEqual(['Tidy shop a #1', 'Tidy shop b #2', 'Tidy shop c #3'])
    expect(() => retryRecord(w.ctx, w.who, before!.id, ai.tidier)).toThrow('This request was answered, so there’s nothing to ask again.')
  })

  it('corrects an open failure when the next run names the same payees', async () => {
    const w = world()
    const ai = fakeTidier()
    ai.down = true
    setAiTidy(w.all, true, ai.tidier)
    await w.done()
    expect(tidyStatus(w.all).error).toBe('The provider took too long to answer.')
    const [first] = records(w.ctx)
    expect(first).toMatchObject({ kind: 'names', ok: 0, tries: 1, subject_key: JSON.stringify(PAYEES) })
    // Again, as after the next sync: it fails once more, then names them.
    await tidyNewPayees(w.all, ai.tidier)
    expect(records(w.ctx)).toEqual([expect.objectContaining({ id: first.id, ok: 0, tries: 2 })])
    ai.down = false
    await tidyNewPayees(w.all, ai.tidier)
    expect(records(w.ctx)).toEqual([expect.objectContaining({ id: first.id, ok: 1, tries: 3, outcome: '3', first_failed_at: first.first_failed_at })])
    expect(ledgerAiUsage(w.ctx, w.who)).toMatchObject({ requests: 1, failed: 0, retryable: 0 })
  })

  it('asks again only for the payees still without a name, and reads as no longer needed once all have one', async () => {
    const w = world()
    const ai = fakeTidier()
    ai.down = true
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    const [failed] = w.recent()
    // One is named by hand.
    renamePayee(w.all, { payee: 'SHOP B #2', name: 'Shop B' })
    expect(w.recent()[0]).toMatchObject({ status: 'failed', canRetry: true, payees: 3 })
    ai.down = false
    ai.asked.length = 0
    expect(retryAll([w.ctx], w.who, undefined, ai.tidier)).toEqual({ started: 1, working: 0 })
    await w.done()
    expect(ai.asked).toEqual([['SHOP A #1', 'SHOP C #3']])
    expect(w.recent()).toEqual([expect.objectContaining({ id: failed!.id, ok: true, named: 2, payees: 3, tries: 2 })])

    // A second failure (the new payee, and the one that has no AI name), then both named by hand: nothing left to ask.
    const acc = makeAccount(w.ctx, 'Visa', 'credit')
    addTx(w.ctx, acc, '2026-09-03', -700, 'SHOP D #4', { categoryId: categoryId(w.ctx, 'Groceries') })
    ai.down = true
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    const kept = records(w.ctx)
    renamePayee(w.all, { payee: 'SHOP D #4', name: 'Shop D' })
    const changes = () => w.storage.sqlite.prepare('SELECT total_changes()').pluck().get()
    const writes = changes()
    const usage = ledgerAiUsage(w.ctx, w.who)
    expect(changes()).toBe(writes)
    expect(records(w.ctx)).toEqual(kept)
    expect(usage).toMatchObject({ requests: 2, failed: 0, retryable: 0 })
    expect(usage.recent[0]).toMatchObject({ kind: 'names', payees: 2, ok: false, status: 'unneeded', canRetry: false })
    expect(() => retryRecord(w.ctx, w.who, usage.recent[0]!.id, ai.tidier)).toThrow('This is no longer needed: the payees all have names now.')
    expect(retryAll([w.ctx], w.who, undefined, ai.tidier)).toEqual({ started: 0, working: 0 })
  })

  it('gives a caller that can’t use every ledger nothing of a request to name payees', async () => {
    const s = setup()
    useProviders(s.storage, 'claude')
    const family = testLedger(s.storage)
    const acc = makeAccount(family)
    // Payees of Family only, and the record sits in Personal, the first ledger.
    PAYEES.forEach((payee, i) => addTx(family, acc, '2026-09-01', -100 - i, payee, { categoryId: categoryId(family, 'Groceries') }))
    expect((await s.call('POST', '/payees/tidy/preview', { page: 0 })).status).toBe(200)
    addTx(family, acc, '2026-09-04', -900, 'SHOP D #4', { categoryId: categoryId(family, 'Groceries') })
    provider.down.add('claude')
    expect((await s.call('POST', '/payees/tidy/preview', { page: 0 })).status).toBe(400)
    expect(records(s.personal).map((r: Json) => [r.kind, r.ok])).toEqual([['names', 1], ['names', 0]])
    expect(records(family)).toEqual([])
    const all = await s.usage()
    expect(all).toMatchObject({ requests: 2, failed: 1, retryable: 1, inputTokens: 100, outputTokens: 40 })
    const failed = all.recent[0]!

    const none = { requests: 0, failed: 0, retryable: 0, retrying: 0, inputTokens: 0, outputTokens: 0, recent: [] }
    for (const ledger of [s.personal, family]) {
      const limited = await s.key({ scopes: ['write'], ledgers: [ledger.ledger.id] })
      expect(await s.usage(limited)).toEqual(none)
      expect((await s.call('GET', `/ledgers/${ledger.ledger.slug}/ai/usage`, undefined, limited)).body).toEqual(none)
      expect((await s.call('POST', '/ai/usage/retry', undefined, limited)).body).toEqual({ started: 0, working: 0 })
    }
    // Its id is answered like one that doesn't exist.
    const limited = await s.key({ scopes: ['write'], ledgers: [s.personal.ledger.id] })
    const theirs = await s.call('POST', `/ledgers/personal/ai/usage/${failed.id}/retry`, undefined, limited)
    const unknown = await s.call('POST', '/ledgers/personal/ai/usage/999999/retry', undefined, limited)
    expect(theirs.status).toBe(404)
    expect(theirs).toEqual(unknown)
    expect(provider.asked).toEqual(['claude', 'claude'])
    // A key for every ledger gets it as you do.
    expect(await s.usage(await s.key({ scopes: ['write'] }))).toEqual(all)

    // While it's being asked again, the limited key isn't told so either.
    provider.down.clear()
    let release!: () => void
    provider.hold = new Promise<void>((r) => (release = r))
    expect((await s.call('POST', `/ledgers/personal/ai/usage/${failed.id}/retry`)).body).toEqual({ started: 1, working: 0 })
    expect(await s.usage()).toMatchObject({ retrying: 1, recent: expect.arrayContaining([expect.objectContaining({ id: failed.id, retrying: true })]) })
    expect(await s.usage(limited)).toEqual(none)
    expect((await s.call('GET', '/ledgers/personal/ai/usage', undefined, limited)).body).toEqual(none)
    release()
    await idle(s)
    expect(await s.usage(limited)).toEqual(none)
    expect(await s.usage()).toMatchObject({ failed: 0, retrying: 0 })
  })

  it('asks again in one run for the failed requests of every ledger, each payee once', async () => {
    const w = world()
    const ai = fakeTidier()
    ai.down = true
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    // A failed request about other payees is in another ledger.
    const family = testLedger(w.storage)
    const acc = makeAccount(family)
    const OTHERS = ['SHOP X #8', 'SHOP Y #9']
    OTHERS.forEach((payee, i) => addTx(family, acc, '2026-09-02', -300 - i, payee, { categoryId: categoryId(family, 'Groceries') }))
    family.q.run(
      `INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok, error, kind, subject_key, tries, first_failed_at)
       VALUES (@ledger, 'primary', 'fake-model', 5, 0, 'down', 'names', ?, 1, '2026-09-01T10:00:00.000Z')`,
      JSON.stringify(OTHERS),
    )
    expect(aiUsage([w.ctx, family], w.who)).toMatchObject({ requests: 2, failed: 2, retryable: 2 })

    ai.down = false
    ai.asked.length = 0
    const started: Array<[string, number]> = []
    expect(retryAll([w.ctx, family], w.who, (ctx, count) => started.push([ctx.ledger.name, count]), ai.tidier)).toEqual({ started: 2, working: 0 })
    expect(started).toEqual([
      ['Personal', 1],
      ['Family', 1],
    ])
    expect(aiUsage([w.ctx, family], w.who).retrying).toBe(2)
    await settle(() => !tidyStatus(w.all).running && aiUsage([w.ctx, family], w.who).retrying === 0)
    expect(ai.asked).toEqual([PAYEES, OTHERS])
    expect(records(w.ctx)).toEqual([expect.objectContaining({ ok: 1, tries: 2, outcome: '3' })])
    expect(records(family)).toEqual([expect.objectContaining({ ok: 1, tries: 2, outcome: '2' })])
    expect(aiUsage([w.ctx, family], w.who)).toMatchObject({ requests: 2, failed: 0, retryable: 0 })

    // One at a time, the other ledger's is left while the first is being asked.
    ai.down = true
    addTx(w.ctx, makeAccount(w.ctx, 'Visa', 'credit'), '2026-09-03', -700, 'SHOP D #4', { categoryId: categoryId(w.ctx, 'Groceries') })
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    const open = aiUsage([w.ctx, family], w.who).recent.filter((r) => r.status === 'failed')
    expect(open).toHaveLength(1)
    ai.down = false
    expect(retryAll([w.ctx, family], w.who, undefined, ai.tidier)).toEqual({ started: 1, working: 0 })
    expect(retryAll([w.ctx, family], w.who, undefined, ai.tidier)).toEqual({ started: 0, working: 1 })
    await settle(() => !tidyStatus(w.all).running && aiUsage([w.ctx, family], w.who).retrying === 0)
    expect(aiUsage([w.ctx, family], w.who)).toMatchObject({ failed: 0 })
  })

  it('corrects a retried request in the ledger its record is in, whichever ledger comes first by then', async () => {
    const w = world()
    const ai = fakeTidier()
    ai.down = true
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    const [first] = records(w.ctx)
    // Another ledger now comes first.
    const family = testLedger(w.storage)
    w.storage.sqlite.prepare('UPDATE ledgers SET sort = -1 WHERE id = ?').run(family.ledger.id)
    expect(w.all.ledgers()[0]!.ledger.id).toBe(family.ledger.id)

    expect(retryRecord(w.ctx, w.who, first.id, ai.tidier)).toEqual({ started: 1, working: 0 })
    await w.done()
    // The same payees asked for anew (a preview, the next sync) correct it too, where it is.
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    expect(records(w.ctx)).toEqual([expect.objectContaining({ id: first.id, ok: 0, tries: 3 })])
    expect(records(family)).toEqual([])
    expect(aiUsage([family, w.ctx], w.who)).toMatchObject({ requests: 1, failed: 1, retryable: 1 })

    ai.down = false
    expect(retryAll([family, w.ctx], w.who, undefined, ai.tidier)).toEqual({ started: 1, working: 0 })
    await w.done()
    expect(records(w.ctx)).toEqual([expect.objectContaining({ id: first.id, ok: 1, tries: 4, outcome: '3', first_failed_at: first.first_failed_at })])
    expect(records(family)).toEqual([])
    // A new request, with no open record anywhere, goes to the first ledger.
    addTx(w.ctx, makeAccount(w.ctx, 'Visa', 'credit'), '2026-09-03', -700, 'SHOP D #4', { categoryId: categoryId(w.ctx, 'Groceries') })
    await previewTidy(w.all, 0, ai.tidier)
    expect(records(family)).toEqual([expect.objectContaining({ kind: 'names', ok: 1, outcome: '1' })])
  })

  it('asks once for a payee that several failed requests share', async () => {
    const w = world()
    const ai = fakeTidier()
    ai.down = true
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    addTx(w.ctx, makeAccount(w.ctx, 'Visa', 'credit'), '2026-09-03', -700, 'SHOP D #4', { categoryId: categoryId(w.ctx, 'Groceries') })
    await expect(previewTidy(w.all, 0, ai.tidier)).rejects.toThrow()
    const [three, four] = w.recent().reverse()
    expect([three!.payees, four!.payees]).toEqual([3, 4])
    expect(ledgerAiUsage(w.ctx, w.who)).toMatchObject({ requests: 2, failed: 2, retryable: 2 })

    ai.down = false
    ai.asked.length = 0
    expect(retryAll([w.ctx], w.who, undefined, ai.tidier)).toEqual({ started: 2, working: 0 })
    await w.done()
    // The second is asked only for what the first didn't just name.
    expect(ai.asked).toEqual([PAYEES, ['SHOP D #4']])
    expect(w.recent().reverse()).toEqual([
      expect.objectContaining({ id: three!.id, ok: true, named: 3, tries: 2 }),
      expect.objectContaining({ id: four!.id, ok: true, named: 1, tries: 2 }),
    ])

    // With nothing left for the second, it isn't asked: it reads as no longer needed.
    const again = world()
    ai.down = true
    await expect(previewTidy(again.all, 0, ai.tidier)).rejects.toThrow()
    const [open] = records(again.ctx)
    again.ctx.q.run(`UPDATE ai_calls SET subject_key = ? WHERE ledger_id = @ledger AND id = ?`, JSON.stringify(PAYEES.slice(0, 2)), open.id)
    again.ctx.q.run(
      `INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok, error, kind, subject_key, tries, first_failed_at)
       VALUES (@ledger, 'primary', 'fake-model', 5, 0, 'down', 'names', ?, 1, '2026-09-01T10:00:00.000Z')`,
      JSON.stringify(PAYEES),
    )
    again.ctx.q.run(
      `INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok, error, kind, subject_key, tries, first_failed_at)
       VALUES (@ledger, 'primary', 'fake-model', 5, 0, 'down', 'names', ?, 1, '2026-09-01T10:00:00.000Z')`,
      JSON.stringify(PAYEES.slice(1)),
    )
    ai.down = false
    ai.asked.length = 0
    expect(retryAll([again.ctx], again.who, undefined, ai.tidier)).toEqual({ started: 3, working: 0 })
    await again.done()
    expect(ai.asked).toEqual([PAYEES.slice(0, 2), ['SHOP C #3']])
    expect(again.recent().reverse().map((r) => [r.status, r.tries, r.named])).toEqual([
      ['ok', 2, 2],
      ['ok', 2, 1],
      ['unneeded', 1, null],
    ])
  })

  it('records the primary failing and the fallback naming them as one request, through the API', async () => {
    const s = setup()
    useProviders(s.storage, 'broken', 'llama')
    provider.down.add('broken')
    const acc = makeAccount(s.personal)
    PAYEES.forEach((payee, i) => addTx(s.personal, acc, '2026-09-01', -100 - i, payee, { categoryId: categoryId(s.personal, 'Groceries') }))
    const preview = await s.call('POST', '/payees/tidy/preview', { page: 0 })
    expect([preview.status, preview.body.samples.length]).toEqual([200, 3])
    const usage = await s.usage()
    expect(usage).toMatchObject({ requests: 1, failed: 0, retryable: 0, inputTokens: 100, outputTokens: 40 })
    expect(usage.recent).toEqual([
      expect.objectContaining<Partial<AiRecord>>({ kind: 'names', payees: 3, named: 3, ok: true, slot: 'fallback', model: 'llama', primaryError: 'broken is down', tries: 1 }),
    ])

    // Both down, then back: the retry through the API names the new payee, in the same record.
    addTx(s.personal, acc, '2026-09-04', -900, 'SHOP D #4', { categoryId: categoryId(s.personal, 'Groceries') })
    provider.down.add('llama')
    expect((await s.call('POST', '/payees/tidy/preview', { page: 0 })).status).toBe(400)
    const [failed] = (await s.usage()).recent
    expect(failed).toMatchObject({ kind: 'names', payees: 1, status: 'failed', canRetry: true, error: 'llama is down', primaryError: 'broken is down' })
    provider.down.clear()
    const retry = await s.call('POST', `/ledgers/personal/ai/usage/${failed!.id}/retry`)
    expect([retry.status, retry.body]).toEqual([202, { started: 1, working: 0 }])
    await idle(s)
    expect((await s.usage()).recent[0]).toMatchObject({ id: failed!.id, ok: true, named: 1, slot: 'primary', model: 'broken', primaryError: null, tries: 2, firstFailedAt: failed!.firstFailedAt })
    expect(records(s.personal)).toHaveLength(2)
  })
})

describe('AI request records: a payee named after its request failed', () => {
  /** One uncategorized METRO #412 whose request failed, the provider back since. */
  async function failedOnce() {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    const acc = makeAccount(s.personal)
    addTx(s.personal, acc, '2026-09-01', -4_200, 'METRO #412')
    ai.down = true
    await categorize(s)
    ai.down = false
    const [failed] = (await s.usage()).recent
    expect(failed).toMatchObject({ subject: 'METRO #412', status: 'failed', canRetry: true })
    return { ai, s, acc, failed: failed!, world: worldOf(s.storage) }
  }
  /** It's still a failure to retry, under the payee's new name, and the retry categorizes the transaction and corrects the same record. */
  async function retried(t: Awaited<ReturnType<typeof failedOnce>>, name: string, key: string, retry: () => Promise<Json>, requests = 1) {
    const asked = () => records(t.s.personal).filter((r: Json) => r.kind === 'categorize')
    expect(asked()).toEqual([expect.objectContaining({ id: t.failed.id, ok: 0, tries: 1, subject: name, subject_key: `out:${key}` })])
    expect(await t.s.usage()).toMatchObject({ requests, failed: 1, retryable: 1 })
    expect((await t.s.usage()).recent.filter((r) => r.kind === 'categorize')).toEqual([expect.objectContaining({ id: t.failed.id, subject: name, status: 'failed', canRetry: true })])
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual([null])
    expect((await retry()).body).toEqual({ started: 1, working: 0 })
    await idle(t.s)
    expect(categoriesOf(t.s.personal)).toEqual([{ payee: 'METRO #412', category: 'Groceries', source: 'ai', confidence: 0.8, review: 1 }])
    expect(asked()).toEqual([
      expect.objectContaining({ id: t.failed.id, ok: 1, tries: 2, outcome: 'Groceries', subject: name, first_failed_at: t.failed.firstFailedAt }),
    ])
    expect(await t.s.usage()).toMatchObject({ requests, failed: 0, retryable: 0 })
  }

  it('keeps the failure with the payee when AI tidying names it', async () => {
    const t = await failedOnce()
    const tidy = fakeTidier()
    setAiTidy(t.world, true, tidy.tidier)
    await settle(() => !tidyStatus(t.world).running)
    expect(t.s.personal.q.column('SELECT payee_key FROM transactions WHERE ledger_id = @ledger')).toEqual(['tidy metro 412'])
    // The request that named it is a record too.
    await retried(t, 'Tidy metro #412', 'tidy metro 412', () => t.s.call('POST', '/ai/usage/retry'), 2)
  })

  it('keeps the failure with the payee when a rule of yours names it, and when it goes back to its own name', async () => {
    const t = await failedOnce()
    renamePayee(t.world, { payee: 'METRO #412', name: 'Metro' })
    expect((await t.s.usage()).recent[0]).toMatchObject({ id: t.failed.id, subject: 'Metro', status: 'failed', canRetry: true })
    renamePayee(t.world, { payee: 'METRO #412', name: null })
    expect((await t.s.usage()).recent[0]).toMatchObject({ id: t.failed.id, subject: 'METRO #412', status: 'failed', canRetry: true })
    renamePayee(t.world, { payee: 'METRO #412', name: 'Metro' })
    await retried(t, 'Metro', 'metro', () => t.s.call('POST', `/ledgers/personal/ai/usage/${t.failed.id}/retry`))
  })

  it('corrects the same record when the payee is named while AI is being asked again', async () => {
    const t = await failedOnce()
    let release!: () => void
    t.ai.hold = new Promise<void>((r) => (release = r))
    expect((await t.s.call('POST', `/ledgers/personal/ai/usage/${t.failed.id}/retry`)).body).toEqual({ started: 1, working: 0 })
    renamePayee(t.world, { payee: 'METRO #412', name: 'Metro' })
    release()
    await idle(t.s)
    expect(records(t.s.personal)).toEqual([expect.objectContaining({ id: t.failed.id, ok: 1, tries: 2, subject: 'Metro', subject_key: 'out:metro' })])
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual(['Groceries'])
  })

  it('keeps one record when two payees that both failed become one', async () => {
    const t = await failedOnce()
    addTx(t.s.personal, t.acc, '2026-09-02', -900, 'METRO #7')
    // Money in from the same payee is another thing asked, and stays one.
    addTx(t.s.personal, t.acc, '2026-09-03', 500, 'METRO #7')
    t.ai.down = true
    await categorize(t.s)
    await categorize(t.s)
    expect(records(t.s.personal).map((r: Json) => [r.subject_key, r.tries])).toEqual([
      ['out:metro 412', 3],
      ['in:metro 7', 2],
      ['out:metro 7', 2],
    ])
    const [first, moneyIn] = records(t.s.personal)

    nameWordings(t.world, { payees: ['METRO #412', 'METRO #7'], name: 'Metro' })
    expect(records(t.s.personal)).toEqual([
      expect.objectContaining({ id: first.id, ok: 0, subject: 'Metro', subject_key: 'out:metro', tries: 5, first_failed_at: first.first_failed_at }),
      expect.objectContaining({ id: moneyIn.id, ok: 0, subject: 'Metro', subject_key: 'in:metro', tries: 2 }),
    ])
    expect(await t.s.usage()).toMatchObject({ requests: 2, failed: 2, retryable: 2 })

    t.ai.down = false
    t.ai.asked.length = 0
    expect((await t.s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 2, working: 0 })
    await idle(t.s)
    expect(t.ai.asked).toHaveLength(2)
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual(['Groceries', 'Groceries', 'Groceries'])
    expect(records(t.s.personal).map((r: Json) => [r.id, r.ok, r.tries])).toEqual([
      [first.id, 1, 6],
      [moneyIn.id, 1, 3],
    ])
    expect(await t.s.usage()).toMatchObject({ requests: 2, failed: 0, retryable: 0 })
  })

  it('leaves the record where it is while some of the payee’s transactions wait under the old name', async () => {
    const t = await failedOnce()
    // Two wordings one rule called the same, failed as one payee: one of them leaves the rule.
    addTx(t.s.personal, t.acc, '2026-09-02', -900, 'METRO #7')
    nameWordings(t.world, { payees: ['METRO #412', 'METRO #7'], name: 'Metro' })
    expect(records(t.s.personal)).toEqual([expect.objectContaining({ id: t.failed.id, subject_key: 'out:metro' })])
    nameWordings(t.world, { payees: ['METRO #7'], name: null })
    expect(records(t.s.personal)).toEqual([expect.objectContaining({ id: t.failed.id, subject: 'Metro', subject_key: 'out:metro' })])
    expect((await t.s.usage()).recent[0]).toMatchObject({ status: 'failed', canRetry: true })
  })
})

describe('AI request records: failed payees that become one, whichever failed first', () => {
  /** A ledger whose AI is down, with what adds a transaction and asks about the uncategorized ones, or asks again about some. */
  function down() {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    useProviders(s.storage, 'claude')
    ai.down = true
    const acc = makeAccount(s.personal)
    const add = (payee: string, opts: Parameters<typeof addTx>[5] = {}, amount = -4_200) => addTx(s.personal, acc, '2026-09-01', amount, payee, opts)
    const askAgain = async (ids: number[]) => {
      expect((await s.call('POST', '/ledgers/personal/categorize/again', { ids })).status).toBe(202)
      await settle(() => !aiJobStatus(s.personal).running)
    }
    const open = () => records(s.personal).map((r: Json) => [r.id, r.ok, r.subject_key, r.subject, r.tries])
    const keys = () => s.personal.q.column('SELECT payee_key FROM transactions WHERE ledger_id = @ledger ORDER BY id')
    /** Every one retried and answered: the payees asked about, and the records after. */
    const retried = async () => {
      ai.down = false
      ai.asked.length = 0
      await s.call('POST', '/ai/usage/retry')
      await idle(s)
      return { asked: [...ai.asked].sort(), records: records(s.personal).map((r: Json) => [r.id, r.ok, r.tries]) }
    }
    return { ai, s, add, askAgain, open, keys, retried, world: worldOf(s.storage) }
  }
  /** What the bank sent for a transaction, worded otherwise now. */
  const reword = (ctx: AppContext, id: number, payee: string) => {
    const was = ctx.q.get<{ payee: string; payeeKey: string }>('SELECT payee, payee_key AS payeeKey FROM transactions WHERE ledger_id = @ledger AND id = ?', id)!
    followBankPayee(ctx, { id, ...was, origin: 'sync' }, payee)
  }

  it('keeps the older record when its payee joins one that failed later', async () => {
    const t = down()
    t.add('METRO #412')
    await categorize(t.s)
    t.add('METRO #7')
    renamePayee(t.world, { payee: 'METRO #7', name: 'Metro' })
    await categorize(t.s)
    expect(t.open()).toEqual([
      [1, 0, 'out:metro 412', 'METRO #412', 2],
      [2, 0, 'out:metro', 'Metro', 1],
    ])
    const first = records(t.s.personal)[0].first_failed_at

    expect(nameWordings(t.world, { payees: ['METRO #412', 'METRO #7'], name: 'Metro' }).changed).toBe(1)
    expect(t.keys()).toEqual(['metro', 'metro'])
    expect(t.open()).toEqual([[1, 0, 'out:metro', 'Metro', 3]])
    expect(records(t.s.personal)[0].first_failed_at).toBe(first)
    expect(await t.s.usage()).toMatchObject({ requests: 1, failed: 1, retryable: 1 })
    expect(await t.retried()).toEqual({ asked: ['METRO #7'], records: [[1, 1, 4]] })
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual(['Groceries', 'Groceries'])
  })

  it('keeps the older record when a payee that failed later joins it', async () => {
    const t = down()
    t.add('METRO #7')
    renamePayee(t.world, { payee: 'METRO #7', name: 'Metro' })
    await categorize(t.s)
    t.add('METRO #412')
    await categorize(t.s)
    expect(t.open()).toEqual([
      [1, 0, 'out:metro', 'Metro', 2],
      [2, 0, 'out:metro 412', 'METRO #412', 1],
    ])
    nameWordings(t.world, { payees: ['METRO #412', 'METRO #7'], name: 'Metro' })
    expect(t.open()).toEqual([[1, 0, 'out:metro', 'Metro', 3]])
    expect((await t.retried()).records).toEqual([[1, 1, 4]])
  })

  it('makes one record of three, the payee they join being neither the oldest nor the newest', async () => {
    const t = down()
    t.add('METRO #412')
    await categorize(t.s)
    t.add('METRO #7')
    renamePayee(t.world, { payee: 'METRO #7', name: 'Metro' })
    await categorize(t.s)
    t.add('METRO #9')
    // Money in from the newest is another thing asked: it moves alone.
    addTx(t.s.personal, makeAccount(t.s.personal, 'Savings'), '2026-09-02', 900, 'METRO #9')
    await categorize(t.s)
    expect(t.open()).toEqual([
      [1, 0, 'out:metro 412', 'METRO #412', 3],
      [2, 0, 'out:metro', 'Metro', 2],
      [3, 0, 'in:metro 9', 'METRO #9', 1],
      [4, 0, 'out:metro 9', 'METRO #9', 1],
    ])
    nameWordings(t.world, { payees: ['METRO #412', 'METRO #7', 'METRO #9'], name: 'Metro' })
    expect(t.open()).toEqual([
      [1, 0, 'out:metro', 'Metro', 6],
      [3, 0, 'in:metro', 'Metro', 1],
    ])
    expect(await t.s.usage()).toMatchObject({ requests: 2, failed: 2, retryable: 2 })
    expect((await t.retried()).records).toEqual([
      [1, 1, 7],
      [3, 1, 2],
    ])
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual(['Groceries', 'Groceries', 'Groceries', 'Groceries'])
  })

  /** AI tidying switched on with these names, which every payee takes at once. */
  async function tidied(t: ReturnType<typeof down>, names: Record<string, string>) {
    const tidier: PayeeTidier = async (payees) => ({ names: payees.map((payee) => ({ payee, name: names[payee] ?? payee })), model: 'fake-model' })
    setAiTidy(t.world, true, tidier)
    await settle(() => !tidyStatus(t.world).running)
  }

  it('moves two records that take each other’s payee', async () => {
    const t = down()
    t.add('ALPHA')
    await categorize(t.s)
    t.add('BETA')
    await categorize(t.s)
    expect(t.open()).toEqual([
      [1, 0, 'out:alpha', 'ALPHA', 2],
      [2, 0, 'out:beta', 'BETA', 1],
    ])
    await tidied(t, { ALPHA: 'Beta', BETA: 'Alpha' })
    expect(t.keys()).toEqual(['beta', 'alpha'])
    expect(t.open().filter((r) => r[2]?.startsWith('out:'))).toEqual([
      [1, 0, 'out:beta', 'Beta', 2],
      [2, 0, 'out:alpha', 'Alpha', 1],
    ])
    expect(await t.s.usage()).toMatchObject({ failed: 2, retryable: 2 })
    expect((await t.retried()).asked).toEqual(['ALPHA', 'BETA'])
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual(['Groceries', 'Groceries'])
  })

  it('moves a record to a payee whose own record moves on, and joins that one with the record it lands on', async () => {
    const t = down()
    t.add('GAMMA')
    await categorize(t.s)
    t.add('BETA')
    await categorize(t.s)
    t.add('ALPHA')
    await categorize(t.s)
    expect(t.open()).toEqual([
      [1, 0, 'out:gamma', 'GAMMA', 3],
      [2, 0, 'out:beta', 'BETA', 2],
      [3, 0, 'out:alpha', 'ALPHA', 1],
    ])
    await tidied(t, { ALPHA: 'Beta', BETA: 'Gamma' })
    expect(t.keys()).toEqual(['gamma', 'gamma', 'beta'])
    expect(t.open().filter((r) => r[2]?.startsWith('out:'))).toEqual([
      [1, 0, 'out:gamma', 'Gamma', 5],
      [3, 0, 'out:beta', 'Beta', 1],
    ])
    expect((await t.retried()).asked).toHaveLength(2)
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual(['Groceries', 'Groceries', 'Groceries'])
  })

  it('joins “Ask AI again” records with each other and the ordinary ones with each other, on the same payees', async () => {
    const t = down()
    const dineOut = categoryId(t.s.personal, 'Dine out')
    // One that had a category and one that waits, each asked again about: two things asked of one payee.
    await t.askAgain([t.add('BEAN #2', { categoryId: dineOut })])
    await t.askAgain([t.add('BEAN #2', {}, -900)])
    const has = t.add('BEAN BAR', { categoryId: dineOut })
    const waits = t.add('BEAN BAR', {}, -900)
    renamePayee(t.world, { payee: 'BEAN BAR', name: 'Bean' })
    await t.askAgain([has])
    await t.askAgain([waits])
    expect(t.open()).toEqual([
      [1, 0, 'again:out:bean 2', 'BEAN #2', 1],
      [2, 0, 'out:bean 2', 'BEAN #2', 1],
      [3, 0, 'again:out:bean', 'Bean', 1],
      [4, 0, 'out:bean', 'Bean', 1],
    ])
    nameWordings(t.world, { payees: ['BEAN #2', 'BEAN BAR'], name: 'Bean' })
    expect(t.open()).toEqual([
      [1, 0, 'again:out:bean', 'Bean', 2],
      [2, 0, 'out:bean', 'Bean', 2],
    ])
    // And apart again, each record stays with the payee most of its transactions are.
    nameWordings(t.world, { payees: ['BEAN #2', 'BEAN BAR'], name: null })
    expect(t.open().map((r) => r[0])).toEqual([1, 2])
  })

  it('keeps a bank sync going when a pending charge posts under a payee that failed too, older or newer', async () => {
    const t = down()
    const pending = t.add('METRO PENDING', { origin: 'sync' })
    await categorize(t.s)
    t.add('METRO POSTED', { origin: 'sync' })
    await categorize(t.s)
    expect(t.open()).toEqual([
      [1, 0, 'out:metro pending', 'METRO PENDING', 2],
      [2, 0, 'out:metro posted', 'METRO POSTED', 1],
    ])
    // The older record's payee becomes the newer one's.
    reword(t.s.personal, pending, 'METRO POSTED')
    expect(t.keys()).toEqual(['metro posted', 'metro posted'])
    expect(t.open()).toEqual([[1, 0, 'out:metro posted', 'METRO POSTED', 3]])

    // The newer record's payee becomes the older one's.
    const late = t.add('SHOP PENDING', { origin: 'sync' })
    await categorize(t.s)
    expect(t.open()).toEqual([
      [1, 0, 'out:metro posted', 'METRO POSTED', 4],
      [3, 0, 'out:shop pending', 'SHOP PENDING', 1],
    ])
    reword(t.s.personal, late, 'METRO POSTED')
    expect(t.open()).toEqual([[1, 0, 'out:metro posted', 'METRO POSTED', 5]])
    expect(await t.retried()).toEqual({ asked: ['METRO POSTED'], records: [[1, 1, 6]] })
    expect(categoriesOf(t.s.personal).map((r: Json) => r.category)).toEqual(['Groceries', 'Groceries', 'Groceries'])
  })

  it('keeps a bank sync going when a charge asked again about posts under a payee asked again about too', async () => {
    const t = down()
    const dineOut = categoryId(t.s.personal, 'Dine out')
    const pending = t.add('BEAN PENDING', { origin: 'sync', categoryId: dineOut })
    await t.askAgain([pending])
    await t.askAgain([t.add('BEAN POSTED', { origin: 'sync', categoryId: dineOut })])
    await t.askAgain([t.add('BEAN POSTED', { origin: 'sync' }, -900)])
    expect(t.open()).toEqual([
      [1, 0, 'again:out:bean pending', 'BEAN PENDING', 1],
      [2, 0, 'again:out:bean posted', 'BEAN POSTED', 1],
      [3, 0, 'out:bean posted', 'BEAN POSTED', 1],
    ])
    // The record asked again goes with it, and the one of those still waiting is left alone.
    reword(t.s.personal, pending, 'BEAN POSTED')
    expect(t.open()).toEqual([
      [1, 0, 'again:out:bean posted', 'BEAN POSTED', 2],
      [3, 0, 'out:bean posted', 'BEAN POSTED', 1],
    ])
  })
})

describe('AI request records: Ask AI again, and archived ledgers', () => {
  const ASKED_AGAIN = 'It was asked with “Ask AI again”, about transactions that had a category. Select them and ask again there.'

  it('keeps a failed “Ask AI again” about categorized transactions failed, to ask again there', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    useProviders(s.storage, 'claude')
    const acc = makeAccount(s.personal)
    // One AI categorized before: you never set its category yourself.
    const id = addTx(s.personal, acc, '2026-09-01', -500, 'BEAN BAR')
    s.personal.q.run("UPDATE transactions SET category_id = ?, category_source = 'ai' WHERE ledger_id = @ledger AND id = ?", categoryId(s.personal, 'Dine out'), id)
    const askAgain = async (ids: number[]) => {
      expect((await s.call('POST', '/ledgers/personal/categorize/again', { ids })).status).toBe(202)
      await settle(() => !aiJobStatus(s.personal).running)
    }
    ai.down = true
    await askAgain([id])
    const usage = await s.usage()
    expect(usage).toMatchObject({ requests: 1, failed: 1, retryable: 0 })
    const [failed] = usage.recent
    expect(failed).toMatchObject({ kind: 'categorize', subject: 'BEAN BAR', again: true, status: 'failed', canRetry: false, noRetry: ASKED_AGAIN, tries: 1 })
    const retry = await s.call('POST', `/ledgers/personal/ai/usage/${failed!.id}/retry`)
    expect([retry.status, retry.body.error.message]).toEqual([409, ASKED_AGAIN])
    expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 0, working: 0 })

    // The payee named since, the record goes with it.
    renamePayee(worldOf(s.storage), { payee: 'BEAN BAR', name: 'Bean Bar Café' })
    expect((await s.usage()).recent[0]).toMatchObject({ id: failed!.id, subject: 'Bean Bar Café', status: 'failed', noRetry: ASKED_AGAIN })

    // An uncategorized transaction of the payee is another thing asked: a record of its own, to retry.
    const waiting = addTx(s.personal, acc, '2026-09-02', -700, 'BEAN BAR')
    await askAgain([waiting])
    expect((await s.usage()).recent.map((r) => [r.subject, r.status, r.canRetry, r.noRetry])).toEqual([
      ['Bean Bar Café', 'failed', true, null],
      ['Bean Bar Café', 'failed', false, ASKED_AGAIN],
    ])
    expect(await s.usage()).toMatchObject({ requests: 2, failed: 2, retryable: 1 })

    // Asked again there and answered, the same record is corrected.
    ai.down = false
    await askAgain([id])
    expect(records(s.personal)[0]).toMatchObject({ id: failed!.id, ok: 1, tries: 2, outcome: 'Groceries', first_failed_at: failed!.firstFailedAt })
    expect(await s.usage()).toMatchObject({ requests: 2, failed: 1, retryable: 1 })
    expect(categoriesOf(s.personal).map((r: Json) => r.category)).toEqual(['Groceries', null])
  })

  const AGAIN_UNNEEDED =
    'This is no longer needed: the payee’s transactions that had a category are gone or were changed by hand since, or the payee always gets one category now.'
  /** Two BEAN BAR transactions AI categorized before, asked again about while AI is down. */
  async function askedAgainFailed() {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    useProviders(s.storage, 'claude')
    const acc = makeAccount(s.personal)
    const dineOut = categoryId(s.personal, 'Dine out')
    const ids = [-500, -700].map((amount) => {
      const id = addTx(s.personal, acc, '2026-09-01', amount, 'BEAN BAR')
      s.personal.q.run("UPDATE transactions SET category_id = ?, category_source = 'ai' WHERE ledger_id = @ledger AND id = ?", dineOut, id)
      return id
    })
    const askAgain = async (which: number[]) => {
      expect((await s.call('POST', '/ledgers/personal/categorize/again', { ids: which })).status).toBe(202)
      await settle(() => !aiJobStatus(s.personal).running)
    }
    ai.down = true
    await askAgain(ids)
    const usage = await s.usage()
    expect(usage).toMatchObject({ requests: 1, failed: 1, retryable: 0 })
    expect(usage.recent).toEqual([expect.objectContaining({ again: true, status: 'failed', noRetry: ASKED_AGAIN, tries: 2 })])
    // After the try, by the clock the records and the transactions are stamped with.
    await new Promise((r) => setTimeout(r, 5))
    /** The record reads as no longer needed, nothing written by reading it, and it can't be retried. */
    const unneeded = async () => {
      const changes = () => s.storage.sqlite.prepare('SELECT total_changes()').pluck().get()
      const kept = records(s.personal)
      const writes = changes()
      const read = ledgerAiUsage(s.personal, { write: true, everyLedger: true, world: worldOf(s.storage) })
      expect(changes()).toBe(writes)
      expect(records(s.personal)).toEqual(kept)
      expect(read).toMatchObject({ requests: 1, failed: 0, retryable: 0 })
      expect(read.recent).toEqual([expect.objectContaining({ id: usage.recent[0]!.id, again: true, ok: false, status: 'unneeded', canRetry: false, noRetry: null })])
      const retry = await s.call('POST', `/ledgers/personal/ai/usage/${usage.recent[0]!.id}/retry`)
      expect([retry.status, retry.body.error.message]).toEqual([409, AGAIN_UNNEEDED])
      expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 0, working: 0 })
    }
    return { ai, s, acc, ids, dineOut, askAgain, unneeded }
  }

  it('reads a failed “Ask AI again” as no longer needed once the transactions are deleted', async () => {
    const t = await askedAgainFailed()
    deleteTransaction(t.s.personal, t.ids[0]!)
    // One is left to ask about.
    expect(await t.s.usage()).toMatchObject({ failed: 1, retryable: 0 })
    deleteTransaction(t.s.personal, t.ids[1]!)
    await t.unneeded()
  })

  it('reads a failed “Ask AI again” as no longer needed once the transactions have no category, where the failure to retry is the payee’s own', async () => {
    const t = await askedAgainFailed()
    for (const id of t.ids) updateTransaction(t.s.personal, id, { categoryId: null })
    await t.unneeded()
  })

  it('reads a failed “Ask AI again” as no longer needed once the payee always gets one category', async () => {
    const t = await askedAgainFailed()
    setPayeeChoice(t.s.personal, { payee: 'BEAN BAR', mode: 'always', categoryId: t.dineOut })
    await t.unneeded()
    // Back to a suggestion each time, it's a failure again.
    setPayeeChoice(t.s.personal, { payee: 'BEAN BAR', mode: 'ask' })
    expect(await t.s.usage()).toMatchObject({ failed: 1, retryable: 0 })
  })

  it('reads a failed “Ask AI again” as no longer needed once a category is set by hand, until it fails again', async () => {
    const t = await askedAgainFailed()
    // A change that sets no category leaves it failed.
    t.s.personal.q.run("UPDATE transactions SET notes = 'x', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE ledger_id = @ledger AND id = ?", t.ids[1])
    expect(await t.s.usage()).toMatchObject({ failed: 1 })
    updateTransaction(t.s.personal, t.ids[0]!, { categoryId: categoryId(t.s.personal, 'Groceries') })
    await t.unneeded()
    // Asked again there and failing once more, it's a failure after that change.
    await new Promise((r) => setTimeout(r, 5))
    await t.askAgain(t.ids)
    expect((await t.s.usage()).recent).toEqual([expect.objectContaining({ status: 'failed', noRetry: ASKED_AGAIN, tries: 4 })])
  })

  it('records the waiting transactions of a group asked again apart from the categorized ones, to retry like any other', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    useProviders(s.storage, 'claude')
    const acc = makeAccount(s.personal)
    // The same payee, amount and notes: one AI categorized before, one waiting.
    const had = addTx(s.personal, acc, '2026-09-01', -500, 'BEAN BAR')
    s.personal.q.run("UPDATE transactions SET category_id = ?, category_source = 'ai' WHERE ledger_id = @ledger AND id = ?", categoryId(s.personal, 'Dine out'), had)
    const waits = addTx(s.personal, acc, '2026-09-02', -500, 'BEAN BAR')
    ai.down = true
    expect((await s.call('POST', '/ledgers/personal/categorize/again', { ids: [had, waits] })).status).toBe(202)
    await settle(() => !aiJobStatus(s.personal).running)
    expect(await s.usage()).toMatchObject({ requests: 2, failed: 2, retryable: 1 })
    const byKey = () => Object.fromEntries(records(s.personal).map((r: Json) => [r.subject_key, [r.ok, r.tries]]))
    expect(byKey()).toEqual({ 'again:out:bean bar': [0, 1], 'out:bean bar': [0, 1] })
    const open = (await s.usage()).recent.find((r) => !r.again)!
    expect(open).toMatchObject({ status: 'failed', canRetry: true, noRetry: null })

    // “Categorize uncategorized now” corrects the waiting one's record, and leaves the other transaction alone.
    ai.down = false
    await categorize(s)
    expect(byKey()).toEqual({ 'again:out:bean bar': [0, 1], 'out:bean bar': [1, 2] })
    expect(categoriesOf(s.personal).map((r: Json) => r.category)).toEqual(['Dine out', 'Groceries'])
    expect(await s.usage()).toMatchObject({ requests: 2, failed: 1, retryable: 0 })

    // The same with Retry, in a ledger where both failed again.
    const again = fakeLlm()
    const other = setup({ llm: again.llm })
    useProviders(other.storage, 'claude')
    const account = makeAccount(other.personal)
    const first = addTx(other.personal, account, '2026-09-01', -500, 'BEAN BAR')
    other.personal.q.run("UPDATE transactions SET category_id = ?, category_source = 'ai' WHERE ledger_id = @ledger AND id = ?", categoryId(other.personal, 'Dine out'), first)
    const second = addTx(other.personal, account, '2026-09-02', -500, 'BEAN BAR')
    again.down = true
    expect((await other.call('POST', '/ledgers/personal/categorize/again', { ids: [first, second] })).status).toBe(202)
    await settle(() => !aiJobStatus(other.personal).running)
    again.down = false
    const retry = (await other.usage()).recent.find((r) => r.canRetry)!
    expect((await other.call('POST', `/ledgers/personal/ai/usage/${retry.id}/retry`)).body).toEqual({ started: 1, working: 0 })
    await idle(other)
    expect(categoriesOf(other.personal).map((r: Json) => r.category)).toEqual(['Dine out', 'Groceries'])
    expect(await other.usage()).toMatchObject({ requests: 2, failed: 1, retryable: 0 })
  })

  it('leaves an archived ledger’s failures alone until it’s restored', async () => {
    const ai = fakeLlm()
    const s = setup({ llm: ai.llm })
    const family = testLedger(s.storage)
    addTx(family, makeAccount(family), '2026-09-01', -4_200, 'METRO #412')
    ai.down = true
    await categorize(s, family)
    ai.down = false
    ai.asked.length = 0
    s.storage.registry.update(family.ledger.id, { archived: true })

    const usage = await s.usage()
    expect(usage).toMatchObject({ requests: 1, failed: 1, retryable: 0 })
    const [failed] = usage.recent
    expect(failed).toMatchObject({ subject: 'METRO #412', ledger: 'Family', status: 'failed', canRetry: false, noRetry: 'This ledger is archived. Restore it first, then ask again.' })
    expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 0, working: 0 })
    const one = await s.call('POST', `/ledgers/family/ai/usage/${failed!.id}/retry`)
    expect([one.status, one.body.error.message]).toEqual([409, 'This ledger is archived. Restore it first, then ask again.'])
    expect(ai.asked).toEqual([])
    expect(records(family)).toEqual([expect.objectContaining({ ok: 0, tries: 1 })])

    s.storage.registry.update(family.ledger.id, { archived: false })
    expect(await s.usage()).toMatchObject({ failed: 1, retryable: 1 })
    expect((await s.call('POST', '/ai/usage/retry')).body).toEqual({ started: 1, working: 0 })
    await idle(s)
    expect(records(family)).toEqual([expect.objectContaining({ id: failed!.id, ok: 1, tries: 2 })])
  })
})
