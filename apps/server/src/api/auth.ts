import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { desc, eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ApiKey, ApiKeyCreate, ApiKeyCreated, ApiScope } from '@chipmunk/shared'
import { apiKeys } from '../db/meta-schema'
import { ulid } from '../lib/ids'
import type { MetaStore } from '../services/context'
import type { LedgerRegistry } from '../storage'

type ApiKeyRow = typeof apiKeys.$inferSelect

/** Who is making a request: the web app (trusted) or a script or agent with an API key. */
export type Actor = { kind: 'web' } | { kind: 'key'; key: ApiKeyRow }

/** How an actor appears in the activity log. */
export function actorName(actor: Actor): string {
  return actor.kind === 'web' ? 'web' : actor.key.name
}

/** A stable id per caller, for idempotency keys. */
export function actorId(actor: Actor): string {
  return actor.kind === 'web' ? 'web' : actor.key.id
}

export function requireScope(actor: Actor, scope: ApiScope) {
  if (actor.kind === 'key' && !actor.key.scopes.includes(scope)) {
    throw new HTTPException(403, { message: `This API key can't do that. It needs the “${scope}” scope.` })
  }
}

export function canUseLedger(actor: Actor, ledgerId: string): boolean {
  return actor.kind === 'web' || !actor.key.ledgers || actor.key.ledgers.includes(ledgerId)
}

export function requireLedger(actor: Actor, ledgerId: string) {
  if (!canUseLedger(actor, ledgerId)) throw new HTTPException(403, { message: "This API key isn't allowed to use that ledger." })
}

// Keys -----------------------------------------------------------------------

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 43 base62 characters (about 256 bits), drawn without modulo bias. */
function randomToken(length = 43): string {
  let out = ''
  while (out.length < length) {
    for (const b of randomBytes(64)) {
      if (b < 248 && out.length < length) out += BASE62[b % 62]
    }
  }
  return out
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** read < write < admin: each scope includes the ones below it. */
function expandScopes(scopes: ApiScope[]): ApiScope[] {
  const all: ApiScope[] = ['read', 'write', 'admin']
  const top = Math.max(...scopes.map((s) => all.indexOf(s)))
  return all.slice(0, top + 1)
}

function toDTO(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    ledgers: row.ledgers,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  }
}

export function listApiKeys(meta: MetaStore): ApiKey[] {
  return meta.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all().map(toDTO)
}

export function createApiKey(
  meta: MetaStore,
  registry: LedgerRegistry,
  input: Omit<ApiKeyCreate, 'ledgers'> & { ledgers?: string[] | null },
  now: Date,
): ApiKeyCreated {
  const key = `cm_${randomToken()}`
  const ledgers = input.ledgers?.length ? [...new Set(input.ledgers.map((l) => registry.get(l).id))] : null
  const row: ApiKeyRow = {
    id: ulid(now.getTime()),
    name: input.name,
    prefix: key.slice(0, 9),
    hash: hashKey(key),
    scopes: expandScopes(input.scopes),
    ledgers,
    expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString() : null,
    lastUsedAt: null,
    createdAt: now.toISOString(),
  }
  meta.db.insert(apiKeys).values(row).run()
  return { ...toDTO(row), key }
}

export function revokeApiKey(meta: MetaStore, id: string): ApiKey {
  const row = meta.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
  if (!row) throw new HTTPException(404, { message: 'API key not found' })
  meta.db.delete(apiKeys).where(eq(apiKeys.id, id)).run()
  return toDTO(row)
}

/** The key's row, or null when it's unknown or expired. Records when it was last used (at most once a minute). */
export function verifyApiKey(meta: MetaStore, key: string, now: Date): ApiKeyRow | null {
  const row = meta.db.select().from(apiKeys).where(eq(apiKeys.hash, hashKey(key))).get()
  if (!row) return null
  if (row.expiresAt && row.expiresAt <= now.toISOString()) return null
  const stamp = now.toISOString()
  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > 60_000) {
    meta.db.update(apiKeys).set({ lastUsedAt: stamp }).where(eq(apiKeys.id, row.id)).run()
    row.lastUsedAt = stamp
  }
  return row
}

