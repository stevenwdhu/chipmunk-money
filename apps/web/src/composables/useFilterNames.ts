import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { filterRefs, recurringLabel, withSavedNames, type FilterNames, type RefNames, type ReportFilter } from '@chipmunk/shared'
import { useAccounts, useCategories, usePayeeSearch, useRecurring, useTags } from './queries'

/**
 * Names for what filters refer to, to describe them in words (describeFilter and the rest). A
 * category turned off reads "Dining (off)". One that no longer exists goes by the name a saved report
 * kept for it (`saved`, "#moving (deleted)"), or none: the words then say it's deleted.
 */
export function useFilterNames(filters: MaybeRefOrGetter<Array<ReportFilter | null | undefined>>, saved?: MaybeRefOrGetter<RefNames | undefined>) {
  const { byId: categories, groups, labels } = useCategories()
  const tags = useTags()
  const accounts = useAccounts()
  const recurring = useRecurring()
  const payeeKeys = computed(() => [...new Set(toValue(filters).flatMap((f) => [...filterRefs(f).payee]))].sort())
  const payees = usePayeeSearch(
    () => ({ keys: payeeKeys.value, limit: 200 }),
    { enabled: () => payeeKeys.value.length > 0 },
  )
  const groupNames = computed(() => new Map(groups.value.map((g) => [g.id, g.name])))
  const labelNames = computed(() => new Map(labels.value.map((l) => [l.id, l.name])))
  const tagNames = computed(() => new Map((tags.data.value ?? []).map((t) => [t.id, t.name])))
  const payeeNames = computed(() => new Map((payees.data.value ?? []).map((p) => [p.payeeKey, p.payee])))
  const items = computed(() => new Map((recurring.data.value ?? []).map((r) => [r.id, recurringLabel(r)])))
  return computed<FilterNames>(() =>
    withSavedNames(
      {
        category: (id) => {
          const c = categories.value.get(id)
          return c && (c.archived ? `${c.name} (off)` : c.name)
        },
        group: (id) => groupNames.value.get(id),
        label: (id) => labelNames.value.get(id),
        tag: (id) => tagNames.value.get(id),
        payee: (key) => payeeNames.value.get(key),
        account: (id) => accounts.byId.value.get(id)?.name,
        recurring: (id) => items.value.get(id),
      },
      toValue(saved),
    ),
  )
}
