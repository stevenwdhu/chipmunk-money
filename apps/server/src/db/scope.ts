import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { notFound } from '../lib/http'
import type { DB, SQLite } from './client'
import { checkPinned, ledgerTableIn, LedgerScopeError, usesLedgerParam } from './pins'
import * as schema from './schema'
import { TABLES } from './tables'
import type { UnscopedReason } from './unscoped-sites'

export { checkPinned, LedgerScopeError } from './pins'

/**
 * Keeping each ledger's queries to its own rows, two ways:
 * - The ledger handle (LedgerQuery, ctx.q) checks every statement for a ledger pin before preparing
 *   it (pins.ts) and binds @ledger itself, so the SQL says which ledger it reads.
 * - Write guards: TEMP triggers on every table with ledger data abort a write to a row outside the
 *   write scope, which the handle sets to its ledger around each call. Outside a handle the scope
 *   is empty, so a raw write to ledger data aborts too. They fire for rows changed by the content
 *   triggers and by foreign key actions as well. Two scopes span two ledgers: a move's (ledgerMove),
 *   which lets through only a transaction changing from one to the other, and a home change's
 *   (twoLedgers), which lets through only the account tables of the two. Each is called at one
 *   place only, in move-rows.ts (scope.test.ts checks it).
 * better-sqlite3 is synchronous, so nothing else runs on the connection while a scope is set.
 */

/** A move's write scope: only a transaction of `from` becoming one of `to` (moveRows in move-rows.ts). */
interface MoveScope {
  readonly from: string
  readonly to: string
}

/** A home change's write scope: these tables' rows of these ledgers only (changeHome in move-rows.ts). */
interface TablesScope {
  readonly ledgers: ReadonlySet<string>
  readonly tables: ReadonlySet<string>
}

type ScopeValue = 'all' | ReadonlySet<string> | MoveScope | TablesScope | null

const isMove = (scope: ScopeValue): scope is MoveScope => !!scope && scope !== 'all' && 'from' in scope
const isTables = (scope: ScopeValue): scope is TablesScope => !!scope && scope !== 'all' && 'tables' in scope

/**
 * What a home change writes: the account (its home, institution, sort, archive and opening ledger),
 * the member rows, and the bank payloads that let go of rows. bank_payloads is a child of accounts,
 * checked against the account's ledger.
 */
const HOME_CHANGE_TABLES: ReadonlySet<string> = new Set(['accounts', 'account_ledgers', 'bank_payloads'])

interface Prepared {
  stmt: Database.Statement
  usesLedger: boolean
}

interface ConnectionState {
  scope: ScopeValue
  /** The handle's statements, by SQL text, least recently used first. */
  statements: Map<string, Prepared>
}

const states = new WeakMap<SQLite, ConnectionState>()

/** How many prepared statements the handle keeps per connection. */
const STATEMENT_CACHE_SIZE = 2000

function stateOf(sqlite: SQLite): ConnectionState {
  const state = states.get(sqlite)
  if (!state) throw new Error('This connection has no write guards: open it with openDatabase')
  return state
}

const OUTSIDE = "SELECT RAISE(ABORT, 'write outside the ledger scope')"

/** The one table whose rows change ledger: a transaction moving between ledgers that have its account. */
const MOVES = 'transactions'

/**
 * Adds the write guards to a connection, after its migrations: the functions they call, and a TEMP
 * trigger per table and change (TEMP, so they live on this connection only and aren't in the file).
 */
