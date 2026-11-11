<script setup lang="ts">
import { computed } from 'vue'
import { TEXT_SCOPES, type TextScope } from '@chipmunk/shared'
import InfoTip from '@/components/InfoTip.vue'
import { cn } from '@/lib/utils'

/**
 * Where words are looked for: everywhere the search box looks (left out), or only in any of the name,
 * payee and notes. Taking the last of those off goes back to everywhere.
 */
defineProps<{ class?: string }>()
const model = defineModel<TextScope[]>()

const LABELS: Record<TextScope, string> = { name: 'Name', payee: 'Payee', notes: 'Notes' }
const everywhere = computed(() => !model.value?.length)
const has = (s: TextScope) => !!model.value?.includes(s)
function toggle(s: TextScope) {
  const next = TEXT_SCOPES.filter((x) => (x === s ? !has(x) : has(x)))
  model.value = next.length ? next : undefined
}
// 32px to look at, 44px to tap on phones (the words truncate inside, so they don't clip that).
const button = (on: boolean) =>
  cn(
    'relative h-8 min-w-0 flex-auto rounded px-2 after:absolute after:inset-x-0 after:-inset-y-1.5 md:after:inset-y-0',
    on ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
  )
</script>

<template>
  <div :class="cn('flex items-center gap-2', $props.class)">
    <div class="flex min-w-0 flex-1 rounded-md bg-muted p-0.5 text-xs" role="group" aria-label="Look for the words in">
      <button type="button" :aria-pressed="everywhere" :class="button(everywhere)" @click="model = undefined">
        <span class="block truncate">Everywhere</span>
      </button>
      <button v-for="s in TEXT_SCOPES" :key="s" type="button" :aria-pressed="has(s)" :class="button(has(s))" @click="toggle(s)">
        <span class="block truncate">{{ LABELS[s] }}</span>
      </button>
    </div>
    <InfoTip text="Everywhere is what the search box looks at: payee, name, notes, recurring item and exact amount" />
  </div>
</template>
