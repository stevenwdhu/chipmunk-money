<script setup lang="ts">
import { computed } from 'vue'
import { useCategories } from '@/composables/queries'
import MultiPicker, { type PickerOption } from './MultiPicker.vue'

/** Any number of category labels, in their order, then No label (uncategorized, or a category without one). */
defineProps<{ class?: string }>()
const model = defineModel<Array<number | 'none'>>({ default: () => [] })
const { labels } = useCategories()
const options = computed<PickerOption<number | 'none'>[]>(() => [
  ...labels.value.map((l) => ({ value: l.id, label: l.name, color: l.color })),
  { value: 'none', label: 'No label', color: null },
])
</script>

<template>
  <MultiPicker
    v-model="model"
    :options="options"
    placeholder="Pick labels"
    gone="Deleted label"
    label="Labels"
    search="Search labels…"
    empty="No label matches."
    none="No labels yet."
    :class="$props.class"
  />
</template>
