import { describe, expect, it } from 'vitest'
import { makeAccount, testLedger, testStorage } from '../test/helpers'
import type { AppContext } from './context'
import {
  balancesAt,
  createAccount,
  deleteAccount,
  deleteSnapshot,
  getAccount,
  listAccounts,
  listSnapshots,
  saveImportMapping,
  setBalance,
  updateAccount,
} from './accounts'

/** Two ledgers with the same-looking accounts: Personal and Family, each with a TD Chequing. */
function twoLedgers() {
  const storage = testStorage()
  const personal = storage.registry.defaultContext()
  const family = testLedger(storage)
  return { storage, personal, family }
}

const addTx = (ctx: AppContext, account: number, date: string, amount: number) =>
  Number(
    ctx.q.run(
      `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES (@ledger, @account, @date, @amount, 'Shop', 'shop')`,
      { account, date, amount },
    ).lastInsertRowid,
  )

const notFound = { status: 404, message: 'Account not found' }

describe('accounts in one database', () => {
  it('lists, balances and sorts each ledger’s accounts on their own', () => {
    const { personal, family } = twoLedgers()
    const p = createAccount(personal, { name: 'TD Chequing', type: 'chequing', institution: 'TD', currency: 'CAD', openingBalanceMinor: 1_000 })
    const p2 = createAccount(personal, { name: 'Savings', type: 'savings', institution: 'TD', currency: 'CAD', openingBalanceMinor: 0 })
    const f = createAccount(family, { name: 'TD Chequing', type: 'chequing', institution: 'TD', currency: 'CAD', openingBalanceMinor: 5_000 })
    expect([p.sort, p2.sort, f.sort]).toEqual([0, 1, 0])
    expect(f.institutionId).not.toBe(p.institutionId)

    addTx(personal, p.id, '2026-09-01', -200)
    addTx(family, f.id, '2026-09-01', -700)
    addTx(family, f.id, '2026-09-02', -100)

    expect(listAccounts(personal).map((a) => [a.id, a.balanceMinor, a.transactionCount])).toEqual([
      [p.id, 800, 1],
      [p2.id, 0, 0],
    ])
    expect(listAccounts(family).map((a) => [a.id, a.balanceMinor, a.transactionCount])).toEqual([[f.id, 4_200, 2]])

    const balances = balancesAt(family, ['2026-09-01', '2026-09-30'])
    expect([...balances.keys()]).toEqual([f.id])
    expect(balances.get(f.id)).toEqual([4_300, 4_200])
    expect([...balancesAt(personal, ['2026-09-30']).keys()].sort()).toEqual([p.id, p2.id].sort())
  })

  it('takes the latest snapshot of the account’s own ledger', () => {
    const { personal, family } = twoLedgers()
    const p = makeAccount(personal, 'Card', 'credit')
    const f = makeAccount(family, 'Card', 'credit')
    setBalance(personal, p, { date: '2026-09-10', balanceMinor: -300 })
    setBalance(personal, p, { date: '2026-09-10', balanceMinor: -350 })
    setBalance(family, f, { date: '2026-09-20', balanceMinor: -900 })
    addTx(personal, p, '2026-09-15', -50)

    expect(getAccount(personal, p)).toMatchObject({ balanceMinor: -400, balanceAsOf: '2026-09-10' })
    expect(getAccount(family, f)).toMatchObject({ balanceMinor: -900, balanceAsOf: '2026-09-20' })
    expect(listSnapshots(personal, p).map((s) => s.balanceMinor)).toEqual([-350])
    expect(balancesAt(personal, ['2026-09-30']).get(p)).toEqual([-400])

    const snap = listSnapshots(personal, p)[0]!
    expect(deleteSnapshot(personal, p, snap.id)).toEqual({ id: snap.id, date: '2026-09-10', balanceMinor: -350, source: 'manual' })
    expect(getAccount(personal, p)).toMatchObject({ balanceMinor: -50, balanceAsOf: null })
    expect(listSnapshots(family, f)).toHaveLength(1)
  })

  it('refuses another ledger’s account by id', () => {
    const { storage, personal, family } = twoLedgers()
    const p = makeAccount(personal)
    const f = makeAccount(family)
    setBalance(family, f, { date: '2026-09-10', balanceMinor: 100 })
    const snap = listSnapshots(family, f)[0]!

    expect(() => getAccount(personal, f)).toThrow(expect.objectContaining(notFound))
    expect(() => updateAccount(personal, f, { name: 'Mine now' })).toThrow(expect.objectContaining(notFound))
    expect(() => deleteAccount(personal, storage.ctxOf, f)).toThrow(expect.objectContaining(notFound))
    expect(() => setBalance(personal, f, { date: '2026-09-11', balanceMinor: 1 })).toThrow(expect.objectContaining(notFound))
    expect(() => listSnapshots(personal, f)).toThrow(expect.objectContaining(notFound))
    expect(() => deleteSnapshot(personal, f, snap.id)).toThrow(expect.objectContaining({ status: 404, message: 'Balance update not found' }))
    expect(() => deleteSnapshot(personal, p, snap.id)).toThrow(expect.objectContaining({ status: 404, message: 'Balance update not found' }))
    saveImportMapping(personal, f, { date: 0, payee: 1, amount: 2 } as never)

    expect(getAccount(family, f)).toMatchObject({ name: 'TD Chequing', importMapping: null, balanceMinor: 100 })
    expect(listSnapshots(family, f)).toHaveLength(1)
  })

  it('updates an account: only what’s given, archived as a date', () => {
    const { personal } = twoLedgers()
    const id = createAccount(personal, { name: 'Card', type: 'credit', institution: 'TD', currency: 'CAD', openingBalanceMinor: 0, notes: 'old' }).id
    expect(updateAccount(personal, id, { archived: true, sort: 4 })).toMatchObject({ name: 'Card', notes: 'old', archived: true, sort: 4 })
    expect(updateAccount(personal, id, { notes: null, archived: false, institution: 'RBC' })).toMatchObject({ notes: null, archived: false, institution: 'RBC' })
    saveImportMapping(personal, id, { date: 0, payee: 1, amount: 2 } as never)
    expect(getAccount(personal, id).importMapping).toEqual({ date: 0, payee: 1, amount: 2 })
  })

  it('deletes an account with its rows, and only in its ledger', () => {
    const { storage, personal, family } = twoLedgers()
    const p = makeAccount(personal)
    const f = makeAccount(family)
    addTx(personal, p, '2026-09-01', -10)
    addTx(family, f, '2026-09-01', -10)
    setBalance(personal, p, { date: '2026-09-10', balanceMinor: 5 })
    setBalance(family, f, { date: '2026-09-10', balanceMinor: 5 })
    storage.sqlite.prepare(`INSERT INTO bank_connections (id, provider, name, secret) VALUES ('c1', 'simplefin', 'Bank', 'x')`).run()
    const link = storage.sqlite.prepare(`INSERT INTO bank_accounts (id, connection_id, remote_id, name, currency, account_id) VALUES (?, 'c1', ?, 'Chequing', 'CAD', ?)`)
    link.run('bp', 'rp', p)
    link.run('bf', 'rf', f)
    expect(getAccount(personal, p).bank).toMatchObject({ bankAccountId: 'bp', connectionId: 'c1', provider: 'simplefin' })
    expect(getAccount(family, f).bank).toMatchObject({ bankAccountId: 'bf' })

    deleteAccount(personal, storage.ctxOf, p)
    expect(listAccounts(personal)).toEqual([])
    const linkOf = (id: string) => storage.sqlite.prepare('SELECT account_id FROM bank_accounts WHERE id = ?').pluck().get(id)
    expect([linkOf('bp'), linkOf('bf')]).toEqual([null, f])
    const count = (ctx: AppContext, sql: string) => ctx.q.pluck<number>(sql)
    expect(count(personal, 'SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(0)
    expect(count(family, 'SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(1)
    expect(getAccount(family, f)).toMatchObject({ balanceMinor: 5, transactionCount: 1 })
  })
})
