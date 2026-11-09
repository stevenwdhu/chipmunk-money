<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { Ban, ChevronDown } from '@lucide/vue'
import { formatMonthShort, UNGROUPED_COLOR, type CategoryAmount } from '@st/shared'
import MoneyText from '@/components/MoneyText.vue'
import { Card } from '@/components/ui/card'
import { useCategories, usePeriodSummary } from '@/composables/queries'
import { money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useIsDesktop } from '@/composables/useBreakpoint'

/**
 * Income, spending by group and category, and what's left out of totals for a period, like
 * Lunch Money's monthly summary. Without `from`/`to` it covers all time and adds monthly averages.
 * Choosing a category filters the list by it (choosing it again clears the filter), and so does
 * choosing one of your category labels.
 */
const props = defineProps<{
  title: string
  from?: string
  to?: string
  /** The categories the list is filtered by ('none' for uncategorized), highlighted. */
  activeCategories?: Array<number | 'none'>
  /** The category label the list is filtered by ('none' for spending without one). */
  activeLabel?: number | 'none' | null
  /** Starts folded to its header (above the list on smaller screens). */
  collapsible?: boolean
}>()
const emit = defineEmits<{ filter: [categoryId: number | 'none']; label: [labelId: number | 'none'] }>()

const summary = usePeriodSummary(() => ({ from: props.from, to: props.to }))
const isDesktop = useIsDesktop()
const s = computed(() => summary.data.value)
const allTime = computed(() => !props.from && !props.to)
const open = ref(!props.collapsible)
const folded = ref(new Set<number | null>())
function toggleGroup(id: number | null) {
  const next = new Set(folded.value)
  if (!next.delete(id)) next.add(id)
  folded.value = next
}

const span = computed(() => {
  if (!s.value || !allTime.value) return null
  const label = (date: string) => `${formatMonthShort(date.slice(0, 7))} ${date.slice(0, 4)}`
  const first = label(s.value.from)
  const last = label(s.value.to)
  return `${first === last ? first : `${first} – ${last}`} · ${s.value.months} month${s.value.months === 1 ? '' : 's'}`
})
/** All time: the monthly average, which says more than a total over years. */
const perMonth = (minor: number) => (allTime.value && s.value && s.value.months > 1 ? `${money(Math.round(minor / s.value.months))} a month` : null)

/**
 * Spending by your category labels, as shares of income (the 50/30/20 way of looking at needs and
 * wants), or of spending when there's no income. A category with two labels counts under both, so
 * the shares can add up to more than 100%.
 */
const { labels: allLabels } = useCategories()
const labelRows = computed(() => {
  if (!s.value || !s.value.labels.items.length) return null
  const ofIncome = s.value.incomeMinor > 0
  const base = ofIncome ? s.value.incomeMinor : s.value.spentMinor
  const share = (minor: number) => (base > 0 && minor ? `${Math.round((minor / base) * 100)}%` : '')
  const rows: Array<{ key: number | 'none' | 'left'; name: string; color: string; amount: number; income: boolean; share: string }> =
    s.value.labels.items.map((l) => {
      // A label on income categories only shows what came in.
      const income = !l.spentMinor && l.incomeMinor > 0
      return { key: l.labelId, name: l.name, color: l.color, amount: income ? l.incomeMinor : l.spentMinor, income, share: income ? '' : share(l.spentMinor) }
    })
  const unlabelled = s.value.labels.unlabelledSpentMinor
  if (unlabelled) rows.push({ key: 'none', name: 'No label', color: 'var(--muted-foreground)', amount: unlabelled, income: false, share: share(unlabelled) })
  // What's left of income after spending: the "savings" share.
  if (ofIncome) rows.push({ key: 'left', name: 'Left over', color: 'var(--positive)', amount: s.value.netMinor, income: false, share: share(s.value.netMinor) })
  return { ofIncome, rows }
})
const key = (c: CategoryAmount) => c.categoryId ?? 'none'
const isActive = (c: CategoryAmount) => !!props.activeCategories?.includes(key(c))
</script>

