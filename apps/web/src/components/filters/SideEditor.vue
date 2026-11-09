<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue'
import { ChevronRight, EyeOff, Plus, RotateCcw } from '@lucide/vue'
import { addRule, FILTER_LIMITS, type Condition, type ConditionField, type FilteredOut, type FilterNames, type FilterSide } from '@st/shared'
import InfoTip from '@/components/InfoTip.vue'
import { Button } from '@/components/ui/button'
import AddMenu, { type AddMenuItem } from './AddMenu.vue'
import ConditionRow from './ConditionRow.vue'
import {
  appliedIndex,
  BIG_ONE_TIME,
  draftRow,
  draftRule,
  emptyCondition,
  figure,
  FIELDS,
  isComplete,
  ONCE_IN_ONLY,
  wholeMoney,
  type DraftSide,
} from './conditions'
import RuleRow from './RuleRow.vue'

/**
 * One side of the filter in the builder: Only count, then Filter out (its rules, and the transactions
 * picked and put back). Empty sections offer the usual first steps. Each edit hands on the whole side.
 */
const props = defineProps<{
  side: FilterSide
  draft: DraftSide
  names: FilterNames
  filteredOut: FilteredOut | null
}>()
const emit = defineEmits<{ change: [DraftSide]; view: [view: 'pick' | 'picked' | 'keep'] }>()

/** The row whose editor opens once it's on screen (one just added). */
const focusKey = ref<number | null>(null)
const id = useId()
const root = useTemplateRef<HTMLElement>('root')
const update = (patch: Partial<DraftSide>) => emit('change', { ...props.draft, ...patch })
const noun = computed(() => (props.side === 'spending' ? 'charges' : 'deposits'))

// Only count -----------------------------------------------------------------

const onlyFields = computed(() => props.draft.only.map((r) => r.c.field))
/** Fields a row can't change to: the once-only ones another row has. */
const takenInOnly = (i: number) => onlyFields.value.filter((f, j) => j !== i && ONCE_IN_ONLY.has(f))
const onlyItems = computed<AddMenuItem[]>(() =>
  FIELDS.map((f) => ({ value: f.value, label: f.label, disabled: ONCE_IN_ONLY.has(f.value) && onlyFields.value.includes(f.value) })),
)

function addOnly(field: ConditionField) {
  const row = draftRow(emptyCondition(field))
  update({ only: [...props.draft.only, row] })
  focusKey.value = row.key
}

// Filter out -----------------------------------------------------------------

const ruleItems = computed<AddMenuItem[]>(() => [
  { value: 'big', label: `Big one-time ${noun.value}` },
  'separator',
  ...FIELDS.map((f) => ({ value: f.value, label: f.label })),
  'separator',
  { value: 'pick', label: props.side === 'spending' ? 'Pick purchases' : 'Pick deposits' },
])

function addRuleOn(field: ConditionField) {
  const rule = draftRule([emptyCondition(field)])
  update({ filterOut: [...props.draft.filterOut, rule] })
  focusKey.value = rule.when[0]!.key
}

