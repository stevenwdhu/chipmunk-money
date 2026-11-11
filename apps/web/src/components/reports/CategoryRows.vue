<script setup lang="ts">
import { computed } from 'vue'
import { chartColor, UNGROUPED_COLOR, type CategoryAmount } from '@chipmunk/shared'
import { money, percent } from '@/lib/format'
import RowActions from './RowActions.vue'

/**
 * CategoryBars with each row's actions (Show transactions, Only this, Filter out this). `colorOf`
 * gives each category the page's colour, so it matches the chart.
 */
const props = withDefaults(
  defineProps<{ items: CategoryAmount[]; limit?: number; total?: number; colorOf?: (categoryId: number | null) => string | undefined }>(),
  { limit: 10, colorOf: undefined },
)
const emit = defineEmits<{ show: [CategoryAmount]; only: [CategoryAmount]; filterOut: [CategoryAmount] }>()

const positive = computed(() => props.items.filter((i) => i.amountMinor > 0))
const total = computed(() => props.total ?? positive.value.reduce((n, i) => n + i.amountMinor, 0))
const rows = computed(() => {
  const top = positive.value.slice(0, props.limit)
  const max = Math.max(...top.map((r) => r.amountMinor), 1)
  // The page's colour, or as CategoryBars: each category the next chart colour, uncategorized grey.
  let next = 0
  return top.map((r) => ({
    item: r,
    color: props.colorOf?.(r.categoryId) ?? (r.categoryId === null ? UNGROUPED_COLOR : chartColor(next++)),
    width: (r.amountMinor / max) * 100,
    share: total.value ? r.amountMinor / total.value : 0,
  }))
})
const rest = computed(() => {
  const more = positive.value.slice(props.limit)
  return more.length ? { count: more.length, amountMinor: more.reduce((n, i) => n + i.amountMinor, 0) } : null
})
</script>

<template>
  <ul class="flex flex-col gap-1">
    <li v-for="r in rows" :key="r.item.categoryId ?? 'none'">
      <RowActions :label="r.item.name" @show="emit('show', r.item)" @only="emit('only', r.item)" @filter-out="emit('filterOut', r.item)">
        <span class="grid w-full gap-1.5 px-1 py-1">
          <span class="flex items-center justify-between gap-2 text-sm">
            <span class="flex min-w-0 items-center gap-2">
              <span class="size-2 shrink-0 rounded-full" :style="{ background: r.color }" />
              <span class="truncate">{{ r.item.name }}</span>
            </span>
            <span class="flex shrink-0 items-baseline gap-2">
              <span class="text-xs text-muted-foreground tabular">{{ percent(r.share) }}</span>
              <span class="tabular">{{ money(r.item.amountMinor) }}</span>
            </span>
          </span>
          <span class="h-1.5 overflow-hidden rounded-full bg-muted">
            <span class="block h-full rounded-full transition-[width] duration-500" :style="{ width: `${r.width}%`, background: r.color }" />
          </span>
        </span>
      </RowActions>
    </li>
    <li v-if="rest" class="flex items-center justify-between gap-2 px-1 py-1 text-sm text-muted-foreground">
      <span>{{ rest.count }} more</span><span class="tabular">{{ money(rest.amountMinor) }}</span>
    </li>
  </ul>
</template>
