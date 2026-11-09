<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Ellipsis, Landmark, Pencil, Plus, RefreshCw, X } from '@lucide/vue'
import { ACCOUNT_TYPES, accountTypeInfo, formatDateShort, formatMonthShort, statementBalance, type Account, type AccountType, type Institution } from '@st/shared'
import AccountFormDialog from '@/components/AccountFormDialog.vue'
import LineChart from '@/components/charts/LineChart.vue'
import EmptyState from '@/components/EmptyState.vue'
import InfoTip from '@/components/InfoTip.vue'
import InstitutionDialog from '@/components/InstitutionDialog.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import MoneyText from '@/components/MoneyText.vue'
import SegmentedToggle from '@/components/SegmentedToggle.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAccounts, useInstitutionMutations, useInstitutions, useNetWorth } from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { errorMessage } from '@/lib/api'
import { money, timeAgo } from '@/lib/format'
import { currentLedger } from '@/lib/ledger'
import { cn } from '@/lib/utils'

const route = useRoute()
const router = useRouter()
const accounts = useAccounts()
const institutions = useInstitutions()
const instM = useInstitutionMutations()
const isDesktop = useIsDesktop()
const range = ref(12)
const netWorth = useNetWorth(range)

const formOpen = ref(false)
/** Set when you add an account from App settings → Bank sync: it starts out synced from that bank account. */
const newFromBank = ref<string | null>(null)
/** Set when you add an account from an institution's menu. */
const newIn = ref<number | null>(null)
watch(
  () => route.query.new,
  (v) => {
    if (v === '1') {
      newFromBank.value = typeof route.query.bank === 'string' ? route.query.bank : null
      formOpen.value = true
      router.replace({ query: {} })
    }
  },
  { immediate: true },
)
watch(formOpen, (v) => {
  if (v) return
  newFromBank.value = null
  newIn.value = null
})
function addTo(i: Institution) {
  newIn.value = i.id
  formOpen.value = true
}

/**
 * Balances as the bank shows them: what you have, or what you owe on a debt. A total of only debts is
 * what you owe on them; one that mixes in other accounts is what's left after the debts.
 */
function total(list: Account[]) {
  const debts = list.length > 0 && list.every((a) => a.isLiability)
  const amount = list.reduce((n, a) => n + (debts ? statementBalance(a.balanceMinor, a.type) : a.balanceMinor), 0)
  return { amount, negative: !debts && amount < 0 }
}
const overdrawn = (a: Account) => !a.isLiability && a.balanceMinor < 0

/** Narrows the list to one account type, from the overview on the side. */
const typeFilter = ref<AccountType | null>(null)
const listEl = ref<HTMLElement | null>(null)
function filterBy(type: AccountType) {
  typeFilter.value = typeFilter.value === type ? null : type
  // On a phone the overview sits below the list.
  listEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}
const byType = computed(() =>
  ACCOUNT_TYPES.map((t) => {
    const list = accounts.active.value.filter((a) => a.type === t.value)
    return { value: t.value, label: t.label, count: list.length, total: total(list) }
  }).filter((t) => t.count),
)
watch(byType, (types) => {
  if (typeFilter.value && !types.some((t) => t.value === typeFilter.value)) typeFilter.value = null
})

/** Open accounts under their institutions, in your order. Institutions without any still show, so you can edit them. */
const groups = computed(() =>
  (institutions.data.value ?? [])
    .map((institution) => {
      const open = accounts.active.value.filter((a) => a.institutionId === institution.id)
      const list = typeFilter.value ? open.filter((a) => a.type === typeFilter.value) : open
      const archived = (accounts.data.value ?? []).filter((a) => a.institutionId === institution.id && a.archived).length
      return { institution, accounts: list, total: total(list), archived }
    })
    .filter((g) => !typeFilter.value || g.accounts.length),
)
const archived = computed(() => (accounts.data.value ?? []).filter((a) => a.archived))
const showArchived = ref(false)

// Collapsed institutions, remembered per ledger on this device.
const collapseKey = computed(() => `accounts.collapsed:${currentLedger.value}`)
const collapsed = ref(new Set<number>())
watch(
  collapseKey,
  (key) => {
    try {
      collapsed.value = new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as number[])
    } catch {
      collapsed.value = new Set()
    }
  },
  { immediate: true },
)
function toggle(id: number) {
  const next = new Set(collapsed.value)
  if (!next.delete(id)) next.add(id)
  collapsed.value = next
  try {
    localStorage.setItem(collapseKey.value, JSON.stringify([...next]))
  } catch {
    // Private browsing: it just won't be remembered.
  }
}

const editing = ref<Institution | null>(null)
const institutionOpen = ref(false)
function edit(i: Institution) {
  editing.value = i
  institutionOpen.value = true
}
/** Swaps the institution with its neighbour; the sidebar follows the same order. */
async function move(i: Institution, dir: -1 | 1) {
  const ids = (institutions.data.value ?? []).map((x) => x.id)
  const at = ids.indexOf(i.id)
  const other = ids[at + dir]
  if (other === undefined) return
  ids[at + dir] = i.id
  ids[at] = other
  await instM.reorder.mutateAsync(ids).catch((err) => toast.error(errorMessage(err)))
}
const position = (i: Institution) => (institutions.data.value ?? []).findIndex((x) => x.id === i.id)

