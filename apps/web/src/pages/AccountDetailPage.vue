<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { AlertTriangle, Archive, ArchiveRestore, Loader2, Pencil, Plus, FileInput, RefreshCw, Scale, Trash2, Users, X } from '@lucide/vue'
import { accountTypeInfo, formatDateLong, formatDateShort, formatMonth, formatMonthShort, statementBalance, type SharingChange } from '@chipmunk/shared'
import AccountFormDialog from '@/components/AccountFormDialog.vue'
import BalanceDialog from '@/components/BalanceDialog.vue'
import LineChart from '@/components/charts/LineChart.vue'
import EmptyState from '@/components/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import MoneyText from '@/components/MoneyText.vue'
import AllLedgersTable from '@/components/sharing/AllLedgersTable.vue'
import ShareAccountDialog from '@/components/sharing/ShareAccountDialog.vue'
import TransactionFilterBar from '@/components/TransactionFilterBar.vue'
import TransactionTable from '@/components/TransactionTable.vue'
import TransactionTotals from '@/components/TransactionTotals.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  useAccountHistory,
  useAccountMutations,
  useAccounts,
  useBankMutations,
  useLedgers,
  useSettings,
  useSnapshots,
  useTransactions,
} from '@/composables/queries'
import { useReportsUsing } from '@/composables/useReportsUsing'
import { useTransactionFilters } from '@/composables/useTransactionFilters'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { errorMessage } from '@/lib/api'
import { money, timeAgo } from '@/lib/format'
import { currentLedger } from '@/lib/ledger'
import { listOf } from '@/lib/sharing'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'

const route = useRoute()
const isDesktop = useIsDesktop()
const router = useRouter()
const ui = useUiStore()
const id = computed(() => Number(route.params.id))
const accounts = useAccounts()
const account = computed(() => accounts.byId.value.get(id.value))
const history = useAccountHistory(id, 12)
const ledgers = useLedgers()
/** How it's shared between ledgers, when it is. */
const sharing = computed(() => account.value?.sharing ?? null)
/** This ledger looks after it: it's the account's home, or the only ledger that has it. A ledger it's shared with only holds transactions on it. */
const managed = computed(() => !sharing.value || sharing.value.isHome)
const sharedWith = computed(() => listOf((sharing.value?.ledgers ?? []).filter((l) => l.slug !== currentLedger.value).map((l) => l.name)))
// The recorded balances are the home's.
const snapshots = useSnapshots(id, managed)
// The same list as the Transactions page, with its filters in the URL and a running balance.
const f = useTransactionFilters()
const list = useTransactions(() => ({ accountId: id.value, ...f.filters.value }), 100, { keep: true })
const items = computed(() => list.data.value?.pages.flatMap((p) => p.items) ?? [])
/**
 * A shared account lists this ledger's transactions, or every ledger's (`?ledgers=all`), like the
 * bank's statement. The switch is for someone who can see every ledger that has the account.
 */
const seesAll = computed(() => !!sharing.value?.ledgers.every((l) => ledgers.all.value.some((x) => x.slug === l.slug)))
const allLedgers = computed({
  get: () => !!sharing.value && f.q('ledgers') === 'all',
  set: (v) => f.setQuery({ ledgers: v ? 'all' : undefined }),
})
const emptyTitle = computed(() => (f.activeCount.value ? 'Nothing matches these filters.' : 'No transactions in this account'))
const emptyDescription = computed(() =>
  f.activeCount.value
    ? undefined
    : account.value && accountTypeInfo(account.value.type).revalued
      ? 'That’s fine for one you keep up to date with Update balance.'
      : managed.value
        ? 'Add one, or import a CSV export from your bank.'
        : `Add one, or move one here from ${sharing.value?.home.name}.`,
)
const am = useAccountMutations()

const bank = useBankMutations()
const settings = useSettings()
const tz = computed(() => settings.data.value?.effectiveTimezone)

