<script setup lang="ts" generic="T extends number | 'none'">
import { computed, ref } from 'vue'
import { Check, ChevronsUpDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** `none` stands for no value at all, like No label. */
export type PickerOption<V extends number | 'none' = number> = { value: V; label: string; group?: string; color?: string | null }

/**
 * Picking any number of things from a searchable list, like CategoryFilter: picking one adds it or
 * takes it off, and the list stays open for more. Clear, above the list, takes them all off.
 */
const props = defineProps<{
  options: PickerOption<T>[]
  /** The button's words with nothing picked. */
  placeholder: string
  /** What a picked one that isn't an option any more is called. */
  gone: string
  /** The button's name for screen readers, like "Tags". */
  label: string
  search: string
  /** Shown when the search matches none. */
  empty: string
  /** Shown when there's nothing to pick. */
  none: string
  class?: string
}>()
const model = defineModel<T[]>({ default: () => [] })
const open = ref(false)

const byValue = computed(() => new Map(props.options.map((o) => [o.value, o])))
const groups = computed(() => {
  const out = new Map<string, PickerOption<T>[]>()
  for (const o of props.options) out.set(o.group ?? '', [...(out.get(o.group ?? '') ?? []), o])
  return [...out].map(([name, options]) => ({ name, options }))
})
const has = (v: T) => model.value.includes(v)
function toggle(v: T) {
  model.value = has(v) ? model.value.filter((x) => x !== v) : [...model.value, v]
}
const nameOf = (v: T) => byValue.value.get(v)?.label ?? props.gone
const first = computed(() => (model.value.length ? byValue.value.get(model.value[0]!) : undefined))
const text = computed(() => {
  if (!model.value.length) return props.placeholder
  const name = nameOf(model.value[0]!)
  return model.value.length === 1 ? name : `${name} +${model.value.length - 1}`
})
const title = computed(() => model.value.map(nameOf).join(', ') || undefined)
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        :aria-label="model.length ? `${label}: ${title}` : `${label}: none picked`"
        :title="title"
        :class="cn('w-full justify-between font-normal', !model.length && 'text-muted-foreground', props.class)"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span v-if="first?.color" class="size-2 shrink-0 rounded-full" :style="{ background: first.color }" />
          <span class="truncate">{{ text }}</span>
        </span>
        <ChevronsUpDown class="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-(--reka-popover-trigger-width) min-w-64 p-0" align="start">
      <Command>
        <CommandInput :placeholder="search" />
        <div v-if="model.length" class="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3 text-xs text-muted-foreground">
          <span class="tabular">{{ model.length }} selected</span>
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="((model = []), (open = false))">Clear</Button>
        </div>
        <CommandList class="max-h-72">
          <CommandEmpty v-if="options.length">{{ empty }}</CommandEmpty>
          <p v-if="!options.length" class="px-3 py-6 text-center text-sm text-muted-foreground">{{ none }}</p>
          <CommandGroup v-for="g in groups" :key="g.name" :heading="g.name || undefined">
            <CommandItem v-for="o in g.options" :key="o.value" :value="o.value" @select="toggle(o.value)">
              <span v-if="o.color !== undefined" class="size-2 shrink-0 rounded-full" :style="o.color ? { background: o.color } : { border: '1px solid currentColor' }" />
              <span class="min-w-0 truncate">{{ o.label }}</span>
              <span v-if="g.name" class="sr-only">{{ g.name }}</span>
              <Check v-if="has(o.value)" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
