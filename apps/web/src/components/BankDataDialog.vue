<script setup lang="ts">
import { computed } from 'vue'
import { Loader2 } from '@lucide/vue'
import { BANK_PROVIDER_LABELS, type Transaction } from '@st/shared'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useBankData, useSettings } from '@/composables/queries'
import { dateTime } from '@/lib/format'

/** What its current sync service last sent for a transaction, exactly as sent. */
const props = defineProps<{ tx: Transaction }>()
const open = defineModel<boolean>('open', { default: false })
const data = useBankData(() => (open.value ? props.tx.id : null))
const settings = useSettings()
const tz = computed(() => settings.data.value?.effectiveTimezone)
const EVENTS = { added: 'Sent as new', changed: 'Sent again, changed', removed: 'Removed' } as const
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Raw data</DialogTitle>
        <DialogDescription>{{ tx.payee }}, exactly as its sync service last sent it.</DialogDescription>
      </DialogHeader>
      <div v-if="data.isLoading.value" class="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 class="size-4 animate-spin" />Loading…</div>
      <p v-else-if="!data.data.value" class="py-2 text-sm text-muted-foreground">
        Nothing kept for this one. The bank’s data is kept for transactions synced from now on.
      </p>
      <div v-else class="grid min-w-0 gap-1.5">
        <div class="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span class="font-medium">{{ BANK_PROVIDER_LABELS[data.data.value.provider] }}</span>
          <span class="text-muted-foreground">{{ EVENTS[data.data.value.event] }} · {{ dateTime(data.data.value.receivedAt, tz) }} · {{ data.data.value.remoteId }}</span>
        </div>
        <pre class="max-h-[60svh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">{{ JSON.stringify(data.data.value.payload, null, 2) }}</pre>
      </div>
    </DialogContent>
  </Dialog>
</template>
