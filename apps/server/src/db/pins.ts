import { CHILD_NAMES, PINNED_NAMES, tableDef } from './tables'

/**
 * The ledger pin checker: every statement a ledger handle runs is checked before it's prepared, so
 * a query that forgot its ledger filter fails loudly instead of reading or writing another ledger.
 *
 * It reads the SQL as tokens, not a full parse, and knows just enough of SQLite's grammar for the
 * statements the services write:
 * - Only SELECT, INSERT, UPDATE and DELETE (with WITH): no DDL, PRAGMA or ATTACH, which could drop
 *   the write guards or turn foreign keys off for the whole connection.
 * - Each FROM or JOIN reference to a table or view with ledger_id (tables.ts) must be pinned in its
 *   own scope: a conjunct `alias.ledger_id = @ledger` (or unqualified `ledger_id = @ledger` when
 *   it's the only such table in its SELECT), or `alias.ledger_id = other.ledger_id` with `other`
 *   pinned in the same or an enclosing scope. A pin inside a subquery doesn't count for an outer
 *   table: under NOT EXISTS, say, it would keep exactly the other ledgers' rows.
 * - A pin counts only as a top-level AND of a WHERE or ON clause: not under OR, NOT or CASE, not
 *   in HAVING, and not with a positional `?` (anyone's ledger id could be passed there). In an ON
 *   clause it pins only what the join filters: a LEFT JOIN's the joined table, a RIGHT JOIN's the
 *   tables before it, a FULL JOIN's nothing.
 * - Subqueries, table-valued functions, CTE bodies and UNION branches each have their own aliases,
 *   as in SQL. A parenthesized join, like `FROM (tags g JOIN ...)`, is refused.
 * - A child table (no ledger_id) is pinned by one of its parent columns: `child.col = parent.id`
 *   with the parent pinned, or `child.col IN (SELECT id FROM parent WHERE ...)` with the
 *   subquery's table pinned. Ids are global, so a child read by an id from the request alone could
 *   be another ledger's. An INSERT into one needs nothing: the write guards hold it to its parents.
 * - `accounts` is read through the ledger_accounts view; the table itself only as the target of an
 *   UPDATE or DELETE.
 * - An INSERT into a ledger table names ledger_id and gives it @ledger (or a pinned ledger_id in
 *   every branch of an INSERT ... SELECT). Not OR REPLACE, on any ledger table: the row it replaces
 *   could be another ledger's.
 * - The `ledgers` row is written only pinned with `id = @ledger`, and never inserted.
 */

export class LedgerScopeError extends Error {
  override name = 'LedgerScopeError'
}

type TokType = 'word' | 'ident' | 'param' | 'str' | 'num' | 'punct'
interface Tok {
  type: TokType
  /** Lowercased for words and identifiers; a param's name without its prefix. */
  v: string
  pos: number
  /** Parenthesis depth (a parenthesis itself has the depth outside it). */
  depth: number
  scope: number
}

const OPS = ['->>', '->', '==', '!=', '<>', '<=', '>=', '||', '<<', '>>']

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = []
  const push = (type: TokType, v: string, pos: number) => toks.push({ type, v, pos, depth: 0, scope: 0 })
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
    } else if (c === "'" || ((c === 'x' || c === 'X') && sql[i + 1] === "'")) {
      const start = i
      i = c === "'" ? i + 1 : i + 2
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") break
        else i++
      }
      i++
      push('str', '', start)
    } else if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      const start = i
      let v = ''
      i++
      while (i < sql.length) {
        if (sql[i] === close && close !== ']' && sql[i + 1] === close) {
          v += close
          i += 2
        } else if (sql[i] === close) break
        else v += sql[i++]
      }
      i++
      push('ident', v.toLowerCase(), start)
    } else if ((c === '@' || c === ':' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      const m = /^[A-Za-z0-9_]+/.exec(sql.slice(i + 1))!
      push('param', m[0], i)
      i += 1 + m[0].length
    } else if (c === '?') {
      const m = /^\d*/.exec(sql.slice(i + 1))!
      push('param', '?', i)
      i += 1 + m[0].length
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(0x[0-9a-f]+|[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?)/i.exec(sql.slice(i))!
      push('num', m[0], i)
      i += Math.max(1, m[0].length)
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z0-9_$]+/.exec(sql.slice(i))!
      push('word', m[0].toLowerCase(), i)
      i += m[0].length
    } else {
      const op = OPS.find((o) => sql.startsWith(o, i))
      push('punct', op ?? c, i)
      i += op ? op.length : 1
    }
  }
  return toks
}

