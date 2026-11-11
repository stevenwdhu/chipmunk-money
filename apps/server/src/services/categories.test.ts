import { describe, expect, it } from 'vitest'
import { CHART_COLORS, DEFAULT_CATEGORY_GROUPS, transactionCreateSchema, UNGROUPED_COLOR } from '@chipmunk/shared'
import { spendIn } from '../test/category-lists'
import { categoryId, makeAccount, testContext, testLedger, testStorage } from '../test/helpers'
import { leaveSharedList } from './catalog'
import {
  createGroup,
  createTag,
  deleteCategory,
  deleteGroup,
  deleteTag,
  getCategory,
  getGroup,
  getTag,
  listCategories,
  listTags,
  mergeCategory,
  reorder,
  updateCategory,
  updateGroup,
  updateTag,
  upsertTags,
} from './categories'
import { byCategory, trend } from './reports'
import { createTransaction } from './transactions'

describe('colours', () => {
  it('belong to groups; categories show in their group’s colour', async () => {
    const ctx = testContext()
    // Its own list, to edit here.
    leaveSharedList(ctx)
    const food = listCategories(ctx).groups.find((g) => g.name === 'Food')!
    expect(food.color).toBe(DEFAULT_CATEGORY_GROUPS.find((g) => g.name === 'Food')!.color)
    const dineOut = categoryId(ctx, 'Dine out')
    expect(getCategory(ctx, dineOut)).not.toHaveProperty('color')

    const acc = makeAccount(ctx)
    await createTransaction(ctx, transactionCreateSchema.parse({ accountId: acc, date: '2026-09-01', amountMinor: -900, payee: 'Pizza', categoryId: dineOut }), { useAi: false })
    const color = () => byCategory(ctx, '2026-09-01', '2026-09-30').find((c) => c.categoryId === dineOut)?.color
    expect(color()).toBe(food.color)

    // Recolouring the group, or moving the category, changes how it shows.
    updateGroup(ctx, food.id, { color: '#3b82f6' })
    expect(color()).toBe('#3b82f6')
    const pets = createGroup(ctx, { name: 'Pets' })
    expect(listCategories(ctx).groups.filter((g) => g.color === pets.color)).toHaveLength(1)
    updateCategory(ctx, dineOut, { groupId: pets.id })
    expect(color()).toBe(pets.color)
    updateCategory(ctx, dineOut, { groupId: null })
    expect(color()).toBe(UNGROUPED_COLOR)
  })

  it('give charts split by category easy-to-tell-apart colours, largest first', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const add = (name: string, amountMinor: number, categoryId: number | null) =>
      createTransaction(ctx, transactionCreateSchema.parse({ accountId: acc, date: '2026-09-05', amountMinor, payee: name, categoryId }), { useAi: false })
    await add('Loblaws', -9_000, categoryId(ctx, 'Groceries'))
    await add('Pizza', -3_000, categoryId(ctx, 'Dine out'))
    await add('Mystery', -2_000, null)
    await add('Coffee', -1_000, categoryId(ctx, 'Drinks & treats'))

    // Three Food categories, three different colours; uncategorized stays neutral.
    expect(trend(ctx, '2026-09', 1, 'category').series.map((s) => [s.name, s.color])).toEqual([
      ['Groceries', CHART_COLORS[0]],
      ['Dine out', CHART_COLORS[1]],
      ['Uncategorized', UNGROUPED_COLOR],
      ['Drinks & treats', CHART_COLORS[2]],
    ])
    // By group, each group's own colour.
    const food = listCategories(ctx).groups.find((g) => g.name === 'Food')!
    expect(trend(ctx, '2026-09', 1, 'group').series.find((s) => s.name === 'Food')?.color).toBe(food.color)
  })
})

describe('with two ledgers', () => {
  function twins() {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    return { storage, a, b }
  }

  it('keeps each one’s own list to itself', () => {
    const { a, b } = twins()
    leaveSharedList(a)
    leaveSharedList(b)
    const [fuelA, fuelB] = [categoryId(a, 'Fuel'), categoryId(b, 'Fuel')]
    expect(fuelA).not.toBe(fuelB)
    updateCategory(a, fuelA, { name: 'Gas' })
    expect(getCategory(b, fuelB).name).toBe('Fuel')
    // Another ledger's category, group or tag isn't this one's, even by its id.
    expect(() => getCategory(b, fuelA)).toThrow(/Category not found/)
    expect(() => updateCategory(b, fuelA, { name: 'Mine' })).toThrow(/Category not found/)
    expect(() => deleteCategory(b, fuelA)).toThrow(/Category not found/)
    expect(() => mergeCategory(b, fuelB, fuelA)).toThrow(/Category not found/)
    const groupA = getCategory(a, fuelA).groupId!
    expect(() => getGroup(b, groupA)).toThrow(/Group not found/)
    expect(() => updateCategory(b, fuelB, { groupId: groupA })).toThrow(/Group not found/)
    expect(() => deleteGroup(b, groupA)).toThrow(/Group not found/)
    expect(() => reorder(b, 'categories', [fuelA])).toThrow(/Not found/)
    expect(getCategory(a, fuelA).name).toBe('Gas')
    // A group made in one isn't in the other.
    const boats = createGroup(a, { name: 'Boats' })
    expect(listCategories(b).groups.some((g) => g.id === boats.id || g.name === 'Boats')).toBe(false)
  })

  it('reorders each ledger’s accounts and institutions, not another’s', () => {
    const { a, b } = twins()
    const [a1, a2] = [makeAccount(a, 'One'), makeAccount(a, 'Two')]
    const b1 = makeAccount(b, 'One')
    expect(() => reorder(a, 'accounts', [b1])).toThrow(/Not found/)
    reorder(a, 'accounts', [a2, a1])
    expect(a.q.column('SELECT name FROM ledger_accounts WHERE ledger_id = @ledger ORDER BY sort, id')).toEqual(['Two', 'One'])
    expect(b.q.pluck('SELECT sort FROM ledger_accounts WHERE ledger_id = @ledger AND id = @b1', { b1 })).toBe(0)
  })

  it('keeps tags per ledger, by name', () => {
    const { a, b } = twins()
    const [tripA] = upsertTags(a, ['Trip'])
    const [tripB, work] = upsertTags(b, ['#trip', 'Work'])
    expect(tripA).not.toBe(tripB)
    expect(upsertTags(a, ['trip'])).toEqual([tripA])
    expect(listTags(a).map((t) => t.name)).toEqual(['trip'])
    expect(listTags(b).map((t) => t.name)).toEqual(['trip', 'work'])
    expect(() => getTag(a, work!)).toThrow(/Tag not found/)
    expect(() => updateTag(a, tripB!, { color: '#ff0000' })).toThrow(/Tag not found/)
    expect(() => deleteTag(a, tripB!)).toThrow(/Tag not found/)
    expect(createTag(a, 'Trip', '#00ff00')).toEqual({ id: tripA, name: 'trip', color: '#00ff00' })
    expect(getTag(b, tripB!).color).toBeNull()
    deleteTag(b, tripB!)
    expect(getTag(a, tripA!).name).toBe('trip')
  })

  it('counts a tag’s transactions in its own ledger', () => {
    const { a, b } = twins()
    const [tag] = upsertTags(a, ['trip'])
    const t = spendIn(a, null)
    spendIn(b, null)
    a.q.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', t, tag)
    expect(listTags(a)).toEqual([{ id: tag, name: 'trip', color: null, count: 1 }])
    expect(listTags(b)).toEqual([])
  })
})
