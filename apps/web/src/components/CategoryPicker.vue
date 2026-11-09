<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronsUpDown, Sparkles } from '@lucide/vue'
import { UNGROUPED_COLOR } from '@st/shared'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCategories, type CategoryScope } from '@/composables/queries'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    id?: string
    suggestedId?: number | null
    allowNone?: boolean
    placeholder?: string
    size?: 'default' | 'sm'
    /** "badge" renders the current category as a compact pill (for tables). */
    variant?: 'field' | 'badge'
    needsReview?: boolean
    /** Categories not to offer (say, the one being merged away). */
    exclude?: number[]
    /** Which list to pick from: this ledger's (default) or the shared one. */
    scope?: CategoryScope
    /** Shown but not changeable (a refund's, which is always its purchase's). */
    disabled?: boolean
    class?: string
  }>(),
  { allowNone: true, placeholder: 'Pick a category', size: 'default', variant: 'field' },
)
const model = defineModel<number | null>({ default: null })
const open = ref(false)
const { grouped: allGrouped, byId, colorOf } = useCategories(props.scope)
const grouped = computed(() =>
  props.exclude?.length
    ? allGrouped.value.map((g) => ({ ...g, categories: g.categories.filter((c) => !props.exclude!.includes(c.id)) })).filter((g) => g.categories.length)
    : allGrouped.value,
)
const selected = computed(() => (model.value ? byId.value.get(model.value) : undefined))

function choose(id: number | null) {
  model.value = id
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger v-if="variant === 'badge'" as-child>
      <button
        :id="id"
        type="button"
        :aria-label="`Category: ${selected?.name ?? 'Uncategorized'}. Change category`"
        :class="
          cn(
            'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors hover:bg-muted',
            needsReview ? 'border-dashed border-ai bg-ai-soft hover:bg-ai-soft/70' : 'border-border',
            !selected && 'text-muted-foreground',
            props.class,
          )
        "
        @click.stop
      >
        <span
          class="size-2 shrink-0 rounded-full"
          :style="{ background: colorOf(selected) ?? 'transparent', border: selected ? undefined : '1px dashed currentColor' }"
        />
        <span class="truncate">{{ selected?.name ?? 'Uncategorized' }}</span>
        <Sparkles v-if="needsReview" class="size-3 shrink-0 text-ai" />
      </button>
    </PopoverTrigger>
    <PopoverTrigger v-else as-child>
      <Button
        :id="id"
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        :disabled="disabled"
        :size="size === 'sm' ? 'sm' : 'default'"
        :class="cn('w-full justify-between font-normal', !selected && 'text-muted-foreground', props.class)"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span v-if="selected" class="size-2 shrink-0 rounded-full" :style="{ background: colorOf(selected) }" />
          <span class="truncate">{{ selected?.name ?? placeholder }}</span>
          <Sparkles v-if="selected && suggestedId === selected.id" class="size-3.5 shrink-0 text-ai" />
        </span>
        <ChevronsUpDown class="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-(--reka-popover-trigger-width) min-w-64 p-0" align="start">
      <Command>
        <CommandInput placeholder="Search categories…" />
        <CommandList class="max-h-72">
          <CommandEmpty>No category matches.</CommandEmpty>
          <CommandGroup v-if="allowNone">
            <CommandItem value="__none" @select="choose(null)">
              <span class="size-2 rounded-full border border-dashed border-muted-foreground" />
              Uncategorized
              <Check v-if="model === null" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
          <!-- Colours are the groups': on each group's heading, its categories lined up under its name. -->
          <CommandGroup v-for="g in grouped" :key="g.group?.id ?? 'none'" :heading="g.group?.name ?? 'Other'">
            <template #heading>
              <span class="flex items-center gap-2">
                <span class="size-2 shrink-0 rounded-full" :style="{ background: g.group?.color ?? UNGROUPED_COLOR }" />{{ g.group?.name ?? 'Other' }}
              </span>
            </template>
            <CommandItem v-for="c in g.categories" :key="c.id" :value="`${c.name} ${g.group?.name ?? ''}`" class="pl-6" @select="choose(c.id)">
              {{ c.name }}
              <!-- Searched too: a group's name finds its categories. -->
              <span class="sr-only">{{ g.group?.name }}</span>
              <Sparkles v-if="suggestedId === c.id" class="size-3.5 text-ai" />
              <Check v-if="model === c.id" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
