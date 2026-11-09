<script setup lang="ts">
import { computed, ref } from 'vue'
import { X } from '@lucide/vue'
import { useTags } from '@/composables/queries'

defineProps<{ id?: string; placeholder?: string }>()
const model = defineModel<string[]>({ default: () => [] })
const draft = ref('')
const focused = ref(false)
const { data: tags } = useTags()

const clean = (s: string) => s.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')
const suggestions = computed(() => {
  const q = clean(draft.value)
  return (tags.value ?? [])
    .filter((t) => !model.value.includes(t.name) && (!q || t.name.includes(q)))
    .slice(0, 6)
})

function add(name = draft.value) {
  const tag = clean(name)
  if (tag && !model.value.includes(tag)) model.value = [...model.value, tag]
  draft.value = ''
}
function remove(tag: string) {
  model.value = model.value.filter((t) => t !== tag)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
    if (draft.value.trim()) {
      e.preventDefault()
      add()
    }
  } else if (e.key === 'Backspace' && !draft.value && model.value.length) {
    remove(model.value[model.value.length - 1]!)
  }
}
</script>

<template>
  <div class="relative">
    <div
      class="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
    >
      <span v-for="t in model" :key="t" class="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
        #{{ t }}
        <button type="button" class="opacity-60 hover:opacity-100" :aria-label="`Remove ${t}`" @click="remove(t)">
          <X class="size-3" />
        </button>
      </span>
      <input
        :id="id"
        v-model="draft"
        class="min-w-20 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        :placeholder="model.length ? '' : (placeholder ?? 'Add tags')"
        autocomplete="off"
        @keydown="onKey"
        @focus="focused = true"
        @blur="(focused = false), add()"
      />
    </div>
    <div
      v-if="focused && suggestions.length"
      class="absolute inset-x-0 top-full z-50 mt-1 rounded-md border bg-popover p-1 text-sm shadow-md"
    >
      <button
        v-for="t in suggestions"
        :key="t.id"
        type="button"
        class="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
        @mousedown.prevent="add(t.name)"
      >
        #{{ t.name }} <span class="text-xs text-muted-foreground">· {{ t.count }}</span>
      </button>
    </div>
  </div>
</template>
