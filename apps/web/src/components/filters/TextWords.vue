<script setup lang="ts">
import { ref } from 'vue'
import { X } from '@lucide/vue'
import { FILTER_LIMITS } from '@chipmunk/shared'
import { cn } from '@/lib/utils'

/** Words to match, as the search box matches them. Enter (or leaving the field) adds one, and Backspace takes the last off. */
const props = defineProps<{ class?: string }>()
const model = defineModel<string[]>({ default: () => [] })
const draft = ref('')

function add() {
  const word = draft.value.trim().slice(0, FILTER_LIMITS.word)
  draft.value = ''
  if (!word || model.value.length >= FILTER_LIMITS.words || model.value.some((w) => w.toLowerCase() === word.toLowerCase())) return
  model.value = [...model.value, word]
}
const remove = (i: number) => (model.value = model.value.filter((_, j) => j !== i))
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    add()
  } else if (e.key === 'Backspace' && !draft.value && model.value.length) {
    remove(model.value.length - 1)
  }
}
</script>

<template>
  <div
    :class="
      cn(
        'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
        props.class,
      )
    "
  >
    <span v-for="(w, i) in model" :key="w" class="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-full bg-secondary py-0.5 pr-0.5 pl-2 text-xs">
      <span class="truncate">“{{ w }}”</span>
      <!-- 20px to look at, 44px to tap on phones. -->
      <button
        type="button"
        class="relative grid size-5 shrink-0 place-items-center rounded-full opacity-60 after:absolute after:-inset-3 hover:opacity-100 md:after:inset-0"
        :aria-label="`Remove “${w}”`"
        @click="remove(i)"
      >
        <X class="size-3" />
      </button>
    </span>
    <input
      v-model="draft"
      class="min-w-16 flex-1 bg-transparent py-0.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
      :placeholder="model.length ? '' : 'Add words'"
      enterkeyhint="done"
      autocomplete="off"
      aria-label="Words"
      @keydown="onKey"
      @blur="add"
    />
  </div>
</template>
