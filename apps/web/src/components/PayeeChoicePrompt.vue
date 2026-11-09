<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { usePayeePrompt } from '@/composables/usePayeePrompt'
import { useUiStore } from '@/stores/ui'

/**
 * What happens to a payee from now on, after you set a transaction's category: a panel at the bottom
 * of the screen. After accepting a suggestion with its ✓, the small popover by the ✓ asks instead
 * (PayeeChoicePopover), unless its row is gone, say from a list of ones to review.
 */
const ui = useUiStore()
const { prompt, category, current, currentCategory, open, pending, close, choose, busy } = usePayeePrompt()
// Asked by a ✓: a moment for its popover to come up first, so this doesn't flash.
const settled = ref(true)
watch(prompt, (p) => {
  settled.value = !p?.txId
  if (p?.txId) void nextTick(() => (settled.value = true))
})
const shown = computed(() => open.value && settled.value && !(prompt.value?.txId && ui.payeePopoverShown))
</script>

<template>
  <Transition
    enter-active-class="transition duration-150 ease-out"
    enter-from-class="translate-y-2 opacity-0"
    leave-active-class="transition duration-100 ease-in"
    leave-to-class="translate-y-2 opacity-0"
  >
    <section
      v-if="shown && prompt"
      role="dialog"
      aria-labelledby="payee-prompt-title"
      class="fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-md rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg md:bottom-6"
      @keydown.esc="close"
    >
      <header class="mb-2 flex items-start gap-2 pl-1">
        <div class="min-w-0 flex-1">
          <h2 id="payee-prompt-title" class="truncate text-sm font-medium">{{ prompt.payee }}</h2>
          <p class="text-xs text-muted-foreground">
            {{ current?.mode === 'always' ? `Always ${currentCategory?.name ?? 'another category'} until now.` : 'What about its other transactions?' }}
          </p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close" @click="close"><X /></Button>
      </header>
      <div class="grid gap-1.5">
        <button type="button" class="rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/60" :disabled="busy" @click="choose('always')">
          <span class="block text-sm font-medium">Always set to {{ category?.name }}</span>
          <span class="block text-xs text-muted-foreground">
            {{ pending ? `${pending} other transaction${pending === 1 ? '' : 's'} will be marked as reviewed.` : 'New ones are set without review.' }}
          </span>
        </button>
        <button type="button" class="rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/60" :disabled="busy" @click="choose('review')">
          <span class="block text-sm font-medium">Always manually review</span>
          <span class="block text-xs text-muted-foreground">Never set on its own, even when AI and your bank agree.</span>
        </button>
      </div>
    </section>
  </Transition>
</template>
