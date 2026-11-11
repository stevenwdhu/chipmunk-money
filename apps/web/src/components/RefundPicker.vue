<script setup lang="ts">
import { computed, ref } from 'vue'
import { refDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { Loader2, Search } from '@lucide/vue'
import { formatMoney, type LinkCandidate, type Transaction } from '@chipmunk/shared'
import { ListboxContent, ListboxFilter, ListboxGroup, ListboxGroupLabel, ListboxItem, ListboxRoot } from 'reka-ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAccounts, useCategories, useLinkCandidates, useTransactionMutations } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { shortDate } from '@/lib/format'
import { titleOf } from '@/lib/payee'

/**
 * "Refund of a purchase": money in you link to the purchase it gives money back for, from a list of
 * purchases with something left to refund (the same or a similar payee first), or any you search for.
 * All of it refunds that purchase, even more than it had left (a currency's rate moved, say): it takes
 * the purchase's category and follows it.
 */
const props = defineProps<{ tx: Transaction }>()
const emit = defineEmits<{ linked: [Transaction] }>()

const today = useToday()
const { byId: accounts } = useAccounts()
const { byId: categories } = useCategories()
const m = useTransactionMutations()

const open = ref(false)
const search = ref('')
const q = refDebounced(search, 250)
const candidates = useLinkCandidates(() => (open.value ? props.tx.id : null), 'refund', q)
const groups = computed(() => {
  const all = candidates.data.value ?? []
  return [
    { label: 'Likely', items: all.filter((c) => c.likely) },
    { label: all.some((c) => c.likely) ? 'Other purchases' : 'Purchases', items: all.filter((c) => !c.likely) },
  ].filter((g) => g.items.length)
})

function details(c: LinkCandidate) {
  const t = c.transaction
  return [shortDate(t.date, today.value), accounts.value.get(t.accountId)?.name, t.categoryId ? categories.value.get(t.categoryId)?.name : 'Uncategorized']
    .filter(Boolean)
    .join(' · ')
}

async function choose(c: LinkCandidate) {
  try {
    const updated = await m.setLinks.mutateAsync({ id: props.tx.id, links: [{ transactionId: c.transaction.id, amountMinor: props.tx.amountMinor, kind: 'refund' }] })
    const category = updated.categoryId ? categories.value.get(updated.categoryId)?.name : undefined
    toast.success(`Refund of ${titleOf(c.transaction)}`, {
      description: category ? `It takes its category, ${category}.` : 'It takes its category.',
    })
    open.value = false
    emit('linked', updated)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <Popover v-model:open="open" @update:open="(v) => v && (search = '')">
    <PopoverTrigger as-child>
      <button type="button" class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline">Refund of a purchase</button>
    </PopoverTrigger>
    <PopoverContent class="w-80 max-w-[calc(100vw-2rem)] p-0" align="start">
      <ListboxRoot class="flex flex-col" highlight-on-hover>
        <div class="flex h-9 items-center gap-2 border-b px-3">
          <Search class="size-4 shrink-0 opacity-50" />
          <ListboxFilter
            v-model="search"
            auto-focus
            placeholder="Search purchases"
            class="flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground"
          />
          <Loader2 v-if="candidates.isFetching.value" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        </div>
        <ListboxContent class="max-h-80 overflow-y-auto p-1">
          <p v-if="!groups.length && !candidates.isPending.value" class="px-2 py-6 text-center text-sm text-muted-foreground">
            {{ q ? 'No purchase with something left to refund matches.' : 'No purchase from the last 6 months has something left to refund. Search for older ones.' }}
          </p>
          <ListboxGroup v-for="g in groups" :key="g.label">
            <ListboxGroupLabel class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{{ g.label }}</ListboxGroupLabel>
            <ListboxItem
              v-for="c in g.items"
              :key="c.transaction.id"
              :value="c.transaction.id"
              :disabled="m.setLinks.isPending.value"
              class="grid cursor-default gap-0.5 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              @select="choose(c)"
            >
              <!-- A long name wraps: the amount keeps its place on the right. -->
              <span class="flex items-baseline justify-between gap-3">
                <span class="min-w-0 break-words">{{ titleOf(c.transaction) }}</span>
                <span class="shrink-0 tabular-nums">{{ formatMoney(c.transaction.amountMinor, c.transaction.currency) }}</span>
              </span>
              <span class="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span class="min-w-0 break-words">{{ details(c) }}</span>
                <span v-if="c.leftMinor < -c.transaction.amountMinor" class="shrink-0">{{ formatMoney(c.leftMinor, c.transaction.currency) }} left</span>
              </span>
            </ListboxItem>
          </ListboxGroup>
        </ListboxContent>
      </ListboxRoot>
    </PopoverContent>
  </Popover>
</template>
