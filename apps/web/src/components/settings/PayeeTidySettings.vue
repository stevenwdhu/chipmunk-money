<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArrowRight, Check, ChevronLeft, ChevronRight, Loader2, Pencil, RotateCcw, Search, Sparkles, X } from '@lucide/vue'
import type { PayeeTidyName, PayeeTidyPreview } from '@st/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { previewPayeeTidy, usePayeeNameMutations, usePayeeTidy } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * AI tidying of payee names: turning it on shows what it makes of 20 payees first, then it names the
 * rest in the background, and every payee it named is listed here, to look through and ask again.
 */
const status = usePayeeTidy()
const m = usePayeeNameMutations()
const s = computed(() => status.data.value)

// Turning it on: a preview first, 20 payees at a time. Batches seen are kept, to go back to.
const BATCH = 20
const previewOpen = ref(false)
const batches = ref<PayeeTidyPreview[]>([])
const page = ref(0)
const total = ref(0)
const loading = ref(false)
const previewError = ref('')
const preview = computed(() => batches.value[page.value] ?? null)
const hasNext = computed(() => (page.value + 1) * BATCH < total.value)
const range = computed(() => {
  const from = page.value * BATCH + 1
  const to = Math.min(from + (preview.value?.samples.length ?? BATCH) - 1, total.value || from + BATCH - 1)
  return total.value ? `${from}–${to} of ${total.value}` : ''
})
const table = ref<HTMLElement | null>(null)
watch(page, () => table.value?.scrollTo({ top: 0 }))
async function showBatch(p: number) {
  previewError.value = ''
  page.value = p
  if (batches.value[p]) return
  loading.value = true
  try {
    const batch = await previewPayeeTidy(p)
    batches.value[p] = batch
    total.value = batch.total
  } catch (err) {
    previewError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}
function startPreview() {
  previewOpen.value = true
  batches.value = []
  total.value = 0
  void showBatch(0)
}
async function turn(enabled: boolean) {
  try {
    await m.tidy.mutateAsync(enabled)
    previewOpen.value = false
    toast.success(enabled ? 'AI tidying is on' : 'AI tidying is off', {
      description: enabled ? 'It tidies the rest of your payees in the background.' : 'Payees show as the bank sent them again. What AI said is kept for next time.',
    })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
function toggle(on: boolean) {
  if (on) void startPreview()
  else void turn(false)
}

// The payees it named, searched.
const search = ref('')
const names = computed(() => {
  const q = search.value.trim().toLowerCase()
  const all = s.value?.names ?? []
  return q ? all.filter((n) => [n.original, n.tidied, n.name].some((t) => t.toLowerCase().includes(q))) : all
})
const payees = (n: number) => (n === 1 ? 'one payee' : `${n} payees`)

// Several at once: asked again together, or one name for them all.
const selected = ref(new Set<string>())
watch(
  () => s.value?.names,
  (all) => {
    if (!all) return
    const have = new Set(all.map((n) => n.original))
    if ([...selected.value].some((o) => !have.has(o))) selected.value = new Set([...selected.value].filter((o) => have.has(o)))
  },
)
function select(original: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(original)
  else next.delete(original)
  selected.value = next
}
const shownSelected = computed(() => {
  const n = names.value.filter((x) => selected.value.has(x.original)).length
  return n === 0 ? false : n === names.value.length ? true : 'indeterminate'
})
function selectShown(on: boolean) {
  const next = new Set(selected.value)
  for (const n of names.value) {
    if (on) next.add(n.original)
    else next.delete(n.original)
  }
  selected.value = next
}

const naming = ref(false)
const commonName = ref('')
const picked = computed(() => (s.value?.names ?? []).filter((n) => selected.value.has(n.original)))
function startNaming() {
  const shared = new Set(picked.value.map((n) => n.name))
  commonName.value = shared.size === 1 ? [...shared][0]! : ''
  naming.value = true
}
async function nameSelected() {
  const chosen = [...selected.value]
  try {
    const { rule } = await m.nameWordings.mutateAsync({ payees: chosen, name: commonName.value.trim() || null })
    naming.value = false
    selected.value = new Set()
    toast.success(rule ? `Called ${rule.name}` : 'Back to AI’s names', {
      description: rule ? `A custom rule names ${payees(chosen.length)} now, in every ledger.` : `${payees(chosen.length)} go by what AI tidying called them.`,
    })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

// A name of your own for one of them: a rule for that wording, in Custom rules below.
const editing = ref<string | null>(null)
const draft = ref('')
async function startEdit(n: PayeeTidyName) {
  editing.value = n.original
  draft.value = n.name
  await nextTick()
  const input = document.getElementById('tidied-name') as HTMLInputElement | null
  input?.focus()
  input?.select()
}
async function saveName(n: PayeeTidyName) {
  const name = draft.value.trim()
  if (name === n.name) return void (editing.value = null)
  try {
    const { rule } = await m.nameWordings.mutateAsync({ payees: [n.original], name: name || null })
    editing.value = null
    toast.success(rule ? `Called ${rule.name}` : `Called ${n.tidied} again`, {
      description: rule ? 'A custom rule names it now, in every ledger.' : 'It goes by what AI tidying called it.',
    })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

async function again(originals: string[]) {
  try {
    await m.tidyAgain.mutateAsync(originals)
    for (const o of originals) select(o, false)
    toast.success(originals.length === 1 ? 'Asked again' : `Asked again about ${payees(originals.length)}`, {
      description: s.value?.enabled ? 'Named again in a moment, together.' : 'Named again when AI tidying is on.',
    })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <Card class="gap-0">
    <CardHeader class="flex flex-row items-start justify-between gap-4">
      <div class="grid gap-1.5">
        <CardTitle class="flex items-center gap-2"><Sparkles class="size-4 text-ai" />AI tidying</CardTitle>
        <CardDescription>
          AI names each payee the way people know it, like “Walmart” for “Wal-Mart Supercenter#4217”, and keeps how the money moved, like
          “Jane Doe - e-Transfer”. Each payee is asked about once, then that name is used in every ledger. Off, payees show as the bank sent them.
          Custom rules come first either way.
        </CardDescription>
      </div>
      <Switch
        :model-value="s?.enabled ?? false"
        :disabled="!s || (!s.available && !s.enabled) || m.tidy.isPending.value"
        aria-label="AI tidying"
        @update:model-value="(v) => toggle(!!v)"
      />
    </CardHeader>
    <CardContent v-if="s && (!s.available || s.running || s.error)" class="grid gap-2 pb-4 text-sm">
      <p v-if="!s.available" class="text-muted-foreground">
        It needs an AI provider. Set one up in <RouterLink :to="{ query: { tab: 'ai' } }" class="text-primary underline-offset-4 hover:underline">AI</RouterLink> first.
      </p>
      <div v-if="s.running" class="grid gap-1.5">
        <p class="flex items-center gap-2 text-muted-foreground"><Loader2 class="size-3.5 animate-spin" />Tidying payees: {{ s.done }} of {{ s.total }}</p>
        <Progress :model-value="s.total ? (s.done / s.total) * 100 : 0" class="h-1.5" />
      </div>
      <div v-else-if="s.error" class="grid justify-items-start gap-1">
        <p class="text-destructive">It stopped: {{ s.error }}</p>
        <Button variant="link" size="sm" class="h-auto px-0" @click="turn(true)">Try again</Button>
      </div>
    </CardContent>
  </Card>

  <Card v-if="s?.names.length" class="gap-0 py-0">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
      <div class="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Checkbox :model-value="shownSelected" :disabled="!names.length" aria-label="Select all shown" @update:model-value="(v) => selectShown(v === true)" />
        <template v-if="selected.size">
          <span class="text-sm font-medium tabular">{{ selected.size }} selected</span>
          <Button variant="outline" size="sm" @click="startNaming"><Pencil />Name them</Button>
          <Button variant="outline" size="sm" :disabled="m.tidyAgain.isPending.value" @click="again([...selected])"><RotateCcw />Ask AI again</Button>
          <Button variant="ghost" size="sm" @click="selected = new Set()">Clear</Button>
        </template>
        <span v-else class="text-sm font-medium">Tidied payees <span class="font-normal text-muted-foreground tabular">{{ s.names.length }}</span></span>
      </div>
      <div class="flex h-8 w-56 items-center gap-2 rounded-md border px-2.5">
        <Search class="size-3.5 shrink-0 opacity-50" />
        <input v-model="search" placeholder="Search payees" class="h-full w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground" />
      </div>
    </div>
    <ul class="max-h-[40rem] divide-y overflow-y-auto">
      <li v-for="n in names" :key="n.original" :class="cn('flex items-center gap-3 px-4 py-2 md:px-6', selected.has(n.original) && 'bg-muted/50')">
        <Checkbox :model-value="selected.has(n.original)" :aria-label="`Select ${n.original}`" @update:model-value="(v) => select(n.original, v === true)" />
        <div class="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span class="min-w-0 truncate text-muted-foreground" :title="n.original">{{ n.original }}</span>
          <ArrowRight class="size-3.5 shrink-0 text-muted-foreground" />
          <form v-if="editing === n.original" class="flex min-w-0 flex-1 items-center gap-1" @submit.prevent="saveName(n)">
            <Input
              id="tidied-name"
              v-model="draft"
              class="h-7 min-w-0 flex-1 text-sm"
              :placeholder="n.tidied"
              aria-label="Its name"
              title="Empty: what AI tidying called it"
              @keydown.esc.prevent="editing = null"
            />
            <Button type="submit" variant="ghost" size="icon-sm" aria-label="Save" title="Save" :disabled="m.nameWordings.isPending.value">
              <Loader2 v-if="m.nameWordings.isPending.value" class="animate-spin" /><Check v-else />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel" title="Cancel" @click="editing = null"><X /></Button>
          </form>
          <template v-else>
            <span class="min-w-0 truncate font-medium" :title="n.ruleId !== null ? `AI tidying called it ${n.tidied}` : undefined">{{ n.name }}</span>
            <span v-if="n.ruleId !== null" class="shrink-0 text-xs text-muted-foreground">custom rule</span>
          </template>
        </div>
        <span class="shrink-0 text-xs text-muted-foreground tabular">{{ n.transactions }}</span>
        <Button v-if="editing !== n.original" variant="ghost" size="icon-sm" aria-label="Change its name" title="Change its name" @click="startEdit(n)">
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Ask AI again" title="Ask AI again" :disabled="m.tidyAgain.isPending.value" @click="again([n.original])">
          <RotateCcw />
        </Button>
      </li>
    </ul>
    <p v-if="!names.length" class="px-4 py-6 text-center text-sm text-muted-foreground md:px-6">No tidied payee matches.</p>
  </Card>

  <!-- One name for the payees selected. -->
  <Dialog v-model:open="naming">
    <DialogContent class="sm:max-w-md">
      <form class="grid gap-4" @submit.prevent="nameSelected">
        <DialogHeader>
          <DialogTitle>Name {{ payees(picked.length) }}</DialogTitle>
          <DialogDescription>They’re called this in every ledger, by one custom rule. A name a custom rule gives already joins that rule.</DialogDescription>
        </DialogHeader>
        <div class="grid gap-1.5">
          <FieldLabel html-for="tidied-names" hint="Empty: off custom rules, they go by what AI tidying called them.">Name</FieldLabel>
          <Input id="tidied-names" v-model="commonName" placeholder="What AI tidying called them" />
        </div>
        <ul class="max-h-48 divide-y overflow-y-auto rounded-md border text-xs">
          <li v-for="n in picked" :key="n.original" class="flex min-w-0 items-center gap-2 px-3 py-1.5">
            <span class="min-w-0 truncate text-muted-foreground" :title="n.original">{{ n.original }}</span>
            <ArrowRight class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 truncate">{{ n.name }}</span>
          </li>
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" @click="naming = false">Cancel</Button>
          <Button type="submit" :disabled="m.nameWordings.isPending.value"><Loader2 v-if="m.nameWordings.isPending.value" class="animate-spin" />Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <!-- Before it's on: what it makes of 20 payees. -->
  <Dialog v-model:open="previewOpen">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Try AI tidying</DialogTitle>
        <DialogDescription>AI tidied these payees, the messiest and most used first. If they look right, turn it on, and it tidies the rest in the background.</DialogDescription>
      </DialogHeader>
      <p v-if="previewError" class="text-sm text-destructive">{{ previewError }}</p>
      <p v-else-if="!preview" class="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 class="size-4 animate-spin" />Asking AI to tidy 20 payees…</p>
      <div v-else ref="table" class="max-h-[55vh] overflow-y-auto rounded-md border">
        <table class="w-full table-fixed text-sm">
          <thead class="sticky top-0 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
            <tr>
              <th class="px-3 py-2 font-medium">As the bank sent it</th>
              <th class="px-3 py-2 font-medium">With AI tidying</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="p in preview.samples" :key="p.original">
              <td class="truncate px-3 py-1.5 text-muted-foreground" :title="p.original">{{ p.original }}</td>
              <td class="truncate px-3 py-1.5 font-medium" :title="p.tidied">{{ p.tidied }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <DialogFooter class="sm:justify-between">
        <!-- Other batches: the next one is asked about, ones seen come back as they were. -->
        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" aria-label="Previous 20" title="Previous 20" :disabled="page === 0 || loading" @click="showBatch(page - 1)">
            <ChevronLeft />
          </Button>
          <Button type="button" variant="outline" :disabled="!hasNext || loading" @click="showBatch(page + 1)">Next 20<ChevronRight /></Button>
          <span class="text-xs text-muted-foreground tabular">{{ range }}</span>
        </div>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" @click="previewOpen = false">Not now</Button>
          <Button type="button" :disabled="!batches.length || loading || m.tidy.isPending.value" @click="turn(true)">
            <Loader2 v-if="m.tidy.isPending.value" class="animate-spin" />Turn on
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
