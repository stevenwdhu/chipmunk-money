<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useElementSize, useIntersectionObserver } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { ArrowLeftRight, Check, GripVertical, HandCoins, Loader2, Receipt, Repeat, Sparkles, Tag, Trash2 } from '@lucide/vue'
import {
  COLUMN_WIDTH_RANGE,
  formatDateLong,
  formatMoney,
  recurringLabel,
  statementBalance,
  TRANSACTION_COLUMNS,
  type Transaction,
  type TransactionColumn,
  type TransactionListItem as Item,
} from '@chipmunk/shared'
import CategoryPicker from '@/components/CategoryPicker.vue'
import EmptyState from '@/components/EmptyState.vue'
import FilterOutOfReport from '@/components/FilterOutOfReport.vue'
import LinkBadge from '@/components/LinkBadge.vue'
import MoneyText from '@/components/MoneyText.vue'
import CategoryBadge from '@/components/CategoryBadge.vue'
import PayeeChoicePopover from '@/components/PayeeChoicePopover.vue'
import PaybackDialog from '@/components/PaybackDialog.vue'
import TransactionList from '@/components/TransactionList.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  useAccounts,
  useAiJobStatus,
  useCategories,
  useInvalidateLedger,
  useRecurring,
  useSettings,
  useTransactionMutations,
  useUpdateSettings,
  type useTransactions,
} from '@/composables/queries'
import { useColumnOrder } from '@/composables/useColumnOrder'
import { useColumnWidths } from '@/composables/useColumnWidths'
import { jumpToTransaction } from '@/composables/useGoToTransaction'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { shortDate } from '@/lib/format'
import { billCount, netAmount } from '@/lib/links'
import { sentPayeeUnder, titleOf } from '@/lib/payee'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'

/**
 * A list of transactions: a table with columns you can move and resize on larger screens, a list
 * grouped by day on phones, selection with bulk changes, and more loading as you scroll. The
 * Transactions page and each account's page share it, so they look and work the same.
 */
const props = defineProps<{
  list: ReturnType<typeof useTransactions>
  /** Every row is the same account (its own page), so there's no Account column. */
  hideAccount?: boolean
  emptyTitle: string
  emptyDescription?: string
}>()

const ui = useUiStore()
const today = useToday()
const { byId: accounts } = useAccounts()
const { byId: categories } = useCategories()
const recurring = useRecurring()
const itemLabels = computed(() => new Map((recurring.data.value ?? []).map((i) => [i.id, recurringLabel(i)])))
const m = useTransactionMutations()

const items = computed<Item[]>(() => props.list.rows.value)
/** The server sends running balances for one account's list with no filter but dates. */
const hasBalances = computed(() => items.value.some((t) => t.balanceAfterMinor !== null))
/** Changed so it no longer matches the filters: still listed, faded, until they change. */
const kept = computed(() => props.list.kept.value)
const KEPT_TITLE = 'It doesn’t match the filters any more. It stays until you change them.'
/** A running balance as the bank's statement shows it: for a credit card, what you owe. */
const balanceOf = (tx: Item) =>
  tx.balanceAfterMinor === null ? null : statementBalance(tx.balanceAfterMinor, accounts.value.get(tx.accountId)?.type ?? 'chequing')
const overdrawn = (tx: Item) => !accounts.value.get(tx.accountId)?.isLiability && (tx.balanceAfterMinor ?? 0) < 0

/**
 * Desktop table columns: drag a header to move one, or its right edge to resize it. The rightmost
 * column fills the rest of the row. When the columns don't fit, Name, Account and then Notes step
 * out and show under the payee instead.
 */
