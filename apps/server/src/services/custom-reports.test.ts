import { describe, expect, it } from 'vitest'
import { transactionCreateSchema, type CustomReport, type ReportSpec } from '@chipmunk/shared'
import { createApp } from '../app'
import { categoryId, makeAccount, testContext, testLedger, testStorage } from '../test/helpers'
import { leaveSharedList } from './catalog'
import { createGroup, createTag, deleteGroup, deleteTag, mergeCategory, setCategoryEnabled } from './categories'
import {
  carryPayeeRefs,
  createCustomReport,
  CUSTOM_REPORTS_MAX,
  deleteCustomReport,
  getCustomReport,
  listCustomReports,
  reorderCustomReports,
  updateCustomReport,
} from './custom-reports'
import { createLabel, deleteLabel } from './labels'
import { listRecurring } from './recurring'
import { eraseAll, startDemo } from './setup'
import { createTransaction, deleteTransaction } from './transactions'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const spending = (side: Record<string, unknown>) => ({ filter: { spending: side } }) as ReportSpec
const spend = (ctx: ReturnType<typeof testContext>, payee: string, extra: Record<string, unknown> = {}) =>
  createTransaction(ctx, transactionCreateSchema.parse({ accountId: makeAccount(ctx, `Chq ${payee}`), date: '2026-09-01', amountMinor: -1_000, payee, ...extra }), {
    useAi: false,
  })

