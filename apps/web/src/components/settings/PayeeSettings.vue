<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { Search, Store, X } from '@lucide/vue'
import type { PayeeChoiceUpdate, PayeeRule } from '@st/shared'
import CategoryPicker from '@/components/CategoryPicker.vue'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCategories, usePayeeRules, useSetPayeeChoice } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

/** Payees you chose to always set to one category, or to always review yourself. The rest ask each time. */
const rules = usePayeeRules()
const set = useSetPayeeChoice()
const { byId } = useCategories()

// Searched by the payee, or the category it's set to.
const search = ref('')
const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  const all = rules.data.value ?? []
  if (!q) return all
  return all.filter((r) => r.payee.toLowerCase().includes(q) || (r.categoryId !== null && !!byId.value.get(r.categoryId)?.name.toLowerCase().includes(q)))
})

// "Always" picked for a payee you review yourself: waits for its category.
const choosing = ref(new Set<string>())
const modeOf = (r: PayeeRule) => (choosing.value.has(r.payeeKey) ? 'always' : r.mode)

async function save(r: PayeeRule, input: Omit<PayeeChoiceUpdate, 'payeeKey'>) {
  try {
    const res = await set.mutateAsync({ payeeKey: r.payeeKey, ...input })
    choosing.value.delete(r.payeeKey)
    if (input.mode === 'always') {
      const name = byId.value.get(res.categoryId!)?.name ?? 'that category'
      toast.success(`${r.payee}: always ${name}`, { description: res.updated ? `${res.updated} transaction${res.updated === 1 ? '' : 's'} set and marked as reviewed` : undefined })
    }
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

function setMode(r: PayeeRule, mode: 'always' | 'review') {
  if (mode === 'always') {
    if (r.mode !== 'always') choosing.value = new Set(choosing.value).add(r.payeeKey)
    return
  }
  choosing.value.delete(r.payeeKey)
  void save(r, { mode })
}

/** Off the list: it asks each time again. Undo puts the choice back. */
async function remove(r: PayeeRule) {
  try {
    await set.mutateAsync({ payeeKey: r.payeeKey, mode: 'ask' })
    choosing.value.delete(r.payeeKey)
    const before: Omit<PayeeChoiceUpdate, 'payeeKey'> = r.mode === 'always' && r.categoryId ? { mode: 'always', categoryId: r.categoryId } : { mode: 'review' }
    toast.success(`${r.payee} asks each time now`, { action: { label: 'Undo', onClick: () => set.mutate({ payeeKey: r.payeeKey, ...before }) } })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <Card class="gap-0">
      <CardHeader>
        <CardTitle>Payees</CardTitle>
        <CardDescription>
          Payees set to one category are categorized without review. Payees not in this list get a suggestion to review each time. When you
          set a transaction’s category, you can choose what happens to its payee.
        </CardDescription>
        <p class="pt-1 text-sm text-muted-foreground">
          What payees are called, and AI tidying of their names, is in
          <RouterLink :to="{ name: 'app-settings', query: { tab: 'payees' } }" class="text-primary underline-offset-4 hover:underline">App settings → Payees</RouterLink>.
        </p>
      </CardHeader>
    </Card>

    <Card class="gap-0 py-0">
      <div v-if="rules.data.value?.length" class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
        <span class="text-sm font-medium">Payee choices <span class="font-normal text-muted-foreground tabular">{{ rules.data.value.length }}</span></span>
        <div class="flex h-8 w-56 items-center gap-2 rounded-md border px-2.5">
          <Search class="size-3.5 shrink-0 opacity-50" />
          <input v-model="search" placeholder="Search payees" aria-label="Search payees" class="h-full w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground" />
        </div>
      </div>
      <ul v-if="shown.length" class="divide-y">
        <li v-for="r in shown" :key="r.payeeKey" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:px-6">
          <div class="min-w-0 flex-1 basis-40">
            <div class="truncate text-sm">{{ r.payee }}</div>
            <div class="text-xs text-muted-foreground tabular">{{ r.transactionCount }} transaction{{ r.transactionCount === 1 ? '' : 's' }}</div>
          </div>
          <Select :model-value="modeOf(r)" @update:model-value="(v) => setMode(r, v as 'always' | 'review')">
            <SelectTrigger size="sm" class="w-52" :aria-label="`What happens to ${r.payee}`"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always set to</SelectItem>
              <SelectItem value="review">Always manually review</SelectItem>
            </SelectContent>
          </Select>
          <CategoryPicker
            v-if="modeOf(r) === 'always'"
            :model-value="choosing.has(r.payeeKey) ? null : r.categoryId"
            :allow-none="false"
            size="sm"
            placeholder="Choose a category"
            class="w-44"
            @update:model-value="(id) => id && save(r, { mode: 'always', categoryId: id })"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground/60 hover:text-foreground"
            :aria-label="`Remove ${r.payee}`"
            title="Remove: ask each time"
            :disabled="set.isPending.value"
            @click="remove(r)"
          >
            <X />
          </Button>
        </li>
      </ul>
      <p v-else-if="rules.data.value?.length" class="px-4 py-6 text-center text-sm text-muted-foreground md:px-6">No payee matches.</p>
      <EmptyState
        v-else-if="!rules.isLoading.value"
        :icon="Store"
        title="No payee choices yet"
        description="When you set a transaction’s category, choose to always set its payee that way, or to always review it yourself. Payees not listed here ask each time."
      />
    </Card>
  </div>
</template>
