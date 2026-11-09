<script setup lang="ts">
import { computed } from 'vue'
import { useTags } from '@/composables/queries'
import MultiPicker, { type PickerOption } from './MultiPicker.vue'

/** Any number of tags, most used first. */
defineProps<{ class?: string }>()
const model = defineModel<number[]>({ default: () => [] })
const { data } = useTags()
const options = computed<PickerOption[]>(() =>
  [...(data.value ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map((t) => ({ value: t.id, label: `#${t.name}`, color: t.color })),
)
</script>

<template>
  <MultiPicker
    v-model="model"
    :options="options"
    placeholder="Pick tags"
    gone="Deleted tag"
    label="Tags"
    search="Search tags…"
    empty="No tag matches."
    none="No tags yet. Add them to transactions first."
    :class="$props.class"
  />
</template>
