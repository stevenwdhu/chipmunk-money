<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { ChevronRight, Loader2, RefreshCw } from '@lucide/vue'
import {
  BANK_PROVIDER_LABELS,
  formatMoney,
  type Account,
  type BankAccount,
  type LinkPreview,
  type SwitchResult,
} from '@st/shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAccountBankMutations, useBankMutations, useSettings } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { ApiError, errorMessage } from '@/lib/api'
import { shortDate, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Before an account switches to sync from another bank account: its transactions on the left, the
 * bank's on the right, like a diff. Sure pairs are hidden (you can show them), possible ones (the
 * payee couldn't tell them from another with the same amount and day) are shown in amber. Any pair
 * can be marked not the same, which leaves it side by side (≠) to pair again, like a near one (the
 * same day and payee, another amount). Any two pair by clicking one on each side. What only one side
 * has is kept or added unless you uncheck it, and the bank's from before the account's first
 * transaction (its older history) are folded into one line you can open.
 *
 * It compares what the bank account's syncs kept, without fetching, and its connections don't sync on
 * their own while it's open, so what you review is what switches. Desktop only: it's reached from
 * Link and from Edit account → Updates, neither of which a phone shows.
 */
const props = defineProps<{
  account: Account | null
  bankAccount: BankAccount | null
  connectionId: string | null
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ switched: [SwitchResult] }>()

type Row = LinkPreview['rows'][number]
type Local = NonNullable<Row['local']>
type Remote = NonNullable<Row['remote']>
interface Pair {
  local: Local
  remote: Remote
  /** `user`: paired by you. */
  kind: 'matched' | 'guessed' | 'user'
}

const m = useAccountBankMutations()
const bankM = useBankMutations()
const settings = useSettings()
const tz = computed(() => settings.data.value?.effectiveTimezone)
const today = useToday()
const preview = ref<LinkPreview | null>(null)
const from = ref('')
const error = ref('')
const showMatched = ref(false)
const showOlder = ref(false)
/** Switched: the server ended the review itself. */
let done = false

const pairs = ref<Pair[]>([])
/** Side by side but not paired: `near` (another amount) or `split` (by you). */
interface Apart {
  local: Local
  remote: Remote
  why: 'near' | 'split'
}
const apart = ref<Apart[]>([])
const loneLocal = ref<Local[]>([])
const loneRemote = ref<Remote[]>([])
/** Yours to keep, and the bank's to add (the rest are left out). */
const keep = ref(new Set<number>())
const add = ref(new Set<string>())
/** The one you clicked first, to pair with one on the other side. */
const picked = ref<{ side: 'local'; item: Local } | { side: 'remote'; item: Remote } | null>(null)

const oldSource = computed(() =>
  props.account?.bank ? BANK_PROVIDER_LABELS[props.account.bank.provider] : 'This account',
)
const newSource = computed(() => (preview.value ? BANK_PROVIDER_LABELS[preview.value.provider] : 'The bank'))
const money = (n: number) => formatMoney(n, props.account?.currency ?? 'CAD')

function load(p: LinkPreview) {
  preview.value = p
  from.value = p.from
  pairs.value = p.rows
    .filter((r) => r.kind === 'matched' || r.kind === 'guessed')
    .map((r) => ({ local: r.local!, remote: r.remote!, kind: r.kind as Pair['kind'] }))
  apart.value = p.rows
    .filter((r) => r.kind === 'near')
    .map((r) => ({ local: r.local!, remote: r.remote!, why: 'near' as const }))
  loneLocal.value = p.rows.filter((r) => r.kind === 'local').map((r) => r.local!)
  loneRemote.value = p.rows.filter((r) => r.kind === 'remote').map((r) => r.remote!)
  keep.value = new Set([...loneLocal.value, ...apart.value.map((a) => a.local)].map((l) => l.id))
  add.value = new Set([...loneRemote.value, ...apart.value.map((a) => a.remote)].map((r) => r.remoteId))
  picked.value = null
}

async function fetchPreview(start?: string) {
  if (!props.account || !props.bankAccount) return
  error.value = ''
  try {
    load(
      await m.preview.mutateAsync({
        id: props.account.id,
        bankAccountId: props.bankAccount.id,
        from: start || null,
      }),
    )
  } catch (err) {
    error.value = errorMessage(err)
  }
}
watch(open, (v) => {
  // Closed without switching: its connections sync on their own again.
  if (!v) return void (!done && props.account && m.endReview.mutate(props.account.id))
  done = false
  preview.value = null
  showMatched.value = false
  showOlder.value = false
  void fetchPreview()
})

/** Nothing was fetched for the bank account yet: its first sync, then the comparison. */
async function syncFirst() {
  if (!props.connectionId) return
  error.value = ''
  try {
    const r = await bankM.sync.mutateAsync(props.connectionId)
    if (!r.ok) return void (error.value = r.error ?? 'The sync failed.')
    await fetchPreview()
  } catch (err) {
    error.value = errorMessage(err)
  }
}

// Changing your mind -----------------------------------------------------------------------
/** Not the same: both stay, side by side, so you can pair them again. */
function split(p: Pair) {
  pairs.value = pairs.value.filter((x) => x !== p)
  apart.value = [...apart.value, { local: p.local, remote: p.remote, why: 'split' }]
  if (!p.local.deleted) keep.value = new Set([...keep.value, p.local.id])
  add.value = new Set([...add.value, p.remote.remoteId])
}
/** Two from different lines: what was beside each is left on its own. */
function pairUp(local: Local, remote: Remote) {
  const leftLocal = apart.value
    .filter((a) => a.remote.remoteId === remote.remoteId && a.local.id !== local.id)
    .map((a) => a.local)
  const leftRemote = apart.value
    .filter((a) => a.local.id === local.id && a.remote.remoteId !== remote.remoteId)
    .map((a) => a.remote)
  apart.value = apart.value.filter((a) => a.local.id !== local.id && a.remote.remoteId !== remote.remoteId)
  loneLocal.value = [...loneLocal.value.filter((l) => l.id !== local.id), ...leftLocal]
  loneRemote.value = [...loneRemote.value.filter((r) => r.remoteId !== remote.remoteId), ...leftRemote]
  pairs.value = [...pairs.value, { local, remote, kind: 'user' }]
  picked.value = null
}
function pick(side: 'local', item: Local): void
function pick(side: 'remote', item: Remote): void
function pick(side: 'local' | 'remote', item: Local | Remote) {
  const first = picked.value
  if (first && first.side !== side) {
    if (side === 'local') pairUp(item as Local, first.item as Remote)
    else pairUp(first.item as Local, item as Remote)
    return
  }
  const same =
    first &&
    (first.side === 'local'
      ? first.item.id === (item as Local).id
      : first.item.remoteId === (item as Remote).remoteId)
  picked.value = same
    ? null
    : side === 'local'
      ? { side, item: item as Local }
      : { side, item: item as Remote }
}
const isPicked = (side: 'local' | 'remote', id: number | string) =>
  !!picked.value &&
  picked.value.side === side &&
  (side === 'local' ? (picked.value.item as Local).id === id : (picked.value.item as Remote).remoteId === id)
function toggle<T>(set: Set<T>, id: T, on: boolean) {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

// What it shows, newest first ----------------------------------------------------------------
type Line =
  | { type: 'pair'; key: string; date: string; pair: Pair }
  | { type: 'apart'; key: string; date: string; local: Local; remote: Remote; why: Apart['why'] }
  | { type: 'local'; key: string; date: string; local: Local }
  | { type: 'remote'; key: string; date: string; remote: Remote }
  | { type: 'older'; key: string; date: string }
const later = (a: string, b: string) => (a > b ? a : b)
const remoteLine = (r: Remote): Line => ({ type: 'remote', key: `r${r.remoteId}`, date: r.date, remote: r })
/** The bank's from before the account's first transaction: its older history, with nothing to pair. */
const isOlder = (r: Remote) => !!preview.value?.first && r.date < preview.value.first
const older = computed(() => loneRemote.value.filter(isOlder).sort((a, b) => b.date.localeCompare(a.date)))
const lines = computed<Line[]>(() => [
  ...[
    ...pairs.value
      .filter((p) => p.kind !== 'matched' || showMatched.value)
      .map((p) => ({
        type: 'pair' as const,
        key: `p${p.local.id}`,
        date: later(p.local.date, p.remote.date),
        pair: p,
      })),
    ...apart.value.map((a) => ({
      type: 'apart' as const,
      key: `a${a.local.id}`,
      date: later(a.local.date, a.remote.date),
      ...a,
    })),
    ...loneLocal.value.map((l) => ({ type: 'local' as const, key: `l${l.id}`, date: l.date, local: l })),
    ...loneRemote.value.filter((r) => !isOlder(r)).map(remoteLine),
  ].sort((a, b) => b.date.localeCompare(a.date)),
  ...(older.value.length ? [{ type: 'older' as const, key: 'older', date: '' }] : []),
  ...(showOlder.value ? older.value.map(remoteLine) : []),
])
const olderAdded = computed(() => older.value.filter((r) => add.value.has(r.remoteId)).length)
function addOlder(on: boolean) {
  const next = new Set(add.value)
  for (const r of older.value) {
    if (on) next.add(r.remoteId)
    else next.delete(r.remoteId)
  }
  add.value = next
}
const matchedCount = computed(() => pairs.value.filter((p) => p.kind === 'matched').length)
const possibleCount = computed(() => pairs.value.filter((p) => p.kind === 'guessed').length)
/** A deleted one stays deleted either way, so it's neither kept nor deleted. */
const unpairedLocal = computed(() =>
  [...loneLocal.value, ...apart.value.map((a) => a.local)].filter((l) => !l.deleted),
)
const unpairedRemote = computed(() => [...loneRemote.value, ...apart.value.map((a) => a.remote)])
const summary = computed(() => {
  const added = unpairedRemote.value.filter((r) => add.value.has(r.remoteId)).length
  const removed = unpairedLocal.value.filter((l) => !keep.value.has(l.id)).length
  return [
    `${pairs.value.length} paired`,
    added && `${added} added`,
    unpairedRemote.value.length - added && `${unpairedRemote.value.length - added} left out`,
    unpairedLocal.value.length - removed && `${unpairedLocal.value.length - removed} kept`,
    removed && `${removed} deleted`,
  ]
    .filter(Boolean)
    .join(' · ')
})

async function submit() {
  if (!props.account || !props.bankAccount || !preview.value) return
  error.value = ''
  try {
    const { result } = await m.switchTo.mutateAsync({
      id: props.account.id,
      bankAccountId: props.bankAccount.id,
      from: preview.value.from,
      version: preview.value.version,
      pairs: pairs.value.map((p) => ({
        transactionId: p.local.id,
        remoteId: p.remote.remoteId,
        keepAmount: p.local.amountMinor !== p.remote.amountMinor,
      })),
      skip: unpairedRemote.value.filter((r) => !add.value.has(r.remoteId)).map((r) => r.remoteId),
      remove: unpairedLocal.value.filter((l) => !keep.value.has(l.id)).map((l) => l.id),
    })
    done = true
    open.value = false
    emit('switched', result)
  } catch (err) {
    const message = errorMessage(err)
    toast.error(message)
    // Made from transactions that changed since: it's made again, to check before switching.
    if (err instanceof ApiError && err.status === 409) await fetchPreview(preview.value.from)
    error.value = message
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle>Review before switching</DialogTitle>
        <DialogDescription>
          {{ account?.name }} is about to sync from {{ newSource }}’s {{ bankAccount?.name }}. Here’s how its
          transactions pair with {{ newSource }}’s<template v-if="preview?.fetchedAt"
            >, as of its last sync {{ timeAgo(preview.fetchedAt, tz) }}</template
          >. Nothing changes until you switch.
        </DialogDescription>
      </DialogHeader>

      <div v-if="!preview" class="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <template v-if="error">{{ error }}</template>
        <template v-else><Loader2 class="size-4 animate-spin" />Comparing transactions…</template>
      </div>

      <!-- Nothing fetched for the bank account yet. -->
      <div
        v-else-if="!preview.fetchedAt"
        class="grid justify-items-start gap-3 rounded-lg border px-4 py-6 text-sm"
      >
        <p>
          {{ newSource }} hasn’t sent {{ bankAccount?.name }}’s transactions yet. They come with its first
          sync.
        </p>
        <Button
          type="button"
          size="sm"
          :disabled="!connectionId || bankM.sync.isPending.value"
          @click="syncFirst"
        >
          <Loader2 v-if="bankM.sync.isPending.value" class="animate-spin" /><RefreshCw v-else />Sync now
        </Button>
      </div>

      <template v-else>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label class="flex items-center gap-2">
            <span class="text-muted-foreground">From</span>
            <Input
              v-model="from"
              type="date"
              class="h-8 w-40"
              :min="preview.earliest"
              :max="preview.to"
              :disabled="m.preview.isPending.value"
              @change="fetchPreview(from)"
            />
          </label>
          <Loader2 v-if="m.preview.isPending.value" class="size-4 animate-spin text-muted-foreground" />
          <span v-if="possibleCount" class="text-amber-700 dark:text-amber-400">
            {{ possibleCount }} possible {{ possibleCount === 1 ? 'match' : 'matches' }} to check
          </span>
          <label class="ml-auto flex items-center gap-2 text-muted-foreground">
            <Checkbox :model-value="showMatched" @update:model-value="(v) => (showMatched = !!v)" />Show
            {{ matchedCount }} matched
          </label>
        </div>

        <div class="overflow-hidden rounded-lg border text-sm">
          <div
            class="grid grid-cols-[1fr_2.25rem_1fr_14rem] border-b bg-muted/50 text-xs font-medium text-muted-foreground"
          >
            <div class="px-3 py-2">{{ oldSource }} (now)</div>
            <div class="border-x" />
            <div class="px-3 py-2">{{ newSource }} (new)</div>
            <div class="border-l" />
          </div>
          <div class="max-h-[55vh] overflow-y-auto">
            <p v-if="!lines.length" class="px-3 py-8 text-center text-muted-foreground">
              All {{ matchedCount }} are the same on both sides.
            </p>
            <div
              v-for="line in lines"
              :key="line.key"
              :class="
                cn(
                  'grid grid-cols-[1fr_2.25rem_1fr_14rem] border-b last:border-b-0',
                  line.type === 'pair' && line.pair.kind === 'guessed' && 'bg-amber-500/10',
                )
              "
            >
              <!-- The bank's older history, folded into one line -->
              <div
                v-if="line.type === 'older'"
                class="col-span-4 flex min-w-0 items-center gap-2 bg-muted/40 px-3 py-1.5"
              >
                <Checkbox
                  :model-value="olderAdded === older.length ? true : olderAdded ? 'indeterminate' : false"
                  aria-label="Add the older ones"
                  @update:model-value="(v) => addOlder(v === true)"
                />
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  :aria-expanded="showOlder"
                  @click="showOlder = !showOlder"
                >
                  <span class="truncate">
                    {{ older.length }} older from {{ newSource }}, before {{ account?.name }}’s first
                    transaction
                    <span class="text-muted-foreground"
                      >· {{ shortDate(older.at(-1)!.date, today) }} to
                      {{ shortDate(older[0]!.date, today) }}</span
                    >
                  </span>
                  <ChevronRight
                    class="size-4 shrink-0 text-muted-foreground transition-transform"
                    :class="showOlder && 'rotate-90'"
                  />
                </button>
                <span v-if="olderAdded !== older.length" class="shrink-0 text-xs text-muted-foreground"
                  >{{ olderAdded }} added</span
                >
              </div>
              <template v-else>
                <!-- Yours -->
                <div v-if="line.type === 'remote'" class="hatch" />
                <div
                  v-else
                  :class="
                    cn(
                      'flex min-w-0 items-center gap-2 px-3 py-1.5',
                      line.type === 'pair' && line.pair.kind === 'matched' && 'text-muted-foreground',
                      line.type !== 'pair' && 'cursor-pointer hover:bg-muted/50',
                      line.type !== 'pair' &&
                        isPicked('local', line.local.id) &&
                        'bg-primary/10 ring-1 ring-primary ring-inset',
                    )
                  "
                  @click="line.type !== 'pair' && pick('local', line.local)"
                >
                  <template v-for="l in [line.type === 'pair' ? line.pair.local : line.local]" :key="l.id">
                    <Checkbox
                      v-if="line.type !== 'pair'"
                      :model-value="keep.has(l.id)"
                      :disabled="l.deleted"
                      aria-label="Keep it"
                      @click.stop
                      @update:model-value="(v) => (keep = toggle(keep, l.id, !!v))"
                    />
                    <span class="w-12 shrink-0 text-xs text-muted-foreground">{{
                      shortDate(l.date, today)
                    }}</span>
                    <span
                      class="min-w-0 flex-1 truncate"
                      :class="line.type !== 'pair' && !keep.has(l.id) && 'text-muted-foreground line-through'"
                      >{{ l.payee }}</span
                    >
                    <span v-if="l.deleted" class="shrink-0 text-xs text-muted-foreground">deleted</span>
                    <span class="tabular shrink-0">{{ money(l.amountMinor) }}</span>
                  </template>
                </div>

                <!-- What it is -->
                <div class="flex items-center justify-center border-x text-muted-foreground">
                  <template v-if="line.type === 'pair'">
                    <span
                      v-if="line.pair.kind === 'guessed'"
                      class="font-medium text-amber-700 dark:text-amber-400"
                      title="Possibly the same transaction"
                      >=</span
                    >
                    <span
                      v-else-if="line.pair.kind === 'user'"
                      class="text-foreground"
                      title="The same transaction, you said"
                      >=</span
                    >
                    <span v-else title="The same transaction">=</span>
                  </template>
                  <span
                    v-else-if="line.type === 'apart'"
                    :title="
                      line.why === 'near'
                        ? 'The same day and payee, another amount'
                        : 'Not the same, you said'
                    "
                    >≠</span
                  >
                  <span v-else-if="line.type === 'local'" title="Only yours">−</span>
                  <span v-else title="Only the bank’s">+</span>
                </div>

                <!-- The bank's -->
                <div v-if="line.type === 'local'" class="hatch" />
                <div
                  v-else
                  :class="
                    cn(
                      'flex min-w-0 items-center gap-2 px-3 py-1.5',
                      line.type === 'pair' && line.pair.kind === 'matched' && 'text-muted-foreground',
                      line.type !== 'pair' && 'cursor-pointer hover:bg-muted/50',
                      line.type !== 'pair' &&
                        isPicked('remote', line.remote.remoteId) &&
                        'bg-primary/10 ring-1 ring-primary ring-inset',
                    )
                  "
                  @click="line.type !== 'pair' && pick('remote', line.remote)"
                >
                  <template
                    v-for="r in [line.type === 'pair' ? line.pair.remote : line.remote]"
                    :key="r.remoteId"
                  >
                    <Checkbox
                      v-if="line.type !== 'pair'"
                      :model-value="add.has(r.remoteId)"
                      aria-label="Add it"
                      @click.stop
                      @update:model-value="(v) => (add = toggle(add, r.remoteId, !!v))"
                    />
                    <span class="w-12 shrink-0 text-xs text-muted-foreground">{{
                      shortDate(r.date, today)
                    }}</span>
                    <span
                      class="min-w-0 flex-1 truncate"
                      :class="
                        line.type !== 'pair' && !add.has(r.remoteId) && 'text-muted-foreground line-through'
                      "
                      >{{ r.payee }}</span
                    >
                    <span v-if="r.pending" class="shrink-0 text-xs text-muted-foreground">pending</span>
                    <span class="tabular shrink-0">{{ money(r.amountMinor) }}</span>
                  </template>
                </div>

                <!-- What you can do -->
                <div class="flex min-w-0 items-center justify-end gap-2 border-l px-2">
                  <template v-if="line.type === 'pair'">
                    <span
                      v-if="line.pair.kind === 'guessed'"
                      class="truncate text-xs font-medium text-amber-700 dark:text-amber-400"
                      title="It has the same amount and day as another, and the payees don’t say which is which."
                      >Possible match</span
                    >
                    <span v-else-if="line.pair.kind === 'user'" class="truncate text-xs text-muted-foreground"
                      >Paired by you</span
                    >
                    <Button
                      type="button"
                      :variant="line.pair.kind === 'guessed' ? 'outline' : 'ghost'"
                      size="xs"
                      :class="line.pair.kind !== 'guessed' && 'text-muted-foreground'"
                      @click="split(line.pair)"
                      >Not the same</Button
                    >
                  </template>
                  <template v-else-if="line.type === 'apart'">
                    <span v-if="line.why === 'near'" class="truncate text-xs text-muted-foreground"
                      >Another amount</span
                    >
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      class="text-muted-foreground"
                      :title="line.why === 'near' ? 'Pair them. Your amount stays.' : 'Pair them again'"
                      @click="pairUp(line.local, line.remote)"
                      >Same</Button
                    >
                  </template>
                </div>
              </template>
            </div>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          A pair is one transaction. It keeps your payee, category and notes, and takes {{ newSource }}’s date
          and time. A possible match has the same amount and day as another, and the payees don’t say which is
          which. Unchecked ones are left out. Click one on each side to pair them. Yours from before the From
          date stay as they are.
        </p>
      </template>

      <p v-if="error && preview" class="text-sm text-destructive">{{ error }}</p>
      <DialogFooter class="items-center">
        <span v-if="preview?.fetchedAt" class="mr-auto text-sm text-muted-foreground">{{ summary }}</span>
        <Button type="button" variant="outline" @click="open = false">Cancel</Button>
        <Button
          type="button"
          :disabled="!preview?.fetchedAt || m.switchTo.isPending.value || m.preview.isPending.value"
          @click="submit"
        >
          <Loader2 v-if="m.switchTo.isPending.value" class="animate-spin" />Switch
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* Nothing on this side. */
.hatch {
  background: repeating-linear-gradient(135deg, transparent 0 6px, var(--muted) 6px 12px);
}
</style>
