import {
  payeeKey,
  payeeNamer,
  payeeRegex,
  payeeNameRuleCreateSchema,
  type PayeeNamePreview,
  type PayeeNamePreviewQuery,
  type PayeeNameRule,
  type PayeeNameRuleCreate,
  type PayeeNameRuleSpec,
  type PayeeNameRuleUpdate,
  type PayeeNaming,
  type PayeeRename,
  type PayeeWordingsName,
} from '@chipmunk/shared'
import { badRequest, notFound } from '../lib/http'
import type { Storage } from '../storage'
import { learn } from './categorize'
import type { AppContext, MetaStore } from './context'
import { carryPayeeRefs } from './custom-reports'
import { aiTidyOn, forgetPayeeNamer, loadNameRules, payeeNamerFor, tidiedNames } from './payee-namer'
import { applyPayeeChoices } from './payees'

/** Where payee names apply: the app's rules and AI names (meta.db), and every ledger. */
export interface PayeeWorld {
  meta: MetaStore
  ledgers: () => AppContext[]
}
export const worldOf = (storage: Pick<Storage, 'meta' | 'registry'>): PayeeWorld => ({
  meta: storage.meta,
  ledgers: () => storage.registry.list().map((l) => storage.registry.context(l.id)),
})
/** One ledger as all there is (a test's). */
export const worldOfLedger = (ctx: AppContext): PayeeWorld => ({ meta: ctx.meta, ledgers: () => [ctx] })

/**
 * Your payee name rules (app-wide), and what changing them does: each transaction's payee_key is what
 * the rules make of its payee, kept, and made again in every ledger when they change
 * (rebuildPayeeKeys). A transaction that becomes another payee carries what was set for the old one
 * over (carryPayeeOver).
 */

type RuleInput = ReturnType<typeof payeeNameRuleCreateSchema.parse>

/** A rule as it can be saved: a `same` one names its payee, a regex is one that works. */
function checked(r: RuleInput): RuleInput {
  if (!r.name) badRequest(r.kind === 'same' ? 'Give the payee a name.' : 'Say what it becomes, like $1 for what the first group caught.')
  if (r.kind === 'regex') {
    if (r.patterns.length !== 1) badRequest('A regex rule has one pattern.')
    if (!payeeRegex(r.patterns[0]!)) badRequest(`“${r.patterns[0]}” isn’t a regex that works.`)
    return { ...r, match: null }
  }
  return { ...r, match: r.match ?? 'is' }
}

/** Live payees as sent, in every ledger, and how many transactions have each. */
export function payeesSent(world: PayeeWorld): Map<string, number> {
  const sent = new Map<string, number>()
  for (const ctx of world.ledgers()) {
    for (const { payee, n } of ctx.sqlite.prepare('SELECT payee, count(*) AS n FROM transactions WHERE deleted_at IS NULL GROUP BY payee').all() as Array<{ payee: string; n: number }>) {
      sent.set(payee, (sent.get(payee) ?? 0) + n)
    }
  }
  return sent
}

export function listNameRules(world: PayeeWorld): PayeeNameRule[] {
  const name = payeeNamerFor(world)
  const counts = new Map<number, number>()
  for (const [payee, n] of payeesSent(world)) {
    const id = name(payee).ruleId
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + n)
  }
  const stamps = new Map(
    (world.meta.sqlite.prepare('SELECT id, updated_at AS updatedAt FROM payee_name_rules').all() as Array<{ id: number; updatedAt: string }>).map((r) => [r.id, r.updatedAt]),
  )
  return loadNameRules(world.meta).map((r) => ({ ...r, transactionCount: counts.get(r.id) ?? 0, updatedAt: stamps.get(r.id)! }))
}

const getRule = (world: PayeeWorld, id: number) => {
  const rule = listNameRules(world).find((r) => r.id === id)
  if (!rule) notFound('Payee name rule not found')
  return rule
}

/** After the rules or AI names change: payees named again, and transactions moved, in every ledger, to the payee they now are. */
export function renamed(world: PayeeWorld) {
  forgetPayeeNamer(world.meta)
  return world.ledgers().reduce((n, ctx) => n + rebuildPayeeKeys(ctx).length, 0)
}

export function createNameRule(world: PayeeWorld, input: PayeeNameRuleCreate): { rule: PayeeNameRule; changed: number } {
  const id = createRow(world.meta, checked(payeeNameRuleCreateSchema.parse(input)))
  const count = renamed(world)
  return { rule: getRule(world, id), changed: count }
}

