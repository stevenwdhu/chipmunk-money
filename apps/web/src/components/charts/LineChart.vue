<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementSize } from '@vueuse/core'
import { formatMoneyCompact } from '@st/shared'
import { money } from '@/lib/format'
import { labelIndexes, niceTicks } from '@/lib/chart'

const props = withDefaults(
  defineProps<{
    points: Array<{ label: string; value: number; detail?: string }>
    height?: number
    color?: string
    chartLabel: string
  }>(),
  { height: 220, color: 'var(--foreground)' },
)

const el = ref<HTMLElement | null>(null)
const { width } = useElementSize(el)
const pad = { top: 12, right: 12, bottom: 26, left: 56 }
const hover = ref<number | null>(null)

const geo = computed(() => {
  const w = Math.max(width.value, 200)
  const h = props.height
  const values = props.points.map((p) => p.value)
  const ticks = niceTicks(Math.min(...values, 0), Math.max(...values, 0))
  const lo = ticks[0]!
  const hi = ticks[ticks.length - 1]!
  const iw = w - pad.left - pad.right
  const ih = h - pad.top - pad.bottom
  const x = (i: number) => pad.left + (props.points.length <= 1 ? iw / 2 : (i / (props.points.length - 1)) * iw)
  const y = (v: number) => pad.top + ih - ((v - lo) / (hi - lo || 1)) * ih
  const line = props.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const base = y(Math.max(lo, Math.min(0, hi)))
  const area = props.points.length ? `${line} L${x(props.points.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z` : ''
  return { w, h, ticks, x, y, line, area, base }
})

function onMove(e: PointerEvent) {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const px = e.clientX - rect.left
  const n = props.points.length
  if (!n) return
  const iw = geo.value.w - pad.left - pad.right
  const i = Math.round(((px - pad.left) / (iw || 1)) * (n - 1))
  hover.value = Math.max(0, Math.min(n - 1, i))
}
const hovered = computed(() => (hover.value === null ? null : props.points[hover.value]))
const gradId = `lc-${Math.random().toString(36).slice(2, 8)}`
</script>

<template>
  <div ref="el" class="relative w-full select-none">
    <svg
      :width="geo.w"
      :height="geo.h"
      class="block overflow-visible"
      role="img"
      :aria-label="chartLabel"
      @pointermove="onMove"
      @pointerleave="hover = null"
    >
      <defs>
        <linearGradient :id="gradId" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.18" />
          <stop offset="100%" :stop-color="color" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="text-[11px]" fill="var(--muted-foreground)">
        <template v-for="t in geo.ticks" :key="t">
          <line :x1="pad.left" :x2="geo.w - pad.right" :y1="geo.y(t)" :y2="geo.y(t)" stroke="var(--border)" :stroke-dasharray="t === 0 ? undefined : '3 3'" />
          <text :x="pad.left - 8" :y="geo.y(t)" text-anchor="end" dominant-baseline="middle" class="tabular">{{ formatMoneyCompact(t) }}</text>
        </template>
        <text
          v-for="i in labelIndexes(points.length)"
          :key="i"
          :x="geo.x(i)"
          :y="geo.h - 6"
          :text-anchor="i === points.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'"
        >
          {{ points[i]?.label }}
        </text>
      </g>
      <path :d="geo.area" :fill="`url(#${gradId})`" />
      <path :d="geo.line" fill="none" :stroke="color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <circle
        v-if="points.length"
        :cx="geo.x(points.length - 1)"
        :cy="geo.y(points[points.length - 1]!.value)"
        r="3.5"
        :fill="color"
      />
      <g v-if="hover !== null && hovered">
        <line :x1="geo.x(hover)" :x2="geo.x(hover)" :y1="pad.top" :y2="geo.h - pad.bottom" stroke="var(--muted-foreground)" stroke-dasharray="2 3" />
        <circle :cx="geo.x(hover)" :cy="geo.y(hovered.value)" r="4.5" :fill="color" stroke="var(--background)" stroke-width="2" />
      </g>
    </svg>
    <div
      v-if="hover !== null && hovered"
      class="pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
      :style="{ left: `${Math.min(Math.max(geo.x(hover) - 70, 0), geo.w - 140)}px` }"
    >
      <div class="text-muted-foreground">{{ hovered.detail ?? hovered.label }}</div>
      <div class="font-medium tabular">{{ money(hovered.value) }}</div>
    </div>
  </div>
</template>
