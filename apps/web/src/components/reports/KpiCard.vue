<script setup lang="ts">
import { computed } from 'vue'
import InfoTip from '@/components/InfoTip.vue'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { percent } from '@/lib/format'

/**
 * One of the Reports page's figures, with its change against the comparison under it ("+8% vs
 * prev."). `upIsBad`: more is worse (spending), so a rise is red.
 */
const props = defineProps<{
  label: string
  value: string
  info?: string
  /** The change as a fraction, against `vs` ("prev.", "last yr"). */
  change?: number | null
  vs?: string
  upIsBad?: boolean
  negative?: boolean
}>()

const tone = computed(() => {
  const c = props.change
  // A change that rounds to 0% is no change.
  if (c === null || c === undefined || percent(c) === '0%') return 'text-muted-foreground'
  return c > 0 === !!props.upIsBad ? 'text-negative' : 'text-positive'
})
</script>

<template>
  <Card class="gap-1 py-4">
    <CardHeader class="gap-1 px-4">
      <CardDescription class="flex items-center gap-1.5">
        <span class="truncate">{{ label }}</span>
        <InfoTip v-if="info" :text="info" />
      </CardDescription>
      <CardTitle class="text-lg tabular md:text-2xl" :class="negative && 'text-negative'">
        <slot name="value">{{ value }}</slot>
      </CardTitle>
      <p class="min-h-4 text-xs text-muted-foreground">
        <slot>
          <span v-if="change !== null && change !== undefined && vs" :class="tone">{{ change > 0 && percent(change) !== '0%' ? '+' : '' }}{{ percent(change) }} vs {{ vs }}</span>
        </slot>
      </p>
    </CardHeader>
  </Card>
</template>