const COLUMNS: Record<TransactionColumn, { label: string; width: number }> = {
  date: { label: 'Date', width: 112 },
  payee: { label: 'Payee', width: 240 },
  notes: { label: 'Notes', width: 200 },
  category: { label: 'Category', width: 192 },
  account: { label: 'Account', width: 160 },
  amount: { label: 'Amount', width: 128 },
  balance: { label: 'Balance', width: 128 },
}
const OPTIONAL_COLUMNS: TransactionColumn[] = ['account', 'notes']
/** The checkbox and the right padding. */
const FIXED_WIDTH = 56
const RIGHT_ALIGNED: TransactionColumn[] = ['amount', 'balance']
// Order and widths are app settings, so they're the same on every device and every list.
const settings = useSettings()
const updateSettings = useUpdateSettings()
const saveSetting = (input: Parameters<typeof updateSettings.mutateAsync>[0], what: string) =>
  updateSettings.mutateAsync(input).catch((err) => {
    toast.error(`Couldn’t save the ${what}. ${errorMessage(err)}`)
    throw err
  })
const tableCard = useTemplateRef<ComponentPublicInstance>('tableCard')
const widths = useColumnWidths(
  Object.fromEntries(TRANSACTION_COLUMNS.map((c) => [c, COLUMNS[c].width])) as Record<TransactionColumn, number>,
  {
    table: tableCard,
    saved: () => settings.data.value?.transactionColumnWidths,
    save: (next) => saveSetting({ transactionColumnWidths: next }, 'column widths'),
    ...COLUMN_WIDTH_RANGE,
  },
)
const { width: tableWidth } = useElementSize(tableCard)
const visibleColumns = computed<TransactionColumn[]>(() => {
  let cols: TransactionColumn[] = columns.order.value.filter((c) => (c !== 'balance' || hasBalances.value) && (c !== 'account' || !props.hideAccount))
  for (const optional of OPTIONAL_COLUMNS) {
    if (FIXED_WIDTH + cols.reduce((n, c) => n + widths.width(c), 0) <= tableWidth.value) break
    cols = cols.filter((c) => c !== optional)
  }
  return cols
})
const columns = useColumnOrder(TRANSACTION_COLUMNS, {
  table: tableCard,
  saved: () => settings.data.value?.transactionColumns,
  save: (next) => saveSetting({ transactionColumns: next }, 'column order'),
  visible: visibleColumns,
})
const fillColumn = computed(() => visibleColumns.value[visibleColumns.value.length - 1])
const shows = (col: TransactionColumn) => visibleColumns.value.includes(col)

