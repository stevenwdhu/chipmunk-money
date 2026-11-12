import { describe, expect, it } from 'vitest'
import { addLedger, addSharedList, bareDatabase, bareWriter, fillLedger } from '../test/world'

/** Two ledgers on the shared list (A and B) and one with its own (C), on a database without write guards. */
function world() {
  const sqlite = bareDatabase()
  addLedger(sqlite, 'A')
  addLedger(sqlite, 'B')
  addLedger(sqlite, 'C', 'own')
  const shared = addSharedList(sqlite)
  const a = fillLedger(bareWriter(sqlite, 'A'), { category: shared.food, offCategory: shared.fun })
  const b = fillLedger(bareWriter(sqlite, 'B'), { category: shared.food, offCategory: shared.food })
  const writeC = bareWriter(sqlite, 'C')
  const cGroup = writeC("INSERT INTO category_groups (ledger_id, name) VALUES (@ledger, 'Mine')")
  const cCategory = writeC("INSERT INTO categories (ledger_id, group_id, name, archived_at) VALUES (@ledger, @g, 'Own food', NULL)", { g: cGroup })
  const cOld = writeC("INSERT INTO categories (ledger_id, group_id, name, archived_at) VALUES (@ledger, @g, 'Old', '2026-01-01')", { g: cGroup })
  const cLabel = writeC("INSERT INTO labels (ledger_id, name) VALUES (@ledger, 'Needs')")
  writeC('INSERT INTO category_labels (category_id, label_id) VALUES (@c, @l)', { c: cCategory, l: cLabel })
  const cInstitution = writeC("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Bank')")
  const cAccount = writeC("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES (@ledger, 'Cash', 'cash', @i)", { i: cInstitution })
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  const all = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params)
  return { sqlite, shared, a, b, c: { group: cGroup, category: cCategory, old: cOld, label: cLabel, account: cAccount }, run, all }
}

describe('views', () => {
  it("give each ledger only its own accounts", () => {
    const w = world()
    const names = (ledger: string) => w.all('SELECT id FROM ledger_accounts WHERE ledger_id = ? ORDER BY id', ledger).map((r) => (r as { id: number }).id)
    expect(names('A')).toEqual([w.a.account, w.a.savings])
    expect(names('B')).toEqual([w.b.account, w.b.savings])
    expect(names('C')).toEqual([w.c.account])
  })

  it('give a shared-list ledger the shared categories with what it turned off, and an own-list ledger its own', () => {
    const w = world()
    const cats = (ledger: string) =>
      w.all('SELECT id, name, archived_at AS archivedAt, shared FROM ledger_categories WHERE ledger_id = ? ORDER BY id', ledger)
    expect(cats('A')).toEqual([
      { id: w.shared.food, name: 'Food', archivedAt: null, shared: 1 },
      { id: w.shared.fun, name: 'Fun', archivedAt: '2026-09-01', shared: 1 },
    ])
    // B turned off Food, not Fun: the off state is per ledger.
    expect(cats('B')).toEqual([
      { id: w.shared.food, name: 'Food', archivedAt: '2026-09-01', shared: 1 },
      { id: w.shared.fun, name: 'Fun', archivedAt: null, shared: 1 },
    ])
    expect(cats('C')).toEqual([
      { id: w.c.category, name: 'Own food', archivedAt: null, shared: 0 },
      { id: w.c.old, name: 'Old', archivedAt: '2026-01-01', shared: 0 },
    ])
    const groups = (ledger: string) => w.all('SELECT id FROM ledger_category_groups WHERE ledger_id = ?', ledger).map((r) => (r as { id: number }).id)
    expect(groups('A')).toEqual([w.shared.group])
    expect(groups('C')).toEqual([w.c.group])
    const labels = (ledger: string) => w.all('SELECT id, name FROM ledger_labels WHERE ledger_id = ?', ledger)
    expect(labels('B')).toEqual([{ id: w.shared.label, name: 'Needs' }])
    // The same name in two lists.
    expect(labels('C')).toEqual([{ id: w.c.label, name: 'Needs' }])

    // Switching C to the shared list shows the shared list there.
    w.run("UPDATE ledgers SET category_list = 'shared' WHERE id = 'C'")
    expect((cats('C') as Array<{ shared: number }>).filter((c) => c.shared).length).toBe(2)
  })

  it('give each ledger its own transaction lines, links included', () => {
    const w = world()
    const lines = (ledger: string) =>
      w.all('SELECT id, amount_minor AS amount, category_id AS category, owner_id AS owner, link_kind AS kind FROM transaction_lines WHERE ledger_id = ? ORDER BY id, owner_id', ledger)
    const expected = (x: typeof w.a) => [
      { id: x.purchase, amount: -10000, category: w.shared.food, owner: x.purchase, kind: null },
      // The refund counts in its purchase's category.
      { id: x.refund, amount: 4000, category: w.shared.food, owner: x.purchase, kind: 'refund' },
      { id: x.transferOut, amount: -2500, category: null, owner: x.transferOut, kind: null },
      { id: x.transferIn, amount: 2500, category: null, owner: x.transferIn, kind: null },
      { id: x.payment, amount: -5000, category: w.shared.food, owner: x.payment, kind: null },
    ]
    expect(lines('A')).toEqual(expected(w.a))
    expect(lines('B')).toEqual(expected(w.b))
    expect(lines('C')).toEqual([])
  })
})

