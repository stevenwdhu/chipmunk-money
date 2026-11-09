import { Hono, type Context, type Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { ApiScope } from '@st/shared'
import type { SQLite } from '../db/client'
import { body as readBody, parseWith } from '../lib/http'
import { requireScope, type Actor } from './auth'

export type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'

export interface RouteMeta {
  /** What an API key needs to call this route. Requests from the web app may call anything. */
  scope: ApiScope
  /** Short sentence-case title, e.g. "List transactions". Also becomes the operationId. */
  summary: string
  description?: string
  /** Section in the API docs. Defaults to the router's tag. */
  tag?: string
  /** Path parameters. Defaults to a positive integer for every `:name` in the path. */
  params?: z.ZodType
  query?: z.ZodType
  /** JSON request body. */
  body?: z.ZodType
  /** A raw request body instead of JSON, e.g. a backup file. The handler reads it. */
  upload?: { contentType: string; description: string }
  /** JSON response body. */
  response?: z.ZodType
  /** A file response instead of JSON. The handler returns the Response. */
  file?: { contentType: string; description: string }
  status?: 200 | 201 | 202 | 204
  /** Accepts `?dryRun=true`: the handler runs, then every database change is rolled back. */
  dryRun?: boolean
}

export interface RouteSpec extends RouteMeta {
  method: Method
  /** Hono-style path under /api/v1, e.g. `/ledgers/:ledger/transactions/:id`. */
  path: string
  tag: string
}

type ParamNames<S extends string> = S extends `${string}:${infer P}/${infer Rest}`
  ? P | ParamNames<`/${Rest}`>
  : S extends `${string}:${infer P}`
    ? P
    : never

export interface RouteInput<P extends string, M extends RouteMeta> {
  params: M extends { params: infer S extends z.ZodType } ? z.output<S> : { [K in ParamNames<P>]: number }
  query: M extends { query: infer S extends z.ZodType } ? z.output<S> : Record<string, never>
  body: M extends { body: infer S extends z.ZodType } ? z.output<S> : undefined
  /** True when the caller asked for a dry run (routes with `dryRun: true`). */
  dryRun: boolean
}

export type BaseEnv = { Variables: { actor: Actor } }
type Handler<E extends Env, P extends string, M extends RouteMeta> = (
  c: Context<E>,
  input: RouteInput<P, M>,
) => unknown | Promise<unknown>

const positiveId = z.coerce.number().int().positive()
const dryRunFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1')

/** Names of the `:params` in a Hono path, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]!)
}

/**
 * Runs `fn` and rolls back everything it wrote. `fn` must be synchronous: nothing else can touch
 * the database between the savepoint and the rollback.
 */
export function withDryRun<T>(sqlite: SQLite, fn: () => T): T {
  sqlite.exec('SAVEPOINT dry_run')
  try {
    const out = fn()
    if (out instanceof Promise) throw new Error('Dry runs need a synchronous handler')
    return out
  } finally {
    sqlite.exec('ROLLBACK TO dry_run')
    sqlite.exec('RELEASE dry_run')
  }
}

/**
 * A Hono router that also records each route's scope and schemas. The records drive the scope
 * checks, the OpenAPI spec and the coverage test, so a route can't exist without them.
 */
export class ApiRouter<E extends BaseEnv> {
  readonly hono = new Hono<E>()
  readonly specs: RouteSpec[] = []

  constructor(
    private opts: {
      /** Where this router is mounted under /api/v1, e.g. `/ledgers/:ledger`. */
      mount: string
      tag: string
      /** The database a dry run rolls back. */
      dryRunDb?: (c: Context<E>) => SQLite
    },
  ) {}

  get<P extends string, M extends RouteMeta>(path: P, meta: M, handler: Handler<E, P, M>) {
    this.add('get', path, meta, handler)
  }
  post<P extends string, M extends RouteMeta>(path: P, meta: M, handler: Handler<E, P, M>) {
    this.add('post', path, meta, handler)
  }
  patch<P extends string, M extends RouteMeta>(path: P, meta: M, handler: Handler<E, P, M>) {
    this.add('patch', path, meta, handler)
  }
  put<P extends string, M extends RouteMeta>(path: P, meta: M, handler: Handler<E, P, M>) {
    this.add('put', path, meta, handler)
  }
  delete<P extends string, M extends RouteMeta>(path: P, meta: M, handler: Handler<E, P, M>) {
    this.add('delete', path, meta, handler)
  }

  private add<P extends string, M extends RouteMeta>(method: Method, path: P, meta: M, handler: Handler<E, P, M>) {
    const spec: RouteSpec = { ...meta, method, path: `${this.opts.mount}${path}`, tag: meta.tag ?? this.opts.tag }
    if (spec.dryRun && !this.opts.dryRunDb) throw new Error(`${spec.path}: dry runs need a database`)
    this.specs.push(spec)
    const names = pathParams(path)
    const paramsSchema = meta.params ?? z.object(Object.fromEntries(names.map((n) => [n, positiveId])))
    const status = meta.status ?? 200

    this.hono.on(method.toUpperCase(), path, async (c) => {
      requireScope(c.var.actor, meta.scope)
      const params = parseWith(paramsSchema, Object.fromEntries(names.map((n) => [n, c.req.param(n as never)])))
      const query = meta.query ? parseWith(meta.query, c.req.query()) : {}
      const body = meta.body ? await readBody(c, meta.body) : undefined
      const dryRun = meta.dryRun ? parseWith(dryRunFlag, c.req.query('dryRun')) : false
      const input = { params, query, body, dryRun } as RouteInput<P, M>

      const result = dryRun ? withDryRun(this.opts.dryRunDb!(c), () => handler(c, input)) : await handler(c, input)
      if (result instanceof Response) return result
      if (status === 204) return c.body(null, 204)
      return c.json(result as object, status as ContentfulStatusCode)
    })
  }
}