/** Amounts as the bank's statement shows them: for a credit card or loan, what you owe. */
const shown = (minor: number) => (account.value ? statementBalance(minor, account.value.type) : minor)
async function syncNow() {
  if (!account.value?.bank) return
  try {
    const r = await bank.sync.mutateAsync(account.value.bank.connectionId)
    if (!r.ok) return toast.error(r.error ?? 'The sync failed')
    const mine = r.accounts.find((x) => x.accountId === account.value?.id)
    toast.success(mine?.added ? `Synced: ${mine.added} new transaction${mine.added === 1 ? '' : 's'}` : 'Synced. Nothing new.')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

const editOpen = ref(false)
const balanceOpen = ref(false)
const deleteOpen = ref(false)
const shareOpen = ref(false)

/** This ledger may no longer have the account: it goes to the one made for what it kept, or to its accounts. */
function shared(change: SharingChange) {
  if ([change.sharing.home, ...change.sharing.members].some((l) => l.slug === currentLedger.value)) return
  const kept = change.removed.find((l) => l.ledger.slug === currentLedger.value)?.account
  router.replace(kept ? { name: 'account', params: { id: kept.id } } : { name: 'accounts' })
}

/** Credit cards are paid off every month, so their chart shows each month's spending on its own. */
const monthly = computed(() => !!account.value && accountTypeInfo(account.value.type).paidMonthly)
const points = computed(() =>
  (history.data.value ?? []).map((p, i, all) => {
    const last = i === all.length - 1
    const month = p.date.slice(0, 7)
    return monthly.value
      ? { label: formatMonthShort(month), detail: last ? `${formatMonth(month)} so far` : formatMonth(month), value: shown(p.monthMinor) }
      : { label: last ? 'Today' : formatMonthShort(month), detail: formatDateShort(p.date), value: shown(p.balanceMinor) }
  }),
)

async function toggleArchive() {
  if (!account.value) return
  try {
    await am.update.mutateAsync({ id: account.value.id, archived: !account.value.archived })
    toast.success(account.value.archived ? 'Account restored' : 'Account archived')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
const reportsUsing = useReportsUsing('account', () => account.value?.id)

async function remove() {
  if (!account.value) return
  try {
    await am.remove.mutateAsync(account.value.id)
    toast.success('Account deleted')
    router.replace({ name: 'accounts' })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
async function removeSnapshot(snapshotId: number) {
  try {
    await am.deleteSnapshot.mutateAsync({ id: id.value, snapshotId })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <template v-if="account">
    <PageHeader
      :title="account.name"
      :back="{ name: 'accounts' }"
      :subtitle="[account.institution, accountTypeInfo(account.type).label].filter(Boolean).join(' · ')"
      menu-label="Account actions"
    >
      <template v-if="sharing" #title>
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-base font-semibold md:text-lg">{{ account.name }}</h1>
          <Badge variant="secondary" class="shrink-0">Shared</Badge>
        </div>
      </template>
      <template #actions>
        <Button class="hidden md:inline-flex" @click="ui.openAdd({ accountId: account.id })"><Plus />Add transaction</Button>
      </template>
      <template #menu>
        <DropdownMenuItem @select="editOpen = true"><Pencil />Edit account</DropdownMenuItem>
        <!-- A shared account's balance, CSV, sharing and deletion are its home's. A synced account's balance is the bank's. -->
        <template v-if="managed">
          <DropdownMenuItem v-if="!account.bank" @select="balanceOpen = true"><Scale />Update balance</DropdownMenuItem>
          <DropdownMenuItem v-if="isDesktop" as-child>
            <RouterLink :to="{ name: 'import', query: { accountId: account.id } }"><FileInput />Import CSV</RouterLink>
          </DropdownMenuItem>
          <!-- Only credit cards can be shared. -->
          <DropdownMenuItem v-if="account.type === 'credit' && ledgers.all.value.length > 1" @select="shareOpen = true"><Users />Share with…</DropdownMenuItem>
        </template>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="toggleArchive">
          <component :is="account.archived ? ArchiveRestore : Archive" />{{ account.archived ? 'Restore' : 'Archive' }}
        </DropdownMenuItem>
        <DropdownMenuItem v-if="managed" variant="destructive" @select="deleteOpen = true"><Trash2 />Delete account</DropdownMenuItem>
      </template>
    </PageHeader>

    <main class="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <Card class="gap-4">
        <CardHeader>
          <CardDescription>{{ account.isLiability ? 'Owed' : 'Balance' }}<template v-if="sharing && ledgers.current.value"> in {{ ledgers.current.value.name }}</template></CardDescription>
          <CardTitle class="text-3xl tabular" :class="!account.isLiability && account.balanceMinor < 0 && 'text-negative'">
            {{ money(shown(account.balanceMinor)) }}
          </CardTitle>
          <p class="text-sm text-muted-foreground">
            <template v-if="account.balanceAsOf">Last balance update {{ formatDateShort(account.balanceAsOf) }}. </template>
            <template v-if="monthly">This month <span class="tabular">{{ money(shown(account.monthMinor)) }}</span> · </template>
            {{ account.transactionCount }} transaction{{ account.transactionCount === 1 ? '' : 's' }}
          </p>
          <!-- A shared account: this ledger's part is above, and here the whole account's, as the bank has it. -->
          <p v-if="sharing" class="col-span-full text-sm text-muted-foreground">
            <span class="tabular">{{ money(shown(sharing.totalBalanceMinor)) }}</span>{{ account.isLiability ? ' owed' : '' }} on the whole account ·
            <template v-if="sharing.isHome">Shared with {{ sharedWith }}</template>
            <template v-else>Home: {{ sharing.home.name }}</template>
          </p>
          <div v-if="account.bank" class="col-span-full mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span class="flex items-center gap-1.5 text-muted-foreground">
              <RefreshCw class="size-3.5" />
              Syncs from {{ account.bank.institution ?? 'your bank' }} ({{ account.bank.name }})
              <template v-if="account.bank.lastSyncedAt">· {{ timeAgo(account.bank.lastSyncedAt, tz) }}</template>
            </span>
            <Button variant="ghost" size="xs" :disabled="bank.sync.isPending.value" @click="syncNow">
              <Loader2 v-if="bank.sync.isPending.value" class="animate-spin" />Sync now
            </Button>
            <span v-if="account.bank.error" class="flex items-center gap-1 text-amber-700 dark:text-amber-400"><AlertTriangle class="size-3.5" />{{ account.bank.error }}</span>
          </div>
        </CardHeader>
        <CardContent>
          <LineChart
            v-if="points.length > 1"
            :points="points"
            :chart-label="monthly ? `${account.name} spending by month` : `${account.name} balance over time`"
            :height="180"
          />
        </CardContent>
      </Card>

      <section class="flex flex-col gap-3 md:gap-4" aria-labelledby="account-transactions">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 id="account-transactions" class="text-base font-semibold">Transactions</h2>
            <div v-if="sharing && seesAll" class="grid grid-cols-2 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Whose transactions">
              <button
                v-for="opt in [{ all: false, label: 'This ledger' }, { all: true, label: 'All ledgers' }]"
                :key="opt.label"
                type="button"
                role="radio"
                :aria-checked="allLedgers === opt.all"
                :class="cn('rounded-md px-3 py-1 text-sm font-medium transition-colors', allLedgers === opt.all ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')"
                @click="allLedgers = opt.all"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <Button variant="outline" size="sm" as-child>
            <RouterLink :to="{ name: 'transactions', query: { accountId: account.id, period: 'all' } }">Open in Transactions</RouterLink>
          </Button>
        </div>
        <template v-if="allLedgers">
          <p class="text-sm text-muted-foreground">
            What every ledger has on {{ account.name }}, with the whole account’s balance after each. Another ledger’s transaction can be moved here to edit it.
          </p>
          <AllLedgersTable :account="account" />
        </template>
        <template v-else>
          <TransactionFilterBar :filters="f" />
          <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <TransactionTotals :items="items" :more="list.hasNextPage.value" single-account />
            <span v-if="f.activeCount.value && !accountTypeInfo(account.type).revalued" class="text-xs text-muted-foreground">
              Clear the filters to see the running balance.
            </span>
          </div>
          <TransactionTable :list="list" hide-account :empty-title="emptyTitle" :empty-description="emptyDescription">
            <template #empty>
              <Button v-if="f.activeCount.value" variant="outline" size="sm" @click="f.clear()">Clear filters</Button>
              <Button v-else size="sm" @click="ui.openAdd({ accountId: account.id })"><Plus />Add transaction</Button>
            </template>
          </TransactionTable>
        </template>
      </section>

      <Card v-if="managed && snapshots.data.value?.length" class="gap-2">
        <CardHeader>
          <CardTitle>Balance updates</CardTitle>
          <CardDescription>{{ account.bank ? 'From your bank, or recorded by hand' : 'Recorded by hand' }}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul class="divide-y text-sm">
            <li v-for="s in snapshots.data.value" :key="s.id" class="group flex items-center justify-between py-2">
              <span class="text-muted-foreground">{{ formatDateLong(s.date) }}<template v-if="s.source === 'sync'"> · bank</template></span>
              <span class="flex items-center gap-1">
                <MoneyText :amount="shown(s.balanceMinor)" :colored="false" />
                <Button variant="ghost" size="icon-xs" class="opacity-60 group-hover:opacity-100" aria-label="Delete balance update" @click="removeSnapshot(s.id)">
                  <X />
                </Button>
              </span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </main>

    <AccountFormDialog v-model:open="editOpen" :account="account" />
    <BalanceDialog v-model:open="balanceOpen" :account="account" />
    <ShareAccountDialog v-model:open="shareOpen" :account="account" @saved="shared" />
    <Dialog v-model:open="deleteOpen">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {{ account.name }}?</DialogTitle>
          <!-- A shared account can't be deleted: the other ledgers have transactions on it. -->
          <DialogDescription v-if="sharing">
            {{ account.name }} is shared with {{ sharedWith }}. Stop sharing it first (Share with… in the account’s menu), then delete it. Or
            archive it to keep its history in reports.
          </DialogDescription>
          <DialogDescription v-else>
            This permanently deletes the account and its {{ account.transactionCount }} transaction{{ account.transactionCount === 1 ? '' : 's' }}.
            Archive it instead to keep its history in reports.
          </DialogDescription>
          <DialogDescription v-if="reportsUsing && !sharing">{{ reportsUsing }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteOpen = false">Cancel</Button>
          <Button variant="outline" @click="(deleteOpen = false), toggleArchive()">Archive instead</Button>
          <Button v-if="!sharing" variant="destructive" :disabled="am.remove.isPending.value" @click="remove">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </template>
  <template v-else>
    <PageHeader title="Account" :back="{ name: 'accounts' }" />
    <main class="p-4 md:p-6">
      <Card v-if="accounts.isSuccess.value"><EmptyState title="This account doesn't exist" description="It may have been deleted." /></Card>
    </main>
  </template>
</template>
