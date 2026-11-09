import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import type { ChatgptModel, ChatgptStatus } from '@st/shared'
import { badRequest } from '../lib/http'
import type { MetaStore } from './context'
import { getAppSetting, setAppSetting } from './settings'

/**
 * Sign in with ChatGPT: AI categorizing on your ChatGPT plan instead of an API key, through OpenAI's
 * token sharing for open-source apps (developers.openai.com/siwc/token-sharing-open-source).
 *
 * The first sign-in registers this app with your ChatGPT account (client_id `dynamic_agent_client`),
 * which issues it a client ID of its own, kept and reused. This server has a host ID of its own too
 * (`ext_agent_host_id`, a random UUID made once). OpenAI sends the browser back to
 * http://127.0.0.1:<this server's port>/auth/callback, which reaches this server when the browser
 * runs on the same machine; otherwise you paste the address it lands on. Tokens are kept encrypted
 * in meta.db, refreshed an hour at a time, and used for Responses API requests at api.openai.com.
 */

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
export const CHATGPT_API = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
/** The scope that lets requests use the ChatGPT plan. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const APP_NAME = 'Spending Tracker'
export const USAGE_URL = 'https://chatgpt.com/settings/usage'
/** A sign-in that isn't finished in this long is dropped. */
const PENDING_MS = 15 * 60_000
/** Refresh the access token (an hour long) this long before it runs out. */
const REFRESH_EARLY_MS = 2 * 60_000

/** What's kept (encrypted) in the `chatgpt.session` app setting. */
interface Session {
  /** This server, for OpenAI: made once, kept even after signing out. */
  hostId: string
  /** The client ID OpenAI issued at the first sign-in, kept even after signing out. */
  clientId: string | null
  /** The last sign-in's ID token, to skip choosing the account next time (it may be expired). */
  idToken: string | null
  email: string | null
  accessToken: string | null
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
}

interface Pending {
  verifier: string
  nonce: string
  redirectUri: string
  /** The issued client ID it signs in again with, or null for a first registration. */
  clientId: string | null
  until: number
}
const pending = new Map<string, Pending>()
let refreshing: Promise<Session> | null = null

/** How long a request to OpenAI's sign-in and model list may take. */
const TIMEOUT_MS = 30_000

