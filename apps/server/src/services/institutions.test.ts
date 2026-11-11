import { describe, expect, it } from 'vitest'
import { makeAccount, testLedger, testStorage } from '../test/helpers'
import {
  createInstitution,
  deleteInstitution,
  getInstitution,
  listInstitutions,
  removeIfEmpty,
  resolveInstitution,
  updateInstitution,
} from './institutions'

function twoLedgers() {
  const storage = testStorage()
  return { personal: storage.registry.defaultContext(), family: testLedger(storage) }
}

const notFound = { status: 404, message: 'Institution not found' }

describe('institutions in one database', () => {
  it('keeps names, sort and counts per ledger', () => {
    const { personal, family } = twoLedgers()
    const td = createInstitution(personal, { name: 'TD' })
    const rbc = createInstitution(personal, { name: 'RBC' })
    // The same name in another ledger is another institution, first in its order.
    const ftd = createInstitution(family, { name: ' td ' })
    expect([td.sort, rbc.sort, ftd.sort]).toEqual([0, 1, 0])
    expect(ftd.id).not.toBe(td.id)
    expect(() => createInstitution(family, { name: 'TD' })).toThrow(expect.objectContaining({ status: 409, message: 'There’s already an institution called “TD”.' }))

    makeAccount(personal, 'Chequing', 'chequing', 0, 'TD')
    makeAccount(personal, 'Savings', 'savings', 0, 'TD')
    makeAccount(family, 'Chequing', 'chequing', 0, 'td')
    expect(listInstitutions(personal).map((i) => [i.name, i.accountCount])).toEqual([
      ['TD', 2],
      ['RBC', 0],
    ])
    expect(listInstitutions(family).map((i) => [i.name, i.accountCount])).toEqual([['td', 1]])

    expect(resolveInstitution(family, { institution: 'TD' })).toEqual({ id: ftd.id, created: false })
    const added = resolveInstitution(family, { institution: 'RBC' })
    expect(added.created).toBe(true)
    expect(added.id).not.toBe(rbc.id)
  })

  it('refuses another ledger’s institution by id', () => {
    const { personal, family } = twoLedgers()
    const td = createInstitution(personal, { name: 'TD' })
    const ftd = createInstitution(family, { name: 'TD' })
    makeAccount(family, 'Chequing', 'chequing', 0, 'TD')

    expect(() => getInstitution(personal, ftd.id)).toThrow(expect.objectContaining(notFound))
    expect(() => updateInstitution(personal, ftd.id, { name: 'Mine' })).toThrow(expect.objectContaining(notFound))
    expect(() => resolveInstitution(personal, { institutionId: ftd.id })).toThrow(expect.objectContaining(notFound))
    expect(() => deleteInstitution(personal, ftd.id)).toThrow(expect.objectContaining(notFound))
    expect(() => deleteInstitution(personal, td.id, ftd.id)).toThrow(expect.objectContaining(notFound))
    expect(removeIfEmpty(personal, ftd.id)).toBeNull()
    expect(getInstitution(family, ftd.id)).toMatchObject({ name: 'TD', accountCount: 1 })
  })

  it('moves accounts within the ledger when deleting', () => {
    const { personal, family } = twoLedgers()
    const td = createInstitution(personal, { name: 'TD' })
    const rbc = createInstitution(personal, { name: 'RBC' })
    makeAccount(personal, 'Chequing', 'chequing', 0, 'TD')
    makeAccount(family, 'Chequing', 'chequing', 0, 'TD')

    expect(() => deleteInstitution(personal, td.id)).toThrow(
      expect.objectContaining({ status: 409, message: 'TD still has 1 account. Move them to another institution first.' }),
    )
    const { before, movedTo } = deleteInstitution(personal, td.id, rbc.id)
    expect([before.name, movedTo?.name, movedTo?.accountCount]).toEqual(['TD', 'RBC', 1])
    expect(listInstitutions(personal).map((i) => i.name)).toEqual(['RBC'])
    expect(listInstitutions(family).map((i) => [i.name, i.accountCount])).toEqual([['TD', 1]])

    const empty = createInstitution(personal, { name: 'Empty' })
    expect(updateInstitution(personal, empty.id, { name: 'Tangerine', sort: 7 })).toMatchObject({ name: 'Tangerine', sort: 7 })
    expect(removeIfEmpty(personal, empty.id)?.name).toBe('Tangerine')
    expect(removeIfEmpty(personal, rbc.id)).toBeNull()
  })
})
