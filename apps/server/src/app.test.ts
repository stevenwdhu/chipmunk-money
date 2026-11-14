import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { testStorage } from './test/helpers'

describe('api', () => {
  const storage = testStorage()
  const app = createApp(storage)
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  it('validates input with readable messages', async () => {
    const res = await app.request(
      '/api/v1/ledgers/personal/transactions',
      json('POST', { accountId: 1, date: '2026-02-30', amountMinor: 1, payee: 'x' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toEqual({
      error: {
        code: 'validation_failed',
        message: 'date: Use a valid date (YYYY-MM-DD)',
        issues: [{ path: 'date', message: 'Use a valid date (YYYY-MM-DD)' }],
      },
    })
  })

  it('stores time zone and AI settings without leaking the API key', async () => {
    let res = await app.request(
      '/api/v1/settings',
      json('PATCH', {
        timezone: 'America/Vancouver',
        ai: { primary: { kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-secret-1234' } },
      }),
    )
    const s = (await res.json()) as any
    expect(s.effectiveTimezone).toBe('America/Vancouver')
    expect(s.ai.primary).toMatchObject({ hasApiKey: true, apiKeyHint: '••••1234' })
    expect(JSON.stringify(s)).not.toContain('sk-ant-secret')

    // Omitting apiKey keeps the stored key; null clears the slot.
    res = await app.request('/api/v1/settings', json('PATCH', { ai: { primary: { kind: 'anthropic', model: 'claude-haiku-4-5' } } }))
    expect(((await res.json()) as any).ai.primary).toMatchObject({ model: 'claude-haiku-4-5', hasApiKey: true })
    res = await app.request('/api/v1/settings', json('PATCH', { timezone: null, ai: { primary: null } }))
    const cleared = (await res.json()) as any
    expect(cleared.ai.enabled).toBe(false)
    expect(cleared.timezone).toBeNull()

    res = await app.request('/api/v1/settings', json('PATCH', { timezone: 'Mars/Olympus' }))
    expect(res.status).toBe(400)
  })

  it('makes the fallback AI provider the primary one, each keeping its own key', async () => {
    const { aiConfig } = await import('./services/settings')
    const meta = storage.registry.defaultContext().meta
    const swap = () => app.request('/api/v1/settings/ai/swap', json('POST'))
    let res = await swap()
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.message).toBe('There’s no fallback provider to make primary.')

    await app.request(
      '/api/v1/settings',
      json('PATCH', {
        ai: {
          primary: { kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-secret-1234' },
          fallback: { kind: 'local', model: 'gemma4:26b', baseUrl: 'http://mm:11434/v1' },
        },
      }),
    )
    res = await swap()
    expect(res.status).toBe(200)
    const s = (await res.json()) as any
    expect(s.ai.primary).toMatchObject({ kind: 'local', model: 'gemma4:26b', baseUrl: 'http://mm:11434/v1', hasApiKey: false })
    expect(s.ai.fallback).toMatchObject({ kind: 'anthropic', model: 'claude-opus-5-5', hasApiKey: true, apiKeyHint: '••••1234' })
    expect(JSON.stringify(s)).not.toContain('sk-ant-secret')
    // The key went with its provider and still opens.
    expect(aiConfig(meta, 'fallback')?.apiKey).toBe('sk-ant-secret-1234')
    expect(aiConfig(meta, 'primary')?.apiKey).toBeNull()

    // And back.
    res = await swap()
    expect(((await res.json()) as any).ai.primary).toMatchObject({ kind: 'anthropic', hasApiKey: true })
    expect(aiConfig(meta, 'primary')?.apiKey).toBe('sk-ant-secret-1234')

    // With no primary, the fallback becomes the primary and there's no fallback after.
    await app.request('/api/v1/settings', json('PATCH', { ai: { primary: null } }))
    res = await swap()
    const alone = (await res.json()) as any
    expect(alone.ai.primary).toMatchObject({ kind: 'local' })
    expect(alone.ai.fallback).toBeNull()

    // Set by the server's environment, it can't change places.
    process.env.AI_FALLBACK_KIND = 'local'
    process.env.AI_FALLBACK_MODEL = 'llama3.2'
    try {
      res = await swap()
      expect(res.status).toBe(409)
      expect(((await res.json()) as any).error.message).toMatch(/environment variables/)
    } finally {
      delete process.env.AI_FALLBACK_KIND
      delete process.env.AI_FALLBACK_MODEL
    }
    await app.request('/api/v1/settings', json('PATCH', { ai: { primary: null, fallback: null } }))
  })

  it('returns 404s as JSON', async () => {
    let res = await app.request('/api/v1/ledgers/personal/transactions/999', json('GET'))
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toEqual({ error: { code: 'not_found', message: 'Transaction not found' } })
    res = await app.request('/api/v1/nothing-here', json('GET'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('not_found')
  })
})