/** fetch, given up on after TIMEOUT_MS with an error that says so. */
const fetchOf =
  (meta: MetaStore): typeof fetch =>
  async (input, init) => {
    try {
      const send = meta.fetch ?? ((url, options) => globalThis.fetch(url, options))
      return await send(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new Error(`OpenAI didn’t answer within ${TIMEOUT_MS / 1000} seconds. Try again later.`)
      throw err
    }
  }
const random = () => randomBytes(32).toString('base64url')

function load(meta: MetaStore): Session | null {
  const sealed = getAppSetting<string | null>(meta, 'chatgpt.session', null)
  if (!sealed) return null
  try {
    return JSON.parse(meta.secrets.open(sealed)) as Session
  } catch {
    // meta.db copied without its secret.key: sign in again.
    return null
  }
}
function save(meta: MetaStore, session: Session) {
  setAppSetting(meta, 'chatgpt.session', meta.secrets.seal(JSON.stringify(session)))
}
/** Signed out: the tokens go, the registration (client and host IDs, the last ID token) stays. */
function forgetTokens(meta: MetaStore, session: Session) {
  save(meta, { ...session, accessToken: null, refreshToken: null, expiresAt: null, scopes: [] })
}

export function chatgptStatus(meta: MetaStore): ChatgptStatus {
  const s = load(meta)
  const signedIn = !!s?.refreshToken
  return { signedIn, email: signedIn ? s!.email : null, planUsage: signedIn && s!.scopes.includes(PLAN_SCOPE), registered: !!s?.clientId, usageUrl: USAGE_URL }
}

/** Where to send the browser to sign in. `port`: this server's, for the loopback callback. */
export function startChatgptSignIn(meta: MetaStore, port: number): { url: string } {
  const now = Date.now()
  for (const [state, p] of pending) if (p.until < now) pending.delete(state)
  let session = load(meta)
  if (!session) {
    session = { hostId: `urn:uuid:${randomUUID()}`, clientId: null, idToken: null, email: null, accessToken: null, refreshToken: null, expiresAt: null, scopes: [] }
    save(meta, session)
  }
  const state = random()
  const nonce = random()
  const verifier = random()
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  const params = new URLSearchParams({
    client_id: session.clientId ?? 'dynamic_agent_client',
    ...(session.clientId ? {} : { agent_name_hint: APP_NAME }),
    ext_agent_host_id: session.hostId,
    ...(session.clientId && session.idToken ? { id_token_hint: session.idToken } : {}),
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: CHATGPT_API,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  })
  pending.set(state, { verifier, nonce, redirectUri, clientId: session.clientId, until: now + PENDING_MS })
  return { url: `${AUTHORIZE_URL}?${params}` }
}

/** The callback's query (from the loopback redirect, or the address you pasted). */
export async function finishChatgptSignIn(meta: MetaStore, query: { code?: string; state?: string; client_id?: string; error?: string }): Promise<ChatgptStatus> {
  const p = query.state ? pending.get(query.state) : undefined
  if (!p || p.until < Date.now()) badRequest('This sign-in expired or was already used. Start it again.')
  pending.delete(query.state!)
  if (query.error) badRequest(query.error === 'access_denied' ? 'Signing in to ChatGPT was cancelled.' : `ChatGPT said: ${query.error}`)
  if (!query.code) badRequest('That address has no sign-in code. Paste the whole address of the page it ended on.')
  // A first sign-in gets its client ID here; signing in again keeps the one it has.
  const clientId = p.clientId ?? query.client_id
  if (!clientId) badRequest('OpenAI didn’t finish registering this app. Sign in again.')
  if (p.clientId && query.client_id && query.client_id !== p.clientId) badRequest('That sign-in came back for another app. Sign in again.')

  const tokens = await tokenRequest(meta, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: query.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
    resource: CHATGPT_API,
  })
  if (!tokens.id_token || !tokens.refresh_token) badRequest('ChatGPT didn’t send what signing in needs. Sign in again.')
  const claims = await verifyIdToken(meta, tokens.id_token, clientId, p.nonce)
  const session = load(meta)!
  save(meta, {
    ...session,
    clientId,
    idToken: tokens.id_token,
    email: typeof claims.email === 'string' ? claims.email : null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
  })
  return chatgptStatus(meta)
}

/** Signs out: tells OpenAI to drop the session, and forgets the tokens. Returns a note when OpenAI couldn't be told. */
export async function signOutChatgpt(meta: MetaStore): Promise<{ note: string | null }> {
  const s = load(meta)
  if (!s?.refreshToken) return { note: null }
  let note: string | null = null
  try {
    const res = await fetchOf(meta)(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.clientId ?? '' }),
    })
    if (!res.ok) note = 'OpenAI couldn’t confirm the sign-out. You can disconnect this app in ChatGPT’s settings.'
  } catch {
    note = 'OpenAI couldn’t be reached to confirm the sign-out. You can disconnect this app in ChatGPT’s settings.'
  }
  forgetTokens(meta, s)
  return { note }
}

/** An access token that's good for a while yet, refreshed first when it's about to run out (one refresh at a time). */
export async function chatgptAccessToken(meta: MetaStore): Promise<string> {
  let s = load(meta)
  if (!s?.refreshToken) throw new Error('Sign in to ChatGPT in App settings → AI first.')
  if (!s.scopes.includes(PLAN_SCOPE)) {
    throw new Error('ChatGPT plan usage isn’t enabled for this sign-in. Sign in again to enable it, or use another provider with your own API key.')
  }
  if (!s.accessToken || (s.expiresAt ?? 0) - Date.now() < REFRESH_EARLY_MS) {
    refreshing ??= refresh(meta, s).finally(() => (refreshing = null))
    s = await refreshing
  }
  return s.accessToken!
}

