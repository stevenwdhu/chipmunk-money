import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addMonths, monthOf, type ISODate, type MonthKey } from '@st/shared'
import { useSettings } from './queries'

function localToday(): ISODate {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "Today" in the app's configured time zone (falls back to the browser's date while loading). */
export function useToday() {
  const settings = useSettings()
  return computed<ISODate>(() => settings.data.value?.today ?? localToday())
}

/** The month being viewed, kept in the URL (?month=2026-09) so it survives reloads and sharing. */
export function useSelectedMonth() {
  const route = useRoute()
  const router = useRouter()
  const today = useToday()
  const current = computed<MonthKey>(() => monthOf(today.value))
  const month = computed<MonthKey>({
    get: () => {
      const q = route.query.month
      return typeof q === 'string' && /^\d{4}-\d{2}$/.test(q) ? q : current.value
    },
    set: (m) => {
      router.replace({ query: { ...route.query, month: m === current.value ? undefined : m } })
    },
  })
  const isCurrent = computed(() => month.value === current.value)
  const shift = (n: number) => {
    const next = addMonths(month.value, n)
    if (next <= current.value) month.value = next
  }
  return { month, current, isCurrent, shift }
}
