import { describe, expect, it } from 'vitest'
import { categoryId, testLedger, testStorage } from '../test/helpers'
import { leaveSharedList } from './catalog'
import { createCatalogLabel, listCatalog } from './catalog-edit'
import { getCategory } from './categories'
import { applyLabel, createLabel, deleteLabel, getLabel, labelIdsByCategory, listLabels, setCategoryLabels, updateLabel } from './labels'

function twins() {
  const storage = testStorage()
  const a = storage.registry.defaultContext()
  const b = testLedger(storage, 'Family')
  return { storage, a, b }
}

describe('labels', () => {
  it('are the shared list’s for a ledger on it, counted over its categories', () => {
    const { storage, a, b } = twins()
    const shared = listCatalog(storage).labels
    for (const ctx of [a, b]) expect(listLabels(ctx)).toEqual(shared)
    const car = createCatalogLabel(storage, { name: 'Car' })
    for (const ctx of [a, b]) expect(getLabel(ctx, car.id)).toEqual({ ...car, categoryCount: 0 })
    expect(() => updateLabel(a, car.id, { name: 'Auto' })).toThrow(/uses the shared category list/)
    expect(() => deleteLabel(a, car.id)).toThrow(/uses the shared category list/)
  })

  it('are a ledger’s own with its own list: unique within it, apart from the others', () => {
    const { storage, a, b } = twins()
    leaveSharedList(a)
    const needs = listLabels(a).find((l) => l.name === 'Needs')!
    expect(listCatalog(storage).labels.some((l) => l.id === needs.id)).toBe(false)
    expect(() => createLabel(a, { name: 'needs' })).toThrow(/already a label called “Needs”/)
    const car = createLabel(a, { name: 'Car' })
    expect(car).toMatchObject({ name: 'Car', categoryCount: 0, sort: 2 })
    // The shared list and the other ledger don't have it, and can have their own of that name.
    expect(listLabels(b).map((l) => l.name)).not.toContain('Car')
    expect(createCatalogLabel(storage, { name: 'Car' }).id).not.toBe(car.id)

    const fuel = categoryId(a, 'Fuel')
    expect(applyLabel(a, car.id, { add: [fuel], remove: [] }).categoryCount).toBe(1)
    expect(getCategory(a, fuel).labelIds).toContain(car.id)
    expect(updateLabel(a, car.id, { name: 'Auto', color: '#123456' })).toMatchObject({ name: 'Auto', color: '#123456', categoryCount: 1 })
    expect(deleteLabel(a, car.id).name).toBe('Auto')
    expect(getCategory(a, fuel).labelIds).not.toContain(car.id)
  })

  it('go only on the ledger’s own categories, from its own labels', () => {
    const { a, b } = twins()
    leaveSharedList(a)
    leaveSharedList(b)
    const [needsA, needsB] = [a, b].map((ctx) => listLabels(ctx).find((l) => l.name === 'Needs')!.id)
    const [fuelA, fuelB] = [categoryId(a, 'Fuel'), categoryId(b, 'Fuel')]
    expect(() => applyLabel(a, needsA!, { add: [fuelB], remove: [] })).toThrow(/categories doesn’t exist/)
    expect(() => applyLabel(a, needsB!, { add: [fuelA], remove: [] })).toThrow(/Label not found/)
    expect(() => setCategoryLabels(a, fuelA, [needsB!])).toThrow(/labels doesn’t exist/)
    setCategoryLabels(a, fuelA, [needsA!])
    expect(labelIdsByCategory(a, fuelA).get(fuelA)).toEqual([needsA])
    expect(labelIdsByCategory(b).has(fuelA)).toBe(false)
    expect(getCategory(b, fuelB).labelIds).not.toContain(needsA)
  })
})
