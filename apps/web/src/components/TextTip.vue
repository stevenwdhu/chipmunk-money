<script setup lang="ts">
import { ref } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** A word or two whose explanation shows on hover or keyboard focus, and on tap for touch screens. A new line in the text starts a new line. */
defineOptions({ inheritAttrs: false })
defineProps<{ label: string; text: string }>()
const open = ref(false)
</script>

<template>
  <Tooltip v-model:open="open" :delay-duration="150" disable-closing-trigger>
    <TooltipTrigger as-child>
      <button
        type="button"
        v-bind="$attrs"
        class="shrink-0 rounded-sm underline decoration-dotted underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        :aria-label="`${label}: ${text}`"
        @click.prevent="open = !open"
      >
        {{ label }}
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" class="max-w-72 whitespace-pre-line">{{ text }}</TooltipContent>
  </Tooltip>
</template>
