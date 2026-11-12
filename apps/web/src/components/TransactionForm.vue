<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { Loader2, Sparkles, Trash2 } from '@lucide/vue'
import { formatMoney, parseMoney, recurringLabel, type CategorySuggestion, type Transaction } from '@chipmunk/shared'
import FilterOutOfReport from '@/components/FilterOutOfReport.vue'
import AccountSelect from '@/components/AccountSelect.vue'
import BankDataDialog from '@/components/BankDataDialog.vue'
import CategoryPicker from '@/components/CategoryPicker.vue'
import FieldLabel from '@/components/FieldLabel.vue'
import PaybackDialog from '@/components/PaybackDialog.vue'
import RefundPicker from '@/components/RefundPicker.vue'
import MoveToMenu from '@/components/sharing/MoveToMenu.vue'
import SplitPaymentDialog from '@/components/sharing/SplitPaymentDialog.vue'
import TagInput from '@/components/TagInput.vue'
import TransactionLinks from '@/components/TransactionLinks.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  suggestCategory,
  useAccounts,
  useCategories,
  useLedgers,
  useRecurring,
  useRecurringMutations,
  usePayeeNameMutations,
  useSettings,
  useTransaction,
  useTransactionMutations,
} from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { usePayeeOptions } from '@/composables/usePayeeOptions'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { money } from '@/lib/format'
import { currentLedger, lapi } from '@/lib/ledger'
import { titleOf } from '@/lib/payee'
import { MOVE_SPLIT, SHARES_OVER, sharedNote, sharesFor, splitLock } from '@/lib/sharing'
import { cn } from '@/lib/utils'
import { useUiStore, type QuickAddDefaults } from '@/stores/ui'

const props = defineProps<{ transaction: Transaction | null; defaults: QuickAddDefaults }>()
const emit = defineEmits<{ done: [] }>()

type Kind = 'expense' | 'income' | 'transfer'
const LAST_ACCOUNT = 'st-last-account'

const today = useToday()
const { active: accounts, byId: accountsById } = useAccounts()
const { byId: categoriesById } = useCategories()
const settings = useSettings()
const m = useTransactionMutations()
const ui = useUiStore()
const isDesktop = useIsDesktop()

const editing = computed(() => props.transaction)
/** A synced or imported one's payee is what the bank or file sent: matching and learning go by it. */
const payeeLocked = computed(() => !!editing.value && editing.value.origin !== 'manual')

// Part of a card payment split between the ledgers that share its account. A split row (another
// ledger's share, or what this one gave) has its amount, date, account and payee from the split,
// and the payment keeps its date, account and payee while it's split. The server refuses those
// changes, so they can't be made here, and the reason is said.
const { current: ledger } = useLedgers()
const split = computed(() => editing.value?.split ?? null)
const splitRow = computed(() => !!split.value && split.value.part !== 'payment')
const splitLocked = computed(() => (split.value ? splitLock(split.value, ledger.value?.name ?? 'this ledger') : null))
const splitHeading = computed(() => {
  const s = split.value
  if (!s) return ''
  if (s.part === 'share') return `Share of a ${s.from.name} payment`
  if (s.part === 'given') return `${sharesFor(s.shares).text} of a split payment`
  return `Split between ledgers: ${[...s.shares.map((x) => `${x.ledger.name} ${money(x.amountMinor)}`), `${ledger.value?.name ?? 'this ledger'} keeps ${money(s.keptMinor)}`].join(', ')}`
})
/** The payee as it is, not typed over: the bank's or file's, or a split's. */
const payeeFixed = computed(() => payeeLocked.value || !!split.value)
const splitOpen = ref(false)

