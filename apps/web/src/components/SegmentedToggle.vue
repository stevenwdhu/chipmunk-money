<script setup lang="ts" generic="T extends string | number">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

/** A few choices side by side with one of them on (none, when the value isn't one of them). */
const props = defineProps<{ options: ReadonlyArray<{ value: T; label: string }>; label: string; class?: HTMLAttributes['class'] }>()
const model = defineModel<T>({ required: true })
</script>

<template>
  <div :class="cn('flex rounded-md bg-muted p-0.5 text-xs', props.class)" role="radiogroup" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      :class="cn('flex-1 rounded px-2 py-1 whitespace-nowrap', model === o.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')"
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>
