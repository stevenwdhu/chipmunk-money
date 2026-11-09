<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { refDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { Loader2, RotateCcw, Search } from '@lucide/vue'
import { formatMoney, parseMoney, type Transaction, type TransactionLink } from '@st/shared'
import CategoryFilter from '@/components/CategoryFilter.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAccounts, useCategories, useLinkCandidates, useLinkedTransactionsOf, useTransactionMutations } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { shortDate } from '@/lib/format'
import { billCount, namesOf, shortPayee } from '@/lib/links'
import { titleOf } from '@/lib/payee'
import { cn } from '@/lib/utils'

/**
 * Paybacks: money someone sent you for their share of bills you paid. From the money in, the bills it
 * pays back (one e-Transfer can cover several), each with how much of it goes there. From a bill, the
 * money in that paid it back (several people can). Bills count only your share, in their own month.
 * Opened from a selection in the list, what was selected comes picked, and only the picked ones show.
 * Several money in selected pay back together: their amounts add up, and each takes its part of each bill.
 */
const props = defineProps<{
  tx: Transaction
  /** More money in paying back together with it. */
  together?: Transaction[]
  /** Ones to pick to start with, beside the paybacks it has. */
  preselect?: Transaction[]
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ linked: [Transaction] }>()

const today = useToday()
const { byId: accounts } = useAccounts()
const { byId: categories, colorOf } = useCategories()
const m = useTransactionMutations()

/** From the money in (it pays bills back), or from a bill (money in paid it back). */
const fromMoneyIn = computed(() => props.tx.amountMinor > 0)
/** The money in paying back (several, together), or the bill. */
const sources = computed(() => (fromMoneyIn.value ? [props.tx, ...(props.together ?? [])] : [props.tx]))
const pooled = computed(() => sources.value.length > 1)
const cap = computed(() => sources.value.reduce((n, t) => n + Math.abs(t.amountMinor), 0))
const search = ref('')
const q = refDebounced(search, 250)
/** Only ones in these categories (at any date, like a search). */
const categoryIds = ref<Array<number | 'none'>>([])
/** Searched or by category: what matches, at any date, not what's around it. */
const looking = computed(() => !!q.value || categoryIds.value.length > 0)
const candidates = useLinkCandidates(() => (open.value ? props.tx.id : null), 'payback', q, categoryIds)
const linked = useLinkedTransactionsOf(() => (open.value ? sources.value.filter((t) => t.links.length).map((t) => t.id) : []))

interface Row {
  transaction: Transaction
  /** What's left of it to link (unknown for one linked already that isn't listed). */
  leftMinor: number | null
  likely: boolean
}
/** Every row seen since it opened, so a picked one still shows after a search leaves it out. */
const seen = ref(new Map<number, Row>())
/** What's picked, in the order you picked them. */
const picked = ref<number[]>([])
/** Shares you typed (or saved before), which stay as they are. The others split what's left in proportion. */
const manual = ref(new Map<number, number>())
/** The share being typed, and its text. */
const editingId = ref<number | null>(null)
const editText = ref('')
const shareInput = useTemplateRef<Array<InstanceType<typeof Input>>>('shareInput')
/** Only the picked ones: the ones picked when it was turned on, so unpicking one there doesn't move it away. */
const showSelected = ref(false)
const shownIds = ref<number[]>([])
const error = ref('')
const amountText = (minor: number) => (minor / 100).toFixed(2)

// The paybacks it has are picked to start with, and the ones it came with (only those shown).
watch(
  open,
  (v) => {
    if (!v) return
    error.value = ''
    search.value = ''
    categoryIds.value = []
    seen.value = new Map()
    remember()
    // Together, what they each give a bill adds up.
    const saved = new Map<number, number>()
    for (const t of sources.value) for (const l of t.links) if (l.kind === 'payback') saved.set(l.transactionId, (saved.get(l.transactionId) ?? 0) + l.amountMinor)
    const extra = (props.preselect ?? []).filter((t) => !saved.has(t.id))
    for (const t of extra) if (!seen.value.has(t.id)) seen.value.set(t.id, { transaction: t, leftMinor: null, likely: false })
    picked.value = [...saved.keys(), ...extra.map((t) => t.id)]
    manual.value = new Map(saved)
    editingId.value = null
    showSelected.value = extra.length > 0
    shownIds.value = [...picked.value]
  },
  { immediate: true },
)

/**
 * Every transaction it could link, as the server ranks them (likely ones first), then ones linked
 * already, and ones it came with picked, that it didn't list.
 */
const known = computed(() => {
  const map = new Map<number, Row>()
  for (const c of candidates.data.value ?? []) map.set(c.transaction.id, c)
  if (looking.value) return map
  for (const l of linked.data.value ?? []) if (l.link.kind === 'payback' && !map.has(l.transaction.id)) map.set(l.transaction.id, { transaction: l.transaction, leftMinor: null, likely: false })
  for (const t of props.preselect ?? []) if (!map.has(t.id)) map.set(t.id, seen.value.get(t.id) ?? { transaction: t, leftMinor: null, likely: false })
  return map
})
function remember() {
  const next = new Map(seen.value)
  for (const l of linked.data.value ?? []) if (!next.has(l.transaction.id)) next.set(l.transaction.id, { transaction: l.transaction, leftMinor: null, likely: false })
  for (const c of candidates.data.value ?? []) next.set(c.transaction.id, c)
  seen.value = next
}
watch([() => candidates.data.value, () => linked.data.value], remember)
watch(showSelected, (on) => {
  if (on) shownIds.value = [...picked.value]
})
/** Picking one doesn't move it: they stay in the order they're listed. */
const rows = computed(() =>
  showSelected.value ? shownIds.value.flatMap((id) => (seen.value.get(id) ? [seen.value.get(id)!] : [])) : [...known.value.values()],
)

/** Their refunds stay as they are. */
const refundsOf = (t: Transaction): TransactionLink[] => t.links.filter((l) => l.kind === 'refund')
const refunded = computed(() => sources.value.reduce((n, t) => n + refundsOf(t).reduce((sum, l) => sum + l.amountMinor, 0), 0))
const money = (minor: number) => formatMoney(minor, props.tx.currency)
/**
 * What's left of one to link: as the server said, or (linked already, not listed) all of it. The
 * server leaves out only what it has from this one, so what the others paying back together have
 * of it is added back: those links are set again here.
 */
const leftOf = (id: number) => {
  const r = seen.value.get(id)
  if (r?.leftMinor == null) return Math.abs(r?.transaction.amountMinor ?? 0)
  const others = (props.together ?? []).flatMap((t) => t.links).filter((l) => l.kind === 'payback' && l.transactionId === id)
  return r.leftMinor + others.reduce((n, l) => n + l.amountMinor, 0)
}

/**
 * Splits `budget` (cents) over the rows in proportion to their weight, none past what it has left
 * (`cap`): one whose share would be more gets all it has left, and the rest is split again. Rounded to
 * the cent so they add up exactly, the biggest remainders getting the odd cents.
 */
function split(budget: number, rows: Array<{ id: number; weight: number; cap: number }>): Map<number, number> {
  const out = new Map<number, number>()
  let left = Math.max(budget, 0)
  let rest = rows
  for (;;) {
    const weight = rest.reduce((n, r) => n + r.weight, 0)
    const full = rest.filter((r) => weight <= 0 || (left * r.weight) / weight >= r.cap)
    if (!full.length) break
    for (const r of full) {
      const give = Math.min(r.cap, left)
      out.set(r.id, give)
      left -= give
    }
    rest = rest.filter((r) => !full.includes(r))
    if (!rest.length) return out
  }
  const weight = rest.reduce((n, r) => n + r.weight, 0)
  const exact = rest.map((r) => (left * r.weight) / weight)
  const cents = exact.map(Math.floor)
  let odd = left - cents.reduce((n, c) => n + c, 0)
  for (const i of exact.map((v, i) => i).sort((a, b) => exact[b]! - Math.floor(exact[b]!) - (exact[a]! - Math.floor(exact[a]!)))) {
    if (odd <= 0) break
    cents[i]!++
    odd--
  }
  rest.forEach((r, i) => out.set(r.id, cents[i]!))
  return out
}

/** Each pick's share: the ones you typed, and the rest of the money split by what each has left. */
const shares = computed(() => {
  const typed = picked.value.filter((id) => manual.value.has(id))
  const budget = cap.value - refunded.value - typed.reduce((n, id) => n + manual.value.get(id)!, 0)
  const out = split(
    budget,
    picked.value.filter((id) => !manual.value.has(id)).map((id) => ({ id, weight: leftOf(id), cap: leftOf(id) })),
  )
  for (const id of typed) out.set(id, manual.value.get(id)!)
  return out
})
const amounts = computed(() => picked.value.map((id) => ({ id, minor: shares.value.get(id) ?? 0 })))
const total = computed(() => amounts.value.reduce((sum, a) => sum + a.minor, 0))

/**
 * Paying back together, what each money in gives each bill: each gives in proportion to what it has,
 * split across the bills as their shares are, so it all adds up both ways (to the cent).
 */
function allocate(shares: Array<{ id: number; minor: number }>): Map<number, Array<{ id: number; minor: number }>> {
  const room = (t: Transaction) => Math.abs(t.amountMinor) - refundsOf(t).reduce((n, l) => n + l.amountMinor, 0)
  const gives = split(
    shares.reduce((n, s) => n + s.minor, 0),
    sources.value.map((t) => ({ id: t.id, weight: room(t), cap: room(t) })),
  )
  // What's left of each bill's share for the next ones: each splits across what's left, so the last gives exactly that.
  const rest = new Map(shares.map((s) => [s.id, s.minor]))
  const out = new Map<number, Array<{ id: number; minor: number }>>()
  for (const t of sources.value) {
    const row = split(gives.get(t.id) ?? 0, shares.map((s) => ({ id: s.id, weight: rest.get(s.id)!, cap: rest.get(s.id)! })))
    out.set(t.id, shares.map((s) => ({ id: s.id, minor: row.get(s.id) ?? 0 })).filter((a) => a.minor > 0))
    for (const [id, minor] of row) rest.set(id, rest.get(id)! - minor)
  }
  return out
}

function toggle(id: number, on: boolean) {
  if (on && !picked.value.includes(id)) picked.value = [...picked.value, id]
  if (!on) {
    picked.value = picked.value.filter((x) => x !== id)
    manual.value.delete(id)
    if (editingId.value === id) editingId.value = null
  }
}
/** Opens its share for typing, selected so what you type replaces it. */
async function startEdit(id: number) {
  editingId.value = id
  editText.value = amountText(shares.value.get(id) ?? 0)
  await nextTick()
  const el = shareInput.value?.[0]?.$el as HTMLInputElement | undefined
  el?.focus()
  el?.select()
}
/** A share you typed stays. Emptied, it goes back to its share in proportion. */
function commitEdit() {
  const id = editingId.value
  if (id === null) return
  editingId.value = null
  const text = editText.value.trim()
  if (!text) return void manual.value.delete(id)
  const minor = parseMoney(text)
  if (minor === null || minor <= 0) return void (error.value = 'Enter an amount above zero, like 30.00')
  error.value = ''
  if (minor !== shares.value.get(id)) manual.value = new Map(manual.value).set(id, minor)
}
function resetShare(id: number) {
  const next = new Map(manual.value)
  next.delete(id)
  manual.value = next
}

const summary = computed(() => {
  if (fromMoneyIn.value) {
    const rest = cap.value - refunded.value - total.value
    const where = pooled.value ? 'their own categories' : 'its own category'
    return `${money(total.value)} of ${money(cap.value)} goes to bills.${rest > 0 && picked.value.length ? ` The other ${money(rest)} stays in ${where}.` : ''}`
  }
  return `Paid back ${money(total.value)} of ${money(cap.value)}. Your share is ${money(Math.max(cap.value - refunded.value - total.value, 0))}.`
})
const invalid = computed(() => {
  const nothing = amounts.value.find((a) => a.minor <= 0)
  if (nothing) return `${seen.value.get(nothing.id) ? shortPayee(seen.value.get(nothing.id)!.transaction) : 'One'} would get nothing. Lower another share, or unpick it.`
  if (total.value + refunded.value > cap.value) return fromMoneyIn.value ? `That’s more than the ${money(cap.value)} that came in.` : `That’s more than the ${money(cap.value)} it cost.`
  return ''
})

function details(t: Transaction) {
  return [shortDate(t.date, today.value), accounts.value.get(t.accountId)?.name].filter(Boolean).join(' · ')
}
/**
 * Its category, to show: its own, or for money in that pays back several bills, those bills' (it counts in
 * each one's, as the category filter takes it). `color` null: none of its own.
 */
function categoryOf(t: Transaction): { name: string; color: string | null; none: boolean } {
  const bills = billCount(t)
  if (bills) return { name: `${bills} bills`, color: null, none: false }
  const c = t.categoryId ? categories.value.get(t.categoryId) : undefined
  return c ? { name: c.name, color: colorOf(c) ?? null, none: false } : { name: 'Uncategorized', color: null, none: true }
}
/** Its category's colour; dashed when it has none, plain grey for several bills'. */
const dotStyle = (c: { color: string | null; none: boolean }) =>
  c.color ? { background: c.color } : c.none ? { border: '1px dashed currentColor' } : { background: 'var(--muted-foreground)', opacity: '0.4' }
/**
 * Pick, what it is, its category (from a tablet up), its amount, and how much goes to it. Each row is its own grid, so from a tablet
 * up the category and amount are fixed widths, to line up. Written out in full so Tailwind sees it.
 */
const COLUMNS = 'grid grid-cols-[1rem_minmax(0,1fr)_auto_6.5rem] gap-x-3 sm:grid-cols-[1rem_minmax(0,1fr)_10rem_6rem_6.5rem]'

const saving = computed(() => m.setLinks.isPending.value || m.setLinksTogether.isPending.value)
const keepRefunds = (t: Transaction) => refundsOf(t).map((l) => ({ transactionId: l.transactionId, amountMinor: l.amountMinor, kind: l.kind }))
const paybackLinks = (list: Array<{ id: number; minor: number }>) => list.map((a) => ({ transactionId: a.id, amountMinor: a.minor, kind: 'payback' as const }))

async function save() {
  if (invalid.value) return (error.value = invalid.value)
  error.value = ''
  try {
    let updated: Transaction
    if (pooled.value) {
      const plan = allocate(amounts.value)
      const sets = sources.value.map((t) => ({ id: t.id, links: [...keepRefunds(t), ...paybackLinks(plan.get(t.id) ?? [])] }))
      updated = (await m.setLinksTogether.mutateAsync({ sets }))[0]!
    } else {
      updated = await m.setLinks.mutateAsync({ id: props.tx.id, links: [...keepRefunds(props.tx), ...paybackLinks(amounts.value)] })
    }
    const n = picked.value.length
    const bills = n === 1 ? 'a bill' : `${n} bills`
    toast.success(n ? (fromMoneyIn.value ? (pooled.value ? `${sources.value.length} paybacks for ${bills}` : `Payback for ${bills}`) : `Paid back by ${n === 1 ? 'one' : n}`) : 'No longer a payback')
    open.value = false
    emit('linked', updated)
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ fromMoneyIn ? 'Payback for bills' : 'Paid back by' }}</DialogTitle>
        <!-- Which one it's for: from the list, nothing else says. -->
        <p v-if="pooled" class="text-sm font-medium">{{ namesOf(sources) }} · {{ money(cap) }} together</p>
        <p v-else class="text-sm font-medium">{{ shortPayee(tx) }} · {{ money(tx.amountMinor) }} · {{ shortDate(tx.date, today) }}</p>
        <DialogDescription>
          <template v-if="pooled">
            Pick the bills you paid that these pay back together. Their sum is split across them in proportion, and you can change any share. Each bill then counts only your share, in its own month.
          </template>
          <template v-else-if="fromMoneyIn">
            Pick the bills you paid that this pays back. It’s split across them in proportion, and you can change any share. Each bill then counts only your share, in its own month.
          </template>
          <template v-else>Pick the money people sent you for this. Each goes to it, up to what the bill comes to, and you can change any. It then counts only your share.</template>
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex h-9 min-w-0 flex-1 basis-48 items-center gap-2 rounded-md border px-3">
          <Search class="size-4 shrink-0 opacity-50" />
          <input
            v-model="search"
            :placeholder="fromMoneyIn ? 'Search bills' : 'Search money in'"
            :disabled="showSelected"
            class="h-full w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:opacity-50"
          />
          <Loader2 v-if="candidates.isFetching.value" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        </div>
        <!-- On a phone it shares a line with Show selected, under the search. -->
        <CategoryFilter v-model="categoryIds" :disabled="showSelected" class="min-w-0 flex-1 basis-32 sm:w-44 sm:flex-none" />
        <label class="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          <Checkbox :model-value="showSelected" @update:model-value="(v) => (showSelected = v === true)" />Show selected ({{ picked.length }})
        </label>
      </div>

      <div class="-mx-1 max-h-[50vh] overflow-y-auto">
        <p v-if="!rows.length && (showSelected || !candidates.isPending.value)" class="px-2 py-6 text-center text-sm text-muted-foreground">
          <template v-if="showSelected">Nothing is selected yet.</template>
          <template v-else-if="looking">Nothing with something left to pay back matches.</template>
          <template v-else-if="fromMoneyIn">No bill from the 60 days before it has something left to pay back. Search for older ones.</template>
          <template v-else>No money in from around then. Search for it.</template>
        </p>
        <!-- Columns: pick, what it is, its category (on a phone, in its details), its amount, and how much of the money goes to it. -->
        <div v-if="rows.length" :class="cn(COLUMNS, 'px-2 pb-1 text-xs text-muted-foreground')">
          <span />
          <span />
          <span class="hidden sm:block">Category</span>
          <span class="text-right">Amount</span>
          <span class="text-right">{{ fromMoneyIn ? (pooled ? 'From these' : 'From this') : 'Toward this' }}</span>
        </div>
        <div
          v-for="r in rows"
          :key="r.transaction.id"
          :class="cn(COLUMNS, 'items-center rounded-md px-2 py-2 text-sm', picked.includes(r.transaction.id) && 'bg-muted/60')"
        >
          <Checkbox
            :model-value="picked.includes(r.transaction.id)"
            :aria-label="`Pick ${titleOf(r.transaction)}`"
            @update:model-value="(v) => toggle(r.transaction.id, v === true)"
          />
          <button type="button" class="grid min-w-0 gap-0.5 text-left" @click="toggle(r.transaction.id, !picked.includes(r.transaction.id))">
            <span class="truncate">{{ shortPayee(r.transaction) }}</span>
            <span class="truncate text-xs text-muted-foreground">
              {{ details(r.transaction) }}<template v-if="r.leftMinor !== null && r.leftMinor < Math.abs(r.transaction.amountMinor)"> · {{ money(r.leftMinor) }} left</template>
            </span>
            <!-- On a phone, with no room for its column, its category is a line of its own. -->
            <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
              <span class="size-2 shrink-0 rounded-full" :style="dotStyle(categoryOf(r.transaction))" />
              <span class="truncate">{{ categoryOf(r.transaction).name }}</span>
            </span>
          </button>
          <span
            class="hidden max-w-full min-w-0 items-center gap-1.5 justify-self-start rounded-full border px-2 py-0.5 text-xs sm:inline-flex"
            :class="categoryOf(r.transaction).color === null && 'text-muted-foreground'"
            :title="categoryOf(r.transaction).name"
          >
            <span class="size-2 shrink-0 rounded-full" :style="dotStyle(categoryOf(r.transaction))" />
            <span class="truncate">{{ categoryOf(r.transaction).name }}</span>
          </span>
          <span class="text-right tabular-nums">{{ money(r.transaction.amountMinor) }}</span>
          <!-- Its share: in proportion unless you type one (click it). -->
          <div class="flex min-w-0 items-center justify-end gap-1">
            <template v-if="picked.includes(r.transaction.id)">
              <Input
                v-if="editingId === r.transaction.id"
                ref="shareInput"
                v-model="editText"
                inputmode="decimal"
                class="h-8 w-full text-right tabular-nums"
                :aria-label="`How much goes to ${titleOf(r.transaction)}`"
                @blur="commitEdit"
                @keydown.enter.prevent="commitEdit"
                @keydown.escape.stop.prevent="editingId = null"
              />
              <template v-else>
                <button
                  v-if="manual.has(r.transaction.id)"
                  type="button"
                  class="text-muted-foreground hover:text-foreground"
                  title="Back to its share in proportion"
                  :aria-label="`Back to ${titleOf(r.transaction)}’s share in proportion`"
                  @click="resetShare(r.transaction.id)"
                >
                  <RotateCcw class="size-3.5" />
                </button>
                <button
                  type="button"
                  class="font-medium tabular-nums underline decoration-dotted underline-offset-4 hover:decoration-solid"
                  :title="manual.has(r.transaction.id) ? 'The amount you set. Click to change it.' : 'Its share, in proportion to what it has left. Click to change it.'"
                  @click="startEdit(r.transaction.id)"
                >
                  {{ money(shares.get(r.transaction.id) ?? 0) }}
                </button>
              </template>
            </template>
          </div>
        </div>
      </div>

      <p :class="cn('text-sm', invalid && picked.length ? 'text-destructive' : 'text-muted-foreground')">{{ invalid && picked.length ? invalid : summary }}</p>
      <p v-if="error && error !== invalid" class="text-sm text-destructive">{{ error }}</p>
      <DialogFooter>
        <Button type="button" variant="outline" @click="open = false">Cancel</Button>
        <Button type="button" :disabled="!!invalid || saving" @click="save">
          <Loader2 v-if="saving" class="animate-spin" />Save
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
