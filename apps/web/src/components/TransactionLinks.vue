<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import { toast } from 'vue-sonner'
import { ArrowLeftRight, ChevronDown, HandCoins, PencilLine, Repeat, Undo2 } from '@lucide/vue'
import { formatMoney, recurringLabel, type LinkedTransaction, type Transaction } from '@st/shared'
import PaybackDialog from '@/components/PaybackDialog.vue'
import { Button } from '@/components/ui/button'
import { useAccounts, useLinkedTransactions, useRecurring, useTransaction, useTransactionMutations } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { useUiStore } from '@/stores/ui'
import { errorMessage } from '@/lib/api'
import { shortDate } from '@/lib/format'
import { namesOf, shortPayee } from '@/lib/links'

/**
 * What the app linked a transaction to: for money in, the purchase a refund is for and the bills a
 * payback is for; for a purchase or bill, its refunds and who paid it back (and your share); for a
 * matched transfer, the withdrawal or card payment on the other side. Each is one line with its
 * total, folded, that opens to list what it's linked to and the ways to change or undo it. Also the
 * recurring item it's a payment of (undone further down the form), and whether you corrected the
 * bank's amount or date, which syncs then leave alone.
 */
const props = defineProps<{ tx: Transaction }>()
const emit = defineEmits<{ unlinked: [] }>()

const ui = useUiStore()
const today = useToday()
const { byId: accounts } = useAccounts()
const m = useTransactionMutations()
const recurring = useRecurring()
const item = computed(() => recurring.data.value?.find((i) => i.id === props.tx.recurringItemId))
const other = useTransaction(() => (props.tx.transferMatched ? props.tx.transferPairId : null))
const links = useLinkedTransactions(() => (props.tx.links.length ? props.tx.id : null))
const isIn = computed(() => props.tx.amountMinor > 0)
const money = (minor: number) => formatMoney(minor, props.tx.currency)
const sum = (list: LinkedTransaction[]) => list.reduce((n, l) => n + l.link.amountMinor, 0)
const refunds = computed(() => (links.data.value ?? []).filter((l) => l.link.kind === 'refund'))
const paybacks = computed(() => (links.data.value ?? []).filter((l) => l.link.kind === 'payback'))
const paybackOpen = ref(false)


interface Line {
  /** The transaction on the other side: clicking the line opens it. */
  tx: Transaction
  name: string
  /** When and where it is. */
  meta: string
  amount: string
  /** All of it, when only part of it is linked. */
  of: string | null
}
/** One link of the card: a line saying what it is, and when opened, what it's linked to. */
interface Section {
  key: 'refund-of' | 'payback-for' | 'refunded' | 'paid-back' | 'transfer'
  icon: Component
  title: string
  amount: string | null
  lines: Line[]
  /** Under the lines, after a rule: what's left of it. */
  rest: { label: string; amount: string } | null
}
const meta = (t: Transaction) => [shortDate(t.date, today.value), accounts.value.get(t.accountId)?.name].filter(Boolean).join(' · ')
const line = (l: LinkedTransaction): Line => {
  const full = Math.abs(l.transaction.amountMinor)
  return {
    tx: l.transaction,
    name: shortPayee(l.transaction),
    meta: meta(l.transaction),
    amount: money(l.link.amountMinor),
    of: l.link.amountMinor !== full ? `of ${formatMoney(full, l.transaction.currency)}` : null,
  }
}

const sections = computed<Section[]>(() => {
  const out: Section[] = []
  const [rf, pb] = [refunds.value, paybacks.value]
  const linkedIn = sum(rf) + sum(pb)
  if (isIn.value) {
    // Money in: what it refunds, and what it pays back (the rest of it stays in its own category).
    if (rf.length) {
      const title = rf.length === 1 ? `Refund of ${shortPayee(rf[0]!.transaction)}` : `Refund of ${rf.length} purchases`
      out.push({ key: 'refund-of', icon: Undo2, title, amount: money(sum(rf)), lines: rf.map(line), rest: null })
    }
    if (pb.length) {
      const title = pb.length === 1 ? `Payback for ${shortPayee(pb[0]!.transaction)}` : `Payback for ${pb.length} bills`
      const rest = props.tx.amountMinor - linkedIn
      const restLine = rest > 0 ? { label: 'Stays in its own category', amount: money(rest) } : null
      out.push({ key: 'payback-for', icon: HandCoins, title, amount: money(sum(pb)), lines: pb.map(line), rest: restLine })
    }
  } else {
    // A purchase or bill: its refunds, and who paid it back (what's left is your share).
    if (rf.length) {
      const title = sum(rf) >= -props.tx.amountMinor ? 'Refunded in full' : 'Refunded'
      out.push({ key: 'refunded', icon: Undo2, title, amount: money(sum(rf)), lines: rf.map(line), rest: null })
    }
    if (pb.length) {
      const share = { label: 'Your share', amount: money(Math.max(-props.tx.amountMinor - linkedIn, 0)) }
      out.push({ key: 'paid-back', icon: HandCoins, title: `Paid back by ${namesOf(pb.map((l) => l.transaction))}`, amount: money(sum(pb)), lines: pb.map(line), rest: share })
    }
  }
  if (props.tx.transferMatched) {
    const o = other.data.value
    const where = o ? accounts.value.get(o.accountId)?.name : undefined
    const lines = o ? [{ tx: o, name: shortPayee(o), meta: meta(o), amount: formatMoney(o.amountMinor, o.currency), of: null }] : []
    const title = `Transfer ${props.tx.amountMinor < 0 ? 'to' : 'from'} ${where ?? 'another account'}`
    out.push({ key: 'transfer', icon: ArrowLeftRight, title, amount: null, lines, rest: null })
  }
  return out
})

