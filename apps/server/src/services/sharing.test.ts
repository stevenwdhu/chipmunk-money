import { describe, expect, it } from 'vitest'
import { activityQuerySchema } from '@chipmunk/shared'
import { bankAccounts, bankConnections } from '../db/schema'
import { clearForDemo } from '../db/seed-demo'
import { makeAccount } from '../test/helpers'
import { expectPartsSumToAccount, sharedWorld, TESTER, type SharedWorld } from '../test/shared-accounts'
import { createAccount, getAccount, listAccounts, setBalance } from './accounts'
import { listActivity } from './activity'
import { applyRemoteTransactions } from './bank/apply'
import { BankService } from './bank/service'
import type { RemoteTransaction } from './bank/types'
import type { AppContext } from './context'
import { listInstitutions } from './institutions'
import { moveTransactions } from './moves'
import { eraseAll } from './setup'
import { addMember, balanceWords, changeWords, getSharing, removeMember, setSharing, stepWords } from './sharing'

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
    // A home can't be archived while it's the home (the questions ask for another first): set as it would be if it were.
    w.storage.sqlite.prepare("UPDATE ledgers SET archived_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(w.personal.ledger.id)
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

  it('asks where the transactions of a ledger taken out go, and refuses to take out the home', () => {
    const w = sharedWorld()
    expect(status(() => removeMember(w.personal, w.ctxOf, w.visa, w.personal.ledger.id, TESTER))).toEqual({
      status: 400,
      message: 'Personal is Visa’s home, so it keeps the account.',
    })
    expect(status(() => removeMember(w.personal, w.ctxOf, w.visa, w.trip.ledger.id, TESTER))).toEqual({ status: 400, message: 'Visa isn’t shared with that ledger.' })

    const id = w.addTx(w.family, '2026-09-03', -500)
    w.addTx(w.family, '2026-09-04', -600)
    const ask = (message: string) => expect(status(() => removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER))).toEqual({ status: 400, message })
    ask('Say whether Family’s 2 transactions go home or stay in Family.')
    w.family.q.run('DELETE FROM transactions WHERE ledger_id = @ledger AND id <> ?', id)
    ask('Say whether Family’s 1 transaction goes home or stays in Family.')
    // Deleted ones count: they go home too, still deleted.
    w.family.q.run('UPDATE transactions SET deleted_at = ? WHERE id = ? AND ledger_id = @ledger', '2026-10-01T00:00:00Z', id)
    ask('Say whether Family’s 1 deleted transaction goes home or stays in Family.')
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

describe('deleting, erasing or clearing a ledger that has a shared account', () => {
  /** Each way a ledger's data goes: deleting it, erasing it in the app, and clearing it for the demo. */
  const ways = (w: SharedWorld, ctx: AppContext) => ({
    delete: () => w.storage.registry.remove(ctx.ledger.id),
    erase: () => eraseAll(w.storage, ctx),
    seed: () => clearForDemo(w.storage, ctx),
  })
  const ask = { status: 409, message: 'Answer the questions first' }
  const inApp = (account: string, other: string) => ({ status: 409, message: `${account} is shared with ${other}. Erase this ledger in the app first.` })

  it('asks the home its questions first, and the demo seeding refuses it, before anything changes', () => {
    const w = sharedWorld()
    w.addTx(w.personal, '2026-09-01', -200)
    w.addTx(w.family, '2026-09-02', -300)
    const way = ways(w, w.personal)
    expect(status(way.delete)).toEqual(ask)
    expect(status(way.erase)).toEqual(ask)
    expect(status(way.seed)).toEqual(inApp('Visa', 'Family'))
    expect(w.storage.registry.find(w.personal.ledger.id)).toBeDefined()
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -200, family: -300 }, totalMinor: -500 })
  })

  it('asks a ledger the account is shared with what happens to its transactions, and the demo seeding refuses it, naming the home', () => {
    const w = sharedWorld({ opening: -1_000 })
    w.addTx(w.family, '2026-09-02', -300)
    const way = ways(w, w.family)
    expect(status(way.delete)).toEqual(ask)
    expect(status(way.erase)).toEqual(ask)
    expect(status(way.seed)).toEqual(inApp('Visa', 'Personal'))
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -1_000, family: -300 }, totalMinor: -1_300 })
  })

  it('names the first other ledger when the home shares it with several', () => {
    const w = sharedWorld({ shareWith: ['trip', 'family'] })
    expect(status(ways(w, w.personal).seed)).toEqual(inApp('Visa', 'Family'))
  })

  it('leaves a ledger with no shared account, and an account that isn’t shared, as they were', () => {
    const w = sharedWorld({ shareWith: [] })
    w.addTx(w.personal, '2026-09-01', -200)
    expect(ways(w, w.personal).erase()).toEqual({ backup: null, changes: ['Personal’s data was erased.'] })
    expect(listAccounts(w.personal)).toEqual([])
  })

  it('clears a ledger for the demo that kept its rows on an account of its own: the account it was split off from keeps their bank ids', () => {
    const w = sharedWorld()
    const sent: RemoteTransaction[] = [
      { remoteId: 'k1', date: '2026-09-20', amountMinor: -9_000, payee: 'Book Shop', description: 'BOOK SHOP', pending: false },
      { remoteId: 'k2', date: '2026-09-21', amountMinor: -1_200, payee: 'Gas Bar', description: 'GAS BAR', pending: false },
    ]
    const sync = () => applyRemoteTransactions(w.personal, w.ctxOf, w.visa, sent, { from: '2026-07-05', to: '2026-10-03', floor: null }, 'simplefin')
    expect(sync()).toMatchObject({ added: 2 })
    const k1 = w.personal.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND external_id = 'k1'")!
    moveTransactions(w.personal, w.ctxOf, { ids: [k1], to: w.family.ledger.id }, TESTER)
    setSharing(w.personal, w.ctxOf, w.visa, { ledgers: ['personal'], rows: { family: 'keep' } }, { actor: TESTER, usable: null })
    expect(sync()).toMatchObject({ added: 0 })
    const kept = () => w.personal.q.column<string>('SELECT external_id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND bank_id_only = 1', w.visa)
    expect(kept()).toEqual([])

    // Visa isn't shared any more, so the seeding goes ahead, and leaves k1's bank id with it first.
    clearForDemo(w.storage, w.family)
    expect(listAccounts(w.family)).toEqual([])
    expect(kept()).toEqual(['k1'])
    expect(sync()).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    expect(w.personal.q.column('SELECT external_id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NULL', w.visa)).toEqual(['k2'])
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  for (const way of ['delete', 'erase'] as const) {
    it(`lets a ledger the account is only shared with go without a question when it holds nothing on it (${way}): its member row goes, the home's rows stay`, () => {
      const w = sharedWorld({ opening: -1_000 })
      w.addTx(w.personal, '2026-09-01', -200)
      ways(w, w.family)[way]()
      expect(w.personal.accountWide.ledgers(w.visa).map((l) => l.slug)).toEqual(['personal'])
      expect(getSharing(w.personal, w.visa)).toMatchObject({ members: [], totalBalanceMinor: -1_200 })
      expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -1_200 }, totalMinor: -1_200 })
    })
  }
})

