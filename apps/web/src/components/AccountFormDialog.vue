<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { Loader2, PencilLine, RefreshCw } from '@lucide/vue'
import {
  ACCOUNT_TYPES,
  accountTypeInfo,
  BANK_PROVIDER_LABELS,
  formatMoney,
  parseMoney,
  statementBalance,
  syncIntervalLabel,
  type Account,
  type AccountType,
  type BankProviderKind,
  type LinkableBankAccount,
  type SwitchResult,
} from '@chipmunk/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import InstitutionPicker, { type InstitutionChoice } from '@/components/InstitutionPicker.vue'
import SwitchReviewDialog from '@/components/settings/SwitchReviewDialog.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAccountBankMutations, useAccountMutations, useBankMutations, useInstitutions, useLedgers, useLinkableBankAccounts, useSettings } from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { guessType, similarNames } from '@/lib/bankAccounts'
import { cn } from '@/lib/utils'

/**
 * `bankAccountId` starts a new account as synced from that bank account; `institutionId` puts it there.
 * `showLedger` says which ledger a new one goes in (opened outside one: App settings → Bank sync).
 */
const props = defineProps<{ account?: Account | null; bankAccountId?: string | null; institutionId?: number | null; showLedger?: boolean }>()
const ledgers = useLedgers()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [Account] }>()

const today = useToday()
const m = useAccountMutations()
const linkM = useAccountBankMutations()
const bankM = useBankMutations()
const linkable = useLinkableBankAccounts(open)
const institutions = useInstitutions()

const name = ref('')
const type = ref<AccountType>('chequing')
const institution = ref<InstitutionChoice | null>(null)
const balanceText = ref('')
const openingDate = ref('')
const notes = ref('')
const mode = ref<'manual' | 'synced'>('manual')
const bankAccountId = ref('')
const syncFrom = ref('')
const error = ref('')

const isLiability = computed(() => accountTypeInfo(type.value).liability)
const editing = computed(() => !!props.account)
/**
 * A shared account in a ledger it's shared with: its name, type, starting balance, notes and how it
 * updates are its home's to change. Here only its institution is, which each ledger has its own of.
 */
const member = computed(() => !!props.account?.sharing && !props.account.sharing.isHome)

const settings = useSettings()
const isDesktop = useIsDesktop()
const updateModes = computed(() => {
  // How often its service syncs, once you've picked the bank account.
  const hours = chosen.value && settings.data.value?.bank.syncHours[chosen.value.provider]
  const every = hours ? syncIntervalLabel(hours) : 'automatically'
  return [
    { value: 'manual', label: 'Manual', hint: 'You add or import transactions', icon: PencilLine },
    { value: 'synced', label: 'Synced', hint: `From your bank, ${every}`, icon: RefreshCw },
  ] as const
})
/** Still syncing from the bank account it already does: its "Import from" is shown, and saved only when changed. */
const sameLink = computed(() => !!props.account?.bank && bankAccountId.value === props.account.bank.bankAccountId)
/** An empty "Import from" means no limit. */
const syncFromHint = computed(() => {
  const before = 'Transactions before this date are never imported.'
  const howFar = !chosen.value
    ? 'all of it with Wealthsimple, up to two years with Plaid, 90 days with SimpleFIN'
    : { wealthsimple: 'all of it with Wealthsimple', plaid: 'up to two years with Plaid', simplefin: 'up to 90 days with SimpleFIN' }[chosen.value.provider]
  return `${before} Leave it empty for no limit: all the history the bank provides (${howFar}).`
})

watch(open, (v) => {
  if (!v) return
  const a = props.account
  name.value = a?.name ?? ''
  type.value = a?.type ?? 'chequing'
  const preset = props.institutionId ? institutions.byId.value.get(props.institutionId) : undefined
  institution.value = a ? { id: a.institutionId, name: a.institution } : preset ? { id: preset.id, name: preset.name } : null
  const opening = a?.openingBalanceMinor ?? 0
  // As the bank shows it: what's owed on a debt (negative when it's in credit).
  balanceText.value = opening && a ? (statementBalance(opening, a.type) / 100).toFixed(2) : ''
  openingDate.value = a?.openingDate ?? ''
  notes.value = a?.notes ?? ''
  mode.value = a?.bank || props.bankAccountId ? 'synced' : 'manual'
  bankAccountId.value = a?.bank?.bankAccountId ?? props.bankAccountId ?? ''
  syncFrom.value = a?.bank?.syncFrom ?? ''
  error.value = ''
}, { immediate: true }) // The dialog can mount already open (Accounts page with ?new=1).
// Its own date for the bank account it syncs from; another one starts from the default.
watch(bankAccountId, () => {
  syncFrom.value = sameLink.value ? (props.account?.bank?.syncFrom ?? '') : ''
})

