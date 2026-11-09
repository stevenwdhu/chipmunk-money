<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Check } from '@lucide/vue'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { usePayeePrompt } from '@/composables/usePayeePrompt'
import { useUiStore } from '@/stores/ui'

/**
 * What happens to a payee from now on, asked right by the ✓ you accepted a suggestion with: a ✓ in
 * its place, and a small popover from it. Only where it's visible (a row can have its category twice,
 * one for narrow screens); the panel at the bottom asks otherwise.
 */
const ui = useUiStore()
const { prompt, category, current, currentCategory, open, pending, close, choose, busy } = usePayeePrompt()
const anchor = ref<HTMLElement | null>(null)
const visible = ref(false)
onMounted(() => {
  visible.value = !!anchor.value?.offsetParent
  if (visible.value) ui.payeePopoverShown = true
})
onUnmounted(() => {
  if (visible.value) ui.payeePopoverShown = false
})
const shown = computed(() => visible.value && open.value)
</script>

<template>
  <Popover :open="shown" @update:open="(v) => !v && close()">
    <span ref="anchor" class="inline-flex shrink-0">
      <PopoverAnchor as-child>
        <span class="grid size-6 place-items-center text-positive" aria-hidden="true"><Check class="size-3.5" /></span>
      </PopoverAnchor>
    </span>
    <PopoverContent v-if="prompt" side="bottom" align="start" class="w-60 p-1.5" @click.stop>
      <p class="truncate px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
        {{ current?.mode === 'always' ? `Always ${currentCategory?.name ?? 'another category'} until now.` : `${prompt.payee} from now on?` }}
      </p>
      <button type="button" class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted" :disabled="busy" @click="choose('always')">
        Always set to {{ category?.name }}
        <span v-if="pending" class="block text-xs text-muted-foreground">{{ pending }} other{{ pending === 1 ? '' : 's' }} marked as reviewed</span>
      </button>
      <button type="button" class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted" :disabled="busy" @click="choose('review')">
        Always review myself
      </button>
    </PopoverContent>
  </Popover>
</template>
