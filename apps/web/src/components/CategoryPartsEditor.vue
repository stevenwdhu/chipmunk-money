<script setup lang="ts">
import { computed } from 'vue'
import { Plus, X } from '@lucide/vue'
import CategoryPicker from '@/components/CategoryPicker.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { checkLines, type PartLine } from '@/lib/parts'

/**
 * The transaction form's Split into categories: a line per part with a category, an amount and a
 * note. The last line gets the rest of the amount as you type. At least two lines. Undo split puts it
 * back to one category.
 */
const props = defineProps<{ totalMinor: number | null }>()
const lines = defineModel<PartLine[]>({ required: true })
const emit = defineEmits<{ undo: [] }>()

const check = computed(() => checkLines(lines.value, props.totalMinor))
const last = computed(() => lines.value.length - 1)

function addLine() {
  lines.value.splice(last.value, 0, { categoryId: null, amountText: '', note: '' })
}
function removeLine(i: number) {
  lines.value.splice(i, 1)
}
</script>

<template>
  <div class="grid gap-2">
    <div v-for="(l, i) in lines" :key="i" class="grid gap-1.5 rounded-md border p-2">
      <div class="flex items-center gap-2">
        <CategoryPicker :id="i === 0 ? 'tx-category' : undefined" v-model="l.categoryId" size="sm" class="min-w-0 flex-1" />
        <div class="relative w-28 shrink-0">
          <span class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          <Input
            v-if="i < last"
            v-model="l.amountText"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0.00"
            class="h-8 pl-6 text-right tabular"
            :aria-label="`Amount of line ${i + 1}`"
          />
          <Input
            v-else
            :model-value="check.amounts[i]! > 0 ? (check.amounts[i]! / 100).toFixed(2) : ''"
            readonly
            tabindex="-1"
            placeholder="The rest"
            class="h-8 bg-muted/40 pl-6 text-right text-muted-foreground tabular"
            aria-label="The rest, on the last line"
          />
        </div>
        <Button v-if="lines.length > 2" type="button" variant="ghost" size="icon-sm" class="shrink-0" :aria-label="`Take out line ${i + 1}`" @click="removeLine(i)">
          <X />
        </Button>
      </div>
      <Input v-model="l.note" autocomplete="off" placeholder="Note (optional)" class="h-8 text-sm" :aria-label="`Note for line ${i + 1}`" />
    </div>
    <p v-if="check.problem" class="text-xs text-destructive">{{ check.problem }}</p>
    <p v-else class="text-xs text-muted-foreground">The last line gets the rest. Each part counts in its own category in reports.</p>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Button v-if="lines.length < 50" type="button" variant="ghost" size="sm" class="-ml-2 h-8" @click="addLine"><Plus />Add a line</Button>
      <Button type="button" variant="ghost" size="sm" class="h-8 text-muted-foreground" @click="emit('undo')">Undo split</Button>
    </div>
  </div>
</template>
