<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import Papa from 'papaparse'
import { toast } from 'vue-sonner'
import { ArrowLeft, CheckCircle2, FileUp, Loader2, Sparkles } from '@lucide/vue'
import {
  accountTypeInfo,
  applyMapping,
  DATE_FORMATS,
  detectDateFormats,
  formatDateShort,
  guessMapping,
  parseDateWith,
  parseMoney,
  type ColumnMapping,
  type DateFormat,
  type ImportPreviewRow,
  type ImportResult,
} from '@chipmunk/shared'
import AccountSelect from '@/components/AccountSelect.vue'
import CategoryPicker from '@/components/CategoryPicker.vue'
import EmptyState from '@/components/EmptyState.vue'
import FieldLabel from '@/components/FieldLabel.vue'
import DesktopOnly from '@/components/DesktopOnly.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import MoneyText from '@/components/MoneyText.vue'
import TagInput from '@/components/TagInput.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAccounts, useAiJobStatus, useImportBatches, useImportMutations, useSettings } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

type Step = 'file' | 'map' | 'review' | 'done'
const NONE = '__none'
const SHOW_ROWS = 300

const route = useRoute()
const accounts = useAccounts()
const settings = useSettings()
const batches = useImportBatches()
const m = useImportMutations()

const step = ref<Step>('file')
const accountId = ref<number | null>(route.query.accountId ? Number(route.query.accountId) : null)
const fileName = ref('')
const rawRows = ref<string[][]>([])
const dragOver = ref(false)
const parseError = ref('')

// Mapping state (column indexes as strings for the Select components)
const hasHeader = ref(true)
const dateCol = ref(NONE)
const payeeCol = ref(NONE)
const amountMode = ref<'single' | 'split'>('single')
const amountCol = ref(NONE)
const debitCol = ref(NONE)
const creditCol = ref(NONE)
const notesCol = ref(NONE)
const categoryCol = ref(NONE)
const dateFormat = ref<DateFormat>('YYYY-MM-DD')
const negate = ref(false)
const tags = ref<string[]>([])

const preview = ref<Array<ImportPreviewRow & { include: boolean; categoryId: number | null; changed: boolean }>>([])
const result = ref<(ImportResult & { batchId: number }) | null>(null)

watch(
  // An account shared with this ledger takes its CSV in its home, so it isn't offered.
  () => accounts.managed.value,
  (list) => {
    if (!accountId.value && list.length) accountId.value = list.find((a) => !accountTypeInfo(a.type).revalued)?.id ?? list[0]!.id
  },
  { immediate: true },
)
const account = computed(() => (accountId.value ? accounts.byId.value.get(accountId.value) : undefined))

const header = computed(() => (hasHeader.value ? rawRows.value[0] ?? [] : null))
const dataRows = computed(() => (hasHeader.value ? rawRows.value.slice(1) : rawRows.value))
const columns = computed(() => {
  const width = Math.max(...rawRows.value.slice(0, 20).map((r) => r.length), 0)
  return [...Array(width).keys()].map((i) => {
    const sample = dataRows.value.find((r) => r[i]?.trim())?.[i] ?? ''
    const name = header.value?.[i]?.trim() || `Column ${i + 1}`
    return { value: String(i), label: sample ? `${name} · ${sample.slice(0, 18)}` : name }
  })
})
const dateFormatsForColumn = computed(() => {
  if (dateCol.value === NONE) return [...DATE_FORMATS]
  const detected = detectDateFormats(dataRows.value.map((r) => r[Number(dateCol.value)] ?? ''))
  return detected.length ? detected : [...DATE_FORMATS]
})

function looksLikeHeader(row: string[]) {
  const anyDate = row.some((c) => DATE_FORMATS.some((f) => parseDateWith(c, f)))
  const anyNumber = row.some((c) => /^-?\$?\(?[\d,]+\.\d{2}\)?$/.test(c.trim()))
  return !anyDate && !anyNumber
}

