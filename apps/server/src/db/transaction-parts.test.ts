import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { env } from '../env'
import { addLedger, addSharedList, bareDatabase, bareWriter, fillLedger } from '../test/world'

/**
 * A transaction split into categories (migration 0006), on a database without write guards: the
 * lines the transaction_lines view gives for its parts and for what's linked to it, the trigger that
 * keeps the parts adding up to its amount, and the guards on a part's category.
 */

const CROSS = 'cross-ledger reference'

/** Two ledgers on the shared list (A and B) and one with its own (C), with A's purchase of $100 split three ways. */
function world() {
  const sqlite = bareDatabase()
  addLedger(sqlite, 'A')
  addLedger(sqlite, 'B')
  addLedger(sqlite, 'C', 'own')
  const shared = addSharedList(sqlite)
  const a = fillLedger(bareWriter(sqlite, 'A'), { category: shared.food, offCategory: shared.fun })
  const b = fillLedger(bareWriter(sqlite, 'B'), { category: shared.food, offCategory: shared.food })
  const cCategory = bareWriter(sqlite, 'C')("INSERT INTO categories (ledger_id, name) VALUES (@ledger, 'Own food')")
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  const part = (transaction: number, sort: number, category: number | null, amount: number) =>
    run('INSERT INTO transaction_parts (transaction_id, sort, category_id, amount_minor) VALUES (?, ?, ?, ?)', transaction, sort, category, amount)
  const tx = (ledger: string, account: number, date: string, amount: number, category: number | null = null) =>
    Number(
      run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id) VALUES (?, ?, ?, ?, 'x', 'x', ?)", ledger, account, date, amount, category)
        .lastInsertRowid,
    )
  const link = (kind: 'refund' | 'payback', moneyIn: number, moneyOut: number, amount: number) =>
    run('INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES (?, ?, ?, ?)', kind, moneyIn, moneyOut, amount)
  /** A transaction's lines as [amount, category], or with `owner`, the lines of what's linked to it. */
  const lines = (id: number, owner?: number) =>
    (
      sqlite
        .prepare(`SELECT amount_minor, category_id FROM transaction_lines WHERE id = ? AND owner_id = ? ORDER BY ${owner === undefined ? 'link_kind IS NOT NULL, ' : ''}abs(amount_minor) DESC`)
        .raw()
        .all(id, owner ?? id) as Array<[number, number | null]>
    )
  const parts = (id: number) =>
    sqlite.prepare('SELECT category_id, amount_minor FROM transaction_parts WHERE transaction_id = ? ORDER BY sort').raw().all(id) as Array<[number | null, number]>
  const categoryOf = (id: number) => sqlite.prepare('SELECT category_id FROM transactions WHERE id = ?').pluck().get(id) as number | null
  return { sqlite, shared, a, b, cCategory, run, part, tx, link, lines, parts, categoryOf }
}

/** A's purchase of $100: Food $62.10, Fun $18.40, and $19.50 with no category. */
function split(w: ReturnType<typeof world>) {
  // The refund fillLedger linked to it goes: each test links its own.
  w.run('DELETE FROM transaction_links WHERE money_out_id = ?', w.a.purchase)
  w.part(w.a.purchase, 0, w.shared.food, -6210)
  w.part(w.a.purchase, 1, w.shared.fun, -1840)
  w.part(w.a.purchase, 2, null, -1950)
}

