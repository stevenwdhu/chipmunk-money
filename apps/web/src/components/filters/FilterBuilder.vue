<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  FILTER_SIDES,
  normalizeFilter,
  pick,
  putBack,
  sameFilter,
  sideOf,
  unkeep,
  type FilteredOut,
  type FilterNames,
  type FilterSide,
  type FilterSideFilter,
  type ReportFilter,
} from '@st/shared'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { errorMessage } from '@/lib/api'
import { draftIndex, fromDraft, matchedByRules, sideNoun, toDraft, wholeMoney, type Draft, type DraftSide } from './conditions'
import PickedList from './PickedList.vue'
import PickPurchases from './PickPurchases.vue'
import SideEditor from './SideEditor.vue'

type At = { side: FilterSide; kind: 'only' | 'rule' | 'picked' | 'keep'; index: number }

/**
 * What's inside FilterPanel: Spending and Income tabs, each side's builder, and what it all comes to.
 * Every edit applies at once. Rows still waiting for a value are kept here, out of the filter, until
 * they have one.
 */
const props = defineProps<{
  filter: ReportFilter
  names: FilterNames
  filteredOut: { spending: FilteredOut; income: FilteredOut } | null
  at?: At | null
  range: { from: string; to: string }
  apiFilter?: string
  counted: { spendingMinor: number; incomeMinor: number }
}>()
const emit = defineEmits<{ change: [ReportFilter]; done: [] }>()

const draft = ref<Draft>(toDraft(props.filter))
const side = ref<FilterSide>(props.at?.side ?? 'spending')
const view = ref<'main' | 'pick' | 'picked' | 'keep'>('main')
const busy = ref(false)
const body = useTemplateRef<HTMLElement>('body')
watch(side, () => (view.value = 'main'))

// Filters sent and not back yet as the prop: their return isn't a change from elsewhere.
const sent: string[] = []
const keyOf = (f: ReportFilter) => JSON.stringify(normalizeFilter(f))

function commit(next: Draft) {
  draft.value = next
  const f = fromDraft(next)
  if (sameFilter(f, props.filter)) return
  sent.push(keyOf(f))
  if (sent.length > 20) sent.shift()
  emit('change', f)
}
// Changed elsewhere (Undo, say): the builder starts over from it.
watch(
  () => props.filter,
  (f) => {
    const i = sent.indexOf(keyOf(f))
    if (i >= 0) return void sent.splice(0, i + 1)
    if (!sameFilter(f, fromDraft(draft.value))) draft.value = toDraft(f)
  },
)
const setSide = (s: FilterSide, d: DraftSide) => commit({ ...draft.value, [s]: d })

/** The shared helpers work on a side's picks and put backs. */
const picks = (d: DraftSide): FilterSideFilter => ({ only: [], filterOut: [], picked: d.picked, keep: d.keep })
function withPicks(s: FilterSide, fn: (p: FilterSideFilter) => FilterSideFilter) {
  const d = draft.value[s]
  const next = fn(picks(d))
  commit({ ...draft.value, [s]: { ...d, picked: next.picked, keep: next.keep } })
}

/** Put back: kept counted when a rule would still filter it out, otherwise just no longer picked. */
async function putBackAll(s: FilterSide, items: Array<{ id: number; date?: string }>) {
  busy.value = true
  try {
    const rules = sideOf(fromDraft(draft.value), s).filterOut
    const matched = await matchedByRules(s, rules, items.filter((t): t is { id: number; date: string } => !!t.date))
    withPicks(s, (p) => items.reduce((acc, t) => putBack(acc, t.id, matched.has(t.id)), p))
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    busy.value = false
  }
}

// A list emptied (the last one put back): back to the builder.
watch(
  () => [view.value, draft.value[side.value].picked.length, draft.value[side.value].keep.length] as const,
  ([v, picked, keep]) => {
    if ((v === 'picked' && !picked) || (v === 'keep' && !keep)) view.value = 'main'
  },
)

// Opened from a chip: that side, and that row in sight (or the picked or put back list).
watch(
  () => props.at,
  async (at) => {
    if (!at) return
    side.value = at.side
    await nextTick()
    if (at.kind === 'picked' || at.kind === 'keep') {
      if (draft.value[at.side][at.kind === 'picked' ? 'picked' : 'keep'].length) view.value = at.kind
      return
    }
    view.value = 'main'
    await nextTick()
    const i = draftIndex(draft.value[at.side], at.kind, at.index)
    const el = body.value?.querySelector<HTMLElement>(`[data-at="${at.kind}-${i}"]`)
    if (!el) return
    requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    el.dataset.flash = ''
    setTimeout(() => delete el.dataset.flash, 1600)
  },
  { immediate: true },
)

/** Conditions, rules, picks and put backs on a side, as its tab counts them. */
const countOf = (s: FilterSide) => {
  const f = sideOf(props.filter, s)
  return f.only.length + f.filterOut.length + (f.picked.length ? 1 : 0) + (f.keep.length ? 1 : 0)
}
const out = computed(() => props.filteredOut?.[side.value] ?? null)
const counted = computed(() => (side.value === 'spending' ? props.counted.spendingMinor : props.counted.incomeMinor))
</script>

<template>
  <Tabs :model-value="side" class="min-h-0 flex-1 gap-0" @update:model-value="(v) => (side = v as FilterSide)">
    <div class="px-4 pb-3 md:px-5">
      <TabsList class="w-full">
        <TabsTrigger v-for="s in FILTER_SIDES" :key="s" :value="s">
          {{ s === 'spending' ? 'Spending' : 'Income' }}
          <span v-if="countOf(s)" class="text-xs text-muted-foreground tabular">{{ countOf(s) }}</span>
        </TabsTrigger>
      </TabsList>
    </div>
    <!-- Scrolling stops at its ends instead of going on to the page. -->
    <div ref="body" class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-1 pb-6 md:px-5">
      <TabsContent v-for="s in FILTER_SIDES" :key="s" :value="s">
        <SideEditor
          v-if="view === 'main'"
          :side="s"
          :draft="draft[s]"
          :names="names"
          :filtered-out="filteredOut?.[s] ?? null"
          @change="(d) => setSide(s, d)"
          @view="(v) => (view = v)"
        />
        <PickPurchases
          v-else-if="view === 'pick'"
          :side="s"
          :range="range"
          :api-filter="apiFilter"
          :picked="draft[s].picked"
          @back="view = 'main'"
          @pick="(id) => withPicks(s, (p) => pick(p, id))"
        />
        <PickedList
          v-else
          :side="s"
          :ids="view === 'picked' ? draft[s].picked : draft[s].keep"
          :mode="view === 'picked' ? 'picked' : 'keep'"
          :busy="busy"
          @back="view = 'main'"
          @put-back="(items) => putBackAll(s, items)"
          @unkeep="(ids) => withPicks(s, (p) => ids.reduce(unkeep, p))"
        />
      </TabsContent>
    </div>
    <footer class="flex items-center gap-3 border-t px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-5">
      <div class="min-w-0 flex-1">
        <div class="text-sm">
          Counted <span class="font-medium tabular">{{ wholeMoney(counted) }}</span>
        </div>
        <div v-if="out?.count" class="truncate text-xs text-muted-foreground">
          Filtered out <span class="tabular">{{ wholeMoney(out.amountMinor) }}</span> in {{ out.count }} {{ sideNoun(side, out.count) }}
        </div>
      </div>
      <Button class="h-11 px-6 md:h-9" @click="emit('done')">Done</Button>
    </footer>
  </Tabs>
</template>