/** $1,000 or more and not recurring, its amount ready to change. Already there: it's shown instead. */
async function addBigOneTime() {
  const applied = props.draft.filterOut.map((r) => ({ when: r.when.map((x) => x.c).filter(isComplete) })).filter((r) => r.when.length)
  if (addRule(applied, BIG_ONE_TIME) === applied) {
    const key = (when: Condition[]) => JSON.stringify([...when].sort((a, b) => a.field.localeCompare(b.field)))
    const i = props.draft.filterOut.findIndex((r) => key(r.when.map((x) => x.c)) === key(BIG_ONE_TIME.when))
    await nextTick()
    const el = root.value?.querySelector<HTMLElement>(`[data-at="rule-${i}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    return
  }
  const rule = draftRule(BIG_ONE_TIME.when)
  update({ filterOut: [...props.draft.filterOut, rule] })
  focusKey.value = rule.when[0]!.key
}

function pickRule(value: string) {
  if (value === 'big') addBigOneTime()
  else if (value === 'pick') emit('view', 'pick')
  else addRuleOn(value as ConditionField)
}

const ruleFigure = (i: number) => {
  const f = props.filteredOut?.byRule[appliedIndex(props.draft, 'rule', i)]
  return f && figure(f)
}
const pickedFigure = computed(() => {
  const p = props.filteredOut?.picked
  return p?.count ? wholeMoney(p.amountMinor) : undefined
})
const emptyOut = computed(() => !props.draft.filterOut.length && !props.draft.picked.length)
</script>

<template>
  <div ref="root" class="grid gap-6">
    <section class="grid gap-3" :aria-labelledby="`${id}-only`">
      <h3 :id="`${id}-only`" class="flex items-center gap-1.5 text-sm font-medium">
        Only count
        <InfoTip text="Every condition must match. Leave it empty to count everything" />
      </h3>
      <div
        v-for="(row, i) in draft.only"
        :key="row.key"
        :data-at="`only-${i}`"
        class="rounded-md transition-shadow data-flash:ring-3 data-flash:ring-ring/50"
      >
        <ConditionRow
          :condition="row.c"
          :side="side"
          :names="names"
          :taken="takenInOnly(i)"
          :auto-open="focusKey === row.key"
          @opened="focusKey = null"
          @change="(c) => update({ only: draft.only.map((r) => (r.key === row.key ? { key: r.key, c } : r)) })"
          @remove="update({ only: draft.only.filter((r) => r.key !== row.key) })"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <template v-if="!draft.only.length">
          <Button variant="outline" size="sm" class="h-11 rounded-full md:h-8" @click="addOnly('category')"><Plus />Categories</Button>
          <Button variant="outline" size="sm" class="h-11 rounded-full md:h-8" @click="addOnly('account')"><Plus />Accounts</Button>
        </template>
        <AddMenu
          :label="draft.only.length ? 'Add condition' : 'More'"
          :items="onlyItems"
          :disabled="draft.only.length >= FILTER_LIMITS.only"
          class="first:-ml-2"
          @pick="(f) => addOnly(f as ConditionField)"
        />
      </div>
    </section>

    <section class="grid gap-3" :aria-labelledby="`${id}-out`">
      <h3 :id="`${id}-out`" class="flex items-center gap-1.5 text-sm font-medium">
        Filter out
        <InfoTip text="Anything that matches one of these is filtered out, along with the refunds and paybacks linked to it" />
      </h3>
      <RuleRow
        v-for="(rule, i) in draft.filterOut"
        :key="rule.key"
        :data-at="`rule-${i}`"
        :rule="rule"
        :side="side"
        :names="names"
        :figure="ruleFigure(i)"
        :focus-key="focusKey"
        @focus="(k) => (focusKey = k)"
        @change="(r) => update({ filterOut: draft.filterOut.map((x) => (x.key === rule.key ? r : x)) })"
        @remove="update({ filterOut: draft.filterOut.filter((x) => x.key !== rule.key) })"
      />

      <!-- The whole row opens the list, and the tip sits above that. -->
      <div
        v-if="draft.picked.length"
        data-at="picked-0"
        class="relative flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm transition-shadow hover:bg-muted/50 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 data-flash:ring-3 data-flash:ring-ring/50"
      >
        <EyeOff class="size-4 shrink-0 text-muted-foreground" />
        <button type="button" class="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0" @click="emit('view', 'picked')">
          {{ draft.picked.length }} picked
        </button>
        <span v-if="pickedFigure" class="shrink-0 text-xs text-muted-foreground tabular">{{ pickedFigure }}</span>
        <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
      </div>
      <div
        v-if="draft.keep.length"
        data-at="keep-0"
        class="relative flex min-h-11 items-center gap-2 rounded-lg border border-dashed px-3 text-sm transition-shadow hover:bg-muted/50 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 data-flash:ring-3 data-flash:ring-ring/50"
      >
        <RotateCcw class="size-4 shrink-0 text-muted-foreground" />
        <button type="button" class="min-w-0 truncate text-left outline-none after:absolute after:inset-0" @click="emit('view', 'keep')">
          {{ draft.keep.length }} put back
        </button>
        <span class="relative z-10 flex">
          <InfoTip text="Counts this one payment again. For a bill that comes back every year, make it a recurring item so Not recurring keeps it counted" />
        </span>
        <ChevronRight class="ml-auto size-4 shrink-0 text-muted-foreground" />
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <template v-if="emptyOut">
          <Button variant="outline" size="sm" class="h-11 rounded-full md:h-8" @click="addBigOneTime"><Plus />Big one-time {{ noun }}</Button>
          <Button variant="outline" size="sm" class="h-11 rounded-full md:h-8" @click="addRuleOn('tag')"><Plus />A tag</Button>
          <Button variant="outline" size="sm" class="h-11 rounded-full md:h-8" @click="addRuleOn('payee')"><Plus />A payee</Button>
          <Button variant="outline" size="sm" class="h-11 rounded-full md:h-8" @click="emit('view', 'pick')">
            <Plus />{{ side === 'spending' ? 'Pick purchases' : 'Pick deposits' }}
          </Button>
        </template>
        <AddMenu
          :label="emptyOut ? 'More' : 'Add rule'"
          :items="ruleItems"
          :disabled="draft.filterOut.length >= FILTER_LIMITS.rules"
          class="first:-ml-2"
          @pick="pickRule"
        />
      </div>
    </section>
  </div>
</template>
