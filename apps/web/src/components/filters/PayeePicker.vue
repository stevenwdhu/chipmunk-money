<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { refDebounced } from '@vueuse/core'
import { Check, ChevronsUpDown, Loader2, Search } from '@lucide/vue'
import type { FilterNames } from '@st/shared'
import { ListboxContent, ListboxFilter, ListboxGroup, ListboxGroupLabel, ListboxItem, ListboxRoot } from 'reka-ui'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePayeeSearch } from '@/composables/queries'
import { cn } from '@/lib/utils'

/**
 * Any number of payees, found by name (as your payee name rules call them, or as sent), most used
 * first. The ones picked stay at the top of the list, to take off again.
 */
const props = defineProps<{ names: FilterNames; class?: string }>()
const model = defineModel<string[]>({ default: () => [] })
const open = ref(false)
const search = ref('')
const q = refDebounced(search, 250)
const results = usePayeeSearch(() => ({ q: q.value.trim() || undefined, limit: 30 }), { enabled: open })

// Names from the results, for one just picked: the filter's names catch up once it's in the filter.
const seen = reactive(new Map<string, string>())
watch(
  () => results.data.value,
  (rows) => rows?.forEach((r) => seen.set(r.payeeKey, r.payee)),
  { immediate: true },
)
const nameOf = (key: string) => props.names.payee?.(key) ?? seen.get(key) ?? key
const others = computed(() => (results.data.value ?? []).filter((r) => !model.value.includes(r.payeeKey)))

function toggle(key: string) {
  model.value = model.value.includes(key) ? model.value.filter((k) => k !== key) : [...model.value, key]
}
const text = computed(() => {
  const [first] = model.value
  if (first === undefined) return 'Pick payees'
  return model.value.length === 1 ? nameOf(first) : `${nameOf(first)} +${model.value.length - 1}`
})
const title = computed(() => model.value.map(nameOf).join(', ') || undefined)
const itemClass =
  'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground'
</script>

<template>
  <Popover v-model:open="open" @update:open="(v) => v && (search = '')">
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        :aria-label="model.length ? `Payees: ${title}` : 'Payees: none picked'"
        :title="title"
        :class="cn('w-full justify-between font-normal', !model.length && 'text-muted-foreground', props.class)"
      >
        <span class="truncate">{{ text }}</span>
        <ChevronsUpDown class="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-(--reka-popover-trigger-width) min-w-64 p-0" align="start">
      <ListboxRoot class="flex flex-col" highlight-on-hover>
        <div class="flex h-9 items-center gap-2 border-b px-3">
          <Search class="size-4 shrink-0 opacity-50" />
          <ListboxFilter
            v-model="search"
            auto-focus
            placeholder="Search payees…"
            class="flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground"
          />
          <Loader2 v-if="results.isFetching.value" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        </div>
        <div v-if="model.length" class="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3 text-xs text-muted-foreground">
          <span class="tabular">{{ model.length }} selected</span>
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="((model = []), (open = false))">Clear</Button>
        </div>
        <ListboxContent class="max-h-72 overflow-y-auto p-1">
          <ListboxGroup v-if="model.length">
            <ListboxGroupLabel class="px-2 py-1.5 text-xs font-medium text-muted-foreground">Picked</ListboxGroupLabel>
            <ListboxItem v-for="k in model" :key="k" :value="k" :class="itemClass" @select="toggle(k)">
              <span class="min-w-0 truncate">{{ nameOf(k) }}</span>
              <Check class="ml-auto size-4 shrink-0" />
            </ListboxItem>
          </ListboxGroup>
          <ListboxGroup v-if="others.length">
            <ListboxGroupLabel v-if="model.length" class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {{ q.trim() ? 'Matches' : 'Most used' }}
            </ListboxGroupLabel>
            <ListboxItem v-for="r in others" :key="r.payeeKey" :value="r.payeeKey" :class="itemClass" @select="toggle(r.payeeKey)">
              <span class="min-w-0 truncate">{{ r.payee }}</span>
              <span class="ml-auto shrink-0 text-xs text-muted-foreground tabular" :title="`${r.count} transactions`">{{ r.count }}</span>
            </ListboxItem>
          </ListboxGroup>
          <p v-if="!results.data.value?.length && !results.isFetching.value" class="px-2 py-6 text-center text-sm text-muted-foreground">
            {{ q.trim() ? 'No payee matches.' : 'No payees yet.' }}
          </p>
        </ListboxContent>
      </ListboxRoot>
    </PopoverContent>
  </Popover>
</template>
