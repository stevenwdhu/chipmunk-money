/** Colours offered by the colour picker: four tones of each hue, then neutrals. */
export const COLOR_PALETTE = [
  // 500
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#64748b', '#78716c', '#71717a',
  // 700
  '#b91c1c', '#c2410c', '#b45309', '#a16207', '#4d7c0f', '#15803d', '#047857', '#0f766e', '#0e7490', '#0369a1',
  '#1d4ed8', '#4338ca', '#6d28d9', '#7e22ce', '#a21caf', '#be185d', '#be123c', '#334155', '#44403c', '#3f3f46',
  // 300
  '#fca5a5', '#fdba74', '#fcd34d', '#fde047', '#bef264', '#86efac', '#6ee7b7', '#5eead4', '#67e8f9', '#7dd3fc',
  '#93c5fd', '#a5b4fc', '#c4b5fd', '#d8b4fe', '#f0abfc', '#f9a8d4', '#fda4af', '#cbd5e1', '#d6d3d1', '#d4d4d8',
] as const

/**
 * Colours for charts split by category, handed out in order (largest first), so a chart's
 * categories are easy to tell apart and look the same each time. Categories in lists show in their
 * group's colour instead.
 */
export const CHART_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948',
  '#b07aa1', '#ff9da7', '#9c755f', '#17becf', '#bcbd22', '#7f3c8d',
] as const

/** The colour for the `index`-th category in a chart (repeating after the last). */
export function chartColor(index: number): string {
  return CHART_COLORS[((index % CHART_COLORS.length) + CHART_COLORS.length) % CHART_COLORS.length]!
}

/** Categories without a group (categories show in their group's colour). */
export const UNGROUPED_COLOR = '#94a3b8'

const HEX = /^#[0-9a-f]{6}$/i

export function isHexColor(value: string): boolean {
  return HEX.test(value)
}

/** The first colour in `palette` that's not in `used` (any case), or one by position if all are. */
export function unusedColor(used: Iterable<string>, palette: readonly string[] = COLOR_PALETTE.slice(0, 17)): string {
  const taken = new Set([...used].map((c) => c.toLowerCase()))
  return palette.find((c) => !taken.has(c.toLowerCase())) ?? palette[taken.size % palette.length]!
}
