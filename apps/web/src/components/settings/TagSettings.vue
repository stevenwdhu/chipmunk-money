<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { Tag, Trash2 } from '@lucide/vue'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTagMutations, useTags } from '@/composables/queries'
import { useReportsUsing } from '@/composables/useReportsUsing'
import { errorMessage } from '@/lib/api'

const { data: tags } = useTags()
const m = useTagMutations()
const editingId = ref<number | null>(null)
const draft = ref('')

function startEdit(id: number, name: string) {
  editingId.value = id
  draft.value = name
}
async function save(id: number) {
  const name = draft.value.trim()
  editingId.value = null
  if (!name) return
  await m.update.mutateAsync({ id, name }).catch((err) => toast.error(errorMessage(err)))
}
// A tag a report filters by asks first. Others go at once.
const asking = ref<{ id: number; name: string } | null>(null)
const reportsUsing = useReportsUsing('tag', () => asking.value?.id)
const askOpen = computed({ get: () => !!asking.value && !!reportsUsing.value, set: (v) => !v && (asking.value = null) })
function askToRemove(id: number, name: string) {
  asking.value = { id, name }
  if (!reportsUsing.value) remove(id, name)
}
async function remove(id: number, name: string) {
  asking.value = null
  try {
    await m.remove.mutateAsync(id)
    toast.success(`Removed #${name} from all transactions`)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <Card class="gap-0 py-0">
    <ul v-if="tags?.length" class="divide-y">
      <li v-for="t in tags" :key="t.id" class="flex items-center gap-3 px-4 py-2.5 md:px-6">
        <Tag class="size-4 text-muted-foreground" />
        <form v-if="editingId === t.id" class="flex-1" @submit.prevent="save(t.id)">
          <Input v-model="draft" class="h-8" autofocus :aria-label="`Rename ${t.name}`" @blur="save(t.id)" @keydown.esc="editingId = null" />
        </form>
        <button v-else type="button" class="flex-1 text-left text-sm hover:underline" title="Rename" @click="startEdit(t.id, t.name)">#{{ t.name }}</button>
        <RouterLink :to="{ name: 'transactions', query: { tagId: t.id, period: 'all' } }" class="text-xs text-muted-foreground hover:underline">
          {{ t.count }} transaction{{ t.count === 1 ? '' : 's' }}
        </RouterLink>
        <Button variant="ghost" size="icon-xs" :aria-label="`Delete #${t.name}`" @click="askToRemove(t.id, t.name)"><Trash2 /></Button>
      </li>
    </ul>
    <EmptyState v-else :icon="Tag" title="No tags yet" description="Add tags to transactions, like #trip-japan or #reimbursable, to track things that cut across categories." />
  </Card>

  <Dialog v-model:open="askOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Delete #{{ asking?.name }}?</DialogTitle>
        <DialogDescription>{{ reportsUsing }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="asking = null">Cancel</Button>
        <Button variant="destructive" @click="asking && remove(asking.id, asking.name)">Delete</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
