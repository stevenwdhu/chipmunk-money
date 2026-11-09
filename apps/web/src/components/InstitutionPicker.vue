<script setup lang="ts">
import { computed, ref } from 'vue'
import { ListboxItem } from 'reka-ui'
import { Check, ChevronsUpDown, Plus } from '@lucide/vue'
import CommandSearch from '@/components/CommandSearch.vue'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useInstitutions } from '@/composables/queries'
import { cn } from '@/lib/utils'

/** An institution you have (`id`), or a new one (`id: null`) that's added when the account is saved. */
export interface InstitutionChoice {
  id: number | null
  name: string
}

const props = defineProps<{ id?: string; class?: string }>()
const model = defineModel<InstitutionChoice | null>({ default: null })
const open = ref(false)
const { data: institutions } = useInstitutions()

const norm = (s: string) => s.trim().toLowerCase()
const list = computed(() => institutions.value ?? [])
/** A new name you typed, until the account is saved. */
const pending = computed(() => (model.value && model.value.id === null ? model.value : null))

function choose(choice: InstitutionChoice) {
  model.value = choice
  open.value = false
}
/** Typing an existing name picks that one instead of adding a twin. */
function add(search: string) {
  const same = list.value.find((i) => norm(i.name) === norm(search))
  choose(same ? { id: same.id, name: same.name } : { id: null, name: search.trim().replace(/\s+/g, ' ') })
}
const canAdd = (search: string) =>
  !!search.trim() && !list.value.some((i) => norm(i.name) === norm(search)) && norm(pending.value?.name ?? '') !== norm(search)
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        :id="id"
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        :class="cn('w-full justify-between font-normal', !model && 'text-muted-foreground', props.class)"
      >
        <span class="truncate">{{ model?.name ?? 'Choose or add one' }}</span>
        <span class="flex shrink-0 items-center gap-1.5">
          <span v-if="pending" class="text-xs text-muted-foreground">New</span>
          <ChevronsUpDown class="size-4 opacity-50" />
        </span>
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-(--reka-popover-trigger-width) min-w-56 p-0" align="start">
      <Command>
        <CommandInput placeholder="Search or add…" />
        <CommandList class="max-h-64">
          <CommandGroup v-if="list.length || pending">
            <CommandItem v-if="pending" :value="`new:${pending.name}`" @select="choose(pending)">
              {{ pending.name }}
              <span class="text-xs text-muted-foreground">new</span>
              <Check class="ml-auto size-4" />
            </CommandItem>
            <CommandItem v-for="i in list" :key="i.id" :value="i.id" @select="choose({ id: i.id, name: i.name })">
              <span class="truncate">{{ i.name }}</span>
              <Check v-if="model?.id === i.id" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
          <!-- Outside the Command's filtering, which only knows each option's text from when it appeared. -->
          <CommandSearch v-slot="{ search }">
            <div v-if="canAdd(search)" class="p-1" :class="list.length > 0 && 'border-t'">
              <ListboxItem
                value="__add"
                class="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                @select="add(search)"
              >
                <Plus class="size-4 shrink-0 text-muted-foreground" />
                <span class="truncate">Add “{{ search.trim() }}”</span>
              </ListboxItem>
            </div>
            <p v-else-if="!search.trim() && !list.length && !pending" class="px-3 py-4 text-center text-sm text-muted-foreground">
              Type the name of your bank, or e.g. “Wallet” for cash.
            </p>
          </CommandSearch>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
