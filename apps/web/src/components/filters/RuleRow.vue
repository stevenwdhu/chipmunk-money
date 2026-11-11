<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { EyeOff, Pencil } from '@lucide/vue'
import { describeRule, FILTER_LIMITS, type Condition, type ConditionField, type FilterNames, type FilterSide } from '@chipmunk/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import AddMenu from './AddMenu.vue'
import ConditionRow from './ConditionRow.vue'
import { draftRow, emptyCondition, FIELDS, isComplete, type DraftRow, type DraftRule } from './conditions'

/**
 * A Filter out rule: its conditions (all of them must match), "+ and…" for another, and what it
 * filters out, live. Named, it's called that in place of its conditions. Taking its last condition
 * off takes the rule off.
 */
const props = defineProps<{
  rule: DraftRule
  side: FilterSide
  names: FilterNames
  /** What it filters out: "6 · $4,210" (none while it waits for a value). */
  figure?: string
  /** The row whose editor to open. */
  focusKey: number | null
}>()
const emit = defineEmits<{ change: [DraftRule]; remove: []; focus: [key: number | null] }>()

const words = computed(() => {
  const when = props.rule.when.map((r) => r.c).filter(isComplete)
  // Named as you type it.
  const label = naming.value ? clean(name.value) : props.rule.label
  return when.length ? describeRule({ when, label }, props.side, props.names) : 'Pick a value to filter out'
})
const used = computed(() => props.rule.when.map((r) => r.c.field))
const free = computed(() => FIELDS.filter((f) => !used.value.includes(f.value)))

// A row added with "+ and…" stays fresh (the rule applies without it) until it has a value.
function set(key: number, c: Condition) {
  const row = (r: DraftRow): DraftRow => ({ key, c, ...(r.fresh && !isComplete(c) && { fresh: true }) })
  emit('change', { ...props.rule, when: props.rule.when.map((r) => (r.key === key ? row(r) : r)) })
}
function remove(key: number) {
  if (props.rule.when.length === 1) return emit('remove')
  emit('change', { ...props.rule, when: props.rule.when.filter((r) => r.key !== key) })
}
function add(field: string) {
  const row = { ...draftRow(emptyCondition(field as ConditionField)), fresh: true }
  emit('change', { ...props.rule, when: [...props.rule.when, row] })
  emit('focus', row.key)
}

// Its name -------------------------------------------------------------------

/** As long as the rule schema takes it. */
const NAME_MAX = 40
const clean = (s: string) => s.trim().slice(0, NAME_MAX) || undefined
const naming = ref(false)
const name = ref(props.rule.label ?? '')
const nameInput = useTemplateRef<InstanceType<typeof Input>>('nameInput')
const nameButton = useTemplateRef<InstanceType<typeof Button>>('nameButton')
// Named elsewhere (Undo, say): the field follows, unless it already says it.
watch(
  () => props.rule.label,
  (label) => {
    if (clean(name.value) !== label) name.value = label ?? ''
  },
)

// The header says it as you type, and the rule takes it after a pause, or on leaving the field. Empty, it
// goes back to its conditions.
let timer: ReturnType<typeof setTimeout> | undefined
function applyName() {
  clearTimeout(timer)
  const label = clean(name.value)
  if (label === props.rule.label) return
  emit('change', { key: props.rule.key, when: props.rule.when, ...(label && { label }) })
}
function applyNameSoon() {
  clearTimeout(timer)
  timer = setTimeout(applyName, 400)
}
// The panel can close on Escape with the field still in focus.
onBeforeUnmount(applyName)

async function startNaming() {
  naming.value = true
  await nextTick()
  const el = nameInput.value?.$el as HTMLInputElement | undefined
  el?.focus()
  el?.select()
}
async function stopNaming(refocus: boolean) {
  applyName()
  name.value = clean(name.value) ?? ''
  naming.value = false
  if (!refocus) return
  await nextTick()
  const el = nameButton.value?.$el as HTMLElement | undefined
  el?.focus()
}

const canAnd = computed(() => props.rule.when.length < FILTER_LIMITS.ruleConditions && free.value.length > 0)
</script>

<template>
  <div class="grid gap-2 rounded-lg border p-2.5 transition-shadow data-flash:ring-3 data-flash:ring-ring/50">
    <div class="flex items-start justify-between gap-3 text-xs text-muted-foreground">
      <span class="flex min-w-0 items-start gap-1.5">
        <EyeOff class="mt-px size-3.5 shrink-0" />
        <span class="line-clamp-2">{{ words }}</span>
      </span>
      <span v-if="figure" class="shrink-0 tabular">{{ figure }}</span>
    </div>
    <template v-for="(row, i) in rule.when" :key="row.key">
      <span v-if="i" class="text-xs text-muted-foreground">and</span>
      <ConditionRow
        :condition="row.c"
        :side="side"
        :names="names"
        :taken="used.filter((f) => f !== row.c.field)"
        :auto-open="focusKey === row.key"
        @opened="emit('focus', null)"
        @change="(c) => set(row.key, c)"
        @remove="remove(row.key)"
      />
    </template>
    <!-- The name's field takes the place of its button, at the same height, so nothing moves when it goes. -->
    <div class="flex flex-wrap items-center gap-2">
      <AddMenu v-if="canAnd" label="and…" :items="free.map((f) => ({ value: f.value, label: f.label }))" class="-ml-2" @pick="add" />
      <Input
        v-if="naming"
        ref="nameInput"
        v-model="name"
        :maxlength="NAME_MAX"
        placeholder="One-offs"
        autocomplete="off"
        enterkeyhint="done"
        :aria-label="`Name for ${words}`"
        class="h-11 min-w-40 flex-1 md:h-8"
        @update:model-value="applyNameSoon"
        @blur="stopNaming(false)"
        @keydown.enter.prevent="stopNaming(true)"
      />
      <Button
        v-else
        ref="nameButton"
        variant="ghost"
        size="sm"
        class="h-11 text-muted-foreground first:-ml-2 md:h-8"
        :aria-label="rule.label ? `Rename ${words}` : `Name the rule ${words}`"
        @click="startNaming"
      >
        <Pencil />{{ rule.label ? 'Rename' : 'Name this rule' }}
      </Button>
    </div>
  </div>
</template>
