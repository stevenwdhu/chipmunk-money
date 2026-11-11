<script setup lang="ts">
import { computed, ref } from 'vue'
import { refDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { Loader2, Plus, Search } from '@lucide/vue'
import { formatMoney, recurringLabel, type RecurringItem, type RecurringPaymentCandidate } from '@chipmunk/shared'
import { ListboxContent, ListboxFilter, ListboxGroup, ListboxGroupLabel, ListboxItem, ListboxRoot } from 'reka-ui'
import InfoTip from '@/components/InfoTip.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAccounts, useCategories, useRecurringMutations, useRecurringPaymentCandidates } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { shortDate } from '@/lib/format'
import { titleOf } from '@/lib/payee'

/**
 * "Add a payment": one the app didn't link to the item, because its amount is its own, like a plan's
 * down payment or its last payment (the remainder). From the payments around the item's dates (its
 * payees' first), or any you search for. It counts as one of its payments and takes its category, and
 * the item's usual amount stays.
 */
const props = defineProps<{ item: RecurringItem }>()

const today = useToday()
const { byId: accounts } = useAccounts()
const { byId: categories } = useCategories()
const m = useRecurringMutations()

const open = ref(false)
const search = ref('')
const q = refDebounced(search, 250)
const candidates = useRecurringPaymentCandidates(() => (open.value ? props.item.id : null), q)
const groups = computed(() => {
  const all = candidates.data.value ?? []
  return [
    { label: 'From its payees', items: all.filter((c) => c.likely) },
    { label: all.some((c) => c.likely) ? 'Other payments' : 'Payments', items: all.filter((c) => !c.likely) },
  ].filter((g) => g.items.length)
})
const isPlan = computed(() => props.item.totalPayments !== null)
const full = computed(() => isPlan.value && props.item.remainingPayments === 0)
const tip = computed(() =>
  full.value
    ? `All ${props.item.totalPayments} payments are paid. You can still add one you counted as paid before your history. To add another, take one off or change how many it has.`
    : 'For a payment the app didn’t link because its amount is its own, like a down payment or a last payment that’s the remainder. It counts as one of its payments, and the usual amount stays.',
)

function details(c: RecurringPaymentCandidate) {
  const t = c.transaction
  return [shortDate(t.date, today.value), accounts.value.get(t.accountId)?.name, t.categoryId ? categories.value.get(t.categoryId)?.name : 'Uncategorized']
    .filter(Boolean)
    .join(' · ')
}

async function choose(c: RecurringPaymentCandidate) {
  // A list item fires even while disabled: one at a time.
  if (m.addPayment.isPending.value) return
  try {
    const updated = await m.addPayment.mutateAsync({ id: props.item.id, transactionId: c.transaction.id })
    const usual = formatMoney(Math.abs(updated.expectedAmountMinor), c.transaction.currency)
    toast.success(`Added to ${recurringLabel(updated)}`, {
      description:
        updated.totalPayments !== null && updated.remainingPayments === 0
          ? `All ${updated.totalPayments} payments are paid. It’s moved to Ended.`
          : `Its usual amount stays ${usual}.`,
    })
    open.value = false
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div class="flex items-center gap-1">
    <Popover v-model:open="open" @update:open="(v) => v && (search = '')">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <Plus class="size-3.5" />Add a payment
        </button>
      </PopoverTrigger>
      <PopoverContent class="w-80 max-w-[calc(100vw-2rem)] p-0" align="start">
        <ListboxRoot class="flex flex-col" highlight-on-hover>
          <div class="flex h-9 items-center gap-2 border-b px-3">
            <Search class="size-4 shrink-0 opacity-50" />
            <ListboxFilter
              v-model="search"
              auto-focus
              placeholder="Search payments"
              class="flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground"
            />
            <Loader2 v-if="candidates.isFetching.value" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          </div>
          <ListboxContent class="max-h-80 overflow-y-auto p-1">
            <p v-if="!groups.length && !candidates.isPending.value" class="px-2 py-6 text-center text-sm text-muted-foreground">
              {{ q ? 'No payment you could add matches.' : 'No payment around its dates to add. Search for older ones.' }}
            </p>
            <ListboxGroup v-for="g in groups" :key="g.label">
              <ListboxGroupLabel class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{{ g.label }}</ListboxGroupLabel>
              <ListboxItem
                v-for="c in g.items"
                :key="c.transaction.id"
                :value="c.transaction.id"
                :disabled="m.addPayment.isPending.value"
                class="grid cursor-default gap-0.5 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                @select="choose(c)"
              >
                <!-- A long name wraps: the amount keeps its place on the right. -->
                <span class="flex items-baseline justify-between gap-3">
                  <span class="min-w-0 break-words">{{ titleOf(c.transaction) }}</span>
                  <span class="shrink-0 tabular-nums">{{ formatMoney(c.transaction.amountMinor, c.transaction.currency) }}</span>
                </span>
                <span class="min-w-0 text-xs break-words text-muted-foreground">{{ details(c) }}</span>
              </ListboxItem>
            </ListboxGroup>
          </ListboxContent>
        </ListboxRoot>
      </PopoverContent>
    </Popover>
    <InfoTip :text="tip" />
  </div>
</template>