describe('transaction_lines', () => {
  it('gives a transaction with no parts exactly the lines the baseline view gave', () => {
    const w = world()
    // More of what the view reads: a payback of part of a bill, money in linked to two bills, a deleted bill.
    const payback = w.tx('A', w.a.savings, '2026-08-20', 3000, w.shared.fun)
    w.link('payback', payback, w.a.payment, 1250)
    w.link('payback', payback, w.a.purchase, 500)
    const gone = w.tx('B', w.b.account, '2026-08-07', -900, w.shared.fun)
    w.link('refund', w.tx('B', w.b.account, '2026-08-09', 900), gone, 900)
    w.run("UPDATE transactions SET deleted_at = '2026-08-10' WHERE id = ?", gone)
    // The view as the baseline made it, under another name.
    const baseline = readFileSync(path.join(env.migrations, '0000_baseline.sql'), 'utf8')
    const was = /CREATE VIEW `transaction_lines` AS[^;]+;/.exec(baseline)![0]
    w.sqlite.exec(was.replace('`transaction_lines`', '`lines_before`'))
    const all = (view: string) => w.sqlite.prepare(`SELECT * FROM ${view} ORDER BY ledger_id, id, owner_id, link_kind`).all()
    expect(all('lines_before').length).toBe(15)
    expect(all('transaction_lines')).toEqual(all('lines_before'))
  })

  it('gives a line for each part in place of its own line', () => {
    const w = world()
    split(w)
    expect(w.lines(w.a.purchase)).toEqual([
      [-6210, w.shared.food],
      [-1950, null],
      [-1840, w.shared.fun],
    ])
    // The same transaction in everything else: its ledger, account, date, payee, and itself as owner.
    expect(w.sqlite.prepare('SELECT DISTINCT ledger_id, account_id, date, payee_key, deleted_at, transfer_pair_id, owner_id, link_kind FROM transaction_lines WHERE id = ?').all(w.a.purchase)).toEqual([
      { ledger_id: 'A', account_id: w.a.account, date: '2026-08-01', payee_key: 'shop', deleted_at: null, transfer_pair_id: null, owner_id: w.a.purchase, link_kind: null },
    ])
    // Deleted, its lines say so: readers leave them out, and they're back when it's restored.
    w.run("UPDATE transactions SET deleted_at = '2026-09-01' WHERE id = ?", w.a.purchase)
    expect(w.sqlite.prepare('SELECT count(*) FROM transaction_lines WHERE id = ? AND deleted_at IS NOT NULL').pluck().get(w.a.purchase)).toBe(3)
    // Another ledger's same purchase has its one line still.
    expect(w.lines(w.b.purchase)).toEqual([[-10000, w.shared.food]])
  })

  it('shares a refund linked in full between the parts, to the cent', () => {
    const w = world()
    split(w)
    // $10.01 of $100: 6.2162 → 6.22, 1.8418 → 1.84 and 1.9520 → 1.95.
    const refund = w.tx('A', w.a.account, '2026-08-06', 1001)
    w.link('refund', refund, w.a.purchase, 1001)
    expect(w.lines(refund, w.a.purchase)).toEqual([
      [622, w.shared.food],
      [195, null],
      [184, w.shared.fun],
    ])
    // Linked in full, it has no line of its own.
    expect(w.lines(refund)).toEqual([])
    expect(w.sqlite.prepare('SELECT sum(amount_minor) FROM transaction_lines WHERE id = ?').pluck().get(refund)).toBe(1001)
  })

  it('rounds no share to the other sign, nor more than a cent from exact', () => {
    const w = world()
    w.run('DELETE FROM transaction_links WHERE money_out_id = ?', w.a.purchase)
    // Four parts of $25, and 2 cents back: half a cent each. Two parts take a cent, and none gives one.
    for (let sort = 0; sort < 4; sort++) w.part(w.a.purchase, sort, null, -2500)
    const refund = w.tx('A', w.a.account, '2026-08-06', 2)
    w.link('refund', refund, w.a.purchase, 2)
    expect(w.lines(refund, w.a.purchase).map(([amount]) => amount)).toEqual([1, 1, 0, 0])
    // Six parts of 1 cent of money in, 3 cents of it paying back a bill: three parts give a cent.
    const moneyIn = w.tx('A', w.a.savings, '2026-08-21', 6)
    for (let sort = 0; sort < 6; sort++) w.part(moneyIn, sort, null, 1)
    w.link('payback', moneyIn, w.a.payment, 3)
    expect(w.lines(moneyIn).map(([amount]) => amount)).toEqual([1, 1, 1, 0, 0, 0])
  })

  it('shares a refund linked in part, and a payback on the bill’s date', () => {
    const w = world()
    split(w)
    // $33.33 of a $50 refund: 20.6979 → 20.70, 6.1327 → 6.13, the rest 6.50. Its other $16.67 is its own.
    const refund = w.tx('A', w.a.account, '2026-08-06', 5000, w.shared.fun)
    w.link('refund', refund, w.a.purchase, 3333)
    expect(w.lines(refund, w.a.purchase)).toEqual([
      [2070, w.shared.food],
      [650, null],
      [613, w.shared.fun],
    ])
    expect(w.lines(refund)).toEqual([[1667, w.shared.fun]])
    // $3.33 of a friend's $7: 2.0679 → 2.07, 0.6127 → 0.61, the rest 0.65.
    const payback = w.tx('A', w.a.savings, '2026-08-20', 700)
    w.link('payback', payback, w.a.purchase, 333)
    expect(w.lines(payback, w.a.purchase)).toEqual([
      [207, w.shared.food],
      [65, null],
      [61, w.shared.fun],
    ])
    expect(w.sqlite.prepare('SELECT DISTINCT date, link_kind FROM transaction_lines WHERE id = ? AND owner_id = ?').all(payback, w.a.purchase)).toEqual([
      { date: '2026-08-01', link_kind: 'payback' },
    ])
    // Every cent of both is somewhere: what's linked in the purchase's categories, the rest in their own.
    expect(w.sqlite.prepare('SELECT sum(amount_minor) FROM transaction_lines WHERE id IN (?, ?)').pluck().get(refund, payback)).toBe(5700)
    // By category, the purchase with what came back: Food 62.10 - 20.70 - 2.07, Fun 18.40 - 6.13 - 0.61 (the refund's own 16.67 aside).
    const net = (category: number) => w.sqlite.prepare('SELECT sum(amount_minor) FROM transaction_lines WHERE owner_id = ? AND category_id = ?').pluck().get(w.a.purchase, category)
    expect(net(w.shared.food)).toBe(-3933)
    expect(net(w.shared.fun)).toBe(-1166)
    // A deleted purchase's links give no lines.
    w.run("UPDATE transactions SET deleted_at = '2026-09-01' WHERE id = ?", w.a.purchase)
    expect(w.lines(refund, w.a.purchase)).toEqual([])
    expect(w.lines(refund)).toEqual([[5000, w.shared.fun]])
  })

  it('takes what money in with parts has linked off each part', () => {
    const w = world()
    // $100.01 in three parts, $10 of it paying back a bill: 4.9995 → 5.00, 2.9997 → 3.00, the rest 2.00.
    const moneyIn = w.tx('A', w.a.savings, '2026-08-21', 10001)
    w.part(moneyIn, 0, w.shared.food, 5000)
    w.part(moneyIn, 1, w.shared.fun, 3000)
    w.part(moneyIn, 2, null, 2001)
    w.link('payback', moneyIn, w.a.payment, 1000)
    expect(w.lines(moneyIn)).toEqual([
      [4500, w.shared.food],
      [2700, w.shared.fun],
      [1801, null],
    ])
    // The link is in its bill's category, whole: the bill has no parts.
    expect(w.lines(moneyIn, w.a.payment)).toEqual([[1000, w.shared.food]])
    // Linked in full, it has no lines of its own.
    w.run('UPDATE transaction_links SET amount_minor = 5000 WHERE money_in_id = ?', moneyIn)
    w.link('payback', moneyIn, w.a.purchase, 5001)
    expect(w.lines(moneyIn)).toEqual([])
  })
})

