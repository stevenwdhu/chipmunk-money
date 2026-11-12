import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testContext } from '../test/helpers'
import { updateSettings } from '../services/settings'
import type { AiAttempt } from './records'

const calls: string[] = []
vi.mock('./providers', () => ({
  callProvider: vi.fn(async (cfg: { model: string }) => {
    calls.push(cfg.model)
    if (cfg.model === 'broken') throw new Error('boom')
    return { category: 'Coffee', confidence: 0.8, inputTokens: 10, outputTokens: 5 }
  }),
}))

const { configuredCategorizer } = await import('./runner')

const req = { payee: 'x', amountMinor: -1, date: null, accountType: null, notes: null, categories: [{ name: 'Coffee', group: null, isIncome: false }], examples: [] }

describe('AI runner', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('falls back when the primary provider fails and notes both calls in the request’s log', async () => {
    const ctx = testContext()
    updateSettings(ctx.meta, {
      ai: {
        primary: { kind: 'anthropic', model: 'broken' },
        fallback: { kind: 'openai-compatible', model: 'llama', baseUrl: 'http://localhost:11434/v1' },
      },
    })
    const log: AiAttempt[] = []
    const res = await configuredCategorizer(ctx, log)(req)
    expect(res).toMatchObject({ category: 'Coffee', slot: 'fallback', model: 'llama' })
    expect(calls).toEqual(['broken', 'llama'])
    expect(log).toEqual([
      { slot: 'primary', model: 'broken', ok: false, error: 'boom' },
      { slot: 'fallback', model: 'llama', ok: true, inputTokens: 10, outputTokens: 5 },
    ])
    // The record is the caller's to write: the runner writes none.
    expect(ctx.q.all('SELECT id FROM ai_calls WHERE ledger_id = @ledger')).toEqual([])
  })

  it('throws why the last one failed when no provider answers', async () => {
    const ctx = testContext()
    updateSettings(ctx.meta, { ai: { primary: { kind: 'anthropic', model: 'broken' } } })
    const log: AiAttempt[] = []
    await expect(configuredCategorizer(ctx, log)(req)).rejects.toThrow('boom')
    expect(log).toEqual([{ slot: 'primary', model: 'broken', ok: false, error: 'boom' }])
  })

  it('returns null when nothing is configured', async () => {
    const ctx = testContext()
    expect(await configuredCategorizer(ctx)(req)).toBeNull()
    expect(calls).toEqual([])
  })
})
