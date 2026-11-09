import { computed } from 'vue'
import { useTransactions } from '@/composables/queries'

/** Payees to suggest while typing one: those of recent transactions (not transfers), each once. */
export function usePayeeOptions() {
  const recent = useTransactions({}, 200)
  return computed(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const page of recent.data.value?.pages ?? []) {
      for (const t of page.items) {
        if (t.transferPairId || seen.has(t.payeeKey)) continue
        seen.add(t.payeeKey)
        out.push(t.payee)
      }
    }
    return out.slice(0, 80)
  })
}
