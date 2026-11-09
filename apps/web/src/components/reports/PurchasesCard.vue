<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { EyeOff, Undo2 } from '@lucide/vue'
import { describeRule, pick, putBack, sideOf, withSide, type FilteredOut, type FilterNames, type FilterSide, type ReportPurchases } from '@st/shared'
import InfoTip from '@/components/InfoTip.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCategories, useReportPurchases } from '@/composables/queries'
import type { ReportState } from '@/composables/useReportState'
import { useToday } from '@/composables/useToday'
import { money, shortDate } from '@/lib/format'
import { titleOf } from '@/lib/payee'
import { useUiStore } from '@/stores/ui'

type Item = ReportPurchases['items'][number]
type At = { side: FilterSide; kind: 'only' | 'rule' | 'picked' | 'keep'; index: number }

/**
 * A report's biggest counted purchases, each one a tap from being filtered out, and what its filter
 * filters out, with why and Put back.
 */
const props = defineProps<{
  state: ReportState
  names: FilterNames
  /** The spending side's filtered out total (the KPI's), or null when nothing is filtered out. */
  filteredOut: FilteredOut | null
  /** The report's spec is known (it has loaded): nothing is fetched before. */
  ready: boolean
}>()
const emit = defineEmits<{ openFilter: [at: At] }>()

const ui = useUiStore()
const today = useToday()
const { byId: categories } = useCategories()

const tab = ref<'biggest' | 'out'>('biggest')
watch(
  () => props.filteredOut,
  (fo) => !fo && (tab.value = 'biggest'),
)

const LIMIT = 50
const params = computed(() => ({ from: props.state.range.value.from, to: props.state.range.value.to, side: 'spending' as const, filter: props.state.apiFilter.value }))
const biggest = useReportPurchases(() => ({ ...params.value, set: 'counted' as const, limit: 20 }), { enabled: () => props.ready })
const out = useReportPurchases(() => ({ ...params.value, set: 'filtered-out' as const, limit: LIMIT }), {
  enabled: () => props.ready && tab.value === 'out' && !!props.filteredOut,
})

const rules = computed(() => sideOf(props.state.filter.value, 'spending').filterOut)
const charged = (i: Item) => -i.transaction.amountMinor
const meta = (i: Item) => {
  const c = i.transaction.categoryId === null ? null : categories.value.get(i.transaction.categoryId)
  return [shortDate(i.transaction.date, today.value), c?.name].filter(Boolean).join(' · ')
}

function filterOut(i: Item) {
  const f = props.state.filter.value
  props.state.setFilter(
    withSide(f, 'spending', (s) => pick(s, i.transaction.id)),
    { undo: `Filtered out ${titleOf(i.transaction)}` },
  )
}

function putItBack(i: Item) {
  const f = props.state.filter.value
  props.state.setFilter(
    withSide(f, 'spending', (s) => putBack(s, i.transaction.id, i.rules.length > 0)),
    { undo: `Put back ${titleOf(i.transaction)}` },
  )
}
</script>

