<script setup lang="ts">
import { computed } from 'vue'
import { useAccounts, useGroupedAccounts } from '@/composables/queries'
import MultiPicker, { type PickerOption } from './MultiPicker.vue'

/** Any number of accounts, under their institutions, with archived ones last. */
defineProps<{ class?: string }>()
const model = defineModel<number[]>({ default: () => [] })
const { data, active } = useAccounts()
const groups = useGroupedAccounts(active)
const options = computed<PickerOption[]>(() => [
  ...groups.value.flatMap((g) => g.accounts.map((a) => ({ value: a.id, label: a.name, group: groups.value.length > 1 ? g.name : undefined }))),
  ...(data.value ?? []).filter((a) => a.archived).map((a) => ({ value: a.id, label: a.name, group: 'Archived' })),
])
</script>

<template>
  <MultiPicker
    v-model="model"
    :options="options"
    placeholder="Pick accounts"
    gone="Deleted account"
    label="Accounts"
    search="Search accounts…"
    empty="No account matches."
    none="No accounts yet."
    :class="$props.class"
  />
</template>