describe('a balance in words', () => {
  const visa = { name: 'Visa', type: 'credit', currency: 'CAD' } as const
  const savings = { name: 'Savings', type: 'savings', currency: 'CAD' } as const

  it('is what’s owed on a credit card, as its page shows it', () => {
    expect(balanceWords(-20_000, visa)).toBe('$200.00 owed')
    expect(balanceWords(0, visa)).toBe('$0.00 owed')
    expect(balanceWords(500, visa)).toBe('$5.00 in credit')
    expect(changeWords('Personal', -20_000, visa)).toBe('Personal owes $200.00 more on Visa')
    expect(changeWords('Personal', 5_000, visa, true)).toBe('Personal owes $50.00 less on Visa')
    expect(stepWords(-25_500, visa)).toBe('$255.00 more')
    expect(stepWords(-25_500, visa, true)).toBe('another $255.00 more')
    expect(stepWords(5_000, visa, true)).toBe('another $50.00 less')
  })

  it('is the balance itself on an account that isn’t a debt', () => {
    expect(balanceWords(-20_000, savings)).toBe('-$200.00')
    expect(changeWords('Personal', 20_000, savings)).toBe('Personal’s balance on Savings goes up by $200.00')
    expect(changeWords('Personal', -5_000, savings, true)).toBe('Personal’s balance on Savings went down by $50.00')
    expect(stepWords(-5_000, savings)).toBe('down by $50.00')
    expect(stepWords(5_000, savings, true)).toBe('up by another $50.00')
  })
})
