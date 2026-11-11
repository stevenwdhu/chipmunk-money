<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useIntersectionObserver } from '@vueuse/core'
import { ChevronDown, History, KeyRound, Loader2, Monitor } from '@lucide/vue'
import type { Activity } from '@chipmunk/shared'
import EmptyState from '@/components/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAccounts, useActivity, useActivityActors, useCategories, useSettings } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { money, relativeDay } from '@/lib/format'
import { cn } from '@/lib/utils'

const route = useRoute()
const router = useRouter()
const today = useToday()
const settings = useSettings()
const tz = computed(() => settings.data.value?.effectiveTimezone)
const { byId: accounts } = useAccounts()
const { byId: categories } = useCategories()

const ENTITIES = [
  { value: 'transaction', label: 'Transactions' },
  { value: 'account', label: 'Accounts' },
  { value: 'category', label: 'Categories' },
  { value: 'category_group', label: 'Category groups' },
  { value: 'label', label: 'Labels' },
  { value: 'institution', label: 'Institutions' },
  { value: 'tag', label: 'Tags' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'import', label: 'Imports' },
  { value: 'custom_report', label: 'Custom reports' },
  { value: 'ledger', label: 'Ledger' },
]

// Filters live in the URL, so "what did the agent change" can be bookmarked.
const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined)
const actor = computed({
  get: () => q('actor') ?? 'all',
  set: (v: string) => router.replace({ query: { ...route.query, actor: v === 'all' ? undefined : v } }),
})
const entity = computed({
  get: () => q('entity') ?? 'all',
  set: (v: string) => router.replace({ query: { ...route.query, entity: v === 'all' ? undefined : v } }),
})
const filters = computed(() => ({
  actor: actor.value === 'all' ? undefined : actor.value,
  entity: entity.value === 'all' ? undefined : entity.value,
}))
const actors = useActivityActors()
const list = useActivity(filters)
const items = computed(() => list.data.value?.pages.flatMap((p) => p.items) ?? [])
const actorLabel = (a: string) => (a === 'web' ? 'You (web app)' : a)

const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz.value }).format(new Date(iso))
const timeOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: tz.value }).format(new Date(iso))
const days = computed(() => {
  const out: Array<{ day: string; items: Activity[] }> = []
  for (const a of items.value) {
    const day = dayOf(a.createdAt)
    if (out[out.length - 1]?.day !== day) out.push({ day, items: [] })
    out[out.length - 1]!.items.push(a)
  }
  return out
})

const sentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(sentinel, ([entry]) => {
  if (entry?.isIntersecting && list.hasNextPage.value && !list.isFetchingNextPage.value) list.fetchNextPage()
})

// Showing changes ------------------------------------------------------------

