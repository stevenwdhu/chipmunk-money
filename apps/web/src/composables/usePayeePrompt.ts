import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { toast } from 'vue-sonner'
import { useCategories, usePayeeChoice, useSetPayeeChoice } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { currentLedger } from '@/lib/ledger'
import { useUiStore } from '@/stores/ui'

/**
 * After you set or accept a transaction's category: what happens to its payee from now on. Asked
 * unless you already chose this (always this category, or always review it yourself). Closing it
 * leaves the payee as it was (asked about each time, or its earlier choice). Shared by the panel at
 * the bottom of the screen and the small popover by a suggestion's ✓.
 */
export function usePayeePrompt() {
  const { payeePrompt: prompt } = storeToRefs(useUiStore())
  const { byId } = useCategories()
  const choice = usePayeeChoice(
    () => prompt.value?.payeeKey ?? null,
    () => prompt.value?.categoryId ?? null,
  )
  const set = useSetPayeeChoice()

  const category = computed(() => (prompt.value ? byId.value.get(prompt.value.categoryId) : undefined))
  const current = computed(() => (choice.data.value?.payeeKey === prompt.value?.payeeKey ? choice.data.value : undefined))
  const currentCategory = computed(() => (current.value?.categoryId ? byId.value.get(current.value.categoryId) : undefined))
  const open = computed(
    () =>
      !!prompt.value &&
      !!category.value &&
      !!current.value &&
      (current.value.mode === 'ask' || (current.value.mode === 'always' && current.value.categoryId !== prompt.value.categoryId)),
  )
  const pending = computed(() => current.value?.pending ?? 0)

  const close = () => (prompt.value = null)
  watch(currentLedger, close)

  async function choose(mode: 'always' | 'review') {
    const p = prompt.value
    const name = category.value?.name ?? 'this category'
    if (!p) return
    close()
    try {
      const r = await set.mutateAsync({ payeeKey: p.payeeKey, mode, ...(mode === 'always' ? { categoryId: p.categoryId } : {}) })
      if (mode === 'always') {
        toast.success(`${p.payee}: always ${name}`, {
          description: r.updated ? `${r.updated} other transaction${r.updated === 1 ? '' : 's'} marked as reviewed` : undefined,
        })
      } else {
        toast.success(`You’ll review ${p.payee} yourself`)
      }
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return { prompt, category, current, currentCategory, open, pending, close, choose, busy: set.isPending }
}
