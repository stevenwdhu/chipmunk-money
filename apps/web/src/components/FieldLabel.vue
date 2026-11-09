<script setup lang="ts">
import InfoTip from '@/components/InfoTip.vue'
import { Label } from '@/components/ui/label'

/**
 * A form label with an optional info icon. The hint shows on hover or keyboard focus, and on tap
 * for touch screens, so helper text never pushes an input out of line with its neighbours.
 */
defineProps<{ htmlFor?: string; hint?: string; optional?: boolean }>()
</script>

<template>
  <div class="flex min-h-4 items-center gap-1.5">
    <Label :for="htmlFor"><slot /></Label>
    <span v-if="optional" class="text-sm leading-none text-muted-foreground">(optional)</span>
    <InfoTip v-if="hint" :text="hint" />
  </div>
</template>