const open = ref(new Set<number>())
function toggle(id: number) {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

const HIDDEN = new Set(['id', 'createdAt', 'updatedAt', 'payeeKey', 'sort', 'importMapping', 'transactionCount'])
const LABELS: Record<string, string> = {
  accountId: 'Account',
  categoryId: 'Category',
  groupId: 'Group',
  amountMinor: 'Amount',
  balanceMinor: 'Balance',
  openingBalanceMinor: 'Opening balance',
  expectedAmountMinor: 'Expected amount',
  needsReview: 'Needs review',
  categorySource: 'Category from',
  categoryConfidence: 'Confidence',
  recurringItemId: 'Recurring item',
  externalId: 'External id',
  isIncome: 'Income',
  excludeFromTotals: 'Left out of totals',
}
const label = (k: string) => LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

function show(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (key === 'accountId') return accounts.value.get(v as number)?.name ?? `#${v}`
  if (key === 'categoryId') return categories.value.get(v as number)?.name ?? `#${v}`
  if (key.endsWith('Minor') && typeof v === 'number') return money(v)
  if (key === 'tags' && Array.isArray(v)) return v.length ? v.map((t) => `#${(t as { name: string }).name ?? t}`).join(' ') : '—'
  if (key === 'categoryConfidence' && typeof v === 'number') return `${Math.round(v * 100)}%`
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

type Row = { key: string; before?: string; after?: string }
type Detail = { heading?: string; rows: Row[] }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Turns an entry's before/after into rows a person can read. */
function details(a: Activity): Detail[] {
  const { before, after } = a
  if (Array.isArray(before) || Array.isArray(after)) {
    // Bulk changes: one block per transaction.
    const b = (before as Array<Record<string, unknown>> | null) ?? []
    const f = (after as Array<Record<string, unknown>> | null) ?? []
    return f.slice(0, 50).map((x, i) => ({
      heading: `Transaction #${x.id}`,
      rows: Object.keys(x)
        .filter((k) => !HIDDEN.has(k))
        .map((k) => ({ key: label(k), before: show(k, b[i]?.[k]), after: show(k, x[k]) })),
    }))
  }
  if (isRecord(before) && isRecord(after)) {
    return [{ rows: Object.keys(after).filter((k) => !HIDDEN.has(k)).map((k) => ({ key: label(k), before: show(k, before[k]), after: show(k, after[k]) })) }]
  }
  const only = isRecord(after) ? after : isRecord(before) ? before : null
  if (!only) return []
  const rows = Object.entries(only)
    .filter(([k, v]) => !HIDDEN.has(k) && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => ({ key: label(k), [isRecord(after) ? 'after' : 'before']: show(k, v) }))
  return [{ rows }]
}
const hasDetails = (a: Activity) => details(a).some((d) => d.rows.length)
</script>

<template>
  <PageHeader title="Activity" subtitle="Every change, and who made it" />
  <main class="mx-auto grid w-full max-w-3xl grid-cols-1 gap-4 p-4 md:p-6">
    <div class="grid grid-cols-2 gap-2 sm:flex">
      <Select v-model="actor">
        <SelectTrigger class="w-full sm:w-52" aria-label="Who"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Everyone</SelectItem>
          <SelectItem v-for="x in actors.data.value ?? []" :key="x" :value="x">{{ actorLabel(x) }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="entity">
        <SelectTrigger class="w-full sm:w-44" aria-label="What"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Everything</SelectItem>
          <SelectItem v-for="e in ENTITIES" :key="e.value" :value="e.value">{{ e.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <Card v-if="list.isPending.value" class="p-6 text-sm text-muted-foreground">Loading…</Card>
    <Card v-else-if="!items.length" class="py-0">
      <EmptyState
        :icon="History"
        title="Nothing here yet"
        :description="
          filters.actor || filters.entity
            ? 'No changes match these filters.'
            : 'Changes you make, and changes made with API keys, show up here with what they changed.'
        "
      />
    </Card>

    <section v-for="d in days" :key="d.day" class="grid gap-2">
      <h2 class="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{{ relativeDay(d.day, today) }}</h2>
      <Card class="gap-0 py-0">
        <ul class="divide-y">
          <li v-for="a in d.items" :key="a.id">
            <component
              :is="hasDetails(a) ? 'button' : 'div'"
              :type="hasDetails(a) ? 'button' : undefined"
              :class="cn('flex w-full items-start gap-3 px-4 py-3 text-left md:px-5', hasDetails(a) && 'hover:bg-muted/50')"
              :aria-expanded="hasDetails(a) ? open.has(a.id) : undefined"
              @click="hasDetails(a) && toggle(a.id)"
            >
              <span
                :class="
                  cn(
                    'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full',
                    a.actor === 'web' ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
                  )
                "
                :title="actorLabel(a.actor)"
              >
                <Monitor v-if="a.actor === 'web'" class="size-3.5" />
                <KeyRound v-else class="size-3.5" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm">{{ a.summary }}</span>
                <span class="block text-xs text-muted-foreground">{{ actorLabel(a.actor) }} · {{ timeOf(a.createdAt) }}</span>
              </span>
              <ChevronDown
                v-if="hasDetails(a)"
                :class="cn('mt-1 size-4 shrink-0 text-muted-foreground transition-transform', open.has(a.id) && 'rotate-180')"
              />
            </component>
            <div v-if="open.has(a.id)" class="grid gap-3 px-4 pb-3 pl-14 md:px-5 md:pl-15">
              <div v-for="(block, i) in details(a)" :key="i" class="grid gap-1">
                <p v-if="block.heading" class="text-xs font-medium">{{ block.heading }}</p>
                <dl class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
                  <template v-for="row in block.rows" :key="row.key">
                    <dt class="text-muted-foreground">{{ row.key }}</dt>
                    <dd class="min-w-0 break-words">
                      <template v-if="row.before !== undefined && row.after !== undefined">
                        <span class="text-muted-foreground line-through">{{ row.before }}</span>
                        <span class="text-muted-foreground"> → </span>
                        <span>{{ row.after }}</span>
                      </template>
                      <span v-else-if="row.after !== undefined">{{ row.after }}</span>
                      <span v-else class="text-muted-foreground line-through">{{ row.before }}</span>
                    </dd>
                  </template>
                </dl>
              </div>
            </div>
          </li>
        </ul>
      </Card>
    </section>

    <div ref="sentinel" class="flex justify-center py-2">
      <Loader2 v-if="list.isFetchingNextPage.value" class="size-4 animate-spin text-muted-foreground" />
      <Button v-else-if="list.hasNextPage.value" variant="ghost" size="sm" @click="list.fetchNextPage()">Load more</Button>
    </div>
  </main>
</template>
