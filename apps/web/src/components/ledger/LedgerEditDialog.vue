<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type { Ledger } from '@st/shared'
import ColorPicker from '@/components/ColorPicker.vue'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useLedgerMutations } from '@/composables/queries'
import { useCustomColors } from '@/composables/useCustomColors'
import { errorMessage } from '@/lib/api'
import { currentLedger, setCurrentLedger } from '@/lib/ledger'

const props = defineProps<{ ledger: Ledger | null }>()
const open = defineModel<boolean>('open', { default: false })
const route = useRoute()
const router = useRouter()
const m = useLedgerMutations()
const customColors = useCustomColors()
const name = ref('')
const color = ref('')
const error = ref('')

watch(open, (v) => {
  if (!v || !props.ledger) return
  name.value = props.ledger.name
  color.value = props.ledger.color
  error.value = ''
})

async function save() {
  if (!props.ledger) return
  if (!name.value.trim()) return (error.value = 'Give the ledger a name')
  try {
    const wasCurrent = props.ledger.slug === currentLedger.value
    const updated = await m.update.mutateAsync({ id: props.ledger.id, name: name.value.trim(), color: color.value })
    customColors.remember(color.value)
    // Renaming changes the ledger's address; keep the current page open under the new one.
    if (wasCurrent && updated.slug !== props.ledger.slug) {
      setCurrentLedger(updated.slug)
      if (route.params.ledger && route.name) {
        router.replace({ name: route.name, params: { ...route.params, ledger: updated.slug }, query: route.query })
      }
    }
    toast.success('Ledger saved')
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Edit ledger</DialogTitle>
        <DialogDescription>Renaming changes the ledger's web address too.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="save">
        <div class="grid gap-1.5">
          <FieldLabel html-for="edit-ledger-name">Name</FieldLabel>
          <Input id="edit-ledger-name" v-model="name" autocomplete="off" />
        </div>
        <div class="grid gap-1.5">
          <FieldLabel>Colour</FieldLabel>
          <ColorPicker v-model="color" />
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="m.update.isPending.value">Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
