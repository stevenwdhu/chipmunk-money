<script setup lang="ts">
import { computed, ref } from 'vue'
import { EyeOff, Plus, RotateCcw, X } from '@lucide/vue'
import {
  describeCondition,
  describeRule,
  FILTER_SIDES,
  sideOf,
  type FilteredOut,
  type FilterNames,
  type FilterSide,
  type ReportFilter,
} from '@st/shared'
import { cn } from '@/lib/utils'
import { figure, wholeMoney } from './conditions'

type At = { side: FilterSide; kind: 'only' | 'rule' | 'picked' | 'keep'; index: number }

/**
 * A filter as chips: one per Only count condition (solid) and per Filter out rule (muted, with what
 * it filters out when given), then the picks and put backs. A tap opens the builder at that row, and ×
 * removes it. Income's chips say so, and spending's don't.
 */
const props = defineProps<{
  filter: ReportFilter
  names: FilterNames
  /** byRule and picked figures to show on chips ("6 · $4,210"); left out on Transactions. */
  filteredOut?: { spending: FilteredOut; income: FilteredOut } | null
  /** Transactions page: chips can only be removed (no + Filter, no editing). */
  readonly?: boolean
  /** On phones, show this many chips, then "+N more" (emits 'open'). Default: all. */
  max?: number
}>()
const emit = defineEmits<{ open: [at?: At]; remove: [at: At] }>()

type Chip = { at: At; words: string; figure?: string; tone: 'only' | 'out' | 'keep' }

const chips = computed<Chip[]>(() =>
  FILTER_SIDES.flatMap((side) => {
    const s = sideOf(props.filter, side)
    const out = props.filteredOut?.[side]
    const prefix = side === 'income' ? 'Income: ' : ''
    return [
      ...s.only.map((c, index): Chip => ({ at: { side, kind: 'only', index }, words: prefix + describeCondition(c, side, props.names), tone: 'only' })),
      ...s.filterOut.map((r, index): Chip => {
        const f = out?.byRule[index]
        return { at: { side, kind: 'rule', index }, words: prefix + describeRule(r, side, props.names), figure: f && figure(f), tone: 'out' }
      }),
      ...(s.picked.length
        ? [
            {
              at: { side, kind: 'picked', index: 0 },
              words: `${prefix}Filter out ${s.picked.length} picked`,
              figure: out?.picked.count ? wholeMoney(out.picked.amountMinor) : undefined,
              tone: 'out',
            } satisfies Chip,
          ]
        : []),
      ...(s.keep.length ? [{ at: { side, kind: 'keep', index: 0 }, words: `${prefix}Put back ${s.keep.length}`, tone: 'keep' } satisfies Chip] : []),
    ]
  }),
)

// Read-only, "+N more" shows the rest here (there's no builder to open).
const expanded = ref(false)
const shown = computed(() => (props.max === undefined || expanded.value ? chips.value : chips.value.slice(0, props.max)))
const more = computed(() => chips.value.length - shown.value.length)

function showMore() {
  if (props.readonly) expanded.value = true
  else emit('open')
}

const key = (at: At) => `${at.side}-${at.kind}-${at.index}`
const tones = {
  only: 'border-foreground/25 bg-background',
  out: 'border-transparent bg-muted text-muted-foreground',
  keep: 'border-dashed border-foreground/25 bg-background',
}
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-2">
    <div
      v-for="c in shown"
      :key="key(c.at)"
      :class="cn('inline-flex h-8 max-w-full min-w-0 items-center rounded-full border text-sm', tones[c.tone])"
      :title="c.figure ? `${c.words} · ${c.figure}` : c.words"
    >
      <component
        :is="readonly ? 'span' : 'button'"
        :type="readonly ? undefined : 'button'"
        :class="
          cn(
            'flex h-full min-w-0 items-center gap-1.5 rounded-l-full pr-1 pl-3',
            !readonly && 'hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )
        "
        @click="!readonly && emit('open', c.at)"
      >
        <EyeOff v-if="c.tone === 'out'" class="size-3.5 shrink-0" />
        <RotateCcw v-else-if="c.tone === 'keep'" class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="truncate">{{ c.words }}</span>
        <span v-if="c.figure" class="shrink-0 text-muted-foreground tabular">· {{ c.figure }}</span>
      </component>
      <!-- 28px to look at, 44px to tap on phones. -->
      <button
        type="button"
        class="relative mr-0.5 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground after:absolute after:-inset-2 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:after:inset-0"
        :aria-label="`Remove ${c.words}`"
        @click="emit('remove', c.at)"
      >
        <X class="size-3.5" />
      </button>
    </div>
    <button
      v-if="more > 0"
      type="button"
      class="h-8 rounded-full px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      @click="showMore"
    >
      +{{ more }} more
    </button>
    <button
      v-if="!readonly"
      type="button"
      class="inline-flex h-8 items-center gap-1 rounded-full border border-dashed px-3 text-sm text-muted-foreground hover:border-foreground/40 hover:text-foreground"
      @click="emit('open')"
    >
      <Plus class="size-3.5" />Filter
    </button>
    <!-- Anything that goes with the chips (a tip, say), so it follows the last one instead of wrapping on its own. -->
    <slot />
  </div>
</template>