/** Words that end a table reference: never an alias. */
const KEYWORDS = new Set(
  'abort action add after all alter and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without'.split(
    ' ',
  ),
)

const isName = (t: Tok | undefined): t is Tok => !!t && (t.type === 'ident' || (t.type === 'word' && !KEYWORDS.has(t.v)))
const isWord = (t: Tok | undefined, ...words: string[]) => !!t && t.type === 'word' && words.includes(t.v)
const isPunct = (t: Tok | undefined, ...ps: string[]) => !!t && t.type === 'punct' && ps.includes(t.v)
const isLedgerParam = (t: Tok | undefined) => !!t && t.type === 'param' && t.v === 'ledger'


interface Scope {
  parent: number
  depth: number
}

type JoinType = 'inner' | 'left' | 'right' | 'full'

interface Ref {
  /** The table or view, or '' for a subquery or table-valued function (kept so its alias shadows outer ones). */
  name: string
  alias: string | null
  scope: number
  /** Index of the table name's token. */
  at: number
  kind: 'from' | 'join' | 'update' | 'delete'
  /** How it's joined to the tables before it. */
  join: JoinType
  /** UPDATE OR REPLACE. */
  orReplace?: boolean
}

interface InsertTarget {
  name: string
  at: number
  columns: string[] | null
  /** Index of the token after the column list (or after the name). */
  after: number
  /** INSERT OR REPLACE, or REPLACE INTO. */
  orReplace: boolean
}

interface Parsed {
  toks: Tok[]
  match: number[]
  scopes: Scope[]
  refs: Ref[]
  inserts: InsertTarget[]
  /** Where a FROM or JOIN item is a parenthesized join, like `FROM (tags g JOIN ...)`. */
  parenthesized: number[]
}

/** Words that end a FROM clause (a comma before one of these joins another table). */
const FROM_END = new Set(['where', 'group', 'having', 'window', 'order', 'limit', 'union', 'intersect', 'except', 'returning', 'set', 'do', 'values'])

const opensScope = (toks: Tok[], i: number) => isPunct(toks[i], '(') && isWord(toks[i + 1], 'select', 'with', 'values')

