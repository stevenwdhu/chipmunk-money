<script setup lang="ts">
import { computed } from 'vue'
import { Loader2 } from '@lucide/vue'
import type { RecurringItem } from '@chipmunk/shared'
import MoneyText from '@/components/MoneyText.vue'
import RecurringPaymentPicker from '@/components/RecurringPaymentPicker.vue'
import { useAccounts, useRecurringPayments } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { shortDate } from '@/lib/format'
import { useUiStore } from '@/stores/ui'

/**
 * A recurring item's payments, newest first, as its row or card unfolds on the Recurring page; a suggestion's are the
 * ones the scan found. In a row, it lines up with it: dates under its name, amounts under its amount (left of the
 * row's edit button). Under them, a link to add one the app didn't link, at its own amount.
 */
const props = defineProps<{ item: RecurringItem; card?: boolean }>()
const ui = useUiStore()
const today = useToday()
const { byId: accounts } = useAccounts()
// Six show at a time; the rest scroll.
const list = useRecurringPayments(() => props.item.id)
const payments = computed(() => list.data.value ?? [])
// A plan's payments are numbered: the newest is the last one paid.
const number = (i: number) => (props.item.totalPayments ? `${props.item.paidPayments - i} of ${props.item.totalPayments}` : null)
const LINE = computed(() => ['flex w-full items-center gap-3 py-1.5 text-left text-sm', props.card ? 'px-4' : 'pr-14 pl-11 md:pr-16 md:pl-13'])
</script>

<template>
  <div class="border-t bg-muted/40 py-1.5">
    <div v-if="list.isLoading.value" :class="[LINE, 'text-muted-foreground']"><Loader2 class="size-3.5 animate-spin" />Loading…</div>
    <p v-else-if="!payments.length" :class="[LINE, 'text-muted-foreground']">
      {{ item.status === 'suggested' ? 'No payments found.' : 'No payments linked yet. New ones are linked as they come in.' }}
    </p>
    <!-- 6 lines of 32px. -->
    <div v-else class="max-h-48 overflow-y-auto overscroll-contain">
      <button v-for="(tx, i) in payments" :key="tx.id" type="button" :class="[LINE, 'hover:bg-muted']" @click="ui.openEdit(tx)">
        <span class="min-w-0 flex-1 truncate">
          <span class="tabular">{{ shortDate(tx.date, today) }}</span>
          <span class="text-muted-foreground">
            <template v-if="number(i)"> · {{ number(i) }}</template>
            <!-- The row already names the item's account. -->
            <template v-if="tx.accountId !== item.accountId && accounts.get(tx.accountId)"> · {{ accounts.get(tx.accountId)?.name }}</template>
          </span>
        </span>
        <MoneyText :amount="tx.amountMinor" />
      </button>
    </div>
    <!-- One the app didn't link, at its own amount (a plan's down payment, say). -->
    <div v-if="item.status === 'active' || item.status === 'ended'" :class="[LINE, 'py-1']">
      <RecurringPaymentPicker :item="item" />
    </div>
  </div>
</template>
