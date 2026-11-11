<script setup lang="ts">
import { computed } from 'vue'
import type { Transaction } from '@chipmunk/shared'
import { useGoToTransaction } from '@/composables/useGoToTransaction'
import { linkBadge } from '@/lib/links'

/**
 * A transaction's refund or payback label, beside its payee: clicking it goes to what it's linked to,
 * in the list on screen, or on the Transactions page when it isn't listed here.
 */
const props = defineProps<{ tx: Transaction }>()
const badge = computed(() => linkBadge(props.tx))
const go = useGoToTransaction()
</script>

<template>
  <button
    v-if="badge"
    type="button"
    class="shrink-0 rounded-full border px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
    :title="badge.title"
    @click.stop="go(badge.targetId)"
    @keydown.enter.stop
  >
    {{ badge.text }}
  </button>
</template>