function parse(sql: string): Parsed {
  const toks = tokenize(sql)
  const match = new Array<number>(toks.length).fill(-1)
  const scopes: Scope[] = [{ parent: -1, depth: 0 }]
  const parens: Array<{ at: number; restore: number | null }> = []
  let current = 0
  let depth = 0
  toks.forEach((t, i) => {
    if (isPunct(t, '(')) {
      t.depth = depth
      t.scope = current
      depth++
      const opens = opensScope(toks, i)
      parens.push({ at: i, restore: opens ? current : null })
      if (opens) {
        scopes.push({ parent: current, depth })
        current = scopes.length - 1
      }
      return
    }
    if (isPunct(t, ')')) {
      depth = Math.max(0, depth - 1)
      const open = parens.pop()
      if (open) {
        match[open.at] = i
        match[i] = open.at
        if (open.restore !== null) current = open.restore
      }
      t.depth = depth
      t.scope = current
      return
    }
    // A UNION branch sees none of the other branches' aliases.
    if (isWord(t, 'union', 'intersect', 'except') && depth === scopes[current]!.depth) {
      scopes.push({ parent: scopes[current]!.parent, depth })
      current = scopes.length - 1
    }
    t.depth = depth
    t.scope = current
  })

  const refs: Ref[] = []
  const inserts: InsertTarget[] = []
  const parenthesized: number[] = []

  /** An optional alias at k: the alias and the index after it. */
  const aliasAt = (k: number): [string | null, number] => {
    if (isWord(toks[k], 'as') && isName(toks[k + 1])) return [toks[k + 1]!.v, k + 2]
    if (isName(toks[k])) return [toks[k]!.v, k + 1]
    return [null, k]
  }

  /** Reads one table reference at j; returns the index after it. */
  const readRef = (j: number, kind: Ref['kind'], join: JoinType): number => {
    const t = toks[j]
    if (isPunct(t, '(')) {
      if (opensScope(toks, j)) {
        // A subquery: its own tables are read where they are. Its alias is a name in this scope.
        const [alias, k] = aliasAt(match[j]! + 1)
        refs.push({ name: '', alias, scope: t!.scope, at: j, kind, join })
        return k
      }
      // A parenthesized join: refused by checkPinned, but its tables are read so ledgerTableIn sees them.
      parenthesized.push(j)
      readFromList(j + 1, kind, join)
      return match[j]! + 1
    }
    if (!isName(t)) return j
    let name = t.v
    let k = j + 1
    if (isPunct(toks[k], '.') && isName(toks[k + 1])) {
      name = toks[k + 1]!.v
      k += 2
    }
    // A table-valued function, like json_each(...): no ledger data, but its alias is a name here.
    if (isPunct(toks[k], '(')) {
      const [alias, after] = aliasAt(match[k]! + 1)
      refs.push({ name: '', alias, scope: t.scope, at: j, kind, join })
      return after
    }
    const [alias, after] = aliasAt(k)
    k = after
    if (isWord(toks[k], 'indexed')) k += 3
    else if (isWord(toks[k], 'not') && isWord(toks[k + 1], 'indexed')) k += 2
    refs.push({ name, alias, scope: t.scope, at: j, kind, join })
    return k
  }

  /**
   * Reads a FROM clause's first item at j, then every item after a comma at its depth, up to the
   * clause's end. JOIN items are read where their JOIN is.
   */
  const readFromList = (j: number, kind: Ref['kind'], join: JoinType) => {
    readRef(j, kind, join)
    const d = toks[j]?.depth ?? 0
    for (let k = j; k < toks.length; k++) {
      const t = toks[k]!
      if (t.depth < d || isPunct(t, ';')) break
      if (t.depth > d) continue
      if (t.type === 'word' && FROM_END.has(t.v)) break
      if (isWord(t, 'on') && isWord(toks[k + 1], 'conflict')) break
      if (isPunct(t, ',')) readRef(k + 1, 'from', 'inner')
    }
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (isWord(t, 'from')) {
      // IS [NOT] DISTINCT FROM compares; it doesn't name a table.
      if (isWord(toks[i - 1], 'distinct') && isWord(toks[i - 2], 'is', 'not')) continue
      readFromList(i + 1, isWord(toks[i - 1], 'delete') ? 'delete' : 'from', 'inner')
    } else if (isWord(t, 'join')) {
      const side = isWord(toks[i - 1], 'outer') ? toks[i - 2] : toks[i - 1]
      const join: JoinType = isWord(side, 'left') ? 'left' : isWord(side, 'right') ? 'right' : isWord(side, 'full') ? 'full' : 'inner'
      readRef(i + 1, 'join', join)
    } else if (isWord(t, 'update') && !isWord(toks[i - 1], 'do', 'of', 'before', 'after', 'instead', 'for')) {
      let k = i + 1
      const orReplace = isWord(toks[k], 'or') && isWord(toks[k + 1], 'replace')
      if (isWord(toks[k], 'or')) k += 2
      const before = refs.length
      readRef(k, 'update', 'inner')
      if (orReplace && refs.length > before) refs[refs.length - 1]!.orReplace = true
    } else if (isWord(t, 'into') && (isWord(toks[i - 1], 'insert', 'replace') || isWord(toks[i - 2], 'or'))) {
      const nameTok = toks[i + 1]
      if (!isName(nameTok)) continue
      let k = i + 2
      let name = nameTok.v
      if (isPunct(toks[k], '.') && isName(toks[k + 1])) {
        name = toks[k + 1]!.v
        k += 2
      }
      if (isWord(toks[k], 'as')) k += 2
      let columns: string[] | null = null
      if (isPunct(toks[k], '(')) {
        columns = []
        for (let c = k + 1; c < match[k]!; c++) if (toks[c]!.type === 'word' || toks[c]!.type === 'ident') columns.push(toks[c]!.v)
        k = match[k]! + 1
      }
      inserts.push({ name, at: i + 1, columns, after: k, orReplace: isWord(toks[i - 1], 'replace') })
    }
  }
  return { toks, match, scopes, refs, inserts, parenthesized }
}

