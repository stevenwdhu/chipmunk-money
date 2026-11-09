import type { ISODate } from './dates'
import { isISODate } from './dates'
import { parseMoney } from './money'

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM/DD/YY',
  'DD/MM/YY',
  'MMM D, YYYY',
  'D MMM YYYY',
  'YYYYMMDD',
] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function build(y: number, m: number, d: number): ISODate | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return isISODate(iso) ? iso : null
}

export function parseDateWith(raw: string, format: DateFormat): ISODate | null {
  const s = raw.trim()
  let m: RegExpMatchArray | null
  switch (format) {
    case 'YYYY-MM-DD':
      m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
      return m ? build(+m[1]!, +m[2]!, +m[3]!) : null
    case 'YYYY/MM/DD':
      m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/)
      return m ? build(+m[1]!, +m[2]!, +m[3]!) : null
    case 'MM/DD/YYYY':
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
      return m ? build(+m[3]!, +m[1]!, +m[2]!) : null
    case 'DD/MM/YYYY':
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
      return m ? build(+m[3]!, +m[2]!, +m[1]!) : null
    case 'MM/DD/YY':
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/)
      return m ? build(+m[3]!, +m[1]!, +m[2]!) : null
    case 'DD/MM/YY':
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/)
      return m ? build(+m[3]!, +m[2]!, +m[1]!) : null
    case 'MMM D, YYYY': {
      m = s.match(/^([A-Za-z]{3,4})\.?\s+(\d{1,2}),?\s+(\d{4})$/)
      const mon = m && MONTHS[m[1]!.toLowerCase()]
      return m && mon ? build(+m[3]!, mon, +m[2]!) : null
    }
    case 'D MMM YYYY': {
      m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})\.?[\s-](\d{2,4})$/)
      const mon = m && MONTHS[m[2]!.toLowerCase()]
      return m && mon ? build(+m[3]!, mon, +m[1]!) : null
    }
    case 'YYYYMMDD':
      m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
      return m ? build(+m[1]!, +m[2]!, +m[3]!) : null
  }
}

/** Formats that parse every non-empty sample, best guess first. */
export function detectDateFormats(samples: string[]): DateFormat[] {
  const values = samples.map((s) => s.trim()).filter(Boolean).slice(0, 200)
  if (!values.length) return []
  const ok = DATE_FORMATS.filter((f) => values.every((v) => parseDateWith(v, f) !== null))
  // When both MM/DD and DD/MM parse everything (all days ≤ 12), prefer MM/DD — most Canadian
  // bank exports (TD, RBC, CIBC, Scotiabank) use it.
  return ok
}

export interface ColumnMapping {
  hasHeader: boolean
  date: number
  dateFormat: DateFormat
  payee: number
  /** Single signed amount column. */
  amount?: number | null
  /** Separate outflow/inflow columns (used when `amount` is not set). */
  debit?: number | null
  credit?: number | null
  notes?: number | null
  /**
   * The category the bank or another app gave it (Lunch Money's "💡 Utilities"): kept as its bank
   * category, which AI goes by, like Plaid's.
   */
  category?: number | null
  /** Flip signs, e.g. credit card exports that list purchases as positive numbers. */
  negate?: boolean
}

export interface ParsedImportRow {
  line: number
  date: ISODate
  payee: string
  amountMinor: number
  notes: string | null
  category: string | null
}

export interface ImportParseResult {
  rows: ParsedImportRow[]
  errors: Array<{ line: number; message: string }>
}

