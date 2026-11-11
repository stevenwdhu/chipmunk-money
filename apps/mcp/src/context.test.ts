import { describe, expect, it } from 'vitest'
import type { Account, Category } from '@chipmunk/shared'
import { Lookups, toMinor, ToolError } from './context'

const cat = (id: number, name: string, extra: Partial<Category> = {}): Category => ({
  id,
  name,
  groupId: null,
  isIncome: false,
  excludeFromTotals: false,
  labelIds: [],
  archived: false,
  sort: id,
  ...extra,
})
const acc = (id: number, name: string, archived = false) => ({ id, name, archived }) as Account

const lk = new Lookups(
  [acc(1, 'TD Chequing'), acc(2, 'Amex Cobalt'), acc(3, 'Old Visa', true)],
  [cat(10, 'Groceries'), cat(11, 'Dining out'), cat(12, 'Coffee'), cat(13, 'Coffee beans'), cat(14, 'Gone', { archived: true })],
  [],
)

describe('name lookups', () => {
  it('finds categories by id, exact name in any case, or a unique partial name', () => {
    expect(lk.category(11)).toBe(11)
    expect(lk.category('11')).toBe(11)
    expect(lk.category('groceries')).toBe(10)
    expect(lk.category('Coffee')).toBe(12) // exact beats partial
    expect(lk.category('dining')).toBe(11)
    expect(lk.category(null)).toBeNull()
    expect(lk.category('uncategorized')).toBeNull()
  })

  it('explains what went wrong so an agent can retry', () => {
    expect(() => lk.category('coff')).toThrow(/matches several categories: “Coffee”, “Coffee beans”/)
    expect(() => lk.category('Snacks')).toThrow(ToolError)
    expect(() => lk.category('Snacks')).toThrow(/Choose one of: “Groceries”, “Dining out”, “Coffee”, “Coffee beans”\./)
    expect(() => lk.category('Gone')).toThrow(/no category called “Gone”/) // archived
    expect(() => lk.category(99)).toThrow(/no category with id 99/)
  })

  it('finds accounts, skipping archived ones unless asked by id', () => {
    expect(lk.account('amex').id).toBe(2)
    expect(lk.account(3).id).toBe(3)
    expect(() => lk.account('Old Visa')).toThrow(/no account called/)
  })

  it('turns dollars into cents without float drift', () => {
    expect(toMinor(-12.99)).toBe(-1299)
    expect(toMinor(0.1 + 0.2)).toBe(30)
    expect(toMinor(1234.565)).toBe(123457)
  })
})