/** Every table or view a statement reads or writes. */
export function referencedTables(sql: string): string[] {
  const p = parse(sql)
  return [...new Set([...p.refs.map((r) => r.name).filter((n) => n !== ''), ...p.inserts.map((r) => r.name)])]
}

/** Whether the statement binds @ledger. */
export function usesLedgerParam(sql: string): boolean {
  return tokenize(sql).some(isLedgerParam)
}

const CLAUSE_END = new Set([
  'and',
  'group',
  'order',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'join',
  'left',
  'right',
  'inner',
  'cross',
  'full',
  'natural',
  'where',
  'returning',
  'window',
  'having',
  'on',
  'do',
])

/**
 * Whether toks[start..end] is a conjunct of a WHERE or ON clause: joined to the rest of it by AND
 * only. Returns the ON keyword's index when it's in an ON clause, -1 in a WHERE clause, or null.
 * HAVING doesn't count: a bare column there takes its value from any one row of the group, so it
 * doesn't keep other ledgers' rows out of the group's sums.
 */
function conjunctOf(p: Parsed, start: number, end: number): number | null {
  const { toks, match } = p
  const d = toks[start]!.depth
  const before = toks[start - 1]
  const after = toks[end + 1]
  if (!(isWord(before, 'where', 'on', 'and') || isPunct(before, '('))) return null
  if (!(after === undefined || isPunct(after, ')', ';', ',') || (after.type === 'word' && CLAUSE_END.has(after.v)))) return null
  // To the right: nothing but more conjuncts up to the clause's end (a CASE among them is one).
  for (let k = end + 1, cases = 0; k < toks.length; k++) {
    const t = toks[k]!
    if (t.depth < d || isPunct(t, ';')) break
    if (t.depth > d) continue
    if (isWord(t, 'case')) cases++
    else if (isWord(t, 'end') && cases > 0) cases--
    if (cases > 0 || isWord(t, 'end')) continue
    if (isWord(t, 'or', 'when', 'then', 'else')) return null
    if (t.type === 'word' && CLAUSE_END.has(t.v) && t.v !== 'and') break
    if (isPunct(t, ',')) break
  }
  // To the left, up to the WHERE or ON it's in.
  let cases = 0
  for (let k = start - 1; k >= 0; k--) {
    const t = toks[k]!
    if (t.depth < d) {
      // The opening parenthesis of an expression group: the group must be a conjunct itself.
      if (!isPunct(t, '(') || match[k]! < 0) return null
      const fn = toks[k - 1]
      if (isName(fn) || isWord(fn, 'not', 'exists', 'in', 'when', 'then', 'else', 'case')) return null
      return conjunctOf(p, k, match[k]!)
    }
    if (t.depth > d) continue
    if (isWord(t, 'end')) cases++
    else if (isWord(t, 'case')) {
      if (cases === 0) return null
      cases--
    } else if (cases > 0) continue
    else if (isWord(t, 'where')) return -1
    else if (isWord(t, 'on')) return k
    else if (isWord(t, 'or', 'when', 'then', 'else', 'select', 'set', 'values', 'from', 'by', 'having', 'returning', 'limit', 'using') || isPunct(t, ',')) return null
  }
  return null
}

