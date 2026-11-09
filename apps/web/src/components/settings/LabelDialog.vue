<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Trash2 } from '@lucide/vue'
import { unusedColor, type Label as CategoryLabel } from '@st/shared'
import ColorPicker from '@/components/ColorPicker.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCategories, useLabelMutations, type CategoryScope } from '@/composables/queries'
import { useReportsUsing } from '@/composables/useReportsUsing'
import { useCustomColors } from '@/composables/useCustomColors'
import { errorMessage } from '@/lib/api'

/** Adds a category label, or renames, recolours or deletes one. */
/** `scope`: this ledger's own list (default) or the shared one. */
const props = defineProps<{ label?: CategoryLabel | null; scope?: CategoryScope }>()
const emit = defineEmits<{ saved: [label: CategoryLabel] }>()
const open = defineModel<boolean>('open', { default: false })
const m = useLabelMutations(props.scope)
const { labels } = useCategories(props.scope)
const customColors = useCustomColors()

const name = ref('')
const color = ref(unusedColor([]))
const confirmDelete = ref(false)
const error = ref('')
const editing = computed(() => !!props.label)
const busy = computed(() => m.create.isPending.value || m.update.isPending.value || m.remove.isPending.value)

watch(open, (v) => {
  if (!v) return
  name.value = props.label?.name ?? ''
  color.value = props.label?.color ?? unusedColor(labels.value.map((l) => l.color))
  confirmDelete.value = false
  error.value = ''
})

async function submit() {
  if (!name.value.trim()) return (error.value = 'Give the label a name')
  try {
    const saved = props.label
      ? await m.update.mutateAsync({ id: props.label.id, name: name.value.trim(), color: color.value })
      : await m.create.mutateAsync({ name: name.value.trim(), color: color.value })
    customColors.remember(color.value)
    toast.success(props.label ? 'Label saved' : `Added the label ${saved.name}`)
    emit('saved', saved)
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}

const reportsUsing = useReportsUsing('label', () => props.label?.id)

async function remove() {
  if (!props.label) return
  try {
    await m.remove.mutateAsync(props.label.id)
    toast.success(`Deleted the label ${props.label.name}`)
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
        <DialogTitle>{{ editing ? 'Edit label' : 'Add label' }}</DialogTitle>
        <DialogDescription>Labels sort your categories your own way, across the groups: needs and wants, fixed costs, work expenses.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid gap-1.5">
          <Label for="label-name">Name</Label>
          <Input id="label-name" v-model="name" placeholder="Need" autocomplete="off" maxlength="40" />
        </div>
        <div class="grid gap-1.5">
          <Label>Colour</Label>
          <ColorPicker v-model="color" />
        </div>
        <div v-if="confirmDelete && label" class="flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm">
          <span class="flex-1">
            Delete {{ label.name }}?
            <template v-if="label.categoryCount">It comes off {{ label.categoryCount }} categor{{ label.categoryCount === 1 ? 'y' : 'ies' }}.</template>
            <template v-if="reportsUsing">{{ ' ' }}{{ reportsUsing }}</template>
          </span>
          <Button type="button" variant="outline" size="sm" @click="confirmDelete = false">Keep</Button>
          <Button type="button" variant="destructive" size="sm" :disabled="busy" @click="remove">Delete</Button>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter class="gap-2 sm:justify-between">
          <Button v-if="editing" type="button" variant="ghost" class="text-destructive hover:text-destructive" @click="confirmDelete = true">
            <Trash2 />Delete
          </Button>
          <div class="flex gap-2 sm:ml-auto">
            <Button type="button" variant="outline" @click="open = false">Cancel</Button>
            <Button type="submit" :disabled="busy">{{ editing ? 'Save' : 'Add' }}</Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
