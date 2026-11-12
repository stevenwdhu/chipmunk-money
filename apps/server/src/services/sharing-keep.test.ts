import { describe, expect, it } from 'vitest'
import { accountBankSwitchSchema, importCommitSchema, importPreviewSchema, transactionCreateSchema, type ReportSpec } from '@chipmunk/shared'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER } from '../test/shared-accounts'
import { ledgerRows } from '../test/world'
import { balancesAt, deleteAccount, getAccount, leaveSplitOffBankIds, listSnapshots, setBalance, updateAccount } from './accounts'
import { applyRemoteTransactions } from './bank/apply'
import { BankService } from './bank/service'
import type { RemoteTransaction } from './bank/types'
import type { AppContext } from './context'
import { createCustomReport, getCustomReport } from './custom-reports'
import { commitImport, previewImport } from './import'
import { moveTransactions } from './moves'
import { addMember, changeHome, setSharing, type SharingInput } from './sharing'
import { createTransaction, deleteTransaction, findByExternalId, getTransaction, updateTransaction } from './transactions'

/**
 * Stopping sharing a shared account with a ledger that keeps its transactions: they stay in it, on a
 * new manual account of its own (A′), and the account (A) is the whole bank balance again. The
 * rows A′ took still carry the bank's ids, so A's sync, CSV imports and switches know them and
 * never bring them back, nor change them. Personal is Visa's home, and Family has it. The rows
 * Family holds got there by a real move.
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

const MONTH_ENDS = ['2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']

/** A transaction as a provider hands it over. */
const remote = (remoteId: string, date: string, amountMinor: number, payee: string, more: Partial<RemoteTransaction> = {}): RemoteTransaction => ({
  remoteId,
  date,
  amountMinor,
  payee,
  description: payee.toUpperCase(),
  pending: false,
  raw: { remoteId, date, amountMinor, payee, ...more },
  ...more,
})

function world(opts: Parameters<typeof sharedWorld>[0] = {}) {
  const w = sharedWorld(opts)
  const ledgers = [w.personal, w.family, w.trip]
  const set = (ctx: AppContext, input: SharingInput, dryRun = false) => setSharing(ctx, w.ctxOf, w.visa, input, { dryRun, actor: TESTER })
  const move = (from: AppContext, ids: number[], to: AppContext) => moveTransactions(from, w.ctxOf, { ids, to: to.ledger.id }, TESTER)
  /** Each ledger's own live rows on an account, summed up to `d` (all of them without it). */
  const own = (ctx: AppContext, account: number, d?: string) =>
    ctx.q.pluck<number>(
      'SELECT coalesce(sum(amount_minor), 0) FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NULL AND (? IS NULL OR date <= ?)',
      account,
      d ?? null,
      d ?? null,
    )!
  /** Each ledger's part of Visa at these dates, by slug. */
  const partsAt = (dates: string[]) => Object.fromEntries(ledgers.map((c) => [c.ledger.slug, balancesAt(c, dates).get(w.visa) ?? null]))
  /** The account a ledger kept its rows on: the one split off from Visa (or from `from`). */
  const splitOff = (ctx: AppContext, from = w.visa) => ctx.q.pluck<number>('SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND split_from_id = ?', from)!
  /** A ledger's rows on an account, deleted ones too. */
  const rowsOn = (ctx: AppContext, account: number) =>
    ctx.q.all<{ id: number; externalId: string | null; date: string; amount: number; payee: string; status: string; deleted: number; batch: number | null }>(
      `SELECT id, external_id AS externalId, date, amount_minor AS amount, payee, status, deleted_at IS NOT NULL AS deleted, import_batch_id AS batch
       FROM transactions WHERE ledger_id = @ledger AND account_id = ? ORDER BY id`,
      account,
    )
  const everything = () => ledgers.map((c) => ledgerRows(w.storage.sqlite, c.ledger.id))
  const activity = (ctx: AppContext, action: string) => ctx.q.column<string>('SELECT summary FROM activity WHERE ledger_id = @ledger AND action = ? ORDER BY id', action)
  /** What every change leaves: the parts sum to each account, and nothing refers across ledgers. */
  const check = (...accounts: number[]) => {
    const parts = expectPartsSumToAccount(w.storage, w.visa)
    for (const a of accounts) expectPartsSumToAccount(w.storage, a)
    expectNoCrossLedgerReferences(w.storage)
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
    return parts
  }
  return { ...w, set, move, own, partsAt, splitOff, rowsOn, everything, activity, check }
}