function loadFile(file: File) {
  parseError.value = ''
  fileName.value = file.name
  Papa.parse<string[]>(file, {
    skipEmptyLines: 'greedy',
    complete: (res) => {
      const rows = (res.data as string[][]).filter((r) => r.some((c) => c?.trim()))
      if (rows.length < 1) {
        parseError.value = "That file doesn't have any rows."
        return
      }
      rawRows.value = rows
      hasHeader.value = looksLikeHeader(rows[0]!)
      applyGuess()
      step.value = 'map'
    },
    error: (err) => (parseError.value = `Couldn't read that file: ${err.message}`),
  })
}

function applyGuess() {
  const saved = account.value?.importMapping
  const width = columns.value.length
  const fits = (i: number | null | undefined) => typeof i === 'number' && i < width
  const g: Partial<ColumnMapping> =
    saved && fits(saved.date) && fits(saved.payee) ? saved : guessMapping(header.value, dataRows.value.slice(0, 50))
  if (saved && g === saved) hasHeader.value = saved.hasHeader
  const s = (i: number | null | undefined) => (typeof i === 'number' ? String(i) : NONE)
  dateCol.value = s(g.date)
  payeeCol.value = s(g.payee)
  amountMode.value = typeof g.amount === 'number' ? 'single' : typeof g.debit === 'number' || typeof g.credit === 'number' ? 'split' : 'single'
  amountCol.value = s(g.amount)
  debitCol.value = s(g.debit)
  creditCol.value = s(g.credit)
  notesCol.value = s(g.notes)
  categoryCol.value = s(g.category)
  // A card's export may list purchases as positive (flip them) or already as negative (another app's,
  // like Lunch Money's): flip when most of its amounts are positive.
  const amounts = typeof g.amount === 'number' ? dataRows.value.slice(0, 200).map((r) => parseMoney(r[g.amount!] ?? '')).filter((v) => v !== null) : []
  const mostlyPositive = amounts.filter((v) => v > 0).length > amounts.length / 2
  negate.value = g.negate ?? (account.value?.type === 'credit' && mostlyPositive)
  dateFormat.value = g.dateFormat ?? dateFormatsForColumn.value[0] ?? 'YYYY-MM-DD'
}
watch(dateCol, () => {
  if (!dateFormatsForColumn.value.includes(dateFormat.value)) dateFormat.value = dateFormatsForColumn.value[0] ?? 'YYYY-MM-DD'
})

const mapping = computed<ColumnMapping | null>(() => {
  if (dateCol.value === NONE || payeeCol.value === NONE) return null
  const n = (v: string) => (v === NONE ? null : Number(v))
  if (amountMode.value === 'single' && amountCol.value === NONE) return null
  if (amountMode.value === 'split' && debitCol.value === NONE && creditCol.value === NONE) return null
  return {
    hasHeader: hasHeader.value,
    date: Number(dateCol.value),
    dateFormat: dateFormat.value,
    payee: Number(payeeCol.value),
    amount: amountMode.value === 'single' ? n(amountCol.value) : null,
    debit: amountMode.value === 'split' ? n(debitCol.value) : null,
    credit: amountMode.value === 'split' ? n(creditCol.value) : null,
    notes: n(notesCol.value),
    category: n(categoryCol.value),
    negate: negate.value,
  }
})

const parsed = computed(() => {
  if (!mapping.value) return null
  const res = applyMapping(dataRows.value, mapping.value, hasHeader.value ? 2 : 1)
  return res
})

/** Already on the account: in this ledger, or in another ledger it's shared with (which isn't named). */
const isDuplicate = (r: { duplicateOf: number | null; duplicateElsewhere: boolean }) => r.duplicateOf !== null || r.duplicateElsewhere

