<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { X } from '@lucide/vue'
import { CADENCES, formatMoney, parseMoney, recurringLabel, semiMonthlyPartner, type Cadence, type RecurringItem } from '@st/shared'
import AccountSelect from '@/components/AccountSelect.vue'
import CategoryPicker from '@/components/CategoryPicker.vue'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRecurringMutations } from '@/composables/queries'
import { useReportsUsing } from '@/composables/useReportsUsing'
import { usePayeeOptions } from '@/composables/usePayeeOptions'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

const props = defineProps<{ item?: RecurringItem | null }>()
const open = defineModel<boolean>('open', { default: false })
const today = useToday()
const m = useRecurringMutations()

/** Recurring covers bills and subscriptions, instalment plans (a set number of payments) and income. */
type Kind = 'bill' | 'plan' | 'income'
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'bill', label: 'Bill / subscription' },
  { value: 'plan', label: 'Instalments' },
  { value: 'income', label: 'Income' },
]
const payee = ref('')
/** More payees its payments come from (added when you link one from another payee). */
const otherPayees = ref<string[]>([])
/** What it is, shown in place of the payee; optional. */
const name = ref('')
const kind = ref<Kind>('bill')
const income = computed(() => kind.value === 'income')
const totalPayments = ref('')
const paidPayments = ref('')
/** A plan's full price (optional): its last payment is what's left of it. */
const fullPrice = ref('')
const amount = ref('')
const cadence = ref<Cadence>('monthly')
/** Semi-monthly's other day of the month ("31": the last day); the next due date gives the first. */
const secondDay = ref('')
const DAYS = [...Array.from({ length: 30 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1) })), { value: '31', label: 'Last day of the month' }]
function ordinal(n: number) {
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
  return `${n}${suffix}`
}
// Picking semi-monthly suggests a second day that goes with the next due date.
watch(cadence, (c) => {
  if (c === 'semimonthly' && !secondDay.value && due.value) secondDay.value = String(semiMonthlyPartner(Number(due.value.slice(8, 10))))
})
const due = ref('')
const categoryId = ref<number | null>(null)
const accountId = ref<number | null>(null)
const tolerance = ref('10')
const error = ref('')
const editing = computed(() => !!props.item)
const confirming = computed(() => props.item?.status === 'suggested')
/** An item's payments are matched by its payee, so it stays as it is. A new one's is typed, with suggestions. */
const payeeOptions = usePayeeOptions()

watch(open, (v) => {
  if (!v) return
  const it = props.item
  payee.value = it?.payee ?? ''
  otherPayees.value = [...(it?.otherPayees ?? [])]
  name.value = it?.name ?? ''
  // A plan from a buy-now-pay-later service is an instalment plan even before it has a number of payments.
  kind.value = (it?.expectedAmountMinor ?? -1) > 0 ? 'income' : it?.totalPayments || it?.instalmentService ? 'plan' : 'bill'
  totalPayments.value = it?.totalPayments ? String(it.totalPayments) : it?.instalmentService && it.cadence === 'biweekly' ? '4' : ''
  paidPayments.value = it ? String(it.paidPayments) : '0'
  fullPrice.value = it?.fullPriceMinor ? (Math.abs(it.fullPriceMinor) / 100).toFixed(2) : ''
  amount.value = it ? (Math.abs(it.expectedAmountMinor) / 100).toFixed(2) : ''
  cadence.value = it?.cadence ?? 'monthly'
  due.value = it?.nextDueDate ?? today.value
  secondDay.value = it?.secondDay ? String(it.secondDay) : ''
  categoryId.value = it?.categoryId ?? null
  accountId.value = it?.accountId ?? null
  tolerance.value = String(it?.amountTolerancePct ?? 10)
  error.value = ''
})

