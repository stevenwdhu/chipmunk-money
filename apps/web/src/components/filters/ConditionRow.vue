<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { X } from '@lucide/vue'
import type { Condition, ConditionField, FilterNames, FilterSide, TextScope } from '@st/shared'
import CategoryFilter from '@/components/CategoryFilter.vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useIsDesktop } from '@/composables/useBreakpoint'
import AccountPicker from './AccountPicker.vue'
import AmountCondition from './AmountCondition.vue'
import { emptyCondition, FIELDS } from './conditions'
import GroupPicker from './GroupPicker.vue'
import LabelPicker from './LabelPicker.vue'
import PayeePicker from './PayeePicker.vue'
import RecurringPicker from './RecurringPicker.vue'
import TagPicker from './TagPicker.vue'
import TextWords from './TextWords.vue'
import WordsScope from './WordsScope.vue'

/**
 * One condition: what it's on, its value (for words, where to look for them too), and ×. A row just
 * added, or one whose field you just changed, opens its value's editor.
 */
const props = defineProps<{
  condition: Condition
  side: FilterSide
  names: FilterNames
  /** Fields it can't change to, as another row has them. */
  taken: ConditionField[]
  /** Open its editor once it's on screen. */
  autoOpen?: boolean
}>()
const emit = defineEmits<{ change: [Condition]; remove: []; opened: [] }>()

const isDesktop = useIsDesktop()
const editor = useTemplateRef<HTMLElement>('editor')
const label = computed(() => FIELDS.find((f) => f.value === props.condition.field)?.label ?? 'condition')
// The amount's two fields and the recurring choice take a line of their own, under the field.
const wide = computed(() => props.condition.field === 'amount' || props.condition.field === 'recurring')

/** Opens a picker, or puts the cursor in a field (not on phones, where the keyboard would cover the drawer). */
async function openEditor() {
  await nextTick()
  requestAnimationFrame(() => {
    const el = editor.value?.querySelector<HTMLElement>('[role="combobox"], input')
    if (el instanceof HTMLInputElement) {
      if (isDesktop.value) el.focus()
    } else el?.click()
  })
}
watch(
  () => props.autoOpen,
  (open) => {
    if (!open) return
    openEditor()
    emit('opened')
  },
  { immediate: true },
)

// New words are looked for where the old ones were (only in the name, payee or notes, say).
function setWords(words: string[]) {
  const c = props.condition
  emit('change', c.field === 'text' && c.in ? { field: 'text', words, in: c.in } : { field: 'text', words })
}
function setScope(scope?: TextScope[]) {
  const c = props.condition
  if (c.field === 'text') emit('change', { field: 'text', words: c.words, ...(scope && { in: scope }) })
}

// A new field opens its editor once the field list has closed, so it doesn't take the focus back.
let reopen = false
function setField(field: ConditionField) {
  if (field === props.condition.field) return
  reopen = true
  emit('change', emptyCondition(field))
}
function fieldClosed(e: Event) {
  if (!reopen) return
  reopen = false
  e.preventDefault()
  openEditor()
}
</script>

<template>
  <div class="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-start gap-2">
    <Select :model-value="condition.field" @update:model-value="(f) => setField(f as ConditionField)">
      <SelectTrigger class="w-full" aria-label="Field"><SelectValue /></SelectTrigger>
      <SelectContent @close-auto-focus="fieldClosed">
        <SelectItem v-for="f in FIELDS" :key="f.value" :value="f.value" :disabled="taken.includes(f.value)">{{ f.label }}</SelectItem>
      </SelectContent>
    </Select>
    <div ref="editor" :class="wide ? 'col-span-3 row-start-2' : 'min-w-0'">
      <CategoryFilter
        v-if="condition.field === 'category'"
        placeholder="Pick categories"
        :model-value="condition.ids"
        @update:model-value="(ids) => emit('change', { field: 'category', ids })"
      />
      <GroupPicker
        v-else-if="condition.field === 'group'"
        :model-value="condition.ids"
        @update:model-value="(ids) => emit('change', { field: 'group', ids })"
      />
      <LabelPicker
        v-else-if="condition.field === 'label'"
        :model-value="condition.ids"
        @update:model-value="(ids) => emit('change', { field: 'label', ids })"
      />
      <TagPicker v-else-if="condition.field === 'tag'" :model-value="condition.ids" @update:model-value="(ids) => emit('change', { field: 'tag', ids })" />
      <PayeePicker
        v-else-if="condition.field === 'payee'"
        :names="names"
        :model-value="condition.keys"
        @update:model-value="(keys) => emit('change', { field: 'payee', keys })"
      />
      <TextWords
        v-else-if="condition.field === 'text'"
        :model-value="condition.words"
        @update:model-value="setWords"
      />
      <AmountCondition
        v-else-if="condition.field === 'amount'"
        :side="side"
        :model-value="{ min: condition.min, max: condition.max }"
        @update:model-value="(v) => emit('change', { field: 'amount', ...v })"
      />
      <AccountPicker
        v-else-if="condition.field === 'account'"
        :model-value="condition.ids"
        @update:model-value="(ids) => emit('change', { field: 'account', ids })"
      />
      <RecurringPicker v-else :model-value="condition.ids" @update:model-value="(ids) => emit('change', { field: 'recurring', ids })" />
    </div>
    <!-- 44px to tap on phones: it reaches past the 36px row above and below. -->
    <Button
      variant="ghost"
      size="icon"
      class="col-start-3 row-start-1 -my-1 size-11 text-muted-foreground md:my-0 md:size-9"
      :aria-label="`Remove ${label}`"
      @click="emit('remove')"
    >
      <X />
    </Button>
    <WordsScope v-if="condition.field === 'text'" :model-value="condition.in" class="col-span-3 row-start-2" @update:model-value="setScope" />
  </div>
</template>
