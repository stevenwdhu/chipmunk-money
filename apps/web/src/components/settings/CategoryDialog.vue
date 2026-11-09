<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Check, Plus } from '@lucide/vue'
import type { Category } from '@st/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useCategories, useCategoryMutations, useLabelMutations, type CategoryScope } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

/** `scope`: this ledger's own list (default) or the shared one. */
const props = defineProps<{ category?: Category | null; groupId?: number | null; scope?: CategoryScope }>()
const open = defineModel<boolean>('open', { default: false })
const { groups, labels } = useCategories(props.scope)
const m = useCategoryMutations(props.scope)
const lm = useLabelMutations(props.scope)

const name = ref('')
const group = ref('none')
const isIncome = ref(false)
const exclude = ref(false)
const labelIds = ref(new Set<number>())
const newLabel = ref('')
const error = ref('')
const editing = computed(() => !!props.category)

watch(open, (v) => {
  if (!v) return
  const c = props.category
  name.value = c?.name ?? ''
  group.value = String(c?.groupId ?? props.groupId ?? 'none')
  isIncome.value = c?.isIncome ?? false
  exclude.value = c?.excludeFromTotals ?? false
  labelIds.value = new Set(c?.labelIds ?? [])
  newLabel.value = ''
  error.value = ''
})

function toggleLabel(id: number) {
  const next = new Set(labelIds.value)
  if (!next.delete(id)) next.add(id)
  labelIds.value = next
}
/** Makes a label (or finds one with that name) and picks it. */
async function addLabel() {
  const name = newLabel.value.trim()
  if (!name) return
  const existing = labels.value.find((l) => l.name.toLowerCase() === name.toLowerCase())
  try {
    const label = existing ?? (await lm.create.mutateAsync({ name }))
    labelIds.value = new Set([...labelIds.value, label.id])
    newLabel.value = ''
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function submit() {
  if (!name.value.trim()) return (error.value = 'Give the category a name')
  const payload = {
    name: name.value.trim(),
    groupId: group.value === 'none' ? null : Number(group.value),
    isIncome: isIncome.value,
    excludeFromTotals: exclude.value,
    labelIds: [...labelIds.value],
  }
  try {
    if (props.category) await m.update.mutateAsync({ id: props.category.id, ...payload })
    else await m.create.mutateAsync(payload)
    toast.success(props.category ? 'Category saved' : `Added ${payload.name}`)
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
        <DialogTitle>{{ editing ? 'Edit category' : 'Add category' }}</DialogTitle>
        <DialogDescription>Categories group your spending in reports.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid gap-1.5">
          <Label for="cat-name">Name</Label>
          <Input id="cat-name" v-model="name" placeholder="Pets" autocomplete="off" />
        </div>
        <div class="grid gap-1.5">
          <FieldLabel html-for="cat-group" hint="Its colour comes from the group: a shade of the group’s colour, which you set on the group.">Group</FieldLabel>
          <Select v-model="group">
            <SelectTrigger id="cat-group" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No group</SelectItem>
              <SelectItem v-for="g in groups" :key="g.id" :value="String(g.id)">
                <span class="size-2.5 rounded-full" :style="{ background: g.color }" />{{ g.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-1.5">
          <FieldLabel html-for="cat-new-label" hint="Your own way to sort categories across the groups, like needs and wants. A category can have several.">Labels</FieldLabel>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="l in labels"
              :key="l.id"
              type="button"
              :aria-pressed="labelIds.has(l.id)"
              :class="
                cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm transition-colors',
                  labelIds.has(l.id) ? 'border-foreground/30 bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
                )
              "
              @click="toggleLabel(l.id)"
            >
              <span class="size-2 rounded-full" :style="{ background: l.color }" />{{ l.name }}
              <Check v-if="labelIds.has(l.id)" class="size-3.5" />
            </button>
          </div>
          <div class="flex gap-2">
            <Input id="cat-new-label" v-model="newLabel" placeholder="New label" autocomplete="off" maxlength="40" class="h-8" @keydown.enter.prevent="addLabel" />
            <Button type="button" variant="outline" size="sm" :disabled="!newLabel.trim() || lm.create.isPending.value" @click="addLabel"><Plus />Add</Button>
          </div>
        </div>
        <div class="flex items-start gap-2">
          <Switch id="cat-income" v-model="isIncome" class="mt-0.5" />
          <div><Label for="cat-income">Income category</Label><p class="text-xs text-muted-foreground">Money in, like a paycheque or interest.</p></div>
        </div>
        <div class="flex items-start gap-2">
          <Switch id="cat-exclude" v-model="exclude" class="mt-0.5" />
          <div>
            <Label for="cat-exclude">Leave out of totals</Label>
            <p class="text-xs text-muted-foreground">For money moving between your own accounts, like transfers and card payments.</p>
          </div>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="m.create.isPending.value || m.update.isPending.value">{{ editing ? 'Save' : 'Add' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
