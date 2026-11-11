import { describe, expect, it } from 'vitest'
import { categoryOf, learnedOf, learnIn, spendIn } from '../test/category-lists'
import { testLedger, testStorage } from '../test/helpers'
import { joinSharedList, leaveSharedList, usesSharedList } from './catalog'
import {
  applyCatalogLabel,
  catalogUsage,
  createCatalogCategory,
  createCatalogLabel,
  deleteCatalogCategory,
  deleteCatalogGroup,
  getCatalogCategory,
  listCatalog,
  mergeCatalogCategory,
  reorderCatalog,
  updateCatalogCategory,
} from './catalog-edit'
import { createCategory, getCategory, listCategories, setCategoryEnabled, updateCategory } from './categories'
import type { AppContext } from './context'
import { createLabel, listLabels } from './labels'

/** Two ledgers on the shared list, with a category each in use. */
function twins() {
  const storage = testStorage()
  const a = storage.registry.defaultContext()
  const b = testLedger(storage, 'Family')
  const shared = listCatalog(storage)
  const id = (name: string) => shared.categories.find((c) => c.name === name)!.id
  return { storage, a, b, shared, id }
}

const names = (ctx: AppContext) => listCategories(ctx).categories.map((c) => c.name)
const byName = (ctx: AppContext, name: string) => listCategories(ctx).categories.find((c) => c.name === name)

describe('the shared list, with two ledgers', () => {
  it('is one set of rows: each change is seen by every ledger on it at once, by the same id', () => {
    const { storage, a, b, id } = twins()
    const pets = createCatalogCategory(storage, { name: 'Pets', groupId: getCatalogCategory(storage, id('Fuel')).groupId })
    for (const ctx of [a, b]) expect(byName(ctx, 'Pets')).toMatchObject({ id: pets.id, archived: false })
    updateCatalogCategory(storage, pets.id, { name: 'Animals' })
    for (const ctx of [a, b]) expect(byName(ctx, 'Animals')?.id).toBe(pets.id)
    // One row, not a copy per ledger.
    expect(storage.allLedgers('the shared category list', (db) => db.pluck("SELECT count(*) FROM categories WHERE name = 'Animals'"))).toBe(1)
  })

  it('is turned off in one ledger without changing the other', () => {
    const { a, b, id } = twins()
    setCategoryEnabled(a, id('Phones'), { enabled: false })
    expect(byName(a, 'Phones')?.archived).toBe(true)
    expect(byName(b, 'Phones')?.archived).toBe(false)
    setCategoryEnabled(a, id('Phones'), { enabled: true })
    expect(byName(a, 'Phones')?.archived).toBe(false)
  })

  it('counts its use across the ledgers that share it, or only the ones a key can use', () => {
    const { storage, a, b, id } = twins()
    spendIn(a, id('Fuel'))
    spendIn(b, id('Fuel'))
    spendIn(b, id('Fuel'), 'Gone', { deleted: true })
    expect(catalogUsage(storage).get(id('Fuel'))).toBe(2)
    expect(catalogUsage(storage, (l) => l === b.ledger.id).get(id('Fuel'))).toBe(1)
    // A ledger counts its own.
    expect(byName(a, 'Fuel')?.transactionCount).toBe(1)
  })

  it('deletes a category from every ledger: its transactions are uncategorized, no longer by a rule or to review', () => {
    const { storage, a, b, id } = twins()
    const [ta, tb] = [spendIn(a, id('Fuel')), spendIn(b, id('Fuel'))]
    learnIn(b, id('Fuel'))
    deleteCatalogCategory(storage, id('Fuel'))
    for (const [ctx, t] of [
      [a, ta],
      [b, tb],
    ] as const) {
      expect(categoryOf(ctx, t)).toEqual({ categoryId: null, source: null, confidence: null, needsReview: 0 })
      expect(names(ctx)).not.toContain('Fuel')
    }
    expect(learnedOf(b)).toEqual({ recurring: [null], rule: [], stats: [] })
  })

  it('deletes a group with its categories from every ledger', () => {
    const { storage, a, b, id } = twins()
    const group = getCatalogCategory(storage, id('Fuel')).groupId!
    const t = spendIn(b, id('Fuel'))
    const removed = deleteCatalogGroup(storage, group)
    expect(removed.map((c) => c.name)).toContain('Fuel')
    expect(categoryOf(b, t).categoryId).toBeNull()
    for (const ctx of [a, b]) expect(listCategories(ctx).groups.some((g) => g.id === group)).toBe(false)
  })

  it('merges a category in every ledger, turning the other on where it was on', () => {
    const { storage, a, b, id } = twins()
    const [fuel, transit] = [id('Fuel'), id('Transit')]
    const [ta, tb] = [spendIn(a, fuel), spendIn(b, fuel)]
    learnIn(a, fuel)
    learnIn(a, transit, 'bus')
    // Transit is off in both; Fuel is off in B only.
    setCategoryEnabled(a, transit, { enabled: false })
    setCategoryEnabled(b, transit, { enabled: false })
    setCategoryEnabled(b, fuel, { enabled: false, moveTo: null })
    expect(categoryOf(b, tb).categoryId).toBeNull()

    const result = mergeCatalogCategory(storage, fuel, transit)
    expect(result).toMatchObject({ transactions: 1, recurring: 1, into: { id: transit } })
    expect(categoryOf(a, ta).categoryId).toBe(transit)
    expect(learnedOf(a)).toMatchObject({ recurring: [transit], rule: [transit], stats: [{ categoryId: transit, count: 2 }] })
    expect(byName(a, 'Transit')?.archived).toBe(false)
    expect(byName(b, 'Transit')?.archived).toBe(true)
    for (const ctx of [a, b]) expect(names(ctx)).not.toContain('Fuel')
  })

  it('reorders and labels only the shared list', () => {
    const { storage, a, b, id } = twins()
    leaveSharedList(b)
    const own = byName(b, 'Fuel')!
    expect(() => reorderCatalog(storage, 'categories', [own.id])).toThrow(/Not found/)
    reorderCatalog(storage, 'categories', [id('Transit'), id('Fuel')])
    expect(listCategories(a).categories.slice(0, 2).map((c) => c.name)).toEqual(['Transit', 'Fuel'])
    expect(listCategories(b).categories[0]!.name).not.toBe('Transit')

    const label = createCatalogLabel(storage, { name: 'Car' })
    expect(() => applyCatalogLabel(storage, label.id, { add: [own.id], remove: [] })).toThrow(/No such category/)
    expect(applyCatalogLabel(storage, label.id, { add: [id('Fuel')], remove: [] }).categoryCount).toBe(1)
    expect(getCategory(a, id('Fuel')).labelIds).toContain(label.id)
    expect(listLabels(b).some((l) => l.id === label.id)).toBe(false)
  })
})

