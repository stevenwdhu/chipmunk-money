<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import type { Ledger } from '@chipmunk/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useLedgerMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { currentLedger } from '@/lib/ledger'

const props = defineProps<{ ledger: Ledger | null }>()
const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const m = useLedgerMutations()
const typed = ref('')
watch(open, (v) => v && (typed.value = ''))

async function remove() {
  if (!props.ledger) return
  try {
    const wasCurrent = props.ledger.slug === currentLedger.value
    const { backup } = await m.remove.mutateAsync({ id: props.ledger.id, confirm: typed.value })
    open.value = false
    toast.success(backup ? `Deleted ${props.ledger.name}. A copy was saved as data/backups/${backup}.` : `Deleted ${props.ledger.name}.`)
    // The router sends "/" to the default ledger.
    if (wasCurrent) router.replace('/')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete {{ ledger?.name }}?</DialogTitle>
        <DialogDescription>
          This removes the ledger with its {{ ledger?.accounts ?? 0 }} accounts and {{ ledger?.transactions ?? 0 }} transactions. A copy
          is saved in <code class="text-xs">data/backups</code> first. To keep it out of the way without deleting, archive it instead.
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-1.5" @submit.prevent="typed === ledger?.name && remove()">
        <FieldLabel html-for="delete-ledger-confirm">Type <span class="font-mono">{{ ledger?.name }}</span> to confirm</FieldLabel>
        <Input id="delete-ledger-confirm" v-model="typed" autocomplete="off" autocapitalize="off" />
      </form>
      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button variant="destructive" :disabled="typed !== ledger?.name || m.remove.isPending.value" @click="remove">
          <Loader2 v-if="m.remove.isPending.value" class="animate-spin" />Delete ledger
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
