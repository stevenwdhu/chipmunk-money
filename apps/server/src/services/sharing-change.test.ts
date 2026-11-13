import { describe, expect, it } from 'vitest'
import { addDays, importCommitSchema, importPreviewSchema, transactionCreateSchema } from '@chipmunk/shared'
import type { LlmCategorizer } from '../ai/types'
import { bankAccounts, bankConnections } from '../db/schema'
import { categoryId, makeAccount } from '../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER, type SharedWorld } from '../test/shared-accounts'
import { ledgerRows } from '../test/world'
import { balancesAt, deleteAccount, getAccount, listAccounts, listSnapshots, saveImportMapping, setBalance, updateAccount } from './accounts'
import { BankService } from './bank/service'
import type { AppContext } from './context'
import { commitImport, previewImport } from './import'
import { listInstitutions } from './institutions'
import { setLinks } from './links'
import { MOVE_LIMIT } from './moves'
import { changeHome, getSharing, removeMember, setSharing, type SharingInput } from './sharing'
import { createTransaction, getTransaction, updateTransaction } from './transactions'

/**
 * Changing a shared account's home, stopping sharing it with a ledger whose transactions go home,
 * and setSharing, which does adds, the home change and removes in one transaction. Personal is
 * Visa's home, Family has it, and Trip has it when the test shares it.
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

const ai = (asked: string[]): LlmCategorizer => async (req) => {
  asked.push(req.payee)
  return { category: 'Dine out', confidence: 0.9, slot: 'primary', model: 'm' }
}
const settle = () => new Promise((r) => setTimeout(r, 20))

function world(opts: Parameters<typeof sharedWorld>[0] = {}) {
  const w = sharedWorld(opts)
  const set = (ctx: AppContext, input: SharingInput, dryRun = false) => setSharing(ctx, w.ctxOf, w.visa, input, { dryRun, actor: TESTER, usable: null })
  /** What every sharing change leaves: the parts sum to the account, and nothing refers across ledgers. */
  const check = () => {
    const parts = expectPartsSumToAccount(w.storage, w.visa)
    expectNoCrossLedgerReferences(w.storage)
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
    return parts
  }
  /** Every row of these ledgers, activity included. */
  const everything = (...ctxs: AppContext[]) => ctxs.map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
  /** Each ledger's part at these dates, by slug. */
  const partsAt = (dates: string[]) => Object.fromEntries([w.personal, w.family, w.trip].map((c) => [c.ledger.slug, balancesAt(c, dates).get(w.visa) ?? null]))
  const activity = (ctx: AppContext, action: string) => ctx.q.column<string>('SELECT summary FROM activity WHERE ledger_id = @ledger AND action = ? ORDER BY id', action)
  return { ...w, set, check, everything, partsAt, activity }
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

const MONTH_ENDS = ['2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']

