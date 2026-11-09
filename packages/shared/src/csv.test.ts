import { describe, expect, it } from 'vitest'
import { applyMapping, detectDateFormats, guessMapping, parseDateWith, type ColumnMapping } from './csv'

describe('date parsing', () => {
  it('parses common bank formats', () => {
    expect(parseDateWith('2026-09-30', 'YYYY-MM-DD')).toBe('2026-09-30')
    expect(parseDateWith('09/30/2026', 'MM/DD/YYYY')).toBe('2026-09-30')
    expect(parseDateWith('30/09/2026', 'DD/MM/YYYY')).toBe('2026-09-30')
    expect(parseDateWith('Sep 30, 2026', 'MMM D, YYYY')).toBe('2026-09-30')
    expect(parseDateWith('30 Sep 2026', 'D MMM YYYY')).toBe('2026-09-30')
    expect(parseDateWith('20260930', 'YYYYMMDD')).toBe('2026-09-30')
    expect(parseDateWith('02/30/2026', 'MM/DD/YYYY')).toBeNull()
  })

  it('detects unambiguous formats', () => {
    expect(detectDateFormats(['09/30/2026', '10/01/2026'])).toEqual(['MM/DD/YYYY'])
    expect(detectDateFormats(['30/09/2026', '01/10/2026'])).toEqual(['DD/MM/YYYY'])
    expect(detectDateFormats(['01/02/2026'])).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY'])
  })
})

describe('mapping', () => {
  it('guesses a TD-style headerless export (date, description, debit, credit, balance)', () => {
    const rows = [
      ['09/30/2026', 'LOBLAWS #1032', '84.32', '', '4182.55'],
      ['09/29/2026', 'ACME CORP PAYROLL', '', '3075.00', '4266.87'],
    ]
    const guess = guessMapping(null, rows)
    expect(guess.date).toBe(0)
    expect(guess.payee).toBe(1)
    expect(guess.dateFormat).toBe('MM/DD/YYYY')
  })

  it('guesses from headers', () => {
    const header = ['Transaction Date', 'Description', 'Amount', 'Category']
    const guess = guessMapping(header, [['2026-09-30', 'Netflix', '-20.99', 'Entertainment']])
    expect(guess).toMatchObject({ date: 0, payee: 1, amount: 2, dateFormat: 'YYYY-MM-DD' })
  })

  it('reads a Lunch Money export: its category, without the emoji, and not its category group', () => {
    const header = ['date', 'category_group', 'category', 'payee', 'amount', 'currency', 'notes', 'tags', 'account_name', 'original_name']
    const row = ['2026-07-23', '📌 Needs', '💡 Utilities', 'ACME TELECOM', '-42', 'cad', 'Telecommunication Services', '', 'Example Bank Mastercard', 'ACME TELECOM ******1234']
    const guess = guessMapping(header, [row])
    expect(guess).toMatchObject({ date: 0, category: 2, payee: 3, amount: 4, notes: 6 })
    const shopping = [...row.slice(0, 2), '🛍️ Shopping', ...row.slice(3)]
    const res = applyMapping([row, shopping], { ...guess, hasHeader: true } as ColumnMapping)
    expect(res.rows.map((r) => r.category)).toEqual(['Utilities', 'Shopping'])
  })

  it('applies debit/credit columns', () => {
    const rows = [
      ['09/30/2026', 'LOBLAWS #1032', '84.32', ''],
      ['09/29/2026', 'ACME CORP PAYROLL', '', '3,075.00'],
      ['bad', 'x', '1', ''],
    ]
    const res = applyMapping(rows, { hasHeader: false, date: 0, dateFormat: 'MM/DD/YYYY', payee: 1, debit: 2, credit: 3 })
    expect(res.rows.map((r) => r.amountMinor)).toEqual([-8432, 307500])
    expect(res.errors).toHaveLength(1)
  })

  it('negates credit card exports', () => {
    const res = applyMapping([['2026-09-30', 'Netflix', '20.99']], {
      hasHeader: false, date: 0, dateFormat: 'YYYY-MM-DD', payee: 1, amount: 2, negate: true,
    })
    expect(res.rows[0]?.amountMinor).toBe(-2099)
  })
})
