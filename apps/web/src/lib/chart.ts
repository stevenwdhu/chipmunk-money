/** "Nice" axis ticks (1, 2, 2.5, 5 × 10^n steps) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    if (max === 0) return [0, 1]
    min = Math.min(0, min)
    max = Math.max(0, max)
  }
  const span = max - min
  const rough = span / count
  const pow = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

/** Picks about `max` evenly spaced indexes for x-axis labels, always including the last. */
export function labelIndexes(length: number, max = 6): number[] {
  if (length <= max) return [...Array(length).keys()]
  const step = Math.ceil(length / max)
  const out: number[] = []
  for (let i = length - 1; i >= 0; i -= step) out.unshift(i)
  return out
}