describe('parts_follow_amount', () => {
  const amount = (w: ReturnType<typeof world>, minor: number) => w.run('UPDATE transactions SET amount_minor = ? WHERE id = ?', minor, w.a.purchase)

  it('gives the difference to the largest part, up and down', () => {
    const w = world()
    split(w)
    // A tip: $100 becomes $112.
    amount(w, -11200)
    expect(w.parts(w.a.purchase)).toEqual([
      [w.shared.food, -7410],
      [w.shared.fun, -1840],
      [null, -1950],
    ])
    // Down to $40: the largest part is left with $2.10, and the largest is now the one with no category.
    amount(w, -4000)
    expect(w.parts(w.a.purchase)).toEqual([
      [w.shared.food, -210],
      [w.shared.fun, -1840],
      [null, -1950],
    ])
    expect(w.categoryOf(w.a.purchase)).toBeNull()
    expect(w.sqlite.prepare('SELECT sum(amount_minor) FROM transaction_lines WHERE id = ?').pluck().get(w.a.purchase)).toBe(-4000)
    // The same amount again changes nothing, and nor does another column.
    amount(w, -4000)
    w.run("UPDATE transactions SET notes = 'n' WHERE id = ?", w.a.purchase)
    expect(w.parts(w.a.purchase)).toHaveLength(3)
  })

  it('undoes the split when the largest part can’t take it, keeping the transaction’s category', () => {
    for (const to of [-3790, -3000, 0, 500]) {
      const w = world()
      split(w)
      // -37.90 would leave Food at zero, less than that or money in at the other sign.
      amount(w, to)
      expect(w.parts(w.a.purchase), String(to)).toEqual([])
      expect(w.categoryOf(w.a.purchase)).toBe(w.shared.food)
      expect(w.lines(w.a.purchase)).toEqual(to ? [[to, w.shared.food]] : [[0, w.shared.food]])
    }
    // One cent more and it holds.
    const w = world()
    split(w)
    amount(w, -3791)
    expect(w.parts(w.a.purchase)[0]).toEqual([w.shared.food, -1])
    // A tie goes to the first part: Fun and the one with no category at $19.50 each, and $1 more spent.
    const tie = world()
    tie.run('DELETE FROM transaction_links WHERE money_out_id = ?', tie.a.purchase)
    tie.part(tie.a.purchase, 0, tie.shared.food, -6100)
    tie.part(tie.a.purchase, 1, tie.shared.fun, -1950)
    tie.part(tie.a.purchase, 2, null, -1950)
    amount(tie, -3901)
    expect(tie.parts(tie.a.purchase)[0]).toEqual([tie.shared.food, -1])
    expect(tie.categoryOf(tie.a.purchase)).toBe(tie.shared.fun)
    amount(tie, -4001)
    expect(tie.parts(tie.a.purchase)).toEqual([
      [tie.shared.food, -1],
      [tie.shared.fun, -2050],
      [null, -1950],
    ])
  })

  it("leaves other transactions' parts alone", () => {
    const w = world()
    split(w)
    w.part(w.a.payment, 0, w.shared.food, -3000)
    w.part(w.a.payment, 1, w.shared.fun, -2000)
    amount(w, -11200)
    expect(w.parts(w.a.payment)).toEqual([
      [w.shared.food, -3000],
      [w.shared.fun, -2000],
    ])
  })
})

