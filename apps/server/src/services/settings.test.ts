import { describe, expect, it } from 'vitest'
import { testLedger, testStorage } from '../test/helpers'
import { getAppSetting, getLedgerSetting, setAppSetting, setLedgerSetting } from './settings'

describe('settings', () => {
  it('keeps ledger settings per ledger, and app settings for all of them', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    setLedgerSetting(a, 'setup.completed', true)
    expect(getLedgerSetting(a, 'setup.completed', false)).toBe(true)
    expect(getLedgerSetting(b, 'setup.completed', false)).toBe(false)
    setLedgerSetting(b, 'setup.completed', { at: 1 })
    setLedgerSetting(a, 'setup.completed', null)
    expect(getLedgerSetting(a, 'setup.completed', 'unset')).toBe('unset')
    expect(getLedgerSetting(b, 'setup.completed', null)).toEqual({ at: 1 })

    setAppSetting(a.app, 'firstDayOfWeek', 1)
    expect(getAppSetting(b.app, 'firstDayOfWeek', 0)).toBe(1)
    setAppSetting(a.app, 'firstDayOfWeek', null)
    expect(getAppSetting(b.app, 'firstDayOfWeek', 0)).toBe(0)
  })
})