describe('changing the home', () => {
  it('leaves every part as it was, today and at every past date, with and without recorded balances, in three ledgers', () => {
    for (const recorded of [false, true]) {
      const w = world({ shareWith: ['family', 'trip'], opening: -10_000 })
      const { personal, family, trip } = w
      for (const [ctx, date, amount] of [
        [personal, '2026-01-20', -1000],
        [family, '2026-02-10', -2500],
        [trip, '2026-03-15', -400],
        [personal, '2026-04-05', -700],
        [family, '2026-06-02', -300],
        [personal, '2026-07-12', 5000],
        [trip, '2026-08-20', -900],
        [family, '2026-09-25', -60],
      ] as const) {
        w.addTx(ctx, date, amount)
      }
      w.addTx(family, '2026-05-05', -9999, { deleted: true })
      if (recorded) {
        setBalance(personal, w.visa, { date: '2026-03-31', balanceMinor: -14_000 })
        setBalance(personal, w.visa, { date: '2026-07-31', balanceMinor: -11_000 })
      }
      const before = { today: w.check(), past: w.partsAt(MONTH_ENDS), dto: getAccount(personal, w.visa) }

      const sharing = changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
      expect(sharing).toMatchObject({ home: { slug: 'family' }, opening: { slug: 'personal' }, members: [{ slug: 'personal' }, { slug: 'trip' }] })
      expect(w.check(), recorded ? 'with recorded balances' : 'without').toEqual(before.today)
      expect(w.partsAt(MONTH_ENDS)).toEqual(before.past)
      expect(sharing.totalBalanceMinor).toBe(before.today.totalMinor)

      // The account's own settings and recorded balances show in the new home, and none in the old one.
      expect(getAccount(family, w.visa)).toMatchObject({
        openingBalanceMinor: -10_000,
        balanceAsOf: before.dto.balanceAsOf,
        sharing: { isHome: true, home: { slug: 'family' }, opening: { slug: 'personal' } },
      })
      expect(getAccount(personal, w.visa)).toMatchObject({ openingBalanceMinor: 0, balanceAsOf: null, sharing: { isHome: false } })
      expect(listSnapshots(family, w.visa)).toHaveLength(recorded ? 2 : 0)
      expect(listSnapshots(personal, w.visa)).toEqual([])
      // Each keeps its own institution and place.
      expect(getAccount(personal, w.visa)).toMatchObject({ institution: 'TD', institutionId: before.dto.institutionId, sort: 0 })
      expect(getAccount(family, w.visa).institution).toBe('TD')

      expect(w.activity(personal, 'change_home')).toEqual(['Made Family Visa’s home'])
      expect(w.activity(family, 'change_home')).toEqual(['Personal made this ledger Visa’s home'])
    }
  })

  it('makes the new home where things are done: balances, settings, imports and sharing, the old home answering 409 naming it', async () => {
    const w = world({ opening: -1_000 })
    const { personal, family } = w
    w.addTx(personal, '2026-09-01', -200)
    changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
    const home = (what: string) => ({ status: 409, message: `Visa’s home is Family. ${what}` })

    // A row entered by hand, in either.
    for (const ctx of [family, personal]) {
      await createTransaction(ctx, transactionCreateSchema.parse({ accountId: w.visa, date: '2026-09-20', amountMinor: -500, payee: 'Groceries' }), { useAi: false })
    }
    expect(w.check().parts).toEqual({ family: -500, personal: -1_700 })

    // The balance, in the new home only: a recorded balance with a gap lands in the opening ledger, Personal.
    expect(status(() => setBalance(personal, w.visa, { date: '2026-09-30', balanceMinor: -3_000 }))).toEqual(home('Its balance is updated there.'))
    setBalance(family, w.visa, { date: '2026-09-30', balanceMinor: -3_000 })
    expect(w.check()).toEqual({ parts: { family: -500, personal: -2_500 }, totalMinor: -3_000 })

    // Its own settings.
    expect(status(() => updateAccount(personal, w.visa, { name: 'Visa Infinite' }))).toEqual(home('Its name, type, opening balance and notes are changed there.'))
    expect(updateAccount(family, w.visa, { name: 'Visa Infinite' }).name).toBe('Visa Infinite')
    const visaHome = (what: string) => ({ status: 409, message: `Visa Infinite’s home is Family. ${what}` })
    expect(status(() => saveImportMapping(personal, w.visa, { date: 0, payee: 1, amount: 2 } as never))).toEqual(visaHome('CSV files are imported into it there.'))
    saveImportMapping(family, w.visa, { date: 0, payee: 1, amount: 2 } as never)
    expect(getAccount(family, w.visa).importMapping).toEqual({ date: 0, payee: 1, amount: 2 })
    expect(status(() => getSharing(personal, w.visa))).toEqual(visaHome('Its sharing is changed there.'))

    // A CSV lands in the new home, with its import batch there.
    const rows = [{ line: 1, date: '2026-10-01', payee: 'Hardware', amountMinor: -800 }]
    expect(status(() => previewImport(personal, importPreviewSchema.parse({ accountId: w.visa, rows })))).toEqual(visaHome('CSV files are imported into it there.'))
    const imported = commitImport(family, importCommitSchema.parse({ accountId: w.visa, rows }), { background: false })
    expect(imported.imported).toBe(1)
    expect(family.q.pluck("SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND payee = 'Hardware' AND import_batch_id IS NOT NULL")).toBe(1)
    expect(w.check().parts).toEqual({ family: -1_300, personal: -2_500 })
  })

  it('puts a gap with the bank in the opening ledger, the old home, with and without a recorded balance; the bank link follows the home', () => {
    // No recorded balance: the opening balance takes up the difference, and Personal's part carries it.
    const w = world()
    const synced = w.addTx(w.personal, '2026-09-10', -100)
    const bank = linked(w, -100)
    w.personal.q.run("INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (?, 'simplefin', 'p1', ?, 'added', '{}')", w.visa, synced)
    changeHome(w.personal, w.ctxOf, w.visa, w.family.ledger.id, TESTER)
    // The payload's row is held outside the home now, so it points at none.
    expect(w.family.q.all('SELECT remote_id, transaction_id FROM bank_payloads WHERE account_id IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger)')).toEqual([
      { remote_id: 'p1', transaction_id: null },
    ])
    expect(getAccount(w.family, w.visa).bank).toMatchObject({ bankAccountId: 'b1' })
    expect(getAccount(w.personal, w.visa).bank).toBeNull()
    expect(bank.linkedTo(w.family.ledger.id, w.visa)?.id).toBe('b1')
    expect(bank.linkedTo(w.personal.ledger.id, w.visa)).toBeUndefined()
    expect(bank.available(w.family.ledger.id).find((b) => b.id === 'b1')?.link).toMatchObject({ ledgerSlug: 'family', accountId: w.visa })
    expect(status(() => bank.fill(w.personal, w.visa))).toEqual({ status: 409, message: 'Visa’s home is Family. Its bank sync is set up there.' })

    w.addTx(w.family, '2026-10-01', -40)
    bank.fill(w.family, w.visa)
    expect(getAccount(w.family, w.visa)).toMatchObject({ openingBalanceMinor: 40, balanceAsOf: null })
    expect(w.check()).toEqual({ parts: { personal: -60, family: -40 }, totalMinor: -100 })

    // With one recorded, the bank's balance is recorded, in the new home.
    const r = world()
    r.addTx(r.personal, '2026-09-10', -100)
    setBalance(r.personal, r.visa, { date: '2026-09-30', balanceMinor: -100 })
    const rBank = linked(r, -100)
    changeHome(r.personal, r.ctxOf, r.visa, r.family.ledger.id, TESTER)
    r.addTx(r.family, '2026-10-01', -40)
    rBank.fill(r.family, r.visa)
    expect(listSnapshots(r.family, r.visa).map((s) => [s.date, s.balanceMinor, s.source])).toEqual([
      ['2026-10-03', -100, 'sync'],
      ['2026-09-30', -100, 'manual'],
    ])
    expect(getAccount(r.family, r.visa).openingBalanceMinor).toBe(0)
    expect(r.check()).toEqual({ parts: { personal: -60, family: -40 }, totalMinor: -100 })
  })

  it('changes twice, and back: the old home stays the opening ledger until it is the home again', () => {
    const w = world({ shareWith: ['family', 'trip'], opening: -500 })
    const { personal, family, trip } = w
    w.addTx(personal, '2026-03-01', -100)
    w.addTx(family, '2026-04-01', -200)
    w.addTx(trip, '2026-05-01', -300)
    setBalance(personal, w.visa, { date: '2026-05-31', balanceMinor: -1_200 })
    w.addTx(trip, '2026-06-01', -50)
    updateAccount(family, w.visa, { sort: 4 })
    updateAccount(trip, w.visa, { sort: 9, archived: true })
    const before = { today: w.check(), past: w.partsAt(MONTH_ENDS) }
    const institutions = [personal, family, trip].map((c) => getAccount(c, w.visa).institutionId)
    const opening = () => personal.q.pluck('SELECT opening_ledger_id FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', w.visa)
    const raw = () => w.storage.sqlite.prepare('SELECT ledger_id AS home, opening_ledger_id AS opening FROM accounts WHERE id = ?').get(w.visa)

    changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
    expect(raw()).toEqual({ home: family.ledger.id, opening: personal.ledger.id })
    // From one member to another: Personal keeps it.
    changeHome(family, w.ctxOf, w.visa, trip.ledger.id, TESTER)
    expect(raw()).toEqual({ home: trip.ledger.id, opening: personal.ledger.id })
    expect(getAccount(trip, w.visa)).toMatchObject({ sort: 9, archived: true, openingBalanceMinor: -500, balanceAsOf: '2026-05-31' })
    expect(w.check()).toEqual(before.today)
    expect(w.partsAt(MONTH_ENDS)).toEqual(before.past)
    // Home again: it's the opening ledger as the home, so none named.
    changeHome(trip, w.ctxOf, w.visa, personal.ledger.id, TESTER)
    expect(raw()).toEqual({ home: personal.ledger.id, opening: null })
    expect(opening()).toBe(personal.ledger.id)
    expect(w.check()).toEqual(before.today)
    expect(w.partsAt(MONTH_ENDS)).toEqual(before.past)
    expect([personal, family, trip].map((c) => getAccount(c, w.visa).institutionId)).toEqual(institutions)
    expect([personal, family, trip].map((c) => [getAccount(c, w.visa).sort, getAccount(c, w.visa).archived])).toEqual([
      [0, false],
      [4, false],
      [9, true],
    ])
    // And to the opening ledger itself, when it isn't the home: it is the home and the opening ledger, so none named.
    changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
    changeHome(family, w.ctxOf, w.visa, personal.ledger.id, TESTER)
    expect(raw()).toEqual({ home: personal.ledger.id, opening: null })
    expect(w.check()).toEqual(before.today)
  })

  it('refuses a member asking, the home itself, a ledger it isn’t shared with and an archived one, with nothing changed', () => {
    const w = world()
    const { personal, family, trip, storage } = w
    w.addTx(family, '2026-09-01', -100)
    const before = w.everything(personal, family, trip)
    expect(status(() => changeHome(family, w.ctxOf, w.visa, family.ledger.id, TESTER))).toEqual({ status: 409, message: 'Visa’s home is Personal. Its sharing is changed there.' })
    expect(status(() => changeHome(personal, w.ctxOf, w.visa, personal.ledger.id, TESTER))).toEqual({ status: 400, message: 'Personal is Visa’s home already.' })
    expect(status(() => changeHome(personal, w.ctxOf, w.visa, trip.ledger.id, TESTER))).toEqual({ status: 400, message: 'Visa isn’t shared with that ledger.' })
    expect(status(() => changeHome(personal, w.ctxOf, w.visa, 'no-such-ledger', TESTER))).toEqual({ status: 400, message: 'Visa isn’t shared with that ledger.' })
    storage.registry.update(family.ledger.id, { archived: true })
    expect(status(() => changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER))).toEqual({ status: 400, message: 'Family is archived, so it can’t be Visa’s home.' })
    storage.registry.update(family.ledger.id, { archived: false })
    // A dry run says what it would do, and does nothing.
    expect(w.set(personal, { ledgers: ['personal', 'family'], home: 'family' }, true)).toMatchObject({
      dryRun: true,
      home: { from: { slug: 'personal' }, to: { slug: 'family' } },
      sharing: { home: { slug: 'family' }, opening: { slug: 'personal' } },
      notices: ['Family is the home from now on. Personal keeps Visa’s opening balance, and differences with the bank still land in Personal.'],
    })
    expect(w.everything(personal, family, trip)).toEqual(before)
    expect(getSharing(personal, w.visa).home.slug).toBe('personal')
  })
})

