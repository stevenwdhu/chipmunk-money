import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TABLES } from './db/tables'
import { bareDatabase } from './test/world'

/**
 * Static checks on the source and the schema (the repo has no linter, so they run with the tests).
 * One more lives beside what it checks: db/scope.test.ts keeps db/unscoped-sites.ts equal to the
 * allLedgers calls in the source.
 */

const src = import.meta.dirname

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') out.push(...sourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** What a file does with the database that only src/db/ may do, as `line: text`. */
export function rawDatabaseUses(source: string): string[] {
  const found: string[] = []
  source.split('\n').forEach((line, i) => {
    // A regular expression literal's exec is not the database's.
    const code = line.replace(/\/(?:\\.|[^/\\\n])+\/[dgimsuyv]*\.exec\(/g, '')
    const raw =
      /\bfrom\s+['"](?:drizzle-orm\/)?better-sqlite3(?:\/[\w-]+)?['"]/.test(code) ||
      /\brequire\(\s*['"]better-sqlite3['"]\s*\)/.test(code) ||
      // Drizzle's own .prepare() takes nothing: a connection's takes SQL.
      /\.prepare\(\s*[^)\s]/.test(code) ||
      /\.(?:exec|pragma)\(/.test(code)
    if (raw) found.push(`${i + 1}: ${line.trim()}`)
  })
  return found
}

describe('the source', () => {
  it('uses the database only through src/db/: no better-sqlite3, and no prepare, exec or pragma', () => {
    // Tests and their helpers (src/test/) look at the database directly on purpose.
    const files = sourceFiles(src).filter((f) => {
      const rel = path.relative(src, f)
      return !rel.startsWith(`db${path.sep}`) && !rel.startsWith(`test${path.sep}`)
    })
    expect(files.length).toBeGreaterThan(50)
    const problems = files.flatMap((f) => rawDatabaseUses(readFileSync(f, 'utf8')).map((u) => `${path.relative(src, f)}:${u}`))
    expect(problems).toEqual([])
  })

  it('finds each kind of raw use, and lets regular expressions and drizzle be', () => {
    expect(rawDatabaseUses("import Database from 'better-sqlite3'")).toHaveLength(1)
    expect(rawDatabaseUses("import type Database from 'better-sqlite3'")).toHaveLength(1)
    expect(rawDatabaseUses("import { drizzle } from 'drizzle-orm/better-sqlite3'")).toHaveLength(1)
    expect(rawDatabaseUses("import { migrate } from 'drizzle-orm/better-sqlite3/migrator'")).toHaveLength(1)
    expect(rawDatabaseUses("sqlite.prepare('SELECT 1').get()")).toHaveLength(1)
    expect(rawDatabaseUses('sqlite.prepare(sql)')).toHaveLength(1)
    expect(rawDatabaseUses("db.exec('DELETE FROM tags')")).toHaveLength(1)
    expect(rawDatabaseUses("sqlite.pragma('foreign_keys = OFF')")).toHaveLength(1)
    expect(rawDatabaseUses('const m = /^Bearer\\s+(\\S+)$/i.exec(auth)')).toEqual([])
    expect(rawDatabaseUses('const q = this.db.select().from(t).prepare()')).toEqual([])
    expect(rawDatabaseUses("ctx.q.run('UPDATE tags SET name = ? WHERE id = ? AND ledger_id = @ledger', name, id)")).toEqual([])
  })
})

/**
 * Indexes on ledger tables that don't lead with ledger_id, and why. Every other one does, so a
 * query for one ledger never reads every ledger's rows through it.
 */
const NOT_LEDGER_LED: Record<string, string> = {
  tx_external_id: "A bank's transaction id is unique within the account it came to, whatever the ledger.",
  tx_account_date: "An account's register and balance, by account (an account is in one ledger).",
  labels_shared_name: "The shared list's label names are unique among the shared rows (ledger_id is null).",
}

describe('the schema', () => {
  const sqlite = bareDatabase()
  type Column = { name: string | null; key: number }

  it('leads every index on a ledger table with ledger_id, except foreign key indexes and the listed ones', () => {
    const problems: string[] = []
    const seen = new Set<string>()
    for (const t of TABLES.filter((t) => t.kind === 'ledger' || t.kind === 'catalog')) {
      const fkColumns = new Set((sqlite.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as Array<{ from: string }>).map((f) => f.from))
      for (const index of sqlite.prepare(`PRAGMA index_list("${t.name}")`).all() as Array<{ name: string }>) {
        const columns = (sqlite.prepare(`PRAGMA index_xinfo("${index.name}")`).all() as Column[]).filter((c) => c.key).map((c) => c.name)
        if (columns[0] === 'ledger_id') continue
        // A foreign key's own index (so a cascade or SET NULL finds the rows): that one column.
        if (columns.length === 1 && columns[0] && fkColumns.has(columns[0])) continue
        if (NOT_LEDGER_LED[index.name]) {
          seen.add(index.name)
          continue
        }
        problems.push(`${t.name}: ${index.name} (${columns.map((c) => c ?? '<expression>').join(', ')})`)
      }
    }
    expect(problems).toEqual([])
    // An exception for an index that's gone, or now leads with ledger_id, goes too.
    expect([...seen].sort()).toEqual(Object.keys(NOT_LEDGER_LED).sort())
  })

  it('leads some index with every foreign key column', () => {
    const problems: string[] = []
    for (const t of TABLES) {
      const leading = new Set(
        (sqlite.prepare(`PRAGMA index_list("${t.name}")`).all() as Array<{ name: string }>).map(
          (i) => (sqlite.prepare(`PRAGMA index_xinfo("${i.name}")`).all() as Column[]).find((c) => c.key)?.name,
        ),
      )
      for (const f of sqlite.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as Array<{ from: string; table: string }>) {
        if (!leading.has(f.from)) problems.push(`${t.name}.${f.from} → ${f.table}`)
      }
    }
    expect(problems).toEqual([])
  })
})
