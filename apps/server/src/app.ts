import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { logger } from 'hono/logger'
import { sql } from 'drizzle-orm'
import { createMcpHttpHandler } from '@chipmunk/mcp'
import { authenticate, verifyApiKey } from './api/auth'
import { errorResponse, onError } from './api/errors'
import { idempotency } from './api/idempotency'
import { buildOpenApi, docsPage, SCALAR } from './api/openapi'
import type { RouteSpec } from './api/router'
import { env } from './env'
import { appRoutes } from './routes/app'
import { BankService } from './services/bank/service'
import { finishChatgptSignIn } from './services/chatgpt'
import { envSettingsWarnings } from './services/settings'
import { ledgerRoutes } from './routes/ledger'
import type { Storage } from './storage'

export const API_VERSION = '1.0.0'

// Request size ---------------------------------------------------------------

const MB = 1024 * 1024
/** The most a JSON request may send. */
const JSON_LIMIT = 1 * MB
/** The most an import or an MCP call (which can import) may send: bank exports get large. */
export const UPLOAD_LIMIT = 200 * MB
const UPLOAD_ROUTES = /^\/api\/v1\/ledgers\/[^/]+\/import\/(preview|commit)$/

const limitTo = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => errorResponse(c, 413, `That request is too big. The most it can send is ${maxSize / MB} MB.`) })

// Security headers -----------------------------------------------------------
// What each kind of page may load, in one place. The web app loads its own files, plus Plaid Link
// (its script, its frames and its API) when you connect a bank with Plaid (apps/web/src/lib/plaid.ts).

type Csp = Record<string, string[]>
const cspHeader = (rules: Csp) =>
  Object.entries(rules)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ')
