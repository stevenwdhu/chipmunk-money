<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { ArrowLeftRight, Loader2, Plus } from '@lucide/vue'
import { BANK_PROVIDER_LABELS, formatMoney, type Account, type BankAccount, type BankConnection, type SwitchResult } from '@st/shared'
import SwitchReviewDialog from '@/components/settings/SwitchReviewDialog.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAccountBankMutations, useAccounts, useBankMutations, useLedgers } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { accountKind, guessType, similarNames } from '@/lib/bankAccounts'
import { cn } from '@/lib/utils'

/**
 * "Link" on a bank account in App settings → Bank sync: to a new account (the Add account form), or to
 * an account you have, which then syncs from it instead (from another service, or until now by hand).
 * Accounts at the same bank and of the same kind are listed, closest balance first; the rest at that
 * bank are a click away.
 */
const props = defineProps<{ bankAccount: BankAccount | null; connection: BankConnection | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ addNew: [bankAccountId: string]; linked: [] }>()

const accounts = useAccounts()
const ledgers = useLedgers()
const linkM = useAccountBankMutations()
const bankM = useBankMutations()

const choice = ref<'new' | 'existing'>('new')
const selected = ref<number | null>(null)
const showAll = ref(false)
const error = ref('')

const service = computed(() => (props.connection ? BANK_PROVIDER_LABELS[props.connection.provider] : 'the bank'))
const bankName = computed(() => props.bankAccount?.institution ?? props.connection?.name ?? '')
const kind = computed(() => (props.bankAccount ? accountKind(guessType(props.bankAccount)) : 'other'))
const distance = (a: Account) => Math.abs(a.balanceMinor - (props.bankAccount?.balanceMinor ?? 0))
/** Your accounts at the same bank: the same kind first, closest balance first. */
const atBank = computed(() =>
  (accounts.active.value ?? [])
    .filter((a) => a.bank?.bankAccountId !== props.bankAccount?.id && similarNames(a.institution, bankName.value))
    .sort((a, b) => Number(accountKind(b.type) === kind.value) - Number(accountKind(a.type) === kind.value) || distance(a) - distance(b)),
)
const sameKind = computed(() => atBank.value.filter((a) => accountKind(a.type) === kind.value))
const listed = computed(() => (showAll.value ? atBank.value : sameKind.value))
const chosen = computed(() => atBank.value.find((a) => a.id === selected.value))

watch(open, (v) => {
  if (!v) return
  showAll.value = false
  error.value = ''
  // The likely one is chosen to start with; with none, a new account.
  selected.value = sameKind.value[0]?.id ?? null
  choice.value = selected.value === null ? 'new' : 'existing'
})

const KIND_NAMES: Record<string, string> = { card: 'cards', cash: 'chequing or savings accounts', investment: 'investment accounts', debt: 'loans', other: 'accounts like it' }
const syncedBy = (a: Account) => (a.bank ? `Synced by ${BANK_PROVIDER_LABELS[a.bank.provider]}` : 'Manual')

/** What linking does to the chosen account, in a sentence or two. */
const outcome = computed(() => {
  const a = chosen.value
  if (!a) return []
  const from = a.bank
    ? a.bank.provider === props.connection?.provider
      ? `${a.name} stops syncing from ${a.bank.name} and syncs from ${props.bankAccount?.name} instead.`
      : `${a.name} stops syncing from ${BANK_PROVIDER_LABELS[a.bank.provider]} and syncs from ${service.value}.`
    : `${a.name} starts syncing from ${service.value}. Its balance becomes ${service.value}’s.`
  if (!a.transactionCount) return [from]
  return [from, `Next, you see how its transactions pair with ${service.value}’s, before anything changes.`]
})

const busy = computed(() => linkM.link.isPending.value || bankM.sync.isPending.value)

