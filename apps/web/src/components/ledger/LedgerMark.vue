<script setup lang="ts">
import type { Ledger } from '@chipmunk/shared'

/** A ledger's colour square with its initial. */
withDefaults(defineProps<{ ledger?: Pick<Ledger, 'name' | 'color'> | null; size?: 'sm' | 'md' }>(), { size: 'md' })
</script>

<template>
  <span
    class="grid shrink-0 place-items-center rounded-md font-semibold text-white"
    :class="size === 'md' ? 'size-8 text-sm' : 'size-5 text-[11px]'"
    :style="{ background: ledger?.color ?? 'var(--muted-foreground)' }"
    aria-hidden="true"
  >
    {{ ledger?.name.charAt(0).toUpperCase() ?? '' }}
  </span>
</template>