/** The reference an alias (or, with null, an unqualified ledger_id) means at a scope. */
function resolve(p: Parsed, qualifier: string | null, scope: number): Ref | null {
  for (let s = scope; s >= 0; s = p.scopes[s]!.parent) {
    const here = p.refs.filter((r) => r.scope === s)
    if (qualifier) {
      const found = here.find((r) => (r.alias ?? r.name) === qualifier)
      if (found) return found
    } else {
      const ledgerRefs = here.filter((r) => PINNED_NAMES.has(r.name))
      if (ledgerRefs.length === 1) return ledgerRefs[0]!
      if (ledgerRefs.length > 1) return null
    }
  }
  return null
}

interface Col {
  qualifier: string | null
  column: string
  start: number
  end: number
}

const isColumnName = (t: Tok | undefined): t is Tok => !!t && (t.type === 'ident' || (t.type === 'word' && !KEYWORDS.has(t.v)))

/** A column at i, `q.col` or `col`; null when it isn't one (a function call, a schema-qualified name). */
function colAt(p: Parsed, i: number): Col | null {
  const { toks } = p
  const t = toks[i]
  if (!t || (t.type !== 'word' && t.type !== 'ident') || isPunct(toks[i - 1], '.')) return null
  if (isPunct(toks[i + 1], '.')) {
    if (!isColumnName(toks[i + 2]) || isPunct(toks[i + 3], '.', '(')) return null
    return { qualifier: t.v, column: toks[i + 2]!.v, start: i, end: i + 2 }
  }
  if (!isColumnName(t) || isPunct(toks[i + 1], '(')) return null
  return { qualifier: null, column: t.v, start: i, end: i }
}

const describe = (r: Ref) => `${r.name}${r.alias && r.alias !== r.name ? ` AS ${r.alias}` : ''}`

/** The tables and views a child table's parent column can be joined to: the table, or the view its reads go through. */
const PARENT_VIEWS: Record<string, readonly string[]> = {
  accounts: ['ledger_accounts'],
  categories: ['categories', 'ledger_categories'],
  labels: ['labels', 'ledger_labels'],
  transactions: ['transactions', 'transaction_lines'],
}
const parentNames = (table: string) => PARENT_VIEWS[table] ?? [table]

/** One `x = y` a statement has, with `y` either a column or @ledger. */
interface Equality {
  left: Col
  right: Col | 'ledger'
  start: number
  end: number
}

function equalities(p: Parsed): Equality[] {
  const { toks } = p
  const out: Equality[] = []
  for (let i = 0; i < toks.length; i++) {
    if (isLedgerParam(toks[i]) && isPunct(toks[i + 1], '=', '==')) {
      // @ledger = [q.]col
      const right = colAt(p, i + 2)
      if (right) {
        out.push({ left: right, right: 'ledger', start: i, end: right.end })
        i = right.end
      }
      continue
    }
    const left = colAt(p, i)
    if (!left || !isPunct(toks[left.end + 1], '=', '==')) continue
    const rhsAt = left.end + 2
    if (isLedgerParam(toks[rhsAt])) out.push({ left, right: 'ledger', start: left.start, end: rhsAt })
    else {
      const right = colAt(p, rhsAt)
      if (right) out.push({ left, right, start: left.start, end: right.end })
    }
    i = left.end
  }
  return out
}

/**
 * Throws a LedgerScopeError when the statement reads or writes ledger rows without being pinned to
 * the handle's ledger (the rules are at the top of this file).
 */
