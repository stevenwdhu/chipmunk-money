<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import { parseMoney, type SplitResult, type Transaction } from '@chipmunk/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { previewSplit, useAccounts, useLedgers, useSplitTransaction } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { money } from '@/lib/format'
import { currentLedger } from '@/lib/ledger'
import { SHARES_OVER } from '@/lib/sharing'

/**
 * Splits a card payment on a shared account between the ledgers that have it: one amount for each
 * ledger other than the account's home, which gets the rest. When this ledger holds the payment and
 * isn't the home, its own amount is what it keeps. The server checks the amounts in a dry run before
 * they can be saved. No amounts, or Undo split: the payment is whole again.
 */
const props = defineProps<{ tx: Transaction }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [SplitResult] }>()

const { byId: accounts } = useAccounts()
const ledgers = useLedgers()
const m = useSplitTransaction()

const account = computed(() => accounts.value.get(props.tx.accountId))
const sharing = computed(() => account.value?.sharing ?? null)
const split = computed(() => (props.tx.split?.part === 'payment' ? props.tx.split : null))
/** This ledger, which holds the payment, is the account's home. */
const holdsAsHome = computed(() => !!sharing.value?.isHome)

/** What a ledger has of the payment now: its share, or for this ledger what it keeps. */
function has(slug: string) {
  if (!split.value) return 0
  return Math.max(0, slug === currentLedger.value ? split.value.keptMinor : (split.value.shares.find((s) => s.ledger.slug === slug)?.amountMinor ?? 0))
}
/** Every ledger other than the home. An archived one's share stays as it is, and it gets none when it has none. */
const rows = computed(() =>
  (sharing.value?.ledgers ?? [])
    .filter((l) => l.slug !== sharing.value!.home.slug)
    .map((l) => ({ ...l, own: l.slug === currentLedger.value, archived: !!ledgers.all.value.find((x) => x.slug === l.slug)?.archived, has: has(l.slug) }))
    .filter((l) => l.own || !l.archived || l.has > 0),
)

const texts = ref<Record<string, string>>({})
const error = ref('')
watch(open, (v) => {
  if (!v) return
  texts.value = Object.fromEntries(rows.value.map((l) => [l.slug, l.has ? (l.has / 100).toFixed(2) : '']))
  error.value = ''
})

/** Each amount typed, in cents: null for one that isn't a number above zero. An empty one gives nothing. */
const amounts = computed(() =>
  rows.value.map((l) => {
    const text = (texts.value[l.slug] ?? '').trim()
    const v = text ? parseMoney(text) : 0
    return { ledger: l.slug, amountMinor: v === null || v < 0 ? null : v }
  }),
)
const typo = computed(() => amounts.value.some((a) => a.amountMinor === null))
const shares = computed(() => amounts.value.flatMap((a) => (a.amountMinor ? [{ ledger: a.ledger, amountMinor: a.amountMinor }] : [])))
/** What's left for the home. */
const rest = computed(() => props.tx.amountMinor - shares.value.reduce((n, s) => n + s.amountMinor, 0))
/** Nothing to save: no amounts, on a payment that isn't split. */
const nothing = computed(() => !shares.value.length && !split.value)

// The server checks the amounts as they're typed, once typing pauses, and changes nothing.
const checked = ref<SplitResult | null>(null)
const problem = ref('')
let asked = 0
watch([open, shares, typo], ([isOpen]) => {
  checked.value = null
  problem.value = ''
  const mine = ++asked
  if (!isOpen || typo.value || nothing.value) return
  const input = { id: props.tx.id, shares: shares.value }
  setTimeout(async () => {
    if (mine !== asked) return
    try {
      const r = await previewSplit(input)
      if (mine === asked) checked.value = r
    } catch (err) {
      if (mine === asked) problem.value = errorMessage(err)
    }
  }, 300)
})
const waiting = computed(() => !typo.value && !nothing.value && !checked.value && !problem.value)

async function save(undo = false) {
  error.value = ''
  try {
    const r = await m.mutateAsync({ id: props.tx.id, shares: undo ? [] : shares.value })
    if (r.shares.length) {
      const who = sharing.value?.ledgers.find((l) => l.slug === currentLedger.value)?.name
      toast.success('Payment split', {
        description: [...r.shares.map((s) => `${s.ledger.name} ${money(s.amountMinor)}`), who && `${who} keeps ${money(r.keptMinor)}`].filter(Boolean).join(' · '),
      })
    } else toast.success('Split undone', { description: 'The whole payment counts here again.' })
    open.value = false
    emit('saved', r)
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="sharing && account" class="max-h-[90svh] overflow-y-auto sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Split between ledgers</DialogTitle>
        <DialogDescription>
          {{ money(tx.amountMinor) }} was paid onto {{ account.name }}. Give each ledger its part.
          {{ holdsAsHome ? `${sharing.home.name} keeps the rest.` : `${sharing.home.name}, its home, gets the rest.` }}
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" novalidate @submit.prevent="save()">
        <div class="grid gap-3">
          <div v-for="l in rows" :key="l.slug" class="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3">
            <Label :for="`split-${l.slug}`" class="min-w-0">
              <span class="truncate">{{ l.own ? `${l.name} keeps` : l.name }}</span>
              <Badge v-if="l.archived" variant="secondary">Archived</Badge>
            </Label>
            <div class="relative">
              <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <Input
                :id="`split-${l.slug}`"
                v-model="texts[l.slug]"
                inputmode="decimal"
                autocomplete="off"
                placeholder="0.00"
                class="pl-7 text-right tabular"
                :disabled="l.archived && !l.own"
                :title="l.archived && !l.own ? `${l.name} is archived, so its share stays as it is.` : undefined"
              />
            </div>
          </div>
          <div class="flex items-center justify-between gap-3 border-t pt-3 text-sm">
            <span class="min-w-0 truncate">{{ sharing.home.name }} {{ holdsAsHome ? 'keeps' : 'gets' }}</span>
            <span class="tabular font-medium" :class="rest < 0 && 'text-destructive'">{{ money(rest) }}</span>
          </div>
        </div>
        <p v-if="split && split.keptMinor < 0" class="text-sm text-amber-700 dark:text-amber-400">{{ SHARES_OVER }}.</p>
        <p class="text-sm text-muted-foreground">Each ledger counts its share as a card payment, not spending or income.</p>
        <p v-if="typo" class="text-sm text-destructive">Enter each amount as a number above zero, or leave it empty</p>
        <p v-else-if="problem || error" class="text-sm text-destructive">{{ problem || error }}</p>
        <DialogFooter>
          <Button v-if="split" type="button" variant="ghost" class="text-destructive hover:text-destructive sm:mr-auto" :disabled="m.isPending.value" @click="save(true)">
            Undo split
          </Button>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="m.isPending.value || typo || nothing || !checked">
            <Loader2 v-if="waiting || m.isPending.value" class="animate-spin" />Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
