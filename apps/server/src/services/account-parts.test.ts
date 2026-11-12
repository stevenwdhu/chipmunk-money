import { describe, expect, it } from 'vitest'
import { accountBankSwitchSchema, activityQuerySchema, importCommitSchema, importPreviewSchema, transactionCreateSchema } from '@chipmunk/shared'
import { createApp } from '../app'
import { bankAccounts, bankConnections } from '../db/schema'
import { makeAccount } from '../test/helpers'
import { expectPartsSumToAccount, sharedWorld, TESTER, type SharedWorld } from '../test/shared-accounts'
import {
  accountHistory,
  balancesAt,
  deleteAccount,
  deleteSnapshot,
  getAccount,
  listAccounts,
  listSnapshots,
  requireManualBalance,
  saveImportMapping,
  setBalance,
  updateAccount,
} from './accounts'
import { BankService } from './bank/service'
import { reorder } from './categories'
import { commitImport, previewImport } from './import'
import { createInstitution, deleteInstitution, listInstitutions } from './institutions'
import { getSharing, removeMember } from './sharing'
import { listActivity } from './activity'
import { createTransaction } from './transactions'

/**
 * A shared account's balance in each ledger that has it (its parts) and its total, and what each
 * ledger can change of it. Rows another ledger holds are entered there by hand.
 */

const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    const err = e as { status?: number; message: string }
    return { status: err.status, message: err.message }
  }
  throw new Error('Expected it to be refused')
}

/** Visa synced from a bank account whose balance is `balanceMinor` on 3 October, kept but not yet taken in (`fill` takes it in). */
function linked(w: SharedWorld, balanceMinor: number) {
  const app = w.storage.app.db
  app.insert(bankConnections).values({ id: 'c1', provider: 'simplefin', name: 'Bank', secret: 'x' }).run()
  app
    .insert(bankAccounts)
    .values({ id: 'b1', connectionId: 'c1', remoteId: 'r1', name: 'Visa Infinite', currency: 'CAD', accountId: w.visa, balanceMinor, balanceDate: '2026-10-03T16:00:00Z', fetchedAt: '2026-10-03T16:00:00Z' })
    .run()
  return new BankService(w.storage)
}

