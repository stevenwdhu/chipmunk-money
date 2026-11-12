<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRightFromLine } from '@lucide/vue'
import { formatDateLong, type Account, type AccountTransaction, type MoveResult } from '@chipmunk/shared'
import MoneyText from '@/components/MoneyText.vue'
import { Button } from '@/components/ui/button'
import MoveToMenu from './MoveToMenu.vue'

/**
 * A shared account's transaction that another ledger holds, read-only: what it is, and Move to…,
 * which moves it out of the ledger that holds it (here, to edit it).
 */
const props = defineProps<{ account: Account; row: AccountTransaction }>()
const emit = defineEmits<{ moved: [MoveResult] }>()
const title = computed(() => props.row.name ?? props.row.payeeName)
</script>

<template>
  <div class="grid gap-4">
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      <dt class="text-muted-foreground">Amount</dt>
      <dd><MoneyText :amount="row.amountMinor" class="font-medium" /></dd>
      <dt class="text-muted-foreground">Date</dt>
      <dd>{{ formatDateLong(row.date) }}<template v-if="row.status === 'pending'"> · pending</template></dd>
      <template v-if="title !== row.payee">
        <dt class="text-muted-foreground">Payee</dt>
        <dd class="break-words">{{ row.payee }}</dd>
      </template>
      <dt class="text-muted-foreground">Ledger</dt>
      <dd>{{ row.ledger.name }}</dd>
      <dt class="text-muted-foreground">Category</dt>
      <dd>{{ row.category ?? 'Uncategorized' }}</dd>
      <template v-if="row.split">
        <dt class="text-muted-foreground">Split</dt>
        <dd>
          <span v-for="s in row.split.shares" :key="s.ledger.slug" class="block">{{ s.ledger.name }} <MoneyText :amount="s.amountMinor" :colored="false" /></span>
          <span class="block">{{ row.ledger.name }} keeps <MoneyText :amount="row.split.keptMinor" :colored="false" /></span>
        </dd>
      </template>
      <template v-if="row.notes">
        <dt class="text-muted-foreground">Notes</dt>
        <dd class="break-words whitespace-pre-line">{{ row.notes }}</dd>
      </template>
    </dl>
    <MoveToMenu v-slot="{ busy }" :ids="[row.id]" :ledgers="account.sharing?.ledgers ?? []" :from="row.ledger.slug" @moved="emit('moved', $event)">
      <Button type="button" variant="outline" class="justify-self-start" :disabled="busy"><ArrowRightFromLine />Move to…</Button>
    </MoveToMenu>
  </div>
</template>
