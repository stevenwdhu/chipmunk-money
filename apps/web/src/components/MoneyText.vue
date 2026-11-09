<script setup lang="ts">
import { computed } from 'vue'
import { money } from '@/lib/format'

const props = withDefaults(defineProps<{ amount: number; signed?: boolean; colored?: boolean; muted?: boolean }>(), {
  colored: true,
})
const text = computed(() => money(props.amount, { signed: props.signed }))
</script>

<template>
  <span
    class="tabular whitespace-nowrap"
    :class="[colored && amount > 0 ? 'text-positive' : '', muted && !(colored && amount > 0) ? 'text-muted-foreground' : '']"
    >{{ text }}</span
  >
</template>
