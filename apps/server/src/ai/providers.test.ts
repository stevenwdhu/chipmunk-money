import { describe, expect, it } from 'vitest'
import { settingsUpdateSchema } from '@st/shared'
import { aiConfig, updateSettings } from '../services/settings'
import { testContext } from '../test/helpers'
import { endpointFor } from './providers'

describe('AI providers', () => {
  it('uses fixed URLs for named providers and yours for an OpenAI-compatible server', () => {
    const ctx = testContext()
    updateSettings(ctx.meta, {
      ai: {
        primary: { kind: 'openrouter', model: 'openai/gpt-5-mini', baseUrl: 'https://elsewhere.example/v1', apiKey: 'sk-or-1' },
        fallback: { kind: 'local', model: 'llama3.2', apiKey: 'unused' },
      },
    })
    const primary = aiConfig(ctx.meta, 'primary')!
    expect(primary).toMatchObject({ baseUrl: null, apiKey: 'sk-or-1' })
    expect(endpointFor(primary)).toBe('https://openrouter.ai/api/v1')
    // A local model needs no key.
    const fallback = aiConfig(ctx.meta, 'fallback')!
    expect([fallback.apiKey, endpointFor(fallback)]).toEqual([null, 'http://localhost:11434/v1'])

    expect(endpointFor({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://nas:1234/v1', apiKey: null })).toBe('http://nas:1234/v1')
    // Saved before a URL was required: OpenAI, as it was then.
    expect(endpointFor({ kind: 'openai-compatible', model: 'm', baseUrl: null, apiKey: null })).toBe('https://api.openai.com/v1')
  })

  it('needs a URL only for an OpenAI-compatible server', () => {
    const parse = (primary: object) => settingsUpdateSchema.safeParse({ ai: { primary } }).success
    expect(parse({ kind: 'openai-compatible', model: 'm' })).toBe(false)
    expect(parse({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://nas:1234/v1' })).toBe(true)
    expect(parse({ kind: 'gemini', model: 'gemini-2.5-flash' })).toBe(true)
    expect(parse({ kind: 'nope', model: 'm' })).toBe(false)
  })
})
