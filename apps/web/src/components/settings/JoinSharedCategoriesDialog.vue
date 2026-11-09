<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import CategoryPicker from '@/components/CategoryPicker.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCategorySharingPreview, useLedgerCategorySettings } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

/**
 * Switching a ledger with its own categories to the shared list: categories with the same name just
 * match, and for each of the others you choose what happens to it.
 */
const props = defineProps<{ ledgerName: string }>()
const open = defineModel<boolean>('open', { default: false })
const preview = useCategorySharingPreview(open)
const m = useLedgerCategorySettings()

type Action = 'match' | 'add' | 'move' | 'uncategorize'
const ACTIONS: Array<{ value: Action; label: string }> = [
  { value: 'match', label: 'Same as a shared category' },
  { value: 'add', label: 'Add it to the shared list' },
  { value: 'move', label: 'Move its transactions to…' },
  { value: 'uncategorize', label: 'Leave its transactions uncategorized' },
]
const choices = ref(new Map<number, { action: Action; to: number | null }>())
const differing = computed(() => preview.data.value?.differing ?? [])
// A suggested match where one fits; otherwise it joins the shared list.
watch(
  differing,
  (list) => {
    choices.value = new Map(list.map((d) => [d.id, d.suggestion ? { action: 'match' as Action, to: d.suggestion } : { action: 'add' as Action, to: null }]))
  },
  { immediate: true },
)
const set = (id: number, patch: Partial<{ action: Action; to: number | null }>) => {
  const next = new Map(choices.value)
  next.set(id, { ...next.get(id)!, ...patch })
  choices.value = next
}
const needsTarget = (a: Action) => a === 'match' || a === 'move'
const missing = computed(() => differing.value.filter((d) => needsTarget(choices.value.get(d.id)?.action ?? 'add') && !choices.value.get(d.id)?.to))

async function join() {
  if (missing.value.length) return void toast.error(`Choose a shared category for ${missing.value.map((d) => d.name).join(', ')}`)
  try {
    await m.setSharing.mutateAsync({
      shared: true,
      resolve: differing.value.map((d) => {
        const c = choices.value.get(d.id)!
        return { category: d.id, action: c.action, ...(needsTarget(c.action) ? { to: c.to! } : {}) }
      }),
    })
    toast.success(`${props.ledgerName} uses the shared categories now`)
    open.value = false
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Use the shared categories in {{ ledgerName }}?</DialogTitle>
        <DialogDescription>
          Its categories with the same name as a shared one become that one. For each of the others, choose what happens. Changes to the shared
          list reach {{ ledgerName }} from then on.
        </DialogDescription>
      </DialogHeader>

      <div v-if="preview.isLoading.value" class="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 class="size-4 animate-spin" />Comparing…</div>
      <p v-else-if="!differing.length" class="py-2 text-sm text-muted-foreground">Every category here is in the shared list, so they all just match.</p>
      <ul v-else class="divide-y rounded-md border">
        <li v-for="d in differing" :key="d.id" class="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] sm:items-start">
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{{ d.name }}</div>
            <div class="text-xs text-muted-foreground">
              {{ d.group ?? 'No group' }} · {{ d.transactionCount }} transaction{{ d.transactionCount === 1 ? '' : 's' }}
            </div>
          </div>
          <div class="grid min-w-0 gap-2">
            <Select :model-value="choices.get(d.id)?.action" @update:model-value="(v) => set(d.id, { action: v as Action })">
              <SelectTrigger class="w-full" :aria-label="`What happens to ${d.name}`"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="a in ACTIONS" :key="a.value" :value="a.value">{{ a.label }}</SelectItem>
              </SelectContent>
            </Select>
            <CategoryPicker
              v-if="needsTarget(choices.get(d.id)?.action ?? 'add')"
              :model-value="choices.get(d.id)?.to ?? null"
              scope="shared"
              :allow-none="false"
              placeholder="Choose a shared category"
              class="w-full"
              @update:model-value="(v) => set(d.id, { to: v })"
            />
          </div>
        </li>
      </ul>

      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button :disabled="preview.isLoading.value || m.setSharing.isPending.value" @click="join">
          <Loader2 v-if="m.setSharing.isPending.value" class="animate-spin" />Use the shared categories
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
