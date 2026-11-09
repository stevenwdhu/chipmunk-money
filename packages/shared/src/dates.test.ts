import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  addMonthsToDate,
  comparisonRange,
  completeMonthAverage,
  daysBetween,
  formatDateShort,
  isReportPreset,
  localDateTimeInTz,
  monthRange,
  monthsBetween,
  parseFixedRange,
  resolveRange,
  todayInTz,
  type ReportRange,
} from './dates'

describe('dates', () => {
  it('computes today in a time zone', () => {
    const instant = new Date('2026-10-03T03:30:00Z')
    expect(todayInTz('America/Toronto', instant)).toBe('2026-10-02')
    expect(todayInTz('Asia/Tokyo', instant)).toBe('2026-10-03')
  })

  it('adds days across DST and month ends', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364)
  })

  it('clamps month arithmetic', () => {
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsToDate('2026-02-28', 1, 31)).toBe('2026-03-31')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('formats short dates', () => {
    expect(formatDateShort('2026-09-30')).toBe('Sep 30')
    expect(formatDateShort('2025-09-30', 2026)).toBe('Sep 30, 2025')
  })
})

describe('localDateTimeInTz', () => {
  it('gives a moment as local time, and midnight (a bank’s “no time”) as none', () => {
    expect(localDateTimeInTz('America/Toronto', new Date('2026-09-22T18:33:10Z'))).toBe('2026-09-22T14:33:10')
    expect(localDateTimeInTz('America/Toronto', new Date('2026-09-23T03:15:00Z'))).toBe('2026-09-22T23:15:00')
    expect(localDateTimeInTz('UTC', new Date('2026-09-22T00:00:00Z'))).toBeNull()
  })
})

describe('resolveRange', () => {
  const today = '2026-10-27'

  it.each([
    ['3m', '2026-08', '2026-10', 'Last 3 months'],
    ['6m', '2026-05', '2026-10', 'Last 6 months'],
    ['12m', '2025-11', '2026-10', 'Last 12 months'],
    ['24m', '2024-11', '2026-10', 'Last 24 months'],
    ['ytd', '2026-01', '2026-10', 'This year'],
    ['last-year', '2025-01', '2025-12', 'Last year'],
  ] as const)('%s is %s to %s', (range, start, end, label) => {
    expect(resolveRange(range, today)).toEqual({
      from: `${start}-01`,
      to: monthRange(end).to,
      start,
      end,
      months: monthsBetween(start, end),
      label,
    })
  })

  it('runs to the end of this month, so rows dated later this month count', () => {
    expect(resolveRange('3m', today).to).toBe('2026-10-31')
    expect(resolveRange('ytd', '2026-02-01').to).toBe('2026-02-28')
    expect(resolveRange('2026-09..2026-10', today).to).toBe('2026-10-31')
  })

  it('keeps fixed months as given', () => {
    const r = resolveRange('2025-11..2026-10', today)
    expect(r).toMatchObject({ from: '2025-11-01', to: '2026-10-31', start: '2025-11', end: '2026-10', label: 'Nov 2025 – Oct 2026' })
    expect(r.months).toHaveLength(12)
    expect(resolveRange('2028-02..2028-02', today)).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
      start: '2028-02',
      end: '2028-02',
      months: ['2028-02'],
      label: 'Feb 2028',
    })
  })

  it('throws on an invalid fixed range', () => {
    expect(() => resolveRange('2026-10..2026-09', today)).toThrow()
  })

  it('tells presets apart', () => {
    expect(isReportPreset('12m')).toBe(true)
    expect(isReportPreset('last-year')).toBe(true)
    expect(isReportPreset('1m')).toBe(false)
    expect(isReportPreset('2026-01..2026-02')).toBe(false)
  })
})

