import { HTTPException } from 'hono/http-exception'
import {
  CUSTOM_REPORT_REF_KINDS,
  customReportCreateSchema,
  customReportUpdateSchema,
  describeFilter,
  filterRefs,
  mapConditions,
  normalizeFilter,
  reportSpecSchema,
  type Condition,
  type CustomReport,
  type CustomReportCreate,
  type CustomReportMissing,
  type CustomReportUpdate,
  type FilterNames,
  type ReportFilter,
  type RefNames,
  type ReportSpec,
  withSavedNames,
} from '@chipmunk/shared'
import type { LedgerQuery } from '../db/scope'
import { notFound, parseWith } from '../lib/http'
import { recordActivity } from './activity'
import type { AppContext } from './context'
import { payeeNameOf } from './payee-namer'

/**
 * Reports you saved: a filter, range and comparison under a name. The ids in a filter aren't
 * checked: one that's gone is listed in `missing` and matches nothing, so Undo after a delete, and
 * Save as new on a report with a deleted tag, work. When ids change under them (a category merged
 * or moved, the categories, groups and labels matched to the shared list, payees keyed anew), the
 * filters follow.
 */

export const CUSTOM_REPORTS_MAX = 50

/** Who the activity log says changed a report when the app rewrote its filter. */
const APP = { name: 'Chipmunk', apiKeyId: null }

interface Row {
  id: number
  name: string
  spec: string
  createdAt: string
  updatedAt: string
}

const SELECT = 'SELECT id, name, spec, created_at AS createdAt, updated_at AS updatedAt FROM custom_reports'
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const allRows = (q: LedgerQuery) => q.all<Row>(`${SELECT} WHERE ledger_id = @ledger ORDER BY sort, id`)
const specOf = (r: Row) => JSON.parse(r.spec) as ReportSpec
const REF_NAME_KINDS = ['category', 'group', 'label', 'tag', 'payee', 'account', 'recurring'] as const

/** A spec as it's kept: its filter tidied, and the names of what it refers to now (or, for what's gone, as they were). */
function saved(ctx: AppContext, spec: ReportSpec, before?: RefNames): ReportSpec {
  const filter = normalizeFilter(spec.filter)
  const { names } = lookUp(ctx, [filter])
  const refs = filterRefs(filter)
  const nameNow = (kind: (typeof REF_NAME_KINDS)[number], id: number | string) => (kind === 'payee' ? names.payee?.(String(id)) : names[kind]?.(Number(id)))
  const out: RefNames = {}
  for (const kind of REF_NAME_KINDS) {
    const entries = [...refs[kind]].flatMap((id) => {
      const name = nameNow(kind, id) ?? before?.[kind]?.[String(id)] ?? spec.names?.[kind]?.[String(id)]
      return name === undefined ? [] : [[String(id), name] as const]
    })
    if (entries.length) out[kind] = Object.fromEntries(entries)
  }
  const { names: _was, ...rest } = spec
  return { ...rest, filter, ...(Object.keys(out).length && { names: out }) }
}

/** A payee's name: as your rules name its latest transaction (a live one if it has any). */
function payeeName(ctx: AppContext, key: string): string | undefined {
  const raw = ctx.q.pluck<string>(
    'SELECT payee FROM transactions WHERE ledger_id = @ledger AND payee_key = ? ORDER BY deleted_at IS NULL DESC, date DESC, id DESC LIMIT 1',
    key,
  )
  return raw === undefined ? undefined : payeeNameOf(ctx, raw).name
}