const scriptHash = (code: string) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`
/** Every page: no framing (clickjacking), no plugins, no <base> or form posts elsewhere. */
const LOCKED: Csp = { 'frame-ancestors': ["'none'"], 'object-src': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"] }

const CSP = {
  /** The web app. `inline` are the hashes of index.html's inline scripts (the theme, before first paint). */
  web: (inline: string[]): Csp => ({
    'default-src': ["'self'"],
    'script-src': ["'self'", ...inline, 'https://cdn.plaid.com'],
    // Components set inline styles.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'https://*.plaid.com'],
    'frame-src': ['https://cdn.plaid.com', 'https://*.plaid.com'],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    ...LOCKED,
  }),
  /** API responses are data and files, never pages. */
  api: { 'default-src': ["'none'"], ...LOCKED, 'base-uri': ["'none'"], 'form-action': ["'none'"] } satisfies Csp,
  /** /api/docs: Scalar's pinned script and the page's own config script, calling only this server. */
  docs: (inline: string): Csp => ({
    'default-src': ["'none'"],
    'script-src': [SCALAR.src, scriptHash(inline)],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    ...LOCKED,
  }),
  /** The page after signing in with ChatGPT: inline styles and the script that closes the tab. */
  callback: (inline: string): Csp => ({ 'default-src': ["'none'"], 'style-src': ["'unsafe-inline'"], 'script-src': [scriptHash(inline)], ...LOCKED }),
}

/** Hashes of a page's inline scripts (those without src), for its CSP. */
const inlineScriptHashes = (html: string) =>
  [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => scriptHash(m[1]!))

/** Sets headers on a response that's already made (copying it when its headers can't change). */
function setHeaders(c: Context, headers: Record<string, string>) {
  const apply = () => {
    for (const [name, value] of Object.entries(headers)) if (!c.res.headers.has(name)) c.res.headers.set(name, value)
  }
  try {
    apply()
  } catch {
    c.res = new Response(c.res.body, c.res)
    apply()
  }
}

/** The /api/v1 routes and the records describing them (scopes, schemas) for the spec and tests. */
export function createApi(storage: Storage, bank = new BankService(storage)) {
  const root = appRoutes(storage, bank)
  const ledger = ledgerRoutes(storage, bank)
  const specs: RouteSpec[] = [...root.specs, ...ledger.specs]
  return { root, ledger, specs }
}

export interface AppOptions {
  serveWeb?: boolean
  log?: boolean
  /** Overrides TRUSTED_AUTH_HEADER (tests). */
  trustedHeader?: string | null
  /** Overrides ALLOWED_HOSTS (tests). */
  allowedHosts?: string[]
  /** Overrides apps/web/dist, the built web app (tests). */
  webDist?: string
  /** Shared with the scheduler, so a manual and a scheduled sync can't overlap. */
  bank?: BankService
}

export function createApp(storage: Storage, opts: AppOptions = {}) {
  const app = new Hono()
  if (opts.log) app.use('/api/*', logger())
  app.onError(onError)
  // The server itself, not an app made for a test: say what's wrong with the settings in .env.
  if (opts.log || opts.serveWeb) for (const warning of envSettingsWarnings()) console.warn(`[settings] ${warning}`)

  const webDist = opts.webDist ?? env.webDist
  const serveWeb = opts.serveWeb && existsSync(path.join(webDist, 'index.html'))
  if (opts.serveWeb && !serveWeb) console.warn(`[web] There's no web app in ${webDist}, so only the API is served. Build it with pnpm build.`)
  const webCsp = cspHeader(CSP.web(serveWeb ? inlineScriptHashes(readFileSync(path.join(webDist, 'index.html'), 'utf8')) : []))
  const apiCsp = cspHeader(CSP.api)
  app.use('*', async (c, next) => {
    await next()
    const isApi = /^\/(api|mcp|healthz)(\/|$)/.test(c.req.path)
    setHeaders(c, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      // A page that set its own (the docs, the ChatGPT sign-in) keeps it.
      'Content-Security-Policy': isApi ? apiCsp : webCsp,
    })
  })

  app.get('/healthz', (c) => {
    try {
      storage.app.db.get(sql`SELECT 1`)
      return c.json({ ok: true })
    } catch (err) {
      console.error(err)
      return c.json({ ok: false, error: 'The app database can’t be read.' }, 503)
    }
  })

  // Where OpenAI sends the browser after you sign in with ChatGPT (a loopback address, so it reaches
  // this server when the browser runs on the same machine). The sign-in's state is what protects it.
  const closeTab = 'setTimeout(() => window.close(), 1500)'
  const callbackCsp = cspHeader(CSP.callback(closeTab))
  app.get('/auth/callback', async (c) => {
    const page = (title: string, text: string) => {
      c.header('Content-Security-Policy', callbackCsp)
      return c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
          `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111">` +
          `<h1 style="font-size:1.25rem">${title}</h1><p>${text}</p><script>${closeTab}</script></body>`,
      )
    }
    try {
      await finishChatgptSignIn(storage.app, c.req.query())
      return page('Signed in with ChatGPT', 'You can close this tab and go back to Chipmunk.')
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/[<>&]/g, '')
      return page('Signing in didn’t finish', `${message} Go back to Chipmunk and try again.`)
    }
  })

  const api = createApi(storage, opts.bank)
  let spec: ReturnType<typeof buildOpenApi> | undefined
  // The spec and docs are public: they describe the API but hold no data.
  app.get('/api/v1/openapi.json', (c) => c.json((spec ??= buildOpenApi(api.specs, { version: API_VERSION }))))
  const docs = docsPage('/api/v1/openapi.json')
  const docsCsp = cspHeader(CSP.docs(docs.script))
  app.get('/api/docs', (c) => {
    c.header('Content-Security-Policy', docsCsp)
    return c.html(docs.html)
  })

  const jsonLimit = limitTo(JSON_LIMIT)
  const uploadLimit = limitTo(UPLOAD_LIMIT)
  app.use('/api/v1/*', (c, next) => (UPLOAD_ROUTES.test(c.req.path) ? uploadLimit : jsonLimit)(c, next))
  const trustedHeader = opts.trustedHeader === undefined ? env.trustedAuthHeader : opts.trustedHeader
  const allowedHosts = opts.allowedHosts ?? env.allowedHosts
  app.use('/api/v1/*', authenticate({ meta: storage.app, now: storage.now, trustedHeader, allowedHosts }))
  app.use('/api/v1/*', idempotency({ meta: storage.app, now: storage.now }))
  app.route('/api/v1', api.root.hono)
  app.route('/api/v1/ledgers/:ledger', api.ledger.hono)
  app.all('/api/*', (c) => errorResponse(c, 404, `There's no ${c.req.method} ${c.req.path} in the API. See /api/docs.`))

  // MCP for agents. It always needs an API key (the agent's identity in the activity log), and
  // works through the API in-process, so the key's scopes and ledgers apply to every tool.
  const mcp = createMcpHttpHandler({ fetch: (url, init) => app.request(url, init) })
  app.all('/mcp', uploadLimit, (c) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token || !verifyApiKey(storage.app, token, storage.now())) {
      c.header('WWW-Authenticate', 'Bearer realm="chipmunk"')
      return errorResponse(c, 401, 'Send an API key as "Authorization: Bearer cm_…". Create one in App settings → API keys.')
    }
    return mcp.fetch(c.req.raw, { authInfo: { token, clientId: 'api-key', scopes: [] } })
  })

  if (serveWeb) {
    // serveStatic resolves `root` against the working directory.
    const root = path.relative(process.cwd(), webDist) || '.'
    // Files in /assets have a hash in their name, so they never change. The rest (index.html, sw.js,
    // the manifest) is checked again each time, so a new version is picked up.
    app.use('/*', async (c, next) => {
      c.header('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
      await next()
    })
    app.use('/*', serveStatic({ root }))
    // A hashed file that isn't there (say, an old version's) is missing, not a page of the app.
    app.all('/assets/*', (c) => {
      c.header('Cache-Control', 'no-cache')
      return c.text('Not found', 404)
    })
    // SPA fallback: unknown paths load the app, which handles routing.
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }
  return app
}