/** Bank accounts this account can sync from: free ones, and the one it already uses. */
const choices = computed(() =>
  (linkable.data.value ?? []).filter((b) => !b.link || b.link.accountId === props.account?.id),
)
const chosen = computed(() => (linkable.data.value ?? []).find((b) => b.id === bankAccountId.value))
/** The choices under the service each comes from (named when there's more than one: the same bank can come through two). */
const choiceGroups = computed(() => {
  const groups = new Map<BankProviderKind, LinkableBankAccount[]>()
  for (const b of choices.value) groups.set(b.provider, [...(groups.get(b.provider) ?? []), b])
  return [...groups].map(([provider, items]) => ({ provider, label: BANK_PROVIDER_LABELS[provider], items }))
})
const bankLabel = (b: LinkableBankAccount) =>
  [b.name, b.institution, b.balanceMinor === null ? null : formatMoney(b.balanceMinor, b.currency)].filter(Boolean).join(' · ')

/** Where a new account synced from `b` goes: an institution with a similar name, else a new one named after the bank. */
function institutionFor(b: LinkableBankAccount): InstitutionChoice {
  const list = institutions.data.value ?? []
  const bankName = b.institution ?? b.connectionName
  const found = list.find((i) => similarNames(i.name, bankName))
  return found ? { id: found.id, name: found.name } : { id: null, name: bankName }
}
const sameChoice = (a: InstitutionChoice | null, b: InstitutionChoice | null) => !!a && !!b && a.id === b.id && a.name === b.name

// For a new account, picking a bank account fills in its details.
watch(chosen, (b, before) => {
  if (editing.value || !b) return
  if (!name.value.trim() || name.value === before?.name) name.value = b.name
  if (!institution.value || (before && sameChoice(institution.value, institutionFor(before)))) institution.value = institutionFor(b)
  type.value = guessType(b)
})
// The default chosen when the list arrives (a new account started from Bank sync).
watch(choices, (list) => {
  if (mode.value === 'synced' && !bankAccountId.value && list.length === 1) bankAccountId.value = list[0]!.id
})

const wasSynced = computed(() => !!props.account?.bank)
const switchingToManual = computed(() => wasSynced.value && mode.value === 'manual')
/** A synced account's balance is the bank's, so there's no starting balance to enter. */
const balanceFromBank = computed(() => mode.value === 'synced')
const saving = computed(() => m.create.isPending.value || m.update.isPending.value || linkM.link.isPending.value || linkM.unlink.isPending.value)

async function syncNow(connectionId: string, accountId: number) {
  try {
    const r = await bankM.sync.mutateAsync(connectionId)
    const mine = r.accounts.find((a) => a.accountId === accountId)
    if (!r.ok) toast.error(r.error ?? 'The first sync failed. It will retry on its own.')
    else if (mine) toast.success(`Synced: ${mine.added} new transaction${mine.added === 1 ? '' : 's'}${mine.adopted ? `, ${mine.adopted} matched to ones you had` : ''}`)
  } catch (err) {
    // E.g. the day's SimpleFIN requests are used up: the scheduled sync will pick it up.
    toast.info(`Linked. ${errorMessage(err)}`)
  }
}

// The review, when an account with transactions switches bank accounts ----------------------
const reviewOpen = ref(false)
const reviewing = ref<{ account: Account; bankAccount: LinkableBankAccount } | null>(null)
function switched(result: SwitchResult) {
  const r = reviewing.value
  if (!r) return
  const parts = [`${result.matched} matched`, result.added && `${result.added} added`, result.removed && `${result.removed} deleted`].filter(Boolean)
  toast.success(`${r.account.name} now syncs from ${BANK_PROVIDER_LABELS[r.bankAccount.provider]}: ${parts.join(', ')}.`)
}

