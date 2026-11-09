<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import type { ReportSpec } from '@st/shared'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { cn } from '@/lib/utils'

/** What a report is compared with. */
const props = defineProps<{ class?: HTMLAttributes['class']; size?: 'sm' | 'default' }>()
const model = defineModel<ReportSpec['compare']>({ required: true })
const isDesktop = useIsDesktop()

/** `short` is what the button shows on a phone, where it's half the width. */
const OPTIONS: Array<{ value: ReportSpec['compare']; label: string; short: string }> = [
  { value: 'previous', label: 'Previous period', short: 'Previous period' },
  { value: 'last-year', label: 'Same months last year', short: 'Last year' },
  { value: 'none', label: 'No comparison', short: 'No comparison' },
]
const shown = computed(() => {
  const o = OPTIONS.find((x) => x.value === model.value)
  return o && (isDesktop.value ? o.label : o.short)
})
</script>

<template>
  <Select v-model="model">
    <SelectTrigger :size="size" aria-label="Compare with" :class="cn('min-w-0', props.class)">
      <SelectValue><span class="truncate">{{ shown }}</span></SelectValue>
    </SelectTrigger>
    <SelectContent align="end">
      <SelectItem v-for="o in OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
    </SelectContent>
  </Select>
</template>