export function installWriteGuards(sqlite: SQLite) {
  // Without it a REPLACE deletes the conflicting row with no DELETE trigger, so with no guard.
  if (sqlite.pragma('recursive_triggers', { simple: true }) !== 1) throw new Error('The write guards need PRAGMA recursive_triggers = ON')
  const state: ConnectionState = { scope: null, statements: new Map() }
  states.set(sqlite, state)
  // Whether a row of this ledger, in this table, may be written. A null ledger (the shared category
  // list, an app-wide AI call) only with every ledger in scope.
  sqlite.function('chipmunk_in_scope', { deterministic: false }, (ledgerId: unknown, table: unknown) => {
    const scope = state.scope
    if (scope === 'all') return 1
    if (!scope || isMove(scope) || ledgerId === null) return 0
    if (isTables(scope)) return scope.tables.has(String(table)) && scope.ledgers.has(String(ledgerId)) ? 1 : 0
    return scope.has(String(ledgerId)) ? 1 : 0
  })
  // Whether rows of this table may be written at all (a child table's, whose ledger is its parent's).
  sqlite.function('chipmunk_scope_open', { deterministic: false }, (table: unknown) => {
    const scope = state.scope
    if (scope === 'all') return 1
    if (!scope || isMove(scope)) return 0
    if (isTables(scope)) return scope.tables.has(String(table)) ? 1 : 0
    return scope.size > 0 ? 1 : 0
  })
  // Whether a row's change of ledger is the move in scope: from its `from` to its `to`, nothing else.
  sqlite.function('chipmunk_moving', { deterministic: false }, (oldLedger: unknown, newLedger: unknown) => {
    const scope = state.scope
    if (!isMove(scope)) return 0
    return oldLedger === scope.from && newLedger === scope.to ? 1 : 0
  })

  const triggers: string[] = []
  const trigger = (table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', when: string) =>
    triggers.push(`CREATE TEMP TRIGGER "scope_${table}_${event.toLowerCase()}" BEFORE ${event} ON main."${table}" WHEN ${when} BEGIN ${OUTSIDE}; END`)
  for (const t of TABLES) {
    if (t.kind === 'ledger' || t.kind === 'catalog') {
      // A row with no ledger in a table that needs one: its NOT NULL says so more plainly.
      const required = t.kind === 'ledger' && t.name !== 'ai_calls'
      const inScope = (row: 'NEW' | 'OLD') => `chipmunk_in_scope(${row}.ledger_id, '${t.name}')`
      trigger(t.name, 'INSERT', required ? `NEW.ledger_id IS NOT NULL AND NOT ${inScope('NEW')}` : `NOT ${inScope('NEW')}`)
      const outside = `NOT ${inScope('OLD')} OR NOT ${inScope('NEW')}`
      trigger(t.name, 'UPDATE', t.name === MOVES ? `NOT chipmunk_moving(OLD.ledger_id, NEW.ledger_id) AND (${outside})` : outside)
      trigger(t.name, 'DELETE', `NOT ${inScope('OLD')}`)
    } else if (t.kind === 'child') {
      // In the ledger of its parent rows. A parent that's gone (being deleted, or not inserted yet)
      // doesn't stop it: that parent's own guard, or its foreign key, covers it.
      const outside = (row: 'NEW' | 'OLD') =>
        t
          .parents!.map((p) => `EXISTS (SELECT 1 FROM main."${p.table}" p WHERE p.id = ${row}."${p.column}" AND NOT chipmunk_in_scope(p.ledger_id, '${t.name}'))`)
          .join(' OR ')
      const open = `chipmunk_scope_open('${t.name}')`
      trigger(t.name, 'INSERT', `NOT ${open} OR ${outside('NEW')}`)
      trigger(t.name, 'UPDATE', `NOT ${open} OR ${outside('OLD')} OR ${outside('NEW')}`)
      trigger(t.name, 'DELETE', `NOT ${open} OR ${outside('OLD')}`)
    }
  }
  sqlite.exec(triggers.join(';\n'))
}

function isThenable(value: unknown): boolean {
  return !!value && typeof (value as { then?: unknown }).then === 'function'
}

function withScope<T>(sqlite: SQLite, scope: ScopeValue, fn: () => T): T {
  const state = stateOf(sqlite)
  const previous = state.scope
  state.scope = scope
  try {
    const result = fn()
    // The scope ends when fn returns, so work it leaves for later would run without one.
    if (isThenable(result)) throw new Error('Work in a ledger scope must be synchronous')
    return result
  } finally {
    state.scope = previous
  }
}

/**
 * Runs fn with one ledger's rows writable and no pin checker: for maintenance that works on all
 * of a ledger's rows at once (deleting it, erasing it, clearing it for the demo). The write
 * guards stay on, so nothing it does reaches another ledger.
 */
export function ledgerMaintenance<T>(sqlite: SQLite, ledgerId: string, fn: () => T): T {
  return withScope(sqlite, new Set([ledgerId]), fn)
}

/**
 * Runs fn with one kind of write allowed: a transaction of ledger `from` becoming one of ledger `to`
 * (an UPDATE whose old ledger is `from` and new ledger is `to`). Nothing else of either ledger, or
 * of any other, can be written in it: no insert or delete, no update within one ledger or the other
 * way, and no child row. For moveRows (move-rows.ts), the one place a transaction changes ledger.
 */
export function ledgerMove<T>(sqlite: SQLite, move: { from: string; to: string }, fn: () => T): T {
  if (move.from === move.to) throw new Error('A move is between two ledgers')
  return withScope(sqlite, { from: move.from, to: move.to }, fn)
}

/**
 * Runs fn with no pin checker and only the account tables of two ledgers writable (accounts,
 * account_ledgers, and bank_payloads, by their account): for changeHome (move-rows.ts), whose
 * statements write an account and its member rows in both the old home and the new one, and the
 * payloads that let go of rows. Nothing else of either ledger, no transaction, import batch or
 * recurring item, and nothing of a third ledger can be written in it.
 */
export function twoLedgers<T>(sqlite: SQLite, ledgers: { from: string; to: string }, fn: () => T): T {
  if (ledgers.from === ledgers.to) throw new Error('Two ledgers, not one')
  return withScope(sqlite, { ledgers: new Set([ledgers.from, ledgers.to]), tables: HOME_CHANGE_TABLES }, fn)
}

type Row = Record<string, unknown>

/**
 * Statements with every ledger in scope (what allLedgers hands its callback): the same calls as
 * the ledger handle, with no pin checker and no @ledger.
 */
export class UnscopedQuery {
  constructor(private readonly sqlite: SQLite) {}

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[]
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined
  }

  /** The first column of the first row. */
  pluck<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return this.sqlite.prepare(sql).pluck().get(...params) as T | undefined
  }

  /** The first column of every row. */
  column<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.sqlite.prepare(sql).pluck().all(...params) as T[]
  }

  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.sqlite.prepare(sql).run(...params)
  }

  /** Runs fn in a transaction (a savepoint when one is open). */
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)()
  }
}

