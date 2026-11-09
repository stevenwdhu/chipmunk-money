<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { AlertTriangle, ChevronRight, Eye, EyeOff, Pencil, Plus, Radar, Repeat, TrendingUp, X } from '@lucide/vue'
import { CADENCES, formatDateShort, recurringLabel as label, type RecurringItem } from '@st/shared'
import CategoryBadge from '@/components/CategoryBadge.vue'
import EmptyState from '@/components/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import MoneyText from '@/components/MoneyText.vue'
import RecurringDialog from '@/components/RecurringDialog.vue'
import RecurringPayments from '@/components/RecurringPayments.vue'
import UpcomingList from '@/components/UpcomingList.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAccounts, useCategories, useRecurring, useRecurringMutations, useUpcoming } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { money, relativeDayInline, shortDate } from '@/lib/format'

const today = useToday()
const all = useRecurring()
const upcoming = useUpcoming(30)
const m = useRecurringMutations()
const { byId: categories } = useCategories()
const { byId: accounts } = useAccounts()

const tab = ref('active')
const dialogOpen = ref(false)
const editing = ref<RecurringItem | null>(null)

/** Recurring covers bills, subscriptions and income (no end), and instalment plans (a set number of payments). */
const isPlan = (i: RecurringItem) => i.totalPayments !== null
const items = computed(() => all.data.value ?? [])
const active = computed(() => items.value.filter((i) => i.status === 'active'))
const activeGroups = computed(() =>
  [
    { label: 'Bills, subscriptions & income', items: active.value.filter((i) => !isPlan(i)) },
    { label: 'Instalments', items: active.value.filter(isPlan) },
  ].filter((g) => g.items.length),
)
const suggested = computed(() => items.value.filter((i) => i.status === 'suggested'))
// Suggestions whose payments have stopped (Ended) can be hidden, and then they aren't counted on the tab. This device remembers.
const HISTORY_HIDDEN = 'st-recurring-history-hidden'
function readHistoryHidden() {
  try {
    return localStorage.getItem(HISTORY_HIDDEN) === '1'
  } catch {
    return false
  }
}
const historyHidden = ref(readHistoryHidden())
watch(historyHidden, (hidden) => {
  try {
    localStorage.setItem(HISTORY_HIDDEN, hidden ? '1' : '0')
  } catch {
    // Private mode etc.: it's hidden until the page reloads.
  }
})
const suggestedCount = computed(() => suggested.value.filter((i) => !(historyHidden.value && i.stopped)).length)
// Still going (always shown, empty or not), and stopped ones (kept in Ended when confirmed).
const suggestedGroups = computed(() =>
  [
    { label: 'Ongoing', history: false, hint: null, items: suggested.value.filter((i) => !i.stopped) },
    { label: 'Ended', history: true, hint: 'Payments that have stopped. Confirming one moves it to the Ended tab.', items: suggested.value.filter((i) => i.stopped) },
  ].filter((g) => !g.history || g.items.length),
)
const ended = computed(() => items.value.filter((i) => i.status === 'ended'))
const dismissed = computed(() => items.value.filter((i) => i.status === 'dismissed'))
const bills = computed(() => active.value.filter((i) => i.expectedAmountMinor < 0 && !isPlan(i)))
const monthlyBills = computed(() => bills.value.reduce((n, i) => n + i.monthlyCostMinor, 0))
const monthlyIncome = computed(() => active.value.filter((i) => i.expectedAmountMinor > 0).reduce((n, i) => n + i.monthlyCostMinor, 0))
const plans = computed(() => active.value.filter(isPlan))
const owed = computed(() => plans.value.reduce((n, i) => n + (i.remainingAmountMinor ?? 0), 0))
const lastPlanEnd = computed(() => plans.value.map((i) => i.endDate ?? '').sort().at(-1) || null)
const upcomingTotal = computed(() => (upcoming.data.value ?? []).filter((u) => u.amountMinor < 0).reduce((n, u) => n + u.amountMinor, 0))

