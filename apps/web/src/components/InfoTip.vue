<script setup lang="ts">
import { ref } from 'vue'
import { Info } from '@lucide/vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** An info icon whose text shows on hover or keyboard focus, and on tap for touch screens. */
defineProps<{ text: string }>()
const open = ref(false)
</script>

<template>
  <Tooltip v-model:open="open" :delay-duration="150" disable-closing-trigger>
    <TooltipTrigger as-child>
      <button
        type="button"
        class="-m-1 rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        :aria-label="text"
        @click.prevent="open = !open"
      >
        <Info class="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" class="max-w-64">{{ text }}</TooltipContent>
  </Tooltip>
</template>
