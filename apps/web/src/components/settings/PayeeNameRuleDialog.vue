<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { ArrowRight, Loader2 } from '@lucide/vue'
import type { PayeeNameMatch, PayeeNamePreview, PayeeNameRule, PayeeNameRuleKind } from '@chipmunk/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { previewPayeeNames, usePayeeNameMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

/**
 * Adding or changing a payee name rule: names that are one payee, or a regex. What it would change, in
 * every ledger, shows as you type, before it's saved.
 */
const props = defineProps<{ rule?: PayeeNameRule | null }>()
const open = defineModel<boolean>('open', { default: false })

const m = usePayeeNameMutations()
const kind = ref<PayeeNameRuleKind>('same')
const match = ref<PayeeNameMatch>('is')
const patterns = ref('')
const name = ref('')

watch(open, (v) => {
  if (!v) return
  const r = props.rule
  kind.value = r?.kind ?? 'same'
  match.value = r?.match ?? 'is'
  patterns.value = (r?.patterns ?? []).join('\n')
  name.value = r?.name ?? ''
  preview.value = null
  problem.value = ''
})

/** One per line for names that are one payee, the first line otherwise. */
const lines = computed(() => {
  const all = patterns.value
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
  return kind.value === 'same' ? all : all.slice(0, 1)
})
const input = computed(() => ({
  kind: kind.value,
  match: kind.value === 'same' ? match.value : null,
  patterns: lines.value,
  name: name.value.trim() || null,
}))
const ready = computed(() => lines.value.length > 0 && !!input.value.name)

const preview = ref<PayeeNamePreview | null>(null)
const problem = ref('')
const previewing = ref(false)
watchDebounced(
  [input, open],
  async () => {
    if (!open.value || !ready.value) return void (preview.value = null)
    previewing.value = true
    try {
      preview.value = await previewPayeeNames({ rule: { ...input.value, ...(props.rule ? { id: props.rule.id } : {}) } })
      problem.value = ''
    } catch (err) {
      preview.value = null
      problem.value = errorMessage(err)
    } finally {
      previewing.value = false
    }
  },
  { debounce: 300, deep: true },
)

const saving = computed(() => m.create.isPending.value || m.update.isPending.value)
async function save() {
  try {
    const res = props.rule ? await m.update.mutateAsync({ id: props.rule.id, ...input.value }) : await m.create.mutateAsync(input.value)
    const n = res.rule.transactionCount
    toast.success(props.rule ? 'Rule changed' : 'Rule added', { description: `It names ${n === 1 ? 'one transaction' : `${n} transactions`}.` })
    open.value = false
  } catch (err) {
    problem.value = errorMessage(err)
  }
}

const KINDS: Array<{ value: PayeeNameRuleKind; label: string }> = [
  { value: 'same', label: 'Names that are one payee' },
  { value: 'regex', label: 'Regex' },
]
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ rule ? 'Change the rule' : 'Add a payee name rule' }}</DialogTitle>
        <DialogDescription>Custom rules apply in every ledger, in order, before AI tidying. The first that names a payee wins.</DialogDescription>
      </DialogHeader>

      <div class="grid gap-4">
        <div class="grid gap-1.5">
          <FieldLabel html-for="rule-kind">Kind</FieldLabel>
          <Select v-model="kind">
            <SelectTrigger id="rule-kind" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <template v-if="kind === 'same'">
          <div class="grid gap-1.5">
            <FieldLabel
              html-for="rule-patterns"
              hint="One per line. Each is matched against the payee as the bank sent it, never as AI tidying calls it, without regard to case or punctuation."
            >
              Payees that
            </FieldLabel>
            <div class="grid gap-2">
              <Select v-model="match">
                <SelectTrigger class="w-40" aria-label="How a payee fits"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="is">are</SelectItem>
                  <SelectItem value="starts">start with</SelectItem>
                  <SelectItem value="contains">contain</SelectItem>
                </SelectContent>
              </Select>
              <Textarea id="rule-patterns" v-model="patterns" rows="3" placeholder="Wal Mart&#10;Walmart Store" />
            </div>
          </div>
          <div class="grid gap-1.5">
            <FieldLabel html-for="rule-name" hint="They're one payee, called this. A name another rule gives makes them one payee with those too.">
              Call them
            </FieldLabel>
            <Input id="rule-name" v-model="name" placeholder="Walmart" />
          </div>
        </template>

        <template v-else>
          <div class="grid gap-1.5">
            <FieldLabel html-for="rule-regex" hint="Matched against the payee as the bank or file sent it, without regard to case.">Pattern</FieldLabel>
            <Input id="rule-regex" v-model="patterns" class="font-mono text-sm" placeholder="^SQ \*(.+)$" />
          </div>
          <div class="grid gap-1.5">
            <FieldLabel html-for="rule-becomes" hint="$1 is what the first group caught, $2 the second, $& all of the match.">It becomes</FieldLabel>
            <Input id="rule-becomes" v-model="name" class="font-mono text-sm" placeholder="$1" />
          </div>
        </template>

        <!-- What it would change, before saving. -->
        <div class="grid gap-1.5 rounded-md border bg-muted/30 p-3 text-sm">
          <p v-if="problem" class="text-destructive">{{ problem }}</p>
          <p v-else-if="!ready" class="text-muted-foreground">What it changes shows here.</p>
          <p v-else-if="previewing && !preview" class="flex items-center gap-2 text-muted-foreground"><Loader2 class="size-3.5 animate-spin" />Looking…</p>
          <template v-else-if="preview">
            <p class="font-medium">
              {{ preview.transactions ? `Changes the payee name on ${preview.transactions === 1 ? 'one transaction' : `${preview.transactions} transactions`}` : 'Changes no payee names' }}
            </p>
            <ul v-if="preview.changes.length" class="grid max-h-48 gap-1 overflow-y-auto">
              <li v-for="c in preview.changes" :key="`${c.from}→${c.to}`" class="flex min-w-0 items-center gap-2 text-xs">
                <span class="min-w-0 truncate text-muted-foreground" :title="c.payees.join(', ')">{{ c.from }}</span>
                <ArrowRight class="size-3 shrink-0 text-muted-foreground" />
                <span class="min-w-0 truncate font-medium">{{ c.to }}</span>
                <span class="ml-auto shrink-0 text-muted-foreground tabular">{{ c.transactions }}</span>
              </li>
            </ul>
          </template>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" @click="open = false">Cancel</Button>
        <Button type="button" :disabled="!ready || saving || !!problem" @click="save"><Loader2 v-if="saving" class="animate-spin" />{{ rule ? 'Save' : 'Add' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
