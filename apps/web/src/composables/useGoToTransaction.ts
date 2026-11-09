import { useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type { Transaction } from '@st/shared'
import { keys } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { lapi } from '@/lib/ledger'

/**
 * Goes to a transaction in the list on screen: scrolled to and flashed, without opening it. False
 * when it isn't listed (filtered out, another account's, or further down than has loaded so far).
 */
export function jumpToTransaction(id: number): boolean {
  const row = [...document.querySelectorAll<HTMLElement>(`[data-tx-id="${id}"]`)].find((el) => el.offsetParent !== null)
  if (!row) return false
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  row.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  row.animate([{ backgroundColor: `color-mix(in oklab, ${primary} 18%, transparent)` }, { backgroundColor: 'transparent' }], {
    duration: 1800,
    delay: still ? 0 : 250,
    easing: 'ease-out',
    fill: 'backwards',
  })
  return true
}

/**
 * Goes to a transaction: in the list on screen when it's there, otherwise on the Transactions page,
 * in its month with no filters, which scrolls to it once it's listed (`?jump=`, see TransactionTable).
 */
export function useGoToTransaction() {
  const router = useRouter()
  const client = useQueryClient()
  return async (id: number) => {
    if (jumpToTransaction(id)) return
    try {
      const tx = await client.fetchQuery({
        queryKey: [...keys.transactions(), 'one', id],
        queryFn: () => lapi.get<Transaction>(`/transactions/${id}`),
        staleTime: 5_000,
      })
      await router.push({ name: 'transactions', query: { month: tx.date.slice(0, 7), jump: String(id) } })
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
}
