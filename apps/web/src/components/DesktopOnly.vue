<script setup lang="ts">
import { Monitor } from '@lucide/vue'
import { useIsDesktop } from '@/composables/useBreakpoint'

/**
 * A screen kept for a computer: setup, imports and reorganizing, done rarely and too wide or too many
 * steps for a phone. There, a one-line note says so instead (`what`: "Import CSV files"). The API can
 * still do it all.
 */
defineProps<{ what: string }>()
const isDesktop = useIsDesktop()
</script>

<template>
  <slot v-if="isDesktop" />
  <p v-else class="flex items-start gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
    <Monitor class="mt-0.5 size-4 shrink-0" />{{ what }} from a computer.
  </p>
</template>
