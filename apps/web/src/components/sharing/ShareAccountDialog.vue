<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import { statementBalance, type Account, type AccountSharing, type AccountSharingSet, type SharingChange } from '@chipmunk/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useAccountSharing, useAccountSharingPreview, useLedgers, useSetAccountSharing } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { money } from '@/lib/format'
import { cn } from '@/lib/utils'
import SharingRowsChoice from './SharingRowsChoice.vue'

type Part = AccountSharing['home']
type Rows = 'home' | 'keep'

/**
 * Which ledgers have a credit card, and which one is its home. Opened in the account's home. What
 * a change does (the balances, and what to know first) is the server's dry run of it, shown before
 * it's saved.
 */
const props = defineProps<{ account: Account }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [SharingChange] }>()

const ledgers = useLedgers()
const sharing = useAccountSharing(() => props.account.id, open)
const m = useSetAccountSharing()

/** The sharing as it was when the dialog opened. */
const now = ref<AccountSharing | null>(null)
const ticked = ref<string[]>([])
const home = ref('')
const rows = ref<Record<string, Rows | null>>({})
const error = ref('')

watch(open, async (v) => {
  if (!v) return
  now.value = null
  error.value = ''
  // Asked again each time it opens: what the ledgers hold may have changed.
  const { data } = await sharing.refetch()
  if (!data || !open.value) return
  now.value = data
  ticked.value = [data.home.slug, ...data.members.map((l) => l.slug)]
  home.value = data.home.slug
  rows.value = {}
})

const parts = computed(() => new Map((now.value ? [now.value.home, ...now.value.members] : []).map((p) => [p.slug, p])))
/** Every ledger, in the app's order. An archived one can't get the account or be its home. */
const list = computed(() =>
  ledgers.all.value.map((l) => {
    const part = parts.value.get(l.slug)
    return { ledger: l, part, on: ticked.value.includes(l.slug), isHome: home.value === l.slug, locked: l.archived && !part }
  }),
)
const nameOf = (slug: string) => ledgers.all.value.find((l) => l.slug === slug)?.name ?? slug
const homeName = computed(() => nameOf(home.value))

function toggle(slug: string, on: boolean) {
  if (on) return void (ticked.value = [...ticked.value, slug])
  // The home has the account: another ledger is made the home first.
  if (slug === home.value) return
  ticked.value = ticked.value.filter((s) => s !== slug)
}

/** The ledgers that stop having the account, and those of them with transactions to place. */
const leaving = computed(() => [...parts.value.values()].filter((p) => !ticked.value.includes(p.slug)))
const asked = computed(() => leaving.value.filter((p) => (p.transactionCount ?? 0) > 0))
const changed = computed(() => !!now.value && (home.value !== now.value.home.slug || leaving.value.length > 0 || ticked.value.some((s) => !parts.value.has(s))))

/**
 * The change as it stands, with `choices` for the leaving ledgers' transactions. One that holds none
 * says "home", which is where its deleted ones go.
 */
function request(choices: Record<string, Rows | null>): AccountSharingSet {
  const order = ledgers.all.value.map((l) => l.slug).filter((s) => ticked.value.includes(s))
  return { ledgers: order, home: home.value, rows: Object.fromEntries(leaving.value.map((p) => [p.slug, choices[p.slug] ?? 'home'])) }
}
const inputsFor = (p: Part) => ({ home: request({ ...rows.value, [p.slug]: 'home' }), keep: request({ ...rows.value, [p.slug]: 'keep' }) })
const input = computed(() => (changed.value && asked.value.every((p) => rows.value[p.slug]) ? request(rows.value) : null))
const preview = useAccountSharingPreview(() => props.account.id, input)

/** As the bank's statement shows it: for a credit card, what's owed. */
const shown = (minor: number) => money(statementBalance(minor, props.account.type))
const holds = (p: Part) => {
  if (p.transactionCount === null || p.balanceMinor === null) return ''
  return `${p.transactionCount} transaction${p.transactionCount === 1 ? '' : 's'} · ${shown(p.balanceMinor)}`
}