export function checkPinned(sql: string): void {
  const p = parse(sql)
  const { toks, refs } = p
  const at = (i: number) => `at char ${toks[i]?.pos ?? 0}`

  if (!isWord(toks[0], 'select', 'insert', 'update', 'delete', 'replace', 'with', 'values')) {
    throw new LedgerScopeError(`The ledger handle runs only SELECT, INSERT, UPDATE and DELETE statements, not ${toks[0]?.v.toUpperCase() || 'an empty one'}`)
  }
  if (p.parenthesized.length > 0) {
    throw new LedgerScopeError(`A parenthesized join (${at(p.parenthesized[0]!)}) isn't checked for pins: write its tables without the parentheses`)
  }
  for (const r of refs) {
    if (r.name === 'accounts' && r.kind !== 'update' && r.kind !== 'delete') {
      throw new LedgerScopeError(`${describe(r)} is read from the accounts table (${at(r.at)}): read accounts through the ledger_accounts view`)
    }
    if (r.orReplace && (PINNED_NAMES.has(r.name) || r.name === 'ledgers')) {
      // REPLACE deletes the row it conflicts with, which could be another ledger's.
      throw new LedgerScopeError(`UPDATE OR REPLACE ${r.name} (${at(r.at)}) could delete another ledger's row: use a plain UPDATE`)
    }
  }

  /** The ref a column means, for a scope (an unqualified name other than ledger_id only when the scope has one table). */
  const refOf = (col: Col, scope: number): Ref | null => {
    if (col.qualifier) return resolve(p, col.qualifier, scope)
    if (col.column === 'ledger_id') return resolve(p, null, scope)
    const here = refs.filter((r) => r.scope === scope)
    return here.length === 1 ? here[0]! : null
  }

  /**
   * Whether a conjunct can pin a ref: the ref must be in the conjunct's own scope (a pin in a
   * subquery doesn't filter the outer rows), and before the ON when it's in one. In an ON clause
   * that depends on the join: an inner join's pins every table before it, a LEFT JOIN's only the
   * table it joins, a RIGHT JOIN's only the tables before it (it keeps every row of the joined
   * one), a FULL JOIN's none.
   */
  const pinnable = (target: Ref, scope: number, on: number) => {
    if (target.scope !== scope) return false
    if (on < 0) return true
    if (target.at > on) return false
    const joined = refs.filter((r) => r.scope === toks[on]!.scope && r.at < on).at(-1)
    if (!joined) return false
    if (joined.join === 'left') return joined === target
    if (joined.join === 'right') return joined !== target
    if (joined.join === 'full') return false
    return true
  }

  const eqs = equalities(p).map((e) => ({ ...e, scope: toks[e.start]!.scope, on: conjunctOf(p, e.start, e.end) }))

  // P1: pins and links between ledger_id columns.
  const pinned = new Set<Ref>()
  const ledgerRows = new Set<Ref>()
  const edges: Array<{ from: Ref; to: Ref }> = []
  for (const e of eqs) {
    if (e.on === null) continue
    if (e.right === 'ledger') {
      const target = refOf(e.left, e.scope)
      if (!target || !pinnable(target, e.scope, e.on)) continue
      if (e.left.column === 'ledger_id') pinned.add(target)
      else if (e.left.column === 'id' && target.name === 'ledgers') ledgerRows.add(target)
    } else if (e.left.column === 'ledger_id' && e.right.column === 'ledger_id') {
      const target = refOf(e.left, e.scope)
      const other = refOf(e.right, e.scope)
      if (!target || !other) continue
      // An edge pins a ref in this scope from a pinned one in this or an enclosing scope, never the other way.
      if (pinnable(target, e.scope, e.on)) edges.push({ from: other, to: target })
      if (pinnable(other, e.scope, e.on)) edges.push({ from: target, to: other })
    }
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const e of edges) {
      if (pinned.has(e.from) && !pinned.has(e.to)) {
        pinned.add(e.to)
        grew = true
      }
    }
  }

  for (const r of refs) {
    if (PINNED_NAMES.has(r.name) && !pinned.has(r)) {
      throw new LedgerScopeError(`${describe(r)} has no ledger pin (${at(r.at)}): add ${r.alias ?? r.name}.ledger_id = @ledger`)
    }
    if (r.name === 'ledgers' && (r.kind === 'update' || r.kind === 'delete') && !ledgerRows.has(r)) {
      throw new LedgerScopeError(`A write to ledgers through the ledger handle (${at(r.at)}) must be pinned with id = @ledger`)
    }
  }

  // P2: a child table is pinned by its parent column, joined to a pinned parent's id.
  const childOf = (col: Col, scope: number): { ref: Ref; parent: string } | null => {
    let ref: Ref | null
    if (col.qualifier) ref = resolve(p, col.qualifier, scope)
    else {
      const here = refs.filter((r) => r.scope === scope && tableDef(r.name)?.parents?.some((x) => x.column === col.column))
      ref = here.length === 1 ? here[0]! : null
    }
    const parent = ref && tableDef(ref.name)?.parents?.find((x) => x.column === col.column)
    return ref && parent ? { ref, parent: parent.table } : null
  }
  const childPinned = new Set<Ref>()
  for (const e of eqs) {
    if (e.on === null || e.right === 'ledger') continue
    for (const [c, q] of [
      [e.left, e.right],
      [e.right, e.left],
    ] as const) {
      const child = childOf(c, e.scope)
      if (!child || !pinnable(child.ref, e.scope, e.on)) continue
      const parent = q.qualifier && q.column === 'id' ? resolve(p, q.qualifier, e.scope) : null
      if (parent && pinned.has(parent) && parentNames(child.parent).includes(parent.name)) childPinned.add(child.ref)
    }
  }
  // Or `child.col IN (SELECT id FROM parent WHERE parent.ledger_id = @ledger ...)`.
  for (let i = 0; i < toks.length; i++) {
    const c = colAt(p, i)
    if (!c || !isWord(toks[c.end + 1], 'in') || !opensScope(toks, c.end + 2) || !isWord(toks[c.end + 3], 'select')) continue
    const open = c.end + 2
    const close = p.match[open]!
    const scope = toks[i]!.scope
    const on = conjunctOf(p, c.start, close)
    const child = childOf(c, scope)
    if (on === null || !child || !pinnable(child.ref, scope, on)) continue
    const inner = toks[open + 1]!.scope
    const d = toks[open + 1]!.depth
    let listEnd = open + 2
    let compound = false
    for (let k = open + 2; k < close; k++) {
      if (toks[k]!.depth === d && isWord(toks[k], 'union', 'intersect', 'except')) compound = true
    }
    while (listEnd < close && !(toks[listEnd]!.depth === d && isWord(toks[listEnd], 'from'))) listEnd++
    let first = open + 2
    if (isWord(toks[first], 'distinct', 'all')) first++
    const item = nthItem(p, first, listEnd, 0)
    const col = item && colAt(p, first)
    if (compound || !col || col.column !== 'id' || col.end - col.start + 1 !== item.length) continue
    const parent = refOf(col, inner)
    if (parent && parent.scope === inner && pinned.has(parent) && parentNames(child.parent).includes(parent.name)) childPinned.add(child.ref)
  }
  for (const r of refs) {
    const parents = tableDef(r.name)?.parents
    if (CHILD_NAMES.has(r.name) && parents && !childPinned.has(r)) {
      const how = parents.map((x) => `${r.alias ?? r.name}.${x.column} to the id of a pinned ${x.table}`).join(', or ')
      throw new LedgerScopeError(`${describe(r)} has no ledger pin (${at(r.at)}): match ${how}`)
    }
  }

  for (const ins of p.inserts) {
    const where = `INSERT INTO ${ins.name} (${at(ins.at)})`
    if (ins.name === 'ledgers') throw new LedgerScopeError(`${where}: ledgers are added by the registry, not a ledger handle`)
    if (!PINNED_NAMES.has(ins.name)) continue
    if (ins.orReplace) throw new LedgerScopeError(`${where} OR REPLACE could delete another ledger's row: use ON CONFLICT DO UPDATE`)
    const k = ins.columns?.indexOf('ledger_id') ?? -1
    if (k < 0) throw new LedgerScopeError(`${where} must set ledger_id to @ledger`)
    const source = toks[ins.after]
    const d = source?.depth ?? 0
    /** The next compound operator after j at the source's depth, or -1. */
    const nextBranch = (j: number) => {
      for (let k = j; k < toks.length; k++) {
        const t = toks[k]!
        if (t.depth < d || isPunct(t, ';') || isWord(t, 'returning') || (isWord(t, 'on') && isWord(toks[k + 1], 'conflict'))) return -1
        if (t.depth === d && isWord(t, 'union', 'intersect', 'except')) return k
      }
      return -1
    }
    if (isWord(source, 'values')) {
      let j = ins.after + 1
      for (; isPunct(toks[j], '('); ) {
        const value = nthItem(p, j + 1, p.match[j]!, k)
        if (!(value && value.length === 1 && isLedgerParam(value[0]))) throw new LedgerScopeError(`${where} must set ledger_id to @ledger`)
        j = p.match[j]! + 1
        if (!isPunct(toks[j], ',')) break
        j++
      }
      if (nextBranch(j) >= 0) throw new LedgerScopeError(`${where} must set ledger_id to @ledger in every row: a compound VALUES isn't checked`)
    } else if (isWord(source, 'select')) {
      // Every branch of a compound SELECT gives its own ledger_id.
      for (let branch = ins.after; branch >= 0; ) {
        let end = branch + 1
        while (end < toks.length) {
          const t = toks[end]!
          if (t.depth < d || isPunct(t, ';')) break
          if (t.depth === d && (isWord(t, 'from', 'where', 'group', 'having', 'window', 'order', 'limit', 'union', 'intersect', 'except', 'returning') || (isWord(t, 'on') && isWord(toks[end + 1], 'conflict')))) break
          end++
        }
        let first = branch + 1
        if (isWord(toks[first], 'distinct', 'all')) first++
        const value = nthItem(p, first, end, k)
        const ok =
          value &&
          ((value.length === 1 && isLedgerParam(value[0])) ||
            (() => {
              if (value.length === 0) return false
              const col = colAt(p, toks.indexOf(value[0]!))
              if (!col || col.column !== 'ledger_id' || col.end - col.start + 1 !== value.length) return false
              const ref = resolve(p, col.qualifier, value[0]!.scope)
              return !!ref && pinned.has(ref)
            })())
        if (!ok) throw new LedgerScopeError(`${where} must take ledger_id from @ledger or a pinned ledger_id`)
        const op = nextBranch(end)
        if (op < 0) break
        branch = isWord(toks[op + 1], 'all') ? op + 2 : op + 1
        if (!isWord(toks[branch], 'select')) throw new LedgerScopeError(`${where} must take ledger_id from @ledger or a pinned ledger_id in every branch`)
      }
    } else {
      throw new LedgerScopeError(`${where} must set ledger_id to @ledger`)
    }
  }
}

/** The tokens of the n-th comma-separated item between from (inclusive) and to (exclusive), at from's depth. */
function nthItem(p: Parsed, from: number, to: number, n: number): Tok[] | null {
  const d = p.toks[from]?.depth
  let item = 0
  const out: Tok[] = []
  for (let j = from; j < to; j++) {
    const t = p.toks[j]!
    if (t.depth === d && isPunct(t, ',')) {
      if (item === n) return out
      item++
      continue
    }
    if (item === n) out.push(t)
  }
  return item === n ? out : null
}

/** The first table or view of ledger data (a ledger, catalog or child table) a statement names, or null. */
export function ledgerTableIn(sql: string): string | null {
  return referencedTables(sql).find((t) => PINNED_NAMES.has(t) || CHILD_NAMES.has(t)) ?? null
}
