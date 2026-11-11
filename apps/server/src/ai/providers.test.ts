import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { settingsUpdateSchema } from '@chipmunk/shared'
import { aiConfig, updateSettings, type StoredAiConfig } from '../services/settings'
import { testContext } from '../test/helpers'
import { categoryNamed, endpointFor, structuredOpenAI } from './providers'

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

  it('takes a URL of your own for a local server, for when it isn’t on this machine', () => {
    const ctx = testContext()
    updateSettings(ctx.meta, { ai: { primary: { kind: 'local', model: 'gemma4:26b', baseUrl: 'http://host.docker.internal:11434/v1' } } })
    const primary = aiConfig(ctx.meta, 'primary')!
    expect(endpointFor(primary)).toBe('http://host.docker.internal:11434/v1')
    updateSettings(ctx.meta, { ai: { primary: { kind: 'local', model: 'gemma4:26b', baseUrl: '' } } })
    expect(endpointFor(aiConfig(ctx.meta, 'primary')!)).toBe('http://localhost:11434/v1')
  })

  it('reads a category answered as the list writes it, group and all', () => {
    const names = ['Pharmacy', 'Fuel', 'Clothing & shoes']
    expect(categoryNamed(names, 'Pharmacy')).toBe('Pharmacy')
    expect(categoryNamed(names, 'Health › Pharmacy')).toBe('Pharmacy')
    expect(categoryNamed(names, 'Transportation › fuel ')).toBe('Fuel')
    expect(categoryNamed(names, 'clothing & SHOES')).toBe('Clothing & shoes')
    expect(categoryNamed([...names, 'Salary'], 'Income › Salary (income)')).toBe('Salary')
    expect(categoryNamed([...names, 'Card payment'], 'Card payment (not spending or income: money moving between your own accounts)')).toBe('Card payment')
    expect(categoryNamed([...names, 'Gifts (given)'], 'Gifts › Gifts (given)')).toBe('Gifts (given)')
    // Not in the list: left as it is, and refused later.
    expect(categoryNamed(names, 'Health › Dentist')).toBe('Health › Dentist')
  })

  it('needs a URL only for an OpenAI-compatible server', () => {
    const parse = (primary: object) => settingsUpdateSchema.safeParse({ ai: { primary } }).success
    expect(parse({ kind: 'openai-compatible', model: 'm' })).toBe(false)
    expect(parse({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://nas:1234/v1' })).toBe(true)
    expect(parse({ kind: 'gemini', model: 'gemini-2.5-flash' })).toBe(true)
    expect(parse({ kind: 'nope', model: 'm' })).toBe(false)
  })
})

describe('a server you run', () => {
  const servers: Server[] = []
  afterEach(() => servers.splice(0).forEach((x) => x.close()))

  /** A chat server that refuses what `refuse` says, answering with fenced JSON like Ollama. */
  async function fake(refuse: (body: Record<string, unknown>) => { status: number; message: string } | null) {
    const seen: Array<Record<string, unknown>> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        const body = JSON.parse(raw)
        seen.push(body)
        const no = refuse(body)
        res.writeHead(no ? no.status : 200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify(
            no
              ? { error: { message: no.message, type: 'api_error' } }
              : { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '```json\n{"name": "Walmart"}\n```' } }] },
          ),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const cfg: StoredAiConfig = { kind: 'local', model: 'gemma4:26b', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: null }
    return { seen, cfg }
  }
  const call = {
    system: 'Name the store.',
    user: 'WAL-MART SUPERCENTER#4217',
    name: 'store',
    schema: z.object({ name: z.string() }),
    jsonSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    shape: '{"name": string}',
    invalid: 'No name',
  }

  it('asks without a format when it can’t do structured output, and never to think', async () => {
    const { seen, cfg } = await fake((b) => (b.response_format ? { status: 501, message: 'structured output is unavailable' } : null))
    expect((await structuredOpenAI(cfg, call)).data).toEqual({ name: 'Walmart' })
    // (The SDK asks once more after a 5xx.)
    const formats = seen.map((b) => (b.response_format as { type: string } | undefined)?.type ?? 'none')
    expect(formats.filter((f, i) => f !== formats[i - 1])).toEqual(['json_schema', 'json_object', 'none'])
    expect(seen.every((b) => b.reasoning_effort === 'none')).toBe(true)
    // It remembers: the next question goes straight to what works.
    const before = seen.length
    expect((await structuredOpenAI(cfg, call)).data).toEqual({ name: 'Walmart' })
    expect(seen.slice(before).map((b) => b.response_format ?? 'none')).toEqual(['none'])
  })

  it('asks again without the thinking setting when the server refuses it', async () => {
    const { seen, cfg } = await fake((b) => (b.reasoning_effort ? { status: 400, message: 'reasoning_effort is not supported' } : null))
    expect((await structuredOpenAI(cfg, call)).data).toEqual({ name: 'Walmart' })
    expect(seen.map((b) => [(b.response_format as { type: string }).type, b.reasoning_effort ?? null])).toEqual([
      ['json_schema', 'none'],
      ['json_schema', null],
    ])
  })

  it('gives up on anything that isn’t about what it supports', async () => {
    const { seen, cfg } = await fake(() => ({ status: 404, message: 'model "nope" not found' }))
    await expect(structuredOpenAI(cfg, call)).rejects.toThrow()
    expect(seen).toHaveLength(1)
  })
})