const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
const counted = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`

/** What was done, for the toast: where the account is now, then each change in a sentence. */
function said(c: SharingChange) {
  const all = [c.sharing.home, ...c.sharing.members].map((l) => l.name)
  const title = all.length > 1 ? `${props.account.name} is shared between ${listed(all)}` : `${props.account.name} is no longer shared`
  const what: string[] = []
  if (c.home) what.push(`${c.home.to.name} is its home now.`)
  for (const l of c.removed) {
    if (l.account) what.push(`${l.ledger.name} keeps its transactions in a new account of its own.`)
    else if (l.moved) what.push(`${l.ledger.name}’s ${counted(l.moved)} moved to ${c.sharing.home.name}.`)
  }
  return { title, description: what.length ? what.join(' ') : undefined }
}

async function save() {
  if (!input.value) return
  error.value = ''
  try {
    const done = await m.mutateAsync({ id: props.account.id, ...input.value })
    const { title, description } = said(done)
    toast.success(title, { description })
    open.value = false
    emit('saved', done)
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90svh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Share {{ account.name }}</DialogTitle>
        <DialogDescription>Choose the ledgers that have this account, and which one is its home.</DialogDescription>
      </DialogHeader>

      <p v-if="sharing.error.value && !now" class="text-sm text-destructive">{{ errorMessage(sharing.error.value) }}</p>
      <div v-else-if="!now" class="grid gap-2"><Skeleton v-for="i in 3" :key="i" class="h-9" /></div>
      <form v-else class="grid min-w-0 gap-4" @submit.prevent="save">
        <div>
          <div class="flex items-center justify-between pb-1 text-xs font-medium text-muted-foreground">
            <span>Ledger</span>
            <span>Home</span>
          </div>
          <ul class="divide-y border-y" role="radiogroup" aria-label="Home">
            <li v-for="row in list" :key="row.ledger.id" class="flex items-center gap-3 py-2">
              <label :class="cn('flex min-w-0 flex-1 items-center gap-2 text-sm', row.locked && 'text-muted-foreground')">
                <Checkbox
                  :model-value="row.on"
                  :disabled="row.locked || row.isHome"
                  :title="row.isHome ? 'Choose another home first' : undefined"
                  @update:model-value="toggle(row.ledger.slug, $event === true)"
                />
                <span class="size-2.5 shrink-0 rounded-full" :style="{ background: row.ledger.color }" />
                <span class="min-w-0">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate">{{ row.ledger.name }}</span>
                    <Badge v-if="row.ledger.archived" variant="outline">Archived</Badge>
                  </span>
                  <span v-if="row.part && holds(row.part)" class="block truncate text-xs text-muted-foreground tabular">{{ holds(row.part) }}</span>
                </span>
              </label>
              <button
                v-if="row.on"
                type="button"
                role="radio"
                :aria-checked="row.isHome"
                :aria-label="`${row.ledger.name} is the home`"
                :disabled="row.ledger.archived"
                class="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                @click="home = row.ledger.slug"
              >
                <span :class="cn('flex size-4 items-center justify-center rounded-full border shadow-xs', row.isHome ? 'border-primary' : 'border-input')">
                  <span v-if="row.isHome" class="size-2 rounded-full bg-primary" />
                </span>
              </button>
            </li>
          </ul>
          <p class="pt-2 text-xs text-muted-foreground">
            New transactions from sync and CSV go to the home. Nothing already recorded moves and no balance changes.
          </p>
        </div>

        <div v-for="p in asked" :key="p.slug" class="grid gap-1.5">
          <p class="text-sm font-medium">{{ p.name }} holds {{ counted(p.transactionCount ?? 0) }} on {{ account.name }}</p>
          <SharingRowsChoice
            :model-value="rows[p.slug] ?? null"
            :account="account"
            :leaving="p"
            :home-name="homeName"
            :inputs="inputsFor(p)"
            @update:model-value="rows = { ...rows, [p.slug]: $event }"
          />
        </div>

        <template v-if="input">
          <p v-if="preview.error.value" class="text-sm text-destructive">{{ errorMessage(preview.error.value) }}</p>
          <ul v-else-if="preview.data.value?.notices.length" class="grid gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <li v-for="(notice, i) in preview.data.value.notices" :key="i">{{ notice }}</li>
          </ul>
        </template>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="!input || !preview.data.value || !!preview.error.value || preview.isFetching.value || m.isPending.value">
            <Loader2 v-if="m.isPending.value || (!!input && preview.isFetching.value)" class="animate-spin" />Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
