import { describe, expect, it } from 'vitest'
import { payeeKey } from '@st/shared'
import { planSwitch, type SwitchLocal } from './switching'
import type { RemoteTransaction } from './types'

let nextId = 1
const mine = (date: string, amountMinor: number, payee: string, deleted = false): SwitchLocal => ({ id: nextId++, date, amountMinor, payeeKey: payeeKey(payee), deleted })
const bank = (remoteId: string, date: string, amountMinor: number, payee: string): RemoteTransaction => ({ remoteId, date, amountMinor, payee, description: payee, pending: false })

describe('pairing transactions when an account switches services', () => {
  it('pairs the only one with the same amount within a day, however its payee is worded', () => {
    const walmart = mine('2026-09-29', -4_567, 'Walmart')
    const payment = mine('2026-09-30', 10_000, 'Credit Card Payment - From: Cash')
    const plan = planSwitch([walmart, payment], [bank('w', '2026-09-28', -4_567, 'Wal-Mart Supercenter#1234'), bank('p', '2026-09-30', 10_000, 'Credit card payment')])
    expect(plan.pairs).toHaveLength(2)
    expect(plan.pairs).toContainEqual({ localId: payment.id, remoteId: 'p', guessed: false })
    expect(plan.pairs).toContainEqual({ localId: walmart.id, remoteId: 'w', guessed: false })
    expect([plan.localOnly, plan.remoteOnly]).toEqual([[], []])
  })

  it('tells the same amount and day apart by payee, and says when it only guessed', () => {
    const coffee = mine('2026-06-06', -525, 'Corner Cafe')
    const bar = mine('2026-06-06', -525, 'Bean Bar')
    const clear = planSwitch([coffee, bar], [bank('b', '2026-06-06', -525, 'Tst-Bean Bar'), bank('c', '2026-06-06', -525, 'Sq *Corner Cafe')])
    expect(clear.pairs).toContainEqual({ localId: coffee.id, remoteId: 'c', guessed: false })
    expect(clear.pairs).toContainEqual({ localId: bar.id, remoteId: 'b', guessed: false })

    // Plaid's "Coffee" and "Purchase" say nothing about which is which.
    const one = mine('2026-06-06', -525, 'Coffee')
    const two = mine('2026-06-06', -525, 'Purchase')
    const guess = planSwitch([one, two], [bank('x', '2026-06-06', -525, 'Tst-Bean Bar'), bank('y', '2026-06-06', -525, 'Sq *Corner Cafe')])
    expect(guess.pairs).toHaveLength(2)
    expect(guess.pairs.every((p) => p.guessed)).toBe(true)
  })

  it('pairs them as a whole, so an early pick doesn’t take the next one’s', () => {
    const rent = mine('2026-10-02', -150_000, 'Landlord')
    const loan = mine('2026-10-02', -150_000, 'Auto Loan Pmt')
    const plan = planSwitch([rent, loan], [bank('loan', '2026-10-01', -150_000, 'AUTO LOAN PMT'), bank('rent', '2026-10-02', -150_000, 'LANDLORD')])
    expect(plan.pairs).toContainEqual({ localId: rent.id, remoteId: 'rent', guessed: false })
    expect(plan.pairs).toContainEqual({ localId: loan.id, remoteId: 'loan', guessed: false })
  })

  it('leaves out ones more than a day apart, shows a changed amount beside its twin, and pairs deleted ones quietly', () => {
    const early = mine('2026-09-20', -1_999, 'Netflix')
    const corrected = mine('2026-09-12', -1_600, 'Corner Cafe')
    const gone = mine('2026-09-15', -800, 'Duplicate', true)
    const goneUnmatched = mine('2026-09-16', -900, 'Mistake', true)
    const refund = mine('2026-08-03', 499, 'Refund')
    const plan = planSwitch(
      [early, corrected, gone, goneUnmatched, refund],
      [bank('n', '2026-09-22', -1_999, 'NETFLIX.COM'), bank('c', '2026-09-12', -1_840, 'Corner Cafe'), bank('d', '2026-09-15', -800, 'Duplicate')],
    )
    expect(plan.pairs).toEqual([{ localId: gone.id, remoteId: 'd', guessed: false }])
    expect(plan.near).toEqual([{ localId: corrected.id, remoteId: 'c' }])
    // A deleted one with no twin isn't listed: it's gone either way.
    expect(plan.localOnly.sort()).toEqual([early.id, refund.id].sort())
    expect(plan.remoteOnly).toEqual(['n'])
  })
})