const cadenceLabel = (c: string) => CADENCES.find((x) => x.value === c)?.label ?? c
const paidOff = (i: RecurringItem) => i.remainingPayments === 0
const progress = (i: RecurringItem) => (i.totalPayments ? Math.min(100, (i.paidPayments / i.totalPayments) * 100) : 0)
/** "3 of 4 paid · ends Jun 5". */
const planText = (i: RecurringItem) =>
  `${i.paidPayments} of ${i.totalPayments} paid${i.endDate ? ` · ${i.remainingPayments ? 'ends' : 'ended'} ${shortDate(i.endDate, today.value)}` : ''}`

/** Rows unfolded to show their payments. */
const unfolded = ref(new Set<number>())
function unfold(id: number) {
  const next = new Set(unfolded.value)
  if (!next.delete(id)) next.add(id)
  unfolded.value = next
}
function edit(item: RecurringItem | null) {
  editing.value = item
  dialogOpen.value = true
}
async function run<T>(p: Promise<T>, msg: string) {
  try {
    await p
    toast.success(msg)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
/** The payment is the item's: its payee is added, so later ones match too. */
async function linkPayment(item: RecurringItem) {
  const p = item.possiblePayment!
  await run(m.linkPayment.mutateAsync({ id: item.id, transactionId: p.transactionId }), `Linked. Payments from ${p.payee} match ${label(item)} too.`)
}
function notPayment(item: RecurringItem) {
  void m.notPayment.mutateAsync({ id: item.id, transactionId: item.possiblePayment!.transactionId }).catch((err) => toast.error(errorMessage(err)))
}
async function detect() {
  try {
    const { created } = await m.detect.mutateAsync()
    toast.success(created ? `Found ${created} new recurring payment${created === 1 ? '' : 's'}` : 'No new recurring payments found')
    if (created) tab.value = 'suggested'
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <PageHeader title="Recurring">
    <template #actions>
      <Button variant="outline" size="sm" :disabled="m.detect.isPending.value" @click="detect"><Radar />Scan</Button>
      <Button size="sm" @click="edit(null)"><Plus /><span class="hidden sm:inline">Add</span></Button>
    </template>
  </PageHeader>

  <main class="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
    <div class="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
      <Card class="gap-1 py-4">
        <CardHeader class="px-4"><CardDescription>Bills & subscriptions</CardDescription>
          <CardTitle class="text-lg tabular md:text-2xl">{{ money(-monthlyBills || 0) }}<span class="text-sm font-normal text-muted-foreground"> /mo</span></CardTitle>
        </CardHeader>
        <CardContent class="px-4 text-xs text-muted-foreground">{{ bills.length }} active</CardContent>
      </Card>
      <Card class="gap-1 py-4">
        <CardHeader class="px-4"><CardDescription>Instalments left</CardDescription>
          <CardTitle class="text-lg tabular md:text-2xl">{{ money(-owed || 0) }}</CardTitle>
        </CardHeader>
        <CardContent class="px-4 text-xs text-muted-foreground">
          <template v-if="plans.length">{{ plans.length }} plan{{ plans.length === 1 ? '' : 's' }}<template v-if="lastPlanEnd"> · last ends {{ shortDate(lastPlanEnd, today) }}</template></template>
          <template v-else>No plans</template>
        </CardContent>
      </Card>
      <Card class="gap-1 py-4">
        <CardHeader class="px-4"><CardDescription>Recurring income</CardDescription>
          <CardTitle class="text-lg tabular md:text-2xl">{{ money(monthlyIncome) }}<span class="text-sm font-normal text-muted-foreground"> /mo</span></CardTitle>
        </CardHeader>
        <CardContent class="px-4 text-xs text-muted-foreground">Monthly equivalent</CardContent>
      </Card>
      <Card class="gap-1 py-4">
        <CardHeader class="px-4"><CardDescription>Due in the next 30 days</CardDescription>
          <CardTitle class="text-lg tabular md:text-2xl">{{ money(-upcomingTotal || 0) }}</CardTitle>
        </CardHeader>
        <CardContent class="px-4 text-xs text-muted-foreground">{{ upcoming.data.value?.filter((u) => u.amountMinor < 0).length ?? 0 }} payments</CardContent>
      </Card>
    </div>

    <div class="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
      <div class="lg:col-span-2">
        <Tabs v-model="tab">
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="suggested">
              Suggested <Badge v-if="suggestedCount" variant="secondary" class="ml-1 h-5 px-1.5">{{ suggestedCount }}</Badge>
            </TabsTrigger>
            <TabsTrigger value="ended">Ended</TabsTrigger>
            <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
          </TabsList>

          <TabsContent value="active">
            <Card class="gap-0 overflow-hidden py-0">
              <template v-if="active.length">
                <section v-for="g in activeGroups" :key="g.label" class="border-b last:border-b-0">
                  <h3 v-if="activeGroups.length > 1" class="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground md:px-6">{{ g.label }}</h3>
                  <ul class="divide-y">
                    <li v-for="item in g.items" :key="item.id">
                      <div class="flex items-center gap-2 pr-4 hover:bg-muted/50 md:pr-6">
                        <button
                          type="button"
                          class="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left md:pl-6"
                          :aria-expanded="unfolded.has(item.id)"
                          @click="unfold(item.id)"
                        >
                          <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform" :class="unfolded.has(item.id) && 'rotate-90'" />
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <span class="truncate text-sm font-medium">{{ label(item) }}</span>
                              <CategoryBadge v-if="item.categoryId" :category-id="item.categoryId" class="hidden sm:inline-flex" />
                              <span v-if="item.alerts.includes('missing') && !item.possiblePayment" class="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                                <AlertTriangle class="size-3" />Not seen
                              </span>
                              <span v-if="item.alerts.includes('price_changed')" class="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning" :title="`Last charge was ${money(item.lastAmountMinor ?? 0)}`">
                                <TrendingUp class="size-3" />Price changed
                              </span>
                            </div>
                            <div class="text-xs text-muted-foreground sm:truncate">
                              {{ cadenceLabel(item.cadence) }} · next {{ relativeDayInline(item.nextDueDate, today) }}
                              <template v-if="item.accountId"> · {{ accounts.get(item.accountId)?.name }}</template>
                            </div>
                            <CategoryBadge v-if="item.categoryId" :category-id="item.categoryId" class="mt-1 max-w-full sm:hidden" />
                            <template v-if="isPlan(item)">
                              <Progress :model-value="progress(item)" class="mt-1.5 h-1.5" :aria-label="`${label(item)}: ${planText(item)}`" />
                              <div class="mt-1 text-xs text-muted-foreground sm:truncate">{{ planText(item) }}</div>
                            </template>
                          </div>
                          <div class="text-right">
                            <MoneyText :amount="item.expectedAmountMinor" class="text-sm font-medium" />
                            <div v-if="isPlan(item) && item.remainingAmountMinor" class="text-xs text-muted-foreground tabular">{{ money(-item.remainingAmountMinor) }} left</div>
                            <div v-else-if="item.alerts.includes('price_changed') && item.lastAmountMinor !== null" class="text-xs text-warning tabular">
                              last {{ money(item.lastAmountMinor) }}
                            </div>
                          </div>
                        </button>
                        <Button variant="ghost" size="icon-sm" class="text-muted-foreground" :aria-label="`Edit ${label(item)}`" @click="edit(item)"><Pencil /></Button>
                      </div>
                      <!-- A payment from a similar payee near the due date: the bank may have renamed it. -->
                      <div
                        v-if="item.possiblePayment"
                        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-warning/20 bg-warning/10 py-2 pr-4 pl-11 text-sm md:pr-6 md:pl-13"
                      >
                        <span class="min-w-0 flex-1">
                          Is <span class="font-medium">{{ item.possiblePayment.payee }}</span>’s
                          <span class="tabular">{{ money(Math.abs(item.possiblePayment.amountMinor)) }}</span> on {{ shortDate(item.possiblePayment.date, today) }} its
                          {{ shortDate(item.possiblePayment.dueDate, today) }} payment?
                          <span v-if="item.possiblePayment.newAmount" class="text-muted-foreground">
                            It’d be its amount from now on, instead of <span class="tabular">{{ money(Math.abs(item.expectedAmountMinor)) }}</span>.
                          </span>
                        </span>
                        <span class="flex gap-1">
                          <Button size="xs" :disabled="m.linkPayment.isPending.value" @click="linkPayment(item)">Yes, link it</Button>
                          <Button size="xs" variant="ghost" :disabled="m.notPayment.isPending.value" @click="notPayment(item)">No</Button>
                        </span>
                      </div>
                      <RecurringPayments v-if="unfolded.has(item.id)" :item="item" />
                    </li>
                  </ul>
                </section>
              </template>
              <EmptyState v-else :icon="Repeat" title="No recurring items yet" description="Scan your history to find bills, subscriptions and instalment plans, or add one by hand.">
                <Button size="sm" variant="outline" @click="detect"><Radar />Scan history</Button>
                <Button size="sm" @click="edit(null)"><Plus />Add by hand</Button>
              </EmptyState>
            </Card>
          </TabsContent>

          <TabsContent value="suggested">
            <div class="grid gap-6">
              <section v-for="g in suggestedGroups" :key="g.label" class="grid gap-3">
                <div class="flex items-start justify-between gap-3 px-1">
                  <div class="grid gap-0.5">
                    <h3 class="text-sm font-medium">{{ g.label }} <span class="font-normal text-muted-foreground tabular">{{ g.items.length }}</span></h3>
                    <p v-if="g.hint" class="text-xs text-muted-foreground">{{ g.hint }}</p>
                  </div>
                  <Button v-if="g.history" variant="ghost" size="sm" class="-my-1 h-7 shrink-0 text-xs" :aria-expanded="!historyHidden" @click="historyHidden = !historyHidden">
                    <component :is="historyHidden ? Eye : EyeOff" />{{ historyHidden ? 'Show' : 'Hide' }}
                  </Button>
                </div>
                <Card v-if="!g.history && !g.items.length">
                  <EmptyState :icon="Radar" title="Nothing ongoing right now" description="New patterns are checked every day and after each import and sync." />
                </Card>
                <div v-else-if="!(g.history && historyHidden)" class="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
                  <Card v-for="item in g.items" :key="item.id" class="gap-3 overflow-hidden pt-4 pb-0">
                    <CardHeader class="px-4">
                      <!-- The amounts float, so the description wraps beside them and then takes the full width. -->
                      <div>
                        <div class="float-right ml-2 text-right">
                          <MoneyText :amount="item.expectedAmountMinor" class="text-sm font-semibold" />
                          <div v-if="paidOff(item)" class="text-xs text-muted-foreground tabular">full price {{ money(-item.totalAmountMinor!) }}</div>
                        </div>
                        <CardTitle class="truncate text-base leading-5">{{ label(item) }}</CardTitle>
                        <CardDescription class="mt-1.5">
                          <template v-if="isPlan(item)">{{ cadenceLabel(item.cadence) }} · {{ planText(item) }}</template>
                          <template v-else>
                            {{ cadenceLabel(item.cadence) }} · seen {{ item.occurrences }} times<template v-if="item.lastSeenDate">, last {{ formatDateShort(item.lastSeenDate) }}</template>
                          </template>
                          <template v-if="item.categoryId"> · {{ categories.get(item.categoryId)?.name }}</template>
                        </CardDescription>
                      </div>
                      <p v-if="item.instalmentService && !isPlan(item)" class="text-xs text-muted-foreground">Looks like an instalment plan. Review it to say how many payments it has.</p>
                    </CardHeader>
                    <CardContent class="flex flex-wrap gap-2 px-4">
                      <Button size="sm" @click="edit(item)">Review</Button>
                      <Button size="sm" variant="ghost" class="ml-auto" @click="run(m.dismiss.mutateAsync(item.id), `Dismissed ${label(item)}`)"><X />Dismiss</Button>
                    </CardContent>
                    <!-- The payments the scan found, to check before you confirm. -->
                    <button
                      type="button"
                      class="flex w-full items-center gap-1.5 border-t px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      :aria-expanded="unfolded.has(item.id)"
                      @click="unfold(item.id)"
                    >
                      <ChevronRight class="size-3.5 transition-transform" :class="unfolded.has(item.id) && 'rotate-90'" />
                      {{ item.occurrences }} payment{{ item.occurrences === 1 ? '' : 's' }}
                    </button>
                    <RecurringPayments v-if="unfolded.has(item.id)" :item="item" card class="-mt-3" />
                  </Card>
                </div>
              </section>
            </div>
          </TabsContent>

          <TabsContent value="ended">
            <Card class="gap-0 overflow-hidden py-0">
              <ul v-if="ended.length" class="divide-y">
                <li v-for="item in ended" :key="item.id">
                  <div class="flex items-center gap-2 pr-4 text-sm hover:bg-muted/50 md:pr-6">
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left md:pl-6"
                      :aria-expanded="unfolded.has(item.id)"
                      @click="unfold(item.id)"
                    >
                      <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform" :class="unfolded.has(item.id) && 'rotate-90'" />
                      <div class="min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="truncate font-medium">{{ label(item) }}</span>
                          <CategoryBadge v-if="item.categoryId" :category-id="item.categoryId" class="hidden sm:inline-flex" />
                        </div>
                        <div class="text-xs text-muted-foreground">
                          <template v-if="isPlan(item) && !item.remainingPayments">Paid off · {{ planText(item) }}</template>
                          <template v-else>Stopped · {{ cadenceLabel(item.cadence) }}<template v-if="isPlan(item)"> · {{ planText(item) }}</template></template>
                        </div>
                        <CategoryBadge v-if="item.categoryId" :category-id="item.categoryId" class="mt-1 max-w-full sm:hidden" />
                      </div>
                      <div v-if="isPlan(item)" class="ml-auto shrink-0 text-right">
                        <MoneyText :amount="item.expectedAmountMinor" class="text-sm font-medium" />
                        <div class="text-xs text-muted-foreground tabular">full price {{ money(-item.totalAmountMinor!) }}</div>
                      </div>
                    </button>
                    <Button variant="ghost" size="icon-sm" class="text-muted-foreground" :aria-label="`Edit ${label(item)}`" @click="edit(item)"><Pencil /></Button>
                  </div>
                  <RecurringPayments v-if="unfolded.has(item.id)" :item="item" />
                </li>
              </ul>
              <EmptyState v-else title="Nothing ended" description="Instalment plans you’ve paid off, and items you stop tracking, are listed here." />
            </Card>
          </TabsContent>

          <TabsContent value="dismissed">
            <Card class="gap-0 py-0">
              <ul v-if="dismissed.length" class="divide-y">
                <li v-for="item in dismissed" :key="item.id" class="flex items-center justify-between gap-3 px-4 py-3 text-sm md:px-6">
                  <div class="min-w-0">
                    <div class="truncate font-medium">{{ label(item) }}</div>
                    <div class="text-xs text-muted-foreground">Dismissed · {{ cadenceLabel(item.cadence) }}</div>
                  </div>
                  <div class="flex gap-1">
                    <Button size="sm" variant="outline" @click="run(m.confirm.mutateAsync(item.id), `Tracking ${label(item)}`)">Track</Button>
                    <Button size="sm" variant="ghost" @click="run(m.remove.mutateAsync(item.id), 'Deleted')">Delete</Button>
                  </div>
                </li>
              </ul>
              <EmptyState v-else title="Nothing dismissed" description="Suggestions you dismiss are listed here so they are never suggested again." />
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Card class="gap-2 self-start">
        <CardHeader>
          <CardTitle>Next 30 days</CardTitle>
          <CardDescription>Expected from active items</CardDescription>
        </CardHeader>
        <CardContent>
          <UpcomingList v-if="upcoming.data.value?.length" :items="upcoming.data.value" :today="today" />
          <p v-else class="text-sm text-muted-foreground">Nothing expected.</p>
        </CardContent>
      </Card>
    </div>
  </main>

  <RecurringDialog v-model:open="dialogOpen" :item="editing" />
</template>
