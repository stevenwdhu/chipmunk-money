<script setup lang="ts">
import { computed } from 'vue'
import { Search, Sparkles, Tag, X } from '@lucide/vue'
import AccountSelect from '@/components/AccountSelect.vue'
import CategoryFilter from '@/components/CategoryFilter.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCategories, useTags } from '@/composables/queries'
import type { TransactionFilterState } from '@/composables/useTransactionFilters'

/** Search and filters for a transaction list. Page-specific controls go in the default slot, at the end. */
const props = defineProps<{
  filters: TransactionFilterState
  /** Offer the account filter (not on an account's own page). */
  showAccount?: boolean
  /** Query keys that "Clear" keeps, such as the month. */
  keep?: string[]
}>()

const f = props.filters
const { data: tags } = useTags()
const tagName = computed(() => tags.value?.find((t) => t.id === f.tagId.value)?.name)
// Category labels (like needs and wants), once you have some.
const { labels } = useCategories()
const label = computed({
  get: () => (f.labelId.value === undefined ? 'all' : String(f.labelId.value)),
  set: (v: string) => f.setQuery({ labelId: v === 'all' ? undefined : v }),
})
const anyOn = computed(() => f.activeCount.value > 0 || (props.showAccount && f.accountId.value !== null))
// Needing review means a category was suggested, so it's never uncategorized: picking one takes the
// other off. (Categories go with needing review.)
const categories = computed({
  get: () => f.categoryIds.value,
  set: (v: Array<number | 'none'>) => {
    const ids = v.length ? [...new Set(v)].join(',') : undefined
    f.setQuery(v.includes('none') && !f.categoryIds.value.includes('none') ? { categoryId: ids, needsReview: undefined } : { categoryId: ids })
  },
})
function toggleReview() {
  if (f.needsReview.value) return f.setQuery({ needsReview: undefined })
  const rest = f.categoryIds.value.filter((c) => c !== 'none')
  f.setQuery({ needsReview: '1', categoryId: rest.length ? rest.join(',') : undefined })
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <div class="relative w-full sm:w-64">
      <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input v-model="f.search.value" type="search" placeholder="Search payee, notes or amount" class="pl-8" aria-label="Search" />
    </div>
    <AccountSelect v-if="showAccount" v-model="f.accountId.value" allow-all class="w-[calc(50%-0.25rem)] sm:w-44" />
    <CategoryFilter v-model="categories" :class="showAccount ? 'w-[calc(50%-0.25rem)] sm:w-48' : 'w-full sm:w-48'" />
    <Select v-if="labels.length" v-model="label">
      <SelectTrigger class="w-[calc(50%-0.25rem)] sm:w-40" aria-label="Label"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All labels</SelectItem>
        <SelectItem v-for="l in labels" :key="l.id" :value="String(l.id)">
          <span class="size-2 rounded-full" :style="{ background: l.color }" />{{ l.name }}
        </SelectItem>
        <SelectItem value="none">No label</SelectItem>
      </SelectContent>
    </Select>
    <Button
      :variant="f.needsReview.value ? 'secondary' : 'outline'"
      size="sm"
      class="h-9"
      :aria-pressed="f.needsReview.value"
      @click="toggleReview"
    >
      <Sparkles class="text-ai" />Needs review
    </Button>
    <span v-if="tagName" class="inline-flex h-9 items-center gap-1 rounded-md border pl-2 text-sm">
      <Tag class="size-3.5" />#{{ tagName }}
      <!-- 28px to look at, 44px to tap on phones. -->
      <button
        type="button"
        class="relative mr-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground after:absolute after:-inset-2 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:after:inset-0"
        aria-label="Remove tag filter"
        @click="f.setQuery({ tagId: undefined })"
      >
        <X class="size-3.5" />
      </button>
    </span>
    <Button v-if="anyOn" variant="ghost" size="sm" class="h-9" @click="f.clear(keep)"><X />Clear</Button>
    <slot />
  </div>
</template>
