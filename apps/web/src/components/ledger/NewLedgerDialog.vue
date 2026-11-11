<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArchiveRestore, FlaskConical, Loader2, Plus } from '@lucide/vue'
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

type Start = 'empty' | 'demo' | 'restore'
const name = ref('')
const color = ref(unusedColor([]))
const customColors = useCustomColors()
const start = ref<Start>('empty')
const file = ref<File | null>(null)
const error = ref('')
const busy = ref(false)

watch(open, (v) => {
  if (!v) return
  name.value = ''
  // A colour no other ledger uses yet, when there is one.
  color.value = unusedColor(all.value.map((l) => l.color))
  start.value = 'empty'
  file.value = null
  error.value = ''
})

const starts: Array<{ value: Start; label: string; hint: string; icon: typeof Plus }> = [
  { value: 'empty', label: 'Start empty', hint: 'Add accounts and transactions yourself.', icon: Plus },
  { value: 'restore', label: 'From a backup', hint: 'Fill it from a .db backup file.', icon: ArchiveRestore },
  { value: 'demo', label: 'Demo data', hint: '13 months of sample spending to explore.', icon: FlaskConical },
]

async function create() {
  if (!name.value.trim()) return (error.value = 'Give the ledger a name, like “Family”')
  if (start.value === 'restore' && !file.value) return (error.value = 'Choose the backup file to restore')
  busy.value = true
  error.value = ''
  try {
    const ledger = await m.create.mutateAsync({
      name: name.value.trim(),
      color: color.value,
      start: start.value === 'restore' ? undefined : start.value,
    })
    customColors.remember(color.value)
    if (start.value === 'restore' && file.value) {
      try {
        await m.restoreInto.mutateAsync({ slug: ledger.slug, file: file.value })
      } catch (err) {
        // Keep the ledger; its welcome screen offers the restore again.
        toast.error(`Created ${ledger.name}, but the backup couldn't be restored: ${errorMessage(err)}`)
      }
    }
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
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Start with">
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
        <div v-if="start === 'restore'" class="grid gap-1.5">
          <FieldLabel html-for="ledger-file" hint="A .db file from Ledger settings → Data → Download backup.">Backup file</FieldLabel>
          <Input
            id="ledger-file"
            type="file"
            accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3"
            @change="(e: Event) => (file = (e.target as HTMLInputElement).files?.[0] ?? null)"
          />
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
