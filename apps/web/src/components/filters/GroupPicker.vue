<script setup lang="ts">
import { computed } from 'vue'
import { useCategories } from '@/composables/queries'
import MultiPicker, { type PickerOption } from './MultiPicker.vue'

/** Any number of category groups, in their order, then No group (uncategorized, or a category without one). */
defineProps<{ class?: string }>()
const model = defineModel<Array<number | 'none'>>({ default: () => [] })
const { groups } = useCategories()
const options = computed<PickerOption<number | 'none'>[]>(() => [
  ...groups.value.map((g) => ({ value: g.id, label: g.name, color: g.color })),
  { value: 'none', label: 'No group', color: null },
])
</script>

<template>
  <MultiPicker
    v-model="model"
    :options="options"
    placeholder="Pick groups"
    gone="Deleted group"
    label="Groups"
    search="Search groups…"
    empty="No group matches."
    none="No groups yet."
    :class="$props.class"
  />
</template>
