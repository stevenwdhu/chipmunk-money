import { describe, expect, it } from 'vitest'
import { unusedColor } from './colors'
import { statementBalance } from './constants'
import { formatMoney, parseMoney } from './money'

describe('parseMoney', () => {
  it.each([
    ['12', 1200],
    ['12.3', 1230],
    ['1,234.56', 123456],
    ['-$84.32', -8432],
    ['$84.32-', -8432],
    ['(20.99)', -2099],
    ['CA$5.00', 500],
    ['1.234,56', 123456],
    ['0.1', 10],
    ['  ', null],
    ['abc', null],
  ])('%s → %s', (input, expected) => {
    expect(parseMoney(input)).toBe(expected)
  })

  it('handles numbers without float drift', () => {
    expect(parseMoney(0.1 + 0.2)).toBe(30)
  })
})

describe('formatMoney', () => {
  it('formats CAD', () => {
    expect(formatMoney(123456)).toBe('$1,234.56')
    expect(formatMoney(-8432)).toBe('-$84.32')
    expect(formatMoney(307500, 'CAD', { signed: true })).toBe('+$3,075.00')
  })
})

describe('statementBalance', () => {
  it('shows what you have in an account and what you owe on a debt, like the bank does', () => {
    expect(statementBalance(150_000, 'chequing')).toBe(150_000)
    expect(statementBalance(-5_000, 'chequing')).toBe(-5_000)
    expect(statementBalance(-214_795, 'credit')).toBe(214_795)
    expect(statementBalance(-30_000_000, 'loan')).toBe(30_000_000)
    // A card paid past its balance is in credit.
    expect(statementBalance(5_000, 'credit')).toBe(-5_000)
    expect(formatMoney(statementBalance(0, 'credit'))).toBe('$0.00')
    // It turns what you enter back into the stored balance, too.
    expect(statementBalance(statementBalance(-214_795, 'credit'), 'credit')).toBe(-214_795)
  })
})

describe('unusedColor', () => {
  it('picks a colour nobody has yet', () => {
    expect(unusedColor(['#EF4444'], ['#ef4444', '#f97316'])).toBe('#f97316')
  })
})
