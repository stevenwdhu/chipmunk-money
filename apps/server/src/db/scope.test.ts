import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../env'
import { testLedger, testStorage } from '../test/helpers'
import { appSettings, tags } from './schema'
import { allLedgers, LedgerQuery, ledgerMaintenance, LedgerScopeError } from './scope'
import { UNSCOPED_SITES } from './unscoped-sites'

const OUTSIDE = 'write outside the ledger scope'

function twoLedgers() {
  const storage = testStorage()
  const a = storage.registry.defaultContext()
  const b = testLedger(storage, 'Family')
  const tag = (ctx: typeof a, name: string) => Number(ctx.q.run('INSERT INTO tags (ledger_id, name) VALUES (@ledger, ?)', name).lastInsertRowid)
  return { storage, a, b, aTag: tag(a, 'trip'), bTag: tag(b, 'trip') }
}

describe('the ledger handle', () => {
  it('binds @ledger itself, with named or positional parameters', () => {
    const { a, b, aTag, bTag } = twoLedgers()
    expect(a.q.all('SELECT id FROM tags WHERE ledger_id = @ledger')).toEqual([{ id: aTag }])
    expect(b.q.column('SELECT id FROM tags WHERE ledger_id = @ledger AND name = ?', 'trip')).toEqual([bTag])
    expect(b.q.pluck('SELECT id FROM tags WHERE ledger_id = @ledger AND name = @name', { name: 'trip' })).toBe(bTag)
    expect(a.q.get('SELECT name FROM tags WHERE ledger_id = @ledger AND id = ?', aTag)).toEqual({ name: 'trip' })
    // B's row isn't A's, even by its id.
    expect(a.q.get('SELECT name FROM tags WHERE ledger_id = @ledger AND id = ?', bTag)).toBeUndefined()
    // Statements without @ledger (an app table) take their parameters as they are.
    expect(a.q.pluck('SELECT count(*) FROM ledgers WHERE id = ?', a.ledger.id)).toBe(1)
  })

  it('refuses a `ledger` parameter from the caller', () => {
    const { a, b } = twoLedgers()
    expect(() => a.q.all('SELECT id FROM tags WHERE ledger_id = @ledger', { ledger: b.ledger.id })).toThrow(LedgerScopeError)
  })

  it('refuses DDL, PRAGMA and writes to another ledger’s row', () => {
    const { storage, a, b } = twoLedgers()
    expect(() => a.q.run('DROP TRIGGER scope_tags_delete')).toThrow(LedgerScopeError)
    expect(() => a.q.run('PRAGMA foreign_keys = OFF')).toThrow(LedgerScopeError)
    expect(storage.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() => a.q.run("UPDATE ledgers SET category_list = 'own', name = 'pwned' WHERE id = ?", b.ledger.id)).toThrow(LedgerScopeError)
    expect(storage.registry.get(b.ledger.id)?.name).toBe('Family')
    a.q.run('UPDATE ledgers SET color = ? WHERE id = @ledger', '#000000')
  })

  it('refuses unpinned SQL before running it', () => {
    const { a } = twoLedgers()
    expect(() => a.q.all('SELECT id FROM tags')).toThrow(/tags has no ledger pin/)
    expect(() => a.q.run('DELETE FROM tags WHERE id = ?', 1)).toThrow(LedgerScopeError)
    expect(a.q.pluck('SELECT count(*) FROM tags WHERE ledger_id = @ledger')).toBe(1)
  })

  it('says not found with the message given', () => {
    const { a, bTag } = twoLedgers()
    expect(() => a.q.mustGet('SELECT * FROM tags WHERE ledger_id = @ledger AND id = ?', 'Tag not found', bTag)).toThrow(HTTPException)
    expect(() => a.q.mustGet('SELECT * FROM tags WHERE ledger_id = @ledger AND id = ?', 'Tag not found', bTag)).toThrow('Tag not found')
  })

  it('runs a transaction in its ledger, and rolls back on an error', () => {
    const { a } = twoLedgers()
    expect(() =>
      a.q.transaction(() => {
        a.q.run("INSERT INTO tags (ledger_id, name) VALUES (@ledger, 'one')")
        throw new Error('stop')
      }),
    ).toThrow('stop')
    expect(a.q.column('SELECT name FROM tags WHERE ledger_id = @ledger ORDER BY name')).toEqual(['trip'])
    expect(() => a.q.transaction(() => Promise.resolve(1))).toThrow(/promise/)
  })
})

