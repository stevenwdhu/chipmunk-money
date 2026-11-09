<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { addMonths, FIXED_RANGE_MAX_MONTHS, formatMonthShort, monthOf, type MonthKey, type ReportRange } from '@st/shared'
import { Button } from '@/components/ui/button'
import { useTransactionSpan } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { cn } from '@/lib/utils'

/** Fixed months for a report: a From month, then a To month, at most 36 apart. */
const props = defineProps<{ start: MonthKey; end: MonthKey }>()
const emit = defineEmits<{ pick: [ReportRange] }>()

const today = useToday()
const current = computed(() => monthOf(today.value))
const span = useTransactionSpan()
const firstMonth = computed(() => span.data.value?.first?.slice(0, 7) ?? null)
const firstYear = computed(() => (firstMonth.value ? Number(firstMonth.value.slice(0, 4)) : -Infinity))
const currentYear = computed(() => Number(current.value.slice(0, 4)))

const from = ref<MonthKey | null>(null)
const viewYear = ref(Number(props.start.slice(0, 4)))
const last = computed(() => (from.value ? addMonths(from.value, FIXED_RANGE_MAX_MONTHS - 1) : null))

const name = (m: MonthKey) => `${formatMonthShort(m)} ${m.slice(0, 4)}`

const months = computed(() =>
  Array.from({ length: 12 }, (_, i) => {
    const key = `${viewYear.value}-${String(i + 1).padStart(2, '0')}`
    const outside = key > current.value || (!!firstMonth.value && key < firstMonth.value)
    const tooFar = !!from.value && (key < from.value || key > last.value!)
    // While picking the To month, the months it would cover are shaded.
    const shown = from.value ? key === from.value : key >= props.start && key <= props.end
    const between = from.value ? false : key > props.start && key < props.end
    return { key, label: formatMonthShort(key), disabled: outside || tooFar, edge: shown && !between, between, isNow: key === current.value }
  }),
)

function pickMonth(key: MonthKey) {
  if (!from.value) {
    from.value = key
    return
  }
  emit('pick', `${from.value}..${key}`)
}
</script>

<template>
  <div class="grid gap-3">
    <div class="grid grid-cols-2 gap-1.5 text-xs">
      <button
        type="button"
        :class="cn('rounded-md border px-2 py-1.5 text-left', !from ? 'border-primary' : 'text-muted-foreground')"
        @click="from = null"
      >
        <span class="block text-muted-foreground">From</span>
        <span class="font-medium text-foreground">{{ from ? name(from) : 'Pick a month' }}</span>
      </button>
      <div :class="cn('rounded-md border px-2 py-1.5', from ? 'border-primary' : 'opacity-60')">
        <span class="block text-muted-foreground">To</span>
        <span class="font-medium">{{ from ? 'Pick a month' : '—' }}</span>
      </div>
    </div>
    <div class="flex items-center justify-between">
      <Button variant="ghost" size="icon-sm" aria-label="Previous year" :disabled="viewYear <= firstYear" @click="viewYear--"><ChevronLeft /></Button>
      <span class="text-sm font-semibold tabular">{{ viewYear }}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Next year" :disabled="viewYear >= currentYear" @click="viewYear++"><ChevronRight /></Button>
    </div>
    <div class="grid grid-cols-3 gap-1.5" role="grid" :aria-label="`Months of ${viewYear}`">
      <button
        v-for="m in months"
        :key="m.key"
        type="button"
        :disabled="m.disabled"
        :aria-current="m.edge ? 'date' : undefined"
        :class="
          cn(
            'h-9 rounded-md text-sm transition-colors disabled:pointer-events-none disabled:opacity-35',
            m.edge ? 'bg-primary font-medium text-primary-foreground' : m.between ? 'bg-primary/15' : 'hover:bg-accent',
            m.isNow && !m.edge && 'font-semibold ring-1 ring-border ring-inset',
          )
        "
        @click="pickMonth(m.key)"
      >
        {{ m.label }}
      </button>
    </div>
  </div>
</template>
