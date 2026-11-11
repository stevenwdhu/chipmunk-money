<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from '@lucide/vue'
import { formatMonth, formatMonthShort } from '@chipmunk/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTransactionSpan } from '@/composables/queries'
import { useSelectedMonth } from '@/composables/useToday'
import { cn } from '@/lib/utils'

const { month, isCurrent, shift, current } = useSelectedMonth()

const open = ref(false)
/** "months": the 12 months of `viewYear`; "years": a page of 12 years to jump between. */
const view = ref<'months' | 'years'>('months')
const viewYear = ref(Number(month.value.slice(0, 4)))
/** How many 12-year pages back from the page that ends at the current year. */
const yearPage = ref(0)

const currentYear = computed(() => Number(current.value.slice(0, 4)))
/** Nothing to see before the first transaction, so earlier months are greyed out (no limit while there are none). */
const span = useTransactionSpan()
const firstMonth = computed(() => span.data.value?.first?.slice(0, 7) ?? null)
const firstYear = computed(() => (firstMonth.value ? Number(firstMonth.value.slice(0, 4)) : -Infinity))
const atFirst = computed(() => !!firstMonth.value && month.value <= firstMonth.value)
const selectedYear = computed(() => Number(month.value.slice(0, 4)))

watch(open, (v) => {
  if (!v) return
  view.value = 'months'
  viewYear.value = selectedYear.value
})

const months = computed(() =>
  Array.from({ length: 12 }, (_, i) => {
    const key = `${viewYear.value}-${String(i + 1).padStart(2, '0')}`
    const empty = key > current.value || (!!firstMonth.value && key < firstMonth.value)
    return { key, label: formatMonthShort(key), empty, selected: key === month.value, isNow: key === current.value }
  }),
)

const years = computed(() => {
  const end = currentYear.value - yearPage.value * 12
  return Array.from({ length: 12 }, (_, i) => end - 11 + i)
})

function showYears() {
  yearPage.value = Math.max(0, Math.floor((currentYear.value - viewYear.value) / 12))
  view.value = 'years'
}

function pickYear(y: number) {
  viewYear.value = y
  view.value = 'months'
}

function pickMonth(key: string) {
  month.value = key
  open.value = false
}

function goToCurrent() {
  month.value = current.value
  open.value = false
}
</script>

<template>
  <div class="flex items-center gap-0.5">
    <Button variant="ghost" size="icon-sm" aria-label="Previous month" :disabled="atFirst" @click="shift(-1)"><ChevronLeft /></Button>
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="flex min-w-28 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium tabular transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          :aria-label="`${formatMonth(month)}. Choose a month`"
        >
          {{ formatMonth(month) }}
          <ChevronDown class="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent class="w-64 p-3" align="end">
        <!-- Months of one year -->
        <div v-if="view === 'months'" class="grid gap-3">
          <div class="flex items-center justify-between">
            <Button variant="ghost" size="icon-sm" aria-label="Previous year" :disabled="viewYear <= firstYear" @click="viewYear--">
              <ChevronLeft />
            </Button>
            <button
              type="button"
              class="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold tabular hover:bg-accent"
              aria-label="Choose a year"
              @click="showYears"
            >
              {{ viewYear }}<ChevronDown class="size-3.5 text-muted-foreground" />
            </button>
            <Button variant="ghost" size="icon-sm" aria-label="Next year" :disabled="viewYear >= currentYear" @click="viewYear++">
              <ChevronRight />
            </Button>
          </div>
          <div class="grid grid-cols-3 gap-1.5" role="grid" :aria-label="`Months of ${viewYear}`">
            <button
              v-for="m in months"
              :key="m.key"
              type="button"
              :disabled="m.empty"
              :aria-current="m.selected ? 'date' : undefined"
              :class="
                cn(
                  'h-9 rounded-md text-sm transition-colors disabled:pointer-events-none disabled:opacity-35',
                  m.selected ? 'bg-primary font-medium text-primary-foreground' : 'hover:bg-accent',
                  m.isNow && !m.selected && 'font-semibold ring-1 ring-border ring-inset',
                )
              "
              @click="pickMonth(m.key)"
            >
              {{ m.label }}
            </button>
          </div>
        </div>

        <!-- A page of years -->
        <div v-else class="grid gap-3">
          <div class="flex items-center justify-between">
            <Button variant="ghost" size="icon-sm" aria-label="Earlier years" :disabled="years[0]! <= firstYear" @click="yearPage++">
              <ChevronLeft />
            </Button>
            <span class="text-sm font-semibold tabular">{{ years[0] }} – {{ years[11] }}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Later years" :disabled="yearPage === 0" @click="yearPage--">
              <ChevronRight />
            </Button>
          </div>
          <div class="grid grid-cols-3 gap-1.5" role="grid" aria-label="Years">
            <button
              v-for="y in years"
              :key="y"
              type="button"
              :disabled="y > currentYear || y < firstYear"
              :aria-current="y === selectedYear ? 'date' : undefined"
              :class="
                cn(
                  'h-9 rounded-md text-sm tabular transition-colors disabled:pointer-events-none disabled:opacity-35',
                  y === selectedYear ? 'bg-primary font-medium text-primary-foreground' : 'hover:bg-accent',
                  y === currentYear && y !== selectedYear && 'font-semibold ring-1 ring-border ring-inset',
                )
              "
              @click="pickYear(y)"
            >
              {{ y }}
            </button>
          </div>
        </div>

        <Button v-if="!isCurrent" variant="ghost" size="sm" class="mt-2 w-full" @click="goToCurrent">
          <CalendarDays />This month
        </Button>
      </PopoverContent>
    </Popover>
    <Button variant="ghost" size="icon-sm" aria-label="Next month" :disabled="isCurrent" @click="shift(1)">
      <ChevronRight />
    </Button>
  </div>
</template>