/**
 * Runs fn with every ledger in scope and no pin checker. Each call site is listed, with why, in
 * unscoped-sites.ts (the reason is one of its keys).
 */
export function allLedgers<T>(sqlite: SQLite, reason: UnscopedReason, fn: (db: UnscopedQuery) => T): T {
  void reason
  return withScope(sqlite, 'all', () => fn(new UnscopedQuery(sqlite)))
}


const isNamedParams = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

/**
 * One ledger's way to the database (ctx.q). Every statement is checked for a ledger pin when it's
 * first prepared, and @ledger is bound to this ledger: merged into the named parameters, or added
 * after positional ones. Passing `ledger` yourself is refused, so a caller can't point a pinned
 * statement at another ledger. Writes run with this ledger as the write scope.
 *
 * There's no exec or iterate, and the checker lets through only SELECT, INSERT, UPDATE and DELETE
 * (no DDL, PRAGMA or ATTACH, which could drop the guards): maintenance that needs more uses
 * ledgerMaintenance.
 */
export class LedgerQuery {
  private readonly scope: ReadonlySet<string>

  constructor(
    private readonly sqlite: SQLite,
    readonly ledgerId: string,
  ) {
    stateOf(sqlite)
    this.scope = new Set([ledgerId])
  }

  private prepared(sql: string): Prepared {
    const cache = stateOf(this.sqlite).statements
    let p = cache.get(sql)
    if (p) {
      cache.delete(sql)
      cache.set(sql, p)
      return p
    }
    checkPinned(sql)
    p = { stmt: this.sqlite.prepare(sql), usesLedger: usesLedgerParam(sql) }
    cache.set(sql, p)
    if (cache.size > STATEMENT_CACHE_SIZE) cache.delete(cache.keys().next().value!)
    return p
  }

  private bind(p: Prepared, params: unknown[]): unknown[] {
    const named = params.findIndex(isNamedParams)
    if (named >= 0) {
      const values = params[named] as Record<string, unknown>
      if ('ledger' in values) throw new LedgerScopeError("Don't pass a `ledger` parameter: the ledger handle binds @ledger itself")
      if (!p.usesLedger) return params
      const out = params.slice()
      out[named] = { ...values, ledger: this.ledgerId }
      return out
    }
    return p.usesLedger ? [...params, { ledger: this.ledgerId }] : params
  }

  private call<T>(sql: string, params: unknown[], run: (stmt: Database.Statement, args: unknown[]) => T): T {
    const p = this.prepared(sql)
    const args = this.bind(p, params)
    return withScope(this.sqlite, this.scope, () => run(p.stmt, args))
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.call(sql, params, (s, a) => s.all(...a) as T[])
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.call(sql, params, (s, a) => s.get(...a) as T | undefined)
  }

  /** The first column of the first row. */
  pluck<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return this.call(sql, params, (s, a) => {
      s.pluck(true)
      try {
        return s.get(...a) as T | undefined
      } finally {
        s.pluck(false)
      }
    })
  }

  /** The first column of every row. */
  column<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.call(sql, params, (s, a) => {
      s.pluck(true)
      try {
        return s.all(...a) as T[]
      } finally {
        s.pluck(false)
      }
    })
  }

  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.call(sql, params, (s, a) => s.run(...a))
  }

  /** The first row, or a 404 with this message when there's none. */
  mustGet<T = Row>(sql: string, notFoundMessage: string, ...params: unknown[]): T {
    const row = this.get<T>(sql, ...params)
    if (row === undefined) notFound(notFoundMessage)
    return row
  }

  /** Runs fn in a transaction (a savepoint when one is open), in this ledger's write scope. */
  transaction<T>(fn: () => T): T {
    return withScope(this.sqlite, this.scope, () => this.sqlite.transaction(fn)())
  }
}

/**
 * The drizzle connection for app-wide tables (ctx.app.db): refuses any generated SQL that names a
 * table or view of ledger data, which goes through ctx.q instead.
 */
export function appOnlyConnection(sqlite: SQLite): SQLite {
  const ok = new Set<string>()
  return new Proxy(sqlite, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (source: string) => {
          if (!ok.has(source)) {
            const table = ledgerTableIn(source)
            if (table) throw new LedgerScopeError(`${table} holds ledger data: use the ledger handle (ctx.q), not the app-wide database`)
            if (ok.size < STATEMENT_CACHE_SIZE) ok.add(source)
          }
          return target.prepare(source)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Drizzle over the app-wide tables (ctx.app.db), on appOnlyConnection. */
export function appDatabase(sqlite: SQLite): DB {
  return drizzle(appOnlyConnection(sqlite), { schema })
}