describe('guard triggers', () => {
  const CROSS = 'cross-ledger reference'

  it('keep a transaction to its ledger’s account, category, recurring item, import batch and transfer pair', () => {
    const w = world()
    const insert = (values: Record<string, unknown>) =>
      w.sqlite
        .prepare(
          `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, recurring_item_id, import_batch_id, transfer_pair_id)
           VALUES (@ledger, @account, '2026-09-01', -100, 'x', 'x', @category, @item, @batch, @pair)`,
        )
        .run({ ledger: 'A', account: w.a.account, category: null, item: null, batch: null, pair: null, ...values })
    expect(() => insert({ account: w.b.account })).toThrow(CROSS)
    expect(() => insert({ category: w.c.category })).toThrow(CROSS)
    expect(() => insert({ item: w.b.item })).toThrow(CROSS)
    expect(() => insert({ batch: w.b.batch })).toThrow(CROSS)
    expect(() => insert({ pair: w.b.purchase })).toThrow(CROSS)
    insert({ account: w.a.account, category: w.shared.fun, item: w.a.item, batch: w.a.batch, pair: w.a.purchase })
    // A ledger with its own list can't use the shared one.
    expect(() =>
      w.run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id) VALUES ('C', ?, '2026-09-01', 1, 'x', 'x', ?)", w.c.account, w.shared.food),
    ).toThrow(CROSS)
    w.run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id) VALUES ('C', ?, '2026-09-01', 1, 'x', 'x', ?)", w.c.account, w.c.category)

    const update = (set: string, value: unknown) => w.run(`UPDATE transactions SET ${set} = ? WHERE id = ?`, value, w.a.purchase)
    expect(() => update('account_id', w.b.account)).toThrow(CROSS)
    expect(() => update('category_id', w.c.category)).toThrow(CROSS)
    expect(() => update('recurring_item_id', w.b.item)).toThrow(CROSS)
    expect(() => update('import_batch_id', w.b.batch)).toThrow(CROSS)
    expect(() => update('transfer_pair_id', w.b.purchase)).toThrow(CROSS)
    update('account_id', w.a.savings)
    update('category_id', w.shared.fun)
    update('recurring_item_id', w.a.item)
    update('import_batch_id', w.a.batch)
    update('transfer_pair_id', w.a.refund)
  })

  it('keep accounts, import batches and recurring items to their ledger', () => {
    const w = world()
    expect(() => w.run("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES ('A', 'x', 'cash', ?)", w.b.institution)).toThrow(CROSS)
    w.run("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES ('A', 'x', 'cash', ?)", w.a.institution)
    expect(() => w.run('UPDATE accounts SET institution_id = ? WHERE id = ?', w.b.institution, w.a.account)).toThrow(CROSS)

    expect(() => w.run("INSERT INTO import_batches (ledger_id, account_id) VALUES ('A', ?)", w.b.account)).toThrow(CROSS)
    w.run("INSERT INTO import_batches (ledger_id, account_id) VALUES ('A', ?)", w.a.account)
    expect(() => w.run('UPDATE import_batches SET account_id = ? WHERE id = ?', w.b.account, w.a.batch)).toThrow(CROSS)

    expect(() => w.run('UPDATE recurring_items SET account_id = ? WHERE id = ?', w.b.account, w.a.item)).toThrow(CROSS)
    expect(() => w.run('UPDATE recurring_items SET category_id = ? WHERE id = ?', w.c.category, w.a.item)).toThrow(CROSS)
    w.run('UPDATE recurring_items SET account_id = ?, category_id = ? WHERE id = ?', w.a.savings, w.shared.fun, w.a.item)
    expect(() =>
      w.run(
        `INSERT INTO recurring_items (ledger_id, name, payee_key, account_id, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
         VALUES ('A', 'x', 'x', ?, 1, 'monthly', '2026-01-01', '2026-01-01', 'active', 'manual')`,
        w.b.account,
      ),
    ).toThrow(CROSS)
  })

  it("keep payee rules and stats to categories their ledger uses", () => {
    const w = world()
    expect(() => w.run("INSERT INTO payee_rules (ledger_id, payee_key, mode, category_id) VALUES ('A', 'x', 'always', ?)", w.c.category)).toThrow(CROSS)
    w.run("INSERT INTO payee_rules (ledger_id, payee_key, mode, category_id) VALUES ('A', 'x', 'always', ?)", w.shared.fun)
    expect(() => w.run("UPDATE payee_rules SET category_id = ? WHERE ledger_id = 'A' AND payee_key = 'x'", w.c.category)).toThrow(CROSS)
    expect(() => w.run("INSERT INTO payee_category_stats (ledger_id, payee_key, direction, category_id) VALUES ('C', 'x', 'out', ?)", w.shared.food)).toThrow(CROSS)
    w.run("INSERT INTO payee_category_stats (ledger_id, payee_key, direction, category_id) VALUES ('C', 'x', 'out', ?)", w.c.category)
    expect(() => w.run("UPDATE payee_category_stats SET category_id = ? WHERE ledger_id = 'C'", w.shared.food)).toThrow(CROSS)
  })

  it('keep both sides of links, rejections, tags and recurring payments in one ledger', () => {
    const w = world()
    const pairs: Array<[string, string, [number, number], [number, number]]> = [
      ['transaction_links', "INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('payback', ?, ?, 1)", [w.a.transferIn, w.b.purchase], [w.a.transferIn, w.a.payment]],
      ['transfer_rejections', 'INSERT INTO transfer_rejections (in_id, out_id) VALUES (?, ?)', [w.a.transferIn, w.b.payment], [w.a.transferIn, w.a.payment]],
      ['transaction_tags', 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', [w.a.payment, w.b.tag], [w.a.payment, w.a.tag]],
      ['recurring_not_payments', 'INSERT INTO recurring_not_payments (item_id, transaction_id) VALUES (?, ?)', [w.a.item, w.b.payment], [w.a.item, w.a.refund]],
      ['recurring_payment_dues', "INSERT INTO recurring_payment_dues (item_id, transaction_id, due_date) VALUES (?, ?, '2026-09-01')", [w.a.item, w.b.purchase], [w.a.item, w.a.purchase]],
      ['bank_payloads', "INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (?, 'plaid', 'r2', ?, 'added', '{}')", [w.a.account, w.b.purchase], [w.a.account, w.a.refund]],
    ]
    for (const [table, sql, cross, same] of pairs) {
      expect(() => w.run(sql, ...cross), table).toThrow(CROSS)
      w.run(sql, ...same)
    }
    expect(() => w.run('UPDATE transaction_links SET money_out_id = ? WHERE money_in_id = ?', w.b.purchase, w.a.refund)).toThrow(CROSS)
    expect(() => w.run('UPDATE transaction_links SET money_in_id = ? WHERE money_in_id = ?', w.b.refund, w.a.refund)).toThrow(CROSS)
    expect(() => w.run('UPDATE transfer_rejections SET out_id = ? WHERE in_id = ?', w.b.purchase, w.a.refund)).toThrow(CROSS)
    expect(() => w.run('UPDATE transaction_tags SET tag_id = ? WHERE transaction_id = ?', w.b.tag, w.a.purchase)).toThrow(CROSS)
    expect(() => w.run('UPDATE recurring_not_payments SET transaction_id = ? WHERE item_id = ?', w.b.purchase, w.a.item)).toThrow(CROSS)
    expect(() => w.run('UPDATE recurring_payment_dues SET transaction_id = ? WHERE item_id = ?', w.b.payment, w.a.item)).toThrow(CROSS)
    expect(() => w.run('UPDATE bank_payloads SET transaction_id = ? WHERE account_id = ?', w.b.purchase, w.a.account)).toThrow(CROSS)
  })

  it('keep categories in their own list', () => {
    const w = world()
    // A shared category in an own list's group, and the other way round.
    expect(() => w.run("INSERT INTO categories (group_id, name) VALUES (?, 'x')", w.c.group)).toThrow(CROSS)
    expect(() => w.run("INSERT INTO categories (ledger_id, group_id, name) VALUES ('C', ?, 'x')", w.shared.group)).toThrow(CROSS)
    w.run("INSERT INTO categories (ledger_id, group_id, name) VALUES ('C', ?, 'x')", w.c.group)
    expect(() => w.run('UPDATE categories SET group_id = ? WHERE id = ?', w.c.group, w.shared.fun)).toThrow(CROSS)
    expect(() => w.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)', w.shared.fun, w.c.label)).toThrow(CROSS)
    w.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)', w.shared.fun, w.shared.label)
    // Only shared categories are turned off per ledger.
    expect(() => w.run("INSERT INTO ledger_category_off (ledger_id, category_id, archived_at) VALUES ('C', ?, 'now')", w.c.category)).toThrow(CROSS)
    w.run("INSERT INTO ledger_category_off (ledger_id, category_id, archived_at) VALUES ('A', ?, 'now')", w.shared.food)
    // And a shared category is never archived on its row.
    expect(() => w.run("UPDATE categories SET archived_at = 'now' WHERE id = ?", w.shared.food)).toThrow(/CHECK/)
  })

  it('check from the other side when rows are inserted out of order', () => {
    const w = world()
    const ID = 9999
    /** Runs the rows in one transaction with foreign keys deferred, as a converter or importer may. */
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
    const children: Array<[string, [string, ...unknown[]]]> = [
      ['transaction_links in', ["INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('refund', ?, ?, 1)", w.a.refund, ID]],
      ['transaction_links out', ["INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('refund', ?, ?, 1)", ID, w.a.purchase]],
      ['transfer_rejections', ['INSERT INTO transfer_rejections (in_id, out_id) VALUES (?, ?)', w.a.refund, ID]],
      ['transaction_tags', ['INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', ID, w.a.tag]],
      ['recurring_not_payments', ['INSERT INTO recurring_not_payments (item_id, transaction_id) VALUES (?, ?)', w.a.item, ID]],
      ['recurring_payment_dues', ["INSERT INTO recurring_payment_dues (item_id, transaction_id, due_date) VALUES (?, ?, '2026-09-01')", w.a.item, ID]],
      ['bank_payloads', ["INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (?, 'plaid', 'r9', ?, 'added', '{}')", w.a.account, ID]],
    ]
    for (const [name, child] of children) {
      // A child row of A's, then the transaction it names, in B.
      expect(() => outOfOrder(child, tx('B', w.b.account)), name).toThrow(CROSS)
    }
    // In order, or out of order in the same ledger, is fine.
    outOfOrder(...children.map(([, child]) => child), tx('A', w.a.account))
    expect(w.sqlite.pragma('foreign_key_check')).toEqual([])

    // Root tables: a transaction of A's naming an account, recurring item, import batch, category not yet there.
    const roots: Array<[string, [string, ...unknown[]], [string, ...unknown[]]]> = [
      [
        'accounts',
        ["INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES ('A', ?, '2026-09-01', -1, 'x', 'x')", ID],
        ["INSERT INTO accounts (id, ledger_id, name, type, institution_id) VALUES (?, 'B', 'x', 'cash', ?)", ID, w.b.institution],
      ],
      ['institutions', ["INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES ('A', 'x', 'cash', ?)", ID], ["INSERT INTO institutions (id, ledger_id, name) VALUES (?, 'B', 'x')", ID]],
      [
        'import_batches',
        ["INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, import_batch_id) VALUES ('A', ?, '2026-09-01', -1, 'x', 'x', ?)", w.a.account, ID],
        ["INSERT INTO import_batches (id, ledger_id, account_id) VALUES (?, 'B', ?)", ID, w.b.account],
      ],
      [
        'recurring_items',
        ['INSERT INTO recurring_payment_dues (item_id, transaction_id, due_date) VALUES (?, ?, ?)', ID, w.a.purchase, '2026-09-09'],
        [
          `INSERT INTO recurring_items (id, ledger_id, name, payee_key, expected_amount_minor, cadence, anchor_date, next_due_date, status, origin)
           VALUES (?, 'B', 'x', 'x', 1, 'monthly', '2026-01-01', '2026-01-01', 'active', 'manual')`,
          ID,
        ],
      ],
      ['tags', ['INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', w.a.purchase, ID], ["INSERT INTO tags (id, ledger_id, name) VALUES (?, 'B', 'x')", ID]],
      // C's own category for A's transaction, and a shared one for C (which has its own list).
      [
        'categories',
        ['UPDATE transactions SET category_id = ? WHERE id = ?', ID, w.a.purchase],
        ["INSERT INTO categories (id, ledger_id, name) VALUES (?, 'C', 'x')", ID],
      ],
      [
        'categories (shared)',
        ["INSERT INTO payee_rules (ledger_id, payee_key, mode, category_id) VALUES ('C', 'y', 'always', ?)", ID],
        ["INSERT INTO categories (id, name) VALUES (?, 'x')", ID],
      ],
      ['labels', ['INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)', w.c.category, ID], ["INSERT INTO labels (id, name) VALUES (?, 'Wants')", ID]],
      ['category_groups', ["INSERT INTO categories (ledger_id, group_id, name) VALUES ('C', ?, 'y')", ID], ["INSERT INTO category_groups (id, name) VALUES (?, 'x')", ID]],
    ]
    for (const [name, child, parent] of roots) expect(() => outOfOrder(child, parent), name).toThrow(CROSS)
  })

  it('keep a ledger on the shared list while its rows use it', () => {
    const w = world()
    // A's transactions, recurring item and payee rules are on shared Food.
    expect(() => w.run("UPDATE ledgers SET category_list = 'own' WHERE id = 'A'")).toThrow('the ledger still uses the shared category list')
    // Deleting A's card still works: its SET NULL on the recurring item re-checks the shared category.
    w.run('DELETE FROM accounts WHERE id = ?', w.a.account)
    // Joining the shared list: 'shared' first, then remap, then delete the own rows.
    w.run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id) VALUES ('C', ?, '2026-09-01', -1, 'x', 'x', ?)", w.c.account, w.c.category)
    expect(() => w.run("UPDATE transactions SET category_id = ? WHERE ledger_id = 'C'", w.shared.food)).toThrow(CROSS)
    w.run("UPDATE ledgers SET category_list = 'shared' WHERE id = 'C'")
    w.run("UPDATE transactions SET category_id = ? WHERE ledger_id = 'C'", w.shared.food)
    // Leaving it: remap to own categories first, then 'own'.
    expect(() => w.run("UPDATE ledgers SET category_list = 'own' WHERE id = 'C'")).toThrow('shared category list')
    w.run("UPDATE transactions SET category_id = ? WHERE ledger_id = 'C'", w.c.category)
    w.run("UPDATE ledgers SET category_list = 'own' WHERE id = 'C'")
  })

  it('keep rows in their ledger', () => {
    const w = world()
    expect(() => w.run("UPDATE tags SET ledger_id = 'B' WHERE id = ?", w.a.tag)).toThrow('rows stay in their ledger')
    // A transaction moves only to a ledger that has its account (move-rows.test.ts has the rest).
    expect(() => w.run("UPDATE transactions SET ledger_id = 'B' WHERE id = ?", w.a.purchase)).toThrow('a transaction moves only to a ledger that has its account')
  })

  it("don't let a stray delete of a ledger take its data", () => {
    const w = world()
    expect(() => w.run("DELETE FROM ledgers WHERE id = 'A'")).toThrow(/FOREIGN KEY/)
  })
})

