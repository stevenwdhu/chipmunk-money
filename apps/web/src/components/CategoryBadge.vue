<script setup lang="ts">
import { computed } from 'vue'
import { Check, HandCoins, Repeat, Sparkles, Undo2 } from '@lucide/vue'
import type { Transaction } from '@chipmunk/shared'
import { Button } from '@/components/ui/button'
import PayeeChoicePopover from '@/components/PayeeChoicePopover.vue'
import { useCategories } from '@/composables/queries'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{
  categoryId: number | null
  needsReview?: boolean
  source?: Transaction['categorySource']
  confidence?: number | null
  transfer?: boolean
  /** Money in linked to several bills: it has their categories, not one of its own. */
  bills?: number
  acceptable?: boolean
  /** The transaction it's on: after accepting with ✓, what happens to its payee is asked by it. */
  txId?: number
  class?: string
}>()
const emit = defineEmits<{ accept: [] }>()

const { byId, colorOf } = useCategories()
const ui = useUiStore()
const category = computed(() => (props.categoryId ? byId.value.get(props.categoryId) : undefined))
// A refund's or payback's is always what it pays back's: greyed out, as it isn't its own.
const refund = computed(() => props.source === 'linked')
const several = computed(() => refund.value && (props.bills ?? 0) > 1)
const title = computed(() => {
  if (several.value) return `A payback for ${props.bills} bills: it counts in each one’s category.`
  if (refund.value) {
    return props.needsReview
      ? 'Looks like a partial refund of an earlier purchase, so it has that purchase’s category. Accept it, or open it to say it’s not a refund.'
      : 'A refund or payback: always the category of what it pays back.'
  }
  if (!props.needsReview) return undefined
  const who = props.source === 'ai' ? 'AI' : 'your history'
  const conf = props.confidence ? ` (${Math.round(props.confidence * 100)}% sure)` : ''
  return `Suggested by ${who}${conf}. Accept or pick another category.`
})
</script>

<template>
  <span :class="cn('inline-flex min-w-0 items-center gap-1', props.class)">
    <span
      :title="title"
      :class="
        cn(
          'inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
          needsReview ? 'border-dashed border-ai bg-ai-soft' : 'border-border',
          (refund || (!category && !transfer)) && 'text-muted-foreground',
        )
      "
    >
      <span
        :class="cn('size-2 shrink-0 rounded-full', refund && 'opacity-50')"
        :style="{ background: colorOf(category) ?? 'transparent', border: category ? undefined : '1px dashed currentColor' }"
      />
      <span class="truncate">{{ several ? `${bills} bills` : (category?.name ?? (transfer ? 'Transfer' : 'Uncategorized')) }}</span>
      <Sparkles v-if="needsReview" class="size-3 shrink-0 text-ai" aria-label="Suggested" />
      <Repeat v-else-if="source === 'recurring'" class="size-3 shrink-0 text-muted-foreground" aria-label="From recurring item" />
      <HandCoins v-else-if="several" class="size-3 shrink-0 text-muted-foreground" aria-label="A payback for several bills" />
      <Undo2 v-else-if="refund" class="size-3 shrink-0 text-muted-foreground" aria-label="A refund or payback: the category of what it pays back" />
    </span>
    <PayeeChoicePopover v-if="txId !== undefined && !needsReview && ui.payeePrompt?.txId === txId" />
    <Button
      v-else-if="needsReview && acceptable"
      variant="ghost"
      size="icon-xs"
      class="shrink-0"
      aria-label="Accept suggested category"
      title="Accept suggestion"
      @click.stop="emit('accept')"
    >
      <Check />
    </Button>
  </span>
</template>
