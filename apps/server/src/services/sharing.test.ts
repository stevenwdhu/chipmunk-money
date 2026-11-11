import { describe, expect, it } from 'vitest'
import { activityQuerySchema } from '@chipmunk/shared'
import { bankAccounts, bankConnections } from '../db/schema'
import { makeAccount } from '../test/helpers'
import { sharedWorld, TESTER } from '../test/shared-accounts'
import { createAccount, getAccount, listAccounts, setBalance } from './accounts'
import { listActivity } from './activity'
import { BankService } from './bank/service'
import type { AppContext } from './context'
import { listInstitutions } from './institutions'
import { addMember, getSharing, removeMember } from './sharing'

/**
 * Sharing an account with other ledgers, at the service level: adding a ledger, the sharing
 * overview, taking out a ledger that holds nothing, and how the account looks in each ledger.
 */

const summaries = (ctx: AppContext) => listActivity(ctx, activityQuerySchema.parse({})).items.map((e) => e.summary)
const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    const err = e as { status?: number; message: string }
    return { status: err.status, message: err.message }
  }
  throw new Error('Expected it to be refused')
}

describe('sharing an account', () => {
  it('adds a ledger: the card is there under its own institution, after its accounts, and nothing moves', () => {
    const w = sharedWorld({ shareWith: [] })
    const chequing = createAccount(w.family, { name: 'Joint', type: 'chequing', institution: 'Credit union', currency: 'CAD', openingBalanceMinor: 0 })
    w.addTx(w.personal, '2026-09-01', -2_000)

    const sharing = addMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    expect(sharing).toEqual({
      accountId: w.visa,
      home: { slug: 'personal', name: 'Personal', archived: false, transactionCount: 1, balanceMinor: -2_000 },
      opening: { slug: 'personal', name: 'Personal' },
      members: [{ slug: 'family', name: 'Family', archived: false, transactionCount: 0, balanceMinor: 0 }],
      totalBalanceMinor: -2_000,
    })

    const there = listAccounts(w.family)
    expect(there.map((a) => [a.name, a.sort])).toEqual([
      ['Joint', 0],
      ['Visa', 1],
    ])
    const card = there.find((a) => a.id === w.visa)!
    const td = listInstitutions(w.family).find((i) => i.name === 'TD')!
    expect(card).toMatchObject({ institutionId: td.id, institution: 'TD', transactionCount: 0, balanceMinor: 0 })
    expect(td.id).not.toBe(getAccount(w.personal, w.visa).institutionId)
    expect(chequing.sort).toBe(0)
    // The home's own view of it is unchanged.
    expect(getAccount(w.personal, w.visa)).toMatchObject({ balanceMinor: -2_000, transactionCount: 1, sort: 0 })

    expect(summaries(w.personal)[0]).toBe('Shared Visa with Family')
    expect(summaries(w.family).slice(0, 2)).toEqual(['Personal shared Visa with this ledger, at TD', 'Added the institution TD'])
  })

  it('reuses an institution of the same name in the other ledger', () => {
    const w = sharedWorld({ shareWith: [] })
    makeAccount(w.family, 'Chequing', 'chequing', 0, 'td')
    const before = listInstitutions(w.family)
    addMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    expect(listInstitutions(w.family).map((i) => [i.id, i.accountCount])).toEqual([[before[0]!.id, 2]])
    expect(getAccount(w.family, w.visa).institution).toBe('td')
    expect(summaries(w.family)).not.toContain('Added the institution TD')
  })

  it('lists the sharing of any account of the home: one that isn’t shared has no members', () => {
    const w = sharedWorld({ shareWith: ['family', 'trip'] })
    expect(getSharing(w.personal, w.visa).members.map((m) => m.slug)).toEqual(['family', 'trip'])
    const chequing = makeAccount(w.personal, 'Chequing', 'chequing', 5_000)
    expect(getSharing(w.personal, chequing)).toEqual({
      accountId: chequing,
      home: { slug: 'personal', name: 'Personal', archived: false, transactionCount: 0, balanceMinor: 5_000 },
      opening: { slug: 'personal', name: 'Personal' },
      members: [],
      totalBalanceMinor: 5_000,
    })
  })

  it('refuses what can’t be shared, and anything asked of a ledger that isn’t the home', () => {
    const w = sharedWorld()
    const chequing = makeAccount(w.personal, 'Chequing', 'chequing')
    expect(status(() => addMember(w.personal, w.ctxOf, chequing, w.trip.ledger.id, TESTER))).toEqual({
      status: 400,
      message: 'Only credit cards can be shared for now, and Chequing isn’t one.',
    })
    const home = { status: 409, message: 'Visa’s home is Personal. Its sharing is changed there.' }
    expect(status(() => getSharing(w.family, w.visa))).toEqual(home)
    expect(status(() => addMember(w.family, w.ctxOf, w.visa, w.trip.ledger.id, TESTER))).toEqual(home)
    expect(status(() => removeMember(w.family, w.ctxOf, w.visa, w.family.ledger.id, TESTER))).toEqual(home)
    expect(status(() => addMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER))).toEqual({ status: 409, message: 'Family already has Visa.' })
    expect(status(() => addMember(w.personal, w.ctxOf, w.visa, w.personal.ledger.id, TESTER))).toEqual({ status: 409, message: 'Personal already has Visa.' })
    expect(status(() => addMember(w.personal, w.ctxOf, w.visa, 'no-such-ledger', TESTER))).toMatchObject({ status: 404 })

    w.storage.registry.update(w.trip.ledger.id, { archived: true })
    expect(status(() => addMember(w.personal, w.ctxOf, w.visa, w.trip.ledger.id, TESTER))).toEqual({
      status: 400,
      message: 'Trip is archived, so Visa can’t be shared with it.',
    })
    w.storage.registry.update(w.trip.ledger.id, { archived: false })
    w.storage.registry.update(w.personal.ledger.id, { archived: true })
    expect(status(() => addMember(w.personal, w.ctxOf, w.visa, w.trip.ledger.id, TESTER))).toEqual({
      status: 400,
      message: 'Personal is archived. Restore it before sharing Visa.',
    })
    // Nothing was added by any of them.
    expect(w.personal.accountWide.ledgers(w.visa).map((l) => l.slug)).toEqual(['personal', 'family'])
  })

  it('takes out a ledger that holds nothing on it, and its institution when it has no other account', () => {
    const w = sharedWorld({ shareWith: ['family', 'trip'] })
    makeAccount(w.trip, 'Cash', 'cash', 0, 'TD')
    const sharing = removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    expect(sharing.members.map((m) => m.slug)).toEqual(['trip'])
    expect(listAccounts(w.family)).toEqual([])
    expect(listInstitutions(w.family)).toEqual([])
    expect(status(() => getAccount(w.family, w.visa))).toEqual({ status: 404, message: 'Account not found' })
    expect(summaries(w.personal)[0]).toBe('Stopped sharing Visa with Family')
    expect(summaries(w.family).slice(0, 2)).toEqual(['Removed the institution TD, which had no accounts left', 'Personal stopped sharing Visa with this ledger'])

    // Trip's TD still has its cash account.
    removeMember(w.personal, w.ctxOf, w.visa, w.trip.ledger.id, TESTER)
    expect(listInstitutions(w.trip).map((i) => [i.name, i.accountCount])).toEqual([['TD', 1]])
    expect(getSharing(w.personal, w.visa).members).toEqual([])
    expect(getAccount(w.personal, w.visa).sharing).toBeNull()

    // It can be shared again.
    w.share(w.family)
    expect(getAccount(w.family, w.visa).sharing?.isHome).toBe(false)
  })

  it('refuses to take out a ledger that still has something on it, or the home', () => {
    const w = sharedWorld()
    expect(status(() => removeMember(w.personal, w.ctxOf, w.visa, w.personal.ledger.id, TESTER))).toEqual({
      status: 400,
      message: 'Personal is Visa’s home, so it keeps the account.',
    })
    expect(status(() => removeMember(w.personal, w.ctxOf, w.visa, w.trip.ledger.id, TESTER))).toEqual({ status: 400, message: 'Visa isn’t shared with that ledger.' })

    const id = w.addTx(w.family, '2026-09-03', -500)
    expect(status(() => removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER))).toEqual({
      status: 409,
      message: 'Family still has 1 transaction on Visa, so it can’t stop sharing it yet.',
    })
    w.family.q.run('UPDATE transactions SET deleted_at = ? WHERE id = ? AND ledger_id = @ledger', '2026-10-01T00:00:00Z', id)
    w.family.q.run(
      `INSERT INTO recurring_items (ledger_id, name, payee_key, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
       VALUES (@ledger, 'Phone', 'phone', ?, -3000, 'monthly', '2026-01-01', '2026-10-01', 'active', 'manual')`,
      w.visa,
    )
    expect(status(() => removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER))).toEqual({
      status: 409,
      message: 'Family still has 1 transaction (1 deleted) and 1 recurring item on Visa, so it can’t stop sharing it yet.',
    })
    expect(getSharing(w.personal, w.visa).members.map((m) => m.slug)).toEqual(['family'])
  })
})

