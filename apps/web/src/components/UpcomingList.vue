<script setup lang="ts">
import { recurringLabel, type UpcomingPayment } from '@st/shared'
import MoneyText from '@/components/MoneyText.vue'
import { relativeDay, relativeDayInline } from '@/lib/format'

defineProps<{ items: UpcomingPayment[]; today: string }>()
</script>

<template>
  <ul class="flex flex-col divide-y">
    <li v-for="u in items" :key="`${u.recurringItemId}-${u.dueDate}`" class="flex items-center justify-between gap-3 py-2.5 text-sm">
      <div class="min-w-0">
        <div class="truncate font-medium">{{ recurringLabel(u) }}</div>
        <div class="text-xs" :class="u.overdue ? 'text-warning' : 'text-muted-foreground'">
          {{ u.overdue ? `Expected ${relativeDayInline(u.dueDate, today)} · not seen yet` : relativeDay(u.dueDate, today) }}<template v-if="u.paymentNumber"> · {{ u.paymentNumber }} of {{ u.totalPayments }}</template>
        </div>
      </div>
      <MoneyText :amount="u.amountMinor" />
    </li>
  </ul>
</template>