async function submit() {
  if (!name.value.trim()) return (error.value = 'Give the account a name')
  if (!institution.value) return (error.value = 'Choose the institution, or type the name of a new one')
  if (props.account && member.value) {
    error.value = ''
    try {
      const where = institution.value.id === null ? { institution: institution.value.name } : { institutionId: institution.value.id }
      const saved = await m.update.mutateAsync({ id: props.account.id, ...where })
      open.value = false
      emit('saved', saved)
      toast.success('Account saved')
    } catch (err) {
      error.value = errorMessage(err)
    }
    return
  }
  if (mode.value === 'synced' && !bankAccountId.value) return (error.value = 'Choose the bank account to sync from')
  const amount = balanceText.value ? parseMoney(balanceText.value) : 0
  if (amount === null) return (error.value = 'Enter the balance as a number, like 1250.00')
  // Debts are stored as negative balances, so what's owed is flipped.
  const openingBalanceMinor = statementBalance(amount, type.value)
  const base = {
    name: name.value.trim(),
    type: type.value,
    ...(institution.value.id === null ? { institution: institution.value.name } : { institutionId: institution.value.id }),
    notes: notes.value.trim() || null,
  }
  // Empty: no limit.
  const link = mode.value === 'synced' ? { bankAccountId: bankAccountId.value, syncFrom: syncFrom.value || null } : null
  const syncFromChanged = sameLink.value && (syncFrom.value || null) !== (props.account?.bank?.syncFrom ?? null)
  // Decided now: once saved, the account no longer looks synced.
  const toManual = switchingToManual.value
  error.value = ''
  try {
    let saved: Account
    let linkedNow = false
    if (!props.account) {
      saved = await m.create.mutateAsync(
        link ? { ...base, bank: link } : { ...base, openingBalanceMinor, openingDate: openingDate.value || undefined },
      )
      linkedNow = !!link
    } else {
      // Switched to manual first, so its starting balance can be set.
      if (toManual) await linkM.unlink.mutateAsync(props.account.id)
      saved = await m.update.mutateAsync({ id: props.account.id, ...base, ...(balanceFromBank.value ? {} : { openingBalanceMinor }) })
      // Its transactions are paired with the new bank account's first, for you to review.
      if (!toManual && link && link.bankAccountId !== props.account.bank?.bankAccountId && props.account.transactionCount && chosen.value) {
        open.value = false
        emit('saved', saved)
        reviewing.value = { account: saved, bankAccount: chosen.value }
        reviewOpen.value = true
        return
      }
      if (!toManual && link && (link.bankAccountId !== props.account.bank?.bankAccountId || syncFromChanged)) {
        saved = await linkM.link.mutateAsync({ id: props.account.id, ...link })
        linkedNow = true
      }
    }
    open.value = false
    emit('saved', saved)
    if (linkedNow && syncFromChanged) {
      toast.success(`Saved. ${saved.name} has ${saved.transactionCount} transactions from ${chosen.value?.institution ?? 'your bank'}.`)
    } else if (linkedNow && chosen.value && saved.bank?.lastSyncedAt) {
      // It took what's kept from the bank account's syncs.
      toast.success(`${saved.name} now syncs from ${chosen.value.institution ?? 'your bank'}, with ${saved.transactionCount} transactions.`)
    } else if (linkedNow && chosen.value) {
      // Nothing was fetched for that bank account yet: its first sync, now.
      toast.success(`${saved.name} now syncs from ${chosen.value.institution ?? 'your bank'}. Bringing in transactions…`)
      void syncNow(chosen.value.connectionId, saved.id)
    } else if (toManual) {
      toast.success(`${saved.name} is manual now. Its transactions stay.`)
    } else {
      toast.success(props.account ? 'Account saved' : `Added ${saved.name}`)
    }
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ editing ? 'Edit account' : 'Add account' }}</DialogTitle>
        <DialogDescription>
          <template v-if="showLedger && !account && ledgers.current.value">To the {{ ledgers.current.value.name }} ledger. </template>Balances are in
          {{ account?.currency ?? (mode === 'synced' ? chosen?.currency : null) ?? 'CAD' }}.
          <template v-if="member && account?.sharing">
            {{ account.name }}’s home is {{ account.sharing.home.name }}. Its name, type, starting balance and notes are changed there.
          </template>
        </DialogDescription>
      </DialogHeader>
      <form class="grid min-w-0 gap-4" @submit.prevent="submit">
        <!-- Syncing is set up from a computer: on a phone, a synced account says where it syncs from. -->
        <p v-if="!isDesktop && account?.bank && !member" class="text-sm text-muted-foreground">
          Syncs from {{ account.bank.institution ?? account.bank.name }} through {{ BANK_PROVIDER_LABELS[account.bank.provider] }}. Change how it
          updates from a computer.
        </p>
        <template v-if="isDesktop && !member">
        <div class="grid gap-1.5">
          <FieldLabel hint="Synced accounts get their transactions and balance from your bank, through a bank sync service in App settings (SimpleFIN, Plaid or Wealthsimple). You can switch either way at any time.">
            Updates
          </FieldLabel>
          <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Updates">
            <button
              v-for="opt in updateModes"
              :key="opt.value"
              type="button"
              role="radio"
              :aria-checked="mode === opt.value"
              :class="cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors', mode === opt.value ? 'border-primary bg-muted' : 'hover:bg-muted/50')"
              @click="mode = opt.value"
            >
              <component :is="opt.icon" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span class="grid">
                <span class="font-medium">{{ opt.label }}</span>
                <span class="text-xs text-muted-foreground">{{ opt.hint }}</span>
              </span>
            </button>
          </div>
        </div>

        <template v-if="mode === 'synced'">
          <div class="grid min-w-0 gap-1.5">
            <FieldLabel html-for="acc-bank">Bank account</FieldLabel>
            <p v-if="linkable.isSuccess.value && !choices.length" class="text-sm text-muted-foreground">
              No bank accounts to sync from yet.
              <RouterLink :to="{ name: 'app-settings', query: { tab: 'bank' } }" class="underline underline-offset-2" @click="open = false">
                Connect your bank in App settings → Bank sync
              </RouterLink>
              first.
            </p>
            <Select v-else v-model="bankAccountId">
              <SelectTrigger id="acc-bank" class="w-full min-w-0"><SelectValue placeholder="Choose a bank account" class="block! min-w-0 truncate" /></SelectTrigger>
              <SelectContent>
                <SelectGroup v-for="g in choiceGroups" :key="g.provider">
                  <SelectLabel v-if="choiceGroups.length > 1">{{ g.label }}</SelectLabel>
                  <SelectItem v-for="b in g.items" :key="b.id" :value="b.id">{{ bankLabel(b) }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div v-if="choices.length" class="grid gap-1.5">
            <FieldLabel
              html-for="acc-sync-from"
              optional
              :hint="syncFromHint"
            >
              Import from
            </FieldLabel>
            <Input id="acc-sync-from" v-model="syncFrom" type="date" :max="today" />
          </div>
          <p v-if="editing && !wasSynced && choices.length" class="text-xs text-muted-foreground">
            Transactions you already have are matched with the bank’s instead of being added twice.
          </p>
          <p v-if="chosen && chosen.currency !== (account?.currency ?? chosen.currency)" class="text-xs text-amber-600 dark:text-amber-400">
            The bank reports this account in {{ chosen.currency }}, but this account is in {{ account?.currency }}.
          </p>
        </template>
        <p v-else-if="switchingToManual" class="text-xs text-muted-foreground">
          The account stops syncing. All its transactions stay, and you can switch back to synced later.
        </p>
        </template>

        <div v-if="!member" class="grid gap-1.5">
          <Label for="acc-name">Name</Label>
          <Input id="acc-name" v-model="name" placeholder="TD Chequing" autocomplete="off" />
        </div>
        <!-- One column, so a long institution name is cut short instead of widening the field. -->
        <div class="grid grid-cols-1 gap-1.5">
          <FieldLabel html-for="acc-inst" hint="The bank, or wherever the account is held (e.g. “Wallet” for cash). Accounts are grouped by institution in the sidebar.">
            Institution
          </FieldLabel>
          <InstitutionPicker id="acc-inst" v-model="institution" />
        </div>
        <!-- Only credit cards can be shared, so a shared account keeps its type. -->
        <div v-if="!member" class="grid gap-1.5">
          <Label for="acc-type">Type</Label>
          <Select v-model="type" :disabled="!!account?.sharing">
            <SelectTrigger id="acc-type" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="t in ACCOUNT_TYPES" :key="t.value" :value="t.value">{{ t.label }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="!balanceFromBank && !member" class="grid grid-cols-2 gap-3">
          <div class="grid min-w-0 gap-1.5">
            <Label for="acc-balance">{{ isLiability ? 'Amount owed' : 'Starting balance' }}</Label>
            <Input id="acc-balance" v-model="balanceText" inputmode="decimal" placeholder="0.00" class="tabular" />
          </div>
          <div v-if="!editing" class="grid min-w-0 gap-1.5">
            <Label for="acc-date">As of</Label>
            <Input id="acc-date" v-model="openingDate" type="date" :max="today" />
          </div>
        </div>
        <div v-if="!member" class="grid gap-1.5">
          <Label for="acc-notes">Notes</Label>
          <Textarea id="acc-notes" v-model="notes" rows="2" />
        </div>
        <p v-if="balanceFromBank && !member" class="text-xs text-muted-foreground">Its balance is the bank’s: each sync sets it to what the bank shows.</p>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="saving"><Loader2 v-if="saving" class="animate-spin" />{{ editing ? 'Save' : 'Add account' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
  <SwitchReviewDialog
    v-model:open="reviewOpen"
    :account="reviewing?.account ?? null"
    :bank-account="reviewing?.bankAccount ?? null"
    :connection-id="reviewing?.bankAccount.connectionId ?? null"
    @switched="switched"
  />
</template>
