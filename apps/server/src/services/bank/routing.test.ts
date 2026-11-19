import { describe, expect, it } from 'vitest'
import { recurringCreateSchema, transactionCreateSchema } from '@chipmunk/shared'
import { fakeBridge, fakeTx, TOKEN, type FakeCard } from '../../test/fake-bridge'
import { categoryId } from '../../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld } from '../../test/shared-accounts'
import { ledgerRows } from '../../test/world'
import type { AppContext } from '../context'
import { createRecurring, getRecurring } from '../recurring'
import { createTransaction, getTransaction } from '../transactions'
import { BankService } from './service'

/**
 * New payments follow their recurring item (routeToItems), after a real sync from a fake bank.
 * Personal is Visa's home, where its bank link is. Family has the card, and Trip when the test
 * shares it. Today is 2026-10-03, and Netflix charges $15.99 on the 1st.
 */

type Shared = NonNullable<Parameters<typeof sharedWorld>[0]>['shareWith']

/** Visa linked to the fake bridge in Personal and synced once, with one row from before. */
async function synced(shareWith: Shared = ['family']) {
  const card: FakeCard = { balance: '-50.00', transactions: [fakeTx('a1', '2026-09-28', '-50.00', 'Corner Cafe')] }
  const w = sharedWorld({ fetch: fakeBridge(card), shareWith })
  const ledgers = [w.personal, w.family, w.trip]
  const bank = new BankService(w.storage)
  const conn = await bank.connect({ setupToken: TOKEN })
  bank.linkAccount(w.personal, w.visa, { bankAccountId: conn.accounts.find((a) => a.remoteId === 'visa')!.id }, null)
  const sync = async (opts: { full?: boolean } = {}) => {
    const result = await bank.sync(conn.id, opts)
    expect(result.ok, result.error ?? '').toBe(true)
    return result.accounts[0]!
  }
  await sync()
  /** The bank reports one more transaction, and the balance with it. */
  const charge = (id: string, date: string, amount: string, payee: string, opts: { pending?: boolean } = {}) => {
    card.transactions = [...card.transactions.filter((t) => t.id !== id), fakeTx(id, date, amount, payee, opts)]
    card.balance = card.transactions.reduce((sum, t) => sum + Number(t.amount), 0).toFixed(2)
  }
  /** The ledger's active Netflix item, due on October 1st. */
  const netflix = (ctx: AppContext, more: Record<string, unknown> = {}) =>
    createRecurring(ctx, recurringCreateSchema.parse({ payee: 'Netflix', expectedAmountMinor: -1599, cadence: 'monthly', anchorDate: '2026-10-01', ...more }))
  /** Where each bank id is, with the row. */
  const held = (externalId: string) =>
    ledgers.flatMap((c) =>
      c.q
        .all<{ id: number; status: string; amount: number }>('SELECT id, status, amount_minor AS amount FROM transactions WHERE ledger_id = @ledger AND external_id = ? AND deleted_at IS NULL', externalId)
        .map((r) => ({ ledger: c.ledger.slug, ...r })),
    )
  const activity = (ctx: AppContext) => ctx.q.column<string>("SELECT summary FROM activity WHERE ledger_id = @ledger AND action = 'move' ORDER BY id")
  const check = () => {
    expectNoCrossLedgerReferences(w.storage)
    return expectPartsSumToAccount(w.storage, w.visa).parts
  }
  const everything = () => ledgers.map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
  return { ...w, card, bank, sync, charge, netflix, held, activity, check, everything }
}