/** How the balance is kept up to date. */
function status(a: Account): { text: string; warn?: boolean } {
  if (a.bank?.error) return { text: 'Needs attention', warn: true }
  if (a.bank) return { text: a.bank.lastSyncedAt ? `Synced ${timeAgo(a.bank.lastSyncedAt)}` : 'Waiting for first sync' }
  // One whose value moves on its own (an investment, property): when you last recorded it.
  if (accountTypeInfo(a.type).revalued && !a.transactionCount) return { text: a.balanceAsOf ? `Updated ${formatDateShort(a.balanceAsOf)}` : 'No balance yet' }
  return { text: 'Manual' }
}

const current = computed(() => netWorth.data.value?.current)
const points = computed(() =>
  (netWorth.data.value?.points ?? []).map((p, i, all) => ({
    label: i === all.length - 1 ? 'Today' : formatMonthShort(p.date.slice(0, 7)),
    detail: i === all.length - 1 ? `Today` : formatDateShort(p.date),
    value: p.netWorthMinor,
  })),
)
const change = computed(() => {
  const pts = netWorth.data.value?.points
  if (!pts || pts.length < 2) return null
  return pts[pts.length - 1]!.netWorthMinor - pts[0]!.netWorthMinor
})
</script>

<template>
  <PageHeader title="Accounts">
    <template #actions>
      <Button @click="formOpen = true"><Plus /><span class="hidden sm:inline">Add account</span></Button>
    </template>
  </PageHeader>

  <main class="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
    <Card v-if="accounts.isSuccess.value && !accounts.data.value?.length">
      <EmptyState
        :icon="Landmark"
        title="No accounts yet"
        description="Add the accounts you want to track. Their transactions add up to the balance, and for an investment or a house you can record its value whenever you check it."
      >
        <Button @click="formOpen = true"><Plus />Add an account</Button>
      </EmptyState>
    </Card>

    <template v-else>
      <Card class="gap-4">
        <CardHeader>
          <CardDescription class="flex items-center gap-1.5">
            Net worth
            <InfoTip text="What you have minus what you owe: every account’s balance, with what’s owed on credit cards and loans as liabilities." />
          </CardDescription>
          <CardTitle class="text-3xl tabular">{{ current ? money(current.netWorthMinor) : '—' }}</CardTitle>
          <CardAction>
            <SegmentedToggle
              v-model="range"
              label="Range"
              :options="[
                { value: 6, label: '6M' },
                { value: 12, label: '1Y' },
                { value: 24, label: '2Y' },
              ]"
            />
          </CardAction>
          <div v-if="current" class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>Assets <span class="text-foreground tabular">{{ money(current.assetsMinor) }}</span></span>
            <span>Liabilities <span class="text-foreground tabular">{{ money(current.liabilitiesMinor) }}</span></span>
            <span v-if="change !== null">
              <MoneyText :amount="change" signed :colored="false" :class="change >= 0 ? 'text-positive' : 'text-negative'" /> in {{ range === 24 ? '2 years' : `${range} months` }}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <LineChart v-if="points.length" :points="points" chart-label="Net worth over time" :height="200" color="var(--positive)" />
        </CardContent>
      </Card>

      <div class="grid grid-cols-1 items-start gap-4 md:gap-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <div ref="listEl" class="flex min-w-0 scroll-mt-20 flex-col gap-4">
          <Card class="@container gap-0 overflow-hidden py-0">
            <div class="hidden items-center gap-3 border-b px-6 py-2 text-xs font-medium text-muted-foreground @2xl:flex">
              <span class="flex-1">Account</span>
              <span class="w-28">Type</span>
              <span class="w-40">Status</span>
              <span class="w-28 text-right">Balance</span>
              <span class="w-4" />
            </div>
            <button
              v-if="typeFilter"
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border-b px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              @click="typeFilter = null"
            >
              <X class="size-3.5" />Showing {{ accountTypeInfo(typeFilter).label.toLowerCase() }} accounts. Show all
            </button>

            <section v-for="g in groups" :key="g.institution.id" class="border-b last:border-b-0" :aria-labelledby="`inst-${g.institution.id}`">
              <div class="flex items-center gap-2 bg-muted/40 py-1 pr-2 pl-2 md:pr-4 md:pl-4">
                <button
                  :id="`inst-${g.institution.id}`"
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium"
                  :aria-expanded="!collapsed.has(g.institution.id)"
                  @click="toggle(g.institution.id)"
                >
                  <ChevronDown class="size-4 shrink-0 text-muted-foreground transition-transform" :class="collapsed.has(g.institution.id) && '-rotate-90'" />
                  <span class="truncate">{{ g.institution.name }}</span>
                  <span class="shrink-0 font-normal text-muted-foreground">({{ g.accounts.length }})</span>
                </button>
                <MoneyText v-if="g.accounts.length" :amount="g.total.amount" :colored="false" class="text-sm font-medium" :class="g.total.negative && 'text-negative'" />
                <!-- Editing, merging and reordering institutions is for a computer. -->
                <DropdownMenu v-if="isDesktop">
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${g.institution.name}`"><Ellipsis /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-52">
                    <DropdownMenuItem @select="edit(g.institution)"><Pencil />Edit institution</DropdownMenuItem>
                    <DropdownMenuItem @select="addTo(g.institution)"><Plus />Add an account here</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem :disabled="position(g.institution) === 0" @select="move(g.institution, -1)"><ArrowUp />Move up</DropdownMenuItem>
                    <DropdownMenuItem :disabled="position(g.institution) === (institutions.data.value?.length ?? 0) - 1" @select="move(g.institution, 1)">
                      <ArrowDown />Move down
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <ul v-if="!collapsed.has(g.institution.id)" class="divide-y border-t">
                <li v-for="a in g.accounts" :key="a.id">
                  <RouterLink :to="{ name: 'account', params: { id: a.id } }" class="flex items-center gap-3 px-4 py-3 hover:bg-muted/50 md:px-6">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5 text-sm font-medium">
                        <span class="truncate">{{ a.name }}</span>
                        <AlertTriangle v-if="a.bank?.error" class="size-3.5 shrink-0 text-amber-600" :aria-label="a.bank.error" />
                        <RefreshCw v-else-if="a.bank" class="size-3 shrink-0 text-muted-foreground" aria-label="Syncs from your bank" />
                      </div>
                      <div class="truncate text-xs @2xl:hidden" :class="status(a).warn ? 'text-amber-600' : 'text-muted-foreground'">
                        {{ accountTypeInfo(a.type).label }} · {{ status(a).text }}
                      </div>
                    </div>
                    <span class="hidden w-28 truncate text-sm text-muted-foreground @2xl:block">{{ accountTypeInfo(a.type).label }}</span>
                    <span class="hidden w-40 truncate text-sm @2xl:block" :class="status(a).warn ? 'text-amber-600' : 'text-muted-foreground'">{{ status(a).text }}</span>
                    <MoneyText
                      :amount="statementBalance(a.balanceMinor, a.type)"
                      :colored="false"
                      :class="overdrawn(a) && 'text-negative'"
                      class="text-sm font-medium @2xl:w-28 @2xl:text-right"
                    />
                    <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
                  </RouterLink>
                </li>
                <li v-if="!g.accounts.length" class="px-4 py-3 text-sm text-muted-foreground md:px-6">
                  No open accounts{{ g.archived ? ` (${g.archived} archived)` : '' }}
                </li>
              </ul>
            </section>
          </Card>

          <div v-if="archived.length">
            <Button variant="ghost" size="sm" @click="showArchived = !showArchived">
              {{ showArchived ? 'Hide' : 'Show' }} {{ archived.length }} archived account{{ archived.length === 1 ? '' : 's' }}
            </Button>
            <Card v-if="showArchived" class="mt-2 gap-0 py-0">
              <ul class="divide-y">
                <li v-for="a in archived" :key="a.id">
                  <RouterLink :to="{ name: 'account', params: { id: a.id } }" class="flex items-center justify-between gap-3 px-4 py-3 text-sm text-muted-foreground hover:bg-muted/50 md:px-6">
                    <span class="truncate">{{ a.name }} · {{ a.institution }}</span><MoneyText :amount="statementBalance(a.balanceMinor, a.type)" :colored="false" />
                  </RouterLink>
                </li>
              </ul>
            </Card>
          </div>
        </div>

        <Card class="gap-0 py-0 xl:sticky xl:top-20">
          <CardHeader class="px-4 py-3">
            <CardTitle class="text-sm">By type</CardTitle>
            <CardDescription class="text-xs">Choose one to show only those accounts.</CardDescription>
          </CardHeader>
          <ul class="divide-y border-t">
            <li v-for="t in byType" :key="t.value">
              <button
                type="button"
                :aria-pressed="typeFilter === t.value"
                :class="cn('flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50', typeFilter === t.value && 'bg-muted')"
                @click="filterBy(t.value)"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ t.label }}</span>
                  <span class="block text-xs text-muted-foreground">{{ t.count }} account{{ t.count === 1 ? '' : 's' }}</span>
                </span>
                <MoneyText :amount="t.total.amount" :colored="false" class="text-sm" :class="t.total.negative && 'text-negative'" />
              </button>
            </li>
          </ul>
        </Card>
      </div>
    </template>
  </main>

  <AccountFormDialog
    v-model:open="formOpen"
    :bank-account-id="newFromBank"
    :institution-id="newIn"
    @saved="(a) => router.push({ name: 'account', params: { id: a.id } })"
  />
  <InstitutionDialog v-model:open="institutionOpen" :institution="editing" />
</template>
