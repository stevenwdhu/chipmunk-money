<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Ledger } from '@chipmunk/shared'
import { useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Archive, Pencil, Sparkles, Star, Trash2 } from '@lucide/vue'
import ArchiveLedgerDialog from '@/components/ledger/ArchiveLedgerDialog.vue'
import DeleteLedgerDialog from '@/components/ledger/DeleteLedgerDialog.vue'
import LedgerEditDialog from '@/components/ledger/LedgerEditDialog.vue'
import LedgerMark from '@/components/ledger/LedgerMark.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { keys, useAiJobStatus, useLedgerMutations, useLedgers, useSettings } from '@/composables/queries'
import { useArchiveLedger } from '@/composables/useArchiveLedger'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { errorMessage } from '@/lib/api'
import { lapi } from '@/lib/ledger'
import { alsoDone } from '@/lib/sharing'

const router = useRouter()
const qc = useQueryClient()
const ledgers = useLedgers()
const settings = useSettings()
const m = useLedgerMutations()
const ledger = computed(() => ledgers.current.value ?? null)
const editOpen = ref(false)
const deleteOpen = ref(false)
const isDesktop = useIsDesktop()
const aiEnabled = computed(() => !!settings.data.value?.ai.enabled)
const job = useAiJobStatus(aiEnabled)

async function makeDefault() {
  if (!ledger.value) return
  try {
    await m.update.mutateAsync({ id: ledger.value.id, isDefault: true })
    toast.success(`${ledger.value.name} now opens by default`)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

function archived(l: Ledger, changes: string[]) {
  toast.success(`Archived ${l.name}. Restore it from App settings → Ledgers.`, { description: alsoDone(changes) })
  router.replace('/')
}
const archiving = useArchiveLedger(archived)

async function categorizeNow() {
  try {
    await lapi.post('/categorize/run')
    toast('Categorizing uncategorized transactions…')
    qc.invalidateQueries({ queryKey: keys.aiStatus() })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div v-if="ledger" class="grid grid-cols-1 gap-4">
    <Card class="gap-4">
      <CardHeader>
        <CardTitle>This ledger</CardTitle>
        <CardDescription>Accounts, categories, tags and reports here are separate from your other ledgers.</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap items-center gap-3">
        <LedgerMark :ledger="ledger" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 font-medium">
            {{ ledger.name }} <Badge v-if="ledger.isDefault" variant="secondary">Default</Badge>
          </div>
          <div class="text-sm text-muted-foreground">
            {{ ledger.accounts }} account{{ ledger.accounts === 1 ? '' : 's' }} · {{ ledger.transactions }} transactions
          </div>
        </div>
        <Button variant="outline" @click="editOpen = true"><Pencil />Edit</Button>
        <Button v-if="!ledger.isDefault" variant="ghost" @click="makeDefault"><Star />Open by default</Button>
      </CardContent>
    </Card>

    <Card v-if="aiEnabled" class="gap-4">
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><Sparkles class="size-4 text-ai" />AI categorization</CardTitle>
        <CardDescription>Ask your AI provider about every uncategorized transaction in {{ ledger.name }}. Suggestions wait for your review.</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap items-center gap-3">
        <Button variant="outline" :disabled="job.data.value?.running" @click="categorizeNow"><Sparkles />Categorize uncategorized now</Button>
        <span v-if="job.data.value?.running" class="text-sm text-muted-foreground">Working… {{ job.data.value.done }}/{{ job.data.value.total }} payees</span>
      </CardContent>
    </Card>

    <!-- Archiving and deleting a ledger is for a computer. -->
    <Card v-if="isDesktop" class="gap-4 border-destructive/40">
      <CardHeader>
        <CardTitle>Archive or delete</CardTitle>
        <CardDescription>
          Archiving hides the ledger from the ledger menu but keeps everything. Restore it from App settings → Ledgers. Deleting
          removes it for good (a copy of the whole database is saved in <code class="text-xs">data/backups</code> first).
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Button variant="outline" :disabled="ledgers.active.value.length < 2" @click="archiving.archive(ledger)"><Archive />Archive ledger</Button>
        <Button
          variant="outline"
          class="text-destructive hover:text-destructive"
          :disabled="ledgers.all.value.length < 2"
          @click="deleteOpen = true"
        >
          <Trash2 />Delete ledger…
        </Button>
        <p v-if="ledgers.all.value.length < 2" class="w-full text-xs text-muted-foreground">
          This is your only ledger. Create another before archiving or deleting this one.
        </p>
      </CardContent>
    </Card>

    <LedgerEditDialog v-model:open="editOpen" :ledger="ledger" />
    <DeleteLedgerDialog v-model:open="deleteOpen" :ledger="ledger" />
    <ArchiveLedgerDialog v-model:open="archiving.open.value" :ledger="archiving.ledger.value" @archived="archived" />
  </div>
</template>