async function stop() {
  if (!props.item) return
  try {
    await m.update.mutateAsync({ id: props.item.id, status: 'ended' })
    toast.success(`Stopped tracking ${recurringLabel(props.item)}`)
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}

/**
 * What the full price makes the last payment, as you type (the server works it out for good): what's left
 * after what's paid (its linked payments as they were, while Paid so far is as the app counted it, the
 * others at the usual amount) and the others to come at the usual amount. Null until there's enough to say.
 */
const lastPayment = computed(() => {
  const full = parseMoney(fullPrice.value)
  const usual = parseMoney(amount.value)
  const total = Number(totalPayments.value)
  const paid = Number(paidPayments.value || 0)
  if (!full || !usual || !Number.isInteger(total) || total < 2 || !Number.isInteger(paid) || paid >= total) return null
  const it = props.item
  const counted = it && it.paidPayments === paid && it.totalAmountMinor !== null && it.remainingAmountMinor !== null
  // Its linked payments as they were, and the ones from before your history at the usual amount as you've typed it.
  const before = it ? it.paidPayments - it.occurrences : 0
  const linked = counted ? Math.abs(it.totalAmountMinor! - it.remainingAmountMinor!) - before * Math.abs(it.expectedAmountMinor) : 0
  const paidAmount = counted ? linked + before * Math.abs(usual) : paid * Math.abs(usual)
  return Math.abs(full) - paidAmount - (total - paid - 1) * Math.abs(usual)
})

/** An item you stopped tracking (not a plan that's paid off). */
const stopped = computed(() => props.item?.status === 'ended' && props.item.remainingPayments !== 0)
async function track() {
  if (!props.item) return
  try {
    await m.confirm.mutateAsync(props.item.id)
    toast.success(`Tracking ${recurringLabel(props.item)}`)
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}

// A report filters by it: Delete asks once more.
const reportsUsing = useReportsUsing('recurring', () => props.item?.id)
const askedDelete = ref(false)
watch(() => props.item?.id, () => (askedDelete.value = false))

async function remove() {
  if (!props.item) return
  if (reportsUsing.value && !askedDelete.value) {
    askedDelete.value = true
    return
  }
  try {
    await m.remove.mutateAsync(props.item.id)
    toast.success(`Deleted ${recurringLabel(props.item)}`)
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}

const semi = () => (cadence.value === 'semimonthly' && secondDay.value ? { secondDay: Number(secondDay.value) } : {})

async function submit() {
  const v = parseMoney(amount.value)
  if (!payee.value.trim()) return (error.value = 'Enter the payee, as it appears on payments, like "Netflix"')
  const label = name.value.trim() || payee.value.trim()
  if (v === null || v === 0) return (error.value = 'Enter the usual amount')
  const expectedAmountMinor = income.value ? Math.abs(v) : -Math.abs(v)
  // "1%" is 1.
  const variation = Number(tolerance.value.replace('%', '').trim())
  if (!tolerance.value.trim() || !Number.isFinite(variation) || variation < 0 || variation > 100) return (error.value = 'Price variation is a percentage from 0 to 100, like 5')
  const amountTolerancePct = variation
  const plan = kind.value === 'plan'
  const total = Number(totalPayments.value)
  const paid = Number(paidPayments.value || 0)
  if (plan && (!Number.isInteger(total) || total < 2)) return (error.value = 'Enter how many payments the plan has, like 4 or 12')
  if (plan && (!Number.isInteger(paid) || paid < 0 || paid > total)) return (error.value = `Paid so far is a number from 0 to ${total}`)
  const full = fullPrice.value.trim() ? parseMoney(fullPrice.value) : null
  if (plan && fullPrice.value.trim() && !full) return (error.value = 'The full price is an amount like 399.00, or leave it empty')
  const fullPriceMinor = full ? Math.sign(expectedAmountMinor) * Math.abs(full) : null
  const payments = plan ? { totalPayments: total, paidPayments: paid, fullPriceMinor } : { totalPayments: null }
  try {
    if (props.item) {
      const saved = await m.update.mutateAsync({
        id: props.item.id,
        name: name.value.trim() || null,
        expectedAmountMinor,
        cadence: cadence.value,
        nextDueDate: due.value,
        ...semi(),
        categoryId: categoryId.value,
        accountId: accountId.value,
        amountTolerancePct,
        ...payments,
        ...(otherPayees.value.length !== props.item.otherPayees.length ? { otherPayees: otherPayees.value } : {}),
        ...(confirming.value ? { status: 'active' as const } : {}),
      })
      // A plan that's already paid off goes straight to Ended.
      toast.success(
        confirming.value
          ? saved.status === 'ended'
            ? props.item.stopped && saved.remainingPayments === null
              ? `${label} has stopped, kept in Ended`
              : `${label} is paid off, moved to Ended`
            : `Tracking ${label}`
          : 'Recurring item saved',
      )
    } else {
      await m.create.mutateAsync({
        payee: payee.value.trim(),
        name: name.value.trim() || null,
        expectedAmountMinor,
        cadence: cadence.value,
        anchorDate: due.value,
        ...semi(),
        categoryId: categoryId.value,
        accountId: accountId.value,
        amountTolerancePct,
        ...payments,
      })
      toast.success(`Tracking ${label}`)
    }
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{{ confirming ? 'Confirm recurring item' : editing ? 'Edit recurring item' : 'Add recurring item' }}</DialogTitle>
        <DialogDescription>Payments from this payee are matched to it automatically. An instalment plan ends after its last payment.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid grid-cols-3 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Kind">
          <button
            v-for="opt in KINDS"
            :key="opt.value"
            type="button"
            role="radio"
            :aria-checked="kind === opt.value"
            :class="cn('rounded-md px-1 py-1.5 text-sm font-medium', kind === opt.value ? 'bg-background shadow-sm' : 'text-muted-foreground')"
            @click="kind = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid min-w-0 gap-1.5">
            <FieldLabel
              html-for="rec-payee"
              :hint="
                editing
                  ? 'Its payments are matched by their payee, so it stays as it is. Name it below to show something else.'
                  : 'As it appears on payments. New payments from this payee are matched to the item.'
              "
            >
              Payee
            </FieldLabel>
            <Input v-if="editing" id="rec-payee" :model-value="payee" readonly class="bg-muted/40 text-muted-foreground" />
            <Input
              v-else
              id="rec-payee"
              v-model="payee"
              list="rec-payee-options"
              autocomplete="off"
              :placeholder="kind === 'plan' ? 'Klarna' : kind === 'income' ? 'Acme payroll' : 'Netflix'"
            />
            <datalist v-if="!editing" id="rec-payee-options">
              <option v-for="p in payeeOptions" :key="p" :value="p" />
            </datalist>
          </div>
          <div class="grid min-w-0 gap-1.5">
            <FieldLabel html-for="rec-name" optional hint="What it is, shown in place of the payee, like the store a Klarna plan is for.">Name</FieldLabel>
            <Input id="rec-name" v-model="name" :placeholder="kind === 'plan' ? 'Dyson vacuum' : kind === 'income' ? 'Salary' : 'Family plan'" />
          </div>
          <div v-if="otherPayees.length" class="col-span-2 -mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Also paid as
            <span v-for="p in otherPayees" :key="p" class="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 font-medium text-foreground">
              {{ p }}
              <button type="button" class="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="`Remove ${p}`" @click="otherPayees = otherPayees.filter((o) => o !== p)">
                <X class="size-3" />
              </button>
            </span>
          </div>
        </div>
        <div v-if="kind === 'plan'" class="grid grid-cols-2 gap-3">
          <div class="grid min-w-0 gap-1.5">
            <FieldLabel html-for="rec-total" hint="How many payments the plan has in all, like 4 for Pay in 4 or 60 for a 5-year loan. It ends after the last one.">
              Payments
            </FieldLabel>
            <Input id="rec-total" v-model="totalPayments" inputmode="numeric" placeholder="4" class="tabular" />
          </div>
          <div class="grid min-w-0 gap-1.5">
            <FieldLabel
              html-for="rec-paid"
              hint="How many you’ve paid, including ones from before your history here. Payments the app finds are counted for you."
            >
              Paid so far
            </FieldLabel>
            <Input id="rec-paid" v-model="paidPayments" inputmode="numeric" placeholder="0" class="tabular" />
          </div>
          <div class="col-span-2 grid min-w-0 gap-1.5">
            <FieldLabel
              html-for="rec-full"
              hint="The total of all its payments, as Klarna or Affirm shows it, interest included. Its last payment is what’s left of it, so a last payment of another amount is expected. Leave it empty when every payment is the same."
            >
              Full price <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="rec-full" v-model="fullPrice" inputmode="decimal" placeholder="399.00" class="tabular" />
            <p v-if="lastPayment !== null && lastPayment > 0" class="text-xs text-muted-foreground">
              Its last payment: <span class="tabular">{{ formatMoney(lastPayment) }}</span>
            </p>
            <p v-else-if="lastPayment !== null" class="text-xs text-warning">That’s less than its payments add up to.</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid min-w-0 gap-1.5">
            <Label for="rec-amount">Usual amount</Label>
            <Input id="rec-amount" v-model="amount" inputmode="decimal" placeholder="20.99" class="tabular" />
          </div>
          <div class="grid min-w-0 gap-1.5">
            <Label for="rec-cadence">Repeats</Label>
            <Select v-model="cadence">
              <SelectTrigger id="rec-cadence" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in CADENCES" :key="c.value" :value="c.value">{{ c.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid min-w-0 gap-1.5">
            <Label for="rec-due">Next due</Label>
            <Input id="rec-due" v-model="due" type="date" />
          </div>
          <div v-if="cadence === 'semimonthly'" class="grid min-w-0 gap-1.5">
            <FieldLabel html-for="rec-second" hint="Semi-monthly payments fall on two days of each month: the next due date’s day and this one.">Also on</FieldLabel>
            <Select v-model="secondDay">
              <SelectTrigger id="rec-second" class="w-full"><SelectValue placeholder="Choose a day" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="d in DAYS" :key="d.value" :value="d.value">{{ d.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid min-w-0 gap-1.5">
            <FieldLabel
              html-for="rec-tol"
              hint="Payments within this percentage of the usual amount are its (one per due date). A bigger change is asked about, as a new price."
              >Price variation (%)</FieldLabel
            >
            <Input id="rec-tol" v-model="tolerance" inputmode="numeric" class="tabular" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid min-w-0 gap-1.5">
            <Label for="rec-cat">Category</Label>
            <CategoryPicker id="rec-cat" v-model="categoryId" />
          </div>
          <div class="grid min-w-0 gap-1.5">
            <Label for="rec-acc">Paid from</Label>
            <AccountSelect id="rec-acc" v-model="accountId" allow-all all-label="Any account" />
          </div>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <p v-if="askedDelete && reportsUsing" class="text-sm text-muted-foreground">{{ reportsUsing }}</p>
        <DialogFooter>
          <div v-if="editing && item && !confirming" class="flex gap-1 sm:mr-auto">
            <Button v-if="item.status === 'active'" type="button" variant="ghost" @click="stop">Stop tracking</Button>
            <Button v-else-if="stopped" type="button" variant="ghost" @click="track">Track again</Button>
            <Button type="button" variant="ghost" class="text-destructive hover:text-destructive" @click="remove">{{ askedDelete && reportsUsing ? 'Delete anyway' : 'Delete' }}</Button>
          </div>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="m.create.isPending.value || m.update.isPending.value">
            {{ confirming ? (item?.stopped ? 'Keep in Ended' : 'Confirm') : editing ? 'Save' : 'Add' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
