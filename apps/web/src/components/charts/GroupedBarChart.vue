<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementSize } from '@vueuse/core'
import { formatMoneyCompact } from '@st/shared'
import { money } from '@/lib/format'
import { niceTicks } from '@/lib/chart'

const props = withDefaults(
  defineProps<{
    labels: string[]
    titles?: string[]
    series: Array<{ key: string; name: string; color: string; values: number[] }>
    height?: number
    chartLabel: string
  }>(),
  { height: 240 },
)

const el = ref<HTMLElement | null>(null)
const { width } = useElementSize(el)
const pad = { top: 12, right: 8, bottom: 24, left: 52 }
const hover = ref<number | null>(null)

const geo = computed(() => {
  const w = Math.max(width.value, 200)
  const h = props.height
  const all = props.series.flatMap((s) => s.values)
  const ticks = niceTicks(Math.min(0, ...all), Math.max(1, ...all))
  const lo = ticks[0]!
  const hi = ticks[ticks.length - 1]!
  const iw = w - pad.left - pad.right
  const ih = h - pad.top - pad.bottom
  const band = iw / Math.max(props.labels.length, 1)
  const groupW = Math.min(56, band * 0.7)
  const barW = groupW / props.series.length
  const y = (v: number) => pad.top + ih - ((v - lo) / (hi - lo || 1)) * ih
  return { w, h, ticks, y, band, groupW, barW }
})
const cx = (i: number) => pad.left + geo.value.band * i + geo.value.band / 2
</script>

<template>
  <div ref="el" class="relative w-full select-none">
    <svg :width="geo.w" :height="geo.h" class="block overflow-visible" role="img" :aria-label="chartLabel" @pointerleave="hover = null">
      <g class="text-[11px]" fill="var(--muted-foreground)">
        <template v-for="t in geo.ticks" :key="t">
          <line :x1="pad.left" :x2="geo.w - pad.right" :y1="geo.y(t)" :y2="geo.y(t)" stroke="var(--border)" :stroke-dasharray="t === 0 ? undefined : '3 3'" />
          <text :x="pad.left - 8" :y="geo.y(t)" text-anchor="end" dominant-baseline="middle" class="tabular">{{ formatMoneyCompact(t) }}</text>
        </template>
        <text v-for="(l, i) in labels" :key="i" :x="cx(i)" :y="geo.h - 6" text-anchor="middle">{{ l }}</text>
      </g>
      <g v-for="(_, i) in labels" :key="i" @pointerenter="hover = i">
        <rect :x="cx(i) - geo.band / 2" y="0" :width="geo.band" :height="geo.h - pad.bottom" :fill="hover === i ? 'var(--muted)' : 'transparent'" opacity="0.6" />
        <rect
          v-for="(s, si) in series"
          :key="s.key"
          :x="cx(i) - geo.groupW / 2 + si * geo.barW + 1"
          :y="Math.min(geo.y(s.values[i] ?? 0), geo.y(0))"
          :width="Math.max(geo.barW - 2, 1)"
          :height="Math.max(Math.abs(geo.y(0) - geo.y(s.values[i] ?? 0)), 0.5)"
          :fill="s.color"
          rx="2"
        />
      </g>
    </svg>
    <div
      v-if="hover !== null"
      class="pointer-events-none absolute top-0 z-10 w-48 rounded-md border bg-popover p-2.5 text-xs shadow-md"
      :style="{ left: `${Math.min(Math.max(cx(hover) + 20, 0), geo.w - 200)}px` }"
    >
      <div class="mb-1 font-medium">{{ titles?.[hover] ?? labels[hover] }}</div>
      <div v-for="s in series" :key="s.key" class="flex items-center justify-between gap-2 py-0.5">
        <span class="flex items-center gap-1.5"><span class="size-2 rounded-full" :style="{ background: s.color }" />{{ s.name }}</span>
        <span class="tabular">{{ money(s.values[hover] ?? 0) }}</span>
      </div>
      <slot name="tooltip" :index="hover" />
    </div>
  </div>
</template>