describe('stopping sharing with a ledger that keeps its transactions', () => {
  it('keeps them on an account of its own, sends its pending ones home, and makes the account the whole balance again', () => {
    const w = world({ opening: -1_000 })
    const { personal, family } = w
    // Family was the home once, and imported a file into Visa then.
    changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
    const file = [
      { line: 1, date: '2026-06-10', payee: 'Hardware', amountMinor: -800 },
      { line: 2, date: '2026-06-12', payee: 'Bakery', amountMinor: -300 },
    ]
    commitImport(family, importCommitSchema.parse({ accountId: w.visa, rows: file }), { background: false })
    changeHome(family, w.ctxOf, w.visa, personal.ledger.id, TESTER)
    // Rows on both sides of a balance recorded on 31 July. Family's came from Personal by a move.
    w.addTx(personal, '2026-07-05', -200)
    const july = w.addTx(personal, '2026-07-10', -400, { payee: 'Garden' })
    setBalance(personal, w.visa, { date: '2026-07-31', balanceMinor: -3_000 })
    const august = w.addTx(personal, '2026-08-15', -250, { payee: 'Shoes' })
    w.addTx(personal, '2026-08-20', -30)
    // From the bank (as Plaid sends them): a posted one, and a pending one, which goes home.
    applyRemoteTransactions(personal, w.ctxOf, w.visa, [remote('k1', '2026-09-20', -9_000, 'Book Shop')], { removed: [], floor: null }, 'plaid')
    applyRemoteTransactions(personal, w.ctxOf, w.visa, [remote('p1', '2026-09-28', -6_000, 'Corner Cafe', { pending: true })], { removed: [], floor: null }, 'plaid')
    const idOf = (externalId: string) => w.rowsOn(personal, w.visa).find((r) => r.externalId === externalId)!.id
    const [k1, p1] = [idOf('k1'), idOf('p1')]
    const gone = w.addTx(personal, '2026-09-05', -70)
    w.move(personal, [july, august, k1, p1, gone], family)
    deleteTransaction(family, gone)
    // Family's recurring item on Visa, and a report filtering by it, in Only count and in a Filter out rule.
    family.q.run(
      `INSERT INTO recurring_items (ledger_id, name, payee_key, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
       VALUES (@ledger, 'Gym', 'gym', ?, -3000, 'monthly', '2026-01-01', '2026-10-01', 'active', 'manual')`,
      w.visa,
    )
    const spec = {
      filter: { spending: { only: [{ field: 'account', ids: [w.visa] }], filterOut: [{ when: [{ field: 'account', ids: [w.visa] }, { field: 'amount', min: 10_000 }] }] } },
    } as ReportSpec
    const report = createCustomReport(family, { name: 'Visa only', spec })
    // Personal's report on Visa stays on Visa.
    const personalReport = createCustomReport(personal, { name: 'Visa only', spec })

    const before = w.check()
    // Family holds the imports, Garden, Shoes, Book Shop and Corner Cafe: −800 − 300 − 400 − 250 − 9000 − 6000.
    expect(before.parts.family).toBe(-16_750)
    const pastBefore = w.partsAt(MONTH_ENDS)
    const input: SharingInput = { ledgers: ['personal'], rows: { family: 'keep' } }

    // The dry run says it all, and changes nothing.
    const unchanged = w.everything()
    const dry = w.set(personal, input, true)
    expect(w.everything()).toEqual(unchanged)

    const change = w.set(personal, input)
    const own = w.splitOff(family)
    expect(change).toEqual({ ...dry, dryRun: false })
    // Its own account has its old part less the pending row that went home: −16750 + 6000.
    expect(change.removed).toEqual([
      {
        ledger: { slug: 'family', name: 'Family' },
        rows: 'keep',
        moved: 1,
        sentAsDeleted: 0,
        kept: 6,
        account: { id: own, name: 'Visa', balanceMinor: -10_750 },
        recurringItems: 1,
        importBatches: 1,
        splits: [],
      },
    ])
    expect(change.removed[0]!.account!.balanceMinor + -6_000).toBe(before.parts.family)
    expect(change.notices).toEqual([
      '1 pending transaction goes to Personal, because the bank will post it again.',
      'Family’s new account keeps its balance of -$107.50, and Visa’s total is the whole bank balance again, so that amount is also in Personal until you record how it was settled.',
    ])
    // Visa's total is as it was, all of it in Personal now.
    expect(change.parts).toEqual({ before: before.parts, after: { personal: before.totalMinor } })
    expect(change.sharing).toMatchObject({ members: [], totalBalanceMinor: before.totalMinor })
    expect(w.check(own)).toEqual({ parts: { personal: before.totalMinor }, totalMinor: before.totalMinor })

    // The new account: Visa's own facts, Family's place, nothing of the bank or the import.
    expect(getAccount(family, own)).toMatchObject({
      name: 'Visa',
      type: 'credit',
      currency: 'CAD',
      openingBalanceMinor: 0,
      openingDate: getAccount(personal, w.visa).openingDate,
      institution: 'TD',
      balanceMinor: -10_750,
      bank: null,
      importMapping: null,
      sharing: null,
    })
    expect(w.storage.sqlite.prepare('SELECT split_from_id FROM accounts WHERE id = ?').pluck().get(own)).toBe(w.visa)
    // Every row of Family's, deleted ones too, on it, out of the import, which is gone. The pending one is home.
    expect(w.rowsOn(family, w.visa)).toEqual([])
    expect(w.rowsOn(family, own).map((r) => ({ payee: r.payee, externalId: r.externalId, deleted: r.deleted, batch: r.batch }))).toEqual([
      { payee: 'Hardware', externalId: null, deleted: 0, batch: null },
      { payee: 'Bakery', externalId: null, deleted: 0, batch: null },
      { payee: 'Garden', externalId: null, deleted: 0, batch: null },
      { payee: 'Shoes', externalId: null, deleted: 0, batch: null },
      { payee: 'Book Shop', externalId: 'k1', deleted: 0, batch: null },
      { payee: 'Shop', externalId: null, deleted: 1, batch: null },
    ])
    expect(family.q.pluck('SELECT count(*) FROM import_batches WHERE ledger_id = @ledger')).toBe(0)
    expect(w.rowsOn(personal, w.visa).find((r) => r.externalId === 'p1')).toMatchObject({ id: p1, status: 'pending', deleted: 0 })
    expect(family.q.all('SELECT name, account_id AS accountId FROM recurring_items WHERE ledger_id = @ledger')).toEqual([{ name: 'Gym', accountId: own }])
    expect(getCustomReport(family, report.id).spec.filter).toMatchObject({
      spending: { only: [{ field: 'account', ids: [own] }], filterOut: [{ when: [{ field: 'account', ids: [own] }, { field: 'amount', min: 10_000 }] }] },
    })
    expect(getCustomReport(personal, personalReport.id).spec.filter).toMatchObject({ spending: { only: [{ field: 'account', ids: [w.visa] }] } })
    // Nothing of Family names Visa, and Family keeps its institution for its own account.
    expect(w.storage.sqlite.prepare('SELECT count(*) FROM account_ledgers WHERE account_id = ?').pluck().get(w.visa)).toBe(0)

    // The balance recorded on 31 July loses Family's rows up to it (−800 − 300 − 400): the other
    // ledgers' past balances don't move. Today's balance is the account's total, recorded.
    expect(listSnapshots(personal, w.visa).map(({ date, balanceMinor, source }) => ({ date, balanceMinor, source }))).toEqual([
      { date: '2026-10-03', balanceMinor: before.totalMinor, source: 'manual' },
      { date: '2026-07-31', balanceMinor: -1_500, source: 'manual' },
    ])
    // Personal's part at past month-ends is as it was, but for the pending row from its date on.
    const pastAfter = w.partsAt(MONTH_ENDS)
    expect(pastAfter.personal!.map((p, i) => p - pastBefore.personal![i]!)).toEqual(MONTH_ENDS.map((d) => (d >= '2026-09-28' ? -6_000 : 0)))

    // The bank id it kept is another account's now.
    expect(status(() => findByExternalId(personal, w.visa, 'k1'))).toEqual({ status: 409, message: 'Another account has this transaction' })
    expect(findByExternalId(personal, w.visa, 'p1')).toEqual({ id: p1, deleted: false })

    expect(w.activity(personal, 'stop_sharing')).toEqual(['Stopped sharing Visa with Family, which keeps its 6 transactions on an account of its own'])
    expect(w.activity(family, 'stop_sharing')).toEqual(['Personal stopped sharing Visa with this ledger. Its transactions here are on Visa, an account of this ledger’s own'])
    expect(w.activity(family, 'create')).toContain('Added the account Visa for this ledger’s transactions on Personal’s Visa')

    // From then on it's an ordinary manual account of Family's.
    expect(updateTransaction(family, august, { notes: 'Mine' })).toMatchObject({ accountId: own, notes: 'Mine' })
    deleteTransaction(family, july)
    expect(getTransaction(family, august).accountId).toBe(own)
    expect(updateAccount(family, own, { name: 'Family Visa' })).toMatchObject({ name: 'Family Visa', balanceMinor: -10_350 })
    expect(setBalance(family, own, { date: '2026-10-01', balanceMinor: -10_000 })).toMatchObject({ balanceMinor: -10_000 })
    expect(getAccount(personal, w.visa).balanceMinor).toBe(before.totalMinor)
    w.check(own)

    // Visa, then Family, can be deleted. Family's own account isn't Visa's, so it stays until then.
    deleteAccount(personal, w.ctxOf, w.visa)
    expect(getAccount(family, own).name).toBe('Family Visa')
    w.storage.registry.remove(family.ledger.id)
    expect(w.storage.sqlite.prepare('SELECT count(*) FROM accounts WHERE id = ?').pluck().get(own)).toBe(0)
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('gives the home the opening balance first when the opening ledger keeps its rows, and the base shifts as the notice says', () => {
    const w = world({ opening: -1_000 })
    const { personal, family } = w
    w.addTx(personal, '2026-07-01', -200)
    w.move(personal, [w.addTx(personal, '2026-07-05', -300)], family)
    // Family is the home, and Personal, the old one, keeps the opening balance.
    changeHome(personal, w.ctxOf, w.visa, family.ledger.id, TESTER)
    setBalance(family, w.visa, { date: '2026-07-31', balanceMinor: -2_000 })
    w.move(family, [w.addTx(family, '2026-08-01', -10)], personal)
    applyRemoteTransactions(family, w.ctxOf, w.visa, [remote('p1', '2026-09-28', -4_000, 'Corner Cafe', { pending: true })], { removed: [], floor: null }, 'plaid')
    const pending = family.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND external_id = 'p1'")!
    w.move(family, [pending], personal)
    const before = w.check()
    // Personal: −2000 − 10 − 4000 (after 31 July) less Family's −300 up to it.
    expect(before.parts).toEqual({ family: -300, personal: -5_710 })
    // Personal's base at each date: its part less its own rows.
    const pastBefore = w.partsAt(MONTH_ENDS)
    const base = MONTH_ENDS.map((d, i) => pastBefore.personal![i]! - w.own(personal, w.visa, d))
    const pendingFrom = (d: string) => (d >= '2026-09-28' ? -4_000 : 0)

    const change = w.set(family, { ledgers: ['family'], rows: { personal: 'keep' } })
    const own = w.splitOff(personal)
    // The base is what the opening balance and the recorded balance bring the home today: −2000 less
    // Personal's −200 up to it, which it held then (it's Personal's own row).
    expect(change.opening).toEqual({ from: { slug: 'personal', name: 'Personal' }, to: { slug: 'family', name: 'Family' }, baseMinor: -1_500 })
    expect(change.removed).toMatchObject([{ rows: 'keep', moved: 1, kept: 2, account: { id: own, balanceMinor: -210 } }])
    // Its old part is its own account's balance, the pending row that went home and the base.
    expect(-210 + -4_000 + -1_500).toBe(before.parts.personal)
    expect(change.notices).toEqual([
      'Visa’s opening balance and recorded balances move to Family: -$15.00 of its balance today, and earlier balances shift too.',
      '1 pending transaction goes to Family, because the bank will post it again.',
      'Personal’s new account keeps its balance of -$2.10, and Visa’s total is the whole bank balance again, so that amount is also in Family until you record how it was settled.',
    ])
    expect(w.check(own)).toEqual({ parts: { family: before.totalMinor }, totalMinor: before.totalMinor })
    // Family's part at past month-ends takes Personal's base, and the pending row from its date on.
    const pastAfter = w.partsAt(MONTH_ENDS)
    expect(pastAfter.family!.map((p, i) => p - pastBefore.family![i]!)).toEqual(MONTH_ENDS.map((d, i) => base[i]! + pendingFrom(d)))
    expect(w.storage.sqlite.prepare('SELECT opening_ledger_id FROM accounts WHERE id = ?').pluck().get(w.visa)).toBeNull()

    deleteAccount(personal, w.ctxOf, own)
    deleteAccount(family, w.ctxOf, w.visa)
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('keeps a ledger’s rows in three ledgers, the others’ parts at past dates unchanged', () => {
    const w = world({ shareWith: ['family', 'trip'], opening: -500 })
    const { personal, family, trip } = w
    const rows = [w.addTx(personal, '2026-07-02', -100), w.addTx(personal, '2026-08-02', -200), w.addTx(personal, '2026-09-02', -300)]
    setBalance(personal, w.visa, { date: '2026-08-31', balanceMinor: -1_400 })
    w.move(personal, [rows[0]!], family)
    w.move(personal, [rows[1]!, rows[2]!], trip)
    const before = w.check()
    const pastBefore = w.partsAt(MONTH_ENDS)

    const change = w.set(personal, { ledgers: ['personal', 'family'], rows: { trip: 'keep' } })
    const own = w.splitOff(trip)
    expect(change.removed).toMatchObject([{ ledger: { slug: 'trip' }, moved: 0, kept: 2, account: { id: own, balanceMinor: -500 } }])
    expect(change.notices).toEqual([
      'Trip’s new account keeps its balance of -$5.00, and Visa’s total is the whole bank balance again, so that amount is also in Personal until you record how it was settled.',
    ])
    // Family's part is its rows, as before. Personal's takes what Trip owed today, and nothing at past dates.
    expect(w.check(own)).toEqual({ parts: { personal: before.totalMinor - before.parts.family!, family: before.parts.family }, totalMinor: before.totalMinor })
    const pastAfter = w.partsAt(MONTH_ENDS)
    expect(pastAfter.personal).toEqual(pastBefore.personal)
    expect(pastAfter.family).toEqual(pastBefore.family)
    expect(getSharingMembers(personal, w.visa)).toEqual(['family'])

    // Trip's own account, shared with Family in turn, which keeps its row: split off from Trip's
    // account, the one it was split off from directly. Visa reaches it through that one.
    addMember(trip, w.ctxOf, own, family.ledger.id, TESTER)
    moveTransactions(trip, w.ctxOf, { ids: [rows[1]!], to: family.ledger.id }, TESTER)
    setSharing(trip, w.ctxOf, own, { ledgers: ['trip'], rows: { family: 'keep' } }, { actor: TESTER })
    const again = w.splitOff(family, own)
    expect(w.storage.sqlite.prepare('SELECT id FROM accounts WHERE split_from_id = ? ORDER BY id').pluck().all(w.visa)).toEqual([own])
    expect(personal.accountWide.splitOffs(w.visa).map((s) => s.id)).toEqual([own, again])
    expect(personal.accountWide.splitOffs(own).map((s) => s.id)).toEqual([again])
    expect(family.q.column('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ?', again)).toEqual([rows[1]])
    w.check(own, again)
  })
})

const getSharingMembers = (ctx: AppContext, visa: number) => getAccount(ctx, visa).sharing!.ledgers.map((l) => l.slug).filter((s) => s !== ctx.ledger.slug)

// A fake SimpleFIN Bridge, with the card as two bank accounts: "old", which Visa syncs from, and "new", another service's view of it.

interface FakeTx {
  id: string
  date: string
  amount: string
  payee: string
  pending?: boolean
}

const at = (date: string) => Math.floor(Date.parse(`${date}T16:00:00Z`) / 1000)
const tx = (id: string, date: string, amount: string, payee: string, pending = false): FakeTx => ({ id, date, amount, payee, pending })

function fakeBridge(card: Record<'old' | 'new', { balance: string; transactions: FakeTx[] }>) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (/\/simplefin\/claim\/\w+$/.test(url.pathname) && init?.method === 'POST') return new Response('https://user%40x:s3cret@bridge.test/simplefin')
    if (url.pathname !== '/simplefin/accounts') return new Response('not found', { status: 404 })
    const start = Number(url.searchParams.get('start-date') ?? 0)
    const end = Number(url.searchParams.get('end-date') ?? Infinity)
    return Response.json({
      errlist: [],
      connections: [{ conn_id: 'CON-1', name: 'TD - Me', org_name: 'TD Canada Trust', org_id: 'td' }],
      accounts: (['old', 'new'] as const).map((id) => ({
        id,
        name: id === 'old' ? 'Visa' : 'Visa Infinite',
        conn_id: 'CON-1',
        currency: 'CAD',
        balance: card[id].balance,
        'balance-date': at('2026-10-03'),
        transactions:
          url.searchParams.get('balances-only') === '1'
            ? undefined
            : card[id].transactions
                .map((t) => ({
                  id: t.id,
                  posted: t.pending ? 0 : at(t.date),
                  transacted_at: at(t.date),
                  amount: t.amount,
                  description: t.payee.toUpperCase(),
                  payee: t.payee,
                  ...(t.pending ? { pending: true } : {}),
                }))
                .filter((t) => t.transacted_at >= start && t.transacted_at < end),
      })),
    })
  }) as typeof globalThis.fetch
}

const TOKEN = Buffer.from('https://bridge.test/simplefin/claim/TOKEN1').toString('base64')

/**
 * Visa synced from "old" in Personal, Book Shop, Gas Bar and the pending Pizza moved to Family, and
 * a card fee Family entered by hand. Then Family stops sharing it and keeps its rows.
 */
async function kept() {
  const card = {
    old: {
      balance: '-200.00',
      transactions: [
        tx('o1', '2026-09-28', '-50.00', 'Corner Cafe'),
        tx('o2', '2026-09-29', '-30.00', 'Book Shop'),
        tx('o3', '2026-09-30', '-70.00', 'Gas Bar'),
        tx('o4', '2026-10-01', '-45.00', 'Pizza', true),
      ],
    },
    new: { balance: '-215.00', transactions: [] as FakeTx[] },
  }
  const w = world({ fetch: fakeBridge(card) })
  const bank = new BankService(w.storage)
  const conn = await bank.connect({ setupToken: TOKEN })
  const bankAccount = (remoteId: string) => conn.accounts.find((a) => a.remoteId === remoteId)!.id
  bank.linkAccount(w.personal, w.visa, { bankAccountId: bankAccount('old') }, null)
  const sync = async (opts: { full?: boolean } = {}) => {
    const result = await bank.sync(conn.id, opts)
    expect(result.ok, result.error ?? '').toBe(true)
    return result.accounts.find((a) => a.accountId === w.visa)!
  }
  await sync()
  const idOf = (externalId: string) => w.rowsOn(w.personal, w.visa).find((r) => r.externalId === externalId)!.id
  w.move(w.personal, [idOf('o2'), idOf('o3'), idOf('o4')], w.family)
  const fee = await createTransaction(
    w.family,
    transactionCreateSchema.parse({ accountId: w.visa, date: '2026-09-30', amountMinor: -500, payee: 'Card Fee' }),
    { useAi: false },
  )
  // The bank doesn't have the fee: the next sync puts the difference in Personal's part, the opening ledger's.
  expect(getAccount(w.personal, w.visa).sharing!.totalBalanceMinor).toBe(-20_500)
  await sync()
  expect(w.check().totalMinor).toBe(-20_000)
  const change = w.set(w.personal, { ledgers: ['personal'], rows: { family: 'keep' } })
  const own = w.splitOff(w.family)
  return { ...w, card, bank, conn, bankAccount, sync, fee, change, own }
}

describe('the rows a ledger kept on its own account, for the account’s bank', () => {
  it('are known to its sync, which adds nothing for them and changes none of them, with the bank unchanged or not', async () => {
    const w = await kept()
    const { personal, family, own } = w
    // The bank's balance is the account's again, recorded as a sync would.
    expect(w.change.removed).toMatchObject([{ moved: 1, kept: 3, account: { balanceMinor: -10_500 } }])
    expect(w.check(own)).toEqual({ parts: { personal: -20_000 }, totalMinor: -20_000 })
    expect(listSnapshots(personal, w.visa)).toMatchObject([{ date: '2026-10-03', balanceMinor: -20_000, source: 'sync' }])
    const keptRows = () => w.rowsOn(family, own)
    expect(keptRows().map((r) => [r.externalId, r.amount])).toEqual([
      ['o2', -3_000],
      ['o3', -7_000],
      [null, -500],
    ])

    const unchanged = w.everything()
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    expect(w.everything()).toEqual(unchanged)

    // The bank changes a row Family kept: it's another account's, so nothing follows, and nothing is logged for it.
    w.card.old.transactions[1] = tx('o2', '2026-09-29', '-35.00', 'Book Shop Ltd')
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    expect(w.everything()).toEqual(unchanged)
    // The bank drops one: it isn't removed.
    w.card.old.transactions.splice(2, 1)
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    expect(w.everything()).toEqual(unchanged)
    // Fetch history: everything sent again.
    w.card.old.transactions.splice(2, 0, tx('o3', '2026-09-30', '-70.00', 'Gas Bar'))
    expect(await w.sync({ full: true })).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    expect(w.everything()).toEqual(unchanged)
    // Applying what was kept again, as at boot, changes none of them either.
    expect(w.bank.applyKept()).toBe(0)

    // The pending one, home now, posts there.
    w.card.old.transactions[3] = tx('c4', '2026-10-02', '-48.00', 'Pizza')
    w.card.old.balance = '-203.00'
    expect(await w.sync()).toMatchObject({ added: 0, updated: 1 })
    expect(w.rowsOn(personal, w.visa).find((r) => r.externalId === 'c4')).toMatchObject({ amount: -4_800, status: 'cleared' })
    expect(keptRows().map((r) => [r.externalId, r.amount])).toEqual([
      ['o2', -3_000],
      ['o3', -7_000],
      [null, -500],
    ])
    expect(w.check(own).totalMinor).toBe(-20_300)
  })

  it('are duplicates to a CSV import, and their bank ids another account’s', async () => {
    const w = await kept()
    const { personal, own } = w
    const statement = [
      { line: 2, date: '2026-09-28', payee: 'Corner Cafe', amountMinor: -5_000 },
      { line: 3, date: '2026-09-29', payee: 'Book Shop', amountMinor: -3_000 },
      { line: 4, date: '2026-09-30', payee: 'Gas Bar', amountMinor: -7_000, externalId: 'o3' },
      { line: 5, date: '2026-10-02', payee: 'Bakery', amountMinor: -600 },
    ]
    const shown = previewImport(personal, importPreviewSchema.parse({ accountId: w.visa, rows: statement }))
    expect(shown.map((r) => ({ payee: r.payee, duplicateOf: r.duplicateOf, duplicateElsewhere: r.duplicateElsewhere }))).toEqual([
      { payee: 'Corner Cafe', duplicateOf: w.rowsOn(personal, w.visa).find((r) => r.externalId === 'o1')!.id, duplicateElsewhere: false },
      // Family's own account has them: by date, amount and payee, and by the bank id.
      { payee: 'Book Shop', duplicateOf: null, duplicateElsewhere: true },
      { payee: 'Gas Bar', duplicateOf: null, duplicateElsewhere: true },
      { payee: 'Bakery', duplicateOf: null, duplicateElsewhere: false },
    ])
    for (const r of w.rowsOn(w.family, own)) expect(JSON.stringify(shown)).not.toContain(`"duplicateOf":${r.id}`)
    expect(commitImport(personal, importCommitSchema.parse({ accountId: w.visa, rows: statement.slice(0, 3) }), { background: false })).toMatchObject({
      imported: 0,
      skippedDuplicates: 3,
    })

    // Entered by hand with one of their bank ids: refused, as any insert is.
    const message = 'Another account has this transaction'
    expect(status(() => findByExternalId(personal, w.visa, 'o2'))).toEqual({ status: 409, message })
    const entry = transactionCreateSchema.parse({ accountId: w.visa, date: '2026-09-29', amountMinor: -3_000, payee: 'Book Shop', externalId: 'o2' })
    await expect(createTransaction(personal, entry, { useAi: false })).rejects.toMatchObject({ status: 409, message })
    // In Family, on its own account, the bank id is its own.
    expect(findByExternalId(w.family, own, 'o2')).toMatchObject({ deleted: false })
    w.check(own)
  })

  it('make a link without review a 409, and a switch only gives them the new bank ids', async () => {
    const w = await kept()
    const { personal, family, own } = w
    expect(status(() => w.bank.linkAccount(personal, w.visa, { bankAccountId: w.bankAccount('old') }, null))).toEqual({
      status: 409,
      message: 'Some of Visa’s transactions went to an account of their own when a ledger stopped sharing it. Switch it with a review, so the bank doesn’t add them again.',
    })

    // The new service has every row, worded its own way, with one more.
    w.card.new.transactions = [
      tx('n1', '2026-09-28', '-50.00', 'Tst-Corner Cafe'),
      tx('n2', '2026-09-29', '-30.00', 'Book Shop Ltd'),
      tx('n3', '2026-09-30', '-70.00', 'Gas Bar #12'),
      tx('n5', '2026-10-02', '-15.00', 'Bakery'),
    ]
    await w.sync()
    const target = w.bankAccount('new')
    // Family's rows are written to in the switch: a key must be allowed there too.
    expect(status(() => w.bank.previewSwitch(personal, w.visa, { bankAccountId: target }, [personal.ledger.id]))).toMatchObject({ status: 403 })
    const preview = w.bank.previewSwitch(personal, w.visa, { bankAccountId: target }, [personal.ledger.id, family.ledger.id])
    const [o2, o3] = w.rowsOn(family, own).filter((r) => r.externalId)
    const elsewhere = { ledger: { slug: 'family', name: 'Family' }, account: 'Visa' }
    const local = (id: number) => preview.rows.find((r) => r.local?.id === id)!
    expect(local(o2!.id)).toMatchObject({ kind: 'matched', local: { elsewhere }, remote: { remoteId: 'n2' } })
    expect(local(o3!.id)).toMatchObject({ kind: 'matched', local: { elsewhere }, remote: { remoteId: 'n3' } })
    expect(local(w.fee.id)).toMatchObject({ kind: 'local', local: { payee: 'Card Fee', elsewhere }, remote: null })

    const pairs = preview.rows.filter((r) => r.kind === 'matched' || r.kind === 'guessed').map((r) => ({ transactionId: r.local!.id, remoteId: r.remote!.remoteId }))
    const input = accountBankSwitchSchema.parse({ bankAccountId: target, version: preview.version, from: preview.from, pairs, skip: [], remove: [] })
    // One of Family's can't be removed.
    expect(status(() => w.bank.switchAccount(personal, w.visa, { ...input, remove: [w.fee.id] }, null))).toMatchObject({ status: 400 })
    const before = w.rowsOn(family, own)
    const result = w.bank.switchAccount(personal, w.visa, input, null)
    expect(result).toMatchObject({ matched: 3, added: 1, removed: 0 })
    // Only the bank ids changed: not the dates, amounts or payees.
    expect(w.rowsOn(family, own)).toEqual(before.map((r) => (r.externalId === 'o2' ? { ...r, externalId: 'n2' } : r.externalId === 'o3' ? { ...r, externalId: 'n3' } : r)))
    expect(w.check(own).totalMinor).toBe(-21_500)

    // The next sync knows them by their new ids.
    const unchanged = w.everything()
    expect(await w.sync()).toMatchObject({ added: 0, updated: 0, adopted: 0, removed: 0 })
    expect(w.everything()).toEqual(unchanged)
  })
})

/** Waits for the clock to tick past this millisecond: SQLite stamps created_at to the millisecond, and a row added after a split must be stamped after it. */
const tick = () => {
  const start = Date.now()
  while (Date.now() < start + 2) {
    // waiting
  }
}

describe('a ledger that keeps its rows, for the account’s bank and CSV imports', () => {
  /** Applied to Visa in its home as Plaid's changes. */
  const plaid = (w: ReturnType<typeof world>, changed: RemoteTransaction[], removed: Array<{ remoteId: string }> = []) =>
    applyRemoteTransactions(w.personal, w.ctxOf, w.visa, changed, { removed, floor: null }, 'plaid')
  const bankRow = (ctx: AppContext, externalId: string) => ctx.q.pluck<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND external_id = ?', externalId)!
  const shown = (ctx: AppContext, account: number, rows: Array<{ line: number; date: string; payee: string; amountMinor: number; externalId?: string }>) =>
    previewImport(ctx, importPreviewSchema.parse({ accountId: account, rows })).map((r) => ({ payee: r.payee, duplicate: r.duplicateOf !== null || r.duplicateElsewhere }))

  it('matches each row for the account it was on before it left, two splits down, importing into both', () => {
    const w = world()
    const { personal, family, trip } = w
    // Visa's own row, which Family keeps, then moves to Trip, which keeps it too.
    const old = w.addTx(personal, '2026-09-10', -1_500, { payee: 'Book Shop' })
    w.move(personal, [old], family)
    w.set(personal, { ledgers: ['personal'], rows: { family: 'keep' } })
    const own = w.splitOff(family)
    tick()
    // Family's account, shared with Trip: a file Family imports into it, and a row Trip enters itself. Neither was ever Visa's.
    addMember(family, w.ctxOf, own, trip.ledger.id, TESTER)
    commitImport(family, importCommitSchema.parse({ accountId: own, rows: [{ line: 2, date: '2026-09-15', payee: 'Pizza Place', amountMinor: -2_000 }] }), {
      background: false,
    })
    const pizza = family.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND payee = 'Pizza Place'")!
    const bakery = w.addTx(trip, '2026-09-15', -600, { account: own, payee: 'Bakery' })
    w.move(family, [old, pizza], trip)
    setSharing(family, w.ctxOf, own, { ledgers: ['family'], rows: { trip: 'keep' } }, { actor: TESTER })
    const again = w.splitOff(trip, own)
    expect(w.storage.sqlite.prepare('SELECT split_from_id FROM accounts WHERE id = ?').pluck().get(again)).toBe(own)
    expect(trip.q.column('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? ORDER BY id', again)).toEqual([old, pizza, bakery])

    const statement = [
      { line: 2, date: '2026-09-10', payee: 'Book Shop', amountMinor: -1_500 },
      { line: 3, date: '2026-09-15', payee: 'Pizza Place', amountMinor: -2_000 },
      { line: 4, date: '2026-09-15', payee: 'Bakery', amountMinor: -600 },
    ]
    // Into Family's account, all three were its rows before they left it.
    expect(shown(family, own, statement)).toEqual(statement.map((r) => ({ payee: r.payee, duplicate: true })))
    expect(commitImport(family, importCommitSchema.parse({ accountId: own, rows: statement }), { background: false })).toMatchObject({ imported: 0, skippedDuplicates: 3 })
    // Into Visa, only the one that was Visa's: the others came after Family's account was made.
    expect(shown(personal, w.visa, statement)).toEqual([
      { payee: 'Book Shop', duplicate: true },
      { payee: 'Pizza Place', duplicate: false },
      { payee: 'Bakery', duplicate: false },
    ])
    expect(personal.accountWide.switchRows(w.visa, '2026-01-01').map((r) => r.id)).toEqual([old])
    expect(personal.accountWide.switchRows(own, '2026-01-01').map((r) => r.id)).toEqual([old, pizza, bakery])
    expect(commitImport(personal, importCommitSchema.parse({ accountId: w.visa, rows: statement }), { background: false })).toMatchObject({
      imported: 2,
      skippedDuplicates: 1,
    })
    w.check(own, again)
  })

  it('sends home a pending row it deleted, so the posted one Plaid says replaces it stays deleted', () => {
    const w = world()
    const { personal, family } = w
    plaid(w, [remote('p2', '2026-09-30', -4_000, 'Cafe', { pending: true })])
    const p2 = bankRow(personal, 'p2')
    w.move(personal, [p2], family)
    // Family entered the same charge by hand, and deleted the bank's.
    const twin = w.addTx(family, '2026-09-30', -4_000, { payee: 'Cafe' })
    deleteTransaction(family, p2)

    const change = w.set(personal, { ledgers: ['personal'], rows: { family: 'keep' } })
    const own = w.splitOff(family)
    expect(change.removed).toMatchObject([{ moved: 0, sentAsDeleted: 1, kept: 1, account: { id: own, balanceMinor: -4_000 } }])
    expect(w.rowsOn(personal, w.visa)).toMatchObject([{ id: p2, externalId: 'p2', status: 'pending', deleted: 1 }])
    expect(w.rowsOn(family, own)).toMatchObject([{ id: twin, deleted: 0 }])

    // Posted, replacing it: nothing is added, and it stays deleted, as on an account that isn't shared.
    expect(plaid(w, [remote('c2', '2026-10-01', -4_000, 'Cafe', { replaces: 'p2' })], [{ remoteId: 'p2' }])).toMatchObject({ added: 0, updated: 0 })
    expect(w.rowsOn(personal, w.visa)).toMatchObject([{ id: p2, externalId: 'c2', status: 'cleared', deleted: 1 }])
    w.check(own)
  })

  it('leaves the account the bank ids of a split-off account that goes, so its sync and imports add nothing for them', () => {
    const w = world()
    const { personal, family, trip } = w
    plaid(w, [remote('k1', '2026-09-20', -9_000, 'Book Shop'), remote('k2', '2026-09-21', -1_200, 'Gas Bar')])
    const [k1, k2] = [bankRow(personal, 'k1'), bankRow(personal, 'k2')]
    w.move(personal, [k1, k2], family)
    deleteTransaction(family, k2)
    const deletedAt = family.q.pluck<string>('SELECT deleted_at FROM transactions WHERE ledger_id = @ledger AND id = ?', k2)
    w.set(personal, { ledgers: ['personal'], rows: { family: 'keep' } })
    const own = w.splitOff(family)
    tick()
    const resend = () => plaid(w, [remote('k1', '2026-09-20', -9_000, 'Book Shop'), remote('k2', '2026-09-21', -1_200, 'Gas Bar')])
    expect(resend()).toMatchObject({ added: 0, updated: 0 })

    // Family's account, shared with Trip, which keeps Book Shop on an account of its own, and a row
    // with a bank id Family imports later, which was never Visa's.
    addMember(family, w.ctxOf, own, trip.ledger.id, TESTER)
    commitImport(family, importCommitSchema.parse({ accountId: own, rows: [{ line: 2, date: '2026-09-25', payee: 'Pizza', amountMinor: -700, externalId: 'x1' }] }), {
      background: false,
    })
    w.move(family, [k1], trip)
    setSharing(family, w.ctxOf, own, { ledgers: ['family'], rows: { trip: 'keep' } }, { actor: TESTER })
    const again = w.splitOff(trip, own)

    // Family's account goes, the one in the middle: Visa keeps its bank ids, as deleted rows in its home, with nothing else of theirs.
    deleteAccount(family, w.ctxOf, own)
    expect(w.rowsOn(personal, w.visa).map(({ externalId, date, amount, payee, status, deleted, batch }) => ({ externalId, date, amount, payee, status, deleted, batch }))).toEqual([
      { externalId: 'k1', date: '2026-09-20', amount: -9_000, payee: 'Book Shop', status: 'cleared', deleted: 1, batch: null },
      { externalId: 'k2', date: '2026-09-21', amount: -1_200, payee: 'Gas Bar', status: 'cleared', deleted: 1, batch: null },
    ])
    const left = personal.q.all(
      `SELECT external_id AS externalId, deleted_at AS deletedAt, removed_at AS removedAt, category_id AS categoryId, notes, recurring_item_id AS item, transfer_pair_id AS pair, origin
       FROM transactions WHERE ledger_id = @ledger AND account_id = ? ORDER BY id`,
      w.visa,
    )
    expect(left).toEqual([
      { externalId: 'k1', deletedAt: '2026-10-03T18:00:00.000Z', removedAt: null, categoryId: null, notes: null, item: null, pair: null, origin: 'sync' },
      { externalId: 'k2', deletedAt, removedAt: null, categoryId: null, notes: null, item: null, pair: null, origin: 'sync' },
    ])
    // Trip's account keeps its row, and nothing comes back to Visa: not by sync, nor by a file.
    expect(trip.q.column('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ?', again)).toEqual([k1])
    expect(resend()).toMatchObject({ added: 0, updated: 0 })
    const file = [{ line: 2, date: '2026-09-20', payee: 'Book Shop', amountMinor: -9_000, externalId: 'k1' }]
    expect(commitImport(personal, importCommitSchema.parse({ accountId: w.visa, rows: file }), { background: false })).toMatchObject({ imported: 0, skippedDuplicates: 1 })
    expect(w.check(again).totalMinor).toBe(getAccount(personal, w.visa).balanceMinor)
  })

  it('leaves them when the ledger that holds the split-off account goes, once that calls for it, and deleting it doesn’t fail before then', () => {
    const kept = () => {
      const w = world()
      plaid(w, [remote('k1', '2026-09-20', -9_000, 'Book Shop')])
      w.move(w.personal, [bankRow(w.personal, 'k1')], w.family)
      w.set(w.personal, { ledgers: ['personal'], rows: { family: 'keep' } })
      return { ...w, kept: w.splitOff(w.family) }
    }
    const w = kept()
    expect(leaveSplitOffBankIds(w.family, w.ctxOf, w.kept)).toBe(1)
    w.storage.registry.remove(w.family.ledger.id)
    expect(plaid(w, [remote('k1', '2026-09-20', -9_000, 'Book Shop')])).toMatchObject({ added: 0, updated: 0 })
    expect(w.rowsOn(w.personal, w.visa)).toMatchObject([{ externalId: 'k1', deleted: 1 }])
    expect(w.storage.sqlite.pragma('foreign_key_check')).toEqual([])

    const before = kept()
    expect(() => before.storage.registry.remove(before.family.ledger.id)).not.toThrow()
    expect(before.storage.sqlite.pragma('foreign_key_check')).toEqual([])
  })
})
