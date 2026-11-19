import { parseMoney, sideOf, type FilterSide, type ReportFilter, type TransactionPart } from '@chipmunk/shared'
import { money } from './format'

/** A line of the Split into categories editor, as typed. Amounts are typed without a sign. */
export type PartLine = { categoryId: number | null; amountText: string; note: string }

export const partLines = (parts: TransactionPart[]): PartLine[] =>
  parts.map((p) => ({ categoryId: p.categoryId, amountText: (Math.abs(p.amountMinor) / 100).toFixed(2), note: p.note ?? '' }))

/**
 * Each line's amount in cents, without a sign, with the last line taking the rest of `totalMinor`
 * (the transaction's amount, without a sign). `problem` says why they can't be saved yet.
 */
export function checkLines(lines: PartLine[], totalMinor: number | null): { amounts: number[]; problem: string | null } {
  const typed = lines.slice(0, -1).map((l) => parseMoney(l.amountText))
  const ok = typed.map((v) => (v !== null && v > 0 ? v : 0))
  const rest = (totalMinor ?? 0) - ok.reduce((n, v) => n + v, 0)
  const amounts = [...ok, rest]
  if (!totalMinor) return { amounts, problem: 'Enter the amount first' }
  if (ok.includes(0)) return { amounts, problem: 'Enter each amount as a number above zero' }
  if (rest === 0) return { amounts, problem: 'Nothing is left for the last line. Lower an amount, or take a line out.' }
  if (rest < 0) return { amounts, problem: `The lines are ${money(-rest)} more than the amount` }
  return { amounts, problem: null }
}

/** This side of a report's filter has a condition on categories (a category, group or label): it counts a split's parts each on its own. */
export function byCategory(f: ReportFilter | null | undefined, side: FilterSide): boolean {
  const s = sideOf(f, side)
  return [...s.only, ...s.filterOut.flatMap((r) => r.when)].some((c) => c.field === 'category' || c.field === 'group' || c.field === 'label')
}