function api() {
  const storage = testStorage()
  const app = createApp(storage, { trustedHeader: null })
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(`/api/v1/ledgers/personal${url}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  const activity = async () => ((await call('GET', '/activity?entity=custom_report')).body.items as Json[]).map((a) => a.summary)
  return { ctx: storage.registry.defaultContext(), call, activity }
}

describe('custom reports', () => {
  it('are saved, listed in your order, changed and deleted', () => {
    const ctx = testContext()
    const groceries = categoryId(ctx, 'Groceries')
    const b = createCustomReport(ctx, { name: '  Groceries only ', spec: spending({ only: [{ field: 'category', ids: [groceries, groceries] }] }) })
    expect(b).toMatchObject({
      name: 'Groceries only',
      // Filled in and tidied.
      spec: { v: 1, filter: { v: 1, spending: { only: [{ field: 'category', ids: [groceries] }], filterOut: [], picked: [], keep: [] } }, range: null, compare: 'previous', groupBy: 'category' },
      description: 'Spending: Only Groceries',
      missing: [],
    })
    const a = createCustomReport(ctx, { name: 'all of it', spec: { range: '6m', compare: 'none' } })
    expect(a).toMatchObject({ spec: { filter: { v: 1 }, range: '6m', compare: 'none' }, description: 'Everything' })
    // A new one goes last, and you can move them.
    expect(listCustomReports(ctx).map((r) => r.name)).toEqual(['Groceries only', 'all of it'])
    expect(reorderCustomReports(ctx, [a.id]).map((r) => r.name)).toEqual(['all of it', 'Groceries only'])
    expect(() => reorderCustomReports(ctx, [999])).toThrow('no custom report 999')

    // A new name, or a new spec in place of the old one.
    expect(updateCustomReport(ctx, a.id, { name: 'All of it' })).toMatchObject({ name: 'All of it', spec: { range: '6m' } })
    expect(updateCustomReport(ctx, a.id, { spec: { groupBy: 'group' } }).spec).toEqual({ v: 1, filter: { v: 1 }, range: null, compare: 'previous', groupBy: 'group' })
    expect(() => updateCustomReport(ctx, a.id, { spec: { range: '2026-01..2029-12' } })).toThrow(/at most 36/)
    expect(() => createCustomReport(ctx, { name: 'x'.repeat(61), spec: {} })).toThrow()
    expect(() => createCustomReport(ctx, { name: ' ', spec: {} })).toThrow('Required')

    expect(deleteCustomReport(ctx, a.id).name).toBe('All of it')
    expect(() => getCustomReport(ctx, a.id)).toThrow('Custom report not found')
    expect(listCustomReports(ctx).map((r) => r.id)).toEqual([b.id])
  })

  it('have names unique whatever their case, and up to 50 of them', () => {
    const ctx = testContext()
    const regular = createCustomReport(ctx, { name: 'Regular spending', spec: {} })
    expect(() => createCustomReport(ctx, { name: 'regular SPENDING', spec: {} })).toThrow('You already have a report called “Regular spending”.')
    const other = createCustomReport(ctx, { name: 'Other', spec: {} })
    expect(() => updateCustomReport(ctx, other.id, { name: 'REGULAR spending' })).toThrow(/already have a report/)
    // Its own name in another case is fine.
    expect(updateCustomReport(ctx, regular.id, { name: 'Regular Spending' }).name).toBe('Regular Spending')

    for (let i = listCustomReports(ctx).length; i < CUSTOM_REPORTS_MAX; i++) createCustomReport(ctx, { name: `Report ${i}`, spec: {} })
    expect(() => createCustomReport(ctx, { name: 'One more', spec: {} })).toThrow('You can keep up to 50 custom reports. Delete one to save another.')
    deleteCustomReport(ctx, other.id)
    expect(createCustomReport(ctx, { name: 'One more', spec: {} }).name).toBe('One more')
  })

  it('keep ids that no longer exist, saying what’s gone or off', async () => {
    const ctx = testContext()
    const dineOut = categoryId(ctx, 'Dine out')
    const tag = createTag(ctx, 'trip-japan')
    const t = await spend(ctx, 'Pizza Libretto', { categoryId: dineOut })
    const gone = await spend(ctx, 'Gone')
    const report = createCustomReport(ctx, {
      name: 'Trips',
      spec: spending({
        only: [{ field: 'category', ids: [dineOut] }],
        filterOut: [{ when: [{ field: 'tag', ids: [tag.id] }] }, { when: [{ field: 'payee', keys: ['costco', t.payeeKey] }] }],
        picked: [gone.id, 999],
      }),
    })
    // No transaction has costco, and 999 never was.
    expect(report.missing).toEqual([
      { kind: 'payee', id: 'costco', reason: 'unused' },
      { kind: 'transaction', id: 999, reason: 'deleted' },
    ])
    expect(report.description).toBe('Spending: Only Dine out · Filter out #trip-japan · Filter out costco, Pizza Libretto · Filter out 2 picked')

    // A payee comes back with a transaction, and is named.
    await spend(ctx, 'COSTCO')
    deleteTag(ctx, tag.id)
    deleteTransaction(ctx, gone.id)
    // Turned off, its transactions left uncategorized: the report still has it.
    setCategoryEnabled(ctx, dineOut, { enabled: false, moveTo: null })
    const now = getCustomReport(ctx, report.id)
    expect(now.spec).toEqual(report.spec)
    expect(now.missing).toEqual([
      { kind: 'category', id: dineOut, reason: 'off' },
      { kind: 'tag', id: tag.id, reason: 'deleted' },
      { kind: 'transaction', id: gone.id, reason: 'deleted' },
      { kind: 'transaction', id: 999, reason: 'deleted' },
    ])
    // The tag is named as it was when the report was saved.
    expect(now.description).toBe('Spending: Only Dine out · Filter out #trip-japan (deleted) · Filter out COSTCO, Pizza Libretto · Filter out 2 picked')
    expect(listCustomReports(ctx)).toEqual([now])
  })

  it('follow a category merged or turned off into another', async () => {
    const ctx = testContext()
    // A ledger merges categories of its own list (the shared list's are merged in App settings).
    leaveSharedList(ctx)
    const [dineOut, treats, groceries] = [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Drinks & treats'), categoryId(ctx, 'Groceries')]
    await spend(ctx, 'Starbucks', { categoryId: treats })
    const both = createCustomReport(ctx, { name: 'Eating', spec: spending({ only: [{ field: 'category', ids: [dineOut, treats, 'none'] }] }) })
    const rule = createCustomReport(ctx, { name: 'No treats', spec: spending({ filterOut: [{ when: [{ field: 'category', ids: [treats] }, { field: 'amount', min: 500 }] }] }) })
    const other = createCustomReport(ctx, { name: 'Groceries', spec: spending({ only: [{ field: 'category', ids: [groceries] }] }) })

    expect(mergeCategory(ctx, treats, dineOut)).toMatchObject({ transactions: 1, reports: 2 })
    expect(getCustomReport(ctx, both.id).spec.filter.spending!.only).toEqual([{ field: 'category', ids: [dineOut, 'none'] }])
    expect(getCustomReport(ctx, rule.id).spec.filter.spending!.filterOut).toEqual([{ when: [{ field: 'category', ids: [dineOut] }, { field: 'amount', min: 500 }] }])
    expect(getCustomReport(ctx, other.id)).toEqual(other)

    expect(setCategoryEnabled(ctx, dineOut, { enabled: false, moveTo: groceries })).toMatchObject({ moved: 1, reports: 2 })
    expect(getCustomReport(ctx, both.id)).toMatchObject({ spec: { filter: { spending: { only: [{ field: 'category', ids: [groceries, 'none'] }] } } }, missing: [] })
  })

  it('are cleared by erasing', () => {
    const storage = testStorage()
    const ctx = storage.registry.defaultContext()
    const tag = createTag(ctx, 'kept')
    createCustomReport(ctx, { name: 'Kept', spec: spending({ only: [{ field: 'tag', ids: [tag.id] }] }) })
    expect(listCustomReports(ctx)).toEqual([expect.objectContaining({ name: 'Kept', description: 'Spending: Only #kept', missing: [] })])
    eraseAll(storage, ctx)
    expect(listCustomReports(ctx)).toEqual([])
  })

  it('keep the names of what they filter by, to name what’s gone', () => {
    const ctx = testContext()
    const moving = createTag(ctx, 'moving')
    const report = createCustomReport(ctx, { name: 'Settled', spec: spending({ filterOut: [{ when: [{ field: 'tag', ids: [moving.id] }] }] }) })
    expect(report.spec.names).toEqual({ tag: { [moving.id]: 'moving' } })
    deleteTag(ctx, moving.id)
    expect(getCustomReport(ctx, report.id).description).toBe('Spending: Filter out #moving (deleted)')
    // Saved again, it still knows.
    expect(updateCustomReport(ctx, report.id, { spec: getCustomReport(ctx, report.id).spec }).description).toBe('Spending: Filter out #moving (deleted)')
  })

  it('name the groups and labels they filter by, and say when one is gone', () => {
    const ctx = testContext()
    // Groups and labels are edited in a ledger with its own list (the shared list's in App settings).
    leaveSharedList(ctx)
    const food = ctx.q.pluck<number>("SELECT id FROM ledger_category_groups WHERE ledger_id = @ledger AND name = 'Food'")!
    const boats = createGroup(ctx, { name: 'Boats' })
    const splurge = createLabel(ctx, { name: 'Splurge' })
    const report = createCustomReport(ctx, {
      name: 'Toys',
      spec: spending({
        only: [{ field: 'group', ids: [boats.id, food] }],
        filterOut: [{ when: [{ field: 'label', ids: [splurge.id] }] }, { when: [{ field: 'label', ids: ['none'] }, { field: 'amount', min: 100_000 }] }],
      }),
    })
    expect(report).toMatchObject({
      spec: { names: { group: { [food]: 'Food', [boats.id]: 'Boats' }, label: { [splurge.id]: 'Splurge' } } },
      description: 'Spending: Only Food and Boats groups · Filter out the Splurge label · Filter out charges of $1,000 or more with no label',
      missing: [],
    })
    deleteGroup(ctx, boats.id)
    deleteLabel(ctx, splurge.id)
    expect(getCustomReport(ctx, report.id)).toMatchObject({
      description: 'Spending: Only Food and Boats (deleted) groups · Filter out the Splurge (deleted) label · Filter out charges of $1,000 or more with no label',
      missing: [
        { kind: 'group', id: boats.id, reason: 'deleted' },
        { kind: 'label', id: splurge.id, reason: 'deleted' },
      ],
    })
  })

  it('keep a payee they couldn’t follow to too many new names, and say why', () => {
    const ctx = testContext()
    const report = createCustomReport(ctx, { name: 'Shop', spec: spending({ only: [{ field: 'payee', keys: ['shop'] }] }) })
    carryPayeeRefs(
      ctx,
      Array.from({ length: 201 }, (_, i): [string, string] => ['shop', `shop order ${i}`]),
    )
    expect(getCustomReport(ctx, report.id).spec).toEqual(report.spec)
    // Fewer fit: the old key goes once nothing has it.
    const other = createCustomReport(ctx, { name: 'Other', spec: spending({ only: [{ field: 'payee', keys: ['old', 'new'] }] }) })
    carryPayeeRefs(ctx, [['old', 'new']])
    expect(getCustomReport(ctx, other.id).spec.filter.spending!.only).toEqual([{ field: 'payee', keys: ['new'] }])
    expect(ctx.q.column("SELECT summary FROM activity WHERE ledger_id = @ledger AND entity = 'custom_report' ORDER BY id")).toEqual([
      'Shop couldn’t follow a payee to its new names: there were too many for one report',
      'Other no longer filters by the payee’s old name, old',
    ])
  })

  it('come with the demo: everyday spending, without the trip or big one-offs', () => {
    const ctx = testContext()
    startDemo(ctx)
    const trip = ctx.q.pluck<number>("SELECT id FROM tags WHERE ledger_id = @ledger AND name = 'trip-japan'")!
    expect(getCustomReport(ctx, 1)).toMatchObject({
      name: 'Everyday spending',
      spec: {
        filter: {
          spending: {
            filterOut: [
              { when: [{ field: 'tag', ids: [trip] }] },
              { when: [{ field: 'amount', min: 100_000 }, { field: 'recurring', ids: 'none' }] },
            ],
          },
        },
        range: '12m',
        compare: 'previous',
        groupBy: 'category',
      },
      description: 'Spending: Filter out #trip-japan · Filter out one-time charges of $1,000 or more',
      missing: [],
    })
    // Rent is a recurring item's payments, so the second rule doesn't take it out.
    const rent = listRecurring(ctx, 'active').find((r) => /rent/i.test(r.payee))!
    const rentPaid = ctx.q.column("SELECT recurring_item_id FROM transactions WHERE ledger_id = @ledger AND payee LIKE 'Rent%'")
    expect(rentPaid.length).toBeGreaterThan(10)
    expect(new Set(rentPaid)).toEqual(new Set([rent.id]))
  })
})

describe('custom reports over HTTP', () => {
  it('are created, changed and deleted, each in the activity log', async () => {
    const { call, activity } = api()
    const created = await call('POST', '/custom-reports', { name: 'Regular spending', spec: { range: '3m' } })
    expect(created.status).toBe(201)
    const report = created.body as CustomReport
    expect((await call('GET', '/custom-reports')).body).toEqual([report])
    expect((await call('POST', '/custom-reports', { name: 'REGULAR SPENDING', spec: {} })).body).toEqual({
      error: { code: 'conflict', message: 'You already have a report called “Regular spending”.' },
    })
    expect((await call('POST', '/custom-reports', { name: 'Bad', spec: { compare: 'never' } })).status).toBe(400)

    expect((await call('PATCH', `/custom-reports/${report.id}`, { name: 'Usual spending' })).body).toMatchObject({ name: 'Usual spending', spec: { range: '3m' } })
    expect((await call('PATCH', `/custom-reports/${report.id}`, { spec: { range: '3m' } })).status).toBe(200)
    expect((await call('DELETE', `/custom-reports/${report.id}`)).status).toBe(204)
    expect((await call('GET', `/custom-reports/${report.id}`)).status).toBe(404)
    expect(await activity()).toEqual(['Deleted the custom report Usual spending', 'Edited the custom report Regular spending', 'Added the custom report Regular spending'])
  })

  it('come back from Undo, and are saved as new with a tag that’s gone', async () => {
    const { ctx, call } = api()
    const tag = createTag(ctx, 'old-trip')
    const spec = spending({ filterOut: [{ when: [{ field: 'tag', ids: [tag.id] }] }] })
    const report = (await call('POST', '/custom-reports', { name: 'No trips', spec })).body as CustomReport
    deleteTag(ctx, tag.id)
    expect((await call('DELETE', `/custom-reports/${report.id}`)).status).toBe(204)

    // Undo: the same name and spec again.
    const undone = await call('POST', '/custom-reports', { name: report.name, spec: report.spec })
    expect(undone.status).toBe(201)
    expect(undone.body).toMatchObject({ name: 'No trips', spec: report.spec, missing: [{ kind: 'tag', id: tag.id, reason: 'deleted' }] })
    // Save as new: the deleted tag is kept, reported, and still named.
    const copy = await call('POST', '/custom-reports', { name: 'No trips 2', spec: undone.body.spec })
    expect(copy.status).toBe(201)
    expect(copy.body).toMatchObject({ spec: report.spec, description: 'Spending: Filter out #old-trip (deleted)', missing: [{ kind: 'tag', id: tag.id, reason: 'deleted' }] })
  })

  it('say in a merge’s or move’s activity how many reports moved with the category', async () => {
    const { ctx, call } = api()
    const [dineOut, treats, groceries] = [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Drinks & treats'), categoryId(ctx, 'Groceries')]
    await spend(ctx, 'Starbucks', { categoryId: dineOut })
    await call('POST', '/custom-reports', { name: 'Treats', spec: spending({ only: [{ field: 'category', ids: [treats] }] }) })
    await call('POST', '/custom-reports', { name: 'Eating', spec: spending({ only: [{ field: 'category', ids: [treats, dineOut] }] }) })

    expect((await call('PATCH', `/categories/${dineOut}`, { enabled: false, moveTo: groceries })).status).toBe(200)
    await call('PUT', '/categories/sharing', { shared: false })
    // Its own list is a copy with new ids, and its reports follow them.
    const [ownTreats, ownGroceries] = [categoryId(ctx, 'Drinks & treats'), categoryId(ctx, 'Groceries')]
    expect(ownTreats).not.toBe(treats)
    expect((await call('POST', `/categories/${ownTreats}/merge`, { into: ownGroceries })).body).toEqual({ into: expect.objectContaining({ id: ownGroceries }), transactions: 0, recurring: 0 })
    const summaries = ((await call('GET', '/activity?entity=category')).body.items as Json[]).map((a) => a.summary)
    expect(summaries).toEqual([
      'Merged the category Drinks & treats into Groceries (0 transactions and 2 custom reports)',
      'Turned off the category Dine out and moved its 1 transaction and 1 custom report to Groceries',
    ])
    expect(((await call('GET', '/custom-reports')).body as CustomReport[]).map((r) => r.spec.filter.spending!.only)).toEqual([
      [{ field: 'category', ids: [ownGroceries] }],
      [{ field: 'category', ids: [ownGroceries] }],
    ])
  })
})

describe('custom reports in two ledgers', () => {
  it('are each ledger’s own: names, order, limits, and what their ids mean', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    const [tagA, tagB] = [createTag(a, 'trip'), createTag(b, 'trip')]
    const ra = createCustomReport(a, { name: 'Trips', spec: spending({ only: [{ field: 'tag', ids: [tagA.id] }] }) })
    // The same name in another ledger is fine, and it's first in that ledger's order.
    const rb = createCustomReport(b, { name: 'trips', spec: spending({ only: [{ field: 'tag', ids: [tagB.id] }] }) })
    expect(listCustomReports(a)).toEqual([ra])
    expect(listCustomReports(b)).toEqual([rb])
    expect(rb).toMatchObject({ description: 'Spending: Only #trip', missing: [] })

    // Another ledger's report isn't there, and can't be changed, ordered or deleted from here.
    expect(() => getCustomReport(a, rb.id)).toThrow('Custom report not found')
    expect(() => updateCustomReport(a, rb.id, { name: 'Mine' })).toThrow('Custom report not found')
    expect(() => deleteCustomReport(a, rb.id)).toThrow('Custom report not found')
    expect(() => reorderCustomReports(a, [rb.id])).toThrow(`There's no custom report ${rb.id}`)
    expect(getCustomReport(b, rb.id)).toEqual(rb)

    // Ids of another ledger's tag, account or own category match nothing here: they read as deleted.
    const card = makeAccount(b, 'Visa', 'credit')
    const odd = createCustomReport(a, {
      name: 'Odd',
      spec: spending({ only: [{ field: 'tag', ids: [tagB.id] }, { field: 'account', ids: [card] }] }),
    })
    expect(odd.missing).toEqual([
      { kind: 'tag', id: tagB.id, reason: 'deleted' },
      { kind: 'account', id: card, reason: 'deleted' },
    ])

    // The limit is per ledger.
    for (let i = listCustomReports(b).length; i < CUSTOM_REPORTS_MAX; i++) createCustomReport(b, { name: `Report ${i}`, spec: spending({}) })
    expect(() => createCustomReport(b, { name: 'One more', spec: spending({}) })).toThrow(`You can keep up to ${CUSTOM_REPORTS_MAX} custom reports`)
    expect(createCustomReport(a, { name: 'One more', spec: spending({}) }).name).toBe('One more')
  })

  it('follow a payee to its new key in their own ledger only', async () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    await spend(a, 'Shop')
    const ra = createCustomReport(a, { name: 'Shop', spec: spending({ only: [{ field: 'payee', keys: ['shop'] }] }) })
    const rb = createCustomReport(b, { name: 'Shop', spec: spending({ only: [{ field: 'payee', keys: ['shop'] }] }) })
    carryPayeeRefs(a, [['shop', 'the shop']])
    // A still has transactions keyed shop, so its report keeps that key with the new one.
    expect(getCustomReport(a, ra.id).spec.filter.spending!.only).toEqual([{ field: 'payee', keys: ['shop', 'the shop'] }])
    expect(getCustomReport(b, rb.id)).toEqual(rb)
  })
})
