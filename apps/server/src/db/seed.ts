import { DEFAULT_CATEGORY_GROUPS, DEFAULT_LABELS } from '@st/shared'
import { categories, categoryGroups, categoryLabels, labels } from './schema'
import type { DB } from './client'

/** Seeds default categories (and their Needs/Wants labels) when the database has none. Safe to call on every boot. */
export function seedDefaults(db: DB) {
  const existing = db.select({ id: categories.id }).from(categories).limit(1).all()
  if (existing.length) return
  db.transaction((tx) => {
    // Labels you already have (say, kept through an erase) are reused rather than duplicated.
    const labelIds = new Map(tx.select({ id: labels.id, name: labels.name }).from(labels).all().map((l) => [l.name.toLowerCase(), l.id]))
    DEFAULT_LABELS.forEach((label, i) => {
      if (labelIds.has(label.name.toLowerCase())) return
      const row = tx.insert(labels).values({ name: label.name, color: label.color, sort: i }).returning().get()
      labelIds.set(label.name.toLowerCase(), row.id)
    })
    DEFAULT_CATEGORY_GROUPS.forEach((group, gi) => {
      const g = tx.insert(categoryGroups).values({ name: group.name, color: group.color, sort: gi }).returning().get()
      group.categories.forEach((cat, ci) => {
        const c = tx
          .insert(categories)
          .values({
            groupId: g.id,
            name: cat.name,
            isIncome: cat.isIncome ?? false,
            excludeFromTotals: cat.excludeFromTotals ?? false,
            sort: ci,
          })
          .returning()
          .get()
        for (const name of cat.labels ?? []) {
          const labelId = labelIds.get(name.toLowerCase())
          if (labelId) tx.insert(categoryLabels).values({ categoryId: c.id, labelId }).run()
        }
      })
    })
  })
}

