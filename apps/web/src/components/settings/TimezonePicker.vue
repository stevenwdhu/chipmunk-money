<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronsUpDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const props = defineProps<{ systemZone: string; id?: string }>()
/** null = follow the system time zone */
const model = defineModel<string | null>({ default: null })
const open = ref(false)

const CANADA = [
  'America/St_Johns', 'America/Halifax', 'America/Moncton', 'America/Toronto', 'America/Winnipeg',
  'America/Regina', 'America/Edmonton', 'America/Vancouver', 'America/Whitehorse',
]
const all = computed(() => {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : CANADA
  return zones.filter((z) => !CANADA.includes(z))
})
const label = computed(() => (model.value ? model.value.replace(/_/g, ' ') : `System default (${props.systemZone.replace(/_/g, ' ')})`))
function choose(z: string | null) {
  model.value = z
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button :id="id" variant="outline" role="combobox" :aria-expanded="open" class="w-full justify-between font-normal sm:w-80">
        <span class="truncate">{{ label }}</span>
        <ChevronsUpDown class="size-4 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-80 p-0" align="start">
      <Command>
        <CommandInput placeholder="Search time zones…" />
        <CommandList class="max-h-72">
          <CommandEmpty>No time zone matches.</CommandEmpty>
          <CommandGroup>
            <CommandItem value="system default" @select="choose(null)">
              System default ({{ systemZone }})
              <Check v-if="model === null" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Canada">
            <CommandItem v-for="z in CANADA" :key="z" :value="z" @select="choose(z)">
              {{ z.replace(/_/g, ' ') }}<Check v-if="model === z" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Everywhere">
            <CommandItem v-for="z in all" :key="z" :value="z" @select="choose(z)">
              {{ z.replace(/_/g, ' ') }}<Check v-if="model === z" class="ml-auto size-4" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
