import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TABLES } from './db/tables'
import { env } from './env'
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
  tx_account_date: "An account's register and balance, by account: a shared account's rows are in several ledgers, and reads across them find them by account.",
  tx_transfer_pair: 'What names a row as its transfer’s other side, found by that row’s id alone, as a move checks there’s nothing left before the row changes ledger.',
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

/**
 * SQL as its statements, each with its comments gone, quoted text and names as '' and x, and its
 * whitespace as one space. A trigger's body (BEGIN ... END, CASE ... END inside) is part of its
 * statement.
 */
export function sqlStatements(sql: string): string[] {
  let code = ''
  for (let i = 0; i < sql.length; ) {
    const two = sql.slice(i, i + 2)
    if (two === '--' || two === '/*') {
      const end = two === '--' ? sql.indexOf('\n', i) : sql.indexOf('*/', i + 2) + 2
      i = end <= 1 || end === -1 ? sql.length : end
      code += ' '
      continue
    }
    const close = { "'": "'", '"': '"', '`': '`', '[': ']' }[sql[i]!]
    if (!close) {
      code += sql[i++]
      continue
    }
    // To the closing quote: a doubled one is a quote inside.
    let j = i + 1
    while (j < sql.length && (sql[j] !== close || (close !== ']' && sql[j + 1] === close && ++j))) j++
    code += sql[i] === "'" ? " '' " : ' x '
    i = j + 1
  }
  const statements: string[] = []
  const push = (text: string) => {
    const statement = text.replace(/\s+/g, ' ').trim()
    if (statement) statements.push(statement)
  }
  let start = 0
  let words: string[] = []
  let depth = 0
  for (const m of code.matchAll(/[A-Za-z_][\w$]*|;/g)) {
    const token = m[0].toUpperCase()
    if (token === ';') {
      if (depth > 0) continue
      push(code.slice(start, m.index))
      start = m.index + 1
      words = []
      continue
    }
    words.push(token)
    const trigger = words[0] === 'CREATE' && words.slice(1, 3).includes('TRIGGER')
    if (trigger && token === 'BEGIN') depth++
    else if (depth > 0 && token === 'CASE') depth++
    else if (depth > 0 && token === 'END') depth--
  }
  push(code.slice(start))
  return statements
}

/**
 * What a migration after the baseline may do. drizzle runs it with foreign keys on, so dropping a
 * table (as a rebuild does) cascade-deletes the rows under it, and the real data must come
 * through every migration whole. So: new tables, new columns, new indexes, and views and triggers
 * dropped and made again. Nothing that changes or removes rows, tables or columns.
 */
