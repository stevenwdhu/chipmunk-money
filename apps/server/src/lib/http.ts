import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'

export class ValidationError extends Error {
  constructor(public issues: Array<{ path: string; message: string }>) {
    super(issues[0] ? `${issues[0].path ? `${issues[0].path}: ` : ''}${issues[0].message}` : 'Invalid input')
  }
}

export function parseWith<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return result.data
}

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let json: unknown
  try {
    json = await c.req.json()
  } catch {
    throw new HTTPException(400, { message: 'Request body must be JSON' })
  }
  return parseWith(schema, json)
}

export function query<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseWith(schema, c.req.query())
}

export function idParam(c: Context, name = 'id'): number {
  const id = Number(c.req.param(name))
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: `Invalid ${name}` })
  return id
}

export function notFound(message = 'Not found'): never {
  throw new HTTPException(404, { message })
}

export function badRequest(message: string): never {
  throw new HTTPException(400, { message })
}