describe('content triggers', () => {
  it('keep what each money in has linked, its category and a refund’s name', () => {
    const w = world()
    const tx = (id: number) =>
      w.sqlite.prepare('SELECT linked_minor AS linked, category_id AS category, category_source AS source, name FROM transactions WHERE id = ?').get(id) as {
        linked: number
        category: number | null
        source: string | null
        name: string | null
      }
    // links_sum_insert
    expect(tx(w.a.refund).linked).toBe(4000)
    // refunds_take_name: a refund of one purchase has its name.
    w.run("UPDATE transactions SET name = 'Boots' WHERE id = ?", w.a.purchase)
    // refunds_follow_name
    expect(tx(w.a.refund).name).toBe('Boots')
    // links_follow_bill: money in linked in full to one bill follows its category.
    w.run("UPDATE transactions SET category_source = 'linked' WHERE id = ?", w.a.refund)
    w.run('UPDATE transactions SET category_id = ? WHERE id = ?', w.shared.fun, w.a.purchase)
    expect(tx(w.a.refund).category).toBe(w.shared.fun)
    // links_sum_update
    w.run('UPDATE transaction_links SET amount_minor = 3000 WHERE money_in_id = ?', w.a.refund)
    expect(tx(w.a.refund).linked).toBe(3000)
    // links_sum_bill: a deleted bill's links don't count.
    w.run("UPDATE transactions SET deleted_at = 'now' WHERE id = ?", w.a.purchase)
    expect(tx(w.a.refund).linked).toBe(0)
    w.run('UPDATE transactions SET deleted_at = NULL WHERE id = ?', w.a.purchase)
    expect(tx(w.a.refund).linked).toBe(3000)
    // links_sum_delete, refunds_keep_name (one link left: the name of that bill)
    w.run("UPDATE transactions SET name = 'Gym day' WHERE id = ?", w.a.payment)
    w.run("INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES ('refund', ?, ?, 500)", w.a.refund, w.a.payment)
    expect(tx(w.a.refund).linked).toBe(3500)
    w.run('DELETE FROM transaction_links WHERE money_in_id = ? AND money_out_id = ?', w.a.refund, w.a.purchase)
    expect(tx(w.a.refund)).toMatchObject({ linked: 500, name: 'Gym day' })
    // The other ledger's rows weren't touched.
    expect(tx(w.b.refund)).toMatchObject({ linked: 4000, name: null })
  })
})

