<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import type { Ledger, LedgerAnswers } from '@chipmunk/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLedgerMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import LedgerQuestions from './LedgerQuestions.vue'

/**
 * Archiving a ledger that has something to ask or say first: one that's the home of a shared
 * account, or carries its opening balance. Any other ledger is archived at once (useArchiveLedger).
 */
const props = defineProps<{ ledger: Ledger | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ archived: [ledger: Ledger, changes: string[]] }>()
const m = useLedgerMutations()
const questions = ref<InstanceType<typeof LedgerQuestions> | null>(null)
const answers = ref<LedgerAnswers>({})
const ready = ref(false)

async function archive() {
  if (!props.ledger || !ready.value) return
  try {
    const { changes } = await m.update.mutateAsync({ id: props.ledger.id, archived: true, answers: answers.value })
    open.value = false
    emit('archived', props.ledger, changes)
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
        <DialogTitle>Archive {{ ledger?.name }}?</DialogTitle>
        <DialogDescription>
          It leaves the ledger menu and keeps everything it has, with its transactions on the accounts shared with it. You can restore it any time.
        </DialogDescription>
      </DialogHeader>
      <LedgerQuestions ref="questions" v-model:answers="answers" v-model:ready="ready" :ledger="ledger" action="archive" :active="open" />
      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button :disabled="!ready || m.update.isPending.value" @click="archive">
          <Loader2 v-if="m.update.isPending.value" class="animate-spin" />Archive
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
