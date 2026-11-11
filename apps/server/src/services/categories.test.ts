import { describe, expect, it } from 'vitest'
import { CHART_COLORS, DEFAULT_CATEGORY_GROUPS, transactionCreateSchema, UNGROUPED_COLOR } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import { createGroup, getCategory, listCategories, updateCategory, updateGroup } from './categories'
import { byCategory, trend } from './reports'
import { createTransaction } from './transactions'

describe('colours', () => {
  it('belong to groups; categories show in their group’s colour', async () => {
    const ctx = testContext()
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