// Middleware -----------------------------------------------------------------

/** Names only your own machine or network answers to, so another site can't point them at this server. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.internal', '.ts.net']

/**
 * Whether the web app may be used at this host name: an IP address, localhost, a name without a dot
 * (`nas`), a local one (.local, .lan, .home.arpa, .internal, .ts.net), or one in `allowed` (where
 * `.example.com` also allows its subdomains). Any other name could be a site whose DNS was switched
 * to this server's address (DNS rebinding), which the browser would then treat as that site.
 */
export function isAllowedHost(hostname: string, allowed: readonly string[] = []): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!name) return false
  if (isIP(name) || name === 'localhost' || !name.includes('.')) return true
  if (LOCAL_SUFFIXES.some((s) => name.endsWith(s))) return true
  return allowed.some((a) => (a.startsWith('.') ? name === a.slice(1) || name.endsWith(a) : name === a))
}

const sameHost = (url: string, host: string) => {
  try {
    return new URL(url).host === host
  } catch {
    return false
  }
}

/**
 * Whether a request comes from the app's own page (or is a typed address or a download), not from
 * another site. Browsers say so in Sec-Fetch-Site. They only send it to HTTPS and localhost, so
 * otherwise the Origin (on a POST, PATCH or DELETE) or the Referer (on a GET) must be this host.
 */
function fromOwnPage(c: Context, host: string): boolean {
  const site = c.req.header('sec-fetch-site')
  if (site) return site === 'same-origin' || site === 'none'
  const origin = c.req.header('origin')
  if (origin) return sameHost(origin, host)
  const referer = c.req.header('referer')
  return !!referer && sameHost(referer, host)
}

/**
 * Works out who is calling.
 * - A request with `Authorization: Bearer <key>` is that key, and the key must be valid.
 * - Without a key, the request is the web app, as long as it comes from the app's own page (not
 *   another site, see `fromOwnPage`), at a host name in `isAllowedHost`, and carries
 *   `trustedHeader` (e.g. Tailscale's `Tailscale-User-Login`) when that's configured.
 */
export function authenticate(opts: {
  meta: MetaStore
  now: () => Date
  trustedHeader: string | null
  allowedHosts: readonly string[]
}): MiddlewareHandler<{ Variables: { actor: Actor } }> {
  return async (c, next) => {
    // Only a Bearer token is an API key. Another scheme (Basic, from a proxy that signs people in)
    // isn't ours: the request is checked like any other without a key.
    const auth = c.req.header('authorization')
    if (auth && /^Bearer\b/i.test(auth)) {
      const match = /^Bearer\s+(\S+)$/i.exec(auth)
      if (!match) throw new HTTPException(401, { message: 'Send the API key as "Authorization: Bearer <key>".' })
      const key = verifyApiKey(opts.meta, match[1]!, opts.now())
      if (!key) throw new HTTPException(401, { message: 'That API key is not valid. It may have been revoked or expired.' })
      c.set('actor', { kind: 'key', key })
      return next()
    }
    const url = new URL(c.req.url)
    if (!isAllowedHost(url.hostname, opts.allowedHosts)) {
      throw new HTTPException(403, {
        message: `Without an API key, this server only answers at localhost, its IP address or a local name, not ${url.hostname}. To use the app at that name, add it to ALLOWED_HOSTS.`,
      })
    }
    if (!fromOwnPage(c, url.host)) {
      throw new HTTPException(401, { message: 'Requests from outside the app need an API key. Send it as "Authorization: Bearer <key>".' })
    }
    if (opts.trustedHeader && !c.req.header(opts.trustedHeader)) {
      // Says what's wrong without naming the header, which would help someone forge it.
      throw new HTTPException(401, {
        message: 'Open the app through the proxy that signs you in: this server is set up to expect it (TRUSTED_AUTH_HEADER). Scripts send an API key as "Authorization: Bearer <key>".',
      })
    }
    c.set('actor', { kind: 'web' })
    await next()
  }
}

/** The actor on a request (set by `authenticate`). */
export function actorOf(c: Context): Actor {
  return c.get('actor') as Actor
}