// Renaming its payee, on all of the payee's transactions: a payee name rule is made or changed, right
// here, apart from saving.
const names = usePayeeNameMutations()
const renaming = ref(false)
const renameText = ref('')
const renameInput = useTemplateRef<InstanceType<typeof Input>>('renameInput')
watch(() => editing.value?.id, () => (renaming.value = false))
async function startRename() {
  const tx = editing.value
  if (!tx) return
  renameText.value = tx.payeeName
  renaming.value = true
  await nextTick()
  const el = renameInput.value?.$el as HTMLInputElement | undefined
  el?.focus()
  el?.select()
}
async function saveRename() {
  const tx = editing.value
  if (!tx) return
  const name = renameText.value.trim() || null
  try {
    const { rule } = await names.rename.mutateAsync({ payee: tx.payee, name })
    renaming.value = false
    if (rule) {
      const n = rule.transactionCount
      toast.success(`The payee is ${rule.name}`, { description: `On ${n === 1 ? 'its transaction' : `all ${n} of its transactions`}, and new ones. Custom rules are in App settings → Payees.` })
    } else toast.success('The payee goes by what the rules call it again')
    // The copy open here, named again (what you've typed stays).
    ui.openEdit(await lapi.get<Transaction>(`/transactions/${tx.id}`))
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
// The recurring item it's a payment of, and a way to say it isn't.
const recurring = useRecurring()
const rm = useRecurringMutations()
const recurringItem = computed(() => (editing.value?.recurringItemId ? recurring.data.value?.find((i) => i.id === editing.value!.recurringItemId) : undefined))
async function notPartOfItem() {
  const tx = editing.value
  if (!tx?.recurringItemId) return
  try {
    const item = await rm.notPayment.mutateAsync({ id: tx.recurringItemId, transactionId: tx.id })
    toast.success(`No longer part of ${recurringLabel(item)}`, { description: 'It’s uncategorized now.' })
    emit('done')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
const isTransferEdit = computed(() => !!editing.value?.transferPairId)
/** Money in linked in full (a refund, a payback) has the category of what it pays back: shown greyed out, never changed here. */
const isRefund = computed(() => editing.value?.categorySource === 'linked')
/** A refund of one purchase has that purchase's name (and follows it), so it isn't yours to change. */
const nameLocked = computed(() => {
  const tx = editing.value
  return !!tx && tx.amountMinor > 0 && tx.links.length === 1 && tx.links[0]!.kind === 'refund'
})
// Money in that could pay something back: not a transfer, linked already, or a recurring payment.
const canBeRefund = computed(() => {
  const tx = editing.value
  return !!tx && tx.amountMinor > 0 && !tx.transferPairId && !tx.links.length && !tx.recurringItemId && !tx.split
})
// A bill others could pay you back for: money out, not a transfer, that nobody paid back yet.
const canBePaidBack = computed(() => {
  const tx = editing.value
  return !!tx && tx.amountMinor < 0 && !tx.transferPairId && !tx.links.some((l) => l.kind === 'payback') && !tx.split
})
const paybackOpen = ref(false)
/** Linked as a refund or payback: it shows as one, with the category of what it pays back, keeping what you've typed. */
function linkedRefund(tx: Transaction) {
  ui.editing = tx
  categoryId.value = tx.categoryId
  categoryTouched.value = true
  suggestion.value = null
  // The new category is saved already: not a change of yours.
  const before = JSON.parse(initial.value || '[]') as unknown[]
  if (before.length) {
    before[4] = tx.categoryId
    initial.value = JSON.stringify(before)
  }
}

const kind = ref<Kind>('expense')
const amountText = ref('')
const payee = ref('')
/** What it is; a recurring item's payments share the item's name. */
const name = ref('')
const categoryId = ref<number | null>(null)
const accountId = ref<number | null>(null)
const transferAccountId = ref<number | null>(null)
const date = ref('')
/** Its time of day (HH:MM), if you know it: orders a day's transactions. */
const time = ref('')
const tags = ref<string[]>([])
const notes = ref('')
const showNotes = ref(false)
const showBankData = ref(false)
const errors = ref<Record<string, string>>({})

const suggestion = ref<CategorySuggestion | null>(null)
const suggesting = ref(false)
const categoryTouched = ref(false)
const amountInput = ref<InstanceType<typeof Input> | null>(null)

function lastAccount(): number | null {
  try {
    const id = Number(localStorage.getItem(LAST_ACCOUNT))
    return accountsById.value.has(id) ? id : null
  } catch {
    return null
  }
}

function reset(keep = false) {
  const tx = editing.value
  if (tx) {
    kind.value = tx.transferPairId ? 'transfer' : tx.amountMinor > 0 ? 'income' : 'expense'
    amountText.value = (Math.abs(tx.amountMinor) / 100).toFixed(2)
    payee.value = tx.payee
    name.value = tx.name ?? ''
    categoryId.value = tx.categoryId
    accountId.value = tx.accountId
    date.value = tx.date
    time.value = tx.datetime?.slice(11, 16) ?? ''
    tags.value = tx.tags.map((t) => t.name)
    notes.value = tx.notes ?? ''
    showNotes.value = !!tx.notes
    categoryTouched.value = !tx.needsReview
    suggestion.value = tx.needsReview && tx.categoryId
      ? { categoryId: tx.categoryId, source: tx.categorySource === 'ai' ? 'ai' : 'history', confidence: tx.categoryConfidence ?? 0, reason: '' }
      : null
  } else {
    const d = props.defaults
    if (!keep) {
      kind.value = d.amountMinor && d.amountMinor > 0 ? 'income' : 'expense'
      accountId.value = d.accountId ?? lastAccount() ?? accounts.value[0]?.id ?? null
      date.value = d.date ?? today.value
      time.value = ''
      transferAccountId.value = null
    }
    amountText.value = d.amountMinor ? (Math.abs(d.amountMinor) / 100).toFixed(2) : ''
    payee.value = d.payee ?? ''
    name.value = ''
    categoryId.value = d.categoryId ?? null
    tags.value = []
    notes.value = ''
    showNotes.value = false
    categoryTouched.value = d.categoryId !== undefined && d.categoryId !== null
    suggestion.value = null
  }
  errors.value = {}
  initial.value = fields()
  // An existing one already has its suggestion (from when it came in): it's shown, not asked again.
  askedFor = tx ? suggestionKey() : ''
}

/** The fields, to tell whether you changed anything since it opened. */
const fields = () =>
  JSON.stringify([kind.value, amountText.value, payee.value, name.value, categoryId.value, accountId.value, transferAccountId.value, date.value, time.value, tags.value, notes.value])
const initial = ref('')
const dirty = computed(() => !!initial.value && fields() !== initial.value)
watch(dirty, (d) => (ui.editorDirty = d), { immediate: true })
onBeforeUnmount(() => (ui.editorDirty = false))

onMounted(() => {
  reset()
  nextTick(() => (amountInput.value?.$el as HTMLInputElement | undefined)?.focus())
})
// Another transaction (not a newer copy of this one, like after linking a refund), or new defaults.
watch([() => props.transaction?.id, () => props.defaults], () => reset())

// A shared account's transactions can move to another ledger that has it, and a payment onto it can
// be split between them.
const editedAccount = computed(() => (editing.value ? accountsById.value.get(editing.value.accountId) : undefined))
const moveLedgers = computed(() => editedAccount.value?.sharing?.ledgers ?? [])
/** A split payment and the rows of its split stay until the split is undone. What's typed here and not saved wouldn't go along. */
const moveBlocked = computed(() => (split.value ? MOVE_SPLIT : dirty.value ? 'Save your changes first to move it.' : null))
/** A card payment: money onto the account that's a transfer or in a category left out of totals, linked to nothing. One that's split already stays one. */
const canSplit = computed(() => {
  const tx = editing.value
  if (!tx || !editedAccount.value?.sharing) return false
  if (tx.split) return tx.split.part === 'payment'
  return tx.amountMinor > 0 && !tx.links.length && (!!tx.transferPairId || !!categoriesById.value.get(tx.categoryId ?? -1)?.excludeFromTotals)
})

// The note for a shared account whose balances another ledger carries: for the account picked, the
// one it was on, and the other side of a transfer.
const someShared = computed(() => [...accountsById.value.values()].some((a) => a.sharing && a.sharing.opening.slug !== currentLedger.value))
const pair = useTransaction(() => (someShared.value ? (editing.value?.transferPairId ?? null) : null))
const sharedAccountNote = computed(() =>
  sharedNote(
    [accountId.value, editing.value?.accountId, kind.value === 'transfer' ? transferAccountId.value : null, pair.data.value?.accountId].map((id) =>
      id ? accountsById.value.get(id) : undefined,
    ),
    currentLedger.value,
  ),
)

const amountMinor = computed(() => {
  const v = parseMoney(amountText.value)
  if (v === null) return null
  const abs = Math.abs(v)
  // An edited transfer keeps its direction: money in on the receiving side (a card payment, say).
  if (kind.value === 'transfer' && editing.value) return editing.value.amountMinor > 0 ? abs : -abs
  return kind.value === 'income' ? abs : -abs
})

const payeeOptions = usePayeeOptions()

/** What a suggestion depends on. It's asked for again only when one of these changes, or with Ask again. */
const suggestionKey = () => JSON.stringify([payee.value.trim(), kind.value, amountMinor.value, accountId.value])
let askedFor = ''
const canSuggest = computed(() => !isRefund.value && kind.value !== 'transfer' && payee.value.trim().length >= 2)

/** History first, then AI when history has nothing. `again`: you asked, so even with a category you picked. */
async function runSuggestion(again = false) {
  if (!canSuggest.value) return
  if (!again && (categoryTouched.value || suggestionKey() === askedFor)) return
  askedFor = suggestionKey()
  const query = { payee: payee.value, amountMinor: amountMinor.value ?? undefined, accountId: accountId.value ?? undefined }
  suggesting.value = true
  try {
    let s = await suggestCategory({ ...query, useAi: false })
    if (!s.categoryId && settings.data.value?.ai.enabled) s = await suggestCategory({ ...query, useAi: true })
    // You picked one while it was asking.
    if (!again && categoryTouched.value) return
    suggestion.value = s.categoryId ? s : null
    if (s.categoryId) {
      categoryId.value = s.categoryId
      categoryTouched.value = false
    } else if (again) {
      toast.info('No suggestion for this payee yet.')
    }
  } catch (err) {
    // Suggestions are best-effort, unless you asked.
    if (again) toast.error(errorMessage(err))
  } finally {
    suggesting.value = false
  }
}
watchDebounced([payee, kind, amountMinor, accountId], () => runSuggestion(), { debounce: 400 })

function pickCategory(id: number | null) {
  categoryId.value = id
  categoryTouched.value = true
}

const suggestionText = computed(() => {
  const s = suggestion.value
  if (isRefund.value || !s?.categoryId || categoryId.value !== s.categoryId) return null
  const name = categoriesById.value.get(s.categoryId)?.name
  const who = s.source === 'ai' ? 'AI suggestion' : s.source === 'fuzzy' ? 'Similar to a past payee' : 'From your history'
  return `${who}${name ? `: ${name}` : ''}${s.confidence ? ` · ${Math.round(s.confidence * 100)}% sure` : ''}`
})

function validate() {
  const e: Record<string, string> = {}
  if (amountMinor.value === null || amountMinor.value === 0) e.amount = 'Enter an amount'
  if (!payee.value.trim()) e.payee = kind.value === 'transfer' ? 'Describe the transfer' : 'Enter who you paid'
  if (!accountId.value) e.account = 'Pick an account'
  if (kind.value === 'transfer' && !isTransferEdit.value && !transferAccountId.value) e.transfer = 'Pick the account the money goes to'
  if (!date.value) e.date = 'Pick a date'
  errors.value = e
  return Object.keys(e).length === 0
}

const saving = computed(() => m.create.isPending.value || m.update.isPending.value)
/** Its date and time, keeping the seconds a bank gave when the time isn't changed. */
const datetime = () => {
  if (!time.value) return null
  const was = editing.value?.datetime
  return was?.slice(11, 16) === time.value ? `${date.value}${was.slice(10)}` : `${date.value}T${time.value}`
}
const nameChanged = computed(() => (name.value.trim() || null) !== (editing.value?.name ?? null))

/** Saves it: true when it did (and the form is done, unless adding another). */
async function save(addAnother = false): Promise<boolean> {
  if (!validate()) return false
  try {
    try {
      localStorage.setItem(LAST_ACCOUNT, String(accountId.value))
    } catch {
      // ignore
    }
    if (editing.value) {
      const before = editing.value
      const saved = await m.update.mutateAsync({
        id: editing.value.id,
        accountId: accountId.value!,
        date: date.value,
        datetime: datetime(),
        amountMinor: amountMinor.value!,
        ...(payeeFixed.value ? {} : { payee: payee.value.trim() }),
        ...(nameChanged.value ? { name: name.value.trim() || null } : {}),
        notes: notes.value.trim() || null,
        tags: tags.value,
        // A refund's is its purchase's (sent as it is, saving accepts it when it's waiting for review).
        ...(isTransferEdit.value ? {} : { categoryId: isRefund.value ? before.categoryId : categoryId.value }),
      })
      const said = [
        saved.correctedAt && !before.correctedAt && 'You corrected the bank’s data, so bank syncs leave its amount and date alone.',
        // A recurring item's payments share one category.
        saved.recurringItemId && saved.categoryId !== before.categoryId && 'Its recurring item’s other payments have the new category too.',
        // And one name.
        saved.recurringItemId && saved.name !== before.name && 'Its recurring item and its other payments have the new name too.',
      ].filter(Boolean)
      toast.success('Transaction saved', { description: said.length ? said.join(' ') : undefined })
      if (saved.categorySource !== 'linked' && (saved.categoryId !== before.categoryId || before.needsReview)) ui.askAboutPayee(saved)
      emit('done')
      return true
    }
    const created = await m.create.mutateAsync({
      accountId: accountId.value!,
      date: date.value,
      datetime: datetime(),
      amountMinor: amountMinor.value!,
      payee: payee.value.trim(),
      name: kind.value === 'transfer' ? null : name.value.trim() || null,
      categoryId: kind.value === 'transfer' ? null : categoryId.value,
      notes: notes.value.trim() || null,
      tags: tags.value,
      transferAccountId: kind.value === 'transfer' ? transferAccountId.value : null,
    })
    toast.success(`Added ${formatMoney(created.amountMinor)} · ${titleOf(created)}`, {
      action: { label: 'Undo', onClick: () => m.remove.mutate(created.id) },
    })
    if (addAnother) {
      reset(true)
      nextTick(() => (amountInput.value?.$el as HTMLInputElement | undefined)?.focus())
    } else {
      emit('done')
    }
    return true
  } catch (err) {
    toast.error(errorMessage(err))
    return false
  }
}
defineExpose({ save })

async function remove() {
  const tx = editing.value
  if (!tx) return
  try {
    await m.remove.mutateAsync(tx.id)
    toast('Transaction deleted', { action: { label: 'Undo', onClick: () => m.restore.mutate(tx.id) } })
    emit('done')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

const kinds: Array<{ value: Kind; label: string }> = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
]
</script>

<template>
  <form class="flex flex-col gap-4" novalidate @submit.prevent="save()">
    <TransactionLinks v-if="editing" :tx="editing" @unlinked="emit('done')" />
    <!-- Part of a split payment: what it is, and why some of it can't be changed here. -->
    <div v-if="split" class="grid gap-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <p class="font-medium">{{ splitHeading }}</p>
      <p v-if="split.part === 'payment' && split.keptMinor < 0" class="text-amber-700 dark:text-amber-400">{{ SHARES_OVER }}.</p>
      <p class="text-xs text-muted-foreground">
        {{ splitLocked }}
        <template v-if="splitRow">Its name, notes and tags are yours to change, and its category to another one left out of totals.</template>
      </p>
    </div>
    <div v-if="!isTransferEdit" class="grid grid-cols-3 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Type">
      <button
        v-for="k in kinds"
        :key="k.value"
        type="button"
        role="radio"
        :aria-checked="kind === k.value"
        :disabled="(!!editing && k.value === 'transfer') || splitRow"
        :class="
          cn(
            'rounded-md py-1.5 text-sm font-medium transition-colors disabled:opacity-40',
            kind === k.value ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )
        "
        @click="kind = k.value"
      >
        {{ k.label }}
      </button>
    </div>

    <div class="grid gap-1.5">
      <Label for="tx-amount">Amount</Label>
      <div class="relative">
        <span
          class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-lg font-medium"
          :class="kind === 'income' ? 'text-positive' : 'text-muted-foreground'"
          >{{ kind === 'income' ? '+$' : kind === 'expense' ? '−$' : '$' }}</span
        >
        <Input
          id="tx-amount"
          ref="amountInput"
          v-model="amountText"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0.00"
          :readonly="splitRow"
          :class="cn('h-12 pl-9 text-xl font-semibold tabular', splitRow && 'bg-muted/40 text-muted-foreground')"
          :aria-invalid="!!errors.amount"
        />
      </div>
      <p v-if="errors.amount" class="text-xs text-destructive">{{ errors.amount }}</p>
    </div>

    <div class="grid gap-1.5">
      <FieldLabel
        html-for="tx-payee"
        :hint="
          split
            ? (splitLocked ?? undefined)
            : payeeLocked
              ? 'As the bank or file sent it. Matching and learning go by it, so it stays as it is. Rename the payee to show another name on all its transactions.'
              : undefined
        "
        >{{ kind === 'transfer' ? 'Description' : 'Payee' }}</FieldLabel
      >
      <div class="flex items-center gap-2">
        <Input v-if="payeeFixed" id="tx-payee" :model-value="editing!.payee" readonly class="bg-muted/40 text-muted-foreground" />
        <Input
          v-else
          id="tx-payee"
          v-model="payee"
          list="tx-payee-options"
          autocomplete="off"
          :placeholder="kind === 'transfer' ? 'Credit card payment' : 'Where did the money go?'"
          :aria-invalid="!!errors.payee"
        />
        <Button v-if="editing && kind !== 'transfer' && !renaming && !splitRow" type="button" variant="outline" size="sm" class="h-9 shrink-0" @click="startRename">
          Rename
        </Button>
      </div>
      <datalist v-if="!payeeFixed" id="tx-payee-options">
        <option v-for="p in payeeOptions" :key="p" :value="p" />
      </datalist>
      <p v-if="errors.payee" class="text-xs text-destructive">{{ errors.payee }}</p>
      <p v-if="editing && editing.payeeName !== editing.payee && !renaming" class="text-xs text-muted-foreground">
        Called <span class="font-medium text-foreground">{{ editing.payeeName }}</span>
        {{ editing.payeeNameRule !== null ? 'by a custom rule' : 'by AI tidying' }}, on all its transactions.
      </p>
      <!-- Renaming the payee: all its transactions, apart from this one's Save. -->
      <div v-if="renaming" class="grid gap-1.5 rounded-md border bg-muted/30 p-3">
        <FieldLabel
          html-for="tx-payee-rename"
          hint="All its transactions are called this, and new ones too. A name another payee has makes them one payee. Empty: what AI tidying calls it, or as the bank sent it."
        >
          Call this payee
        </FieldLabel>
        <div class="flex items-center gap-2">
          <Input id="tx-payee-rename" ref="renameInput" v-model="renameText" autocomplete="off" @keydown.enter.prevent="saveRename" />
          <Button type="button" size="sm" class="h-9 shrink-0" :disabled="names.rename.isPending.value" @click="saveRename">Save</Button>
          <Button type="button" size="sm" variant="ghost" class="h-9 shrink-0" @click="renaming = false">Cancel</Button>
        </div>
      </div>
    </div>

    <div v-if="kind !== 'transfer'" class="grid gap-1.5">
      <FieldLabel
        html-for="tx-name"
        optional
        :hint="
          nameLocked
            ? 'The name of the purchase it refunds. Renaming that one renames this too.'
            : editing?.recurringItemId
              ? 'What it is. It’s shared with its recurring item: renaming it renames the item and all its payments.'
              : 'What this one is, like “Suitcase”, when the payee doesn’t say. It shows in place of the payee, and search finds it.'
        "
        >Name</FieldLabel
      >
      <Input id="tx-name" v-model="name" autocomplete="off" :disabled="nameLocked" :placeholder="nameLocked ? 'None, like its purchase' : 'e.g. Suitcase'" />
    </div>

    <div v-if="kind !== 'transfer'" class="grid gap-1.5">
      <Label for="tx-category">Category</Label>
      <CategoryPicker
        id="tx-category"
        :model-value="categoryId"
        :suggested-id="isRefund ? null : (suggestion?.categoryId ?? null)"
        :disabled="isRefund"
        :class="suggestionText ? 'border-ai' : ''"
        @update:model-value="pickCategory"
      />
      <p v-if="suggesting" class="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 class="size-3 animate-spin" />Finding a category…
      </p>
      <p v-else-if="suggestionText" class="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        <Sparkles class="size-3 text-ai" />{{ suggestionText }}
        <button type="button" class="ml-1 text-primary underline-offset-4 hover:underline" @click="runSuggestion(true)">Ask again</button>
      </p>
      <!-- A transaction without a suggestion: one on request. -->
      <p v-else-if="editing && canSuggest && !categoryId" class="text-xs">
        <button type="button" class="text-primary underline-offset-4 hover:underline" @click="runSuggestion(true)">Suggest a category</button>
      </p>
      <p v-if="isRefund && editing?.links.length === 1" class="text-xs text-muted-foreground">
        Always the category of what it pays back: it changes when that one’s does.
      </p>
      <p v-else-if="isRefund" class="text-xs text-muted-foreground">It counts in the categories of the bills it pays back.</p>
      <p v-if="editing?.bankCategory" class="text-xs text-muted-foreground">Your bank’s category: {{ editing.bankCategory }}</p>
    </div>

    <div :class="cn('grid gap-3', kind === 'transfer' && !isTransferEdit && 'grid-cols-2')">
      <div class="grid min-w-0 gap-1.5">
        <Label for="tx-account">{{ kind !== 'transfer' ? 'Account' : (editing?.amountMinor ?? 0) > 0 ? 'To' : 'From' }}</Label>
        <AccountSelect id="tx-account" v-model="accountId" :exclude="kind === 'transfer' ? transferAccountId : null" :disabled="!!split" />
        <p v-if="errors.account" class="text-xs text-destructive">{{ errors.account }}</p>
      </div>
      <div v-if="kind === 'transfer' && !isTransferEdit" class="grid min-w-0 gap-1.5">
        <Label for="tx-transfer">To</Label>
        <AccountSelect id="tx-transfer" v-model="transferAccountId" :exclude="accountId" />
        <p v-if="errors.transfer" class="text-xs text-destructive">{{ errors.transfer }}</p>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="grid min-w-0 gap-1.5">
        <Label for="tx-date">Date</Label>
        <Input id="tx-date" v-model="date" type="date" :disabled="!!split" />
      </div>
      <div class="grid min-w-0 gap-1.5">
        <FieldLabel
          html-for="tx-time"
          optional
          hint="When it happened, if you know: a day’s transactions are listed in time order. Without a time, money in counts as first thing that day and money out as last."
          >Time</FieldLabel
        >
        <Input id="tx-time" v-model="time" type="time" :disabled="!!split" />
      </div>
    </div>

    <div class="grid gap-1.5">
      <Label for="tx-tags">Tags</Label>
      <TagInput id="tx-tags" v-model="tags" placeholder="e.g. trip-japan, reimbursable" />
    </div>

    <div v-if="showNotes" class="grid gap-1.5">
      <Label for="tx-notes">Notes</Label>
      <Textarea id="tx-notes" v-model="notes" rows="2" placeholder="Anything to remember" />
    </div>
    <button v-else type="button" class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline" @click="showNotes = true">
      Add a note
    </button>
    <RefundPicker v-if="canBeRefund && kind === 'income'" :tx="editing!" @linked="linkedRefund" />
    <button
      v-if="(canBeRefund && kind === 'income') || (canBePaidBack && kind === 'expense')"
      type="button"
      class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
      @click="paybackOpen = true"
    >
      {{ kind === 'income' ? 'Payback for bills you paid' : 'Paid back by others' }}
    </button>
    <PaybackDialog v-if="editing" v-model:open="paybackOpen" :tx="editing" @linked="linkedRefund" />
    <button
      v-if="editing?.recurringItemId"
      type="button"
      class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
      :disabled="rm.notPayment.isPending.value"
      @click="notPartOfItem"
    >
      Not part of {{ recurringItem ? recurringLabel(recurringItem) : 'its recurring item' }}
    </button>
    <FilterOutOfReport v-if="editing" :transactions="[editing]" />
    <!-- On a shared account: to another ledger that has it, and a card payment between them. -->
    <template v-if="editing">
      <MoveToMenu v-slot="{ busy }" :ids="[editing.id]" :ledgers="moveLedgers" :blocked="moveBlocked" @moved="emit('done')">
        <button type="button" class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline" :disabled="busy">Move to…</button>
      </MoveToMenu>
      <template v-if="canSplit">
        <button type="button" class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline" @click="splitOpen = true">
          {{ split ? 'Change the split…' : 'Split between ledgers…' }}
        </button>
        <SplitPaymentDialog v-model:open="splitOpen" :tx="editing" @saved="(r) => ui.openEdit(r.transaction)" />
      </template>
    </template>
    <!-- The bank's raw data is for checking a sync, on a computer. -->
    <template v-if="isDesktop && editing?.origin === 'sync'">
      <button type="button" class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline" @click="showBankData = true">
        Show raw data
      </button>
      <BankDataDialog v-model:open="showBankData" :tx="editing" />
    </template>

    <p v-if="sharedAccountNote" class="text-xs text-muted-foreground">{{ sharedAccountNote }}</p>
    <div class="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center">
      <Button
        v-if="editing"
        type="button"
        variant="ghost"
        class="text-destructive hover:text-destructive sm:mr-auto"
        :disabled="!!split"
        :title="splitLocked ?? undefined"
        @click="remove"
      >
        <Trash2 />Delete
      </Button>
      <Button v-else type="button" variant="outline" class="sm:mr-auto" :disabled="saving" @click="save(true)">
        Save &amp; add another
      </Button>
      <Button type="submit" :disabled="saving">
        <Loader2 v-if="saving" class="animate-spin" />{{ editing ? 'Save changes' : 'Save transaction' }}
      </Button>
    </div>
  </form>
</template>
