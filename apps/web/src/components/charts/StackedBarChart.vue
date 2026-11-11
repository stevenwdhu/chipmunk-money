<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useElementSize } from '@vueuse/core'
import { formatMoneyCompact } from '@chipmunk/shared'
import { money } from '@/lib/format'
import { niceTicks } from '@/lib/chart'

const props = withDefaults(
  defineProps<{
    labels: string[]
    /** Long labels for tooltips (e.g. "September 2026"). */
    titles?: string[]
    series: Array<{ key: string; name: string; color: string }>
    /** values[key][i] */
    values: Record<string, number[]>
    height?: number
    /** Optional horizontal reference line, e.g. a monthly average. */
    reference?: { value: number; label: string } | null
    /** Optional hatched segment on top of each bar for what isn't counted, e.g. what a filter filters out. Not in the totals or the reference. */
    extra?: { label: string; values: number[] } | null
    selected?: number | null
    chartLabel: string
  }>(),
  { height: 240, reference: null, selected: null, extra: null },
)
const emit = defineEmits<{ select: [number] }>()

const el = ref<HTMLElement | null>(null)
const { width } = useElementSize(el)
const pad = { top: 12, right: 8, bottom: 24, left: 52 }
const hover = ref<number | null>(null)
// Pattern ids are page-wide: each chart needs its own.
const hatch = `hatch-${useId()}`

const totals = computed(() =>
  props.labels.map((_, i) => props.series.reduce((n, s) => n + Math.max(props.values[s.key]?.[i] ?? 0, 0), 0)),
)
const extras = computed(() => props.labels.map((_, i) => Math.max(props.extra?.values[i] ?? 0, 0)))
const geo = computed(() => {
  const w = Math.max(width.value, 200)
  const h = props.height
  const tops = totals.value.map((n, i) => n + (extras.value[i] ?? 0))
  const ticks = niceTicks(0, Math.max(...tops, props.reference?.value ?? 0, 1))
  const hi = ticks[ticks.length - 1]!
  const iw = w - pad.left - pad.right
  const ih = h - pad.top - pad.bottom
  const band = iw / Math.max(props.labels.length, 1)
  const barW = Math.min(44, band * 0.62)
  const y = (v: number) => pad.top + ih - (v / hi) * ih
  const bars = props.labels.map((_, i) => {
    let acc = 0
    const cx = pad.left + band * i + band / 2
    const segs = props.series
      .map((s) => {
        const v = Math.max(props.values[s.key]?.[i] ?? 0, 0)
        const seg = { key: s.key, color: s.color, y: y(acc + v), height: y(acc) - y(acc + v), v }
        acc += v
        return seg
      })
      .filter((s) => s.v > 0)
    const e = extras.value[i] ?? 0
    const extra = e > 0 ? { y: y(acc + e), height: y(acc) - y(acc + e) } : null
    return { cx, x: cx - barW / 2, segs, extra }
  })
  return { w, h, ticks, y, bars, barW, band }
})

const tooltip = computed(() => {
  if (hover.value === null) return null
  const i = hover.value
  const rows = props.series
    .map((s) => ({ ...s, v: props.values[s.key]?.[i] ?? 0 }))
    .filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v)
  return { i, rows: rows.slice(0, 6), more: Math.max(rows.length - 6, 0), total: totals.value[i] ?? 0 }
})
</script>

<template>
  <div ref="el" class="relative w-full select-none">
    <svg
      :width="geo.w"
      :height="geo.h"
      class="block overflow-visible"
      role="img"
      :aria-label="extra ? `${chartLabel}. ${extra.label} is hatched on top` : chartLabel"
      @pointerleave="hover = null"
    >
      <defs v-if="extra">
        <pattern :id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="var(--muted-foreground)" opacity="0.15" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--muted-foreground)" stroke-width="1.5" opacity="0.6" />
        </pattern>
      </defs>
      <g class="text-[11px]" fill="var(--muted-foreground)">
        <template v-for="t in geo.ticks" :key="t">
          <line :x1="pad.left" :x2="geo.w - pad.right" :y1="geo.y(t)" :y2="geo.y(t)" stroke="var(--border)" :stroke-dasharray="t === 0 ? undefined : '3 3'" />
          <text :x="pad.left - 8" :y="geo.y(t)" text-anchor="end" dominant-baseline="middle" class="tabular">{{ formatMoneyCompact(t) }}</text>
        </template>
        <text v-for="(l, i) in labels" :key="i" :x="geo.bars[i]?.cx" :y="geo.h - 6" text-anchor="middle" :font-weight="selected === i ? 600 : undefined" :fill="selected === i ? 'var(--foreground)' : undefined">
          {{ l }}
        </text>
      </g>
      <g
        v-for="(b, i) in geo.bars"
        :key="i"
        class="cursor-pointer"
        :opacity="hover === null && selected === null ? 0.9 : hover === i || (hover === null && selected === i) ? 1 : 0.45"
        @pointerenter="hover = i"
        @click="emit('select', i)"
      >
        <rect :x="b.cx - geo.band / 2" :y="0" :width="geo.band" :height="geo.h - pad.bottom" fill="transparent" />
        <rect
          v-for="s in b.segs"
          :key="s.key"
          :x="b.x"
          :y="s.y"
          :width="geo.barW"
          :height="Math.max(s.height - 1, 0.5)"
          :fill="s.color"
          rx="2"
        />
        <rect
          v-if="b.extra"
          :x="b.x"
          :y="b.extra.y"
          :width="geo.barW"
          :height="Math.max(b.extra.height - 1, 0.5)"
          :fill="`url(#${hatch})`"
          rx="2"
        />
      </g>
      <g v-if="reference && reference.value > 0">
        <line :x1="pad.left" :x2="geo.w - pad.right" :y1="geo.y(reference.value)" :y2="geo.y(reference.value)" stroke="var(--foreground)" stroke-dasharray="5 4" opacity="0.6" />
        <text :x="geo.w - pad.right" :y="geo.y(reference.value) - 5" text-anchor="end" class="text-[11px]" fill="var(--foreground)" opacity="0.75">
          {{ reference.label }}
        </text>
      </g>
    </svg>
    <div
      v-if="tooltip"
      class="pointer-events-none absolute top-0 z-10 w-52 rounded-md border bg-popover p-2.5 text-xs shadow-md"
      :style="{ left: `${Math.min(Math.max((geo.bars[tooltip.i]?.cx ?? 0) + 16, 0), geo.w - 210)}px` }"
    >
      <div class="mb-1.5 flex justify-between font-medium">
        <span>{{ titles?.[tooltip.i] ?? labels[tooltip.i] }}</span><span class="tabular">{{ money(tooltip.total) }}</span>
      </div>
      <div v-for="r in tooltip.rows" :key="r.key" class="flex items-center justify-between gap-2 py-0.5">
        <span class="flex min-w-0 items-center gap-1.5"><span class="size-2 shrink-0 rounded-full" :style="{ background: r.color }" /><span class="truncate">{{ r.name }}</span></span>
        <span class="tabular text-muted-foreground">{{ money(r.v) }}</span>
      </div>
      <div v-if="tooltip.more" class="pt-0.5 text-muted-foreground">+{{ tooltip.more }} more</div>
      <slot name="tooltip" :index="tooltip.i" />
    </div>
  </div>
</template>
