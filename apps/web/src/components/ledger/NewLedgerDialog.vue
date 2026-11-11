<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { FlaskConical, Loader2, Plus } from '@lucide/vue'
import { unusedColor } from '@chipmunk/shared'
import ColorPicker from '@/components/ColorPicker.vue'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useLedgerMutations, useLedgers } from '@/composables/queries'
import { useCustomColors } from '@/composables/useCustomColors'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const { all } = useLedgers()
const m = useLedgerMutations()

type Start = 'empty' | 'demo'
const name = ref('')
const color = ref(unusedColor([]))
const customColors = useCustomColors()
const start = ref<Start>('empty')
const error = ref('')
const busy = ref(false)

watch(open, (v) => {
  if (!v) return
  name.value = ''
  // A colour no other ledger uses yet, when there is one.
  color.value = unusedColor(all.value.map((l) => l.color))
  start.value = 'empty'
  error.value = ''
})

const starts: Array<{ value: Start; label: string; hint: string; icon: typeof Plus }> = [
  { value: 'empty', label: 'Start empty', hint: 'Add accounts and transactions yourself.', icon: Plus },
  { value: 'demo', label: 'Demo data', hint: '13 months of sample spending to explore.', icon: FlaskConical },
]

async function create() {
  if (!name.value.trim()) return (error.value = 'Give the ledger a name, like “Family”')
  busy.value = true
  error.value = ''
  try {
    const ledger = await m.create.mutateAsync({
      name: name.value.trim(),
      color: color.value,
      start: start.value,
    })
    customColors.remember(color.value)
    open.value = false
    toast.success(`Created ${ledger.name}`)
    router.push({ name: start.value === 'empty' ? 'accounts' : 'overview', params: { ledger: ledger.slug }, query: start.value === 'empty' ? { new: '1' } : undefined })
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>New ledger</DialogTitle>
        <DialogDescription>A separate set of books with its own accounts, categories and reports.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="create">
        <div class="grid gap-1.5">
          <FieldLabel html-for="ledger-name" hint="For example “Family”, “Personal” or “Side business”.">Name</FieldLabel>
          <Input id="ledger-name" v-model="name" placeholder="Family" autocomplete="off" />
        </div>
        <div class="grid gap-1.5">
          <FieldLabel hint="Shown in the sidebar and page header so you always know which ledger you're in.">Colour</FieldLabel>
          <ColorPicker v-model="color" />
        </div>
        <div class="grid gap-1.5">
          <FieldLabel>Start with</FieldLabel>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Start with">
            <button
              v-for="s in starts"
              :key="s.value"
              type="button"
              role="radio"
              :aria-checked="start === s.value"
              :class="
                cn(
                  'flex flex-col gap-1 rounded-lg border p-3 text-left text-sm transition-colors',
                  start === s.value ? 'border-primary bg-muted' : 'hover:bg-muted/50',
                )
              "
              @click="start = s.value"
            >
              <component :is="s.icon" class="size-4" />
              <span class="font-medium">{{ s.label }}</span>
              <span class="text-xs text-muted-foreground">{{ s.hint }}</span>
            </button>
          </div>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="busy"><Loader2 v-if="busy" class="animate-spin" />Create ledger</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
