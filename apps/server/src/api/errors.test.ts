import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
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

  it('answer another ledger’s id the same way as a missing one', async () => {
    const app = new Hono().get('/fk', () => {
      throw Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
    })
    app.get('/other', () => {
      throw Object.assign(new Error('cross-ledger reference'), { code: 'SQLITE_CONSTRAINT_TRIGGER' })
    })
    app.get('/trigger', () => {
      throw Object.assign(new Error('write outside the ledger scope'), { code: 'SQLITE_CONSTRAINT_TRIGGER' })
    })
    app.onError(onError)
    const [missing, other] = [await app.request('/fk'), await app.request('/other')]
    expect(other.status).toBe(400)
    expect(await other.json()).toEqual(await missing.json())
    // Any other guard is a bug on the server, not a bad request.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await app.request('/trigger')).status).toBe(500)
    err.mockRestore()
  })
})
