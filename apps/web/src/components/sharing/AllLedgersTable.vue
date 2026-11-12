<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { ArrowRightFromLine, Loader2, Receipt } from '@lucide/vue'
import { formatDateLong, statementBalance, type Account, type AccountTransaction as Row, type Transaction } from '@chipmunk/shared'
import EmptyState from '@/components/EmptyState.vue'
import LedgerMark from '@/components/ledger/LedgerMark.vue'
import MoneyText from '@/components/MoneyText.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAccountTransactions, useLedgers } from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { shortDate } from '@/lib/format'
import { lapi } from '@/lib/ledger'
import { SHARES_OVER } from '@/lib/sharing'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'
import AccountRowDetails from './AccountRowDetails.vue'
import MoveToMenu from './MoveToMenu.vue'

/**
 * A shared account's transactions in every ledger that has it, like the bank's statement: each with
 * the ledger that holds it, and the whole account's balance after it. A row this ledger holds opens
 * in the editor. Another ledger's is read-only, and can be moved (here, to edit it). The rows a split
 * adds aren't listed: a split payment shows its shares.
 */
const props = defineProps<{ account: Account }>()

const ui = useUiStore()
const today = useToday()
const isDesktop = useIsDesktop()
const ledgers = useLedgers()
const list = useAccountTransactions(() => props.account.id)
const items = computed(() => list.rows.value)
const ledgerOf = (slug: string) => ledgers.all.value.find((l) => l.slug === slug)
const titleOf = (row: Row) => row.name ?? row.payeeName
/** As the bank's statement shows it: for a credit card, what's owed. */
const balanceOf = (row: Row) => statementBalance(row.balanceAfterMinor, props.account.type)
const elsewhere = (row: Row) => `In ${row.ledger.name}. Move it here to edit it.`
/** A split payment's shares, and what the ledger that holds it keeps. */
const sharesOf = (row: Row) => (row.split ? [...row.split.shares.map((s) => ({ name: s.ledger.name, minor: s.amountMinor })), { name: `${row.ledger.name} keeps`, minor: row.split.keptMinor }] : [])

