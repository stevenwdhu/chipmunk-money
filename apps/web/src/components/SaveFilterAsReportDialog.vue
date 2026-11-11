<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { describeFilter, EVERYTHING, resolveRange, type FilterNames, type ReportFilter, type ReportRange } from '@chipmunk/shared'
import InfoTip from '@/components/InfoTip.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useCustomReportMutations } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'

/**
 * Saves the Transactions page's filters as a report, then opens it. Like Reports' Save as report, but
 * it keeps no range unless you say so, as the months you were looking through are seldom the ones to keep.
 */
const props = defineProps<{
  filter: ReportFilter
  names: FilterNames
  /** The months shown, as fixed months (null for all time, or dates that can't be). */
  range: ReportRange | null
  /** What the bar has that a report can't (barToFilter). */
  leftOut: Array<'needsReview' | 'q' | 'tooMany'>
}>()
const open = defineModel<boolean>('open', { default: false })

const router = useRouter()
const today = useToday()
const { create } = useCustomReportMutations()

const name = ref('')
const keep = ref(false)
const error = ref('')
const busy = ref(false)

watch(open, (v) => {
  if (!v) return
  name.value = ''
  keep.value = false
  error.value = ''
})

const label = computed(() => (props.range ? resolveRange(props.range, today.value).label : null))
const keepInfo = computed(() => `Turn this on to always open the report with ${label.value}. Off, it opens with any range`)
const LEFT_OUT = {
  needsReview: 'Needs review isn’t saved, as a report can’t filter by it',
  q: 'The search isn’t saved, as it’s too long',
  tooMany: 'The bar’s filters aren’t saved, as the report has as many conditions as it can hold',
}
const summary = computed(() => [
  describeFilter(props.filter, props.names),
  keep.value && label.value ? label.value : 'Any range',
  ...props.leftOut.map((k) => LEFT_OUT[k]),
])

async function submit() {
  const n = name.value.trim()
  if (!n) return (error.value = 'Give the report a name')
  busy.value = true
  try {
    const r = await create.mutateAsync({ name: n, spec: { ...EVERYTHING, filter: props.filter, range: keep.value ? props.range : null } })
    open.value = false
    // It opens with these months either way.
    await router.push({ name: 'reports', params: { reportId: String(r.id) }, query: !keep.value && props.range ? { range: props.range } : {} })
    toast.success(`Saved ${r.name}`)
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
        <DialogTitle>Save as report</DialogTitle>
        <DialogDescription class="sr-only">Name this report to open it again later</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid gap-1.5">
          <Label for="filter-report-name">Name</Label>
          <Input
            id="filter-report-name"
            v-model="name"
            placeholder="Regular spending"
            autocomplete="off"
            maxlength="60"
            :aria-invalid="!!error || undefined"
            @input="error = ''"
          />
          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        </div>
        <div v-if="range" class="flex items-center gap-2">
          <Switch id="filter-report-keep" v-model="keep" />
          <Label for="filter-report-keep">Keep this range</Label>
          <InfoTip :text="keepInfo" />
        </div>
        <ul class="grid gap-0.5 text-xs text-muted-foreground">
          <li v-for="(s, i) in summary" :key="i">{{ s }}</li>
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="busy">Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
