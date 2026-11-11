import { describe, expect, it } from 'vitest'
import { checkPinned, LedgerScopeError, referencedTables } from './pins'

const ok = (sql: string) => expect(() => checkPinned(sql), sql).not.toThrow()
const refused = (sql: string, message?: RegExp) => {
  expect(() => checkPinned(sql), sql).toThrow(LedgerScopeError)
  if (message) expect(() => checkPinned(sql), sql).toThrow(message)
}

describe('checkPinned', () => {
  it('accepts statements pinned to the ledger', () => {
    ok('SELECT * FROM transactions WHERE ledger_id = @ledger')
    ok('SELECT * FROM transactions t WHERE t.id = ? AND t.ledger_id = @ledger')
    ok('SELECT * FROM "transactions" AS t WHERE @ledger = t."ledger_id"')
    ok('SELECT count(*) FROM ledger_accounts WHERE ledger_id = :ledger')
    ok(`SELECT t.id, c.name FROM transactions t
        JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
        WHERE t.ledger_id = @ledger AND (t.deleted_at IS NULL OR t.id = ?)`)
    // A LEFT JOIN's ON pins the table it joins.
    ok(`SELECT * FROM transactions t LEFT JOIN tags g ON g.ledger_id = t.ledger_id AND g.name = t.payee WHERE t.ledger_id = @ledger`)
    // Correlated subqueries see the outer aliases.
    ok(`SELECT * FROM transactions t WHERE t.ledger_id = @ledger AND EXISTS (
          SELECT 1 FROM transaction_tags x JOIN tags g ON g.id = x.tag_id WHERE x.transaction_id = t.id AND g.ledger_id = t.ledger_id)`)
    // Each UNION branch and CTE pins its own.
    ok(`WITH recent AS (SELECT id FROM transactions WHERE ledger_id = @ledger AND date > ?)
        SELECT id FROM recent UNION ALL SELECT id FROM recurring_items r WHERE r.ledger_id = @ledger`)
    // Child tables are pinned through a parent: a join to it, or an IN over it.
    ok('SELECT l.* FROM transaction_links l JOIN transactions t ON t.id = l.money_in_id WHERE t.ledger_id = @ledger')
    ok('SELECT * FROM transaction_links WHERE money_in_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?)')
    ok('DELETE FROM transaction_tags WHERE transaction_id IN (SELECT t.id FROM transactions t WHERE t.ledger_id = @ledger) AND tag_id = ?')
    ok('SELECT s.balance_minor FROM ledger_accounts a JOIN balance_snapshots s ON s.account_id = a.id WHERE a.ledger_id = @ledger')
    ok(`SELECT t.id, (SELECT count(*) FROM transaction_tags x WHERE x.transaction_id = t.id) AS n FROM transactions t WHERE t.ledger_id = @ledger`)
    // Inserting one needs no pin: the write guards hold it to its parents.
    ok('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)')
    ok('INSERT OR REPLACE INTO recurring_payment_dues (item_id, transaction_id, due_date) VALUES (?, ?, ?)')
    // A table-valued function, a subquery and a comma after a join are read as FROM items.
    ok("SELECT g.name FROM json_each(?) j, tags g WHERE g.ledger_id = @ledger AND g.id = j.value")
    ok('SELECT g.name FROM tags g JOIN transactions t ON t.ledger_id = g.ledger_id, ledger_accounts a WHERE g.ledger_id = @ledger AND a.ledger_id = g.ledger_id')
    // A RIGHT JOIN's ON pins the tables before it.
    ok('SELECT * FROM tags g RIGHT JOIN transactions t ON g.ledger_id = @ledger WHERE t.ledger_id = @ledger')
    // The ledger's own row.
    ok("UPDATE ledgers SET name = ? WHERE id = @ledger")
    // App-wide tables need nothing.
    ok('SELECT * FROM app_settings WHERE key = ?')
    ok("SELECT * FROM ledgers l JOIN bank_accounts b ON 1 = 1 WHERE l.id = 'x'")
    // Writes.
    ok('UPDATE transactions SET notes = ? WHERE id = ? AND ledger_id = @ledger')
    ok('UPDATE accounts SET name = @name WHERE id = @id AND ledger_id = @ledger')
    ok('DELETE FROM accounts WHERE id = ? AND ledger_id = @ledger')
    ok('INSERT INTO tags (ledger_id, name) VALUES (@ledger, ?), (@ledger, ?) ON CONFLICT DO NOTHING')
    ok("INSERT INTO ledger_settings (ledger_id, key, value) VALUES (@ledger, 'k', json('1')) ON CONFLICT (ledger_id, key) DO UPDATE SET value = excluded.value")
    ok('INSERT INTO payee_rules (ledger_id, payee_key, mode) SELECT t.ledger_id, t.payee_key, ? FROM transactions t WHERE t.ledger_id = @ledger')
    ok('INSERT INTO activity (action, ledger_id, actor, entity, summary) SELECT ?, @ledger, ?, ?, ?')
    // Comments, strings and quoted names don't confuse it.
    ok(`SELECT 'FROM accounts' AS x, "ledger_id" FROM transactions -- FROM accounts
        /* JOIN tags */ WHERE ledger_id = @ledger`)
  })

  it('refuses a ledger table without a pin', () => {
    refused('SELECT * FROM transactions', /transactions has no ledger pin/)
    refused('SELECT * FROM transactions t WHERE t.id = ?', /transactions AS t has no ledger pin/)
    refused('SELECT * FROM ledger_categories WHERE id = ?', /ledger_categories/)
    refused('UPDATE transactions SET notes = ? WHERE id = ?')
    refused('DELETE FROM tags WHERE id = ?')
  })

  it('refuses a positional ledger id: any ledger could be passed', () => {
    refused('SELECT * FROM transactions WHERE ledger_id = ?')
    refused('SELECT * FROM transactions WHERE ledger_id = @other')
  })

  it('refuses a pin under OR, NOT or CASE, or in a larger expression', () => {
    refused('SELECT * FROM transactions WHERE ledger_id = @ledger OR id = ?')
    refused('SELECT * FROM transactions WHERE id = ? OR ledger_id = @ledger')
    refused('SELECT * FROM transactions WHERE (ledger_id = @ledger OR 1) AND id = ?')
    refused('SELECT * FROM transactions WHERE NOT ledger_id = @ledger')
    refused('SELECT * FROM transactions WHERE NOT (ledger_id = @ledger)')
    refused('SELECT * FROM transactions WHERE CASE WHEN ledger_id = @ledger THEN 1 ELSE 1 END')
    refused('SELECT * FROM transactions WHERE coalesce(ledger_id = @ledger, 1)')
    refused('SELECT ledger_id = @ledger FROM transactions')
    // Nested ANDs are fine, and so is a CASE or OR beside the pin.
    ok('SELECT * FROM transactions WHERE (id = ? AND (ledger_id = @ledger)) AND date > ?')
    ok("SELECT * FROM transactions WHERE ledger_id = @ledger AND CASE WHEN status = 'x' OR 1 THEN 1 ELSE 0 END AND (a OR b) ORDER BY CASE WHEN x THEN 1 END")
    ok('SELECT * FROM transactions WHERE id BETWEEN ? AND ? AND ledger_id = @ledger AND x IN (1, 2)')
  })

  it('refuses a table pinned only through an unpinned one, or by another scope', () => {
    refused('SELECT * FROM transactions t JOIN tags g ON g.ledger_id = t.ledger_id', /transactions AS t/)
    // A pin in a subquery is for the subquery's own table, even with the same alias.
    refused('SELECT * FROM transactions t WHERE t.id IN (SELECT t.id FROM transactions t WHERE t.ledger_id = @ledger)')
    refused('SELECT id FROM transactions WHERE ledger_id = @ledger UNION SELECT id FROM transactions')
    // Unqualified with two ledger tables in one FROM: ambiguous, so not a pin.
    refused('SELECT * FROM transactions, tags WHERE ledger_id = @ledger')
  })

  it("refuses a LEFT JOIN's ON pin for the outer table", () => {
    refused('SELECT * FROM transactions t LEFT JOIN tags g ON g.ledger_id = @ledger AND t.ledger_id = @ledger', /transactions AS t/)
    refused('SELECT * FROM tags g LEFT JOIN transactions t ON t.ledger_id = g.ledger_id WHERE t.ledger_id = @ledger', /tags AS g/)
  })

  it('refuses reading the accounts table: accounts are read through ledger_accounts', () => {
    refused('SELECT * FROM accounts WHERE ledger_id = @ledger', /ledger_accounts/)
    refused('SELECT * FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.ledger_id = @ledger WHERE t.ledger_id = @ledger', /ledger_accounts/)
    refused('UPDATE accounts SET sort = (SELECT max(sort) FROM accounts WHERE ledger_id = @ledger) WHERE ledger_id = @ledger', /ledger_accounts/)
  })

  it('refuses an INSERT into a ledger table that doesn’t set ledger_id to @ledger', () => {
    refused('INSERT INTO tags (name) VALUES (?)', /must set ledger_id/)
    refused('INSERT INTO tags VALUES (?, ?, ?)', /must set ledger_id/)
    refused('INSERT INTO tags (ledger_id, name) VALUES (?, ?)', /must set ledger_id/)
    refused('INSERT INTO tags (ledger_id, name) VALUES (@ledger, ?), (?, ?)', /must set ledger_id/)
    refused('INSERT INTO tags DEFAULT VALUES', /must set ledger_id/)
    refused('INSERT INTO tags (name, ledger_id) SELECT name, ? FROM tags g WHERE g.ledger_id = @ledger', /pinned ledger_id/)
    // The shared category list is written only from listed sites.
    refused('INSERT INTO categories (name) VALUES (?)', /must set ledger_id/)
    ok('INSERT INTO categories (ledger_id, name) VALUES (@ledger, ?)')
  })

  it('refuses a pin in a subquery for a table outside it', () => {
    refused('SELECT g.name FROM tags g WHERE NOT EXISTS (SELECT 1 WHERE g.ledger_id = @ledger)', /tags AS g/)
    refused('SELECT g.name, (SELECT 1 WHERE g.ledger_id = @ledger) AS z FROM tags g', /tags AS g/)
    refused('SELECT g.name FROM tags g WHERE g.id NOT IN (SELECT id FROM json_each(?) WHERE g.ledger_id = @ledger)', /tags AS g/)
    // Unqualified, in a subquery whose own tables have no ledger_id.
    refused('SELECT * FROM tags WHERE id IN (SELECT value FROM json_each(?) WHERE ledger_id = @ledger)', /tags has no ledger pin/)
    refused(`SELECT t.id, (SELECT c.name FROM ledger_categories c WHERE c.id = t.category_id AND c.ledger_id = @ledger AND t.ledger_id = @ledger) FROM transactions t`, /transactions AS t/)
    // An edge from an inner scope doesn't pin the outer table either.
    refused('SELECT * FROM tags g WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ledger_id = @ledger AND g.ledger_id = t.ledger_id)', /tags AS g/)
    // A subquery's alias shadows an outer one: the pin is for the subquery, not the outer tags.
    refused('SELECT * FROM tags g WHERE g.id IN (SELECT g.id FROM (SELECT id, ledger_id FROM tags WHERE ledger_id = @ledger) g WHERE g.ledger_id = @ledger)', /tags AS g/)
  })

  it('reads every FROM item: after a table-valued function, after a JOIN, in parentheses', () => {
    refused("SELECT g.name FROM json_each('[1]') j, tags g", /tags AS g/)
    refused("SELECT g.name FROM json_each('[1]') AS j, tags g WHERE j.value = 1", /tags AS g/)
    refused('SELECT g.name FROM ledgers l JOIN ledgers m ON m.id = l.id, tags g WHERE l.id = ?', /tags AS g/)
    refused('SELECT g.name FROM ledgers l, ledgers m, tags g WHERE l.id = ?', /tags AS g/)
    refused('SELECT name FROM (tags)', /parenthesized/)
    refused('SELECT name FROM (tags g) WHERE g.ledger_id = @ledger', /parenthesized/)
    refused('SELECT * FROM ledgers l JOIN (tags g JOIN transactions t ON 1) ON 1', /parenthesized/)
    expect(referencedTables('SELECT name FROM (tags)')).toEqual(['tags'])
    expect(referencedTables("SELECT * FROM json_each(?) j, tags g JOIN ledgers l ON 1, payee_rules r")).toEqual(['tags', 'payee_rules', 'ledgers'])
  })

  it('refuses an ON pin for a table the join keeps whole', () => {
    // The joined item isn't a table, so the ON is the LEFT JOIN's, not the FROM table's.
    refused("SELECT g.name FROM tags g LEFT JOIN json_each('[1]') j ON g.ledger_id = @ledger", /tags AS g/)
    refused('SELECT g.name FROM tags g LEFT JOIN (SELECT 1 AS x) s ON g.ledger_id = @ledger', /tags AS g/)
    // RIGHT JOIN keeps every row of the joined table, FULL JOIN of both.
    refused('SELECT t.name FROM app_settings s RIGHT JOIN tags t ON t.ledger_id = @ledger', /tags AS t/)
    refused('SELECT t.name FROM app_settings s FULL JOIN tags t ON t.ledger_id = @ledger', /tags AS t/)
    refused('SELECT g.name FROM tags g FULL OUTER JOIN app_settings s ON g.ledger_id = @ledger', /tags AS g/)
    refused('SELECT * FROM tags g RIGHT JOIN transactions t ON g.ledger_id = @ledger AND t.ledger_id = @ledger', /transactions AS t/)
  })

  it('refuses a child table read without a pinned parent', () => {
    refused('SELECT balance_minor FROM balance_snapshots WHERE account_id = ?', /balance_snapshots has no ledger pin/)
    refused('SELECT * FROM transaction_tags WHERE transaction_id = ?', /transaction_tags has no ledger pin/)
    refused('SELECT * FROM transaction_links WHERE money_in_id IN (SELECT value FROM json_each(?)) OR money_out_id IN (SELECT value FROM json_each(?))', /transaction_links/)
    refused('DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?', /transaction_tags/)
    refused('UPDATE transaction_links SET amount_minor = 1 WHERE money_in_id = ?', /transaction_links/)
    // Joined to a parent that isn't pinned, or by a column that isn't a parent column.
    refused('SELECT * FROM transaction_tags x JOIN transactions t ON t.id = x.transaction_id', /transactions AS t/)
    refused('SELECT x.* FROM transaction_tags x JOIN transactions t ON t.account_id = x.transaction_id WHERE t.ledger_id = @ledger', /transaction_tags AS x/)
    refused('SELECT x.* FROM transaction_tags x JOIN tags t ON t.id = x.transaction_id WHERE t.ledger_id = @ledger', /transaction_tags AS x/)
    // A LEFT JOIN of the parent doesn't filter the child.
    refused('SELECT x.* FROM transaction_tags x LEFT JOIN transactions t ON t.id = x.transaction_id AND t.ledger_id = @ledger', /transaction_tags AS x/)
    // The IN subquery must be a pinned parent's ids, of one branch.
    refused('SELECT * FROM transaction_tags WHERE transaction_id IN (SELECT account_id FROM transactions WHERE ledger_id = @ledger)', /transaction_tags/)
    refused('SELECT * FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger UNION SELECT ?)', /transaction_tags/)
    refused('SELECT * FROM transaction_tags WHERE transaction_id NOT IN (SELECT id FROM transactions WHERE ledger_id = @ledger)', /transaction_tags/)
  })

  it('refuses a pin in HAVING', () => {
    refused('SELECT count(*) AS n FROM tags HAVING ledger_id = @ledger', /tags has no ledger pin/)
    refused('SELECT category_id, sum(amount_minor) FROM transactions GROUP BY category_id HAVING ledger_id = @ledger', /transactions/)
    refused('SELECT category_id FROM transactions GROUP BY category_id HAVING count(*) > 1 AND ledger_id = @ledger', /transactions/)
  })

  it('refuses statements other than SELECT, INSERT, UPDATE and DELETE', () => {
    refused('DROP TRIGGER scope_tags_delete', /only SELECT/)
    refused('PRAGMA foreign_keys = OFF', /only SELECT/)
    refused("ATTACH 'x.db' AS x", /only SELECT/)
    refused('CREATE TEMP TABLE x (y)', /only SELECT/)
    refused('', /only SELECT/)
  })

  it("refuses a write to another ledger's row in ledgers", () => {
    refused("UPDATE ledgers SET category_list = 'own', name = 'pwned' WHERE id = ?", /id = @ledger/)
    refused('DELETE FROM ledgers WHERE id = ?', /id = @ledger/)
    refused('UPDATE ledgers SET name = ? WHERE id = @ledger OR 1', /id = @ledger/)
    refused("INSERT INTO ledgers (id, name, slug) VALUES (@ledger, 'x', 'x')", /registry/)
  })

  it('refuses OR REPLACE on ledger tables', () => {
    refused('INSERT OR REPLACE INTO tags (id, ledger_id, name) VALUES (?, @ledger, ?)', /OR REPLACE/)
    refused('REPLACE INTO categories (id, ledger_id, name) VALUES (?, @ledger, ?)', /OR REPLACE/)
    refused('UPDATE OR REPLACE tags SET id = ? WHERE id = ? AND ledger_id = @ledger', /OR REPLACE/)
    refused('UPDATE OR REPLACE ledgers SET id = ? WHERE id = @ledger', /OR REPLACE/)
    ok('UPDATE OR IGNORE tags SET name = ? WHERE id = ? AND ledger_id = @ledger')
    ok('INSERT OR IGNORE INTO tags (ledger_id, name) VALUES (@ledger, ?)')
  })

  it('checks ledger_id in every branch of an INSERT ... SELECT', () => {
    refused("INSERT INTO tags (ledger_id, name) SELECT @ledger, 'x' UNION ALL SELECT ?, 'y'", /ledger_id/)
    refused("INSERT INTO tags (ledger_id, name) SELECT g.ledger_id, g.name FROM tags g WHERE g.ledger_id = @ledger UNION SELECT h.ledger_id, h.name FROM tags h WHERE h.ledger_id = ?", /ledger_id|no ledger pin/)
    refused("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'x') UNION ALL SELECT ?, 'y'", /ledger_id/)
    refused("INSERT INTO tags (ledger_id, name) SELECT @ledger, 'x' UNION VALUES (?, 'y')", /every branch/)
    ok("INSERT INTO tags (ledger_id, name) SELECT @ledger, 'x' UNION ALL SELECT @ledger, 'y'")
    ok("INSERT INTO tags (ledger_id, name) SELECT g.ledger_id, g.name || '2' FROM tags g WHERE g.ledger_id = @ledger UNION SELECT @ledger, 'z' ON CONFLICT DO NOTHING")
  })

  it('lists the tables a statement uses', () => {
    expect(referencedTables('SELECT * FROM a JOIN b ON 1 WHERE x IN (SELECT y FROM main.c) ').sort()).toEqual(['a', 'b', 'c'])
    expect(referencedTables('INSERT OR REPLACE INTO "d" (x) SELECT x FROM e, f g')).toEqual(['e', 'f', 'd'])
    expect(referencedTables('UPDATE OR IGNORE h SET x = 1')).toEqual(['h'])
    expect(referencedTables('SELECT * FROM json_each(?) j')).toEqual([])
  })
})
