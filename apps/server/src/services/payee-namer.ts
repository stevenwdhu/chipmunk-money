import { asc } from 'drizzle-orm'
import { payeeNamer, type PayeeNameRuleSpec, type PayeeNaming } from '@chipmunk/shared'
import { payeeNameRules, payeeTidy } from '../db/schema'
import type { AppContext, MetaStore } from './context'
import { getAppSetting } from './settings'

/** Your payee name rules (app-wide), in the order they apply. */
export function loadNameRules(meta: MetaStore): PayeeNameRuleSpec[] {
  const r = payeeNameRules
  const rows = meta.db
    .select({ id: r.id, kind: r.kind, match: r.match, patterns: r.patterns, name: r.name, enabled: r.enabled })
    .from(r)
    .orderBy(asc(r.sort), asc(r.id))
    .all()
  return rows.map((r) => ({ ...r, patterns: JSON.parse(r.patterns) as string[], enabled: !!r.enabled }))
}

/** AI tidying names payees (off: they're called what the bank sent). */
export const aiTidyOn = (meta: MetaStore) => getAppSetting<boolean>(meta, 'payees.aiTidy', false)

/** What AI tidying called each payee as sent. */
export const tidiedNames = (meta: MetaStore) =>
  new Map(
    meta.db
      .select({ original: payeeTidy.original, tidied: payeeTidy.tidied })
      .from(payeeTidy)
      .all()
      .map((r) => [r.original, r.tidied]),
  )

/** The app's namer (by its database), made from your rules and AI names, until they change. */
const namers = new WeakMap<object, (raw: string) => PayeeNaming>()

/** Names payees, in every ledger: your rules, then AI tidying when it's on, else as sent (see payeeNamer). */
export function payeeNamerFor(ctx: { meta: MetaStore }): (raw: string) => PayeeNaming {
  let namer = namers.get(ctx.meta.db)
  if (!namer) {
    const tidied = aiTidyOn(ctx.meta) ? tidiedNames(ctx.meta) : null
    namer = payeeNamer(loadNameRules(ctx.meta), tidied ? (raw) => tidied.get(raw) : undefined)
    namers.set(ctx.meta.db, namer)
  }
  return namer
}

/** After your rules, AI names or AI tidying's setting change. */
export const forgetPayeeNamer = (meta: MetaStore) => namers.delete(meta.db)

/** Which payee a payee as sent is: transactions with the same key are one payee. */
export const payeeKeyOf = (ctx: AppContext, raw: string) => payeeNamerFor(ctx)(raw).key
/** What a payee as sent is called, and by which of your rules. */
export const payeeNameOf = (ctx: AppContext, raw: string) => payeeNamerFor(ctx)(raw)
