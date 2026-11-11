import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ChatgptStatus } from '@chipmunk/shared'
import { createApp } from '../app'
import { testStorage } from '../test/helpers'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

// A fake OpenAI: its sign-in (auth.openai.com) and its API (api.openai.com) ----------------------

function fakeOpenAI() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  const state = {
    /** What the authorize step got, as the browser would have sent it. */
    authorize: null as URLSearchParams | null,
    tokenRequests: [] as URLSearchParams[],
    revoked: [] as string[],
    responses: [] as Array<{ auth: string | null; body: Json }>,
    issued: 0,
    /** Seconds the next access token lasts. */
    expiresIn: 3600,
    refreshError: null as string | null,
    responseError: null as { status: number; code: string } | null,
  }
  const idToken = (aud: string, nonce: string) => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const data = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ iss: 'https://auth.openai.com', aud, sub: 'user-1', email: 'me@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })}`
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`
  }
  const tokens = () => {
    state.issued++
    return {
      access_token: `access-${state.issued}`,
      refresh_token: `refresh-${state.issued}`,
      token_type: 'Bearer',
      expires_in: state.expiresIn,
      scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
    }
  }
  const sse = (events: Json[]) =>
    new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    const headers = new Headers(init?.headers)
    if (url.href === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] })
    if (url.href === 'https://auth.openai.com/api/accounts/oauth/token') {
      const form = new URLSearchParams(String(init?.body))
      state.tokenRequests.push(form)
      const a = state.authorize!
      if (form.get('grant_type') === 'authorization_code') {
        const verifierOk = createHash('sha256').update(form.get('code_verifier')!).digest('base64url') === a.get('code_challenge')
        if (!verifierOk || form.get('client_id') !== 'oaiapp_test' || form.get('redirect_uri') !== a.get('redirect_uri') || form.get('resource') !== 'https://api.openai.com/v1') {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        return Response.json({ ...tokens(), id_token: idToken('oaiapp_test', a.get('nonce')!) })
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (state.refreshError) return Response.json({ error: state.refreshError }, { status: 400 })
        if (form.get('refresh_token') !== `refresh-${state.issued}` || form.get('client_id') !== 'oaiapp_test') return Response.json({ error: 'invalid_grant' }, { status: 400 })
        return Response.json(tokens())
      }
    }
    if (url.href === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      state.revoked.push(new URLSearchParams(String(init?.body)).get('token')!)
      return new Response(null, { status: 200 })
    }
    if (url.href === 'https://api.openai.com/v1/models') {
      if (headers.get('authorization') !== `Bearer access-${state.issued}`) return Response.json({ error: { message: 'no' } }, { status: 401 })
      return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }, { slug: 'internal', visibility: 'hide' }] })
    }
    if (url.href === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(String(init?.body))
      state.responses.push({ auth: headers.get('authorization'), body })
      if (state.responseError) return Response.json({ error: { code: state.responseError.code, message: 'Limit' } }, { status: state.responseError.status })
      const answer = JSON.stringify({ category: 'Drinks & treats', confidence: 0.92, agreesWithBank: false })
      return sse([
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_text.delta', delta: answer.slice(0, 20) },
        { type: 'response.output_text.delta', delta: answer.slice(20) },
        { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 321, output_tokens: 12 } } },
      ])
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { state, fetch: fakeFetch }
}

async function setup() {
  const openai = fakeOpenAI()
  const storage = testStorage({ fetch: openai.fetch })
  const app = createApp(storage, { trustedHeader: null })
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url.startsWith('/auth') ? url : `/api/v1${url}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as Json }
  }
  /** Starts signing in, as the settings page does, and keeps what the browser would be sent to. */
  const start = async () => {
    const { url } = (await api('POST', '/settings/ai/chatgpt/sign-in')).body as { url: string }
    openai.state.authorize = new URL(url).searchParams
    return new URL(url)
  }
  return { openai, storage, api, start }
}

