import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiErrorBody, ErrorCode } from '@chipmunk/shared'
import { ValidationError } from '../lib/http'

function codeFor(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 413:
      return 'payload_too_large'
    case 429:
      return 'rate_limited'
    default:
      return status >= 500 ? 'internal' : 'bad_request'
  }
}

/** Every API error has the same shape: `{ error: { code, message, issues? } }`. */
export function errorResponse(c: Context, status: ContentfulStatusCode, message: string, issues?: ApiErrorBody['error']['issues']) {
  const error: ApiErrorBody['error'] = { code: issues ? 'validation_failed' : codeFor(status), message }
  if (issues) error.issues = issues
  return c.json({ error } satisfies ApiErrorBody, status)
}

export function onError(err: Error, c: Context) {
  if (err instanceof ValidationError) return errorResponse(c, 400, err.message, err.issues)
  if (err instanceof HTTPException) return errorResponse(c, err.status as ContentfulStatusCode, err.message)
  // A unique index caught a duplicate the code didn't check for.
  if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return errorResponse(c, 409, 'That already exists.')
  // An id the code didn't check: an account, category or the like that doesn't exist.
  if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return errorResponse(c, 400, 'That refers to something that doesn’t exist, like an account or category. Check the ids you sent.')
  }
  console.error(err)
  return errorResponse(c, 500, 'Something went wrong on the server. Check the server log for details.')
}
