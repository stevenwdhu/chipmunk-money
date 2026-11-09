import { ref } from 'vue'

/**
 * Why the server won't let this page use it (opened at a host name it doesn't answer at, say, or
 * without the header a reverse proxy should add), in the server's words. Set when the app loads.
 */
export const accessRefused = ref<string | null>(null)

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message)
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

function withQuery(path: string, query?: Query) {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query, file?: Blob): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/v1${withQuery(path, query)}`, {
      method,
      headers: file
        ? { 'content-type': 'application/octet-stream' }
        : body === undefined
          ? undefined
          : { 'content-type': 'application/json' },
      body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    // Errors look like { error: { code, message, issues? } }.
    throw new ApiError(data?.error?.message ?? `Request failed (${res.status})`, res.status, data?.error?.issues ?? [])
  }
  return data as T
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T = void>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  /** Sends a file as the raw request body. */
  upload: <T>(path: string, file: Blob) => request<T>('POST', path, undefined, undefined, file),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}
