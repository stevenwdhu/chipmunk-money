import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { filterRefs } from '@chipmunk/shared'
import { useCustomReports } from './queries'

/**
 * Your custom reports whose filter uses a category, group, label, tag, account or recurring item: a warning to show
 * before deleting it ("Regular spending filters by it…"), or '' when none does.
 */
export function useReportsUsing(kind: 'category' | 'group' | 'label' | 'tag' | 'account' | 'recurring', id: MaybeRefOrGetter<number | null | undefined>) {
  const reports = useCustomReports()
  return computed(() => {
    const i = toValue(id)
    const names = i == null ? [] : (reports.data.value ?? []).filter((r) => filterRefs(r.spec.filter)[kind].has(i)).map((r) => r.name)
    if (!names.length) return ''
    const which = names.length === 1 ? `Your report ${names[0]} filters` : `Your reports ${names.slice(0, -1).join(', ')} and ${names.at(-1)} filter`
    return `${which} by it. Once it’s gone, that part of the filter matches nothing.`
  })
}