describe('parseFixedRange', () => {
  it('takes real months in order, up to 36 of them', () => {
    expect(parseFixedRange('2026-10..2026-10')).toEqual({ start: '2026-10', end: '2026-10' })
    expect(parseFixedRange('2024-11..2027-10')).toEqual({ start: '2024-11', end: '2027-10' })
  })

  it.each([
    '2026-13..2027-01',
    '2026-00..2026-01',
    '2026-10..2026-09',
    '2024-10..2027-10',
    '2026-1..2026-02',
    '2026-01-01..2026-02-01',
    '2026-01..2026-02..2026-03',
    '2026-01',
    '3m',
    '',
  ])('rejects %j', (v) => {
    expect(parseFixedRange(v)).toBeNull()
  })
})

describe('comparisonRange', () => {
  const today = '2026-10-27'
  const compare = (range: ReportRange, mode: 'previous' | 'last-year', on = today) =>
    comparisonRange(resolveRange(range, on), mode, on)

  it('takes the same number of months just before', () => {
    expect(compare('3m', 'previous')).toEqual({
      from: '2026-05-01',
      to: '2026-07-27',
      start: '2026-05',
      end: '2026-07',
      months: ['2026-05', '2026-06', '2026-07'],
      label: 'May 2026 – Jul 2026',
    })
    expect(compare('12m', 'previous')).toMatchObject({ from: '2024-11-01', to: '2025-10-27', label: 'Nov 2024 – Oct 2025' })
    expect(compare('ytd', 'previous')).toMatchObject({ start: '2025-03', end: '2025-12', to: '2025-12-27' })
  })

  it('takes the same months a year earlier', () => {
    expect(compare('3m', 'last-year')).toMatchObject({ from: '2025-08-01', to: '2025-10-27', start: '2025-08', end: '2025-10' })
    expect(compare('ytd', 'last-year')).toMatchObject({ from: '2025-01-01', to: '2025-10-27', label: 'Jan 2025 – Oct 2025' })
  })

  it('stops at the same day of a shorter month', () => {
    expect(compare('2026-10..2026-10', 'previous', '2026-10-31')).toMatchObject({ to: '2026-09-30', label: 'Sep 2026' })
    expect(compare('2026-03..2026-03', 'previous', '2026-03-30')).toMatchObject({ from: '2026-02-01', to: '2026-02-28' })
    expect(compare('3m', 'last-year', '2028-02-29')).toMatchObject({ end: '2027-02', to: '2027-02-28' })
  })

  it('runs to the end of its last month when the range ends before this month', () => {
    expect(compare('last-year', 'previous')).toMatchObject({ from: '2024-01-01', to: '2024-12-31', label: 'Jan 2024 – Dec 2024' })
    expect(compare('2026-01..2026-06', 'previous')).toMatchObject({ start: '2025-07', end: '2025-12', to: '2025-12-31' })
    expect(compare('2026-01..2026-06', 'last-year')).toMatchObject({ to: '2025-06-30' })
  })
})

describe('completeMonthAverage', () => {
  const points = [
    { month: '2026-06', value: 999 },
    { month: '2026-07', value: 100 },
    { month: '2026-08', value: 0 },
    { month: '2026-09', value: 301 },
    { month: '2026-10', value: 5000 },
  ]

  it('averages complete months since the first transaction, counting a zero month', () => {
    expect(completeMonthAverage(points, { currentMonth: '2026-10', firstMonth: '2026-07' })).toBe(134)
    expect(completeMonthAverage(points, { currentMonth: '2026-10', firstMonth: '2026-08' })).toBe(151)
  })

  it('only counts the months it is given', () => {
    const gappy = [
      { month: '2026-07', value: 100 },
      { month: '2026-09', value: 300 },
    ]
    expect(completeMonthAverage(gappy, { currentMonth: '2026-10', firstMonth: '2026-01' })).toBe(200)
  })

  it('is null with no complete month or no transactions', () => {
    expect(completeMonthAverage(points, { currentMonth: '2026-10', firstMonth: null })).toBeNull()
    expect(completeMonthAverage(points, { currentMonth: '2026-10', firstMonth: '2026-10' })).toBeNull()
    expect(completeMonthAverage(points, { currentMonth: '2026-06', firstMonth: '2026-01' })).toBeNull()
    expect(completeMonthAverage([], { currentMonth: '2026-10', firstMonth: '2026-01' })).toBeNull()
  })
})
