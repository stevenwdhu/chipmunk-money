import type { AccountType } from '@st/shared'

/** Matching a bank's account to yours: by the bank's name, and by what kind of account it looks like. */

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** Whether one name's words begin the other's: "TD" and "TD Canada Trust". */
export function similarNames(a: string, b: string): boolean {
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length) as [string[], string[]]
  return short.length > 0 && short.every((w, i) => long[i] === w)
}

/** A starting guess at an account's type from the bank's name for it (and a negative balance: owed). */
export function guessType(b: { name: string; balanceMinor: number | null }): AccountType {
  const n = b.name.toLowerCase()
  // Loans first: "Student Loan" and "Line of credit" are owed too, but aren't cards.
  if (/mortgage|loan|line of credit|heloc/.test(n)) return 'loan'
  if (/tfsa|rrsp|fhsa|resp|invest|brokerage|margin|rrif|lira|\bira\b|401k/.test(n)) return 'investment'
  if (/visa|mastercard|master card|amex|american express|credit|card/.test(n) || (b.balanceMinor ?? 0) < 0) return 'credit'
  if (/saving/.test(n)) return 'savings'
  return 'chequing'
}

/** Kinds of account that could be the same one at the bank: a card, money you keep, investments, a debt. */
export function accountKind(type: AccountType): 'card' | 'cash' | 'investment' | 'debt' | 'other' {
  if (type === 'credit') return 'card'
  if (type === 'chequing' || type === 'savings' || type === 'cash') return 'cash'
  if (type === 'investment') return 'investment'
  if (type === 'loan') return 'debt'
  return 'other'
}
