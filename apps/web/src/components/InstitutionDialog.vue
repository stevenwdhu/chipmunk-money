<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Trash2 } from '@lucide/vue'
import type { Institution } from '@st/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInstitutionMutations, useInstitutions } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

const props = defineProps<{ institution: Institution | null }>()
const open = defineModel<boolean>('open', { default: false })
const institutions = useInstitutions()
const m = useInstitutionMutations()

const name = ref('')
const deleting = ref(false)
const moveTo = ref('')
const error = ref('')

watch(open, (v) => {
  if (!v) return
  name.value = props.institution?.name ?? ''
  deleting.value = false
  moveTo.value = ''
  error.value = ''
})

const others = computed(() => (institutions.data.value ?? []).filter((i) => i.id !== props.institution?.id))
const count = computed(() => props.institution?.accountCount ?? 0)
const saving = computed(() => m.update.isPending.value || m.remove.isPending.value)

async function submit() {
  const inst = props.institution
  if (!inst) return
  if (!name.value.trim()) return (error.value = 'Give the institution a name')
  try {
    await m.update.mutateAsync({ id: inst.id, name: name.value.trim() })
    toast.success('Institution saved')
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function remove() {
  const inst = props.institution
  if (!inst) return
  if (count.value && !moveTo.value) return (error.value = 'Choose where its accounts go')
  const target = others.value.find((i) => String(i.id) === moveTo.value)
  try {
    await m.remove.mutateAsync({ id: inst.id, moveTo: target?.id })
    toast.success(target ? `Moved ${inst.name}’s accounts to ${target.name}` : `Deleted ${inst.name}`)
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
        <DialogTitle>Edit institution</DialogTitle>
        <DialogDescription>
          {{ count ? `${count} account${count === 1 ? '' : 's'} at ${institution?.name}.` : 'No accounts here yet.' }}
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid gap-1.5">
          <Label for="inst-name">Name</Label>
          <Input id="inst-name" v-model="name" autocomplete="off" />
        </div>
        <div v-if="deleting" class="grid gap-3 rounded-lg border border-destructive/40 p-3">
          <template v-if="count">
            <Label for="inst-move">Move its {{ count === 1 ? 'account' : `${count} accounts` }} to</Label>
            <Select v-model="moveTo">
              <SelectTrigger id="inst-move" class="w-full"><SelectValue placeholder="Choose an institution" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="i in others" :key="i.id" :value="String(i.id)">{{ i.name }}</SelectItem>
              </SelectContent>
            </Select>
            <p v-if="!others.length" class="text-xs text-muted-foreground">Add another institution from an account first.</p>
          </template>
          <p v-else class="text-sm">Delete {{ institution?.name }}?</p>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" @click="deleting = false">Keep it</Button>
            <Button type="button" variant="destructive" size="sm" :disabled="saving || (count > 0 && !moveTo)" @click="remove">
              {{ count ? 'Move and delete' : 'Delete' }}
            </Button>
          </div>
        </div>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button v-if="!deleting" type="button" variant="ghost" class="text-destructive hover:text-destructive sm:mr-auto" @click="deleting = true">
            <Trash2 />Delete
          </Button>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="saving">Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