describe('the write guards', () => {
  it("abort a write to another ledger's rows, and a raw write with no scope", () => {
    const { storage, a, b, aTag, bTag } = twoLedgers()
    const { sqlite } = storage
    // Raw, outside any handle: nothing of a ledger can be written.
    expect(() => sqlite.prepare('UPDATE tags SET name = ? WHERE id = ?').run('x', aTag)).toThrow(OUTSIDE)
    expect(() => sqlite.prepare("INSERT INTO tags (ledger_id, name) VALUES (?, 'x')").run(a.ledger.id)).toThrow(OUTSIDE)
    expect(() => sqlite.prepare('DELETE FROM transaction_tags').run()).not.toThrow()
    // A's scope: B's rows stay as they are, whatever the SQL says.
    ledgerMaintenance(sqlite, a.ledger.id, () => {
      expect(() => sqlite.prepare('UPDATE tags SET name = ? WHERE id = ?').run('x', bTag)).toThrow(OUTSIDE)
      expect(() => sqlite.prepare("INSERT INTO tags (ledger_id, name) VALUES (?, 'x')").run(b.ledger.id)).toThrow(OUTSIDE)
      sqlite.prepare('UPDATE tags SET name = ? WHERE id = ?').run('mine', aTag)
    })
    expect(b.q.pluck('SELECT name FROM tags WHERE ledger_id = @ledger')).toBe('trip')
    // A pinned statement can't be pointed at B's rows either: the guard holds even if a pin is wrong.
    expect(() => sqlite.prepare("DELETE FROM tags WHERE ledger_id <> ''").run()).toThrow(OUTSIDE)
  })

  it('hold child rows to their parents’ ledger', () => {
    const { storage, a, b, aTag, bTag } = twoLedgers()
    const account = (ctx: typeof a) => {
      const institution = ctx.q.run("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Bank')").lastInsertRowid
      return Number(ctx.q.run("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES (@ledger, 'Cash', 'cash', ?)", institution).lastInsertRowid)
    }
    const tx = (ctx: typeof a) =>
      Number(
        ctx.q.run("INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key) VALUES (@ledger, ?, '2026-09-01', -1, 'x', 'x')", account(ctx))
          .lastInsertRowid,
      )
    const aTx = tx(a)
    const bTx = tx(b)
    b.q.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', bTx, bTag)
    expect(() => a.q.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', bTx, bTag)).toThrow(OUTSIDE)
    // The handle wants the child pinned through a parent; the guard holds without that too.
    expect(() => a.q.run('DELETE FROM transaction_tags WHERE transaction_id = ?', bTx)).toThrow(LedgerScopeError)
    expect(() => ledgerMaintenance(storage.sqlite, a.ledger.id, () => storage.sqlite.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(bTx))).toThrow(OUTSIDE)
    a.q.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', aTx, aTag)
    expect(() => storage.sqlite.prepare('DELETE FROM transaction_tags').run()).toThrow(OUTSIDE)
    // Cascades from a ledger's own rows stay within it.
    a.q.run('DELETE FROM transactions WHERE ledger_id = @ledger AND id = ?', aTx)
    const tagged = 'SELECT count(*) FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND id = ?)'
    expect(b.q.pluck(tagged, bTx)).toBe(1)
    // Pinned through its parent, a child row of B's isn't A's to read, even by its id.
    expect(a.q.pluck(tagged, bTx)).toBe(0)
  })

  it('keep child reads to the ledger, through their parents', () => {
    const { a, b } = twoLedgers()
    const institution = b.q.run("INSERT INTO institutions (ledger_id, name) VALUES (@ledger, 'Bank')").lastInsertRowid
    const bAccount = b.q.run("INSERT INTO accounts (ledger_id, name, type, institution_id) VALUES (@ledger, 'Cash', 'cash', ?)", institution).lastInsertRowid
    b.q.run("INSERT INTO balance_snapshots (account_id, date, balance_minor) VALUES (?, '2026-09-01', 123456)", bAccount)
    expect(() => a.q.all('SELECT balance_minor FROM balance_snapshots WHERE account_id = ?', bAccount)).toThrow(/balance_snapshots has no ledger pin/)
    const read = 'SELECT s.balance_minor FROM ledger_accounts x JOIN balance_snapshots s ON s.account_id = x.id WHERE x.ledger_id = @ledger AND x.id = ?'
    expect(a.q.all(read, bAccount)).toEqual([])
    expect(b.q.all(read, bAccount)).toEqual([{ balance_minor: 123456 }])
  })

  it('see the row a REPLACE deletes', () => {
    const { storage, a, b, bTag } = twoLedgers()
    const { sqlite } = storage
    const food = sqlite.prepare("SELECT id FROM categories WHERE ledger_id IS NULL AND name = 'Groceries'").pluck().get() as number
    // Unreferenced, so no cascade or SET NULL would catch the delete.
    const unused = sqlite.prepare("SELECT id FROM categories c WHERE ledger_id IS NULL AND NOT EXISTS (SELECT 1 FROM category_labels WHERE category_id = c.id)").pluck().get() as number
    ledgerMaintenance(sqlite, a.ledger.id, () => {
      // Taking B's tag (or the shared category) by its id would delete it first.
      expect(() => sqlite.prepare('INSERT OR REPLACE INTO tags (id, ledger_id, name) VALUES (?, ?, ?)').run(bTag, a.ledger.id, 'stolen')).toThrow(OUTSIDE)
      expect(() => sqlite.prepare('REPLACE INTO categories (id, ledger_id, name) VALUES (?, ?, ?)').run(unused, a.ledger.id, 'Mine')).toThrow(OUTSIDE)
      const mine = Number(sqlite.prepare("INSERT INTO tags (ledger_id, name) VALUES (?, 'mine')").run(a.ledger.id).lastInsertRowid)
      expect(() => sqlite.prepare('UPDATE OR REPLACE tags SET id = ? WHERE id = ?').run(bTag, mine)).toThrow(OUTSIDE)
    })
    expect(b.q.pluck('SELECT name FROM tags WHERE ledger_id = @ledger AND id = ?', bTag)).toBe('trip')
    expect(a.q.pluck('SELECT count(*) FROM ledger_categories WHERE ledger_id = @ledger AND id IN (?, ?)', food, unused)).toBe(2)
    // The handle refuses them before they run.
    expect(() => a.q.run('INSERT OR REPLACE INTO tags (id, ledger_id, name) VALUES (?, @ledger, ?)', bTag, 'stolen')).toThrow(/OR REPLACE/)
  })

  it('keep the shared category list to writes with every ledger in scope', () => {
    const { storage, a } = twoLedgers()
    const food = storage.sqlite.prepare("SELECT id FROM categories WHERE ledger_id IS NULL AND name = 'Groceries'").pluck().get() as number
    expect(() => ledgerMaintenance(storage.sqlite, a.ledger.id, () => storage.sqlite.prepare("UPDATE categories SET name = 'x' WHERE id = ?").run(food))).toThrow(OUTSIDE)
    storage.allLedgers('seed the shared category list', (db) => db.run("UPDATE categories SET name = 'Food' WHERE id = ?", food))
    expect(a.q.pluck('SELECT name FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', food)).toBe('Food')
  })

  it('restore the scope after each call, and refuse async work', () => {
    const { storage, a, aTag } = twoLedgers()
    allLedgers(storage.sqlite, 'ledger counts', () => {
      a.q.get('SELECT 1 FROM tags WHERE ledger_id = @ledger')
      // Still every ledger after the handle's own call.
      storage.sqlite.prepare("UPDATE tags SET color = 'red' WHERE id = ?").run(aTag)
    })
    expect(() => storage.sqlite.prepare("UPDATE tags SET color = 'blue' WHERE id = ?").run(aTag)).toThrow(OUTSIDE)
    expect(() => ledgerMaintenance(storage.sqlite, a.ledger.id, async () => 1)).toThrow('synchronous')
  })
})

describe('the app-wide database', () => {
  it('refuses SQL naming a table of ledger data', () => {
    const { storage } = twoLedgers()
    storage.app.db.insert(appSettings).values({ key: 'x', value: 1 }).run()
    expect(storage.app.db.select().from(appSettings).where(eq(appSettings.key, 'x')).get()?.value).toBe(1)
    expect(() => storage.app.db.select().from(tags).all()).toThrow(LedgerScopeError)
    expect(() => storage.app.db.update(tags).set({ name: 'x' }).run()).toThrow(/use the ledger handle/)
  })
})

/**
 * The allLedgers calls in one file's source: each one's reason, and what's wrong with any that
 * can't be read (no literal reason, or allLedgers passed around instead of called).
 */
function unscopedCalls(source: string): { reasons: string[]; problems: string[] } {
  // Storage's own allLedgers hands its caller's reason on: that's the caller's site.
  const code = source.replace('allLedgers: (reason, fn) => allLedgers(sqlite, reason, fn)', '')
  const reasons: string[] = []
  const problems: string[] = []
  for (const m of code.matchAll(/\ballLedgers\b/g)) {
    const rest = code.slice(m.index + m[0].length)
    const before = code.slice(0, m.index)
    // The import, and the method's declaration in Storage's interface.
    if (/import\s*\{[^}]*$/.test(before) || /^<T>\(reason: UnscopedReason/.test(rest)) continue
    const call = /^\(\s*(?:[\w.]+\s*,\s*)?(['"])(.+?)\1/.exec(rest)
    if (call) reasons.push(call[2]!)
    else problems.push(`allLedgers${rest.slice(0, 30).split('\n')[0]}`)
  }
  return { reasons, problems }
}

/**
 * The ledgerMove and twoLedgers calls in one file's source, comments left out: each one's name, and
 * what's wrong with any other use (passed around, or imported under another name).
 */
function twoLedgerCalls(source: string): { calls: string[]; problems: string[] } {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const calls: string[] = []
  const problems: string[] = []
  for (const m of code.matchAll(/\b(ledgerMove|twoLedgers)\b/g)) {
    const rest = code.slice(m.index + m[0].length)
    const before = code.slice(0, m.index)
    if (/import\s*\{[^}]*$/.test(before) && !/^\s+as\b/.test(rest)) continue
    if (/^\s*\(/.test(rest) && !/\.\s*$/.test(before)) calls.push(m[1]!)
    else problems.push(`${m[1]}${rest.slice(0, 30).split('\n')[0]}`)
  }
  return { calls, problems }
}

/** The server's source files, tests left out, by their path from apps/server. */
function sourceFiles(): Array<{ rel: string; source: string }> {
  const root = path.join(repoRoot, 'apps/server')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(full)
    }
  }
  walk(path.join(root, 'src'))
  return files.map((file) => ({ rel: path.relative(root, file), source: readFileSync(file, 'utf8') }))
}

describe('unscoped sites', () => {
  it('lists every allLedgers call in the source, each reason used once, where it is', () => {
    const found: string[] = []
    for (const { rel, source } of sourceFiles()) {
      if (rel === 'src/db/scope.ts' || rel === 'src/db/unscoped-sites.ts') continue
      const { reasons, problems } = unscopedCalls(source)
      expect(problems, `${rel}: allLedgers must be called with its reason as a string literal`).toEqual([])
      found.push(...reasons.map((reason) => `${rel}: ${reason}`))
    }
    const listed = Object.entries(UNSCOPED_SITES).map(([reason, site]) => `${site.file}: ${reason}`)
    // A list, not a set: a second call with a listed reason is a site nobody reviewed.
    expect(found.sort()).toEqual(listed.sort())
  })

  it('counts a reason used twice, and finds allLedgers passed around', () => {
    const twice = unscopedCalls("allLedgers(this.sqlite, 'ledger counts', f)\nallLedgers(this.sqlite, 'ledger counts', g)")
    expect(twice.reasons).toEqual(['ledger counts', 'ledger counts'])
    expect(unscopedCalls("const run = allLedgers\nrun(sqlite, 'anything', fn)").problems).toHaveLength(1)
    expect(unscopedCalls('allLedgers(sqlite, reason, fn)').problems).toHaveLength(1)
    expect(unscopedCalls("storage.allLedgers('full backup', (s) => s)")).toEqual({ reasons: ['full backup'], problems: [] })
  })
})

describe('the two-ledger scopes', () => {
  it('are each called once in the source, in move-rows.ts, and never passed around', () => {
    const found: string[] = []
    for (const { rel, source } of sourceFiles()) {
      if (rel === 'src/db/scope.ts') continue
      const { calls, problems } = twoLedgerCalls(source)
      expect(problems, `${rel}: ledgerMove and twoLedgers are only called`).toEqual([])
      found.push(...calls.map((name) => `${rel}: ${name}`))
    }
    expect(found.sort()).toEqual(['src/db/move-rows.ts: ledgerMove', 'src/db/move-rows.ts: twoLedgers'])
  })

  it('finds a call, one passed around, one renamed, and one through the module, and skips comments', () => {
    expect(twoLedgerCalls("import { ledgerMove, twoLedgers } from './scope'\nledgerMove(sqlite, m, f)\ntwoLedgers (sqlite, c, g)")).toEqual({
      calls: ['ledgerMove', 'twoLedgers'],
      problems: [],
    })
    expect(twoLedgerCalls('const run = ledgerMove\nrun(sqlite, m, f)').problems).toHaveLength(1)
    expect(twoLedgerCalls("import { twoLedgers as both } from './scope'").problems).toHaveLength(1)
    expect(twoLedgerCalls('scope.twoLedgers(sqlite, c, g)').problems).toHaveLength(1)
    expect(twoLedgerCalls('/** In a scope (ledgerMove). */\n// twoLedgers, for changeHome\nconst x = 1')).toEqual({ calls: [], problems: [] })
  })
})

describe('LedgerQuery', () => {
  it('needs a connection with write guards', () => {
    expect(() => new LedgerQuery(new Database(':memory:'), 'x')).toThrow(/no write guards/)
  })
})