describe('leaving the shared list', () => {
  it('copies it under new ids, with what the ledger turned off archived, and moves what used it', () => {
    const { storage, a, b, shared, id } = twins()
    const [fuel, phones] = [id('Fuel'), id('Phones')]
    const t = spendIn(a, fuel)
    const gone = spendIn(a, fuel, 'Old', { deleted: true })
    learnIn(a, fuel)
    const tb = spendIn(b, fuel)
    setCategoryEnabled(a, phones, { enabled: false })

    leaveSharedList(a)
    expect(usesSharedList(a)).toBe(false)
    const own = listCategories(a)
    expect(own.categories.map((c) => c.name)).toEqual(shared.categories.map((c) => c.name))
    expect(own.categories.some((c) => shared.categories.some((s) => s.id === c.id))).toBe(false)
    expect(own.groups.map((g) => g.name)).toEqual(shared.groups.map((g) => g.name))
    expect(own.labels.map((l) => l.name)).toEqual(shared.labels.map((l) => l.name))
    // Labels follow, by the copies' ids.
    const ownFuel = own.categories.find((c) => c.name === 'Fuel')!
    expect(ownFuel.labelIds.map((l) => own.labels.find((x) => x.id === l)!.name)).toEqual(
      getCatalogCategory(storage, fuel).labelIds.map((l) => shared.labels.find((x) => x.id === l)!.name),
    )
    expect(own.categories.find((c) => c.name === 'Phones')!.archived).toBe(true)
    const sharedGroup = (c: number) => shared.groups.find((g) => g.id === getCatalogCategory(storage, c).groupId)!.name
    expect(own.groups.find((g) => g.id === ownFuel.groupId)?.name).toBe(sharedGroup(fuel))
    for (const x of [t, gone]) expect(categoryOf(a, x).categoryId).toBe(ownFuel.id)
    expect(learnedOf(a)).toMatchObject({ recurring: [ownFuel.id], rule: [ownFuel.id], stats: [{ categoryId: ownFuel.id, count: 2 }] })

    // The other ledger and the shared list are as they were.
    expect(categoryOf(b, tb).categoryId).toBe(fuel)
    expect(listCatalog(storage)).toEqual(shared)
    expect(listCategories(b).categories.map((c) => c.id)).toEqual(shared.categories.map((c) => c.id))
    // The shared list no longer reaches it, and its own edits don't reach the others.
    updateCatalogCategory(storage, fuel, { name: 'Gas' })
    expect(byName(a, 'Fuel')?.id).toBe(ownFuel.id)
    updateCategory(a, ownFuel.id, { name: 'Petrol' })
    expect(byName(b, 'Gas')?.id).toBe(fuel)
    expect(names(b)).not.toContain('Petrol')
  })
})