async function refresh(meta: MetaStore, s: Session): Promise<Session> {
  let tokens
  try {
    tokens = await tokenRequest(meta, { grant_type: 'refresh_token', client_id: s.clientId ?? '', refresh_token: s.refreshToken!, resource: CHATGPT_API })
  } catch (err) {
    // The session is over (signed out elsewhere, disconnected, or 30 days unused): sign in again.
    if (err instanceof TokenError && err.terminal) {
      forgetTokens(meta, s)
      throw new Error('Your ChatGPT connection is no longer valid. Sign in again in App settings → AI.')
    }
    throw err
  }
  const next: Session = {
    ...s,
    accessToken: tokens.access_token,
    // It rotates: the new one replaces the old.
    refreshToken: tokens.refresh_token ?? s.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scopes: tokens.scope ? tokens.scope.split(' ').filter(Boolean) : s.scopes,
  }
  save(meta, next)
  return next
}

class TokenError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message)
  }
}
/** Refresh errors that mean signing in again. */
const TERMINAL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])

async function tokenRequest(meta: MetaStore, form: Record<string, string>) {
  const res = await fetchOf(meta)(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
    expires_in?: number
    scope?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token) {
    const code = body.error ?? `HTTP ${res.status}`
    throw new TokenError(`ChatGPT sign-in failed: ${body.error_description ?? code}`, TERMINAL.has(body.error ?? ''))
  }
  return body as typeof body & { access_token: string }
}

/** One of OpenAI's published signing keys (an RSA key as JWK). */
interface Jwk {
  kid?: string
  kty: string
  n?: string
  e?: string
}
let jwks: { keys: Jwk[]; at: number } | null = null

/** Checks the ID token: signed by OpenAI (its published keys), for this client, not expired, and from this sign-in (nonce). */
async function verifyIdToken(meta: MetaStore, token: string, clientId: string, nonce: string): Promise<Record<string, unknown>> {
  const [head, payload, signature] = token.split('.')
  if (!head || !payload || !signature) badRequest('ChatGPT sent an ID token that isn’t one.')
  const header = JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string; kid?: string }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
  if (header.alg !== 'RS256') badRequest('ChatGPT’s ID token is signed in a way this app doesn’t check.')
  const signed = async (fresh: boolean) => {
    if (fresh || !jwks || Date.now() - jwks.at > 60 * 60_000) {
      const res = await fetchOf(meta)(JWKS_URL)
      jwks = { keys: ((await res.json()) as { keys: Jwk[] }).keys, at: Date.now() }
    }
    const jwk = jwks.keys.find((k) => k.kid === header.kid)
    return !!jwk && verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), createPublicKey({ key: { ...jwk }, format: 'jwk' }), Buffer.from(signature, 'base64url'))
  }
  // With the keys kept from before, and if that fails, with OpenAI's current ones (it may have changed them).
  const valid = (await signed(false)) || (await signed(true))
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!valid || claims.iss !== ISSUER || !audience.includes(clientId) || typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() || claims.nonce !== nonce) {
    badRequest('ChatGPT’s ID token didn’t check out. Sign in again.')
  }
  return claims
}

/** The models the signed-in account can use, as OpenAI lists them for it. */
export async function chatgptModels(meta: MetaStore): Promise<ChatgptModel[]> {
  const token = await chatgptAccessToken(meta)
  const res = await fetchOf(meta)(`${CHATGPT_API}/models`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`ChatGPT’s model list didn’t load (HTTP ${res.status}).`)
  const body = (await res.json()) as {
    models?: Array<{ slug: string; display_name?: string; visibility?: string }>
    data?: Array<{ id: string }>
  }
  if (body.models) return body.models.filter((m) => m.visibility === 'list').map((m) => ({ slug: m.slug, displayName: m.display_name ?? m.slug }))
  return (body.data ?? []).map((m) => ({ slug: m.id, displayName: m.id }))
}
