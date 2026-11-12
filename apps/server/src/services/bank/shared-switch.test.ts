import { describe, expect, it, vi } from 'vitest'
import { accountBankSwitchSchema, transactionCreateSchema, transactionUpdateSchema, type ApiKeyCreated, type LinkPreview } from '@chipmunk/shared'
import { createApp } from '../../app'
import { categoryId, makeAccount } from '../../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER } from '../../test/shared-accounts'
import type { AppContext } from '../context'
import { matchTransactions } from '../matching'
import { moveTransactions } from '../moves'
import { setSplit } from '../splits'
import { createTransaction, deleteTransaction, getTransaction, updateTransaction } from '../transactions'
import { BankService } from './service'

// The real matching, its calls recorded: which ledgers a switch settles.
vi.mock('../matching', async (importOriginal) => {
  const real = await importOriginal<typeof import('../matching')>()
  return { ...real, matchTransactions: vi.fn(real.matchTransactions) }
})

/**
 * Switching a shared account's bank service: Personal is Visa's home, where its bank link is, and
 * Family has it. Visa syncs from the bank account "old", and switches to "new", another service's
 * view of the same card (other ids, other wording). The rows Family holds got there by a real move.
 */

interface FakeTx {
  id: string
  date: string
  amount: string
  payee: string
}

const at = (date: string) => Math.floor(Date.parse(`${date}T16:00:00Z`) / 1000)

/** A fake SimpleFIN Bridge with two bank accounts on one connection. */
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
                .map((t) => ({ id: t.id, posted: at(t.date), transacted_at: at(t.date), amount: t.amount, description: t.payee.toUpperCase(), payee: t.payee }))
                .filter((t) => t.transacted_at >= start && t.transacted_at < end),
      })),
    })
  }) as typeof globalThis.fetch
}

const TOKEN = Buffer.from('https://bridge.test/simplefin/claim/TOKEN1').toString('base64')
const tx = (id: string, date: string, amount: string, payee: string): FakeTx => ({ id, date, amount, payee })

/** Visa linked to "old" in Personal and synced, with Book Shop and Gas Bar moved to Family. */
async function world(newTransactions: FakeTx[]) {
  const card = {
    old: {
      balance: '-150.00',
      transactions: [tx('o1', '2026-09-28', '-50.00', 'Corner Cafe'), tx('o2', '2026-09-29', '-30.00', 'Book Shop'), tx('o3', '2026-09-30', '-70.00', 'Gas Bar')],
    },
    new: { balance: '-165.00', transactions: newTransactions },
  }
  const w = sharedWorld({ fetch: fakeBridge(card) })
  const bank = new BankService(w.storage)
  const conn = await bank.connect({ setupToken: TOKEN })
  const bankAccount = (remoteId: string) => conn.accounts.find((a) => a.remoteId === remoteId)!.id
  bank.linkAccount(w.personal, w.visa, { bankAccountId: bankAccount('old') }, null)
  const sync = async () => {
    const result = await bank.sync(conn.id)
    expect(result.ok, result.error ?? '').toBe(true)
  }
  await sync()

  const ledgers = [w.personal, w.family, w.trip]
  /** Visa's rows in every ledger, deleted ones too. */
  const rows = () =>
    ledgers.flatMap((c) =>
      c.q
        .all<{ id: number; externalId: string | null; date: string; amount: number; payee: string; deleted: number }>(
          `SELECT id, external_id AS externalId, date, amount_minor AS amount, payee, deleted_at IS NOT NULL AS deleted
           FROM transactions WHERE ledger_id = @ledger AND account_id = ? ORDER BY id`,
          w.visa,
        )
        .map((r) => ({ ledger: c.ledger.slug, ...r })),
    )
  const row = (externalId: string) => rows().find((r) => r.externalId === externalId)!
  const move = (from: AppContext, externalIds: string[], to: AppContext) =>
    moveTransactions(from, w.ctxOf, { ids: externalIds.map((x) => row(x).id), to: to.ledger.id }, TESTER)
  move(w.personal, ['o2', 'o3'], w.family)
  const check = () => {
    expectPartsSumToAccount(w.storage, w.visa)
    expectNoCrossLedgerReferences(w.storage)
    const ids = rows().flatMap((r) => (r.externalId ? [r.externalId] : []))
    expect(ids.length, 'each bank id once on the account, across its ledgers').toBe(new Set(ids).size)
  }
  return { ...w, card, bank, conn, bankAccount, sync, rows, row, move, check }
}