/** Each starts folded, again for each transaction. */
const expanded = ref(new Set<Section['key']>())
watch(
  () => props.tx.id,
  () => (expanded.value = new Set()),
)
function toggle(key: Section['key']) {
  const next = new Set(expanded.value)
  if (!next.delete(key)) next.add(key)
  expanded.value = next
}

async function resumeSyncing() {
  try {
    await m.update.mutateAsync({ id: props.tx.id, corrected: false })
    toast.success('Bank syncs can update its amount and date again.')
    emit('unlinked')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

async function notTransfer() {
  try {
    await m.update.mutateAsync({ id: props.tx.id, transferPairId: null })
    toast.success('No longer a transfer. Both sides keep their categories.')
    emit('unlinked')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

/** "Not a refund" or "Not a payback": its links of that kind go. It keeps its category, as yours. */
async function unlinkKind(kind: 'refund' | 'payback') {
  try {
    const keep = props.tx.links.filter((l) => l.kind !== kind).map((l) => ({ transactionId: l.transactionId, amountMinor: l.amountMinor, kind: l.kind }))
    await m.setLinks.mutateAsync({ id: props.tx.id, links: keep })
    toast.success(kind === 'refund' ? 'No longer a refund. It keeps its category.' : 'No longer a payback. It keeps its category.')
    emit('unlinked')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div
    v-if="tx.links.length || tx.transferMatched || tx.correctedAt || tx.recurringItemId"
    class="grid gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
  >
    <div v-if="tx.correctedAt" class="flex items-start gap-2">
      <PencilLine class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div class="grid min-w-0 flex-1 justify-items-start gap-0.5">
        <p>You corrected the bank’s amount or date, so bank syncs leave them alone.</p>
        <Button type="button" variant="link" size="sm" class="h-auto px-0" :disabled="m.update.isPending.value" @click="resumeSyncing">Resume syncing</Button>
      </div>
    </div>
    <div v-if="tx.recurringItemId" class="flex items-start gap-2">
      <Repeat class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p class="min-w-0 flex-1">
        A payment of <span class="font-medium">{{ item ? recurringLabel(item) : 'a recurring item' }}</span>.
      </p>
    </div>
    <div v-for="sec in sections" :key="sec.key" class="grid gap-2">
      <button type="button" class="group flex w-full items-center gap-2 text-left" :aria-expanded="expanded.has(sec.key)" @click="toggle(sec.key)">
        <component :is="sec.icon" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ sec.title }}</span>
        <span v-if="sec.amount" class="tabular font-medium">{{ sec.amount }}</span>
        <ChevronDown :class="['size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground', !expanded.has(sec.key) && '-rotate-90']" />
      </button>
      <div v-if="expanded.has(sec.key)" class="grid gap-1 pl-6">
        <!-- Each one it's linked to: who or what and how much of it, then when, where, and all of it. Clicking one opens it. -->
        <button
          v-for="l in sec.lines"
          :key="l.tx.id"
          type="button"
          class="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted"
          :title="`Open ${l.name}`"
          @click="ui.openEdit(l.tx)"
        >
          <span class="truncate">{{ l.name }}</span>
          <span class="tabular text-right">{{ l.amount }}</span>
          <span class="truncate text-xs text-muted-foreground">{{ l.meta }}</span>
          <span class="tabular text-right text-xs text-muted-foreground">{{ l.of }}</span>
        </button>
        <div v-if="sec.rest" class="flex items-center justify-between gap-3 border-t pt-2">
          <span class="text-muted-foreground">{{ sec.rest.label }}</span>
          <span class="tabular font-medium">{{ sec.rest.amount }}</span>
        </div>
        <div v-if="sec.key !== 'refunded'" class="flex gap-4">
          <Button v-if="sec.key === 'payback-for' || sec.key === 'paid-back'" type="button" variant="link" size="sm" class="h-auto px-0" @click="paybackOpen = true">
            Change
          </Button>
          <Button
            v-if="sec.key === 'refund-of' || sec.key === 'payback-for'"
            type="button"
            variant="link"
            size="sm"
            class="h-auto px-0"
            :disabled="m.setLinks.isPending.value"
            @click="unlinkKind(sec.key === 'refund-of' ? 'refund' : 'payback')"
          >
            {{ sec.key === 'refund-of' ? 'Not a refund' : 'Not a payback' }}
          </Button>
          <Button v-if="sec.key === 'transfer'" type="button" variant="link" size="sm" class="h-auto px-0" :disabled="m.update.isPending.value" @click="notTransfer">
            Not a transfer
          </Button>
        </div>
      </div>
    </div>
  </div>
  <PaybackDialog v-model:open="paybackOpen" :tx="tx" @linked="emit('unlinked')" />
</template>