// The one opened (from a link, say) is brought into view when it's listed. The page is held still
// for the panel, but not for this.
watch(
  () => (ui.editorOpen ? ui.editing?.id : null),
  async (id) => {
    if (id == null) return
    await nextTick()
    const card = tableCard.value?.$el as HTMLElement | undefined
    card?.querySelector(`tr[data-tx-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  },
)

// Sent here to show one (?jump=, from a link label on another page): more loads until it's listed,
// then it's scrolled to and flashed, and the URL goes back to the list's.
const route = useRoute()
const router = useRouter()
const jumpId = computed(() => (typeof route.query.jump === 'string' ? Number(route.query.jump) : null))
function jumped() {
  const query = { ...route.query }
  delete query.jump
  router.replace({ query })
}
watch(
  [jumpId, items, () => props.list.isFetching.value],
  async ([id, list, fetching]) => {
    if (!id || fetching) return
    if (list.some((t) => t.id === id)) {
      await nextTick()
      jumpToTransaction(id)
      jumped()
    } else if (props.list.hasNextPage.value) props.list.fetchNextPage()
    else if (props.list.isSuccess.value) {
      jumped()
      toast.error('That transaction isn’t listed. It may have been deleted.')
    }
  },
  { immediate: true },
)

// Infinite scroll
const sentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(sentinel, ([entry]) => {
  const list = props.list
  if (entry?.isIntersecting && list.hasNextPage.value && !list.isFetchingNextPage.value) list.fetchNextPage()
})

// Phone: group by day
const days = computed(() => {
  const groups: Array<{ date: string; items: Item[]; total: number }> = []
  for (const t of items.value) {
    let g = groups[groups.length - 1]
    if (!g || g.date !== t.date) {
      g = { date: t.date, items: [], total: 0 }
      groups.push(g)
    }
    g.items.push(t)
    if (!t.transferPairId || props.hideAccount) g.total += t.amountMinor
  }
  return groups
})

// Selection & bulk actions (desktop). What's no longer listed (say, after a filter) drops out.
const selected = ref(new Set<number>())
watch(items, (list) => {
  if (!selected.value.size) return
  const shown = new Set(list.map((t) => t.id))
  const kept = [...selected.value].filter((id) => shown.has(id))
  if (kept.length !== selected.value.size) selected.value = new Set(kept)
})
const allSelected = computed(() => items.value.length > 0 && items.value.every((t) => selected.value.has(t.id)))
/** The row last checked or unchecked: shift-clicking another checks (or unchecks) the ones between too. */
let anchor: number | null = null
/** Shift was held on the checkbox click being handled (noted before the checkbox handles it). */
let shift = false
function noteShift(e: MouseEvent) {
  shift = e.shiftKey
}
// Shift-clicking a checkbox doesn't select the text between.
function keepTextUnselected(e: MouseEvent) {
  if (e.shiftKey) e.preventDefault()
}
function toggle(id: number, on: boolean) {
  const ids = items.value.map((t) => t.id)
  const [from, to] = [shift && anchor !== null ? ids.indexOf(anchor) : -1, ids.indexOf(id)]
  const range = from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id]
  const next = new Set(selected.value)
  for (const r of range) {
    if (on) next.add(r)
    else next.delete(r)
  }
  selected.value = next
  anchor = id
  shift = false
}
function toggleAll(on: boolean) {
  selected.value = on ? new Set(items.value.map((t) => t.id)) : new Set()
  anchor = null
}
watch(
  () => selected.value.size,
  (n) => {
    if (!n) anchor = null
  },
)
const bulkCategory = ref<number | null>(null)
const bulkTag = ref('')
async function bulk(action: 'category' | 'tag' | 'accept' | 'delete') {
  const ids = [...selected.value]
  if (!ids.length) return
  try {
    const input =
      action === 'category'
        ? { ids, categoryId: bulkCategory.value }
        : action === 'tag'
          ? { ids, addTags: [bulkTag.value] }
          : action === 'accept'
            ? { ids, acceptSuggestions: true }
            : { ids, delete: true }
    const { updated } = await m.bulk.mutateAsync(input)
    toast.success(`${action === 'delete' ? 'Deleted' : 'Updated'} ${updated} transaction${updated === 1 ? '' : 's'}`)
    selected.value = new Set()
    bulkTag.value = ''
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

// AI looks at the selection's categories again, in the background. When it's done, what it changed
// is there to review.
const aiEnabled = computed(() => !!settings.data.value?.ai.enabled)
const aiJob = useAiJobStatus(aiEnabled)
const aiRunning = computed(() => !!aiJob.data.value?.running)
const askedAi = ref(false)
const refresh = useInvalidateLedger()
async function askAiAgain() {
  const ids = [...selected.value]
  if (!ids.length) return
  try {
    await m.askAiAgain.mutateAsync(ids)
    askedAi.value = true
    selected.value = new Set()
    toast(`Asking AI about ${ids.length} transaction${ids.length === 1 ? '' : 's'}…`)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
watch(aiRunning, (running, was) => {
  if (running || !was || !askedAi.value) return
  askedAi.value = false
  refresh()
  const n = aiJob.data.value?.categorized ?? 0
  if (n) toast.success(`Changed ${n} categor${n === 1 ? 'y' : 'ies'}`, { description: 'What AI picked is marked to review. Payees you always set one way got your category.' })
  else toast('No categories changed', { description: 'AI picked the ones they have.' })
})

/**
 * Marking the selection as a payback: the money in selected pays back bills together, their amounts
 * added up, in the payback dialog. Bills selected too come picked there. Just a bill, it opens from
 * the bill, to pick the money in that paid it back.
 */
const selectedItems = computed(() => items.value.filter((t) => selected.value.has(t.id)))
const payback = ref<{ tx: Transaction; together: Transaction[]; preselect: Transaction[] } | null>(null)
const paybackOpen = ref(false)
function markPayback() {
  const ins = selectedItems.value.filter((t) => t.amountMinor > 0)
  const outs = selectedItems.value.filter((t) => t.amountMinor < 0)
  const transfer = selectedItems.value.find((t) => t.transferPairId)
  if (transfer) return void toast.error(`${titleOf(transfer)} is a transfer, so it can’t be part of a payback. Unselect it, or say it’s not a transfer first.`)
  const payment = ins.find((t) => t.recurringItemId)
  if (payment) return void toast.error(`${titleOf(payment)} is a recurring item’s payment, so it can’t pay anything back.`)
  if (ins.length) {
    // From the latest: the bills it finds are from before it.
    const [tx, ...together] = [...ins].sort((a, b) => b.date.localeCompare(a.date))
    payback.value = { tx: tx!, together, preselect: outs }
  } else if (outs.length === 1) payback.value = { tx: outs[0]!, together: [], preselect: [] }
  else return void toast.error('Also select the money in that pays them back.')
  paybackOpen.value = true
}

async function setCategory(tx: Transaction, id: number | null) {
  try {
    const saved = await m.update.mutateAsync({ id: tx.id, categoryId: id })
    // A recurring item's payments share one category.
    if (tx.recurringItemId && id !== tx.categoryId) toast.success(`Changed for all of ${itemLabels.value.get(tx.recurringItemId) ?? 'its recurring item'}’s payments`)
    ui.askAboutPayee(saved)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
async function accept(tx: Transaction) {
  try {
    const saved = await m.accept.mutateAsync(tx.id)
    ui.askAboutPayee(saved, saved.categoryId, true)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 md:gap-4">
    <!-- Bulk bar -->
    <div v-if="selected.size" class="sticky top-16 z-10 hidden flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm md:flex">
      <span class="px-2 text-sm font-medium">{{ selected.size }} selected</span>
      <CategoryPicker v-model="bulkCategory" size="sm" class="w-48" placeholder="Set category…" />
      <Button size="sm" variant="outline" :disabled="m.bulk.isPending.value" @click="bulk('category')">Apply</Button>
      <Popover>
        <PopoverTrigger as-child><Button size="sm" variant="outline"><Tag />Add tag</Button></PopoverTrigger>
        <PopoverContent class="w-56" align="start">
          <form class="flex gap-2" @submit.prevent="bulkTag && bulk('tag')">
            <Input v-model="bulkTag" placeholder="trip-japan" aria-label="Tag name" />
            <Button size="sm" type="submit">Add</Button>
          </form>
        </PopoverContent>
      </Popover>
      <Button size="sm" variant="outline" @click="bulk('accept')"><Check />Accept suggestions</Button>
      <Button
        v-if="aiEnabled"
        size="sm"
        variant="outline"
        :disabled="aiRunning || m.askAiAgain.isPending.value"
        title="AI picks each one’s category again. A different pick is marked to review."
        @click="askAiAgain"
      >
        <Sparkles class="text-ai" />Ask AI again
      </Button>
      <Button size="sm" variant="outline" @click="markPayback"><HandCoins />Mark as payback</Button>
      <FilterOutOfReport :transactions="items.filter((t) => selected.has(t.id))" variant="button" @done="selected = new Set()" />
      <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" @click="bulk('delete')"><Trash2 />Delete</Button>
      <Button size="sm" variant="ghost" class="ml-auto" @click="selected = new Set()">Cancel</Button>
    </div>

    <p v-if="askedAi && aiRunning" class="hidden items-center gap-2 px-1 text-sm text-muted-foreground md:flex">
      <Loader2 class="size-3.5 animate-spin" />AI is looking at their categories again: {{ aiJob.data.value?.done ?? 0 }} of {{ aiJob.data.value?.total ?? 0 }}
    </p>

    <!-- Desktop table -->
    <Card ref="tableCard" class="relative hidden gap-0 overflow-hidden py-0 md:flex">
      <Table v-if="items.length">
        <TableHeader>
          <TableRow>
            <TableHead class="w-10 pl-4">
              <Checkbox :model-value="allSelected" aria-label="Select all" @update:model-value="(v) => toggleAll(!!v)" />
            </TableHead>
            <TableHead
              v-for="col in visibleColumns"
              :key="col"
              v-bind="columns.headerProps(col)"
              :data-col="col"
              :style="{ ...columns.cellStyle(col), ...widths.widthStyle(col, col === fillColumn) }"
              :class="
                cn(
                  'group cursor-grab select-none focus-visible:bg-muted focus-visible:outline-none',
                  RIGHT_ALIGNED.includes(col) && 'text-right',
                  columns.dragging.value === col && 'cursor-grabbing',
                )
              "
              title="Drag to move this column (or Alt + ← / →)"
            >
              <span class="inline-flex items-center gap-1" :class="RIGHT_ALIGNED.includes(col) && 'flex-row-reverse'">
                {{ COLUMNS[col].label }}
                <GripVertical class="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </span>
              <!-- The rightmost column fills the rest of the row, so it has no grip. -->
              <span
                v-if="col !== fillColumn"
                v-bind="widths.handleProps(col, COLUMNS[col].label)"
                class="absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize touch-none after:absolute after:inset-y-2 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border hover:after:w-0.5 hover:after:bg-primary focus-visible:outline-none focus-visible:after:w-0.5 focus-visible:after:bg-primary"
              />
            </TableHead>
            <TableHead class="w-4 p-0" aria-hidden="true" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="tx in items"
            :key="tx.id"
            :data-tx-id="tx.id"
            :class="cn('cursor-pointer scroll-mt-32 scroll-mb-4', kept.has(tx.id) && 'opacity-60', ui.editorOpen && ui.editing?.id === tx.id && 'bg-muted shadow-[inset_3px_0_0_var(--primary)]')"
            :title="kept.has(tx.id) ? KEPT_TITLE : undefined"
            :data-state="selected.has(tx.id) ? 'selected' : undefined"
            @click="ui.openEdit(tx)"
          >
            <TableCell class="pl-4" @click.stop @click.capture="noteShift" @mousedown="keepTextUnselected">
              <Checkbox :model-value="selected.has(tx.id)" :aria-label="`Select ${titleOf(tx)}`" @update:model-value="(v) => toggle(tx.id, !!v)" />
            </TableCell>
            <template v-for="col in visibleColumns" :key="col">
              <TableCell v-if="col === 'date'" :style="columns.cellStyle(col)" class="max-w-0 truncate text-muted-foreground tabular">{{ shortDate(tx.date, today) }}</TableCell>
              <TableCell v-else-if="col === 'payee'" :style="columns.cellStyle(col)" class="max-w-0">
                <!-- Its name, or what you call its payee, or its payee as sent. -->
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-medium">{{ titleOf(tx) }}</span>
                  <LinkBadge :tx="tx" />
                  <Repeat v-if="tx.recurringItemId" class="size-3.5 shrink-0 text-muted-foreground" aria-label="Recurring" />
                </div>
                <!-- Under it: its payee as sent, when it shows as something else. Without an Account or Notes column (a narrow table), those too. -->
                <div
                  v-if="tx.tags.length || sentPayeeUnder(tx) || (!hideAccount && !shows('account')) || (tx.notes && !shows('notes'))"
                  class="mt-0.5 flex min-w-0 items-center gap-1.5"
                >
                  <span v-if="sentPayeeUnder(tx)" class="min-w-0 shrink truncate text-xs text-muted-foreground" :title="sentPayeeUnder(tx)!">{{ sentPayeeUnder(tx) }}</span>
                  <span v-if="!hideAccount && !shows('account')" class="shrink-0 text-xs text-muted-foreground">{{ accounts.get(tx.accountId)?.name }}</span>
                  <span v-for="t in tx.tags" :key="t.id" class="shrink-0 rounded-full border px-1.5 text-[11px] text-muted-foreground">#{{ t.name }}</span>
                  <span v-if="tx.notes && !shows('notes')" class="truncate text-xs text-foreground/80" :title="tx.notes">{{ tx.notes }}</span>
                </div>
              </TableCell>
              <TableCell v-else-if="col === 'notes'" :style="columns.cellStyle(col)" class="max-w-0 truncate text-sm text-muted-foreground" :title="tx.notes ?? undefined">
                {{ tx.notes }}
              </TableCell>
              <TableCell v-else-if="col === 'category'" :style="columns.cellStyle(col)" class="max-w-0" @click.stop>
                <span v-if="tx.transferPairId" class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowLeftRight class="size-3.5" />{{ categories.get(tx.categoryId ?? -1)?.name ?? 'Transfer' }}
                </span>
                <!-- A refund's or payback's is what it pays back's: shown, not changed here. -->
                <CategoryBadge
                  v-else-if="tx.categorySource === 'linked'"
                  :category-id="tx.categoryId"
                  :needs-review="tx.needsReview"
                  :source="tx.categorySource"
                  :bills="billCount(tx)"
                  acceptable
                  class="max-w-full"
                  @accept="accept(tx)"
                />
                <div v-else class="flex items-center gap-1">
                  <CategoryPicker variant="badge" :model-value="tx.categoryId" :needs-review="tx.needsReview" @update:model-value="(id) => setCategory(tx, id)" />
                  <Button v-if="tx.needsReview" variant="ghost" size="icon-xs" aria-label="Accept suggested category" title="Accept suggestion" @click="accept(tx)">
                    <Check />
                  </Button>
                  <PayeeChoicePopover v-else-if="ui.payeePrompt?.txId === tx.id" />
                </div>
              </TableCell>
              <TableCell v-else-if="col === 'account'" :style="columns.cellStyle(col)" class="max-w-0 truncate text-muted-foreground">{{ accounts.get(tx.accountId)?.name }}</TableCell>
              <TableCell v-else-if="col === 'amount'" :style="columns.cellStyle(col)" class="max-w-0 truncate text-right">
                <MoneyText :amount="tx.amountMinor" />
                <div v-if="netAmount(tx) !== null" class="text-xs text-muted-foreground">net {{ formatMoney(netAmount(tx)!, tx.currency, { signed: true }) }}</div>
              </TableCell>
              <TableCell v-else :style="columns.cellStyle(col)" class="max-w-0 truncate text-right text-muted-foreground">
                <MoneyText v-if="balanceOf(tx) !== null" :amount="balanceOf(tx)!" :colored="false" :class="overdrawn(tx) && 'text-negative'" />
              </TableCell>
            </template>
            <TableCell class="p-0" />
          </TableRow>
        </TableBody>
      </Table>
      <EmptyState v-else-if="list.isSuccess.value" :icon="Receipt" :title="emptyTitle" :description="emptyDescription"><slot name="empty" /></EmptyState>
    </Card>

    <!-- Phone list grouped by day -->
    <div class="md:hidden">
      <!-- No overflow-hidden here: it would make the card the sticky container for the day headers. -->
      <Card v-if="items.length" class="gap-0 py-0">
        <section v-for="(day, i) in days" :key="day.date">
          <h2
            :class="i === 0 && 'rounded-t-xl'"
            class="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-[5] flex justify-between border-b bg-muted/90 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur"
          >
            <span>{{ formatDateLong(day.date) }}</span>
            <MoneyText :amount="day.total" :colored="false" />
          </h2>
          <TransactionList
            :items="day.items"
            :faded="kept"
            :show-date="false"
            :show-account="!hideAccount"
            :balance-of="balanceOf"
            @open="ui.openEdit"
            @accept="accept"
          />
        </section>
      </Card>
      <Card v-else-if="list.isSuccess.value">
        <EmptyState :icon="Receipt" :title="emptyTitle" :description="emptyDescription"><slot name="empty" /></EmptyState>
      </Card>
    </div>

    <div ref="sentinel" class="flex justify-center py-2">
      <Loader2 v-if="list.isFetchingNextPage.value || (list.isPending.value && !items.length)" class="size-5 animate-spin text-muted-foreground" />
      <Button v-else-if="list.hasNextPage.value" variant="ghost" size="sm" @click="list.fetchNextPage()">Load more</Button>
    </div>
    <PaybackDialog v-if="payback" v-model:open="paybackOpen" :tx="payback.tx" :together="payback.together" :preselect="payback.preselect" @linked="selected = new Set()" />
  </div>
</template>

<style scoped>
:deep(tr[data-state='selected']) {
  background: var(--muted);
}
</style>