/** Another ledger's row, opened to look at. */
const viewing = ref<Row | null>(null)
const viewOpen = computed({ get: () => !!viewing.value, set: (v) => !v && (viewing.value = null) })
async function open(row: Row) {
  if (!row.here) return void (viewing.value = row)
  try {
    ui.openEdit(await lapi.get<Transaction>(`/transactions/${row.id}`))
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

// Infinite scroll
const sentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(sentinel, ([entry]) => {
  if (entry?.isIntersecting && list.hasNextPage.value && !list.isFetchingNextPage.value) list.fetchNextPage()
})

// Phone: grouped by day.
const days = computed(() => {
  const groups: Array<{ date: string; items: Row[] }> = []
  for (const t of items.value) {
    let g = groups[groups.length - 1]
    if (!g || g.date !== t.date) groups.push((g = { date: t.date, items: [] }))
    g.items.push(t)
  }
  return groups
})

// Selection, to move rows (on a computer). What's no longer listed drops out.
const selected = ref(new Set<number>())
watch(items, (rows) => {
  if (!selected.value.size) return
  const shown = new Set(rows.map((t) => t.id))
  const kept = [...selected.value].filter((id) => shown.has(id))
  if (kept.length !== selected.value.size) selected.value = new Set(kept)
})
const allSelected = computed(() => items.value.length > 0 && items.value.every((t) => selected.value.has(t.id)))
function toggle(id: number, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
/** The ledgers that hold the selected rows: a move takes rows out of one ledger. */
const holders = computed(() => [...new Set(items.value.filter((t) => selected.value.has(t.id)).map((t) => t.ledger.slug))])
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 md:gap-4">
    <!-- The server's reason, as it says it (a key that can't see every ledger that has the account, say). -->
    <Card v-if="list.error.value"><EmptyState :title="errorMessage(list.error.value)" /></Card>
    <template v-else>
      <div v-if="selected.size" class="sticky top-16 z-10 hidden flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm md:flex">
        <span class="px-2 text-sm font-medium">{{ selected.size }} selected</span>
        <MoveToMenu
          v-if="holders.length === 1"
          v-slot="{ busy }"
          :ids="[...selected]"
          :ledgers="account.sharing?.ledgers ?? []"
          :from="holders[0]"
          @moved="selected = new Set()"
        >
          <Button size="sm" variant="outline" :disabled="busy"><ArrowRightFromLine />Move to…</Button>
        </MoveToMenu>
        <span v-else class="text-sm text-muted-foreground">Select rows from one ledger to move them.</span>
        <Button size="sm" variant="ghost" class="ml-auto" @click="selected = new Set()">Cancel</Button>
      </div>

      <!-- Desktop table -->
      <Card class="relative hidden gap-0 overflow-hidden py-0 md:flex">
        <Table v-if="items.length">
          <TableHeader>
            <TableRow>
              <TableHead class="w-10 pl-4">
                <Checkbox :model-value="allSelected" aria-label="Select all" @update:model-value="(v) => (selected = v ? new Set(items.map((t) => t.id)) : new Set())" />
              </TableHead>
              <TableHead class="w-28">Date</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead class="w-40">Ledger</TableHead>
              <TableHead class="w-44">Category</TableHead>
              <TableHead class="w-32 text-right">Amount</TableHead>
              <TableHead class="w-32 pr-4 text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="row in items"
              :key="row.id"
              :class="cn('cursor-pointer', row.here && ui.editorOpen && ui.editing?.id === row.id && 'bg-muted shadow-[inset_3px_0_0_var(--primary)]')"
              :title="row.here ? undefined : elsewhere(row)"
              :data-state="selected.has(row.id) ? 'selected' : undefined"
              @click="open(row)"
            >
              <TableCell class="pl-4" @click.stop>
                <Checkbox :model-value="selected.has(row.id)" :aria-label="`Select ${titleOf(row)}`" @update:model-value="(v) => toggle(row.id, !!v)" />
              </TableCell>
              <TableCell class="truncate text-muted-foreground tabular">{{ shortDate(row.date, today) }}</TableCell>
              <TableCell class="max-w-0">
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-medium">{{ titleOf(row) }}</span>
                  <span v-if="row.split" class="shrink-0 rounded-full border px-1.5 text-[11px] text-muted-foreground">Split</span>
                  <span v-if="row.status === 'pending'" class="shrink-0 text-xs text-muted-foreground">Pending</span>
                </div>
                <div v-if="row.split" class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span v-for="s in sharesOf(row)" :key="s.name" class="whitespace-nowrap">{{ s.name }} <MoneyText :amount="s.minor" :colored="false" /></span>
                  <span v-if="row.split.keptMinor < 0" class="text-amber-700 dark:text-amber-400">{{ SHARES_OVER }}</span>
                </div>
                <div v-if="row.notes" class="mt-0.5 truncate text-xs text-foreground/80" :title="row.notes">{{ row.notes }}</div>
              </TableCell>
              <TableCell class="max-w-0">
                <span class="flex min-w-0 items-center gap-1.5" :class="!row.here && 'text-muted-foreground'">
                  <LedgerMark :ledger="ledgerOf(row.ledger.slug)" size="sm" />
                  <span class="truncate">{{ row.ledger.name }}</span>
                </span>
              </TableCell>
              <TableCell class="max-w-0 truncate text-muted-foreground">{{ row.category }}</TableCell>
              <TableCell class="text-right"><MoneyText :amount="row.amountMinor" /></TableCell>
              <TableCell class="pr-4 text-right text-muted-foreground"><MoneyText :amount="balanceOf(row)" :colored="false" /></TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <EmptyState v-else-if="list.isSuccess.value" :icon="Receipt" title="No transactions in this account" />
      </Card>

      <!-- Phone list grouped by day -->
      <div class="md:hidden">
        <Card v-if="items.length" class="gap-0 py-0">
          <section v-for="(day, i) in days" :key="day.date">
            <h2
              :class="i === 0 && 'rounded-t-xl'"
              class="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-[5] border-b bg-muted/90 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur"
            >
              {{ formatDateLong(day.date) }}
            </h2>
            <ul class="[&>li:first-child>div]:border-t-0">
              <li v-for="row in day.items" :key="row.id">
                <div
                  role="button"
                  tabindex="0"
                  class="grid grid-cols-[minmax(7rem,1fr)_auto] items-start gap-x-3 border-t px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  @click="open(row)"
                  @keydown.enter.prevent="open(row)"
                >
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="truncate text-sm font-medium">{{ titleOf(row) }}</span>
                      <span v-if="row.split" class="shrink-0 rounded-full border px-1.5 text-[11px] text-muted-foreground">Split</span>
                    </div>
                    <div v-if="row.split" class="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span v-for="s in sharesOf(row)" :key="s.name" class="whitespace-nowrap">{{ s.name }} <MoneyText :amount="s.minor" :colored="false" /></span>
                      <span v-if="row.split.keptMinor < 0" class="text-amber-700 dark:text-amber-400">{{ SHARES_OVER }}</span>
                    </div>
                    <div class="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <LedgerMark :ledger="ledgerOf(row.ledger.slug)" size="sm" />
                      <span class="truncate">{{ [row.ledger.name, row.category, row.status === 'pending' ? 'Pending' : null].filter(Boolean).join(' · ') }}</span>
                    </div>
                    <p v-if="row.notes" class="mt-1 line-clamp-2 text-xs break-words whitespace-pre-line text-foreground/80">{{ row.notes }}</p>
                  </div>
                  <div class="flex min-w-0 flex-col items-end gap-1">
                    <MoneyText :amount="row.amountMinor" class="text-sm font-medium" />
                    <MoneyText :amount="balanceOf(row)" :colored="false" class="text-xs text-muted-foreground" />
                  </div>
                </div>
              </li>
            </ul>
          </section>
        </Card>
        <Card v-else-if="list.isSuccess.value"><EmptyState :icon="Receipt" title="No transactions in this account" /></Card>
      </div>

      <div ref="sentinel" class="flex justify-center py-2">
        <Loader2 v-if="list.isFetchingNextPage.value || (list.isPending.value && !items.length)" class="size-5 animate-spin text-muted-foreground" />
        <Button v-else-if="list.hasNextPage.value" variant="ghost" size="sm" @click="list.fetchNextPage()">Load more</Button>
      </div>
    </template>

    <!-- Another ledger's row: a dialog on a computer, a sheet from the bottom on a phone. -->
    <Dialog v-if="isDesktop" v-model:open="viewOpen">
      <DialogContent v-if="viewing" class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ titleOf(viewing) }}</DialogTitle>
          <DialogDescription>{{ elsewhere(viewing) }}</DialogDescription>
        </DialogHeader>
        <AccountRowDetails :account="account" :row="viewing" @moved="viewing = null" />
      </DialogContent>
    </Dialog>
    <Drawer v-else v-model:open="viewOpen">
      <DrawerContent class="max-h-[92svh]">
        <template v-if="viewing">
          <DrawerHeader class="pb-3 text-left">
            <DrawerTitle>{{ titleOf(viewing) }}</DrawerTitle>
            <DrawerDescription>{{ elsewhere(viewing) }}</DrawerDescription>
          </DrawerHeader>
          <div class="overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <AccountRowDetails :account="account" :row="viewing" @moved="viewing = null" />
          </div>
        </template>
      </DrawerContent>
    </Drawer>
  </div>
</template>

<style scoped>
:deep(tr[data-state='selected']) {
  background: var(--muted);
}
</style>