describe('joining the shared list', () => {
  it('matches by name, adds what the list lacks for every ledger, and its own rows go', () => {
    const { storage, a, b, id } = twins()
    leaveSharedList(a)
    const own = (name: string) => byName(a, name)!.id
    updateCategory(a, own('Phones'), { name: 'Mobile phones' })
    const boat = createCategory(a, { name: 'Boat', groupId: getCategory(a, own('Fuel')).groupId })
    const junk = createCategory(a, { name: 'Junk' })
    const lego = createLabel(a, { name: 'Lego' })
    updateCategory(a, boat.id, { labelIds: [lego.id] })
    updateCategory(a, own('Fuel'), { archived: true })
    const [tPhone, tBoat, tJunk, tFuel] = [spendIn(a, own('Mobile phones')), spendIn(a, boat.id), spendIn(a, junk.id), spendIn(a, own('Fuel'))]
    learnIn(a, junk.id)

    joinSharedList(storage, a, new Map([[junk.id, null]]))

    expect(usesSharedList(a)).toBe(true)
    const sharedBoat = byName(b, 'Boat')!
    expect(sharedBoat.archived).toBe(false)
    expect(listCatalog(storage).labels.find((l) => l.name === 'Lego')?.id).toBe(sharedBoat.labelIds[0])
    expect(categoryOf(a, tPhone).categoryId).toBe(id('Phones'))
    expect(categoryOf(a, tBoat).categoryId).toBe(sharedBoat.id)
    expect(categoryOf(a, tJunk)).toEqual({ categoryId: null, source: null, confidence: null, needsReview: 0 })
    expect(learnedOf(a)).toEqual({ recurring: [null], rule: [], stats: [] })
    expect(categoryOf(a, tFuel).categoryId).toBe(id('Fuel'))
    // What it had off stays off, for it only.
    expect(byName(a, 'Fuel')?.archived).toBe(true)
    expect(byName(b, 'Fuel')?.archived).toBe(false)
    // Its own list is gone: it sees exactly the shared one.
    expect(listCategories(a).categories.map((c) => c.id)).toEqual(listCatalog(storage).categories.map((c) => c.id))
    const left = a.q.pluck('SELECT count(*) FROM categories WHERE ledger_id = @ledger')
    expect(left).toBe(0)
  })

  it('refuses a resolution to a category the shared list doesn’t have, changing nothing', () => {
    const { storage, a } = twins()
    leaveSharedList(a)
    const phones = byName(a, 'Phones')!.id
    expect(() => joinSharedList(storage, a, new Map([[phones, phones]]))).toThrow(/shared list has no category/)
    expect(usesSharedList(a)).toBe(false)
    expect(byName(a, 'Phones')?.id).toBe(phones)
  })
})

describe('a ledger on the shared list', () => {
  it('can’t edit the list itself, only turn categories on and off', () => {
    const { a, id } = twins()
    expect(() => updateCategory(a, id('Fuel'), { name: 'Gas' })).toThrow(/uses the shared category list/)
    expect(() => createCategory(a, { name: 'Gas' })).toThrow(/uses the shared category list/)
    expect(() => createLabel(a, { name: 'Car' })).toThrow(/uses the shared category list/)
  })
})