const HEADER_HINTS = {
  date: /date|posted|transaction date|trans\. date/i,
  payee: /description|payee|merchant|name|details|memo|narrative/i,
  amount: /^amount$|amount \(|^cad|transaction amount|^value$/i,
  debit: /debit|withdraw|money out|outflow|paid out/i,
  credit: /credit|deposit|money in|inflow|paid in/i,
  notes: /^notes?$|memo|reference/i,
  /** "category", or one like "Category name", but not "category_group" (Lunch Money's needs and wants). */
  category: /^category$|^(?!.*group).*categor/i,
}

/** "💡 Utilities" → "Utilities": another app's emoji and symbols off the front. */
export function cleanCategory(raw: string): string | null {
  return raw.replace(/^[^\p{L}\p{N}]+/u, '').trim() || null
}

/** Best-effort column mapping from a header row (or from the data when there is no header). */
export function guessMapping(header: string[] | null, sample: string[][]): Partial<ColumnMapping> {
  const out: Partial<ColumnMapping> = { hasHeader: !!header }
  const cols = header ?? sample[0]?.map((_, i) => `Column ${i + 1}`) ?? []
  const find = (re: RegExp, exclude: number[] = []) =>
    cols.findIndex((c, i) => !exclude.includes(i) && re.test(c.trim()))

  if (header) {
    const date = find(HEADER_HINTS.date)
    if (date >= 0) out.date = date
    const amount = find(HEADER_HINTS.amount)
    const debit = find(HEADER_HINTS.debit)
    const credit = find(HEADER_HINTS.credit)
    if (amount >= 0) out.amount = amount
    else if (debit >= 0 || credit >= 0) {
      out.debit = debit >= 0 ? debit : null
      out.credit = credit >= 0 ? credit : null
    }
    const used = [out.date, out.amount, out.debit, out.credit].filter((x): x is number => typeof x === 'number')
    const payee = find(HEADER_HINTS.payee, used)
    if (payee >= 0) out.payee = payee
    const taken = [...used, ...(payee >= 0 ? [payee] : [])]
    const exact = cols.findIndex((c) => /^category$/i.test(c.trim()))
    const category = exact >= 0 ? exact : find(HEADER_HINTS.category, taken)
    if (category >= 0) out.category = category
    const notes = find(HEADER_HINTS.notes, [...taken, category])
    if (notes >= 0) out.notes = notes
  }

  // Fall back to inspecting values.
  const width = cols.length
  const columnValues = (i: number) => sample.map((r) => r[i] ?? '').filter((v) => v.trim())
  if (out.date === undefined) {
    for (let i = 0; i < width; i++) {
      if (detectDateFormats(columnValues(i)).length) {
        out.date = i
        break
      }
    }
  }
  if (out.amount === undefined && out.debit === undefined && out.credit === undefined) {
    const numeric = [...Array(width).keys()].filter(
      (i) => i !== out.date && columnValues(i).length && columnValues(i).every((v) => parseMoney(v) !== null),
    )
    if (numeric.length === 1) out.amount = numeric[0]
    else if (numeric.length >= 2) {
      out.debit = numeric[0]
      out.credit = numeric[1]
    }
  }
  if (out.payee === undefined) {
    // Longest average text column that isn't already used.
    let best = -1
    let bestLen = 0
    for (let i = 0; i < width; i++) {
      if ([out.date, out.amount, out.debit, out.credit].includes(i)) continue
      const vals = columnValues(i)
      const avg = vals.reduce((n, v) => n + v.length, 0) / (vals.length || 1)
      if (avg > bestLen) {
        bestLen = avg
        best = i
      }
    }
    if (best >= 0) out.payee = best
  }
  if (out.date !== undefined) {
    const formats = detectDateFormats(columnValues(out.date))
    if (formats[0]) out.dateFormat = formats[0]
  }
  return out
}

export function applyMapping(rows: string[][], mapping: ColumnMapping, firstLine = 1): ImportParseResult {
  const result: ImportParseResult = { rows: [], errors: [] }
  rows.forEach((row, idx) => {
    const line = firstLine + idx
    if (row.every((c) => !c?.trim())) return
    const rawDate = row[mapping.date] ?? ''
    const date = parseDateWith(rawDate, mapping.dateFormat)
    if (!date) {
      result.errors.push({ line, message: `Couldn't read the date "${rawDate}" as ${mapping.dateFormat}` })
      return
    }
    const payee = (row[mapping.payee] ?? '').trim()
    if (!payee) {
      result.errors.push({ line, message: 'The payee/description is empty' })
      return
    }
    let amount: number | null = null
    if (mapping.amount !== undefined && mapping.amount !== null) {
      amount = parseMoney(row[mapping.amount] ?? '')
    } else {
      const debit = mapping.debit != null ? parseMoney(row[mapping.debit] ?? '') : null
      const credit = mapping.credit != null ? parseMoney(row[mapping.credit] ?? '') : null
      if (debit !== null || credit !== null) amount = (credit ? Math.abs(credit) : 0) - (debit ? Math.abs(debit) : 0)
    }
    if (amount === null) {
      result.errors.push({ line, message: 'No amount found' })
      return
    }
    if (mapping.negate) amount = -amount
    const notes = mapping.notes != null ? (row[mapping.notes] ?? '').trim() || null : null
    const category = mapping.category != null ? cleanCategory(row[mapping.category] ?? '') : null
    result.rows.push({ line, date, payee, amountMinor: amount, notes, category })
  })
  return result
}
