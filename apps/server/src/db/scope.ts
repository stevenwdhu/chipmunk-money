import type Database from 'better-sqlite3'
import { notFound } from '../lib/http'
import type { SQLite } from './client'
import { checkPinned, ledgerTableIn, LedgerScopeError, usesLedgerParam } from './pins'
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
 *   triggers and by foreign key actions as well.
 * better-sqlite3 is synchronous, so nothing else runs on the connection while a scope is set.
 */

type ScopeValue = 'all' | ReadonlySet<string> | null

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

/**
 * Adds the write guards to a connection, after its migrations: the functions they call, and a TEMP
 * trigger per table and change (TEMP, so they live on this connection only and aren't in the file).
 */
export function installWriteGuards(sqlite: SQLite) {
  // Without it a REPLACE deletes the conflicting row with no DELETE trigger, so with no guard.
  if (sqlite.pragma('recursive_triggers', { simple: true }) !== 1) throw new Error('The write guards need PRAGMA recursive_triggers = ON')
  const state: ConnectionState = { scope: null, statements: new Map() }
  states.set(sqlite, state)
  // Whether a row of this ledger may be written. A null ledger (the shared category list, an
  // app-wide AI call) only with every ledger in scope.
  sqlite.function('chipmunk_in_scope', { deterministic: false }, (ledgerId: unknown) => {
    const scope = state.scope
    if (scope === 'all') return 1
    if (!scope || ledgerId === null) return 0
    return scope.has(String(ledgerId)) ? 1 : 0
  })
  sqlite.function('chipmunk_scope_open', { deterministic: false }, () => (state.scope === 'all' || (state.scope?.size ?? 0) > 0 ? 1 : 0))

  const triggers: string[] = []
  const trigger = (table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', when: string) =>
    triggers.push(`CREATE TEMP TRIGGER "scope_${table}_${event.toLowerCase()}" BEFORE ${event} ON main."${table}" WHEN ${when} BEGIN ${OUTSIDE}; END`)
  for (const t of TABLES) {
    if (t.kind === 'ledger' || t.kind === 'catalog') {
      // A row with no ledger in a table that needs one: its NOT NULL says so more plainly.
      const required = t.kind === 'ledger' && t.name !== 'ai_calls'
      trigger(t.name, 'INSERT', required ? 'NEW.ledger_id IS NOT NULL AND NOT chipmunk_in_scope(NEW.ledger_id)' : 'NOT chipmunk_in_scope(NEW.ledger_id)')
      trigger(t.name, 'UPDATE', 'NOT chipmunk_in_scope(OLD.ledger_id) OR NOT chipmunk_in_scope(NEW.ledger_id)')
      trigger(t.name, 'DELETE', 'NOT chipmunk_in_scope(OLD.ledger_id)')
    } else if (t.kind === 'child') {
      // In the ledger of its parent rows. A parent that's gone (being deleted, or not inserted yet)
      // doesn't stop it: that parent's own guard, or its foreign key, covers it.
      const outside = (row: 'NEW' | 'OLD') =>
        t
          .parents!.map((p) => `EXISTS (SELECT 1 FROM main."${p.table}" p WHERE p.id = ${row}."${p.column}" AND NOT chipmunk_in_scope(p.ledger_id))`)
          .join(' OR ')
      trigger(t.name, 'INSERT', `NOT chipmunk_scope_open() OR ${outside('NEW')}`)
      trigger(t.name, 'UPDATE', `NOT chipmunk_scope_open() OR ${outside('OLD')} OR ${outside('NEW')}`)
      trigger(t.name, 'DELETE', `NOT chipmunk_scope_open() OR ${outside('OLD')}`)
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
 * of a ledger's rows at once (deleting it, erasing it, restoring a backup into it). The write
 * guards stay on, so nothing it does reaches another ledger.
 */
export function ledgerMaintenance<T>(sqlite: SQLite, ledgerId: string, fn: () => T): T {
  return withScope(sqlite, new Set([ledgerId]), fn)
}

/**
 * Runs fn with every ledger in scope and no pin checker. Each call site is listed, with why, in
 * unscoped-sites.ts (the reason is one of its keys).
 */
export function allLedgers<T>(sqlite: SQLite, reason: UnscopedReason, fn: (sqlite: SQLite) => T): T {
  void reason
  return withScope(sqlite, 'all', () => fn(sqlite))
}

type Row = Record<string, unknown>

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

/**
 * @deprecated For ctx.sqlite and ctx.db until Stage B converts every use to ctx.q. The one
 * connection, with statements run in one ledger's write scope but not pin checked: writes can't
 * reach another ledger, reads can. serialize() is refused, since it would copy every ledger.
 */
export function scopedConnection(sqlite: SQLite, ledgerId: string): SQLite {
  const scope = new Set([ledgerId])
  const inScope = <T>(fn: () => T) => withScope(sqlite, scope, fn)
  const wrapStatement = (stmt: Database.Statement): Database.Statement => {
    const proxy: Database.Statement = new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const result = inScope(() => (value as (...a: unknown[]) => unknown).apply(target, args))
          return result === target ? proxy : result
        }
      },
    })
    return proxy
  }
  const db: SQLite = new Proxy(sqlite, {
    get(target, prop) {
      if (prop === 'prepare') return (source: string) => wrapStatement(target.prepare(source))
      if (prop === 'exec') {
        return (source: string) => {
          inScope(() => target.exec(source))
          return db
        }
      }
      if (prop === 'serialize') {
        return () => {
          throw new Error("A ledger's backup is its own export now (Stage C), not a copy of the database")
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return db
}
