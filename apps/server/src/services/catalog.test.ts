import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORY_GROUPS, type ApiKeyCreated, type Category, type CategoryList } from '@chipmunk/shared'
import { createApp } from '../app'
import { makeAccount, testStorage } from '../test/helpers'
import { createTransaction, getTransaction } from './transactions'
import { transactionCreateSchema } from '@chipmunk/shared'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

function setup() {
  const storage = testStorage()
  const app = createApp(storage, { trustedHeader: null })
  const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${url}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  const personal = storage.registry.defaultContext()
  const family = storage.registry.context(storage.registry.create({ name: 'Family' }).id)
  const list = async (ledger: string) => (await api('GET', `/ledgers/${ledger}/categories`)).body as CategoryList
  const byName = (l: CategoryList, name: string) => l.categories.find((c) => c.name === name)!
  const spend = (ctx: typeof personal, categoryId: number, payee = 'Shop') =>
    createTransaction(ctx, transactionCreateSchema.parse({ accountId: makeAccount(ctx, `Chq ${payee}`), date: '2026-10-01', amountMinor: -1_000, payee, categoryId }), {
      useAi: false,
    })
  return { storage, api, personal, family, list, byName, spend }
}

describe('the shared category list', () => {
  it('starts from the defaults, and every ledger uses it by the same ids, all on', async () => {
    const { api, list } = setup()
    const shared = (await api('GET', '/categories')).body as CategoryList
    expect(shared.categories.map((c) => c.name).sort()).toEqual(DEFAULT_CATEGORY_GROUPS.flatMap((g) => g.categories.map((c) => c.name)).sort())
    expect(shared.labels.map((l) => l.name)).toEqual(['Needs', 'Wants'])
    for (const ledger of ['personal', 'family']) {
      const l = await list(ledger)
      expect(l.shared).toBe(true)
      expect(l.categories.map((c) => [c.id, c.name, c.labelIds])).toEqual(shared.categories.map((c) => [c.id, c.name, c.labelIds]))
      expect(l.categories.every((c) => !c.archived && c.transactionCount === 0)).toBe(true)
    }
  })

  it('reaches every ledger when it changes', async () => {
    const { api, list, byName, personal, family, spend } = setup()
    const shared = (await api('GET', '/categories')).body as CategoryList
    const fuel = shared.categories.find((c) => c.name === 'Fuel')!
    const transit = shared.categories.find((c) => c.name === 'Transit')!
    const p = await spend(personal, fuel.id, 'Shell')
    const f = await spend(family, fuel.id, 'Esso')

    // Renamed and relabelled everywhere.
    await api('PATCH', `/categories/${fuel.id}`, { name: 'Gas', labelIds: [] })
    for (const ledger of ['personal', 'family']) expect(byName(await list(ledger), 'Gas')).toMatchObject({ id: fuel.id, labelIds: [] })
    // Added everywhere, turned on.
    const pets = (await api('POST', '/categories', { name: 'Pets', groupId: fuel.groupId })).body as Category
    for (const ledger of ['personal', 'family']) expect(byName(await list(ledger), 'Pets')).toMatchObject({ id: pets.id, archived: false })
    // Merged everywhere: the transactions move.
    expect((await api('POST', `/categories/${fuel.id}/merge`, { into: transit.id })).status).toBe(200)
    expect([getTransaction(personal, p.id).categoryId, getTransaction(family, f.id).categoryId]).toEqual([transit.id, transit.id])
    expect((await list('family')).categories.some((c) => c.id === fuel.id)).toBe(false)
    // Deleted everywhere: the transactions become uncategorized.
    expect((await api('DELETE', `/categories/${transit.id}`)).status).toBe(204)
    expect([getTransaction(personal, p.id).categoryId, getTransaction(family, f.id).categoryId]).toEqual([null, null])
    // A ledger made later has it all.
    const later = (await api('POST', '/ledgers', { name: 'Later', start: 'empty' })).body
    expect(byName(await list(later.slug), 'Pets').id).toBe(pets.id)
  })

  it('is turned on and off per ledger, asking where the transactions go', async () => {
    const { api, list, byName, family, spend } = setup()
    const l = await list('family')
    const [phones, internet] = [byName(l, 'Phones'), byName(l, 'Internet')]
    const t = await spend(family, phones.id, 'Fido')

    const asks = await api('PATCH', `/ledgers/family/categories/${phones.id}`, { enabled: false })
    expect(asks.status).toBe(409)
    expect(asks.body.error.message).toMatch(/1 transaction uses Phones/)
    expect((await api('PATCH', `/ledgers/family/categories/${phones.id}`, { enabled: false, moveTo: internet.id })).body).toMatchObject({ archived: true })
    expect(getTransaction(family, t.id).categoryId).toBe(internet.id)
    // Only in that ledger.
    expect(byName(await list('personal'), 'Phones').archived).toBe(false)
    // Back on; then off again, leaving them uncategorized.
    await api('PATCH', `/ledgers/family/categories/${phones.id}`, { enabled: true })
    await api('PATCH', `/ledgers/family/categories/${internet.id}`, { enabled: false, moveTo: null })
    expect(getTransaction(family, t.id).categoryId).toBeNull()
    // It stays off when the shared list changes.
    await api('PATCH', `/categories/${internet.id}`, { name: 'Home internet' })
    expect(byName(await list('family'), 'Home internet').archived).toBe(true)
    // With the shared list, a ledger can't rename or add.
    expect((await api('PATCH', `/ledgers/family/categories/${phones.id}`, { name: 'Cell' })).status).toBe(409)
    expect((await api('POST', '/ledgers/family/categories', { name: 'Cell' })).status).toBe(409)
  })

  it('lets a ledger keep its own list, and join again by name without losing anything', async () => {
    const { api, list, byName, family, spend } = setup()
    const phones = byName(await list('family'), 'Phones')
    const t = await spend(family, phones.id, 'Fido')

    // Its own list: a copy it edits, which the shared list no longer reaches. The copy has its own
    // ids, and its transactions move to them.
    const own = (await api('PUT', '/ledgers/family/categories/sharing', { shared: false })).body as CategoryList
    expect(own.shared).toBe(false)
    const ownPhones = byName(own, 'Phones')
    expect(ownPhones.id).not.toBe(phones.id)
    expect(getTransaction(family, t.id).categoryId).toBe(ownPhones.id)
    expect((await api('PATCH', `/ledgers/family/categories/${phones.id}`, { name: 'Mobile phones' })).status).toBe(404)
    expect((await api('PATCH', `/ledgers/family/categories/${ownPhones.id}`, { name: 'Mobile phones' })).body.name).toBe('Mobile phones')
    const hobby = (await api('POST', '/ledgers/family/categories', { name: 'Hobbies', groupId: ownPhones.groupId })).body as Category
    await api('PATCH', `/categories/${phones.id}`, { name: 'Cellphones' })
    expect(byName(await list('family'), 'Mobile phones').id).toBe(ownPhones.id)
    expect(byName(await list('personal'), 'Cellphones').id).toBe(phones.id)

    // Joining again: matched by name (a former default name counts), and what's new joins the shared list.
    await api('PATCH', `/categories/${phones.id}`, { name: 'Phones' })
    const t2 = await spend(family, hobby.id, 'Lego')
    const joined = (await api('PUT', '/ledgers/family/categories/sharing', { shared: true })).body as CategoryList
    expect(joined.shared).toBe(true)
    expect(getTransaction(family, t.id).categoryId).toBe(phones.id)
    const hobbies = byName(joined, 'Hobbies')
    expect(getTransaction(family, t2.id).categoryId).toBe(hobbies.id)
    expect(byName(await list('personal'), 'Hobbies')).toMatchObject({ id: hobbies.id, archived: false })
  })

  it('asks what happens to each category the shared list doesn’t have when a ledger joins', async () => {
    const { api, list, byName, family, spend } = setup()
    const shared = (await api('GET', '/categories')).body as CategoryList
    const sharedId = (name: string) => shared.categories.find((c) => c.name === name)!.id
    await api('PUT', '/ledgers/family/categories/sharing', { shared: false })
    const own = await list('family')
    const group = byName(own, 'Phones').groupId
    // Four of its own: a renamed one, two new ones, and one to drop.
    await api('PATCH', `/ledgers/family/categories/${byName(own, 'Phones').id}`, { name: 'Cell plan' })
    const make = async (name: string) => ((await api('POST', '/ledgers/family/categories', { name, groupId: group })).body as Category).id
    const [cell, boat, kayak, junk] = [byName(own, 'Phones').id, await make('Boat'), await make('Kayak'), await make('Junk')]
    const tx = await Promise.all([spend(family, cell, 'Fido'), spend(family, boat, 'Marina'), spend(family, kayak, 'MEC'), spend(family, junk, 'Junk')])

    const preview = (await api('GET', '/ledgers/family/categories/sharing')).body
    expect(preview.shared).toBe(false)
    expect(preview.differing.map((d: Json) => [d.name, d.transactionCount])).toEqual([
      ['Cell plan', 1],
      ['Boat', 1],
      ['Kayak', 1],
      ['Junk', 1],
    ])
    // Matching or moving needs a shared category.
    expect((await api('PUT', '/ledgers/family/categories/sharing', { shared: true, resolve: [{ category: cell, action: 'match' }] })).status).toBe(400)

    const joined = (
      await api('PUT', '/ledgers/family/categories/sharing', {
        shared: true,
        resolve: [
          { category: cell, action: 'match', to: sharedId('Phones') },
          { category: boat, action: 'add' },
          { category: kayak, action: 'move', to: sharedId('Sports & fitness') },
          { category: junk, action: 'uncategorize' },
        ],
      })
    ).body as CategoryList
    expect(joined.categories.map((c) => c.name)).not.toEqual(expect.arrayContaining(['Cell plan', 'Kayak', 'Junk']))
    expect(tx.map((t) => getTransaction(family, t.id).categoryId)).toEqual([sharedId('Phones'), byName(joined, 'Boat').id, sharedId('Sports & fitness'), null])
    expect(byName(await list('personal'), 'Boat')).toBeTruthy()
  })

  it('moves a joining ledger’s custom reports to the shared categories, dropping the ones that go', async () => {
    const { api, list, byName } = setup()
    const shared = (await api('GET', '/categories')).body as CategoryList
    const sports = shared.categories.find((c) => c.name === 'Sports & fitness')!.id
    const sharedPhones = shared.categories.find((c) => c.name === 'Phones')!.id
    await api('PUT', '/ledgers/family/categories/sharing', { shared: false })
    const phones = byName(await list('family'), 'Phones')
    const make = async (name: string) => ((await api('POST', '/ledgers/family/categories', { name, groupId: phones.groupId })).body as Category).id
    const [kayak, junk, old] = [await make('Kayak'), await make('Junk'), await make('Old')]
    await api('DELETE', `/ledgers/family/categories/${old}`)
    const spending = {
      only: [{ field: 'category', ids: [phones.id, kayak, junk, old] }],
      filterOut: [{ when: [{ field: 'category', ids: [junk] }] }, { when: [{ field: 'category', ids: [junk, kayak] }, { field: 'amount', min: 5_000 }] }],
    }
    const report = (await api('POST', '/ledgers/family/custom-reports', { name: 'Outdoors', spec: { filter: { spending } } })).body
    const phonesReport = (await api('POST', '/ledgers/family/custom-reports', { name: 'Phones', spec: { filter: { spending: { only: [{ field: 'category', ids: [phones.id] }] } } } })).body

    await api('PUT', '/ledgers/family/categories/sharing', {
      shared: true,
      resolve: [
        { category: kayak, action: 'move', to: sports },
        { category: junk, action: 'uncategorize' },
      ],
    })
    // Its Phones is the shared Phones (by name) and Kayak moved. Junk and the deleted one are gone: their transactions are
    // uncategorized, so Only count takes Uncategorized in their place (not everything), and the rule left with nothing goes.
    expect((await api('GET', `/ledgers/family/custom-reports/${report.id}`)).body).toMatchObject({
      spec: {
        filter: {
          spending: {
            only: [{ field: 'category', ids: [...[sharedPhones, sports].sort((a, b) => a - b), 'none'] }],
            filterOut: [{ when: [{ field: 'category', ids: [sports] }, { field: 'amount', min: 5_000 }] }],
          },
        },
      },
      missing: [],
    })
    // One on a category that kept its name follows it to the shared one, with nothing to tell.
    expect((await api('GET', `/ledgers/family/custom-reports/${phonesReport.id}`)).body).toMatchObject({
      spec: { filter: { spending: { only: [{ field: 'category', ids: [sharedPhones] }] } } },
      missing: [],
    })
    const logged = (await api('GET', '/ledgers/family/activity?entity=custom_report')).body.items
    expect(logged.map((a: Json) => [a.actor, a.summary])).toEqual([
      ['Chipmunk', 'Outdoors filters by Sports & fitness in place of Kayak, Uncategorized in place of Junk and a deleted category, and no longer by Junk'],
      ['web', 'Added the custom report Phones'],
      ['web', 'Added the custom report Outdoors'],
    ])
  })

  it('moves a joining ledger’s custom reports to the shared groups and labels by name, dropping the ones the list doesn’t have', async () => {
    const { api, list } = setup()
    await api('PUT', '/ledgers/family/categories/sharing', { shared: false })
    const before = await list('family')
    // Food and Wants again under new ids, Boats with a category the shared list gets, and Junk and Splurge it won't.
    expect((await api('DELETE', `/ledgers/family/category-groups/${before.groups.find((g) => g.name === 'Food')!.id}`)).status).toBe(204)
    expect((await api('DELETE', `/ledgers/family/labels/${before.labels.find((l) => l.name === 'Wants')!.id}`)).status).toBe(204)
    const make = async (path: string, name: string) => (await api('POST', `/ledgers/family/${path}`, { name })).body.id as number
    const [food, boats, junk, wants, splurge] = [
      await make('category-groups', 'food'),
      await make('category-groups', 'Boats'),
      await make('category-groups', 'Junk'),
      await make('labels', 'WANTS'),
      await make('labels', 'Splurge'),
    ]
    await api('POST', '/ledgers/family/categories', { name: 'Kayak', groupId: boats })
    const spending = {
      only: [
        { field: 'group', ids: [food, boats, junk] },
        { field: 'label', ids: [wants, 'none'] },
      ],
      filterOut: [
        { when: [{ field: 'label', ids: [splurge] }] },
        { when: [{ field: 'group', ids: [junk] }, { field: 'amount', min: 5_000 }] },
        { when: [{ field: 'label', ids: [splurge, wants] }, { field: 'amount', min: 100 }] },
      ],
    }
    const report = (await api('POST', '/ledgers/family/custom-reports', { name: 'Treats', spec: { filter: { spending } } })).body
    const splurging = (await api('POST', '/ledgers/family/custom-reports', { name: 'Splurging', spec: { filter: { spending: { only: [{ field: 'label', ids: [splurge] }] } } } })).body

    await api('PUT', '/ledgers/family/categories/sharing', { shared: true })
    const shared = (await api('GET', '/categories')).body as CategoryList
    const sharedGroup = (name: string) => shared.groups.find((g) => g.name === name)!.id
    const [sharedFood, sharedBoats] = [sharedGroup('Food'), sharedGroup('Boats')]
    const sharedWants = shared.labels.find((l) => l.name === 'Wants')!.id
    // Each id follows its name: the ledger's food is the shared Food, not whatever has its id.
    expect([sharedFood, sharedBoats]).not.toContain(food)
    expect((await api('GET', `/ledgers/family/custom-reports/${report.id}`)).body).toMatchObject({
      spec: {
        filter: {
          spending: {
            only: [
              { field: 'group', ids: [sharedFood, sharedBoats].sort((a, b) => a - b) },
              { field: 'label', ids: [sharedWants, 'none'] },
            ],
            filterOut: [{ when: [{ field: 'label', ids: [sharedWants] }, { field: 'amount', min: 100 }] }],
          },
        },
      },
      description: 'Spending: Only Food and Boats groups · Only the Wants label or no label · Filter out charges of $1 or more with the Wants label',
      missing: [],
    })
    // The names it keeps are the shared ones its ids now point at.
    expect((await api('GET', `/ledgers/family/custom-reports/${report.id}`)).body.spec.names).toMatchObject({
      group: { [sharedFood]: 'Food', [sharedBoats]: 'Boats' },
      label: { [sharedWants]: 'Wants' },
    })
    expect((await api('GET', `/ledgers/family/custom-reports/${splurging.id}`)).body).toMatchObject({ spec: { filter: { v: 1 } }, description: 'Everything' })
    const logged = (await api('GET', '/ledgers/family/activity?entity=custom_report')).body.items
    expect(logged.map((a: Json) => a.summary).slice(0, 2)).toEqual([
      'Splurging no longer filters by the Splurge label',
      'Treats no longer filters by the Junk group or the Splurge label',
    ])
  })

  it('moves a leaving ledger’s custom reports to its copies, keeping ids of deleted categories, and leaves the other ledger’s alone', async () => {
    const { api, list, byName } = setup()
    const shared = (await api('GET', '/categories')).body as CategoryList
    const sharedId = (name: string) => shared.categories.find((c) => c.name === name)!.id
    const group = (name: string) => shared.groups.find((g) => g.name === name)!.id
    const label = (name: string) => shared.labels.find((l) => l.name === name)!.id
    const gone = ((await api('POST', '/categories', { name: 'Gone' })).body as Category).id
    const spending = {
      only: [
        { field: 'category', ids: [sharedId('Phones'), gone] },
        { field: 'group', ids: [group('Food')] },
        { field: 'label', ids: [label('Wants'), 'none'] },
      ],
    }
    const post = async (ledger: string) => (await api('POST', `/ledgers/${ledger}/custom-reports`, { name: 'Mine', spec: { filter: { spending } } })).body
    const [mine, theirs] = [await post('family'), await post('personal')]
    expect([mine.id, theirs.id]).toEqual([expect.any(Number), expect.any(Number)])
    await api('DELETE', `/categories/${gone}`)

    const own = (await api('PUT', '/ledgers/family/categories/sharing', { shared: false })).body as CategoryList
    const ownGroup = own.groups.find((g) => g.name === 'Food')!.id
    const ownLabel = own.labels.find((l) => l.name === 'Wants')!.id
    expect((await api('GET', `/ledgers/family/custom-reports/${mine.id}`)).body.spec.filter.spending.only).toEqual([
      { field: 'category', ids: [byName(own, 'Phones').id, gone].sort((a, b) => a - b) },
      { field: 'group', ids: [ownGroup] },
      { field: 'label', ids: [ownLabel, 'none'] },
    ])
    expect((await api('GET', `/ledgers/personal/custom-reports/${theirs.id}`)).body.spec).toEqual(theirs.spec)
    expect(byName(await list('personal'), 'Phones').id).toBe(sharedId('Phones'))
    // Nothing to tell: every category, group and label is still there, by its name.
    expect((await api('GET', '/ledgers/family/activity?entity=custom_report')).body.items.map((a: Json) => a.actor)).toEqual(['web'])
  })

  it('needs a key for every ledger to change it', async () => {
    const { api, personal } = setup()
    const key = (ledgers?: string[]) =>
      api('POST', '/api-keys', { name: 'k', scopes: ['write'], ...(ledgers ? { ledgers } : {}) }).then((r) => ({ authorization: `Bearer ${(r.body as ApiKeyCreated).key}` }))
    const limited = await key([personal.ledger.id])
    expect((await api('POST', '/categories', { name: 'Pets' }, limited)).status).toBe(403)
    expect((await api('POST', '/categories', { name: 'Pets' }, await key())).status).toBe(201)
  })
})
