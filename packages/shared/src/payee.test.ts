import { describe, expect, it } from 'vitest'
import { instalmentStore, payeeKey, payeeNamer, payeeSimilarity, type PayeeNameRuleSpec } from './payee'

describe('payeeKey', () => {
  it.each([
    ['WAL-MART SUPERCENTER#4217', 'wal mart supercenter 4217'],
    ['Wal-Mart Supercenter#4217', 'wal mart supercenter 4217'],
    ['Jane Doe - INTERAC e-Transfer®', 'jane doe interac e transfer'],
    ['McDonald’s', 'mcdonalds'],
    ["McDonald's", 'mcdonalds'],
    ['A&W #2384', 'a&w 2384'],
    ['Café  Olé', 'cafe ole'],
    ['淘宝 *88', '淘宝 88'],
  ])('%s → %s', (name, key) => {
    expect(payeeKey(name)).toBe(key)
  })
})

describe('payeeSimilarity', () => {
  it('scores related payees highly', () => {
    expect(payeeSimilarity('loblaws', 'loblaws city market')).toBeGreaterThan(0.5)
    expect(payeeSimilarity('netflix', 'spotify')).toBe(0)
  })

  it('leaves out store numbers and codes, unless they are all there is', () => {
    expect(payeeSimilarity('tim hortons 2241', 'tim hortons 1032')).toBe(1)
    expect(payeeSimilarity('1234', '5678')).toBe(0)
  })

  it('takes a payee whose words start another’s as likely the same', () => {
    expect(payeeSimilarity('loblaws 88', 'loblaws 1032 toronto on')).toBe(0.78)
    expect(payeeSimilarity('loblaws', 'no frills loblaws')).toBeLessThan(0.6)
  })
})

describe('payeeNamer', () => {
  const rule = (id: number, r: Partial<PayeeNameRuleSpec>): PayeeNameRuleSpec => ({ id, kind: 'same', match: 'is', patterns: [], name: null, enabled: true, ...r })

  it('calls a payee what the bank sent, with no rules or AI names', () => {
    expect(payeeNamer()('WAL-MART SUPERCENTER#4217')).toEqual({ name: 'WAL-MART SUPERCENTER#4217', key: 'wal mart supercenter 4217', ruleId: null })
    expect(payeeNamer()('Jane Doe -  INTERAC e-Transfer®')).toEqual({ name: 'Jane Doe -  INTERAC e-Transfer®', key: 'jane doe interac e transfer', ruleId: null })
  })

  it('uses the name AI tidying gave a payee, which your rules never match', () => {
    const tidied = new Map([
      ['WAL-MART SUPERCENTER#4217', 'Walmart'],
      ['WALMART STORE #3010', 'Walmart'],
      ['CITY PARKING LOT 4', 'Acme Parking Lots'],
      ['ACME PARKING LOTS', 'Acme Parking Lots'],
    ])
    const name = payeeNamer([rule(1, { patterns: ['Acme Parking Lots'], name: 'Acme Parking' })], (raw) => tidied.get(raw))
    expect(name('WAL-MART SUPERCENTER#4217')).toEqual({ name: 'Walmart', key: 'walmart', ruleId: null })
    expect(name('WALMART STORE #3010').key).toBe('walmart')
    // The rule's wording as sent, not another payee AI tidying called the same.
    expect(name('ACME PARKING LOTS')).toMatchObject({ name: 'Acme Parking', ruleId: 1 })
    expect(name('CITY PARKING LOT 4')).toMatchObject({ name: 'Acme Parking Lots', ruleId: null })
    // Not tidied yet: as sent.
    expect(name('LOBLAWS #1032 TORONTO ON')).toEqual({ name: 'LOBLAWS #1032 TORONTO ON', key: 'loblaws 1032 toronto on', ruleId: null })
  })

  it('makes names one payee: what it is, starts with or contains, without regard to case or punctuation', () => {
    const name = payeeNamer([
      rule(1, { patterns: ['Corner Cafe', 'TST-CORNER CAFE'], name: 'The Corner' }),
      rule(2, { match: 'starts', patterns: ['Amazon Prime'], name: 'Prime Video' }),
      rule(3, { match: 'contains', patterns: ['wal-mart'], name: 'Big shop' }),
    ])
    expect(name('CORNER CAFE')).toEqual({ name: 'The Corner', key: 'the corner', ruleId: 1 })
    expect(name('Tst-Corner Cafe')).toMatchObject({ name: 'The Corner', ruleId: 1 })
    expect(name('Corner Cafe #2')).toMatchObject({ ruleId: null })
    expect(name('AMAZON PRIME*2K4L19R03')).toMatchObject({ name: 'Prime Video', ruleId: 2 })
    expect(name('Amazon.ca*7Q3KX81Z2')).toMatchObject({ ruleId: null })
    expect(name('WAL-MART SUPERCENTER#4217')).toMatchObject({ name: 'Big shop', ruleId: 3 })
  })

  it('names by regex, on the payee as sent', () => {
    const name = payeeNamer([
      rule(1, { kind: 'regex', patterns: ['^CAA\\*([^.]+)'], name: '$1' }),
      rule(2, { kind: 'regex', patterns: ['bar-b-q'], name: 'Hollis Bar-B-Q' }),
      rule(3, { kind: 'regex', patterns: ['(unclosed'], name: 'Never' }),
    ])
    expect(name('Caa*Tripnest.Com - Purchase')).toMatchObject({ name: 'Tripnest', ruleId: 1 })
    expect(name('HOLLIS BAR-B-Q #12')).toEqual({ name: 'Hollis Bar-B-Q', key: 'hollis bar b q', ruleId: 2 })
    expect(name('(unclosed')).toMatchObject({ ruleId: null })
  })

  it('leaves out rules you turned off', () => {
    expect(payeeNamer([rule(1, { patterns: ['Corner Cafe'], name: 'The Corner', enabled: false })])('CORNER CAFE')).toMatchObject({ name: 'CORNER CAFE', ruleId: null })
  })
})

describe('instalmentStore', () => {
  it('is the store after the service', () => {
    expect(instalmentStore('KLARNA*BOSE')).toBe('BOSE')
    expect(instalmentStore('AFTERPAY * SEPHORA 1234')).toBe('SEPHORA 1234')
    expect(instalmentStore('Klarna')).toBeNull()
  })
})