describe('switching a shared account’s bank service', () => {
  it('reviews the rows of every ledger, refuses when a member changed one since, and changes each where it is', async () => {
    const w = await world([
      tx('n1', '2026-09-28', '-50.00', 'Tst-Corner Cafe'),
      tx('n2', '2026-09-29', '-30.00', 'Book Shop Ltd'),
      tx('n3', '2026-09-30', '-70.00', 'Gas Bar #12'),
      tx('n5', '2026-10-01', '-15.00', 'Bakery'),
    ])
    // Family entered a fee by hand that the new service doesn't have.
    const fee = await createTransaction(
      w.family,
      transactionCreateSchema.parse({ accountId: w.visa, date: '2026-09-30', amountMinor: -500, payee: 'Card Fee' }),
      { useAi: false },
    )
    await w.sync()
    w.check()
    const target = w.bankAccount('new')
    const review = () => w.bank.previewSwitch(w.personal, w.visa, { bankAccountId: target }, null)
    let preview = review()

    // Each local row says which ledger holds it, when it isn't the home.
    const family = { ledger: { slug: 'family', name: 'Family' }, account: null }
    const local = (id: number) => preview.rows.find((r) => r.local?.id === id)!
    expect(local(w.row('o1').id)).toMatchObject({ kind: 'matched', remote: { remoteId: 'n1' } })
    expect(local(w.row('o1').id).local).not.toHaveProperty('elsewhere')
    expect(local(w.row('o2').id)).toMatchObject({ kind: 'matched', local: { elsewhere: family }, remote: { remoteId: 'n2' } })
    expect(local(w.row('o3').id)).toMatchObject({ kind: 'matched', local: { elsewhere: family }, remote: { remoteId: 'n3' } })
    expect(local(fee.id)).toMatchObject({ kind: 'local', local: { payee: 'Card Fee', elsewhere: family }, remote: null })
    expect(preview.rows.filter((r) => r.kind === 'remote').map((r) => r.remote!.remoteId)).toEqual(['n5'])

    const decided = (p: LinkPreview) =>
      accountBankSwitchSchema.parse({
        bankAccountId: target,
        from: p.from,
        version: p.version,
        pairs: p.rows.filter((r) => r.kind === 'matched').map((r) => ({ transactionId: r.local!.id, remoteId: r.remote!.remoteId })),
        remove: [fee.id],
      })
    const stale = (p: LinkPreview) => {
      let error: unknown
      try {
        w.bank.switchAccount(w.personal, w.visa, decided(p), null)
      } catch (err) {
        error = err
      }
      expect(error, 'refused').toMatchObject({ status: 409, message: expect.stringContaining('Transactions changed since this review was made') })
    }

    // Family edits one of its rows after the review: the switch is refused, and nothing changed.
    const before = w.rows()
    updateTransaction(w.family, w.row('o3').id, transactionUpdateSchema.parse({ amountMinor: -7_100 }))
    stale(preview)
    expect(w.rows().filter((r) => r.externalId === 'o1')).toEqual(before.filter((r) => r.externalId === 'o1'))
    updateTransaction(w.family, w.row('o3').id, transactionUpdateSchema.parse({ amountMinor: -7_000 }))
    // A move after the review is refused too.
    preview = review()
    w.move(w.personal, ['o1'], w.family)
    stale(preview)
    w.move(w.family, ['o1'], w.personal)

    preview = review()
    vi.mocked(matchTransactions).mockClear()
    const [o1, o2, o3] = ['o1', 'o2', 'o3'].map((x) => w.row(x).id)
    const result = w.bank.switchAccount(w.personal, w.visa, decided(preview), null)
    expect(result).toMatchObject({ matched: 3, added: 1, skipped: 0, removed: 1, kept: 0 })
    // Paired rows took the new ids where they are, the new one is in the home, and Family's fee is deleted in Family.
    expect(w.rows().map(({ ledger, id, externalId, deleted }) => ({ ledger, id, externalId, deleted }))).toEqual([
      { ledger: 'personal', id: o1, externalId: 'n1', deleted: 0 },
      { ledger: 'personal', id: expect.any(Number), externalId: 'n5', deleted: 0 },
      { ledger: 'family', id: o2, externalId: 'n2', deleted: 0 },
      { ledger: 'family', id: o3, externalId: 'n3', deleted: 0 },
      { ledger: 'family', id: fee.id, externalId: null, deleted: 1 },
    ])
    expect(w.bank.linkedTo(w.personal.ledger.id, w.visa)?.remoteId).toBe('new')
    // Matching ran in each ledger whose rows changed.
    expect(vi.mocked(matchTransactions).mock.calls.map(([c]) => c.ledger.slug).sort()).toEqual(['family', 'personal'])
    w.check()

    // The next sync changes nothing.
    const after = w.rows()
    await w.sync()
    expect(w.rows()).toEqual(after)
    w.check()
  })

  it('doesn’t add again a bank id a member’s row already has', async () => {
    // The new service sends a charge under the id Family's row has (one Family deleted).
    const w = await world([tx('n1', '2026-09-28', '-50.00', 'Corner Cafe'), tx('o3', '2026-09-30', '-70.00', 'Gas Bar')])
    deleteTransaction(w.family, w.row('o3').id)
    await w.sync()
    const target = w.bankAccount('new')
    const preview = w.bank.previewSwitch(w.personal, w.visa, { bankAccountId: target }, null)
    // Left unpaired in the review: still not added.
    const result = w.bank.switchAccount(
      w.personal,
      w.visa,
      accountBankSwitchSchema.parse({ bankAccountId: target, from: preview.from, version: preview.version, pairs: [{ transactionId: w.row('o1').id, remoteId: 'n1' }] }),
      null,
    )
    expect(result).toMatchObject({ matched: 1, added: 0, removed: 0 })
    expect(w.rows().map(({ ledger, externalId, deleted }) => [ledger, externalId, deleted])).toEqual([
      ['personal', 'n1', 0],
      ['family', null, 0],
      ['family', 'o3', 1],
    ])
    w.check()
  })

  it('pairs a split payment, its split rows following it, never offers them, and refuses to remove the payment', async () => {
    const w = await world([
      tx('n1', '2026-09-28', '-50.00', 'Corner Cafe'),
      tx('n2', '2026-09-29', '-30.00', 'Book Shop'),
      tx('n3', '2026-09-30', '-70.00', 'Gas Bar'),
      tx('n4', '2026-10-01', '100.00', 'PAYMENT THANK YOU'),
    ])
    // A card payment Personal entered by hand, a day after the bank's date, split $40 to Family.
    const paid = await createTransaction(
      w.personal,
      transactionCreateSchema.parse({ accountId: w.visa, date: '2026-10-02', amountMinor: 10_000, payee: 'PAYMENT THANK YOU', categoryId: categoryId(w.personal, 'Credit card payment') }),
      { useAi: false },
    )
    setSplit(w.personal, w.ctxOf, paid.id, { shares: [{ ledger: 'family', amountMinor: 4_000 }] }, { actor: TESTER, usable: null })
    const splitRows = () =>
      [w.personal, w.family].flatMap((c) =>
        c.q.all<{ id: number; amount: number; date: string }>('SELECT id, amount_minor AS amount, date FROM transactions WHERE ledger_id = @ledger AND split_of = ? ORDER BY id', paid.id),
      )
    const split = splitRows()
    expect(split.map((r) => [r.amount, r.date])).toEqual([
      [-4_000, '2026-10-02'],
      [4_000, '2026-10-02'],
    ])
    w.check()

    const target = w.bankAccount('new')
    const preview = w.bank.previewSwitch(w.personal, w.visa, { bankAccountId: target }, null)
    expect(preview.rows.find((r) => r.local?.id === paid.id)).toMatchObject({ kind: 'matched', remote: { remoteId: 'n4' } })
    for (const r of split) expect(preview.rows.some((row) => row.local?.id === r.id)).toBe(false)
    const decided = (remove: number[]) =>
      accountBankSwitchSchema.parse({
        bankAccountId: target,
        from: preview.from,
        version: preview.version,
        pairs: preview.rows.filter((r) => r.kind === 'matched').map((r) => ({ transactionId: r.local!.id, remoteId: r.remote!.remoteId })),
        remove,
      })

    // Removing it is refused before anything changes, the link included.
    const before = w.rows()
    let error: unknown
    try {
      w.bank.switchAccount(w.personal, w.visa, decided([paid.id]), null)
    } catch (err) {
      error = err
    }
    expect(error).toMatchObject({ status: 409, message: 'Undo the split of the $100.00 payment onto Visa on 2026-10-02 first.' })
    expect(w.rows()).toEqual(before)
    expect(w.bank.linkedTo(w.personal.ledger.id, w.visa)?.remoteId).toBe('old')

    // Paired, it takes the bank's id and date, and its split rows the date.
    expect(w.bank.switchAccount(w.personal, w.visa, decided([]), null)).toMatchObject({ matched: 4, removed: 0 })
    expect(w.row('n4')).toMatchObject({ id: paid.id, amount: 10_000, date: '2026-10-01' })
    expect(splitRows()).toEqual(split.map((r) => ({ ...r, date: '2026-10-01' })))
    expect(getTransaction(w.personal, paid.id).split).toMatchObject({ part: 'payment', keptMinor: 6_000 })
    w.check()
    expect(splitRows().reduce((s, r) => s + r.amount, 0)).toBe(0)
  })

  it('re-points a linked shared account without a review, matching its rows in every ledger', async () => {
    const w = await world([
      tx('n1', '2026-09-28', '-50.00', 'Corner Cafe'),
      tx('n2', '2026-09-29', '-30.00', 'Book Shop'),
      tx('n3', '2026-09-30', '-70.00', 'Gas Bar'),
      tx('n5', '2026-10-01', '-15.00', 'Bakery'),
    ])
    await w.sync()
    const [o1, o2, o3] = ['o1', 'o2', 'o3'].map((x) => w.row(x).id)
    // As PUT /accounts/:id/bank does.
    w.bank.linkAccount(w.personal, w.visa, { bankAccountId: w.bankAccount('new') }, null)
    expect(w.bank.fill(w.personal, w.visa)).toEqual({ added: 1, adopted: 0 })
    expect(w.rows().map(({ ledger, id, externalId }) => ({ ledger, id, externalId }))).toEqual([
      { ledger: 'personal', id: o1, externalId: 'n1' },
      { ledger: 'personal', id: expect.any(Number), externalId: 'n5' },
      { ledger: 'family', id: o2, externalId: 'n2' },
      { ledger: 'family', id: o3, externalId: 'n3' },
    ])
    w.check()
  })

  it('refuses a key limited to some of the ledgers that have the account', async () => {
    const w = await world([tx('n1', '2026-09-28', '-50.00', 'Corner Cafe')])
    await w.sync()
    const target = w.bankAccount('new')
    const message = 'A key limited to some ledgers can’t switch a shared account. Do it in the app.'
    const personalOnly = [w.personal.ledger.id]
    const refused = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ status: 403, message }))
    refused(() => w.bank.previewSwitch(w.personal, w.visa, { bankAccountId: target }, personalOnly))
    refused(() => w.bank.switchAccount(w.personal, w.visa, accountBankSwitchSchema.parse({ bankAccountId: target, from: '2026-09-01', version: 'v', pairs: [] }), personalOnly))
    refused(() => w.bank.linkAccount(w.personal, w.visa, { bankAccountId: target }, personalOnly))
    expect(w.bank.linkedTo(w.personal.ledger.id, w.visa)?.remoteId).toBe('old')
    // Allowed in every ledger that has it (not Trip): fine. So is a key for one ledger on an account that isn't shared.
    expect(w.bank.previewSwitch(w.personal, w.visa, { bankAccountId: target }, [w.personal.ledger.id, w.family.ledger.id]).rows).not.toHaveLength(0)
    w.bank.endReview(w.personal, w.visa)
    const chequing = makeAccount(w.personal, 'Chequing', 'chequing')
    expect(w.bank.previewSwitch(w.personal, chequing, { bankAccountId: target }, personalOnly).rows).not.toHaveLength(0)
    w.bank.endReview(w.personal, chequing)

    // Over HTTP, the preview, the switch and PUT /accounts/:id/bank, with a key for Personal only.
    const app = createApp(w.storage, { trustedHeader: null, bank: w.bank })
    const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(`/api/v1${url}`, {
        method,
        headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as unknown }
    }
    const created = (await api('POST', '/api-keys', { name: 'Personal', scopes: ['read', 'write'], ledgers: personalOnly })).body as ApiKeyCreated
    const key = { authorization: `Bearer ${created.key}` }
    const visa = `/ledgers/personal/accounts/${w.visa}/bank`
    // Visa's own bank account is the one a limited key may name; the refusal is for the account, not the bank account.
    const old = w.bankAccount('old')
    for (const [method, url, body] of [
      ['POST', `${visa}/preview`, { bankAccountId: old }],
      ['POST', `${visa}/switch`, { bankAccountId: old, from: '2026-09-01', version: 'v', pairs: [] }],
      ['PUT', visa, { bankAccountId: old }],
    ] as const) {
      expect(await api(method, url, body, key), `${method} ${url}`).toEqual({ status: 403, body: { error: { code: 'forbidden', message } } })
    }
    w.check()
  })
})