async function toReview() {
  if (!parsed.value?.rows.length || !accountId.value) return
  try {
    const rows = await m.preview.mutateAsync({ accountId: accountId.value, rows: parsed.value.rows })
    preview.value = rows.map((r) => ({ ...r, include: !isDuplicate(r), categoryId: r.suggestion.categoryId, changed: false }))
    step.value = 'review'
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

const included = computed(() => preview.value.filter((r) => r.include))
const duplicates = computed(() => preview.value.filter(isDuplicate).length)
const suggested = computed(() => preview.value.filter((r) => r.include && r.categoryId).length)

async function commit() {
  if (!accountId.value || !included.value.length) return
  try {
    result.value = await m.commit.mutateAsync({
      accountId: accountId.value,
      fileName: fileName.value,
      mapping: mapping.value ?? undefined,
      rows: included.value.map((r) => ({
        line: r.line,
        date: r.date,
        payee: r.payee,
        amountMinor: r.amountMinor,
        notes: r.notes,
        category: r.category ?? null,
        // Only send categories the user picked; the server applies its own suggestions (and learns
        // from confirmed ones) otherwise.
        categoryId: r.changed ? r.categoryId : null,
        tags: tags.value,
      })),
    })
    step.value = 'done'
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

const aiEnabled = computed(() => !!settings.data.value?.ai.enabled)
const aiJob = useAiJobStatus(() => step.value === 'done' && aiEnabled.value)

function reset() {
  step.value = 'file'
  rawRows.value = []
  preview.value = []
  result.value = null
  fileName.value = ''
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) loadFile(f)
}
function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) loadFile(f)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <PageHeader title="Import CSV" :subtitle="fileName || 'Bring in transactions from your bank'" :back="{ name: 'ledger-settings', query: { tab: 'data' } }" />

  <main class="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
    <DesktopOnly what="Import CSV files">
    <!-- Step indicator -->
    <ol class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      <li
        v-for="(s, i) in [
          { k: 'file', l: 'Choose file' },
          { k: 'map', l: 'Match columns' },
          { k: 'review', l: 'Review' },
          { k: 'done', l: 'Done' },
        ]"
        :key="s.k"
        :class="cn('flex items-center gap-2', step === s.k ? 'font-medium' : 'text-muted-foreground')"
      >
        <span :class="cn('grid size-5 place-items-center rounded-full text-[11px]', step === s.k ? 'bg-primary text-primary-foreground' : 'bg-muted')">{{ i + 1 }}</span>
        {{ s.l }}
      </li>
    </ol>

    <!-- 1. File -->
    <Card v-if="step === 'file'" class="gap-4">
      <CardHeader>
        <CardTitle>Choose the account and file</CardTitle>
        <CardDescription>Download a CSV of transactions from your bank's website, then drop it here. Nothing leaves your server.</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4">
        <div class="grid max-w-sm gap-1.5">
          <Label for="imp-account">Import into</Label>
          <AccountSelect id="imp-account" v-model="accountId" managed />
          <p v-if="!accounts.managed.value.length" class="text-sm text-muted-foreground">
            <RouterLink :to="{ name: 'accounts', query: { new: '1' } }" class="underline">Add an account</RouterLink> first.
          </p>
        </div>
        <label
          :class="
            cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors',
              dragOver ? 'border-primary bg-muted' : 'hover:bg-muted/50',
              !accountId && 'pointer-events-none opacity-50',
            )
          "
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <FileUp class="size-8 text-muted-foreground" />
          <span class="font-medium">Drop a CSV file here, or click to choose one</span>
          <span class="text-sm text-muted-foreground">Works with exports from TD, RBC, CIBC, Scotiabank, BMO, Tangerine, Amex and most others</span>
          <input type="file" accept=".csv,text/csv" class="sr-only" :disabled="!accountId" @change="onPick" />
        </label>
        <p v-if="parseError" class="text-sm text-destructive">{{ parseError }}</p>
      </CardContent>
    </Card>

    <!-- 2. Mapping -->
    <template v-if="step === 'map'">
      <Card class="gap-4">
        <CardHeader>
          <CardTitle>Match the columns</CardTitle>
          <CardDescription>
            {{ dataRows.length }} row{{ dataRows.length === 1 ? '' : 's' }} found.
            <template v-if="account?.importMapping">Using the settings from your last {{ account.name }} import.</template>
            <template v-else>We guessed the columns; check them against the preview below.</template>
          </CardDescription>
        </CardHeader>
        <CardContent class="grid gap-5">
          <div class="flex items-center gap-2">
            <Switch id="imp-header" v-model="hasHeader" />
            <Label for="imp-header">The first row is a header</Label>
          </div>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div class="grid min-w-0 gap-1.5">
              <Label for="imp-date">Date</Label>
              <Select v-model="dateCol">
                <SelectTrigger id="imp-date" class="w-full min-w-0 overflow-hidden"><SelectValue placeholder="Pick a column" /></SelectTrigger>
                <SelectContent><SelectItem v-for="c in columns" :key="c.value" :value="c.value">{{ c.label }}</SelectItem></SelectContent>
              </Select>
            </div>
            <div class="grid min-w-0 gap-1.5">
              <Label for="imp-fmt">Date format</Label>
              <Select v-model="dateFormat">
                <SelectTrigger id="imp-fmt" class="w-full min-w-0 overflow-hidden"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem v-for="f in dateFormatsForColumn" :key="f" :value="f">{{ f }}</SelectItem></SelectContent>
              </Select>
            </div>
            <div class="grid min-w-0 gap-1.5">
              <Label for="imp-payee">Description / payee</Label>
              <Select v-model="payeeCol">
                <SelectTrigger id="imp-payee" class="w-full min-w-0 overflow-hidden"><SelectValue placeholder="Pick a column" /></SelectTrigger>
                <SelectContent><SelectItem v-for="c in columns" :key="c.value" :value="c.value">{{ c.label }}</SelectItem></SelectContent>
              </Select>
            </div>
            <div class="grid min-w-0 gap-1.5">
              <Label for="imp-notes">Notes (optional)</Label>
              <Select v-model="notesCol">
                <SelectTrigger id="imp-notes" class="w-full min-w-0 overflow-hidden"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NONE">None</SelectItem>
                  <SelectItem v-for="c in columns" :key="c.value" :value="c.value">{{ c.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid min-w-0 gap-1.5">
              <FieldLabel
                html-for="imp-category"
                optional
                hint="The category your bank or another app gave each one, like Lunch Money’s. AI goes by it when it picks one of your categories (as with your bank’s through Plaid), and when it agrees, its pick is set without review."
                >Category</FieldLabel
              >
              <Select v-model="categoryCol">
                <SelectTrigger id="imp-category" class="w-full min-w-0 overflow-hidden"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NONE">None</SelectItem>
                  <SelectItem v-for="c in columns" :key="c.value" :value="c.value">{{ c.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="grid gap-3">
            <div class="flex flex-wrap gap-2 text-sm" role="radiogroup" aria-label="Amount columns">
              <button
                v-for="o in [{ v: 'single', l: 'One amount column' }, { v: 'split', l: 'Separate withdrawal / deposit columns' }] as const"
                :key="o.v"
                type="button"
                role="radio"
                :aria-checked="amountMode === o.v"
                :class="cn('rounded-md border px-3 py-1.5', amountMode === o.v ? 'border-primary bg-muted font-medium' : 'text-muted-foreground')"
                @click="amountMode = o.v"
              >
                {{ o.l }}
              </button>
            </div>
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div v-if="amountMode === 'single'" class="grid min-w-0 gap-1.5">
                <Label for="imp-amount">Amount</Label>
                <Select v-model="amountCol">
                  <SelectTrigger id="imp-amount" class="w-full min-w-0 overflow-hidden"><SelectValue placeholder="Pick a column" /></SelectTrigger>
                  <SelectContent><SelectItem v-for="c in columns" :key="c.value" :value="c.value">{{ c.label }}</SelectItem></SelectContent>
                </Select>
              </div>
              <template v-else>
                <div class="grid min-w-0 gap-1.5">
                  <Label for="imp-debit">Money out (withdrawals)</Label>
                  <Select v-model="debitCol">
                    <SelectTrigger id="imp-debit" class="w-full min-w-0 overflow-hidden"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="NONE">None</SelectItem>
                      <SelectItem v-for="c in columns" :key="c.value" :value="c.value">{{ c.label }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid min-w-0 gap-1.5">
                  <Label for="imp-credit">Money in (deposits)</Label>
                  <Select v-model="creditCol">
                    <SelectTrigger id="imp-credit" class="w-full min-w-0 overflow-hidden"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="NONE">None</SelectItem>
                      <SelectItem v-for="c in columns" :key="c.value" :value="c.value">{{ c.label }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </template>
            </div>
            <div class="flex items-start gap-2">
              <Switch id="imp-negate" v-model="negate" class="mt-0.5" />
              <div>
                <Label for="imp-negate">Flip the sign of amounts</Label>
                <p class="text-xs text-muted-foreground">Turn on when purchases appear as positive numbers (common for credit card exports).</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card class="gap-0 overflow-hidden py-0">
        <CardHeader class="px-4 py-3 md:px-6">
          <CardTitle class="text-sm">Preview</CardTitle>
          <CardDescription v-if="parsed">
            {{ parsed.rows.length }} row{{ parsed.rows.length === 1 ? '' : 's' }} read
            <span v-if="parsed.errors.length" class="text-destructive">· {{ parsed.errors.length }} couldn't be read</span>
          </CardDescription>
        </CardHeader>
        <div class="max-h-96 overflow-auto border-t">
          <Table v-if="parsed?.rows.length">
            <TableHeader>
              <TableRow><TableHead class="pl-4 md:pl-6">Date</TableHead><TableHead>Payee</TableHead><TableHead class="pr-4 text-right md:pr-6">Amount</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="r in parsed.rows.slice(0, 12)" :key="r.line">
                <TableCell class="pl-4 text-muted-foreground tabular md:pl-6">{{ formatDateShort(r.date, 2000) }}</TableCell>
                <TableCell class="max-w-0 truncate">{{ r.payee }}</TableCell>
                <TableCell class="pr-4 text-right md:pr-6"><MoneyText :amount="r.amountMinor" /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p v-else class="p-4 text-sm text-muted-foreground md:px-6">Pick the date, payee and amount columns to see a preview.</p>
          <ul v-if="parsed?.errors.length" class="border-t px-4 py-2 text-xs text-destructive md:px-6">
            <li v-for="e in parsed.errors.slice(0, 5)" :key="e.line">Line {{ e.line }}: {{ e.message }}</li>
            <li v-if="parsed.errors.length > 5">…and {{ parsed.errors.length - 5 }} more</li>
          </ul>
        </div>
      </Card>

      <div class="flex justify-between gap-2">
        <Button variant="ghost" @click="reset"><ArrowLeft />Choose another file</Button>
        <Button :disabled="!parsed?.rows.length || m.preview.isPending.value" @click="toReview">
          <Loader2 v-if="m.preview.isPending.value" class="animate-spin" />Check {{ parsed?.rows.length ?? 0 }} row{{ parsed?.rows.length === 1 ? '' : 's' }}
        </Button>
      </div>
    </template>

    <!-- 3. Review -->
    <template v-if="step === 'review'">
      <Card class="gap-3">
        <CardHeader>
          <CardTitle>Review before importing into {{ account?.name }}</CardTitle>
          <CardDescription>
            {{ included.length }} to import · {{ duplicates }} already in this account (unchecked) · {{ suggested }} with a category from your history.
            <template v-if="aiEnabled"> The rest will be categorized by AI after the import.</template>
          </CardDescription>
        </CardHeader>
        <CardContent class="grid max-w-md gap-1.5">
          <Label for="imp-tags">Tag every imported transaction (optional)</Label>
          <TagInput id="imp-tags" v-model="tags" placeholder="e.g. td-import" />
        </CardContent>
      </Card>

      <Card class="gap-0 overflow-hidden py-0">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="w-10 pl-4">
                  <Checkbox
                    :model-value="included.length === preview.length"
                    aria-label="Include all"
                    @update:model-value="(v) => preview.forEach((r) => (r.include = !!v))"
                  />
                </TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Payee</TableHead>
                <TableHead>Category</TableHead>
                <TableHead class="pr-4 text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="r in preview.slice(0, SHOW_ROWS)" :key="r.line" :class="!r.include && 'opacity-50'">
                <TableCell class="pl-4"><Checkbox v-model="r.include" :aria-label="`Include ${r.payee}`" /></TableCell>
                <TableCell class="whitespace-nowrap text-muted-foreground tabular">{{ formatDateShort(r.date, 2000) }}</TableCell>
                <TableCell class="max-w-64 truncate">
                  {{ r.payee }}
                  <span v-if="r.duplicateOf !== null" class="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Already imported</span>
                  <span v-else-if="r.duplicateElsewhere" class="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Already in another ledger</span>
                </TableCell>
                <TableCell>
                  <CategoryPicker
                    variant="badge"
                    :model-value="r.categoryId"
                    :needs-review="!r.changed && !!r.categoryId"
                    @update:model-value="(id) => ((r.categoryId = id), (r.changed = true))"
                  />
                </TableCell>
                <TableCell class="pr-4 text-right"><MoneyText :amount="r.amountMinor" /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p v-if="preview.length > SHOW_ROWS" class="border-t px-4 py-2 text-xs text-muted-foreground">
          Showing the first {{ SHOW_ROWS }} of {{ preview.length }} rows. All checked rows will be imported.
        </p>
      </Card>

      <div class="flex justify-between gap-2">
        <Button variant="ghost" @click="step = 'map'"><ArrowLeft />Back to columns</Button>
        <Button :disabled="!included.length || m.commit.isPending.value" @click="commit">
          <Loader2 v-if="m.commit.isPending.value" class="animate-spin" />Import {{ included.length }} transaction{{ included.length === 1 ? '' : 's' }}
        </Button>
      </div>
    </template>

    <!-- 4. Done -->
    <Card v-if="step === 'done' && result">
      <EmptyState
        :icon="CheckCircle2"
        :title="`Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'}`"
        :description="`${result.categorized} categorized from your history${result.needsReview ? `, ${result.needsReview} to review` : ''}${result.skippedDuplicates ? ` · ${result.skippedDuplicates} duplicates skipped` : ''}.`"
      >
        <div v-if="aiJob.data.value?.running" class="flex w-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Sparkles class="size-4 text-ai" />Categorizing new payees with AI… {{ aiJob.data.value.done }}/{{ aiJob.data.value.total }}
        </div>
        <div v-else-if="aiJob.data.value?.total" class="flex w-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Sparkles class="size-4 text-ai" />AI suggested categories for {{ aiJob.data.value.categorized }} more transactions to review.
        </div>
        <Button as-child><RouterLink :to="{ name: 'transactions', query: { accountId: accountId ?? undefined, period: 'all' } }">View transactions</RouterLink></Button>
        <Button variant="outline" @click="reset">Import another file</Button>
        <p class="w-full text-center text-xs text-muted-foreground">Imported the wrong file? Select its transactions in View transactions and delete them.</p>
      </EmptyState>
    </Card>

    <Card v-if="step === 'file' && batches.data.value?.length" class="gap-0 py-0">
      <CardHeader class="px-4 py-3 md:px-6"><CardTitle class="text-sm">Recent imports</CardTitle></CardHeader>
      <ul class="divide-y border-t text-sm">
        <li v-for="b in batches.data.value" :key="b.id" class="min-w-0 px-4 py-2.5 md:px-6">
          <div class="truncate font-medium">{{ b.fileName ?? 'Import' }}</div>
          <div class="text-xs text-muted-foreground">
            {{ b.accountName }} · {{ b.rowCount }} transaction{{ b.rowCount === 1 ? '' : 's' }} · {{ formatDateShort(b.createdAt.slice(0, 10)) }}
          </div>
        </li>
      </ul>
    </Card>
    </DesktopOnly>
  </main>
</template>
