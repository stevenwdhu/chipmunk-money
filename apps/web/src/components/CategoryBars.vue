<script setup lang="ts">
import { computed } from 'vue'
import { chartColor, UNGROUPED_COLOR, type CategoryAmount } from '@chipmunk/shared'
import { money, percent } from '@/lib/format'

const props = withDefaults(defineProps<{ items: CategoryAmount[]; limit?: number; total?: number }>(), { limit: 8 })
const emit = defineEmits<{ select: [CategoryAmount] }>()

const total = computed(() => props.total ?? props.items.reduce((n, i) => n + Math.max(i.amountMinor, 0), 0))
const rows = computed(() => {
  const positive = props.items.filter((i) => i.amountMinor > 0)
  const top = positive.slice(0, props.limit)
  const rest = positive.slice(props.limit)
  if (rest.length) {
    top.push({
      categoryId: -1,
      name: `${rest.length} more`,
      color: '#94a3b8',
      groupId: null,
      groupName: null,
      amountMinor: rest.reduce((n, i) => n + i.amountMinor, 0),
      count: rest.reduce((n, i) => n + i.count, 0),
    })
  }
  const max = Math.max(...top.map((r) => r.amountMinor), 1)
  // Each category gets the next easy-to-tell-apart chart colour; uncategorized and "more" stay grey.
  let next = 0
  return top.map((r) => ({
    ...r,
    color: r.categoryId === null || r.categoryId === -1 ? UNGROUPED_COLOR : chartColor(next++),
    width: (r.amountMinor / max) * 100,
    share: total.value ? r.amountMinor / total.value : 0,
  }))
})
</script>

<template>
  <ul class="flex flex-col gap-3">
    <li v-for="r in rows" :key="r.categoryId ?? 'none'">
      <button
        type="button"
        class="group grid w-full gap-1.5 text-left"
        :disabled="r.categoryId === -1"
        @click="emit('select', r)"
      >
        <span class="flex items-center justify-between gap-2 text-sm">
          <span class="flex min-w-0 items-center gap-2">
            <span class="size-2 shrink-0 rounded-full" :style="{ background: r.color }" />
            <span class="truncate group-enabled:group-hover:underline">{{ r.name }}</span>
          </span>
          <span class="flex shrink-0 items-baseline gap-2">
            <span class="text-xs text-muted-foreground tabular">{{ percent(r.share) }}</span>
            <span class="tabular">{{ money(r.amountMinor) }}</span>
          </span>
        </span>
        <span class="h-1.5 overflow-hidden rounded-full bg-muted">
          <span class="block h-full rounded-full transition-[width] duration-500" :style="{ width: `${r.width}%`, background: r.color }" />
        </span>
      </button>
    </li>
  </ul>
</template>
