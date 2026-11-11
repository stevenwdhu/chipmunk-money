<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArrowDownRight, ArrowUpRight, CalendarClock, FileInput, Plus, Sparkles, Wallet } from '@lucide/vue'
import { formatMonth, formatMonthShort, addMonths, monthRange, type CategoryAmount, type Transaction } from '@st/shared'
import CategoryBars from '@/components/CategoryBars.vue'
import EmptyState from '@/components/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import MonthSwitcher from '@/components/MonthSwitcher.vue'
import TransactionList from '@/components/TransactionList.vue'
import UpcomingList from '@/components/UpcomingList.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAccounts, useSummary, useTransactionMutations, useTransactions, useUpcoming } from '@/composables/queries'
import { useSelectedMonth, useToday } from '@/composables/useToday'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { errorMessage } from '@/lib/api'
import { money, percent } from '@/lib/format'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const isDesktop = useIsDesktop()
const router = useRouter()
const today = useToday()
const { month, isCurrent } = useSelectedMonth()
const range = computed(() => monthRange(month.value))

const accounts = useAccounts()
const summary = useSummary(month)
// The latest transactions: at least MIN_ROWS, and on a wide screen as many as fit beside the cards on
// the right (the grid makes the card as tall as they are).
const MIN_ROWS = 8
const recent = useTransactions(() => ({ from: range.value.from, to: range.value.to }), 30)
const upcoming = useUpcoming(14)
const m = useTransactionMutations()

const s = computed(() => summary.data.value)
const recentItems = computed(() => recent.data.value?.pages[0]?.items ?? [])

// The list is laid out whole, off the flow, and cut after the last row that fits: the card's own height
// comes from its first MIN_ROWS rows, so it never grows to fit more. Rows cut off can't be tabbed to.
// (One list, not two, so every row's columns line up.)
const listBox = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const fit = reactive({ min: 0, bottom: 0 })
function measure() {
  const box = listBox.value
  const list = listEl.value
  if (!box || !list) return
  const top = list.getBoundingClientRect().top
  const rows = [...list.querySelectorAll<HTMLElement>('[data-tx-id]')]
  const bottoms = rows.map((r) => r.getBoundingClientRect().bottom - top)
  const least = Math.min(MIN_ROWS, bottoms.length)
  fit.min = least ? bottoms[least - 1]! : 0
  const room = Math.max(box.clientHeight, fit.min)
  const fits = bottoms.findIndex((b) => b > room + 0.5)
  const shown = Math.max(least, fits < 0 ? bottoms.length : fits)
  fit.bottom = shown ? bottoms[shown - 1]! : 0
  rows.forEach((r, i) => (r.inert = i >= shown))
}
// Again when the card's height changes (the cards beside it), and when the rows do (data, width).
watch(
  [listBox, listEl],
  ([box, list], _, onCleanup) => {
    if (!box || !list?.firstElementChild) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(box)
    observer.observe(list.firstElementChild)
    onCleanup(() => observer.disconnect())
  },
  { flush: 'post' },
)
watch(recentItems, () => nextTick(measure))
const netWorth = computed(() => accounts.active.value.reduce((n, a) => n + a.balanceMinor, 0))
const hasAccounts = computed(() => (accounts.data.value?.length ?? 0) > 0)

const spentChange = computed(() => {
  if (!s.value || !s.value.previousSpentMinor) return null
  return (s.value.spentMinor - s.value.previousSpentMinor) / s.value.previousSpentMinor
})
const prevMonthName = computed(() => formatMonthShort(addMonths(month.value, -1)))

