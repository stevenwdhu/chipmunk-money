<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { comparePeriods, type PeriodSummary } from '@st/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { money, percent } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Spending by group, then category, in this period and the one it's compared with, biggest change first. */
const props = defineProps<{
  cur: PeriodSummary
  prev: PeriodSummary
  curLabel: string
  prevLabel: string
  prevHeading: string
  /** The page's colour for a category, so it matches the chart. */
  colorOf?: (categoryId: number | null) => string | undefined
}>()
const emit = defineEmits<{ drill: [categoryId: number | null] }>()

const LIMIT = 8
const groups = computed(() => comparePeriods(props.cur, props.prev))
const all = ref(false)
const shown = computed(() => (all.value ? groups.value : groups.value.slice(0, LIMIT)))
const expanded = ref(new Set<number | null>())

function toggle(id: number | null) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

// More spending is red, less is green.
const tone = (n: number) => (n > 0 ? 'text-negative' : n < 0 ? 'text-positive' : 'text-muted-foreground')
const pct = (p: number | null) => (p === null ? '—' : `${p > 0 && percent(p) !== '0%' ? '+' : ''}${percent(p)}`)
</script>

<template>
  <Card class="gap-3">
    <CardHeader>
      <CardTitle>What changed</CardTitle>
      <CardDescription>{{ curLabel }} vs {{ prevLabel }}</CardDescription>
    </CardHeader>
    <CardContent>
      <p v-if="!groups.length" class="text-sm text-muted-foreground">No spending in either period.</p>
      <div v-else class="text-sm">
        <div class="hidden items-center gap-2 border-b pb-1.5 text-xs text-muted-foreground sm:flex">
          <span class="min-w-0 flex-1 pl-6">Group</span>
          <span class="w-24 text-right">This period</span>
          <span class="w-24 text-right">{{ prevHeading }}</span>
          <span class="w-24 text-right">Change</span>
          <span class="w-12 text-right">%</span>
        </div>
        <ul class="divide-y">
          <li v-for="g in shown" :key="g.groupId ?? 'none'">
            <!-- On a phone the two periods' amounts go on a line of their own, under the rest. -->
            <button
              type="button"
              class="flex min-h-11 w-full flex-wrap items-center gap-x-2 py-1.5 text-left hover:bg-muted/50"
              :aria-expanded="expanded.has(g.groupId)"
              @click="toggle(g.groupId)"
            >
              <ChevronRight :class="cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded.has(g.groupId) && 'rotate-90')" />
              <span class="min-w-0 flex-1 truncate font-medium">{{ g.name }}</span>
              <span class="hidden w-24 text-right tabular sm:block">{{ money(g.currentMinor) }}</span>
              <span class="hidden w-24 text-right text-muted-foreground tabular sm:block">{{ money(g.previousMinor) }}</span>
              <span :class="cn('w-24 text-right tabular', tone(g.changeMinor))">{{ money(g.changeMinor, { signed: true }) }}</span>
              <span :class="cn('w-12 text-right text-xs tabular', tone(g.changeMinor))">{{ pct(g.changePct) }}</span>
              <span class="basis-full truncate pl-6 text-xs text-muted-foreground tabular sm:hidden">{{ money(g.currentMinor) }} vs {{ money(g.previousMinor) }}</span>
            </button>
            <ul v-if="expanded.has(g.groupId)" class="pb-1.5">
              <li v-for="c in g.categories" :key="c.categoryId ?? 'none'">
                <button
                  type="button"
                  class="flex min-h-11 w-full flex-wrap items-center gap-x-2 py-1 pl-6 text-left hover:bg-muted/50 sm:min-h-9"
                  @click="emit('drill', c.categoryId)"
                >
                  <span class="flex min-w-0 flex-1 items-center gap-2">
                    <span class="size-2 shrink-0 rounded-full" :style="{ background: colorOf?.(c.categoryId) ?? c.color }" />
                    <span class="truncate"><span class="sr-only">Show transactions in </span>{{ c.name }}</span>
                  </span>
                  <span class="hidden w-24 text-right tabular sm:block">{{ money(c.currentMinor) }}</span>
                  <span class="hidden w-24 text-right text-muted-foreground tabular sm:block">{{ money(c.previousMinor) }}</span>
                  <span :class="cn('w-24 text-right tabular', tone(c.changeMinor))">{{ money(c.changeMinor, { signed: true }) }}</span>
                  <span :class="cn('w-12 text-right text-xs tabular', tone(c.changeMinor))">{{ pct(c.changePct) }}</span>
                  <span class="basis-full truncate pl-4 text-xs text-muted-foreground tabular sm:hidden">{{ money(c.currentMinor) }} vs {{ money(c.previousMinor) }}</span>
                </button>
              </li>
            </ul>
          </li>
        </ul>
        <Button v-if="groups.length > LIMIT" variant="ghost" size="sm" class="mt-1 w-full" @click="all = !all">
          {{ all ? 'Show fewer' : `Show all ${groups.length} groups` }}
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