describe('new payments follow their recurring item: bank sync', () => {
  it('sends a new payment to the one ledger whose item it matches, says so in the result and both logs, and adds nothing twice', async () => {
    const w = await synced()
    const item = w.netflix(w.family, { name: 'Netflix family plan', categoryId: categoryId(w.family, 'Software & media') })
    w.charge('n1', '2026-10-01', '-15.99', 'Netflix')
    w.charge('c1', '2026-10-02', '-4.00', 'Corner Cafe')

    const result = await w.sync()
    const [n1] = w.held('n1')
    expect(n1).toMatchObject({ ledger: 'family', amount: -1599 })
    expect(result).toMatchObject({ added: 2, updated: 0, routed: [{ id: n1!.id, payee: 'Netflix', ledger: 'Family', item: 'Netflix family plan' }] })
    expect(w.held('c1')).toMatchObject([{ ledger: 'personal' }])
    // It's that item's payment there, in its category, and the item is due next in November.
    expect(getTransaction(w.family, n1!.id)).toMatchObject({ recurringItemId: item.id, categoryId: categoryId(w.family, 'Software & media'), categorySource: 'recurring' })
    expect(getRecurring(w.family, item.id)).toMatchObject({ occurrences: 1, nextDueDate: '2026-11-01' })
    expect(w.activity(w.personal)).toEqual(['Netflix (-$15.99 on 2026-10-01) went to Family, where it’s a payment of Netflix family plan'])
    // Family is told it's new on the card, and not which ledger it came through.
    expect(w.activity(w.family)).toEqual(['Netflix (-$15.99 on 2026-10-01) is new on Visa, a payment of Netflix family plan'])
    expect(w.family.q.pluck("SELECT after FROM activity WHERE ledger_id = @ledger AND action = 'move'")).not.toMatch(/personal/i)
    // $50.00 and $4.00 at the cafe stay in Personal's part, and $15.99 is Family's.
    expect(w.check()).toEqual({ personal: -5400, family: -1599 })

    // The next sync and Fetch history find it where it is.
    const before = w.everything()
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, routed: [] })
    expect(await w.sync({ full: true })).toMatchObject({ added: 0, updated: 0, routed: [] })
    expect(w.everything()).toEqual(before)
  })

  it('keeps a pending charge in the home, whatever Fetch history brings, and routes it once it posts', async () => {
    const w = await synced()
    const item = w.netflix(w.family)
    w.charge('n1', '2026-10-01', '-15.99', 'Netflix', { pending: true })
    expect(await w.sync({ full: true })).toMatchObject({ added: 1, routed: [] })
    const [pending] = w.held('n1')
    expect(pending).toMatchObject({ ledger: 'personal', status: 'pending', amount: -1599 })
    expect(getRecurring(w.family, item.id).occurrences).toBe(0)
    // $50.00 at the cafe and the pending $15.99 are Personal's.
    expect(w.check()).toEqual({ personal: -6599, family: 0 })
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, routed: [] })
    expect(w.held('n1')).toMatchObject([{ ledger: 'personal', status: 'pending' }])

    // It posts, a cent more: the same row goes to Family, where it's the item's payment.
    w.charge('n1', '2026-10-01', '-16.00', 'Netflix')
    expect(await w.sync()).toMatchObject({ added: 0, updated: 1, routed: [{ id: pending!.id, payee: 'Netflix', ledger: 'Family', item: 'Netflix' }] })
    expect(w.held('n1')).toEqual([{ ledger: 'family', id: pending!.id, status: 'cleared', amount: -1600 }])
    expect(getTransaction(w.family, pending!.id).recurringItemId).toBe(item.id)
    expect(getRecurring(w.family, item.id)).toMatchObject({ occurrences: 1, nextDueDate: '2026-11-01' })
    expect(w.check()).toEqual({ personal: -5000, family: -1600 })

    // And nothing is routed again.
    const before = w.everything()
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, routed: [] })
    expect(w.everything()).toEqual(before)
  })

  it('links a pending charge that posts in the home to the home’s own item, and routes nothing', async () => {
    const w = await synced()
    const mine = w.netflix(w.personal)
    w.netflix(w.family)
    w.charge('n1', '2026-10-01', '-15.99', 'Netflix', { pending: true })
    expect(await w.sync()).toMatchObject({ added: 1, routed: [] })
    const [pending] = w.held('n1')
    expect(getTransaction(w.personal, pending!.id)).toMatchObject({ status: 'pending', recurringItemId: null })
    w.charge('n1', '2026-10-01', '-15.99', 'Netflix')
    expect(await w.sync()).toMatchObject({ added: 0, updated: 1, routed: [] })
    expect(getTransaction(w.personal, pending!.id)).toMatchObject({ status: 'cleared', recurringItemId: mine.id })
    expect(w.check()).toEqual({ personal: -6599, family: 0 })
  })

  it('keeps it in the home when the home has a matching item, when two other ledgers do, and when the only one is archived', async () => {
    // The home's own item takes it.
    const home = await synced()
    const mine = home.netflix(home.personal)
    home.netflix(home.family)
    home.charge('n1', '2026-10-01', '-15.99', 'Netflix')
    expect(await home.sync()).toMatchObject({ added: 1, routed: [] })
    expect(home.held('n1')).toMatchObject([{ ledger: 'personal' }])
    expect(getTransaction(home.personal, home.held('n1')[0]!.id).recurringItemId).toBe(mine.id)

    // Family and Trip both wait for it: neither gets it.
    const two = await synced(['family', 'trip'])
    two.netflix(two.family)
    two.netflix(two.trip)
    two.charge('n1', '2026-10-01', '-15.99', 'Netflix')
    expect(await two.sync()).toMatchObject({ added: 1, routed: [] })
    expect(two.held('n1')).toMatchObject([{ ledger: 'personal' }])
    expect(two.activity(two.personal)).toEqual([])

    // Family is archived.
    const archived = await synced()
    archived.netflix(archived.family)
    archived.storage.registry.update(archived.family.ledger.id, { archived: true })
    archived.charge('n1', '2026-10-01', '-15.99', 'Netflix')
    expect(await archived.sync()).toMatchObject({ added: 1, routed: [] })
    expect(archived.held('n1')).toMatchObject([{ ledger: 'personal' }])
    archived.check()
  })

  it('keeps it in the home for a suggestion never accepted, an amount outside the item’s variation, and a row entered by hand', async () => {
    const w = await synced()
    const item = w.netflix(w.family)
    w.family.q.run("UPDATE recurring_items SET status = 'suggested' WHERE ledger_id = @ledger AND id = ?", item.id)
    w.charge('n1', '2026-10-01', '-15.99', 'Netflix')
    expect(await w.sync()).toMatchObject({ added: 1, routed: [] })
    expect(w.held('n1')).toMatchObject([{ ledger: 'personal' }])

    // Accepted, at $15.99 give or take 10%: $25.00 isn't its payment.
    w.family.q.run("UPDATE recurring_items SET status = 'active' WHERE ledger_id = @ledger AND id = ?", item.id)
    w.charge('n2', '2026-10-02', '-25.00', 'Netflix')
    expect(await w.sync()).toMatchObject({ added: 1, routed: [] })
    expect(w.held('n2')).toMatchObject([{ ledger: 'personal' }])

    // One you enter in Personal stays there, through the next sync too.
    const byHand = await createTransaction(w.personal, transactionCreateSchema.parse({ accountId: w.visa, date: '2026-10-02', amountMinor: -1599, payee: 'Netflix' }), { useAi: false })
    expect(await w.sync()).toMatchObject({ added: 0, routed: [] })
    expect(getTransaction(w.personal, byHand.id)).toMatchObject({ recurringItemId: null })
    expect(getRecurring(w.family, item.id)).toMatchObject({ occurrences: 0, nextDueDate: '2026-10-01' })
    expect(w.activity(w.personal)).toEqual([])
    w.check()
  })

  it('syncs an account that isn’t shared as before, whatever items another ledger has', async () => {
    const w = await synced([])
    w.netflix(w.family)
    w.charge('n1', '2026-10-01', '-15.99', 'Netflix')
    const family = ledgerRows(w.storage.sqlite, w.family.ledger.id)
    expect(await w.sync()).toEqual(expect.objectContaining({ added: 1, updated: 0, adopted: 0, removed: 0, routed: [], error: null }))
    expect(w.held('n1')).toMatchObject([{ ledger: 'personal', status: 'cleared', amount: -1599 }])
    expect(ledgerRows(w.storage.sqlite, w.family.ledger.id)).toEqual(family)
    expect(w.personal.q.column('SELECT action FROM activity WHERE ledger_id = @ledger ORDER BY id DESC LIMIT 1')).toEqual(['sync'])
  })
})