export function updateNameRule(world: PayeeWorld, id: number, input: PayeeNameRuleUpdate): { rule: PayeeNameRule; changed: number } {
  const before = getRule(world, id)
  const r = checked(payeeNameRuleCreateSchema.parse({ ...before, ...input }))
  world.meta.sqlite
    .prepare(
      `UPDATE payee_name_rules SET kind = ?, match = ?, patterns = ?, name = ?, enabled = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .run(r.kind, r.match, JSON.stringify(r.patterns), r.name, r.enabled ? 1 : 0, id)
  const count = renamed(world)
  return { rule: getRule(world, id), changed: count }
}

export function deleteNameRule(world: PayeeWorld, id: number): { changed: number } {
  getRule(world, id)
  world.meta.sqlite.prepare('DELETE FROM payee_name_rules WHERE id = ?').run(id)
  return { changed: renamed(world) }
}

/** All your rules, in the order they apply (the first that names a payee wins). */
export function orderNameRules(world: PayeeWorld, ids: number[]): { changed: number } {
  const all = loadNameRules(world.meta).map((r) => r.id)
  if (ids.length !== all.length || !all.every((id) => ids.includes(id))) badRequest('List every rule once, in the order they apply.')
  const set = world.meta.sqlite.prepare('UPDATE payee_name_rules SET sort = ? WHERE id = ?')
  world.meta.sqlite.transaction(() => ids.forEach((id, i) => set.run(i + 1, id)))()
  return { changed: renamed(world) }
}


/** What payee names a change to the rules would make, before it's saved. */
export function previewNameRules(world: PayeeWorld, q: PayeeNamePreviewQuery): PayeeNamePreview {
  let rules = loadNameRules(world.meta)
  if (q.rule) {
    const { id, ...fields } = q.rule
    const r = checked(payeeNameRuleCreateSchema.parse(fields))
    const spec = { id: id ?? -1, ...r }
    rules = id ? rules.map((x) => (x.id === id ? spec : x)) : [...rules, spec]
  }
  if (q.remove) rules = rules.filter((r) => r.id !== q.remove)
  const now = payeeNamerFor(world)
  const tidied = aiTidyOn(world.meta) ? tidiedNames(world.meta) : null
  const then = payeeNamer(rules, tidied ? (raw) => tidied.get(raw) : undefined)
  const changes = new Map<string, PayeeNamePreview['changes'][number]>()
  for (const [payee, n] of payeesSent(world)) {
    const [from, to] = [now(payee).name, then(payee).name]
    if (from === to) continue
    const c = changes.get(`${from}\u0000${to}`) ?? { from, to, payees: [], transactions: 0 }
    c.transactions += n
    if (c.payees.length < 3) c.payees.push(payee)
    changes.set(`${from}\u0000${to}`, c)
  }
  const list = [...changes.values()].sort((a, b) => b.transactions - a.transactions)
  return { transactions: list.reduce((sum, c) => sum + c.transactions, 0), changes: list.slice(0, 50) }
}

/**
 * Renaming a payee from one of its transactions: a rule for it is made or changed. Rules name payees by
 * their wording as sent, so a new one has every wording that's this payee now (AI tidying may call
 * several the same). The payee your rule names is renamed with every payee it names. A name another
 * rule gives joins that rule: they're one payee. No name: it goes back to what it's called otherwise.
 */
export function renamePayee(world: PayeeWorld, input: PayeeRename): { rule: PayeeNameRule | null; changed: number } {
  const rules = loadNameRules(world.meta)
  const current = payeeNamerFor(world)
  const naming = current(input.payee)
  const own = naming.ruleId !== null ? rules.find((r) => r.id === naming.ruleId) : undefined
  if (own?.kind === 'regex') badRequest('A regex rule names this payee. Change that rule in App settings → Payees.')
  const tidied = aiTidyOn(world.meta) ? tidiedNames(world.meta) : null
  // What it's called without your names, and its wordings: those called the same, no other rule naming them.
  const plain = payeeNamer([], tidied ? (raw) => tidied.get(raw) : undefined)
  const called = plain(input.payee)
  const wordings = [
    ...new Set([input.payee, ...[...payeesSent(world).keys()].filter((p) => plain(p).key === called.key && [null, naming.ruleId].includes(current(p).ruleId))]),
  ]
  /** Its patterns that these wordings fit. */
  const fitting = (r: PayeeNameRuleSpec) => r.patterns.filter((p) => wordings.some((w) => payeeNamer([{ ...r, id: -1, patterns: [p] }])(w).ruleId === -1))
  const write = world.meta.sqlite.prepare(`UPDATE payee_name_rules SET patterns = ?, name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
  const drop = (r: PayeeNameRuleSpec) => {
    const keep = r.patterns.filter((p) => !fitting(r).includes(p))
    if (keep.length) write.run(JSON.stringify(keep), r.name, r.id)
    else world.meta.sqlite.prepare('DELETE FROM payee_name_rules WHERE id = ?').run(r.id)
  }
  const name = input.name?.trim() || null
  let ruleId: number | null = null
  world.meta.sqlite.transaction(() => {
    if (!name) {
      if (own) drop(own)
      return
    }
    const joins = rules.find((r) => r.kind === 'same' && r.id !== own?.id && r.name?.trim().toLowerCase() === name.toLowerCase())
    if (own && !joins) {
      write.run(JSON.stringify(own.patterns), name, own.id)
      ruleId = own.id
    } else if (joins) {
      if (own) drop(own)
      write.run(JSON.stringify([...new Set([...joins.patterns, ...wordings])]), joins.name, joins.id)
      ruleId = joins.id
    } else if (name !== called.name) {
      ruleId = createRow(world.meta, { kind: 'same', match: 'is', patterns: wordings, name, enabled: true })
    }
  })()
  const count = renamed(world)
  return { rule: ruleId ? getRule(world, ruleId) : null, changed: count }
}

/**
 * Naming payees as sent, from the tidied payees: they're called `name`, by one rule of yours (one with
 * that name already, or a new one), and are off your rules that named them by their wording before. A
 * broader rule of yours (starts with, contains) stays as it is. No name: off your rules, they go by
 * what AI tidying called them.
 */
export function nameWordings(world: PayeeWorld, input: PayeeWordingsName): { rule: PayeeNameRule | null; changed: number } {
  const wordings = [...new Set(input.payees.map((p) => p.trim()).filter(Boolean))]
  const name = input.name?.trim() || null
  /** Whether a rule's pattern names any of them. */
  const names = (r: PayeeNameRuleSpec, pattern: string) => wordings.some((w) => payeeNamer([{ ...r, id: -1, patterns: [pattern], enabled: true }])(w).ruleId === -1)
  const write = world.meta.sqlite.prepare(`UPDATE payee_name_rules SET patterns = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
  let ruleId: number | null = null
  world.meta.sqlite.transaction(() => {
    for (const r of loadNameRules(world.meta)) {
      if (r.kind !== 'same' || (r.match ?? 'is') !== 'is') continue
      const keep = r.patterns.filter((p) => !names(r, p))
      if (keep.length === r.patterns.length) continue
      if (keep.length) write.run(JSON.stringify(keep), r.id)
      else world.meta.sqlite.prepare('DELETE FROM payee_name_rules WHERE id = ?').run(r.id)
    }
    if (!name) return
    const joins = loadNameRules(world.meta).find((r) => r.kind === 'same' && r.name?.trim().toLowerCase() === name.toLowerCase())
    if (joins) {
      write.run(JSON.stringify([...new Set([...joins.patterns, ...wordings])]), joins.id)
      ruleId = joins.id
    } else {
      ruleId = createRow(world.meta, { kind: 'same', match: 'is', patterns: wordings, name, enabled: true })
    }
  })()
  const changed = renamed(world)
  return { rule: ruleId ? getRule(world, ruleId) : null, changed }
}

function createRow(meta: MetaStore, r: RuleInput) {
  const sort = meta.sqlite.prepare('SELECT coalesce(max(sort), 0) + 1 FROM payee_name_rules').pluck().get() as number
  return Number(
    meta.sqlite
      .prepare('INSERT INTO payee_name_rules (kind, match, patterns, name, enabled, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.kind, r.match, JSON.stringify(r.patterns), r.name, r.enabled ? 1 : 0, sort).lastInsertRowid,
  )
}

/**
 * A synced or imported transaction's payee is what its current bank connection sends: when the
 * bank's wording changes (a pending one posting, or another service after a switch), so does the
 * payee. One you entered keeps yours. A payee your rule named keeps that name: its new wording joins
 * the rule. When it becomes another payee, what was set for the old one carries over (carryPayeeOver).
 */
export function followBankPayee(ctx: AppContext, tx: { id: number; payee: string; payeeKey: string; origin: string }, payee: string) {
  if (tx.origin === 'manual' || tx.payee === payee) return
  let name = payeeNamerFor(ctx)
  const before = name(tx.payee)
  if (before.ruleId !== null && name(payee).ruleId !== before.ruleId) keepNamed(ctx.meta, before, payee)
  name = payeeNamerFor(ctx)
  const key = name(payee).key
  ctx.sqlite
    .prepare(`UPDATE transactions SET payee = ?, payee_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(payee, key, tx.id)
  if (key !== tx.payeeKey) {
    carryPayeeOver(ctx, tx.id, tx.payeeKey, key, payee)
    applyPayeeChoices(ctx, [key])
    carryPayeeRefs(ctx, [[tx.payeeKey, key]])
  }
}

/** A payee your `same` rule named, now worded otherwise: the new wording joins the rule. */
function keepNamed(meta: MetaStore, before: PayeeNaming, payee: string) {
  const rule = loadNameRules(meta).find((r) => r.id === before.ruleId)
  if (rule?.kind !== 'same') return
  meta.sqlite
    .prepare(`UPDATE payee_name_rules SET patterns = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(JSON.stringify([...new Set([...rule.patterns, payee])]), rule.id)
  forgetPayeeNamer(meta)
}

/**
 * A transaction moved from one payee to another (its key): what was set for the old one carries over
 * to the new one. The category it learned from you, your choice for the payee (the new one's own
 * stays), and its recurring item matching it. The old payee's choice goes once none of its
 * transactions are left.
 */
function carryPayeeOver(ctx: AppContext, id: number, from: string, to: string, payee: string) {
  const t = ctx.sqlite
    .prepare('SELECT amount_minor AS amount, category_id AS categoryId, category_source AS source, recurring_item_id AS itemId FROM transactions WHERE id = ?')
    .get(id) as { amount: number; categoryId: number | null; source: string | null; itemId: number | null }
  if (t.source === 'user' && t.categoryId) {
    learn(ctx, from, t.amount, t.categoryId, -1)
    learn(ctx, to, t.amount, t.categoryId)
  }
  ctx.sqlite.prepare('INSERT OR IGNORE INTO payee_rules (payee_key, mode, category_id) SELECT ?, mode, category_id FROM payee_rules WHERE payee_key = ?').run(to, from)
  if (!ctx.sqlite.prepare('SELECT 1 FROM transactions WHERE payee_key = ? LIMIT 1').get(from)) {
    ctx.sqlite.prepare('DELETE FROM payee_rules WHERE payee_key = ?').run(from)
  }
  if (t.itemId) {
    ctx.sqlite
      .prepare(
        `INSERT OR IGNORE INTO recurring_payees (item_id, payee_key, name)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM recurring_items WHERE id = ? AND payee_key = ?)`,
      )
      .run(t.itemId, to, payeeNamerFor(ctx)(payee).name, t.itemId, to)
  }
}

/**
 * After the payee name rules or AI names change (or how payees are named: PAYEE_RULES_VERSION): each
 * transaction whose payee they now make into another one moves to it, carrying over what was set for
 * the old one. Returns the ones that moved.
 */
export function rebuildPayeeKeys(ctx: AppContext): number[] {
  const name = payeeNamerFor(ctx)
  const rows = ctx.sqlite.prepare('SELECT id, payee, payee_key AS payeeKey FROM transactions').all() as Array<{ id: number; payee: string; payeeKey: string }>
  const move = ctx.sqlite.prepare(`UPDATE transactions SET payee_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
  const moved: number[] = []
  const into = new Set<string>()
  const pairs = new Map<string, [string, string]>()
  ctx.sqlite.transaction(() => {
    for (const r of rows) {
      const key = name(r.payee).key
      if (key === r.payeeKey) continue
      move.run(key, r.id)
      carryPayeeOver(ctx, r.id, r.payeeKey, key, r.payee)
      moved.push(r.id)
      into.add(key)
      pairs.set(`${r.payeeKey}\u0000${key}`, [r.payeeKey, key])
    }
    // A payee you always set one way: its new transactions waiting for a category get it.
    if (into.size) applyPayeeChoices(ctx, [...into])
    carryPayeeRefs(ctx, [...pairs.values()])
  })()
  return moved
}

/**
 * Before payee keys are made again by new naming (PAYEE_RULES_VERSION): payees your `same` rules
 * named, which they wouldn't now, stay named. (The built-in cleanup made “Tst-Corner Cafe” into
 * “corner cafe”, which a rule knew it by.) Their wording as sent joins the rule. Returns how many
 * were added.
 */
export function keepRuleNames(world: PayeeWorld): number {
  const rules = loadNameRules(world.meta).filter((r) => r.kind === 'same' && r.name?.trim())
  if (!rules.length) return 0
  const name = payeeNamerFor(world)
  const added = new Map<number, Set<string>>()
  for (const ctx of world.ledgers()) {
    const rows = ctx.sqlite.prepare('SELECT DISTINCT payee, payee_key AS payeeKey FROM transactions').all() as Array<{ payee: string; payeeKey: string }>
    for (const r of rows) {
      const rule = rules.find((x) => payeeKey(x.name!) === r.payeeKey)
      if (!rule || name(r.payee).ruleId === rule.id) continue
      const set = added.get(rule.id) ?? new Set(rule.patterns)
      set.add(r.payee)
      added.set(rule.id, set)
    }
  }
  const write = world.meta.sqlite.prepare(`UPDATE payee_name_rules SET patterns = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
  let n = 0
  world.meta.sqlite.transaction(() => {
    for (const [id, set] of added) {
      n += set.size - rules.find((r) => r.id === id)!.patterns.length
      write.run(JSON.stringify([...set]), id)
    }
  })()
  if (n) forgetPayeeNamer(world.meta)
  return n
}
