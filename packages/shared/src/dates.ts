/**
 * Dates are plain 'YYYY-MM-DD' strings in the user's time zone. Arithmetic is done in UTC on
 * those strings so DST never shifts a day.
 */

export type ISODate = string // YYYY-MM-DD
export type MonthKey = string // YYYY-MM

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isISODate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The current date in a given IANA time zone. */
export function todayInTz(tz: string, now: Date = new Date()): ISODate {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * A moment as local time in `tz` (YYYY-MM-DDTHH:MM:SS), or null at midnight exactly, which banks send
 * when they only know the day.
 */
export function localDateTimeInTz(tz: string, at: Date): string | null {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const time = `${parts.hour}:${parts.minute}:${parts.second}`
  return time === '00:00:00' ? null : `${parts.year}-${parts.month}-${parts.day}T${time}`
}

function toUTC(date: ISODate): Date {
  return new Date(`${date}T00:00:00Z`)
}

function fromUTC(d: Date): ISODate {
  return d.toISOString().slice(0, 10)
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUTC(date)
  d.setUTCDate(d.getUTCDate() + days)
  return fromUTC(d)
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((toUTC(to).getTime() - toUTC(from).getTime()) / 86_400_000)
}

/** Adds calendar months, clamping the day (Jan 31 + 1 month → Feb 28/29). */
export function addMonthsToDate(date: ISODate, months: number, anchorDay?: number): ISODate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const day = anchorDay ?? d
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

export function monthOf(date: ISODate): MonthKey {
  return date.slice(0, 7)
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  return addMonthsToDate(`${month}-01`, n).slice(0, 7)
}

export function monthRange(month: MonthKey): { from: ISODate; to: ISODate } {
  const from = `${month}-01`
  const to = addDays(addMonthsToDate(from, 1), -1)
  return { from, to }
}

export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m)
  return out
}

const shortFmt = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const longFmt = new Intl.DateTimeFormat('en-CA', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})
const monthFmt = new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthShortFmt = new Intl.DateTimeFormat('en-CA', { month: 'short', timeZone: 'UTC' })

/** "2026-09-30" → "Sep 30" (adds the year when it differs from `currentYear`). */
export function formatDateShort(date: ISODate, currentYear?: number): string {
  const d = toUTC(date)
  const base = shortFmt.format(d)
  return currentYear && d.getUTCFullYear() !== currentYear ? `${base}, ${d.getUTCFullYear()}` : base
}

/** "2026-09-30" → "Wednesday, September 30" */
export function formatDateLong(date: ISODate): string {
  return longFmt.format(toUTC(date))
}

/** "2026-09" → "September 2026" */
export function formatMonth(month: MonthKey): string {
  return monthFmt.format(toUTC(`${month}-01`))
}

/** "2026-09" → "Sep" */
export function formatMonthShort(month: MonthKey): string {
  return monthShortFmt.format(toUTC(`${month}-01`))
}

export const REPORT_PRESETS = ['3m', '6m', '12m', '24m', 'ytd', 'last-year'] as const
export type ReportPreset = (typeof REPORT_PRESETS)[number]
/** A preset, or fixed months `YYYY-MM..YYYY-MM` (at most 36). */
export type ReportRange = ReportPreset | `${string}..${string}`
export const FIXED_RANGE_MAX_MONTHS = 36
export type ResolvedRange = { from: ISODate; to: ISODate; start: MonthKey; end: MonthKey; months: MonthKey[]; label: string }

const PRESET_LABELS: Record<ReportPreset, string> = {
  '3m': 'Last 3 months',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
  '24m': 'Last 24 months',
  ytd: 'This year',
  'last-year': 'Last year',
}

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/

export function isReportPreset(v: string): v is ReportPreset {
  return (REPORT_PRESETS as readonly string[]).includes(v)
}

export function parseFixedRange(v: string): { start: MonthKey; end: MonthKey } | null {
  const [start = '', end = '', ...rest] = v.split('..')
  if (rest.length || !MONTH_RE.test(start) || !MONTH_RE.test(end) || start > end) return null
  return addMonths(start, FIXED_RANGE_MAX_MONTHS - 1) < end ? null : { start, end }
}

function presetMonths(preset: ReportPreset, current: MonthKey): { start: MonthKey; end: MonthKey } {
  const january = `${current.slice(0, 4)}-01`
  if (preset === 'ytd') return { start: january, end: current }
  if (preset === 'last-year') return { start: addMonths(january, -12), end: addMonths(january, -1) }
  return { start: addMonths(current, 1 - Number(preset.slice(0, -1))), end: current }
}

/** "Nov 2025 – Oct 2026", or "Oct 2026" for one month (formatMonthShort has no year). */
function monthsLabel(start: MonthKey, end: MonthKey): string {
  const name = (m: MonthKey) => `${formatMonthShort(m)} ${m.slice(0, 4)}`
  return start === end ? name(start) : `${name(start)} – ${name(end)}`
}

function spanOf(start: MonthKey, end: MonthKey, label = monthsLabel(start, end)): ResolvedRange {
  return { from: `${start}-01`, to: monthRange(end).to, start, end, months: monthsBetween(start, end), label }
}

/**
 * The months a report covers. `to` is the end of the last month even when that's this month, so rows
 * dated later this month count. Throws on an invalid fixed range.
 */
export function resolveRange(range: ReportRange, today: ISODate): ResolvedRange {
  if (isReportPreset(range)) {
    const { start, end } = presetMonths(range, monthOf(today))
    return spanOf(start, end, PRESET_LABELS[range])
  }
  const fixed = parseFixedRange(range)
  if (!fixed) throw new Error(`Invalid report range: ${range}`)
  return spanOf(fixed.start, fixed.end)
}

/**
 * The period to compare `cur` with: the same number of months just before it, or the same months a
 * year earlier. When `cur` ends this month, the comparison stops at the same day of its last month, so
 * a month in progress is compared against the same part of a month.
 */
export function comparisonRange(cur: ResolvedRange, mode: 'previous' | 'last-year', today: ISODate): ResolvedRange {
  const shift = mode === 'previous' ? -cur.months.length : -12
  const range = spanOf(addMonths(cur.start, shift), addMonths(cur.end, shift))
  if (cur.end === monthOf(today)) range.to = addMonthsToDate(today, shift)
  return range
}

/**
 * The average of `value` over the complete months in `points` (before `currentMonth`) since the first
 * transaction's month, rounded to minor units. Null when no month qualifies or there are no transactions.
 */
export function completeMonthAverage(
  points: Array<{ month: MonthKey; value: number }>,
  opts: { currentMonth: MonthKey; firstMonth: MonthKey | null },
): number | null {
  const { currentMonth, firstMonth } = opts
  if (firstMonth === null) return null
  const values = points.filter((p) => p.month < currentMonth && p.month >= firstMonth).map((p) => p.value)
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null
}