const MIGRATION_STATEMENTS: readonly RegExp[] = [
  /^CREATE TABLE (IF NOT EXISTS )?\S+ ?\(/i,
  /^ALTER TABLE \S+ ADD (COLUMN )?/i,
  /^CREATE (UNIQUE )?INDEX /i,
  /^(CREATE|DROP) (VIEW|TRIGGER) /i,
]

/**
 * How a migration breaks the rules, one line each: a piece (between statement-breakpoint markers)
 * without exactly one statement, since drizzle runs each piece as one, or a statement of a kind
 * MIGRATION_STATEMENTS doesn't allow. `rules: false` checks the pieces only (the baseline).
 */
export function migrationProblems(sql: string, opts: { rules?: boolean } = {}): string[] {
  return sql.split('--> statement-breakpoint').flatMap((piece, i) => {
    const statements = sqlStatements(piece)
    if (statements.length !== 1) return [`piece ${i + 1} holds ${statements.length} statements`]
    if (opts.rules === false || MIGRATION_STATEMENTS.some((r) => r.test(statements[0]!))) return []
    // Its first line of SQL, as written.
    const line = piece.split('\n').find((l) => l.trim() && !l.trim().startsWith('--'))!
    return [`piece ${i + 1}: ${line.trim().slice(0, 60)}`]
  })
}

describe('the migrations', () => {
  const journal = JSON.parse(readFileSync(path.join(env.migrations, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }

  it('are all in the journal, in order, each made after the one before', () => {
    const files = readdirSync(env.migrations).filter((f) => f.endsWith('.sql'))
    expect(files.sort()).toEqual(journal.entries.map((e) => `${e.tag}.sql`).sort())
    // drizzle runs those made after the newest one a database ran: an older time would never run.
    journal.entries.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i)
      if (i > 0) expect(e.when, e.tag).toBeGreaterThan(journal.entries[i - 1]!.when)
    })
  })

  it('hold one statement per piece, and after the baseline only what MIGRATION_STATEMENTS allows', () => {
    const problems = journal.entries.flatMap((e, i) =>
      migrationProblems(readFileSync(path.join(env.migrations, `${e.tag}.sql`), 'utf8'), { rules: i > 0 }).map((p) => `${e.tag}: ${p}`),
    )
    expect(problems).toEqual([])
  })

  it('finds a piece with two statements or none, and each kind of statement not allowed', () => {
    const pieces = (...sql: string[]) => sql.join('\n--> statement-breakpoint\n')
    // As drizzle-kit writes a column change: the table rebuilt.
    const rebuild = pieces(
      'PRAGMA foreign_keys=OFF;',
      'CREATE TABLE `__new_accounts` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);',
      'INSERT INTO `__new_accounts`("id", "name") SELECT "id", "name" FROM `accounts`;',
      'DROP TABLE `accounts`;',
      'ALTER TABLE `__new_accounts` RENAME TO `accounts`;',
      'PRAGMA foreign_keys=ON;',
    )
    expect(migrationProblems(rebuild)).toEqual([
      'piece 1: PRAGMA foreign_keys=OFF;',
      expect.stringMatching(/^piece 3: INSERT INTO `__new_accounts`/),
      'piece 4: DROP TABLE `accounts`;',
      'piece 5: ALTER TABLE `__new_accounts` RENAME TO `accounts`;',
      'piece 6: PRAGMA foreign_keys=ON;',
    ])
    expect(migrationProblems('CREATE INDEX `a` ON `t` (`x`);\nCREATE INDEX `b` ON `t` (`y`);')).toEqual(['piece 1 holds 2 statements'])
    expect(migrationProblems(pieces('CREATE INDEX `a` ON `t` (`x`);', '-- nothing left; it moved'))).toEqual(['piece 2 holds 0 statements'])
    for (const sql of [
      "UPDATE `accounts` SET `name` = 'x';",
      'DELETE FROM `tags`;',
      'ALTER TABLE `accounts` DROP COLUMN `notes`;',
      'ALTER TABLE `accounts` RENAME COLUMN `notes` TO `memo`;',
      'DROP INDEX `tx_account_date`;',
      'CREATE TABLE `copy` AS SELECT * FROM `accounts`;',
      'CREATE TEMP TRIGGER `t` BEFORE INSERT ON `tags` BEGIN SELECT 1; END;',
      'REPLACE INTO `tags` SELECT * FROM `tags`;',
    ]) {
      expect(migrationProblems(sql), sql).toHaveLength(1)
    }
  })

  it('lets each allowed kind through, triggers with their bodies as one statement', () => {
    const allowed = [
      'CREATE TABLE `account_ledgers` (\n\t`ledger_id` text NOT NULL,\n\tPRIMARY KEY(`ledger_id`, `account_id`)\n);\n',
      'ALTER TABLE `accounts` ADD `opening_ledger_id` text REFERENCES ledgers(id);',
      'ALTER TABLE `transactions` ADD COLUMN `removed_at` text;',
      'CREATE INDEX `accounts_opening_ledger` ON `accounts` (`opening_ledger_id`);',
      'CREATE UNIQUE INDEX `tx_split` ON `transactions` (`split_of`,`ledger_id`) WHERE "transactions"."split_of" is not null;',
      'DROP VIEW `ledger_accounts`;',
      '-- Home rows and member rows; one view.\nCREATE VIEW `ledger_accounts` AS SELECT a.`id`, \'a;b\' AS `x` FROM `accounts` a;',
      'DROP TRIGGER IF EXISTS `keep_ledger_transactions`;',
      `CREATE TRIGGER \`guard\` BEFORE UPDATE ON \`transactions\`
WHEN NEW.\`ledger_id\` IS NOT OLD.\`ledger_id\`
BEGIN
  SELECT CASE WHEN 1 THEN RAISE(ABORT, 'it''s refused; END') END;
  /* a second statement in the body; */ UPDATE \`tags\` SET \`name\` = \`name\` WHERE 0;
END;`,
    ]
    for (const sql of allowed) expect(migrationProblems(sql), sql).toEqual([])
    expect(sqlStatements(allowed[allowed.length - 1]!)).toHaveLength(1)
  })
})
