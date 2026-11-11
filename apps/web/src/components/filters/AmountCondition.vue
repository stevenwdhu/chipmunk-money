<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { parseMoney, type FilterSide } from '@chipmunk/shared'
import InfoTip from '@/components/InfoTip.vue'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type Amount = { min?: number; max?: number }

/** Your share between two amounts, either end left open. Typing applies after a pause, or on leaving the field. */
const props = defineProps<{ side: FilterSide; class?: string }>()
const model = defineModel<Amount>({ required: true })
const id = useId()

const text = (minor?: number) => (minor === undefined ? '' : String(minor / 100))
const parse = (s: string) => {
  const v = parseMoney(s)
  return v === null ? undefined : Math.abs(v)
}
const min = ref(text(model.value.min))
const max = ref(text(model.value.max))
// Changed from outside (Undo, say): the fields follow, unless they already say it. Only the amounts are
// watched, as the row hands down a new object each time it renders.
watch([() => model.value.min, () => model.value.max], ([a, b]) => {
  if (parse(min.value) !== a) min.value = text(a)
  if (parse(max.value) !== b) max.value = text(b)
})
const invalid = computed(() => {
  const [a, b] = [parse(min.value), parse(max.value)]
  return a !== undefined && b !== undefined && a > b
})

let timer: ReturnType<typeof setTimeout> | undefined
function apply() {
  clearTimeout(timer)
  const [a, b] = [parse(min.value), parse(max.value)]
  if (a === model.value.min && b === model.value.max) return
  model.value = { ...(a !== undefined && { min: a }), ...(b !== undefined && { max: b }) }
}
function applySoon() {
  clearTimeout(timer)
  timer = setTimeout(apply, 400)
}
onBeforeUnmount(() => clearTimeout(timer))
const tip = computed(() =>
  props.side === 'spending' ? 'Your share: what it cost, less the refunds and paybacks linked to it' : 'Your share: what came in, less what’s linked to bills',
)
</script>

<template>
  <div :class="cn('grid grid-cols-2 gap-2', props.class)">
    <label :for="`${id}-min`" class="text-xs text-muted-foreground">At least $</label>
    <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <label :for="`${id}-max`">At most $</label>
      <InfoTip :text="tip" />
    </span>
    <Input
      :id="`${id}-min`"
      v-model="min"
      inputmode="decimal"
      autocomplete="off"
      enterkeyhint="done"
      placeholder="Any"
      class="tabular"
      :aria-invalid="invalid"
      @update:model-value="applySoon"
      @blur="apply"
      @keydown.enter="apply"
    />
    <Input
      :id="`${id}-max`"
      v-model="max"
      inputmode="decimal"
      autocomplete="off"
      enterkeyhint="done"
      placeholder="Any"
      class="tabular"
      :aria-invalid="invalid"
      @update:model-value="applySoon"
      @blur="apply"
      @keydown.enter="apply"
    />
  </div>
</template>