describe('AI request records', () => {
  const insert = (w: ReturnType<typeof world>, ledger: string, ok: number, kind: string | null, key: string | null) =>
    w.run("INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok, kind, subject_key) VALUES (?, 'primary', 'm', 10, ?, ?, ?)", ledger, ok, kind, key)

  it('refuse a second open record for the same thing in a ledger', () => {
    const w = world()
    insert(w, 'A', 0, 'categorize', 'out:metro')
    expect(() => insert(w, 'A', 0, 'categorize', 'out:metro')).toThrow(/UNIQUE constraint failed/)
    // Another thing, another kind and another ledger each have their own.
    insert(w, 'A', 0, 'categorize', 'in:metro')
    insert(w, 'A', 0, 'names', 'out:metro')
    insert(w, 'B', 0, 'categorize', 'out:metro')
    // One that answered isn't open: any number, and one more open beside them is refused still.
    insert(w, 'A', 1, 'categorize', 'out:metro')
    insert(w, 'A', 1, 'categorize', 'out:metro')
    expect(() => insert(w, 'A', 0, 'categorize', 'out:metro')).toThrow(/UNIQUE constraint failed/)
    // A record that answered can't be turned back into a second open one.
    expect(() => w.run("UPDATE ai_calls SET ok = 0 WHERE ledger_id = 'A' AND ok = 1 AND subject_key = 'out:metro'")).toThrow(/UNIQUE constraint failed/)
    // The open one corrected leaves room for the next failure.
    w.run("UPDATE ai_calls SET ok = 1 WHERE ledger_id = 'A' AND ok = 0 AND kind = 'categorize' AND subject_key = 'out:metro'")
    insert(w, 'A', 0, 'categorize', 'out:metro')
  })

  it('let connection tests and rows from before fail any number of times', () => {
    const w = world()
    const failed = () => (w.all("SELECT count(*) AS n FROM ai_calls WHERE ledger_id = 'A' AND ok = 0")[0] as { n: number }).n
    insert(w, 'A', 0, 'test', null)
    insert(w, 'A', 0, 'test', null)
    insert(w, 'A', 0, null, null)
    insert(w, 'A', 0, null, null)
    expect(failed()).toBe(4)
    // A row written as before the columns came: asked once, nothing else known.
    w.run("INSERT INTO ai_calls (ledger_id, slot, model, latency_ms, ok) VALUES ('A', 'primary', 'm', 10, 0)")
    expect(w.all("SELECT kind, subject, subject_key, outcome, tries, first_failed_at, primary_error, tried_at, asked FROM ai_calls WHERE ledger_id = 'A' ORDER BY id DESC LIMIT 1")).toEqual([
      { kind: null, subject: null, subject_key: null, outcome: null, tries: 1, first_failed_at: null, primary_error: null, tried_at: null, asked: null },
    ])
  })
})