// The review, for an account with transactions already ---------------------------------------
const reviewOpen = ref(false)
const reviewing = ref<Account | null>(null)
function switched(result: SwitchResult) {
  const a = reviewing.value
  if (!a) return
  emit('linked')
  const parts = [`${result.matched} matched`, result.added && `${result.added} added`, result.removed && `${result.removed} deleted`].filter(Boolean)
  toast.success(`${a.name} now syncs from ${service.value}: ${parts.join(', ')}.`)
}
async function submit() {
  const b = props.bankAccount
  const c = props.connection
  if (!b || !c) return
  if (choice.value === 'new') {
    open.value = false
    emit('addNew', b.id)
    return
  }
  const a = chosen.value
  if (!a) return (error.value = 'Choose the account')
  error.value = ''
  // With transactions already, they're paired with the bank's first, for you to review.
  if (a.transactionCount) {
    open.value = false
    reviewing.value = a
    reviewOpen.value = true
    return
  }
  let linked: Account
  try {
    linked = await linkM.link.mutateAsync({ id: a.id, bankAccountId: b.id })
  } catch (err) {
    return (error.value = errorMessage(err))
  }
  open.value = false
  emit('linked')
  // It took what's kept from the bank account's syncs. Nothing was fetched for it yet: its first sync, now.
  if (linked.bank?.lastSyncedAt) return void toast.success(`${a.name} now syncs from ${service.value}, with ${linked.transactionCount} transactions.`)
  toast.success(`${a.name} now syncs from ${service.value}. Bringing in transactions…`)
  try {
    const r = await bankM.sync.mutateAsync(c.id)
    const mine = r.accounts.find((x) => x.accountId === a.id)
    if (!r.ok) toast.error(r.error ?? 'The first sync failed. It will retry on its own.')
    else if (mine) {
      const matched = mine.updated + mine.adopted
      toast.success(`Synced ${a.name}: ${matched} matched, ${mine.added} new.`)
    }
  } catch (err) {
    toast.info(`Linked. ${errorMessage(err)}`)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Link {{ bankAccount?.name }}</DialogTitle>
        <DialogDescription>
          {{ bankName }}<template v-if="bankAccount && bankAccount.balanceMinor !== null"> · {{ formatMoney(bankAccount.balanceMinor, bankAccount.currency) }}</template>
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid gap-2" role="radiogroup" aria-label="Link it to">
          <button
            type="button"
            role="radio"
            :aria-checked="choice === 'new'"
            :class="cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors', choice === 'new' ? 'border-primary bg-muted' : 'hover:bg-muted/50')"
            @click="choice = 'new'"
          >
            <Plus class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span class="grid">
              <span class="font-medium">To a new account</span>
              <span class="text-xs text-muted-foreground">With its history from {{ service }}</span>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="choice === 'existing'"
            :class="cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors', choice === 'existing' ? 'border-primary bg-muted' : 'hover:bg-muted/50')"
            @click="choice = 'existing'"
          >
            <ArrowLeftRight class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span class="grid">
              <span class="font-medium">To an account you have</span>
              <span class="text-xs text-muted-foreground">It keeps its transactions and syncs from here instead</span>
            </span>
          </button>
        </div>

        <div v-if="choice === 'existing'" class="grid gap-2">
          <p v-if="listed.length && (ledgers.active.value?.length ?? 0) > 1 && ledgers.current.value" class="text-xs text-muted-foreground">
            In the {{ ledgers.current.value.name }} ledger. Switch ledgers in the sidebar for the others.
          </p>
          <div v-if="listed.length" class="divide-y overflow-hidden rounded-lg border" role="radiogroup" aria-label="Account">
            <button
              v-for="a in listed"
              :key="a.id"
              type="button"
              role="radio"
              :aria-checked="selected === a.id"
              :class="cn('flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors', selected === a.id ? 'bg-muted' : 'hover:bg-muted/50')"
              @click="selected = a.id"
            >
              <span class="min-w-0 flex-1 truncate">{{ a.name }}</span>
              <span class="tabular shrink-0 text-muted-foreground" :class="a.balanceMinor < 0 && 'text-negative'">{{ formatMoney(a.balanceMinor, a.currency) }}</span>
              <span class="w-32 shrink-0 text-right text-xs text-muted-foreground">{{ syncedBy(a) }}</span>
            </button>
          </div>
          <p v-else class="text-sm text-muted-foreground">
            No {{ KIND_NAMES[kind] }} at {{ bankName }}<template v-if="ledgers.current.value"> in the {{ ledgers.current.value.name }} ledger</template>.
          </p>
          <button
            v-if="!showAll && atBank.length > sameKind.length"
            type="button"
            class="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
            @click="showAll = true"
          >
            Show all accounts at {{ bankName }}
          </button>
        </div>

        <div v-if="choice === 'existing' && outcome.length" class="grid gap-1 border-t pt-3 text-xs text-muted-foreground">
          <p v-for="(line, i) in outcome" :key="i">{{ line }}</p>
        </div>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="busy || (choice === 'existing' && !chosen)">
            <Loader2 v-if="busy" class="animate-spin" />{{ choice === 'new' || chosen?.transactionCount ? 'Continue' : 'Link' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
  <SwitchReviewDialog v-model:open="reviewOpen" :account="reviewing" :bank-account="bankAccount" :connection-id="connection?.id ?? null" @switched="switched" />
</template>