/** What some filters refer to, as it is now: names to describe them by, and what's gone or off. */
function lookUp(ctx: AppContext, filters: ReportFilter[]) {
  const refs = filterRefs(null)
  for (const f of filters) {
    const r = filterRefs(f)
    for (const kind of CUSTOM_REPORT_REF_KINDS) for (const v of r[kind]) (refs[kind] as Set<number | string>).add(v)
  }
  const list = (s: Set<number | string>) => JSON.stringify([...s])
  // Only this ledger's: an id of another ledger's tag, account or category reads as deleted.
  const byId = <T>(sql: string, s: Set<number>) =>
    new Map(ctx.q.all<T & { id: number }>(`${sql} WHERE ledger_id = @ledger AND id IN (SELECT value FROM json_each(?))`, list(s)).map((r) => [r.id, r]))
  const categories = byId<{ name: string; archivedAt: string | null }>('SELECT id, name, archived_at AS archivedAt FROM ledger_categories', refs.category)
  const groups = byId<{ name: string }>('SELECT id, name FROM ledger_category_groups', refs.group)
  const labels = byId<{ name: string }>('SELECT id, name FROM ledger_labels', refs.label)
  const tags = byId<{ name: string }>('SELECT id, name FROM tags', refs.tag)
  const accounts = byId<{ name: string }>('SELECT id, name FROM ledger_accounts', refs.account)
  const recurring = byId<{ name: string }>('SELECT id, coalesce(title, name) AS name FROM recurring_items', refs.recurring)
  const live = new Set(
    ctx.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))', list(refs.transaction)),
  )
  const used = (key: string) => !!ctx.q.pluck('SELECT 1 FROM transactions WHERE ledger_id = @ledger AND payee_key = ? AND deleted_at IS NULL LIMIT 1', key)
  const payees = new Map([...refs.payee].map((k) => [k, { name: payeeName(ctx, k), used: used(k) }]))

  const names: FilterNames = {
    category: (i) => categories.get(i)?.name,
    group: (i) => groups.get(i)?.name,
    label: (i) => labels.get(i)?.name,
    tag: (i) => tags.get(i)?.name,
    payee: (k) => payees.get(k)?.name,
    account: (i) => accounts.get(i)?.name,
    recurring: (i) => recurring.get(i)?.name,
  }
  const missing = (f: ReportFilter): CustomReportMissing[] => {
    const r = filterRefs(f)
    const deleted = (kind: CustomReportMissing['kind'], ids: Set<number>, has: (i: number) => boolean) =>
      [...ids].filter((i) => !has(i)).map((id): CustomReportMissing => ({ kind, id, reason: 'deleted' }))
    return [
      ...[...r.category].flatMap((id): CustomReportMissing[] => {
        const c = categories.get(id)
        return !c ? [{ kind: 'category', id, reason: 'deleted' }] : c.archivedAt ? [{ kind: 'category', id, reason: 'off' }] : []
      }),
      ...deleted('group', r.group, (i) => groups.has(i)),
      ...deleted('label', r.label, (i) => labels.has(i)),
      ...deleted('tag', r.tag, (i) => tags.has(i)),
      ...[...r.payee].filter((k) => !payees.get(k)?.used).map((id): CustomReportMissing => ({ kind: 'payee', id, reason: 'unused' })),
      ...deleted('account', r.account, (i) => accounts.has(i)),
      ...deleted('recurring', r.recurring, (i) => recurring.has(i)),
      ...deleted('transaction', r.transaction, (i) => live.has(i)),
    ]
  }
  return { names, missing }
}