describe('stopping sharing with a ledger whose transactions go home', () => {
  it('moves its rows home from an archived ledger, sends its deleted ones home still deleted, and lets go of its recurring items and institution', () => {
    const w = world({ opening: -1_000 })
    const { personal, family } = w
    w.addTx(personal, '2026-08-01', -100)
    const purchase = w.addTx(family, '2026-09-02', -8000, { payee: 'Sport Store' })
    const refund = w.addTx(family, '2026-09-05', 2000, { payee: 'Sport Store' })
    setLinks(family, refund, [{ transactionId: purchase, kind: 'refund', amountMinor: 2000 }])
    updateTransaction(family, purchase, { tags: ['sport'] })
    const gone = w.addTx(family, '2026-09-06', -300, { deleted: true })
    family.q.run('UPDATE transactions SET external_id = ? WHERE ledger_id = @ledger AND id = ?', 'bank-1', gone)
    family.q.run("INSERT INTO transaction_tags (transaction_id, tag_id) SELECT ?, id FROM tags WHERE ledger_id = @ledger AND name = 'sport'", gone)
    family.q.run(
      `INSERT INTO recurring_items (ledger_id, name, payee_key, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
       VALUES (@ledger, 'Gym', 'gym', ?, -3000, 'monthly', '2026-01-01', '2026-10-01', 'active', 'manual')`,
      w.visa,
    )
    // Family is archived: it keeps its rows and its part until it stops sharing.
    w.storage.registry.change(family.ledger.id, { archived: true, answers: {} }, { actor: TESTER })
    const before = w.check()
    expect(before.parts.family).toBe(-6000)

    const change = w.set(personal, { ledgers: ['personal'], rows: { family: 'home' } })
    expect(change).toMatchObject({
      dryRun: false,
      added: [],
      home: null,
      removed: [{ ledger: { slug: 'family', name: 'Family' }, rows: 'home', moved: 2, sentAsDeleted: 1, recurringItems: 1, importBatches: 0 }],
      opening: null,
      parts: { before: before.parts, after: { personal: before.totalMinor } },
      notices: [],
    })
    expect(change.sharing).toMatchObject({ members: [], totalBalanceMinor: before.totalMinor })
    expect(getAccount(personal, w.visa).sharing).toBeNull()
    expect(w.check()).toEqual({ parts: { personal: before.totalMinor }, totalMinor: before.totalMinor })

    // The refund came with its purchase, still linked, and the tags by name.
    expect(getTransaction(personal, refund).links).toMatchObject([{ transactionId: purchase, kind: 'refund' }])
    expect(getTransaction(personal, purchase).tags.map((t) => t.name)).toEqual(['sport'])
    // The deleted row is in the home, deleted, with its bank id and nothing else.
    expect(personal.q.get('SELECT deleted_at IS NOT NULL AS deleted, external_id AS externalId, category_id AS categoryId FROM transactions WHERE ledger_id = @ledger AND id = ?', gone)).toEqual({
      deleted: 1,
      externalId: 'bank-1',
      categoryId: null,
    })
    // Nothing of Family names the account.
    expect(w.storage.sqlite.prepare('SELECT count(*) FROM transactions WHERE ledger_id = ? AND account_id = ?').pluck().get(family.ledger.id, w.visa)).toBe(0)
    expect(family.q.all('SELECT name, account_id AS accountId FROM recurring_items WHERE ledger_id = @ledger')).toEqual([{ name: 'Gym', accountId: null }])
    expect(listAccounts(family)).toEqual([])
    expect(listInstitutions(family)).toEqual([])
    expect(w.activity(personal, 'stop_sharing')).toEqual(['Stopped sharing Visa with Family'])
    expect(w.activity(family, 'stop_sharing')).toEqual(['Personal stopped sharing Visa with this ledger'])
    expect(w.storage.registry.get(family.ledger.id).archivedAt).not.toBeNull()

    // So the ledger, then the account, can be deleted.
    w.storage.registry.remove(family.ledger.id)
    deleteAccount(personal, w.ctxOf, w.visa)
    expect(listAccounts(personal)).toEqual([])
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('gives the home the opening balance when the opening ledger leaves, and says what that brings it', () => {
    for (const recorded of [false, true]) {
      const w = world({ shareWith: ['family', 'trip'], opening: -1_000 })
      const { personal, family, trip } = w
      w.addTx(personal, '2026-07-01', -200)
      w.addTx(family, '2026-07-05', -300)
      w.addTx(trip, '2026-07-09', -50)
      if (recorded) setBalance(personal, w.visa, { date: '2026-07-31', balanceMinor: -2_000 })
      w.addTx(personal, '2026-08-01', -10)
      changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
      const before = w.check()
      // Personal carries the opening balance (and the recorded one), Family is the home.
      expect(before.parts).toEqual(recorded ? { family: -300, personal: -1_660, trip: -50 } : { family: -300, personal: -1_210, trip: -50 })

      const dry = w.set(family, { ledgers: ['family', 'trip'], rows: { personal: 'home' } }, true)
      expect(dry).toMatchObject({ dryRun: true, removed: [{ ledger: { slug: 'personal' }, moved: 2 }] })
      const change = w.set(family, { ledgers: ['family', 'trip'], rows: { personal: 'home' } })
      expect(change).toEqual({ ...dry, dryRun: false })
      // The base is measured before Personal's rows come home. Family's part was its own −300. With the
      // opening balance it's −1000 − 300 = −1300, a base of −1000. With the balance recorded on 31 July
      // it's −2000 less the rows up to then that others hold (Personal's −200, Trip's −50), so −1750,
      // a base of −1450.
      const base = recorded ? -1_450 : -1_000
      expect(change.opening).toEqual({ from: { slug: 'personal', name: 'Personal' }, to: { slug: 'family', name: 'Family' }, baseMinor: base })
      expect(change.notices).toEqual([
        `Visa’s opening balance and recorded balances move to Family: ${recorded ? '$14.50' : '$10.00'} owed of its balance today, and earlier balances shift too.`,
      ])
      // The whole change is in the parts. Before: Personal −1000 − 200 − 10 = −1210, or −2000 − 10 less
      // Family's −300 and Trip's −50 up to 31 July = −1660. After, Family holds −300 − 200 − 10 = −510:
      // −1000 − 510 = −1510, or −2000 − 10 (after 31 July) less Trip's −50 = −1960. Its part changes by
      // −1210, or −1660: Personal's part, all of it.
      expect(change.parts).toEqual({
        before: recorded ? { family: -300, personal: -1_660, trip: -50 } : { family: -300, personal: -1_210, trip: -50 },
        after: recorded ? { family: -1_960, trip: -50 } : { family: -1_510, trip: -50 },
      })
      expect(change.sharing).toMatchObject({ home: { slug: 'family' }, opening: { slug: 'family' }, members: [{ slug: 'trip' }] })
      expect(w.check()).toEqual({ parts: { family: before.totalMinor + 50, trip: -50 }, totalMinor: before.totalMinor })
      expect(w.storage.sqlite.prepare('SELECT opening_ledger_id FROM accounts WHERE id = ?').pluck().get(w.visa)).toBeNull()
    }
  })

  it('lets a ledger that was the home once leave: its imports into the account go', () => {
    const w = world()
    const { personal, family } = w
    const rows = [
      { line: 1, date: '2026-09-01', payee: 'Hardware', amountMinor: -800 },
      { line: 2, date: '2026-09-02', payee: 'Bakery', amountMinor: -300 },
    ]
    commitImport(personal, importCommitSchema.parse({ accountId: w.visa, rows }), { background: false })
    expect(personal.q.pluck('SELECT count(*) FROM import_batches WHERE ledger_id = @ledger')).toBe(1)
    changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
    // The import stays in the ledger that made it, which keeps it a member until it goes.
    expect(status(() => removeMember(family, w.ctxOf, w.visa, personal.ledger.id, TESTER))).toEqual({
      status: 400,
      message: 'Say whether Personal’s 2 transactions go home or stay in Personal.',
    })
    removeMember(family, w.ctxOf, w.visa, personal.ledger.id, TESTER, { rows: 'home' })
    expect(personal.q.pluck('SELECT count(*) FROM import_batches WHERE ledger_id = @ledger')).toBe(0)
    expect(family.q.column('SELECT payee FROM transactions WHERE ledger_id = @ledger AND import_batch_id IS NULL ORDER BY date')).toEqual(['Hardware', 'Bakery'])
    expect(w.check()).toEqual({ parts: { family: -1_100 }, totalMinor: -1_100 })
    expect(getAccount(family, w.visa).sharing).toBeNull()
    deleteAccount(family, w.ctxOf, w.visa)
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  // A thousand rows take seconds on a slow machine.
  it('moves more than 1000 rows in chunks, a purchase and its refund in one', { timeout: 30_000 }, () => {
    const w = world()
    const { personal, family } = w
    const ids = family.q.transaction(() => Array.from({ length: MOVE_LIMIT + 5 }, (_, i) => w.addTx(family, addDays('2026-01-01', i % 270), -100 - i)))
    // The first row and the last by date, linked: a chunk by date alone would part them.
    const purchase = ids[0]!
    const refund = w.addTx(family, '2026-09-30', 50, { payee: 'Shop' })
    setLinks(family, refund, [{ transactionId: purchase, kind: 'refund', amountMinor: 50 }])
    const before = w.check()

    const change = w.set(personal, { ledgers: ['personal'], rows: { family: 'home' } })
    expect(change.removed).toMatchObject([{ moved: MOVE_LIMIT + 6, sentAsDeleted: 0 }])
    expect(personal.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND account_id = ?', w.visa)).toBe(MOVE_LIMIT + 6)
    expect(getTransaction(personal, refund).links).toMatchObject([{ transactionId: purchase }])
    expect(personal.q.column("SELECT summary FROM activity WHERE ledger_id = @ledger AND action = 'move' ORDER BY id")).toHaveLength(2)
    expect(w.check()).toEqual({ parts: { personal: before.totalMinor }, totalMinor: before.totalMinor })
  })

  it('has AI categorize what came home uncategorized, once, after the commit, and not in a dry run', async () => {
    const asked: string[] = []
    const w = world({ llm: ai(asked) })
    const { personal, family } = w
    const cafe = w.addTx(family, '2026-09-03', -1000, { payee: 'Corner Cafe' })
    w.addTx(family, '2026-09-04', -1500, { payee: 'Bean Bar' })
    w.set(personal, { ledgers: ['personal'], rows: { family: 'home' } }, true)
    await settle()
    expect(asked).toEqual([])
    w.set(personal, { ledgers: ['personal'], rows: { family: 'home' } })
    await settle()
    expect(asked.sort()).toEqual(['Bean Bar', 'Corner Cafe'])
    expect(getTransaction(personal, cafe)).toMatchObject({ categoryId: categoryId(personal, 'Dine out'), categorySource: 'ai' })
  })
})

describe('setSharing', () => {
  it('makes Family the home and takes Personal out in one call, after which Personal and the account can be deleted', () => {
    const w = world({ opening: -1_000 })
    const { personal, family, trip } = w
    const chequing = makeAccount(personal, 'Chequing')
    w.addTx(personal, '2026-08-01', -200)
    w.addTx(personal, '2026-08-02', -50, { deleted: true })
    w.addTx(family, '2026-08-03', -300)
    setBalance(personal, w.visa, { date: '2026-08-31', balanceMinor: -1_600 })
    w.addTx(personal, '2026-09-01', -20, { account: chequing })
    const before = w.check()
    const input: SharingInput = { ledgers: ['family'], home: 'family', rows: { personal: 'home' } }

    const all = w.everything(personal, family, trip)
    const dry = w.set(personal, input, true)
    expect(w.everything(personal, family, trip)).toEqual(all)
    expect(dry).toMatchObject({
      dryRun: true,
      home: { from: { slug: 'personal' }, to: { slug: 'family' } },
      removed: [{ ledger: { slug: 'personal' }, rows: 'home', moved: 1, sentAsDeleted: 1, recurringItems: 0, importBatches: 0 }],
      opening: { from: { slug: 'personal' }, to: { slug: 'family' } },
      parts: { before: before.parts, after: { family: before.totalMinor } },
    })
    expect(dry.notices[0]).toBe('Family is the home from now on.')
    expect(dry.sharing).toMatchObject({ home: { slug: 'family' }, opening: { slug: 'family' }, members: [], totalBalanceMinor: before.totalMinor })

    const change = w.set(personal, input)
    expect(change).toEqual({ ...dry, dryRun: false })
    expect(w.check()).toEqual({ parts: { family: before.totalMinor }, totalMinor: before.totalMinor })
    expect(getAccount(family, w.visa)).toMatchObject({ sharing: null, openingBalanceMinor: -1_000, balanceAsOf: '2026-08-31', balanceMinor: before.totalMinor })
    expect(status(() => getAccount(personal, w.visa))).toEqual({ status: 404, message: 'Account not found' })
    expect(w.activity(personal, 'change_home')).toEqual(['Made Family Visa’s home'])
    expect(w.activity(family, 'stop_sharing')).toEqual(['Stopped sharing Visa with Personal'])

    // Nothing of Personal names the account: the ledger goes, then the account.
    w.storage.registry.remove(personal.ledger.id)
    deleteAccount(family, w.ctxOf, w.visa)
    expect(listAccounts(family)).toEqual([])
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('adds, makes a new ledger the home and takes one out in one call, and says the old home keeps the opening balance', () => {
    const w = world({ opening: -1_000 })
    const { personal, family, trip } = w
    w.addTx(personal, '2026-08-01', -200)
    w.addTx(family, '2026-08-03', -300)
    const before = w.check()
    const change = w.set(personal, { ledgers: ['personal', 'trip'], home: 'trip', rows: { family: 'home' } })
    expect(change).toMatchObject({
      added: [{ slug: 'trip', name: 'Trip' }],
      home: { from: { slug: 'personal' }, to: { slug: 'trip' } },
      removed: [{ ledger: { slug: 'family' }, moved: 1 }],
      opening: null,
      notices: ['Trip is the home from now on. Personal keeps Visa’s opening balance, and differences with the bank still land in Personal.'],
      parts: { before: before.parts, after: { trip: -300, personal: -1_200 } },
    })
    expect(change.sharing).toMatchObject({ home: { slug: 'trip' }, opening: { slug: 'personal' }, members: [{ slug: 'personal' }] })
    expect(w.check()).toEqual({ parts: { trip: -300, personal: -1_200 }, totalMinor: before.totalMinor })
    expect(listAccounts(family)).toEqual([])
    expect(getAccount(trip, w.visa).institution).toBe('TD')
  })

  it('ends the sharing with a list of only the home, and changes nothing when the list is as it is', () => {
    const w = world({ shareWith: ['family', 'trip'] })
    const { personal, family, trip } = w
    const all = w.everything(personal, family, trip)
    expect(w.set(personal, { ledgers: ['trip', 'personal', 'family'] })).toMatchObject({ added: [], home: null, removed: [], notices: [] })
    expect(w.everything(personal, family, trip)).toEqual(all)
    expect(w.set(personal, { ledgers: ['personal'] }).removed.map((r) => [r.ledger.slug, r.rows])).toEqual([
      ['family', null],
      ['trip', null],
    ])
    expect(getAccount(personal, w.visa).sharing).toBeNull()
  })

  it('refuses a list it can’t do, with nothing changed', () => {
    const w = world()
    const { personal, family, trip, storage } = w
    w.addTx(family, '2026-09-01', -100)
    const chequing = makeAccount(personal, 'Chequing')
    const before = w.everything(personal, family, trip)
    const refused = (input: SharingInput, message: string, ctx = personal) => expect(status(() => w.set(ctx, input))).toEqual({ status: 400, message })
    expect(status(() => w.set(family, { ledgers: ['family'] }))).toEqual({ status: 409, message: 'Visa’s home is Personal. Its sharing is changed there.' })
    refused({ ledgers: [] }, 'List the ledgers that will have Visa, its home included.')
    refused({ ledgers: ['personal', 'nowhere'] }, 'There’s no ledger “nowhere”.')
    refused({ ledgers: ['family'] }, 'Personal is Visa’s home. Keep it in the list, or name the new home.')
    refused({ ledgers: ['personal', 'family'], home: 'trip' }, 'Trip isn’t in the list, so it can’t be Visa’s home.')
    refused({ ledgers: ['personal'] }, 'Say whether Family’s 1 transaction goes home or stays in Family.')
    refused({ ledgers: ['personal'], rows: { family: 'elsewhere' } }, 'Say “home” or “keep” for Family’s transactions.')
    expect(status(() => setSharing(personal, w.ctxOf, chequing, { ledgers: ['personal', 'family'] }, { actor: TESTER, usable: null }))).toEqual({
      status: 400,
      message: 'Only credit cards can be shared for now, and Chequing isn’t one.',
    })
    storage.registry.update(trip.ledger.id, { archived: true })
    refused({ ledgers: ['personal', 'family', 'trip'] }, 'Trip is archived, so Visa can’t be shared with it.')
    storage.registry.update(trip.ledger.id, { archived: false })
    // A step that fails after another has run takes it back too: Trip is added, then the archived new home is refused.
    storage.registry.update(family.ledger.id, { archived: true })
    refused({ ledgers: ['personal', 'family', 'trip'], home: 'family' }, 'Family is archived, so it can’t be Visa’s home.')
    storage.registry.update(family.ledger.id, { archived: false })
    // A home can't be archived while it's the home (the questions ask for another first): set as it would be if it were.
    storage.sqlite.prepare("UPDATE ledgers SET archived_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(personal.ledger.id)
    refused({ ledgers: ['personal'], rows: { family: 'home' } }, 'Personal is archived. Restore it before changing how Visa is shared.')
    expect(w.everything(personal, family, trip)).toEqual(before)
  })
})