<template>
  <Card class="gap-0 py-0">
    <component
      :is="collapsible ? 'button' : 'div'"
      :type="collapsible ? 'button' : undefined"
      :aria-expanded="collapsible ? open : undefined"
      class="flex w-full items-center gap-2 px-4 py-3 text-left"
      @click="collapsible && (open = !open)"
    >
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold">{{ title }}</span>
        <span v-if="span" class="block text-xs text-muted-foreground">{{ span }}</span>
      </span>
      <template v-if="collapsible">
        <span v-if="s" class="text-xs text-muted-foreground">Net <MoneyText :amount="s.netMinor" :class="s.netMinor < 0 && 'text-negative'" /></span>
        <ChevronDown class="size-4 shrink-0 text-muted-foreground transition-transform" :class="!open && '-rotate-90'" />
      </template>
    </component>

    <template v-if="open && s">
      <p v-if="!s.transactionCount && !s.excluded.categories.length" class="border-t px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing in this period yet.
      </p>
      <template v-else>
        <!-- Income -->
        <section class="border-t px-2 py-2" aria-label="Income">
          <div class="flex items-baseline justify-between px-2 py-1">
            <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Income</span>
            <span class="text-right">
              <MoneyText :amount="s.incomeMinor" class="text-sm font-medium" />
              <span v-if="perMonth(s.incomeMinor)" class="block text-[11px] text-muted-foreground">{{ perMonth(s.incomeMinor) }}</span>
            </span>
          </div>
          <button
            v-for="c in s.income"
            :key="key(c)"
            type="button"
            :aria-pressed="isActive(c)"
            :class="cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted/60', isActive(c) && 'bg-muted')"
            @click="emit('filter', key(c))"
          >
            <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
            <MoneyText :amount="c.amountMinor" :colored="false" class="text-muted-foreground" />
          </button>
        </section>

        <!-- Spending by your category labels, across the groups -->
        <section v-if="labelRows" class="border-t px-2 py-2" aria-label="Labels">
          <div class="flex items-baseline justify-between px-2 py-1">
            <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Labels</span>
            <span class="text-[11px] text-muted-foreground">{{ labelRows.ofIncome ? 'of income' : 'of spending' }}</span>
          </div>
          <component
            :is="r.key === 'left' ? 'div' : 'button'"
            v-for="r in labelRows.rows"
            :key="r.key"
            :type="r.key === 'left' ? undefined : 'button'"
            :aria-pressed="r.key === 'left' ? undefined : activeLabel === r.key"
            :class="
              cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm',
                r.key !== 'left' && 'hover:bg-muted/60',
                r.key !== 'left' && activeLabel === r.key && 'bg-muted',
              )
            "
            @click="r.key !== 'left' && emit('label', r.key)"
          >
            <span class="size-2 shrink-0 rounded-full" :style="{ background: r.color }" />
            <span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
            <span class="text-xs text-muted-foreground tabular">{{ r.share }}</span>
            <MoneyText v-if="r.income" :amount="r.amount" class="w-24 text-right" />
            <span v-else class="w-24 text-right tabular" :class="r.amount < 0 && 'text-negative'">{{ money(r.amount) }}</span>
          </component>
        </section>
        <p v-else-if="isDesktop && !allLabels.length && s.spentMinor" class="border-t px-4 py-2 text-xs text-muted-foreground">
          Sort spending your own way, like needs and wants:
          <RouterLink :to="{ name: 'ledger-settings', query: { tab: 'categories' } }" class="underline underline-offset-2 hover:text-foreground">
            label your categories</RouterLink
          >.
        </p>

        <!-- Spending by group -->
        <section class="border-t px-2 py-2" aria-label="Expenses">
          <div class="flex items-baseline justify-between px-2 py-1">
            <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Expenses</span>
            <span class="text-right">
              <span class="tabular text-sm font-medium">{{ money(s.spentMinor) }}</span>
              <span v-if="perMonth(s.spentMinor)" class="block text-[11px] text-muted-foreground">{{ perMonth(s.spentMinor) }}</span>
            </span>
          </div>
          <div v-for="g in s.expenses" :key="g.groupId ?? 'none'">
            <button
              type="button"
              class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-sm font-medium hover:bg-muted/60"
              :aria-expanded="!folded.has(g.groupId)"
              @click="toggleGroup(g.groupId)"
            >
              <ChevronDown class="size-3.5 shrink-0 text-muted-foreground transition-transform" :class="folded.has(g.groupId) && '-rotate-90'" />
              <!-- Colours are the groups': a category's is its group's. -->
              <span class="mx-1 size-2 shrink-0 rounded-full" :style="{ background: g.categories[0]?.color ?? UNGROUPED_COLOR }" />
              <span class="min-w-0 flex-1 truncate">{{ g.name }}</span>
              <span class="tabular">{{ money(g.amountMinor) }}</span>
            </button>
            <template v-if="!folded.has(g.groupId)">
              <button
                v-for="c in g.categories"
                :key="key(c)"
                type="button"
                :aria-pressed="isActive(c)"
                :class="cn('flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-10 text-left text-sm hover:bg-muted/60', isActive(c) && 'bg-muted')"
                @click="emit('filter', key(c))"
              >
                <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
                <span class="tabular text-muted-foreground">{{ money(c.amountMinor) }}</span>
              </button>
            </template>
          </div>
        </section>

        <!-- Transfers and other money left out of the totals -->
        <section v-if="s.excluded.categories.length" class="border-t px-2 py-2" aria-label="Left out of totals">
          <div class="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Left out of totals</div>
          <component
            :is="c.categoryId ? 'button' : 'div'"
            v-for="c in s.excluded.categories"
            :key="key(c)"
            :type="c.categoryId ? 'button' : undefined"
            :class="cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm', c.categoryId && 'hover:bg-muted/60', isActive(c) && 'bg-muted')"
            @click="c.categoryId && emit('filter', c.categoryId)"
          >
            <Ban class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
            <MoneyText :amount="c.amountMinor" :colored="false" class="text-muted-foreground" />
          </component>
        </section>

        <div class="flex items-baseline justify-between border-t px-4 py-3">
          <span class="text-sm font-semibold">Net income</span>
          <span class="text-right">
            <MoneyText :amount="s.netMinor" class="text-sm font-semibold" :class="s.netMinor < 0 && 'text-negative'" />
            <span v-if="perMonth(s.netMinor)" class="block text-[11px] text-muted-foreground">{{ perMonth(s.netMinor) }}</span>
          </span>
        </div>
      </template>
    </template>
  </Card>
</template>
