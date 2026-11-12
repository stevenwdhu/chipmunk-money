<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import type { Ledger, LedgerAnswers } from '@chipmunk/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useLedgerMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { currentLedger } from '@/lib/ledger'
import { alsoDone } from '@/lib/sharing'
import LedgerQuestions from './LedgerQuestions.vue'

const props = defineProps<{ ledger: Ledger | null }>()
const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const m = useLedgerMutations()
const typed = ref('')
watch(open, (v) => v && (typed.value = ''))
// What a ledger with a shared account asks first, and whether it's all answered.
const questions = ref<InstanceType<typeof LedgerQuestions> | null>(null)
const answers = ref<LedgerAnswers>({})
const ready = ref(false)
const can = computed(() => ready.value && typed.value === props.ledger?.name && !m.remove.isPending.value)

async function remove() {
  // The ledger as it was: the list it comes from is refreshed without it once it's deleted.
  const ledger = props.ledger
  if (!ledger || !can.value) return
  try {
    const wasCurrent = ledger.slug === currentLedger.value
    const { backup, changes } = await m.remove.mutateAsync({ id: ledger.id, confirm: typed.value, answers: answers.value })
    open.value = false
    toast.success(backup ? `Deleted ${ledger.name}. A copy was saved as data/backups/${backup}.` : `Deleted ${ledger.name}.`, { description: alsoDone(changes) })
    // The router sends "/" to the default ledger.
    if (wasCurrent) router.replace('/')
  } catch (err) {
    // Refused because the questions changed: they're asked again in the dialog.
    if (!questions.value?.refused(err)) toast.error(errorMessage(err))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90svh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete {{ ledger?.name }}?</DialogTitle>
        <DialogDescription>
          This removes the ledger with its {{ ledger?.accounts ?? 0 }} accounts and {{ ledger?.transactions ?? 0 }} transactions. A copy of
          the whole database is saved in <code class="text-xs">data/backups</code> first. To keep it out of the way without deleting, archive it instead.
        </DialogDescription>
      </DialogHeader>
      <LedgerQuestions ref="questions" v-model:answers="answers" v-model:ready="ready" :ledger="ledger" action="delete" :active="open" />
      <form class="grid gap-1.5" @submit.prevent="remove()">
        <FieldLabel html-for="delete-ledger-confirm">Type <span class="font-mono">{{ ledger?.name }}</span> to confirm</FieldLabel>
        <Input id="delete-ledger-confirm" v-model="typed" autocomplete="off" autocapitalize="off" />
      </form>
      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button variant="destructive" :disabled="!can" @click="remove">
          <Loader2 v-if="m.remove.isPending.value" class="animate-spin" />Delete ledger
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