function toDTO(r: Row, spec: ReportSpec, known: ReturnType<typeof lookUp>): CustomReport {
  return {
    id: r.id,
    name: r.name,
    spec,
    description: describeFilter(spec.filter, withSavedNames(known.names, spec.names)),
    missing: known.missing(spec.filter),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** Your reports, in your order. */
export function listCustomReports(ctx: AppContext): CustomReport[] {
  const rows = allRows(ctx.q).map((r) => ({ r, spec: specOf(r) }))
  const known = lookUp(ctx, rows.map((x) => x.spec.filter))
  return rows.map((x) => toDTO(x.r, x.spec, known))
}

export function getCustomReport(ctx: AppContext, id: number): CustomReport {
  const r = ctx.q.mustGet<Row>(`${SELECT} WHERE ledger_id = @ledger AND id = ?`, 'Custom report not found', id)
  const spec = specOf(r)
  return toDTO(r, spec, lookUp(ctx, [spec.filter]))
}

/** Names are unique whatever their case. */
function checkName(ctx: AppContext, name: string, except?: number) {
  const clash = allRows(ctx.q).find((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase())
  if (clash) throw new HTTPException(409, { message: `You already have a report called “${clash.name}”.` })
}

export function createCustomReport(ctx: AppContext, input: CustomReportCreate): CustomReport {
  const { name, spec } = parseWith(customReportCreateSchema, input)
  const count = ctx.q.pluck<number>('SELECT count(*) FROM custom_reports WHERE ledger_id = @ledger')!
  if (count >= CUSTOM_REPORTS_MAX) {
    throw new HTTPException(409, { message: `You can keep up to ${CUSTOM_REPORTS_MAX} custom reports. Delete one to save another.` })
  }
  checkName(ctx, name)
  // A new one goes last.
  const id = ctx.q.pluck<number>(
    `INSERT INTO custom_reports (ledger_id, name, spec, sort)
     VALUES (@ledger, ?, ?, (SELECT coalesce(max(sort) + 1, 0) FROM custom_reports WHERE ledger_id = @ledger)) RETURNING id`,
    name,
    JSON.stringify(saved(ctx, spec)),
  )!
  return getCustomReport(ctx, id)
}

/** Renames it or replaces its spec. The last change wins. */
export function updateCustomReport(ctx: AppContext, id: number, input: CustomReportUpdate): CustomReport {
  const before = getCustomReport(ctx, id)
  const { name, spec } = parseWith(customReportUpdateSchema, input)
  if (name !== undefined) checkName(ctx, name, id)
  const sets = Object.entries({ name, spec: spec && JSON.stringify(saved(ctx, spec, before.spec.names)) }).filter(([, v]) => v !== undefined)
  if (sets.length) {
    ctx.q.run(`UPDATE custom_reports SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ${NOW} WHERE ledger_id = @ledger AND id = ?`, ...sets.map(([, v]) => v), id)
  }
  return getCustomReport(ctx, id)
}

/** Puts them in this order: these ids first, then the rest as they were. */
export function reorderCustomReports(ctx: AppContext, ids: number[]): CustomReport[] {
  const rows = allRows(ctx.q)
  const known = new Set(rows.map((r) => r.id))
  const unknown = ids.find((id) => !known.has(id))
  if (unknown !== undefined) notFound(`There's no custom report ${unknown}`)
  const order = [...new Set(ids), ...rows.map((r) => r.id).filter((id) => !ids.includes(id))]
  ctx.q.transaction(() => order.forEach((id, i) => ctx.q.run('UPDATE custom_reports SET sort = ? WHERE ledger_id = @ledger AND id = ?', i, id)))
  return listCustomReports(ctx)
}

/** Deletes it, returning it as it was (POST its name and spec to undo). */
export function deleteCustomReport(ctx: AppContext, id: number): CustomReport {
  const before = getCustomReport(ctx, id)
  ctx.q.run('DELETE FROM custom_reports WHERE ledger_id = @ledger AND id = ?', id)
  return before
}

// When what filters refer to changes --------------------------------------

type Change = { row: Row; before: ReportFilter; after: ReportFilter }

/**
 * Every report's filter rewritten condition by condition (see mapConditions). Returns the ones that
 * changed, and the ones left as they were because the rewrite wouldn't fit a report's limits.
 */
function remap(q: LedgerQuery, fn: (c: Condition, place: 'only' | 'rule') => Condition | null) {
  const write = (spec: string, id: number) => q.run(`UPDATE custom_reports SET spec = ?, updated_at = ${NOW} WHERE ledger_id = @ledger AND id = ?`, spec, id)
  const changed: Change[] = []
  const tooBig: Row[] = []
  for (const row of allRows(q)) {
    const spec = specOf(row)
    const before = normalizeFilter(spec.filter)
    const after = mapConditions(before, fn)
    if (JSON.stringify(after) === JSON.stringify(before)) continue
    if (!reportSpecSchema.safeParse({ ...spec, filter: after }).success) {
      tooBig.push(row)
      continue
    }
    write(JSON.stringify({ ...spec, filter: after }), row.id)
    changed.push({ row, before, after })
  }
  return { changed, tooBig }
}

function logChange(ctx: Pick<AppContext, 'q' | 'now'>, change: Change, summary: string) {
  recordActivity(ctx, APP, {
    action: 'update',
    entity: 'custom_report',
    entityId: change.row.id,
    summary,
    before: { filter: change.before },
    after: { filter: change.after },
  })
}

/** A category merged into another, or turned off with its transactions moved: reports on it are on `into`. Returns how many changed. */
export function remapCategoryRefs(ctx: AppContext, from: number, into: number): number {
  return remap(ctx.q, (c) => (c.field === 'category' ? { ...c, ids: c.ids.map((i) => (i === from ? into : i)) } : c)).changed.length
}

/** Category ids in a filter's Only count conditions, and in its rules. */
function categoryPlaces(f: ReportFilter) {
  const only = new Set<number>()
  const rules = new Set<number>()
  mapConditions(f, (c, place) => {
    if (c.field === 'category') for (const i of c.ids) if (i !== 'none') (place === 'only' ? only : rules).add(i)
    return c
  })
  return { only, rules }
}

/** One kind of id a joining ledger's reports change: each old id's shared one (null: it went), and the old ids' names. */
export type JoinedIds = { to: Map<number, number | null>; names: Map<number, string> }

/**
 * A ledger's categories, groups and labels matched to the shared list the first time. Each id in a
 * filter becomes its shared one. One with none, or already gone, can't stay, as a shared one may have
 * that id. A category's transactions are uncategorized now, so in Only count it becomes
 * Uncategorized. A group or label just goes, and its Only count condition with it when nothing's
 * left. A rule on nothing else goes. Call it once the shared list is written: the log says what each
 * report filters by in place of what, and what it no longer filters by.
 */
/**
 * After the first join, ids point at the shared categories, groups and labels: the names a report
 * kept for them are the shared ones (so a shared one deleted later is named right).
 */
function renameJoined(q: LedgerQuery) {
  const tables = { category: 'ledger_categories', group: 'ledger_category_groups', label: 'ledger_labels' } as const
  for (const row of allRows(q)) {
    const spec = specOf(row)
    if (!spec.names) continue
    const refs = filterRefs(spec.filter)
    const names: RefNames = { ...spec.names }
    for (const [kind, table] of Object.entries(tables) as Array<[keyof typeof tables, string]>) {
      const ids = JSON.stringify([...refs[kind]])
      const now = q.all<{ id: number; name: string }>(`SELECT id, name FROM ${table} WHERE ledger_id = @ledger AND id IN (SELECT value FROM json_each(?))`, ids)
      if (now.length) names[kind] = Object.fromEntries(now.map((r) => [String(r.id), r.name]))
      else delete names[kind]
    }
    q.run('UPDATE custom_reports SET spec = ? WHERE ledger_id = @ledger AND id = ?', JSON.stringify({ ...spec, names: Object.keys(names).length ? names : undefined }), row.id)
  }
}

export function joinCategoryRefs(ctx: Pick<AppContext, 'q' | 'now'>, joined: Record<'category' | 'group' | 'label', JoinedIds>) {
  const target = (kind: keyof typeof joined, i: number) => joined[kind].to.get(i) ?? null
  const { changed } = remap(ctx.q, (c, place) => {
    if (c.field === 'category') {
      const ids = c.ids.flatMap((i): Array<number | 'none'> => {
        if (i === 'none') return [i]
        const to = target('category', i)
        return to !== null ? [to] : place === 'only' ? ['none'] : []
      })
      return ids.length ? { field: 'category', ids } : null
    }
    if (c.field === 'group' || c.field === 'label') {
      const ids = c.ids.flatMap((i): Array<number | 'none'> => {
        const to = i === 'none' ? i : target(c.field, i)
        return to === null ? [] : [to]
      })
      return ids.length ? { field: c.field, ids } : null
    }
    return c
  })
  renameJoined(ctx.q)
  const nameNow = (id: number) => ctx.q.pluck<string>('SELECT name FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', id)
  const either = (w: string[]) => (w.length > 1 ? `${w.slice(0, -1).join(', ')} or ${w[w.length - 1]}` : w[0])
  const formerNames = joined.category.names
  for (const change of changed) {
    const former = (i: number) => formerNames.get(i) ?? 'a deleted category'
    const { only, rules } = categoryPlaces(change.before)
    // What each category it filters by now stands in for.
    const moved = new Map<string, Set<string>>()
    const gone = new Set<string>()
    for (const i of new Set([...only, ...rules])) {
      const to = target('category', i)
      const now = to === null ? (only.has(i) ? 'Uncategorized' : undefined) : nameNow(to)
      if (to === null && rules.has(i)) gone.add(former(i))
      if (now && now.toLowerCase() !== formerNames.get(i)?.toLowerCase()) moved.set(now, (moved.get(now) ?? new Set()).add(former(i)))
    }
    // Groups and labels keep their names, so only the ones the shared list doesn't have are told.
    const refs = filterRefs(change.before)
    for (const kind of ['group', 'label'] as const) {
      for (const i of refs[kind]) {
        const name = joined[kind].names.get(i)
        if (target(kind, i) === null) gone.add(name === undefined ? `a deleted ${kind}` : `the ${name} ${kind}`)
      }
    }
    const name = change.row.name
    const filtersBy = [...moved].map(([now, was]) => `${now} in place of ${[...was].join(' and ')}`).join(', ')
    const no = gone.size ? `no longer by ${either([...gone])}` : ''
    if (filtersBy) logChange(ctx, change, `${name} filters by ${filtersBy}${no && `, and ${no}`}`)
    else if (no) logChange(ctx, change, `${name} no longer filters by ${either([...gone])}`)
  }
}

/**
 * Payees that got another key (renamed by your rules, or worded otherwise by the bank), as
 * (from, to) pairs: each filter on one filters by the new key too, and keeps the old one only
 * while transactions still have it. A report that would then have too many payees keeps the old
 * key (listed in `missing` once nothing has it), and the log says so.
 */
export function carryPayeeRefs(ctx: AppContext, pairs: Array<[from: string, to: string]>) {
  const tos = new Map<string, Set<string>>()
  for (const [from, to] of pairs) if (from !== to) tos.set(from, (tos.get(from) ?? new Set()).add(to))
  if (!tos.size || !ctx.q.pluck('SELECT 1 FROM custom_reports WHERE ledger_id = @ledger LIMIT 1')) return
  const has = (key: string) => !!ctx.q.pluck('SELECT 1 FROM transactions WHERE ledger_id = @ledger AND payee_key = ? LIMIT 1', key)
  const { changed, tooBig } = remap(ctx.q, (c) =>
    c.field === 'payee' ? { field: 'payee', keys: c.keys.flatMap((k) => (tos.has(k) ? [...(has(k) ? [k] : []), ...tos.get(k)!] : [k])) } : c,
  )
  const named = (keys: string[]) => keys.map((k) => payeeName(ctx, k) ?? k)
  for (const change of changed) {
    const had = filterRefs(change.before).payee
    const now = filterRefs(change.after).payee
    const added = named([...now].filter((k) => !had.has(k)))
    const dropped = named([...had].filter((k) => !now.has(k)))
    const name = change.row.name
    const summary =
      added.length === 1
        ? `${name} now filters by the payee’s new name, ${added[0]}`
        : added.length
          ? `${name} now filters by the payees’ new names, ${added.join(', ')}`
          : `${name} no longer filters by the payee’s old name${dropped.length === 1 ? '' : 's'}, ${dropped.join(', ')}`
    logChange(ctx, change, summary)
  }
  for (const row of tooBig) {
    recordActivity(ctx, APP, {
      action: 'update',
      entity: 'custom_report',
      entityId: row.id,
      summary: `${row.name} couldn’t follow a payee to its new names: there were too many for one report`,
    })
  }
}
