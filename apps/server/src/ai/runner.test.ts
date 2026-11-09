import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testContext } from '../test/helpers'
import { updateSettings } from '../services/settings'

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

  it('falls back when the primary provider fails and logs both calls', async () => {
    const ctx = testContext()
    updateSettings(ctx.meta, {
      ai: {
        primary: { kind: 'anthropic', model: 'broken' },
        fallback: { kind: 'openai-compatible', model: 'llama', baseUrl: 'http://localhost:11434/v1' },
      },
    })
    const res = await configuredCategorizer(ctx)(req)
    expect(res).toMatchObject({ category: 'Coffee', slot: 'fallback', model: 'llama' })
    expect(calls).toEqual(['broken', 'llama'])
    const logged = ctx.sqlite.prepare('SELECT slot, ok FROM ai_calls ORDER BY id').all()
    expect(logged).toEqual([
      { slot: 'primary', ok: 0 },
      { slot: 'fallback', ok: 1 },
    ])
  })

  it('returns null when nothing is configured', async () => {
    const ctx = testContext()
    expect(await configuredCategorizer(ctx)(req)).toBeNull()
    expect(calls).toEqual([])
  })
})