function openTx(tx: Transaction) {
  ui.openEdit(tx)
}
async function accept(tx: Transaction) {
  try {
    const saved = await m.accept.mutateAsync(tx.id)
    ui.askAboutPayee(saved, saved.categoryId, true)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
function showCategory(c: CategoryAmount) {
  router.push({
    name: 'transactions',
    query: { month: isCurrent.value ? undefined : month.value, categoryId: c.categoryId ?? 'none' },
  })
}
</script>

<template>
  <PageHeader title="Overview">
    <template #actions>
      <MonthSwitcher />
      <Button class="ml-2 hidden md:inline-flex" @click="ui.openAdd()"><Plus />Add transaction</Button>
    </template>
  </PageHeader>

  <main class="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
    <Card v-if="accounts.isSuccess.value && !hasAccounts">
      <EmptyState
        :icon="Wallet"
        title="Welcome to Spending Tracker"
        description="Start by adding the accounts you spend from: chequing, credit cards, cash. You can also import a CSV export from your bank."
      >
        <Button as-child><RouterLink :to="{ name: 'accounts', query: { new: '1' } }"><Plus />Add an account</RouterLink></Button>
        <Button v-if="isDesktop" as-child variant="outline"><RouterLink :to="{ name: 'import' }"><FileInput />Import a CSV</RouterLink></Button>
      </EmptyState>
    </Card>

    <template v-else>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        <Card class="col-span-2 gap-1 py-4 md:col-span-1">
          <CardHeader class="px-4">
            <CardDescription>Spent in {{ formatMonth(month).split(' ')[0] }}</CardDescription>
            <CardTitle class="text-2xl tabular">
              <Skeleton v-if="!s" class="h-8 w-32" />
              <template v-else>{{ money(s.spentMinor) }}</template>
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-xs">
            <span
              v-if="spentChange !== null"
              class="inline-flex items-center gap-0.5"
              :class="spentChange <= 0 ? 'text-positive' : 'text-negative'"
            >
              <component :is="spentChange <= 0 ? ArrowDownRight : ArrowUpRight" class="size-3.5" />
              {{ percent(Math.abs(spentChange), 1) }} vs {{ prevMonthName }}
            </span>
            <span v-if="s?.averageSpentMinor" class="text-muted-foreground">3-month avg {{ money(s.averageSpentMinor) }}</span>
          </CardContent>
        </Card>
        <Card class="gap-1 py-4">
          <CardHeader class="px-4">
            <CardDescription>Income</CardDescription>
            <CardTitle class="text-lg tabular md:text-2xl">
              <Skeleton v-if="!s" class="h-7 w-24" />
              <template v-else>{{ money(s.incomeMinor) }}</template>
            </CardTitle>
          </CardHeader>
          <CardContent class="px-4 text-xs text-muted-foreground">
            <template v-if="s && s.savingsRate !== null">
              Saved {{ money(s.netMinor) }}
              <span :class="s.netMinor >= 0 ? 'text-positive' : 'text-negative'">({{ percent(s.savingsRate) }})</span>
            </template>
            <template v-else>No income yet</template>
          </CardContent>
        </Card>
        <Card class="gap-1 py-4">
          <CardHeader class="px-4">
            <CardDescription>Net worth</CardDescription>
            <CardTitle class="text-lg tabular md:text-2xl">{{ money(netWorth) }}</CardTitle>
          </CardHeader>
          <CardContent class="px-4 text-xs">
            <RouterLink :to="{ name: 'accounts' }" class="text-muted-foreground hover:text-foreground hover:underline">
              {{ accounts.active.value.length }} account{{ accounts.active.value.length === 1 ? '' : 's' }}
            </RouterLink>
          </CardContent>
        </Card>
      </div>

      <div
        v-if="s && s.needsReviewCount > 0"
        class="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-ai bg-ai-soft px-4 py-3"
      >
        <Sparkles class="size-5 shrink-0 text-ai" />
        <div class="min-w-0 flex-1 text-sm">
          <span class="font-medium">{{ s.needsReviewCount }} suggested categor{{ s.needsReviewCount === 1 ? 'y' : 'ies' }} to review.</span>
          <span class="text-muted-foreground"> Set one, and choose whether its payee is always set that way.</span>
        </div>
        <Button size="sm" variant="outline" as-child>
          <RouterLink :to="{ name: 'transactions', query: { needsReview: '1', period: 'all' } }">Review</RouterLink>
        </Button>
      </div>

      <div class="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
        <Card class="gap-0 overflow-hidden py-0 lg:col-span-2">
          <CardHeader class="px-4 py-4 md:px-6">
            <CardTitle>Transactions in {{ formatMonth(month).split(' ')[0] }}</CardTitle>
            <CardDescription>
              {{ s ? `${s.transactionCount} transaction${s.transactionCount === 1 ? '' : 's'}` : 'Loading…' }}
              <template v-if="s?.uncategorizedCount"> · {{ s.uncategorizedCount }} uncategorized</template>
            </CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" as-child>
                <RouterLink :to="{ name: 'transactions', query: { month: isCurrent ? undefined : month } }">View all</RouterLink>
              </Button>
            </CardAction>
          </CardHeader>
          <div v-if="recentItems.length" ref="listBox" class="relative flex-1 border-t" :style="{ minHeight: `${fit.min}px` }">
            <div ref="listEl" class="absolute inset-x-0 top-0 overflow-hidden" :style="{ maxHeight: `${fit.bottom}px` }">
              <TransactionList :items="recentItems" :today="today" show-account @open="openTx" @accept="accept" />
            </div>
          </div>
          <div v-else-if="recent.isSuccess.value" class="border-t">
            <EmptyState title="Nothing this month yet" description="Add a transaction with the + button, or import a CSV from your bank.">
              <Button size="sm" @click="ui.openAdd()"><Plus />Add transaction</Button>
            </EmptyState>
          </div>
        </Card>

        <div class="flex flex-col gap-4 md:gap-6">
          <Card class="gap-4">
            <CardHeader>
              <CardTitle>Spending by category</CardTitle>
              <CardDescription v-if="s">{{ money(s.spentMinor) }} in {{ formatMonth(month) }}</CardDescription>
            </CardHeader>
            <CardContent>
              <CategoryBars v-if="s?.byCategory.length" :items="s.byCategory" :total="s.spentMinor" @select="showCategory" />
              <p v-else class="text-sm text-muted-foreground">No spending recorded for this month.</p>
            </CardContent>
          </Card>

          <Card v-if="isCurrent" class="gap-2">
            <CardHeader>
              <CardTitle>Coming up</CardTitle>
              <CardDescription>Recurring payments in the next 2 weeks</CardDescription>
              <CardAction>
                <Button variant="ghost" size="sm" as-child><RouterLink :to="{ name: 'recurring' }">All</RouterLink></Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <UpcomingList v-if="upcoming.data.value?.length" :items="upcoming.data.value" :today="today" />
              <div v-else class="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <CalendarClock class="size-4" />Nothing due. Confirm recurring items to see them here.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </template>
  </main>
</template>
