<script setup lang="ts">
import { computed } from 'vue'
import { Check, Palette } from '@lucide/vue'
import { SketchPicker } from 'vue-color'
import 'vue-color/style.css'
import { COLOR_PALETTE } from '@chipmunk/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCustomColors } from '@/composables/useCustomColors'
import { cn } from '@/lib/utils'

/**
 * Picks a colour from a palette (your custom colours first), or any colour at all with "More…",
 * which opens vue-color's Sketch picker. Remember a custom colour with useCustomColors().remember
 * once it's saved.
 */
const model = defineModel<string>({ required: true })
defineProps<{ label?: string }>()
const custom = useCustomColors()

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const PALETTE = COLOR_PALETTE.slice(0, 20)
/** Your custom colours, the current colour if it's from elsewhere, then the palette. */
const swatches = computed(() => {
  const list = [...custom.colors.value]
  if (model.value && !list.some((c) => same(c, model.value)) && !PALETTE.some((c) => same(c, model.value))) list.unshift(model.value)
  return [...list, ...PALETTE.filter((c) => !list.some((x) => same(x, c)))]
})
// The picker keeps the format it's given (hex); keep it lowercase like the rest of the app.
const color = computed({
  get: () => model.value,
  set: (v: unknown) => {
    if (typeof v === 'string') model.value = v.toLowerCase()
  },
})
</script>

<template>
  <div class="grid gap-2">
    <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" :aria-label="label ?? 'Colour'">
      <button
        v-for="c in swatches"
        :key="c"
        type="button"
        role="radio"
        :aria-checked="same(model, c)"
        :aria-label="c"
        :class="
          cn(
            'grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            same(model, c) && 'ring-2 ring-foreground/60',
          )
        "
        :style="{ background: c }"
        @click="model = c"
      >
        <Check v-if="same(model, c)" class="size-4 text-white mix-blend-difference" />
      </button>
      <Popover>
        <PopoverTrigger as-child>
          <Button type="button" variant="outline" size="sm" class="h-7 rounded-full px-2.5"><Palette />More…</Button>
        </PopoverTrigger>
        <PopoverContent class="w-auto p-0" align="start">
          <SketchPicker v-model="color" :preset-colors="[]" disable-alpha class="color-picker" />
        </PopoverContent>
      </Popover>
    </div>
    <button v-if="custom.colors.value.length" type="button" class="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" @click="custom.clear">
      Forget my custom colours
    </button>
  </div>
</template>

<style scoped>
/* The app's colours, so the picker follows light and dark mode; the popover draws the frame. */
.color-picker {
  --vc-body-bg: var(--popover);
  --vc-input-bg: var(--background);
  --vc-input-border: var(--input);
  --vc-input-text: var(--foreground);
  --vc-input-label: var(--muted-foreground);
  --vc-sketch-input-label: var(--muted-foreground);
  --vc-sketch-presets-border: var(--border);
  box-shadow: none !important;
  border-radius: var(--radius);
  font-family: inherit;
}
/* The palette sits outside the picker, so its own (empty) preset row isn't needed. */
.color-picker :deep(.presets) {
  display: none;
}
</style>
