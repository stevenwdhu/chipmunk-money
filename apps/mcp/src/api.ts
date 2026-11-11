import type { ApiScope } from '@chipmunk/shared'

/** `fetch`, or anything shaped like it (the main server passes Hono's in-process `app.request`). */
export type FetchLike = (url: string, init?: RequestInit) => Response | Promise<Response>

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

/** What `GET /me` says about the caller. */
export interface Me {
  actor: string
  kind: 'web' | 'key'
  scopes: ApiScope[]
  ledgers: string[] | null
  defaultLedger: string | null
}

export interface ApiClient {
  get<T>(path: string, query?: Query): Promise<T>
  post<T>(path: string, body?: unknown, query?: Query): Promise<T>
  patch<T>(path: string, body: unknown): Promise<T>
  put<T>(path: string, body: unknown, query?: Query): Promise<T>
  del(path: string): Promise<void>
  /** Like `post`, but also returns the HTTP status (201 created vs 200 already there). */
  postWithStatus<T>(path: string, body?: unknown): Promise<{ status: number; data: T }>
}

/**
 * A small client for /api/v1. The MCP server works only through the API, with the agent's key, so
 * scopes, validation, idempotency and the activity log all apply exactly as they do for any caller.
 */
export function createApiClient(opts: { fetch: FetchLike; baseUrl?: string; apiKey?: string | null }): ApiClient {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '')
  async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<{ status: number; data: T }> {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
    const qs = params.size ? `?${params}` : ''
    const headers: Record<string, string> = {}
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await opts.fetch(`${base}/api/v1${path}${qs}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      throw new ApiError(`Can't reach Chipmunk at ${base || 'this server'}: ${err instanceof Error ? err.message : err}`, 0)
    }
    if (res.status === 204) return { status: 204, data: undefined as T }
    const text = await res.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = undefined
    }
    if (!res.ok) {
      const error = (data as { error?: { message?: string; code?: string } } | undefined)?.error
      throw new ApiError(error?.message ?? `Request failed (${res.status})`, res.status, error?.code)
    }
    return { status: res.status, data: data as T }
  }
  return {
    get: async (path, query) => (await request<never>('GET', path, undefined, query)).data,
    post: async (path, body, query) => (await request<never>('POST', path, body ?? {}, query)).data,
    patch: async (path, body) => (await request<never>('PATCH', path, body)).data,
    put: async (path, body, query) => (await request<never>('PUT', path, body, query)).data,
    del: async (path) => void (await request('DELETE', path)),
    postWithStatus: (path, body) => request('POST', path, body ?? {}),
  }
}