describe('a shared account’s parts and total', () => {
  it('works out the worked example: each part is what its ledger holds, the opening ledger’s with the recorded balance', () => {
    const w = sharedWorld({ now: '2026-02-20T18:00:00Z' })
    w.addTx(w.personal, '2026-01-10', -100)
    w.addTx(w.family, '2026-01-15', -50)
    w.addTx(w.personal, '2026-01-20', -30)
    setBalance(w.personal, w.visa, { date: '2026-01-31', balanceMinor: -180 })
    w.addTx(w.personal, '2026-02-05', -40)
    w.addTx(w.family, '2026-02-10', -25)

    // Personal's part is −180 + 50 − 40: its own three rows.
    expect(expectPartsSumToAccount(w.storage, w.visa, { dates: ['2025-12-31', '2026-01-15', '2026-01-31'] })).toEqual({
      parts: { personal: -170, family: -75 },
      totalMinor: -245,
    })
    expect(getSharing(w.personal, w.visa)).toMatchObject({ home: { balanceMinor: -170 }, members: [{ balanceMinor: -75 }], totalBalanceMinor: -245 })
    expect(balancesAt(w.personal, ['2026-01-31']).get(w.visa)).toEqual([-130])
    expect(balancesAt(w.family, ['2026-01-31']).get(w.visa)).toEqual([-50])

    // The same rows on a card that isn't shared give the total, at every date.
    const twin = makeAccount(w.trip, 'Twin', 'credit', 0, 'TD')
    for (const [date, amount] of [
      ['2026-01-10', -100],
      ['2026-01-15', -50],
      ['2026-01-20', -30],
      ['2026-02-05', -40],
      ['2026-02-10', -25],
    ] as const) {
      w.addTx(w.trip, date, amount, { account: twin })
    }
    setBalance(w.trip, twin, { date: '2026-01-31', balanceMinor: -180 })
    const dates = ['2026-01-12', '2026-01-31', '2026-02-07', '2026-02-20']
    const parts = [w.personal, w.family].map((c) => balancesAt(c, dates).get(w.visa)!)
    expect(balancesAt(w.trip, dates).get(twin)).toEqual(dates.map((_, i) => parts[0]![i]! + parts[1]![i]!))
    expect(getAccount(w.trip, twin).balanceMinor).toBe(-245)
  })

  it('takes each past date’s part from the balance recorded by then, not the latest', () => {
    const w = sharedWorld({ now: '2026-06-10T18:00:00Z' })
    w.addTx(w.personal, '2026-03-05', -100)
    w.addTx(w.family, '2026-03-10', -200)
    setBalance(w.personal, w.visa, { date: '2026-03-31', balanceMinor: -320 })
    w.addTx(w.personal, '2026-04-05', -10)
    w.addTx(w.family, '2026-04-20', -30)
    setBalance(w.personal, w.visa, { date: '2026-05-31', balanceMinor: -400 })
    w.addTx(w.family, '2026-06-02', -5)

    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -170, family: -235 }, totalMinor: -405 })
    // On 30 April: −320 recorded on 31 March, Personal's −10 after it, less Family's −200 before it.
    expect(balancesAt(w.personal, ['2026-04-30']).get(w.visa)).toEqual([-130])
    expect(balancesAt(w.family, ['2026-04-30']).get(w.visa)).toEqual([-230])
    expect(accountHistory(w.personal, w.visa, 4, '2026-06-10').map((p) => [p.date, p.balanceMinor])).toEqual([
      ['2026-03-31', -120],
      ['2026-04-30', -130],
      ['2026-05-31', -170],
      ['2026-06-10', -170],
    ])
    expect(accountHistory(w.family, w.visa, 4, '2026-06-10').map((p) => p.balanceMinor)).toEqual([-200, -230, -230, -235])
  })

  it('with no recorded balance: the opening ledger’s part is the opening balance and its own rows', () => {
    const w = sharedWorld({ opening: -1_000, now: '2026-06-10T18:00:00Z' })
    w.addTx(w.personal, '2026-04-02', -100)
    w.addTx(w.family, '2026-04-12', -60)
    w.addTx(w.family, '2026-05-12', -40)
    w.addTx(w.family, '2026-05-13', -999, { deleted: true })
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -1_100, family: -100 }, totalMinor: -1_200 })
    expect(balancesAt(w.family, ['2026-04-30']).get(w.visa)).toEqual([-60])
    expect(getAccount(w.family, w.visa)).toMatchObject({ openingBalanceMinor: 0, balanceAsOf: null })
  })

  it('is 0 in every ledger before the opening date, and counts a row dated before it from then on', () => {
    const w = sharedWorld({ opening: -500, now: '2026-04-10T18:00:00Z' })
    w.personal.q.run("UPDATE accounts SET opening_date = '2026-03-01' WHERE id = ? AND ledger_id = @ledger", w.visa)
    w.addTx(w.family, '2026-02-20', -50)
    w.addTx(w.personal, '2026-03-05', -10)
    expect(expectPartsSumToAccount(w.storage, w.visa, { dates: ['2026-02-20', '2026-02-28', '2026-03-01', '2026-03-31'] })).toEqual({
      parts: { personal: -510, family: -50 },
      totalMinor: -560,
    })
    expect(balancesAt(w.family, ['2026-02-28', '2026-03-01']).get(w.visa)).toEqual([0, -50])
    expect(balancesAt(w.personal, ['2026-02-28', '2026-03-01']).get(w.visa)).toEqual([0, -500])
  })

  it('counts a row dated after today in the total, so the bank’s balance with it shows no difference', () => {
    const w = sharedWorld()
    w.addTx(w.personal, '2026-09-15', -100)
    w.addTx(w.family, '2026-10-10', -70)
    const bank = linked(w, -170)
    bank.fill(w.personal, w.visa)
    expect(getAccount(w.personal, w.visa)).toMatchObject({ openingBalanceMinor: 0, balanceAsOf: null, balanceMinor: -100, sharing: { totalBalanceMinor: -170 } })
    expect(listSnapshots(w.personal, w.visa)).toEqual([])
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -100, family: -70 }, totalMinor: -170 })
    // As the charts have it, today leaves out the later row.
    expect(balancesAt(w.family, ['2026-10-03']).get(w.visa)).toEqual([0])
  })

  it('records a balance by hand in the home, for every ledger: the other ledgers’ parts stay what they hold', () => {
    const w = sharedWorld({ opening: -1_000 })
    w.addTx(w.personal, '2026-09-01', -100)
    w.addTx(w.family, '2026-09-02', -300)
    w.addTx(w.family, '2026-10-05', -20)
    requireManualBalance(w.personal, w.visa)
    setBalance(w.personal, w.visa, { date: '2026-10-03', balanceMinor: -1_500 })
    // Personal: −1500, less Family's −300 up to the 3rd. Family's −20 is after it, in the total.
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -1_200, family: -320 }, totalMinor: -1_520 })
    expect(getAccount(w.personal, w.visa)).toMatchObject({ balanceAsOf: '2026-10-03', openingBalanceMinor: -1_000 })
  })

  it('takes the bank’s balance as the total: a row Family entered by hand that the bank doesn’t have lands in the opening ledger', () => {
    // No recorded balance: the opening balance takes up the difference.
    const w = sharedWorld()
    w.addTx(w.personal, '2026-09-10', -100)
    w.addTx(w.family, '2026-10-01', -40)
    linked(w, -100).fill(w.personal, w.visa)
    expect(getAccount(w.personal, w.visa)).toMatchObject({ openingBalanceMinor: 40, balanceAsOf: null })
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -60, family: -40 }, totalMinor: -100 })

    // With one recorded, the bank's balance is recorded.
    const r = sharedWorld()
    r.addTx(r.personal, '2026-09-10', -100)
    setBalance(r.personal, r.visa, { date: '2026-09-30', balanceMinor: -100 })
    r.addTx(r.family, '2026-10-01', -40)
    linked(r, -100).fill(r.personal, r.visa)
    expect(listSnapshots(r.personal, r.visa).map((s) => [s.date, s.balanceMinor, s.source])).toEqual([
      ['2026-10-03', -100, 'sync'],
      ['2026-09-30', -100, 'manual'],
    ])
    expect(getAccount(r.personal, r.visa).openingBalanceMinor).toBe(0)
    expect(expectPartsSumToAccount(r.storage, r.visa)).toEqual({ parts: { personal: -60, family: -40 }, totalMinor: -100 })

    // Taken in again with nothing new, there's no difference.
    r.storage.app.db.update(bankAccounts).set({ lastSyncedAt: null }).run()
    new BankService(r.storage).fill(r.personal, r.visa)
    expect(listSnapshots(r.personal, r.visa)).toHaveLength(2)
  })

  it('adds up in three ledgers', () => {
    const w = sharedWorld({ shareWith: ['family', 'trip'], opening: -250, now: '2026-08-15T18:00:00Z' })
    w.addTx(w.personal, '2026-06-03', -100)
    w.addTx(w.family, '2026-06-08', -80)
    w.addTx(w.trip, '2026-06-20', -400)
    setBalance(w.personal, w.visa, { date: '2026-06-30', balanceMinor: -900 })
    w.addTx(w.trip, '2026-07-02', -15)
    w.addTx(w.family, '2026-07-09', -5)
    w.addTx(w.personal, '2026-08-01', 200)
    w.addTx(w.trip, '2026-08-02', -1, { deleted: true })
    // Personal: −900, less Family's −80 and Trip's −400, plus its own 200 after.
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -220, family: -85, trip: -415 }, totalMinor: -720 })
    expect(getSharing(w.personal, w.visa).members.map((m) => [m.slug, m.balanceMinor])).toEqual([
      ['family', -85],
      ['trip', -415],
    ])
  })

  it('leaves an account that isn’t shared as it was', () => {
    const w = sharedWorld({ shareWith: [], opening: -300 })
    w.addTx(w.personal, '2026-08-01', -100)
    setBalance(w.personal, w.visa, { date: '2026-08-31', balanceMinor: -450 })
    w.addTx(w.personal, '2026-09-05', -50)
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -500 }, totalMinor: -500 })
  })
})

