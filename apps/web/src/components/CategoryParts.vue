<script setup lang="ts">
import { Split } from '@lucide/vue'
import type { TransactionPart } from '@chipmunk/shared'
import { useCategories } from '@/composables/queries'
import { money } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * A transaction split into categories, where its category shows: the mark, and its parts under it in
 * their order, "Groceries $62.10 · Pharmacy $18.40". It's changed in the editor, not here.
 */
const props = defineProps<{ parts: TransactionPart[]; class?: string }>()
const { byId, colorOf } = useCategories()
</script>

<template>
  <span :class="cn('flex min-w-0 flex-col items-start gap-0.5', props.class)">
    <span class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
      <Split class="size-3 shrink-0 text-muted-foreground" />
      <span class="truncate">Split by category</span>
    </span>
    <span class="flex max-w-full flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <template v-for="(p, i) in parts" :key="i">
        <span v-if="i" aria-hidden="true">·</span>
        <span class="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
          <span
            class="size-1.5 shrink-0 rounded-full"
            :style="{ background: colorOf(byId.get(p.categoryId ?? -1)) ?? 'transparent', border: p.categoryId ? undefined : '1px dashed currentColor' }"
          />{{ byId.get(p.categoryId ?? -1)?.name ?? 'Uncategorized' }} <span class="tabular">{{ money(Math.abs(p.amountMinor)) }}</span>
        </span>
      </template>
    </span>
  </span>
</template>
