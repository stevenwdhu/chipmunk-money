/** Money is always handled as integer minor units (cents). Never use floats for stored amounts. */

const formatters = new Map<string, Intl.NumberFormat>()

function formatter(currency: string, signDisplay: Intl.NumberFormatOptions['signDisplay']) {
  const key = `${currency}:${signDisplay}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-CA', { style: 'currency', currency, signDisplay })
    formatters.set(key, f)
  }
  return f
}

/** 123456 → "$1,234.56"; -8432 → "-$84.32". `signed` also prefixes positives with "+". */
export function formatMoney(minor: number, currency = 'CAD', opts: { signed?: boolean } = {}): string {
  return formatter(currency, opts.signed ? 'exceptZero' : 'auto').format(minor / 100)
}

/** Compact form for chart axes: 1234567 → "$12K". */
export function formatMoneyCompact(minor: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(minor / 100)
}

export function fromMinor(minor: number): number {
  return minor / 100
}

/**
 * Parses user or bank input into minor units. Accepts "1,234.56", "-$12.30", "$12.30-",
 * "(12.30)" (accounting negative), "12" and "CA$5". Returns null when the text has no number.
 */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null
  let s = input.trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.endsWith('-')) {
    negative = !negative
    s = s.slice(0, -1)
  }
  if (s.includes('-')) {
    negative = !negative
    s = s.replace(/-/g, '')
  }
  s = s.replace(/[^\d.,]/g, '')
  if (!s) return null
  // "1.234,56" (European) vs "1,234.56": treat the last separator as the decimal point
  // only when it is followed by exactly two digits.
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > lastDot && s.length - lastComma - 1 === 2) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else {
    s = s.replace(/,/g, '')
  }
  const value = Number(s)
  if (!Number.isFinite(value)) return null
  const minor = Math.round(value * 100)
  return negative ? -minor : minor
}
