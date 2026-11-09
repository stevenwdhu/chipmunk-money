<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { recurringLabel } from '@st/shared'
import InfoTip from '@/components/InfoTip.vue'
import { useRecurring } from '@/composables/queries'
import { cn } from '@/lib/utils'
import MultiPicker, { type PickerOption } from './MultiPicker.vue'

type Value = 'any' | 'none' | number[]
type Mode = 'any' | 'none' | 'items'

/**
 * Recurring, not recurring, or these items (active and ended ones). A new row has none of the three
 * on until you choose, and "These items" waits for at least one.
 */
defineProps<{ class?: string }>()
const model = defineModel<Value>({ required: true })

const modeOf = (v: Value): Mode | null => (Array.isArray(v) ? (v.length ? 'items' : null) : v)
const mode = ref<Mode | null>(modeOf(model.value))
watch(model, (v) => {
  // An empty list is "These items" with none picked yet, once you chose it.
  if (modeOf(v) !== null) mode.value = modeOf(v)
})

function choose(m: Mode) {
  mode.value = m
  model.value = m === 'items' ? (Array.isArray(model.value) ? model.value : []) : m
}

const recurring = useRecurring()
const options = computed<PickerOption[]>(() =>
  (recurring.data.value ?? [])
    .filter((i) => i.status === 'active' || i.status === 'ended')
    .sort((a, b) => (a.status === b.status ? recurringLabel(a).localeCompare(recurringLabel(b)) : a.status === 'active' ? -1 : 1))
    .map((i) => ({ value: i.id, label: recurringLabel(i), group: i.status === 'active' ? 'Active' : 'Ended' })),
)
const items = computed({
  get: () => (Array.isArray(model.value) ? model.value : []),
  set: (ids: number[]) => (model.value = ids),
})
const choices: Array<{ value: Mode; label: string }> = [
  { value: 'any', label: 'Recurring' },
  { value: 'none', label: 'Not recurring' },
  { value: 'items', label: 'These items' },
]
</script>

<template>
  <div :class="cn('grid gap-2', $props.class)">
    <div class="flex items-center gap-2">
      <div class="flex min-w-0 flex-1 rounded-md bg-muted p-0.5 text-xs" role="radiogroup" aria-label="Recurring">
        <button
          v-for="c in choices"
          :key="c.value"
          type="button"
          role="radio"
          :aria-checked="mode === c.value"
          :class="
            cn(
              'h-8 min-w-0 flex-1 truncate rounded px-1.5',
              mode === c.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )
          "
          @click="choose(c.value)"
        >
          {{ c.label }}
        </button>
      </div>
      <InfoTip text="Payments linked to one of your recurring items. Suggestions and dismissed items don’t count" />
    </div>
    <MultiPicker
      v-if="mode === 'items'"
      v-model="items"
      :options="options"
      placeholder="Pick items"
      gone="Deleted recurring item"
      label="Recurring items"
      search="Search recurring items…"
      empty="No recurring item matches."
      none="No active or ended recurring items yet."
    />
  </div>
</template>
