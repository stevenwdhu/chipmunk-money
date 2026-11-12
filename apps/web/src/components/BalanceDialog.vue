<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { formatMoney, parseMoney, statementBalance, type Account } from '@chipmunk/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { previewBalance, useAccountMutations, useAccountSharing } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { money } from '@/lib/format'

const props = defineProps<{ account: Account }>()
const open = defineModel<boolean>('open', { default: false })
const today = useToday()
const m = useAccountMutations()
const amount = ref('')
const date = ref('')
const error = ref('')

// A shared account: the balance recorded is the whole account's, so what it gives each ledger shows first.
const shared = computed(() => !!props.account.sharing)
const sharing = useAccountSharing(() => props.account.id, () => open.value && shared.value)
/** The account as it would be with this balance recorded, from the server's dry run (null while it isn't known). */
const after = ref<Account | null>(null)
const previewError = ref('')
let asked = 0
watch([open, amount, date], ([isOpen]) => {
  after.value = null
  previewError.value = ''
  const mine = ++asked
  const v = parseMoney(amount.value)
  if (!isOpen || !shared.value || v === null || !date.value) return
  // Once typing pauses.
  setTimeout(async () => {
    if (mine !== asked) return
    try {
      const a = await previewBalance({ id: props.account.id, date: date.value, balanceMinor: statementBalance(v, props.account.type) })
      if (mine === asked) after.value = a
    } catch (err) {
      if (mine === asked) previewError.value = errorMessage(err)
    }
  }, 300)
})
/** As the bank's statement shows it: what's owed on a debt. */
const shown = (minor: number) => money(statementBalance(minor, props.account.type))
/**
 * Each ledger's balance on the account now and with this balance recorded, then the total. The dry
 * run gives this ledger's and the total. What the other ledgers hold stays theirs, except the one
 * that carries the opening balance, which takes the rest of the change.
 */
const parts = computed(() => {
  const s = sharing.data.value
  const a = after.value
  if (!s || !a?.sharing || s.home.balanceMinor === null) return null
  const homeChange = a.balanceMinor - s.home.balanceMinor
  const rest = a.sharing.totalBalanceMinor - s.totalBalanceMinor - homeChange
  const lines = [
    { name: s.home.name, before: s.home.balanceMinor, after: a.balanceMinor },
    ...s.members.flatMap((l) => (l.balanceMinor === null ? [] : [{ name: l.name, before: l.balanceMinor, after: l.balanceMinor + (l.slug === s.opening.slug ? rest : 0) }])),
  ]
  return { lines, total: { before: s.totalBalanceMinor, after: a.sharing.totalBalanceMinor } }
})
/** Why the balances can't be shown, as the server says it. */
const problem = computed(() => previewError.value || (sharing.error.value ? errorMessage(sharing.error.value) : ''))
/** A balance is typed and what it gives isn't known yet. */
const waiting = computed(() => shared.value && !parts.value && !problem.value && parseMoney(amount.value) !== null && !!date.value)

watch(open, (v) => {
  if (!v) return
  // As the bank shows it: what's owed on a debt (negative when it's in credit).
  // A shared account's is the whole account's, not this ledger's part of it.
  amount.value = (statementBalance(props.account.sharing?.totalBalanceMinor ?? props.account.balanceMinor, props.account.type) / 100).toFixed(2)
  date.value = today.value
  error.value = ''
})

async function submit() {
  const v = parseMoney(amount.value)
  if (v === null) {
    error.value = 'Enter the balance as a number'
    return
  }
  const balanceMinor = statementBalance(v, props.account.type)
  try {
    await m.setBalance.mutateAsync({ id: props.account.id, date: date.value, balanceMinor })
    toast.success(`${props.account.name} is now ${formatMoney(v)}${props.account.isLiability ? ' owed' : ''}`)
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Update balance</DialogTitle>
        <DialogDescription>
          Record what {{ account.name }} shows on {{ account.institution ? `your ${account.institution} statement` : 'your statement' }}.
          Transactions dated after this are added on top.
          <template v-if="account.sharing">It’s the balance of the whole account, for every ledger that has it.</template>
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label for="bal-amount">{{ account.isLiability ? 'Amount owed' : 'Balance' }}</Label>
            <Input id="bal-amount" v-model="amount" inputmode="decimal" class="tabular" />
          </div>
          <div class="grid gap-1.5">
            <Label for="bal-date">As of</Label>
            <Input id="bal-date" v-model="date" type="date" :max="today" />
          </div>
        </div>
        <template v-if="shared">
          <p v-if="problem" class="text-sm text-destructive">{{ problem }}</p>
          <div v-else-if="parts" class="grid gap-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <div class="flex justify-between gap-3 text-xs font-medium text-muted-foreground"><span>Each ledger’s balance on it</span><span>Now → then</span></div>
            <div v-for="l in parts.lines" :key="l.name" class="flex justify-between gap-3">
              <span class="min-w-0 truncate">{{ l.name }}</span>
              <span class="tabular whitespace-nowrap">
                <template v-if="l.before !== l.after"><span class="text-muted-foreground">{{ shown(l.before) }} →</span> {{ shown(l.after) }}</template>
                <span v-else class="text-muted-foreground">{{ shown(l.after) }}</span>
              </span>
            </div>
            <div class="flex justify-between gap-3 border-t pt-1 font-medium">
              <span>Whole account</span>
              <span class="tabular whitespace-nowrap"><span class="font-normal text-muted-foreground">{{ shown(parts.total.before) }} →</span> {{ shown(parts.total.after) }}</span>
            </div>
          </div>
          <Skeleton v-else-if="waiting" class="h-20" />
        </template>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="m.setBalance.isPending.value || waiting">Save balance</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
