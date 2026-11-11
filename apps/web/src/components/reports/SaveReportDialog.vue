<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { copyName, describeFilter, isReportPreset, type FilterNames } from '@chipmunk/shared'
import InfoTip from '@/components/InfoTip.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { ReportState } from '@/composables/useReportState'
import { errorMessage } from '@/lib/api'

/**
 * Saves what the Reports page shows as a report (`create`), as a copy of the one open (`copy`, Save
 * as new), or renames the one open (`rename`).
 */
const props = defineProps<{ state: ReportState; names: FilterNames; mode: 'create' | 'copy' | 'rename' }>()
const open = defineModel<boolean>('open', { default: false })

const name = ref('')
const keep = ref(true)
const error = ref('')
const busy = ref(false)

watch(open, (v) => {
  if (!v) return
  const current = props.state.report.data.value?.name ?? ''
  const taken = (props.state.reports.data.value ?? []).map((r) => r.name)
  name.value = props.mode === 'rename' ? current : props.mode === 'copy' ? copyName(current, taken) : ''
  keep.value = true
  error.value = ''
})

const title = computed(() => (props.mode === 'rename' ? 'Rename report' : props.mode === 'copy' ? 'Save as new report' : 'Save as report'))
const range = computed(() => props.state.range.value)
const spec = computed(() => props.state.spec.value)
const keepInfo = computed(() => {
  const moves = isReportPreset(spec.value.range ?? '12m')
  return `${moves ? `${range.value.label} moves with today. ` : ''}Turn this off to open the report with any range`
})
const summary = computed(() => [
  describeFilter(spec.value.filter, props.names),
  keep.value ? range.value.label : 'Any range',
  spec.value.compare === 'previous' ? 'Compared with the previous period' : spec.value.compare === 'last-year' ? 'Compared with the same months last year' : 'No comparison',
  spec.value.groupBy === 'group' ? 'By group' : 'By category',
])

async function submit() {
  const n = name.value.trim()
  if (!n) return (error.value = 'Give the report a name')
  busy.value = true
  try {
    if (props.mode === 'rename') {
      await props.state.rename(n)
      toast.success(`Renamed to ${n}`)
    } else {
      await props.state.create(n, keep.value)
    }
    open.value = false
  } catch (err) {
    // A name that's taken (409), mostly.
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription class="sr-only">{{ mode === 'rename' ? 'A new name for this report' : 'Name this report to open it again later' }}</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid gap-1.5">
          <Label for="report-name">Name</Label>
          <Input id="report-name" v-model="name" placeholder="Regular spending" autocomplete="off" maxlength="60" :aria-invalid="!!error || undefined" @input="error = ''" />
          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        </div>
        <template v-if="mode !== 'rename'">
          <div class="flex items-center gap-2">
            <Switch id="report-keep" v-model="keep" />
            <Label for="report-keep">Keep this range</Label>
            <InfoTip :text="keepInfo" />
          </div>
          <ul class="grid gap-0.5 text-xs text-muted-foreground">
            <li v-for="(s, i) in summary" :key="i">{{ s }}</li>
          </ul>
        </template>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="busy">{{ mode === 'rename' ? 'Rename' : 'Save' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