describe('a shared account in each ledger', () => {
  it('carries how it’s shared, and each ledger’s part: the home’s with the opening and recorded balances', () => {
    const w = sharedWorld({ opening: -1_000 })
    w.addTx(w.personal, '2026-09-01', -200)
    w.addTx(w.family, '2026-09-02', -300)
    w.addTx(w.family, '2026-09-03', -900, { deleted: true })
    const block = (isHome: boolean, totalBalanceMinor: number) => ({
      home: { slug: 'personal', name: 'Personal' },
      isHome,
      opening: { slug: 'personal', name: 'Personal' },
      ledgers: [
        { slug: 'personal', name: 'Personal' },
        { slug: 'family', name: 'Family' },
      ],
      totalBalanceMinor,
    })

    expect(getAccount(w.personal, w.visa)).toMatchObject({ openingBalanceMinor: -1_000, balanceMinor: -1_200, transactionCount: 1, sharing: block(true, -1_500) })
    expect(getAccount(w.family, w.visa)).toMatchObject({
      openingBalanceMinor: 0,
      balanceAsOf: null,
      balanceMinor: -300,
      transactionCount: 1,
      bank: null,
      sharing: block(false, -1_500),
    })

    // A recorded balance is the account's total on its day: the other ledgers' rows up to it are in it.
    setBalance(w.personal, w.visa, { date: '2026-09-05', balanceMinor: -1_600 })
    w.addTx(w.family, '2026-09-10', -50)
    w.addTx(w.personal, '2026-09-12', -25)
    const home = getAccount(w.personal, w.visa)
    const member = listAccounts(w.family).find((a) => a.id === w.visa)!
    expect(home).toMatchObject({ balanceAsOf: '2026-09-05', balanceMinor: -1_600 + 300 - 25, sharing: { totalBalanceMinor: -1_675 } })
    expect(member).toMatchObject({ balanceAsOf: null, openingBalanceMinor: 0, balanceMinor: -350, sharing: { totalBalanceMinor: -1_675 } })
    expect(home.balanceMinor + member.balanceMinor).toBe(-1_675)
    expect(getSharing(w.personal, w.visa)).toMatchObject({
      home: { balanceMinor: -1_325, transactionCount: 2 },
      members: [{ slug: 'family', balanceMinor: -350, transactionCount: 2 }],
      totalBalanceMinor: -1_675,
    })
  })

  it('has no sharing block when it isn’t shared', () => {
    const w = sharedWorld({ shareWith: [] })
    expect(getAccount(w.personal, w.visa).sharing).toBeNull()
    expect(listAccounts(w.personal).map((a) => a.sharing)).toEqual([null])
  })

  it('syncs into its home: the bank link stays the home’s, and the other ledgers have none', () => {
    const w = sharedWorld({ shareWith: ['family', 'trip'] })
    const app = w.storage.app.db
    app.insert(bankConnections).values({ id: 'c1', provider: 'simplefin', name: 'Bank', secret: 'x' }).run()
    app.insert(bankAccounts).values({ id: 'b1', connectionId: 'c1', remoteId: 'r1', name: 'Visa Infinite', currency: 'CAD', accountId: w.visa }).run()
    const bank = new BankService(w.storage)

    expect(getAccount(w.personal, w.visa).bank).toMatchObject({ bankAccountId: 'b1', name: 'Visa Infinite' })
    expect(getAccount(w.family, w.visa).bank).toBeNull()
    expect(getAccount(w.trip, w.visa).bank).toBeNull()
    expect(bank.linkedTo(w.personal.ledger.id, w.visa)?.id).toBe('b1')
    expect(bank.linkedTo(w.family.ledger.id, w.visa)).toBeUndefined()
    expect(bank.linkedTo(w.trip.ledger.id, w.visa)).toBeUndefined()
    expect(bank.available(w.personal.ledger.id).find((b) => b.id === 'b1')?.link).toMatchObject({ ledgerSlug: 'personal', accountId: w.visa, accountName: 'Visa' })
    expect(bank.available(w.family.ledger.id).map((b) => b.id)).toEqual([])
    expect(bank.available(w.trip.ledger.id).map((b) => b.id)).toEqual([])
  })

  it('leaves a ledger it isn’t shared with as it was: it doesn’t see the card or write to it', () => {
    const w = sharedWorld()
    const tripCard = makeAccount(w.trip, 'Visa', 'credit', 0, 'TD')
    w.addTx(w.personal, '2026-09-01', -200)
    w.addTx(w.family, '2026-09-02', -300)

    expect(listAccounts(w.trip).map((a) => [a.id, a.balanceMinor, a.sharing])).toEqual([[tripCard, 0, null]])
    expect(status(() => getAccount(w.trip, w.visa))).toEqual({ status: 404, message: 'Account not found' })
    expect(status(() => getSharing(w.trip, w.visa))).toEqual({ status: 404, message: 'Account not found' })
    expect(() => w.addTx(w.trip, '2026-09-03', -1, { account: w.visa })).toThrow('cross-ledger reference')
    // Nor do Personal and Family see Trip's own card.
    expect(status(() => getAccount(w.family, tripCard))).toEqual({ status: 404, message: 'Account not found' })
    expect(listAccounts(w.personal).map((a) => a.id)).toEqual([w.visa])
    // Family's part is only its own rows, and the home's only Personal's.
    expect(getAccount(w.personal, w.visa).balanceMinor).toBe(-200)
    expect(getAccount(w.family, w.visa).balanceMinor).toBe(-300)
    expect(w.personal.accountWide.sharedAccounts(w.trip.ledger.id)).toEqual([])
    expect(w.personal.accountWide.sharedAccounts(w.family.ledger.id)).toEqual([w.visa])
  })

  it('counts in each ledger that has it, in the ledger list', () => {
    const w = sharedWorld()
    const counts = Object.fromEntries(w.storage.registry.list().map((l) => [l.slug, l.accounts]))
    expect(counts).toEqual({ personal: 1, family: 1, trip: 0 })
    expect(w.storage.registry.toDTO(w.storage.registry.get('family')).accounts).toBe(1)
  })
})
