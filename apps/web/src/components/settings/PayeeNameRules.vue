<script setup lang="ts">
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { ArrowRight, ChevronDown, ChevronUp, Pencil, Plus, X } from '@lucide/vue'
import type { PayeeNameRule } from '@st/shared'
import PayeeNameRuleDialog from '@/components/settings/PayeeNameRuleDialog.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { usePayeeNameMutations, usePayeeNameRules } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Your payee name rules, in every ledger, in the order they apply: each can be turned off, changed, moved or removed. */
const data = usePayeeNameRules()
const m = usePayeeNameMutations()
const rules = computed(() => data.data.value ?? [])

const editing = ref<PayeeNameRule | null>(null)
const dialogOpen = ref(false)
function edit(r: PayeeNameRule | null) {
  editing.value = r
  dialogOpen.value = true
}

const MATCH = { is: 'is', starts: 'starts with', contains: 'contains' } as const
const count = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`

async function run(work: Promise<{ changed: number }>, done?: string) {
  try {
    await work
    if (done) toast.success(done)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
function move(i: number, by: -1 | 1) {
  const ids = rules.value.map((r) => r.id)
  const [id] = ids.splice(i, 1)
  ids.splice(i + by, 0, id!)
  void run(m.order.mutateAsync(ids))
}
</script>

<template>
  <Card class="gap-0">
    <CardHeader class="flex flex-row items-start justify-between gap-4">
      <div class="grid gap-1.5">
        <CardTitle>Custom rules</CardTitle>
        <CardDescription>
          What payees are called, in every ledger. Custom rules come first, in this order, then AI tidying. Renaming a
          payee from one of its transactions adds a rule here.
        </CardDescription>
      </div>
      <Button size="sm" class="shrink-0" @click="edit(null)"><Plus />Add rule</Button>
    </CardHeader>
  </Card>

  <Card v-if="rules.length" class="gap-0 py-0">
    <ul class="divide-y">
      <li v-for="(r, i) in rules" :key="r.id" :class="cn('flex items-center gap-3 px-4 py-2.5 md:px-6', !r.enabled && 'opacity-60')">
        <div class="min-w-0 flex-1">
          <!-- What it does, in a few words. -->
          <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
            <template v-if="r.kind === 'regex'">
              <code class="min-w-0 truncate rounded bg-muted px-1 font-mono text-xs">/{{ r.patterns[0] }}/</code>
              <ArrowRight class="size-3.5 shrink-0 text-muted-foreground" />
              <code class="rounded bg-muted px-1 font-mono text-xs">{{ r.name }}</code>
            </template>
            <template v-else>
              <span class="text-muted-foreground">{{ MATCH[r.match ?? 'is'] }}</span>
              <span class="min-w-0 truncate">{{ r.patterns.join(', ') }}</span>
              <ArrowRight class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="font-medium">{{ r.name }}</span>
            </template>
          </div>
          <div class="text-xs text-muted-foreground tabular">{{ count(r.transactionCount) }}</div>
        </div>
        <Switch
          :model-value="r.enabled"
          :aria-label="r.enabled ? 'Turn off' : 'Turn on'"
          @update:model-value="(v) => run(m.update.mutateAsync({ id: r.id, enabled: !!v }))"
        />
        <div class="flex shrink-0 items-center">
          <Button variant="ghost" size="icon-sm" aria-label="Move up" title="Move up: it applies earlier" :disabled="i === 0" @click="move(i, -1)"><ChevronUp /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Move down" title="Move down" :disabled="i === rules.length - 1" @click="move(i, 1)"><ChevronDown /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Change" title="Change" @click="edit(r)"><Pencil /></Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground/60 hover:text-foreground"
            aria-label="Remove"
            title="Remove"
            @click="run(m.remove.mutateAsync(r.id), 'Rule removed')"
          >
            <X />
          </Button>
        </div>
      </li>
    </ul>
  </Card>

  <PayeeNameRuleDialog v-model:open="dialogOpen" :rule="editing" />
</template>