describe('signing in with ChatGPT', () => {
  it('registers this app with the account, then categorizes on the ChatGPT plan', async () => {
    const { openai, storage, api, start } = await setup()
    expect((await api('GET', '/settings/ai/chatgpt')).body).toMatchObject({ signedIn: false, registered: false, planUsage: false })

    // The first sign-in registers the app, from this server's host ID, coming back to this server.
    const url = await start()
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    const p = url.searchParams
    expect(Object.fromEntries(p)).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Chipmunk',
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:8787/auth/callback',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
    })
    expect(p.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)

    // The browser comes back with the code and the client ID OpenAI issued.
    const page = await api('GET', `/auth/callback?code=code-1&state=${p.get('state')}&client_id=oaiapp_test`)
    expect(page.body).toContain('Signed in with ChatGPT')
    expect((await api('GET', '/settings/ai/chatgpt')).body).toEqual({
      signedIn: true,
      email: 'me@example.com',
      planUsage: true,
      registered: true,
      usageUrl: 'https://chatgpt.com/settings/usage',
    } satisfies ChatgptStatus)
    // A sign-in is used once.
    expect((await api('GET', `/auth/callback?code=code-1&state=${p.get('state')}&client_id=oaiapp_test`)).body).toContain('expired or was already used')
    // Kept encrypted.
    const stored = storage.meta.sqlite.prepare("SELECT value FROM settings WHERE key = 'chatgpt.session'").pluck().get() as string
    expect(stored).not.toMatch(/access-1|refresh-1|me@example/)

    // The models the plan offers, and categorizing with one of them.
    expect((await api('GET', '/settings/ai/chatgpt/models')).body).toEqual([{ slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }])
    expect((await api('PATCH', '/settings', { ai: { primary: { kind: 'chatgpt', model: 'gpt-6.1-sol', baseUrl: null } } })).status).toBe(200)
    const test = (await api('POST', '/settings/ai/test', { slot: 'primary' })).body
    expect(test).toMatchObject({ ok: true, category: 'Drinks & treats', model: 'gpt-6.1-sol' })
    const sent = openai.state.responses.at(-1)!
    expect(sent.auth).toBe('Bearer access-1')
    expect(sent.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, input: [{ role: 'user' }] })
    expect(sent.body.instructions).toContain('categorize')
  })

  it('refreshes the token before it runs out, and asks to sign in again when the session is over', async () => {
    const { openai, api, start } = await setup()
    const p = (await start()).searchParams
    // Access tokens that are about to run out, so each request refreshes first.
    openai.state.expiresIn = 60
    await api('GET', `/auth/callback?code=code-1&state=${p.get('state')}&client_id=oaiapp_test`)
    await api('PATCH', '/settings', { ai: { primary: { kind: 'chatgpt', model: 'gpt-6.1-sol', baseUrl: null } } })
    expect((await api('POST', '/settings/ai/test', { slot: 'primary' })).body).toMatchObject({ ok: true })
    // Refreshed first (with the issued client ID and the plan's resource), then used.
    const refresh = openai.state.tokenRequests.at(-1)!
    expect(Object.fromEntries(refresh)).toMatchObject({ grant_type: 'refresh_token', client_id: 'oaiapp_test', refresh_token: 'refresh-1', resource: 'https://api.openai.com/v1' })
    expect(openai.state.responses.at(-1)!.auth).toBe('Bearer access-2')

    // A usage limit says so plainly.
    openai.state.responseError = { status: 429, code: 'subscription_sharing_usage_limit_exceeded' }
    expect((await api('POST', '/settings/ai/test', { slot: 'primary' })).body.error).toMatch(/usage limit for ChatGPT plan requests/)
    openai.state.responseError = null

    // The session is over (disconnected in ChatGPT, say): sign in again.
    openai.state.refreshError = 'invalid_grant'
    expect((await api('POST', '/settings/ai/test', { slot: 'primary' })).body.error).toMatch(/no longer valid/)
    expect((await api('GET', '/settings/ai/chatgpt')).body).toMatchObject({ signedIn: false, registered: true })
  })

  it('signs out, and signs in again as the same app, finishing with the address you paste', async () => {
    const { openai, api, start } = await setup()
    const first = (await start()).searchParams
    await api('GET', `/auth/callback?code=code-1&state=${first.get('state')}&client_id=oaiapp_test`)
    const hostId = first.get('ext_agent_host_id')

    expect((await api('DELETE', '/settings/ai/chatgpt')).body).toEqual({ note: null })
    expect(openai.state.revoked).toEqual(['refresh-1'])
    expect((await api('GET', '/settings/ai/chatgpt')).body).toMatchObject({ signedIn: false, registered: true })

    // Signing in again: the same app and host, skipping the account choice, and no new registration.
    const again = (await start()).searchParams
    expect(again.get('client_id')).toBe('oaiapp_test')
    expect(again.get('ext_agent_host_id')).toBe(hostId)
    expect(again.get('agent_name_hint')).toBeNull()
    expect(again.get('id_token_hint')).toMatch(/^ey/)
    // The browser couldn't reach this server: the address it ended on, pasted.
    const pasted = `http://127.0.0.1:8787/auth/callback?code=code-2&state=${again.get('state')}&scope=openid`
    expect((await api('POST', '/settings/ai/chatgpt/finish', { url: pasted })).body).toMatchObject({ signedIn: true, email: 'me@example.com' })
    expect((await api('POST', '/settings/ai/chatgpt/finish', { url: 'not an address' })).status).toBe(400)
  })
})