describe('guards', () => {
  it("keep a part's category to one its transaction's ledger uses", () => {
    const w = world()
    expect(() => w.part(w.a.purchase, 0, w.cCategory, -1)).toThrow(CROSS)
    w.part(w.a.purchase, 0, w.shared.food, -1)
    expect(() => w.run('UPDATE transaction_parts SET category_id = ? WHERE transaction_id = ?', w.cCategory, w.a.purchase)).toThrow(CROSS)
    w.run('UPDATE transaction_parts SET category_id = NULL WHERE transaction_id = ?', w.a.purchase)
    // C has its own list: a shared category isn't one of its.
    const cAccount = bareWriter(w.sqlite, 'C')("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES (@ledger, 'Cash', 'cash', @i)", {
      i: bareWriter(w.sqlite, 'C')("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Bank')"),
    })
    const own = w.tx('C', cAccount, '2026-09-01', -100)
    expect(() => w.part(own, 0, w.shared.food, -1)).toThrow(CROSS)
    w.part(own, 0, w.cCategory, -1)
  })

  it('check from the other side when rows are inserted out of order', () => {
    const w = world()
    const ID = 9999
    const outOfOrder = (...steps: Array<[string, ...unknown[]]>) =>
      w.sqlite.transaction(() => {
        w.sqlite.pragma('defer_foreign_keys = ON')
        for (const [sql, ...params] of steps) w.run(sql, ...params)
      })()
    const tx = (ledger: string, account: number): [string, ...unknown[]] => [
      "INSERT INTO transactions (id, ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES (?, ?, ?, '2026-09-01', -1, 'x', 'x')",
      ID,
      ledger,
      account,
    ]
    // A part in C's own category, then its transaction in A.
    const part: [string, ...unknown[]] = ['INSERT INTO transaction_parts (transaction_id, sort, category_id, amount_minor) VALUES (?, 0, ?, -1)', ID, w.cCategory]
    expect(() => outOfOrder(part, tx('A', w.a.account))).toThrow(CROSS)
    // A part of A's purchase, then its category in C's list.
    expect(() =>
      outOfOrder(['INSERT INTO transaction_parts (transaction_id, sort, category_id, amount_minor) VALUES (?, 0, ?, -1)', w.a.purchase, ID], [
        "INSERT INTO categories (id, ledger_id, name) VALUES (?, 'C', 'x')",
        ID,
      ]),
    ).toThrow(CROSS)
    // In the same ledger's list, out of order is fine.
    outOfOrder(['INSERT INTO transaction_parts (transaction_id, sort, category_id, amount_minor) VALUES (?, 0, ?, -1)', ID, w.shared.food], tx('A', w.a.account))
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('keep a ledger on the shared list while its parts use it, and a transaction with parts in its ledger', () => {
    const w = world()
    w.run('DELETE FROM payee_rules')
    w.run('DELETE FROM payee_category_stats')
    w.run('UPDATE recurring_items SET category_id = NULL')
    w.run('UPDATE transactions SET category_id = NULL')
    w.part(w.a.purchase, 0, w.shared.food, -6000)
    w.part(w.a.purchase, 1, null, -4000)
    expect(() => w.run("UPDATE ledgers SET category_list = 'own' WHERE id = 'A'")).toThrow('the ledger still uses the shared category list')
    w.run("UPDATE ledgers SET category_list = 'own' WHERE id = 'B'")
    w.run('UPDATE transaction_parts SET category_id = NULL')
    w.run("UPDATE ledgers SET category_list = 'own' WHERE id = 'A'")

    // B's card is shared with A, and a transaction of B's with nothing else attached could move: not with parts.
    const institution = bareWriter(w.sqlite, 'A')("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'B bank')")
    w.run("INSERT INTO account_ledgers (ledger_id, account_id, institution_id) VALUES ('A', ?, ?)", w.b.account, institution)
    const moving = w.tx('B', w.b.account, '2026-09-01', -100)
    w.part(moving, 0, null, -60)
    w.part(moving, 1, null, -40)
    expect(() => w.run("UPDATE transactions SET ledger_id = 'A' WHERE id = ?", moving)).toThrow('with nothing still attached')
    w.run('DELETE FROM transaction_parts WHERE transaction_id = ?', moving)
    w.run("UPDATE transactions SET ledger_id = 'A' WHERE id = ?", moving)
  })

  it('take the parts with a transaction deleted for good, and a deleted category off its parts', () => {
    const w = world()
    split(w)
    w.run('DELETE FROM category_labels')
    w.run('DELETE FROM ledger_category_off')
    w.run('DELETE FROM categories WHERE id = ?', w.shared.fun)
    expect(w.parts(w.a.purchase)).toEqual([
      [w.shared.food, -6210],
      [null, -1840],
      [null, -1950],
    ])
    w.run('DELETE FROM transaction_links')
    w.run('DELETE FROM bank_payloads')
    w.run('DELETE FROM transactions WHERE id = ?', w.a.purchase)
    expect(w.sqlite.prepare('SELECT count(*) FROM transaction_parts').pluck().get()).toBe(0)
  })
})