<template>
  <Card class="gap-3">
    <CardHeader>
      <CardTitle>Purchases</CardTitle>
    </CardHeader>
    <CardContent>
      <Tabs v-model="tab">
        <TabsList class="w-full sm:w-auto">
          <TabsTrigger value="biggest">Biggest</TabsTrigger>
          <TabsTrigger v-if="filteredOut" value="out">Filtered out ({{ filteredOut.count }})</TabsTrigger>
        </TabsList>

        <TabsContent value="biggest" class="mt-2">
          <p class="text-xs text-muted-foreground">Recurring payments aren't listed</p>
          <p v-if="biggest.data.value && !biggest.data.value.items.length" class="py-4 text-sm text-muted-foreground">No purchases in this range.</p>
          <ul class="divide-y">
            <li v-for="i in biggest.data.value?.items ?? []" :key="i.transaction.id" class="flex items-center gap-1">
              <button type="button" class="flex min-w-0 flex-1 items-center gap-3 rounded-md py-2 text-left hover:bg-muted/50" @click="ui.openEdit(i.transaction)">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{{ titleOf(i.transaction) }}</span>
                  <span class="block truncate text-xs text-muted-foreground">{{ meta(i) }}</span>
                </span>
                <span class="shrink-0 text-right">
                  <span class="block text-sm tabular">{{ money(charged(i)) }}</span>
                  <span v-if="i.shareMinor !== charged(i)" class="block text-xs text-muted-foreground tabular">your share {{ money(i.shareMinor) }}</span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                class="size-11 shrink-0 text-muted-foreground md:size-8"
                :aria-label="`Filter out ${titleOf(i.transaction)}`"
                :title="`Filter out ${titleOf(i.transaction)}`"
                @click="filterOut(i)"
              >
                <EyeOff />
              </Button>
            </li>
          </ul>
        </TabsContent>

        <TabsContent v-if="filteredOut" value="out" class="mt-2">
          <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Filtered out {{ money(filteredOut.amountMinor) }} in {{ filteredOut.count }} purchase{{ filteredOut.count === 1 ? '' : 's' }}</span>
            <span class="flex shrink-0 items-center gap-1">
              Put back
              <InfoTip text="Counts this one payment again. For a bill that comes back every year, make it a recurring item so Not recurring keeps it counted" />
            </span>
          </div>
          <ul class="divide-y">
            <li v-for="i in out.data.value?.items ?? []" :key="i.transaction.id" class="flex items-center gap-1 py-1">
              <div class="min-w-0 flex-1">
                <button type="button" class="flex w-full items-center gap-3 rounded-md py-1 text-left hover:bg-muted/50" @click="ui.openEdit(i.transaction)">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm">{{ titleOf(i.transaction) }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ meta(i) }}</span>
                  </span>
                  <span class="shrink-0 text-right">
                    <span class="block text-sm tabular">{{ money(i.inRangeMinor) }}</span>
                    <span v-if="i.shareMinor !== i.inRangeMinor" class="block text-xs text-muted-foreground tabular">your share {{ money(i.shareMinor) }}</span>
                  </span>
                </button>
                <!-- Each reason opens the builder at it: on a phone the pill sits in a 44px tall button. -->
                <div class="flex flex-wrap gap-x-1 md:gap-1 md:pb-1">
                  <button
                    v-for="r in i.rules.filter((r) => rules[r])"
                    :key="r"
                    type="button"
                    class="group flex min-h-11 max-w-full min-w-0 items-center md:min-h-0"
                    :title="describeRule(rules[r]!, 'spending', names)"
                    @click="emit('openFilter', { side: 'spending', kind: 'rule', index: r })"
                  >
                    <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground group-hover:bg-muted">
                      <EyeOff class="size-3 shrink-0" /><span class="truncate">{{ describeRule(rules[r]!, 'spending', names) }}</span>
                    </span>
                  </button>
                  <button
                    v-if="i.picked"
                    type="button"
                    class="group flex min-h-11 items-center md:min-h-0"
                    @click="emit('openFilter', { side: 'spending', kind: 'picked', index: 0 })"
                  >
                    <span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground group-hover:bg-muted">
                      <EyeOff class="size-3" />Picked
                    </span>
                  </button>
                </div>
              </div>
              <Button variant="ghost" size="sm" class="h-11 shrink-0 md:h-8" :aria-label="`Put back ${titleOf(i.transaction)}`" @click="putItBack(i)">
                <Undo2 />Put back
              </Button>
            </li>
          </ul>
          <p v-if="out.data.value && !out.data.value.items.length" class="py-4 text-sm text-muted-foreground">Nothing filtered out in this range.</p>
          <Button v-if="(out.data.value?.count ?? 0) > LIMIT" variant="ghost" size="sm" class="mt-1 w-full" as-child>
            <RouterLink :to="state.drill({ side: 'spending', filteredOut: true })">See all {{ out.data.value?.count }} in Transactions</RouterLink>
          </Button>
        </TabsContent>
      </Tabs>
    </CardContent>
  </Card>
</template>