describe('changing a shared account in a ledger it’s shared with', () => {
  const home = (what: string) => ({ status: 409, message: `Visa’s home is Personal. ${what}` })

  it('keeps its institution, place and archive per ledger, and its own fields in the home', () => {
    const w = sharedWorld({ opening: -1_000 })
    makeAccount(w.family, 'Joint', 'chequing', 0, 'Credit union')

    expect(updateAccount(w.family, w.visa, { institution: 'Credit union', sort: 7, archived: true })).toMatchObject({
      institution: 'Credit union',
      sort: 7,
      archived: true,
    })
    expect(getAccount(w.personal, w.visa)).toMatchObject({ institution: 'TD', sort: 0, archived: false })
    // Its own fields, sent as they are, change nothing and are no reason to refuse.
    expect(updateAccount(w.family, w.visa, { name: 'Visa', type: 'credit', openingBalanceMinor: -1_000, notes: null, archived: false })).toMatchObject({ archived: false })

    const own = home('Its name, type, opening balance and notes are changed there.')
    expect(status(() => updateAccount(w.family, w.visa, { name: 'Family Visa' }))).toEqual(own)
    expect(status(() => updateAccount(w.family, w.visa, { openingBalanceMinor: 0 }))).toEqual(own)
    expect(status(() => updateAccount(w.family, w.visa, { notes: 'Ours', sort: 1 }))).toEqual(own)
    expect(getAccount(w.family, w.visa)).toMatchObject({ sort: 7, notes: null })

    expect(status(() => updateAccount(w.personal, w.visa, { type: 'chequing' }))).toEqual({ status: 409, message: 'Visa is shared with other ledgers, so its type can’t change.' })
    updateAccount(w.personal, w.visa, { name: 'Visa Infinite', notes: 'The joint card' })
    expect(getAccount(w.family, w.visa)).toMatchObject({ name: 'Visa Infinite', notes: 'The joint card', institution: 'Credit union' })

    // Not shared any more, its type can change again.
    removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    expect(updateAccount(w.personal, w.visa, { type: 'chequing' }).type).toBe('chequing')
  })

  it('leaves no new institution behind when an edit that names one is refused, over the API', async () => {
    const w = sharedWorld()
    const app = createApp(w.storage)
    const patch = (ctx: typeof w.family, body: unknown) =>
      app.request(`/api/v1/ledgers/${ctx.ledger.slug}/accounts/${w.visa}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify(body),
      })
    const state = (ctx: typeof w.family) => ({
      institutions: listInstitutions(ctx).map((i) => i.name),
      activity: listActivity(ctx, activityQuerySchema.parse({})).items.length,
      account: getAccount(ctx, w.visa),
    })
    for (const [ctx, body, message] of [
      [w.family, { institution: 'Credit union', name: 'Family Visa' }, 'Visa’s home is Personal. Its name, type, opening balance and notes are changed there.'],
      [w.personal, { institution: 'Credit union', type: 'chequing' }, 'Visa is shared with other ledgers, so its type can’t change.'],
    ] as const) {
      const before = state(ctx)
      const res = await patch(ctx, body)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message)
      expect(state(ctx)).toEqual(before)
    }
    // Allowed, the same edit adds the institution and logs it.
    const res = await patch(w.family, { institution: 'Credit union' })
    expect(res.status).toBe(200)
    expect(listInstitutions(w.family).map((i) => i.name)).toEqual(['Credit union'])
    expect(listActivity(w.family, activityQuerySchema.parse({})).items.map((e) => e.summary)).toContain('Added the institution Credit union')
  })

  it('reorders and moves it between institutions on its own row', () => {
    const w = sharedWorld()
    const joint = makeAccount(w.family, 'Joint', 'chequing', 0, 'Credit union')
    const cash = makeAccount(w.personal, 'Cash', 'cash')
    reorder(w.personal, 'accounts', [cash, w.visa])
    reorder(w.family, 'accounts', [w.visa, joint])
    // Each ledger's place is its own: Visa is second in Personal and first in Family.
    expect(listAccounts(w.family).map((a) => [a.name, a.sort])).toEqual([
      ['Visa', 0],
      ['Joint', 1],
    ])
    expect(listAccounts(w.personal).map((a) => [a.name, a.sort])).toEqual([
      ['Cash', 0],
      ['Visa', 1],
    ])

    const td = listInstitutions(w.family).find((i) => i.name === 'TD')!
    const union = listInstitutions(w.family).find((i) => i.name === 'Credit union')!
    deleteInstitution(w.family, td.id, union.id)
    expect(listInstitutions(w.family).map((i) => [i.name, i.accountCount])).toEqual([['Credit union', 2]])
    expect(getAccount(w.family, w.visa).institution).toBe('Credit union')
    expect(getAccount(w.personal, w.visa).institution).toBe('TD')

    const other = createInstitution(w.family, { name: 'Other' })
    expect(status(() => deleteInstitution(w.family, union.id))).toMatchObject({ status: 409 })
    deleteInstitution(w.family, union.id, other.id)
    expect(getAccount(w.family, w.visa).institution).toBe('Other')
  })

  it('leaves its balance to the home: recorded balances are the home’s, and the other ledgers list none', () => {
    const w = sharedWorld()
    const balance = home('Its balance is updated there.')
    expect(status(() => setBalance(w.family, w.visa, { date: '2026-10-01', balanceMinor: -5 }))).toEqual(balance)
    expect(status(() => requireManualBalance(w.family, w.visa))).toEqual(balance)
    setBalance(w.personal, w.visa, { date: '2026-10-01', balanceMinor: -5 })
    const [snap] = listSnapshots(w.personal, w.visa)
    expect(listSnapshots(w.family, w.visa)).toEqual([])
    expect(status(() => deleteSnapshot(w.family, w.visa, snap!.id))).toEqual(balance)
    expect(listSnapshots(w.personal, w.visa)).toHaveLength(1)
    deleteSnapshot(w.personal, w.visa, snap!.id)
    expect(listSnapshots(w.personal, w.visa)).toEqual([])
  })

  it('leaves CSV imports and bank sync to the home', () => {
    const w = sharedWorld()
    const rows = [{ line: 1, date: '2026-09-01', payee: 'Shop', amountMinor: -100 }]
    const csv = home('CSV files are imported into it there.')
    expect(status(() => previewImport(w.family, importPreviewSchema.parse({ accountId: w.visa, rows })))).toEqual(csv)
    expect(status(() => commitImport(w.family, importCommitSchema.parse({ accountId: w.visa, rows }), { background: false }))).toEqual(csv)
    expect(status(() => saveImportMapping(w.family, w.visa, { date: 0, payee: 1, amount: 2 } as never))).toEqual(csv)
    expect(previewImport(w.personal, importPreviewSchema.parse({ accountId: w.visa, rows }))).toHaveLength(1)

    const bank = linked(w, -100)
    w.storage.app.db.insert(bankAccounts).values({ id: 'b2', connectionId: 'c1', remoteId: 'r2', name: 'Other card', currency: 'CAD' }).run()
    const sync = home('Its bank sync is set up there.')
    expect(status(() => bank.linkAccount(w.family, w.visa, { bankAccountId: 'b2' }, null))).toEqual(sync)
    expect(status(() => bank.fill(w.family, w.visa))).toEqual(sync)
    expect(status(() => bank.unlinkAccount(w.family, w.visa))).toEqual(sync)
    expect(status(() => bank.previewSwitch(w.family, w.visa, { bankAccountId: 'b2' }, null))).toEqual(sync)
    expect(status(() => bank.switchAccount(w.family, w.visa, accountBankSwitchSchema.parse({ bankAccountId: 'b2', from: '2026-01-01', version: 'v', pairs: [] }), null))).toEqual(sync)
    expect(bank.linkedTo(w.personal.ledger.id, w.visa)?.id).toBe('b1')
    expect(bank.unlinkAccount(w.personal, w.visa).id).toBe('b1')
  })

  it('takes a transaction entered by hand, in its part', async () => {
    const w = sharedWorld({ opening: -1_000 })
    const t = await createTransaction(w.family, transactionCreateSchema.parse({ accountId: w.visa, date: '2026-09-20', amountMinor: -1_200, payee: 'Groceries' }), {
      useAi: false,
    })
    expect(t).toMatchObject({ accountId: w.visa, amountMinor: -1_200 })
    expect(getAccount(w.family, w.visa)).toMatchObject({ balanceMinor: -1_200, transactionCount: 1 })
    expect(getAccount(w.personal, w.visa)).toMatchObject({ balanceMinor: -1_000, transactionCount: 0 })
    expect(expectPartsSumToAccount(w.storage, w.visa)).toEqual({ parts: { personal: -1_000, family: -1_200 }, totalMinor: -2_200 })
  })

  it('isn’t deleted while shared, in any ledger that has it', () => {
    const w = sharedWorld()
    const stop = { status: 409, message: 'Stop sharing Visa first.' }
    expect(status(() => deleteAccount(w.family, w.ctxOf, w.visa))).toEqual(stop)
    expect(status(() => deleteAccount(w.personal, w.ctxOf, w.visa))).toEqual(stop)
    expect(getAccount(w.family, w.visa).sharing).not.toBeNull()
    removeMember(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    deleteAccount(w.personal, w.ctxOf, w.visa)
    expect(listAccounts(w.personal)).toEqual([])
  })
})
