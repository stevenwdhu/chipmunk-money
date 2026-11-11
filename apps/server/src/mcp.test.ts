import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import type { ApiKeyCreated } from '@chipmunk/shared'
import { createApp } from './app'
import { startDemo } from './services/setup'
import { testStorage } from './test/helpers'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup() {
  const storage = testStorage()
  startDemo(storage.registry.defaultContext())
  const app = createApp(storage, { trustedHeader: null })
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (res.status === 204 ? undefined : await res.json()) as Json
  }
  const key = async (name: string, scopes: string[], ledgers?: string[]) =>
    ((await api('POST', '/api-keys', { name, scopes, ledgers })) as ApiKeyCreated).key
  const connect = async (apiKey: string) => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      fetch: async (url, init) => app.request(String(url), init),
    })
    await client.connect(transport)
    return client
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as Json
    return { text: res.content.map((c: Json) => c.text).join('\n') as string, data: res.structuredContent as Json, isError: !!res.isError }
  }
  return { storage, app, api, key, connect, call }
}

describe('MCP server', () => {
  it('needs an API key', async () => {
    const { app } = await setup()
    const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    const bad = await app.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer cm_nope' }, body: '{}' })
    expect(bad.status).toBe(401)
  })

  it('serves clients on the 2025 protocol too', async () => {
    const { app, key } = await setup()
    const auth = `Bearer ${await key('Legacy agent', ['read'])}`
    const rpc = async (body: object, extra: Record<string, string> = {}) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      // Either a JSON body or a single SSE event.
      return JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as Json
    }
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old-agent', version: '1' } },
    })
    expect(init.result.serverInfo.name).toBe('chipmunk')
    expect(init.result.instructions).toContain('ledger')
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' })
    expect(list.result.tools.map((t: Json) => t.name)).toContain('get_month_summary')
  })

  it('lists only the tools a key may use', async () => {
    const { key, connect } = await setup()
    const names = async (k: string) => (await (await connect(k)).listTools()).tools.map((t) => t.name)
    const read = await names(await key('Reader', ['read']))
    const write = await names(await key('Writer', ['write']))
    const admin = await names(await key('Admin', ['admin']))

    expect(read).toContain('search_transactions')
    expect(read).not.toContain('add_transactions')
    expect(write).toEqual(expect.arrayContaining(['add_transactions', 'set_categories', 'list_review_queue', 'sync_banks']))
    expect(read).not.toContain('sync_banks')
    expect(write).not.toContain('create_ledger')
    expect(admin).toEqual(expect.arrayContaining(['create_ledger', 'archive_ledger']))
    // Destructive admin actions stay in the app.
    for (const hidden of ['erase_ledger', 'restore_backup', 'delete_ledger', 'create_api_key']) expect(admin).not.toContain(hidden)

    const writer = await connect(await key('Writer 2', ['write']))
    expect((await writer.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['monthly-review', 'review-queue'])
    const reader = await connect(await key('Reader 2', ['read']))
    expect((await reader.listPrompts()).prompts.map((p) => p.name)).toEqual(['monthly-review'])
  })

  it('lets an agent work the review queue and add transactions, logged under its name', async () => {
    const { key, connect, call, api } = await setup()
    const agent = await connect(await key('Budget bot', ['write']))

    const queue = await call(agent, 'list_review_queue')
    expect(queue.isError).toBe(false)
    expect(queue.data.suggested.length).toBeGreaterThan(0)
    expect(queue.data.categories.flatMap((g: Json) => g.categories)).toContain('Groceries')
    const [first, ...rest] = queue.data.suggested as Json[]

    // Recategorize one suggestion by name, dry run first.
    const dry = await call(agent, 'set_categories', { assignments: [{ id: first.id, category: 'groceries' }], dryRun: true })
    expect(dry.data).toMatchObject({ dryRun: true, updated: 1 })
    expect((await call(agent, 'get_transaction', { id: first.id })).data.transaction.needsReview).toBe(true)
    const set = await call(agent, 'set_categories', { assignments: [{ id: first.id, category: 'Groceries' }] })
    expect(set.data.changes[0]).toMatchObject({ id: first.id, to: 'Groceries' })
    expect(set.text).toContain('→ Groceries')

    if (rest.length) {
      const accepted = await call(agent, 'accept_suggestions', { ids: rest.map((t) => t.id) })
      expect(accepted.data.accepted).toBe(rest.length)
    }
    expect((await call(agent, 'list_review_queue')).data.suggested).toHaveLength(0)

    // Add transactions by account name, with dollars; the externalId makes a retry harmless.
    const accounts = (await call(agent, 'list_accounts')).data.accounts as Json[]
    const card = accounts.find((a) => a.type === 'credit')
    const batch = {
      transactions: [
        { account: card.name, date: '2026-10-03', amount: -18.5, payee: 'Farmers market', category: 'Groceries', externalId: 'rcpt-1' },
        { account: card.id, amount: -4.25, payee: 'Bus fare', externalId: 'rcpt-2', tags: ['commute'] },
      ],
    }
    const added = await call(agent, 'add_transactions', batch)
    expect(added.data.added.map((t: Json) => [t.payee, t.amountMinor, t.amount, t.category])).toEqual([
      ['Farmers market', -1850, '-$18.50', 'Groceries'],
      ['Bus fare', -425, '-$4.25', null], // a new payee with no history stays uncategorized
    ])
    expect(added.data.added[1]).toMatchObject({ date: '2026-10-03', tags: ['commute'] })
    const again = await call(agent, 'add_transactions', batch)
    expect(again.data).toMatchObject({ added: [], alreadyThere: [expect.anything(), expect.anything()] })

    expect((await call(agent, 'sync_banks')).text).toMatch(/No bank accounts are set up/)

    // Accounts go under an institution, by name.
    const visa = await call(agent, 'create_account', { name: 'Visa', type: 'credit', institution: 'american express' })
    expect(visa.data.account.institution).toBe('American Express')
    expect((await call(agent, 'rename_institution', { institution: 'american', newName: 'Amex' })).text).toBe('Renamed American Express to Amex.')
    expect((await call(agent, 'list_accounts')).text).toContain('Visa at Amex (credit)')

    // Mistakes come back as tool errors the agent can act on.
    const wrong = await call(agent, 'set_categories', { assignments: [{ id: first.id, category: 'Snacks' }] })
    expect(wrong.isError).toBe(true)
    expect(wrong.text).toMatch(/no category called “Snacks”.*Groceries/)

    const activity = (await api('GET', '/ledgers/personal/activity?actor=Budget%20bot&limit=200')).items as Json[]
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(['bulk_update', 'create']))
    expect(activity.filter((a) => a.action === 'create' && a.entity === 'transaction').map((a) => a.summary)).toEqual([
      'Added Bus fare -$4.25 on 2026-10-03',
      'Added Farmers market -$18.50 on 2026-10-03',
    ])
  })

  it('answers questions with summaries and reports', async () => {
    const { key, connect, call } = await setup()
    const agent = await connect(await key('Reader', ['read']))
    const summary = await call(agent, 'get_month_summary', { month: '2026-09' })
    expect(summary.data).toMatchObject({ ledger: 'personal', month: '2026-09' })
    expect(summary.data.spent.formatted).toMatch(/^\$[\d,]+\.\d\d$/)
    expect(summary.text).toContain('2026-09: spent $')

    const found = await call(agent, 'search_transactions', { query: 'netflix', limit: 3 })
    expect(found.data.transactions.length).toBeGreaterThan(0)
    expect(found.data.transactions.every((t: Json) => /netflix/i.test(t.payee))).toBe(true)

    for (const [name, args] of [
      ['get_net_worth', {}],
      ['spending_by_category', { from: '2026-09-01', to: '2026-09-30' }],
      ['spending_trend', { months: 3 }],
      ['top_payees', { limit: 5 }],
      ['income_vs_spending', { months: 3 }],
      ['list_recurring', {}],
      ['upcoming_payments', {}],
      ['list_categories', {}],
      ['list_tags', {}],
      ['list_ledgers', {}],
    ] as const) {
      const r = await call(agent, name, args)
      expect(r.isError, `${name}: ${r.text}`).toBe(false)
      expect(r.text.length, name).toBeGreaterThan(0)
    }

    const resources = (await agent.listResources()).resources.map((r) => r.uri)
    expect(resources).toEqual(expect.arrayContaining(['ledger://personal/categories', 'ledger://personal/accounts']))
    const cats = await agent.readResource({ uri: 'ledger://personal/categories' })
    expect(JSON.parse((cats.contents[0] as Json).text).groups.length).toBeGreaterThan(3)

    const prompt = await agent.getPrompt({ name: 'monthly-review', arguments: { month: '2026-09' } })
    expect((prompt.messages[0]!.content as Json).text).toContain('get_month_summary')
    expect((prompt.messages[0]!.content as Json).text).toContain('get_report')
  })

  it('runs a saved report, or one with its own filter', async () => {
    const { key, connect, call } = await setup()
    const agent = await connect(await key('Reader', ['read']))
    const listed = await call(agent, 'list_custom_reports', {})
    expect(listed.data.reports).toEqual([expect.objectContaining({ name: 'Everyday spending', range: 'Last 12 months', warnings: [] })])
    expect(listed.text).toContain('Everyday spending: Spending: Filter out #trip-japan · Filter out one-time charges of $1,000 or more')

    const everything = await call(agent, 'get_report', {})
    const everyday = await call(agent, 'get_report', { report: 'everyday spending' })
    expect(everyday.isError, everyday.text).toBe(false)
    expect(everyday.data).toMatchObject({ report: 'Everyday spending', range: 'Last 12 months', warnings: [] })
    expect(everyday.data.spent.minor + everyday.data.filteredOut.spent.minor).toBe(everything.data.spent.minor)
    expect(everyday.data.filteredOut.biggest[0].why.length).toBeGreaterThan(0)
    expect(everyday.text).toMatch(/^Everyday spending, Last 12 months \(.+\): spent \$/)

    // Its own conditions, added to the report's.
    const lessGroceries = await call(agent, 'get_report', { report: 'Everyday spending', spending: { filterOut: [{ categories: ['Groceries'] }] }, range: '3m', compare: 'last-year' })
    expect(lessGroceries.data.filter).toContain('Filter out Groceries')
    expect(lessGroceries.data.comparison).toMatchObject({ range: expect.stringContaining('–') })
    const onlyNetflix = await call(agent, 'get_report', { spending: { only: { payees: ['Netflix'] } } })
    expect(onlyNetflix.isError, onlyNetflix.text).toBe(false)
    expect(onlyNetflix.data.spent.minor).toBeGreaterThan(0)

    // By a category's group and labels: Food without its wants is the groceries.
    const groceries = await call(agent, 'get_report', { spending: { only: { categories: ['Groceries'] } } })
    const food = await call(agent, 'get_report', { spending: { only: { groups: ['food'] }, filterOut: [{ labels: ['Wants'] }] } })
    expect(food.isError, food.text).toBe(false)
    expect(food.data).toMatchObject({ filter: 'Spending: Only the Food group · Filter out the Wants label', spent: groceries.data.spent })
    const unlabelled = await call(agent, 'get_report', { spending: { only: { labels: ['none'] }, filterOut: [{ groups: ['Food', 'none'], atLeast: 100 }] } })
    expect(unlabelled.data.filter).toBe('Spending: Only charges with no label · Filter out charges of $100 or more in the Food group or no group')

    for (const [args, says] of [
      [{ report: 'Nope' }, 'no custom report “Nope”'],
      [{ spending: { only: { tags: ['nope'] } } }, 'no tag “nope”'],
      [{ spending: { only: { groups: ['Nope'] } } }, 'no category group called “Nope”'],
      [{ spending: { filterOut: [{ labels: ['Nope'] }] } }, 'no label called “Nope”'],
      [{ spending: { only: { payees: ['No such payee'] } } }, 'no payee called'],
      [{ range: 'forever' }, "isn't a range"],
    ] as const) {
      const r = await call(agent, 'get_report', args)
      expect(r.isError).toBe(true)
      expect(r.text).toContain(says)
    }

    // The other report tools and search take a report too.
    const all = await call(agent, 'spending_by_category', { from: '2026-01-01', to: '2026-10-31' })
    const some = await call(agent, 'spending_by_category', { from: '2026-01-01', to: '2026-10-31', report: 'Everyday spending' })
    expect(some.data.total.minor).toBeLessThan(all.data.total.minor)
    for (const name of ['spending_trend', 'top_payees', 'income_vs_spending']) {
      const r = await call(agent, name, { report: 'Everyday spending', spending: { filterOut: [{ categories: ['Groceries'] }] } })
      expect(r.isError, `${name}: ${r.text}`).toBe(false)
    }
    const trip = await call(agent, 'search_transactions', { report: 'Everyday spending', filteredOut: true, query: 'japan', limit: 5 })
    expect(trip.isError, trip.text).toBe(false)
  })

  it('saves, changes and deletes a custom report', async () => {
    const { key, connect, call } = await setup()
    const agent = await connect(await key('Writer', ['read', 'write']))
    const saved = await call(agent, 'save_custom_report', { name: 'No groceries', report: 'Everyday spending', spending: { filterOut: [{ categories: ['Groceries'] }] }, range: '6m' })
    expect(saved.isError, saved.text).toBe(false)
    expect(saved.data).toMatchObject({ name: 'No groceries', created: true })
    expect(saved.data.filter).toContain('Filter out #trip-japan')
    expect(saved.data.filter).toContain('Filter out Groceries')
    expect((await call(agent, 'save_custom_report', { name: 'no groceries' })).text).toContain('already a report called “No groceries”')
    const changed = await call(agent, 'save_custom_report', { name: 'No groceries', replace: true, spending: { only: { categories: ['Groceries'] } } })
    expect(changed.data).toMatchObject({ created: false, filter: 'Spending: Only Groceries' })
    expect((await call(agent, 'get_report', { report: 'No groceries' })).data.range).toBe('Last 6 months')
    expect((await call(agent, 'delete_custom_report', { report: 'No groceries' })).text).toContain('Deleted the custom report No groceries')
    expect((await call(agent, 'list_custom_reports', {})).data.reports.map((r: Json) => r.name)).toEqual(['Everyday spending'])
  })

  it('keeps a key to its ledgers and uses its ledger by default', async () => {
    const { key, connect, call, api } = await setup()
    await api('POST', '/ledgers', { name: 'Family', start: 'empty' })
    const agent = await connect(await key('Family bot', ['write'], ['family']))

    const ledgers = await call(agent, 'list_ledgers')
    expect(ledgers.data.ledgers.map((l: Json) => l.slug)).toEqual(['family'])
    expect((await call(agent, 'list_accounts')).data.ledger).toBe('family')
    const other = await call(agent, 'list_accounts', { ledger: 'personal' })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('Family (family)')
  })

  it('previews an import before committing it', async () => {
    const { key, connect, call } = await setup()
    const agent = await connect(await key('Importer', ['write']))
    const rows = [
      { date: '2026-10-02', payee: 'NEW CAFE 123', amount: -6.5, externalId: 'x1' },
      { date: '2026-10-02', payee: 'ANOTHER SHOP', amount: -20, externalId: 'x2' },
    ]
    const preview = await call(agent, 'import_transactions', { account: 'TD Chequing', rows })
    expect(preview.data).toMatchObject({ committed: false, newRows: 2, duplicates: 0 })
    expect(preview.text).toContain('confirm: true')
    const done = await call(agent, 'import_transactions', { account: 'TD Chequing', rows, confirm: true })
    expect(done.data).toMatchObject({ committed: true, newRows: 2 })
    const again = await call(agent, 'import_transactions', { account: 'TD Chequing', rows, confirm: true })
    expect(again.data).toMatchObject({ committed: true, newRows: 0, duplicates: 2 })
  })
})
