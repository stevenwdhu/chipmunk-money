import { describe, expect, it } from 'vitest'
import { activityQuerySchema } from '@chipmunk/shared'
import { twinLedgers } from '../test/transaction-twins'
import type { AppContext } from './context'
import { activityActors, listActivity, recordActivity } from './activity'

const log = (ctx: AppContext, actor: string, summary: string, entity = 'transaction') =>
  recordActivity(ctx, { name: actor, apiKeyId: null }, { action: 'create', entity, entityId: 1, summary, after: { summary } })

describe('the activity log', () => {
  it('keeps each ledger’s own, paged by its own ids', () => {
    const { a, b } = twinLedgers()
    log(a, 'web', 'A1')
    log(b, 'web', 'B1')
    log(a, 'mcp', 'A2', 'account')
    log(b, 'script', 'B2')
    log(a, 'web', 'A3')

    const page = (ctx: AppContext, q: Record<string, unknown> = {}) => listActivity(ctx, activityQuerySchema.parse(q))
    expect(page(a).items.map((e) => e.summary)).toEqual(['A3', 'A2', 'A1'])
    expect(page(b).items.map((e) => e.summary)).toEqual(['B2', 'B1'])
    expect(page(a).items[0]).toMatchObject({ actor: 'web', action: 'create', entity: 'transaction', entityId: '1', before: null, after: { summary: 'A3' } })

    // A cursor walks only this ledger's entries, past the other's ids in between.
    const first = page(a, { limit: 1 })
    expect(first.items.map((e) => e.summary)).toEqual(['A3'])
    const second = page(a, { limit: 1, cursor: first.nextCursor })
    expect(second.items.map((e) => e.summary)).toEqual(['A2'])
    const third = page(a, { limit: 1, cursor: second.nextCursor })
    expect(third).toMatchObject({ items: [expect.objectContaining({ summary: 'A1' })], nextCursor: null })

    expect(page(a, { actor: 'web' }).items.map((e) => e.summary)).toEqual(['A3', 'A1'])
    expect(page(a, { entity: 'account' }).items.map((e) => e.summary)).toEqual(['A2'])
    expect(page(b, { actor: 'mcp' }).items).toEqual([])
    expect(activityActors(a)).toEqual(['web', 'mcp'])
    expect(activityActors(b).sort()).toEqual(['script', 'web'])
    expect(() => page(a, { cursor: 'x' })).toThrow('Invalid cursor')
  })
})
