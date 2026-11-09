<script setup lang="ts">
import { computed } from 'vue'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAccounts, useGroupedAccounts } from '@/composables/queries'

const props = withDefaults(
  defineProps<{ id?: string; exclude?: number | null; placeholder?: string; allowAll?: boolean; allLabel?: string; class?: string }>(),
  { placeholder: 'Pick an account', allLabel: 'All accounts' },
)
const model = defineModel<number | null>({ default: null })
const { active } = useAccounts()
const options = computed(() => active.value.filter((a) => a.id !== props.exclude))
const groups = useGroupedAccounts(options)
const value = computed({
  get: () => (model.value === null ? (props.allowAll ? 'all' : undefined) : String(model.value)),
  set: (v) => (model.value = v && v !== 'all' ? Number(v) : null),
})
</script>

<template>
  <Select v-model="value">
    <SelectTrigger :id="id" :class="['w-full min-w-0', props.class]">
      <SelectValue :placeholder="placeholder" class="block! min-w-0 truncate" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-if="allowAll" value="all">{{ allLabel }}</SelectItem>
      <SelectGroup v-for="g in groups" :key="g.id">
        <SelectLabel v-if="groups.length > 1">{{ g.name }}</SelectLabel>
        <SelectItem v-for="a in g.accounts" :key="a.id" :value="String(a.id)">{{ a.name }}</SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>
