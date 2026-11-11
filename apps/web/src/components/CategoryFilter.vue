<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronsUpDown } from '@lucide/vue'
import { UNGROUPED_COLOR } from '@chipmunk/shared'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCategories } from '@/composables/queries'
import { cn } from '@/lib/utils'

const ALL = 'All categories'

/**
 * Filtering by categories: any number of them, uncategorized among them. Picking one adds it or takes
 * it off, and the list stays open for more. Clear, above the list, takes them all off.
 */
const props = withDefaults(
  defineProps<{
    id?: string
    disabled?: boolean
    class?: string
    /** The button's words with none picked: all of them count, unless it asks for some (a filter's condition). */
    placeholder?: string
  }>(),
  { placeholder: ALL },
)
const model = defineModel<Array<number | 'none'>>({ default: () => [] })
const open = ref(false)
const { grouped, byId, colorOf } = useCategories()

const has = (c: number | 'none') => model.value.includes(c)
function toggle(c: number | 'none') {
  model.value = has(c) ? model.value.filter((x) => x !== c) : [...model.value, c]
}
const nameOf = (c: number | 'none') => (c === 'none' ? 'Uncategorized' : (byId.value.get(c)?.name ?? 'A category'))
const first = computed(() => model.value[0])
const label = computed(() => {
  if (first.value === undefined) return props.placeholder
  return model.value.length === 1 ? nameOf(first.value) : `${nameOf(first.value)} +${model.value.length - 1}`
})
const title = computed(() => model.value.map(nameOf).join(', ') || undefined)
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        :id="id"
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        :disabled="disabled"
        :aria-label="model.length ? `Categories: ${title}` : placeholder === ALL ? 'Categories: all' : 'Categories: none picked'"
        :title="title"
        :class="cn('w-full justify-between font-normal', !model.length && 'text-muted-foreground', props.class)"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span
            v-if="first !== undefined"
            class="size-2 shrink-0 rounded-full"
            :style="first === 'none' ? { border: '1px dashed currentColor' } : { background: colorOf(byId.get(first)) }"
          />
          <span class="truncate">{{ label }}</span>
        </span>
        <ChevronsUpDown class="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-(--reka-popover-trigger-width) min-w-64 p-0" align="start">
      <Command>
        <CommandInput placeholder="Search categories…" />
        <!-- What's picked, above the list, so it stays in sight while the list scrolls. -->
        <div v-if="model.length" class="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3 text-xs text-muted-foreground">
          <span class="tabular">{{ model.length }} selected</span>
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="((model = []), (open = false))">Clear</Button>
        </div>
        <CommandList class="max-h-72">
          <CommandEmpty>No category matches.</CommandEmpty>
          <CommandGroup>
            <CommandItem value="Uncategorized" @select="toggle('none')">
              <span class="size-2 rounded-full border border-dashed border-muted-foreground" />
              Uncategorized
              <Check v-if="has('none')" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
          <CommandGroup v-for="g in grouped" :key="g.group?.id ?? 'none'" :heading="g.group?.name ?? 'Other'">
            <template #heading>
              <span class="flex items-center gap-2">
                <span class="size-2 shrink-0 rounded-full" :style="{ background: g.group?.color ?? UNGROUPED_COLOR }" />{{ g.group?.name ?? 'Other' }}
              </span>
            </template>
            <CommandItem v-for="c in g.categories" :key="c.id" :value="`${c.name} ${g.group?.name ?? ''}`" class="pl-6" @select="toggle(c.id)">
              {{ c.name }}
              <!-- Searched too: a group's name finds its categories. -->
              <span class="sr-only">{{ g.group?.name }}</span>
              <Check v-if="has(c.id)" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
