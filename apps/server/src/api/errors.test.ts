import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { onError } from './errors'

describe('API errors', () => {
  it('answer a missing id the code didn’t check with 400, not 500', async () => {
    const app = new Hono().get('/fk', () => {
      throw Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
    })
    app.onError(onError)
    const res = await app.request('/fk')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request', message: expect.stringContaining('doesn’t exist') } })
  })
})
