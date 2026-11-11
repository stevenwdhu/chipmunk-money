import { HTTPException } from 'hono/http-exception'
import { DEFAULT_CATEGORY_GROUPS, DEFAULT_LABELS } from '@chipmunk/shared'
import type { UnscopedQuery } from '../db/scope'
import type { Storage } from '../storage'
import type { AppContext } from './context'
import { joinCategoryRefs } from './custom-reports'

/**
 * The shared category list, and how a ledger uses it.
 *
 * The shared list is one set of rows with no ledger (ledger_id null) in category_groups, categories
 * and labels. Every ledger with `category_list = 'shared'` uses it by the same ids, and turns
 * categories off for itself in ledger_category_off. A ledger with its own list has rows with its
 * ledger_id instead. Reads go through the ledger_categories, ledger_category_groups and
 * ledger_labels views, which give each ledger the list it uses.
 *
 * The shared rows belong to no ledger, so they're read and written with every ledger in scope
 * (onSharedList, the one listed site in db/unscoped-sites.ts), from this module and catalog-edit.ts.
 */

/** Statements with every ledger in scope, for the shared list's rows. */
export type SharedList = UnscopedQuery

/**
 * Runs fn on the shared list: its rows have no ledger, so with every ledger in scope and no pin
 * checker. Work on one ledger's rows inside it goes through that ledger's ctx.q as usual.
 */
export function onSharedList<T>(storage: Storage, fn: (db: SharedList) => T): T {
  return storage.allLedgers('the shared category list', fn)
}

// Which list a ledger uses ------------------------------------------------------------

/** Whether a ledger uses the shared list (the default) rather than its own. */
export function usesSharedList(ctx: AppContext): boolean {
  return ctx.q.pluck<string>('SELECT category_list FROM ledgers WHERE id = @ledger') !== 'own'
}

/** A ledger that uses the shared category list changes it in App settings, not here. */
export function requireOwnList(ctx: AppContext) {
  if (usesSharedList(ctx)) {
    throw new HTTPException(409, {
      message: 'This ledger uses the shared category list. Change it in App settings → Categories, or give the ledger its own list (PUT /categories/sharing).',
    })
  }
}

// The shared list ----------------------------------------------------------------------

export interface CatalogGroup {
  id: number
  name: string
  color: string
  sort: number
}
export interface CatalogCategory {
  id: number
  groupId: number | null
  name: string
  isIncome: number
  excludeFromTotals: number
  sort: number
}
export interface CatalogLabel {
  id: number
  name: string
  color: string
  sort: number
}
export interface Catalog {
  groups: CatalogGroup[]
  categories: CatalogCategory[]
  labels: CatalogLabel[]
  links: Array<{ categoryId: number; labelId: number }>
}

/** The shared list as it is. */
export function readCatalog(db: SharedList): Catalog {
  return {
    groups: db.all<CatalogGroup>('SELECT id, name, color, sort FROM category_groups WHERE ledger_id IS NULL ORDER BY sort, id'),
    categories: db.all<CatalogCategory>(
      `SELECT id, group_id AS groupId, name, is_income AS isIncome, exclude_from_totals AS excludeFromTotals, sort
       FROM categories WHERE ledger_id IS NULL ORDER BY sort, id`,
    ),
    labels: db.all<CatalogLabel>('SELECT id, name, color, sort FROM labels WHERE ledger_id IS NULL ORDER BY sort, id'),
    links: db.all<{ categoryId: number; labelId: number }>(
      `SELECT cl.category_id AS categoryId, cl.label_id AS labelId FROM category_labels cl JOIN categories c ON c.id = cl.category_id
       WHERE c.ledger_id IS NULL ORDER BY cl.category_id, cl.label_id`,
    ),
  }
}

/**
 * Starts the shared list from the default categories and labels, the first time. Runs with every
 * ledger in scope, on the statements it hands over (storage.ts).
 */
export function seedCatalog(db: SharedList) {
  db.transaction(() => {
    if (!db.pluck('SELECT 1 FROM categories WHERE ledger_id IS NULL LIMIT 1')) {
      const labelIds = new Map<string, number>()
      DEFAULT_LABELS.forEach((l, i) => {
        labelIds.set(l.name, Number(db.run('INSERT INTO labels (name, color, sort) VALUES (?, ?, ?)', l.name, l.color, i).lastInsertRowid))
      })
      DEFAULT_CATEGORY_GROUPS.forEach((g, gi) => {
        const groupId = Number(db.run('INSERT INTO category_groups (name, color, sort) VALUES (?, ?, ?)', g.name, g.color, gi).lastInsertRowid)
        g.categories.forEach((c, ci) => {
          const id = Number(
            db.run(
              'INSERT INTO categories (group_id, name, is_income, exclude_from_totals, sort) VALUES (?, ?, ?, ?, ?)',
              groupId,
              c.name,
              c.isIncome ? 1 : 0,
              c.excludeFromTotals ? 1 : 0,
              ci,
            ).lastInsertRowid,
          )
          for (const name of c.labels ?? []) {
            const labelId = labelIds.get(name)
            if (labelId) db.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)', id, labelId)
          }
        })
      })
    }
  })
}

// Matching a ledger's own categories to the shared list ------------------------------------

/** Names the defaults used to have, lowercased, and what they're called now. */
const FORMER_NAMES: Record<string, string> = {
  paycheque: 'Salary',
  'hydro & utilities': 'Electricity & heating',
  'hydro & heating': 'Electricity & heating',
  'water & sewer': 'Water',
  'phone & internet': 'Internet',
  'mobile phones': 'Phones',
  'home & household': 'Household supplies',
  'moving & relocation': 'Relocation',
  'furniture & renovations': 'Furniture & decorations',
  'dining out': 'Dine out',
  coffee: 'Drinks & treats',
  gas: 'Fuel',
  'fuel & charging': 'Fuel',
  'public transit': 'Transit',
  'car payment or lease': 'Car payment',
  parking: 'Parking & tolls',
  'ride share & taxi': 'Taxi',
  'home or tenant insurance': 'Home insurance',
  'life & disability insurance': 'Life insurance',
  'health & dental insurance': 'Health insurance',
  'health & pharmacy': 'Pharmacy',
  'pharmacy & prescriptions': 'Pharmacy',
  shopping: 'General shopping',
  fitness: 'Sports & fitness',
  subscriptions: 'Software & media',
  'streaming & media': 'Software & media',
  'apps & software': 'Software & media',
  'gifts & donations': 'Gifts',
  'fees & interest': 'Bank & card fees',
  taxes: 'Income tax',
}

/** The shared category one of this name becomes: the same name, or what a former default name is called now. */
function sharedByName(catalog: Catalog, name: string) {
  const byName = (n: string) => catalog.categories.find((x) => x.name.toLowerCase() === n.toLowerCase())
  const former = FORMER_NAMES[name.toLowerCase()]
  return byName(name) ?? (former ? byName(former) : undefined)
}

/**
 * What happens to one of a ledger's own categories when it joins the shared list: it becomes a
 * shared category (a number: matched, or its transactions moved there), is added to the shared list
 * ('add'), or goes, leaving its transactions uncategorized (null).
 */
export type JoinResolution = number | 'add' | null

interface OwnCategory {
  id: number
  name: string
  isIncome: number
  excludeFromTotals: number
  archivedAt: string | null
  groupName: string | null
  groupColor: string | null
}

/** A ledger's own categories, with their groups' names and colours. */
function ownCategories(ctx: AppContext): OwnCategory[] {
  return ctx.q.all<OwnCategory>(
    `SELECT c.id, c.name, c.is_income AS isIncome, c.exclude_from_totals AS excludeFromTotals, c.archived_at AS archivedAt,
       g.name AS groupName, g.color AS groupColor
     FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id AND g.ledger_id = c.ledger_id
     WHERE c.ledger_id = @ledger ORDER BY c.id`,
  )
}

/**
 * A ledger's own categories that the shared list doesn't have by name, for choosing what happens to
 * each when it joins: with how many transactions use it, and a shared category that seems to fit
 * (one the defaults used to call that, or one whose name is part of its name or the other way round).
 */
export function joinPreview(storage: Storage, ctx: AppContext) {
  const catalog = onSharedList(storage, readCatalog)
  const own = ctx.q.all<{ id: number; name: string; groupName: string | null; transactionCount: number }>(
    `SELECT c.id, c.name, g.name AS groupName,
       (SELECT count(*) FROM transactions t WHERE t.ledger_id = c.ledger_id AND t.category_id = c.id AND t.deleted_at IS NULL) AS transactionCount
     FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id AND g.ledger_id = c.ledger_id
     WHERE c.ledger_id = @ledger ORDER BY g.sort, c.sort, c.id`,
  )
  const byName = (name: string) => catalog.categories.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return own
    .filter((c) => !byName(c.name))
    .map((c) => {
      const former = FORMER_NAMES[c.name.toLowerCase()]
      let suggestion = former ? byName(former) : undefined
      if (!suggestion) {
        const mine = c.name.toLowerCase()
        suggestion = catalog.categories.find((x) => {
          const theirs = x.name.toLowerCase()
          return Math.min(theirs.length, mine.length) >= 4 && (mine.includes(theirs) || theirs.includes(mine))
        })
      }
      return { id: c.id, name: c.name, group: c.groupName, transactionCount: c.transactionCount, suggestion: suggestion?.id ?? null }
    })
}

/** The shared category for one of a ledger's own, added to the list (in the group of the same name, with its labels) when it has none. */
function matchOrAdd(db: SharedList, catalog: Catalog, c: OwnCategory, labels: Array<{ name: string; color: string }>): number {
  const found = sharedByName(catalog, c.name)
  if (found) return found.id

  let group = c.groupName ? catalog.groups.find((g) => g.name.toLowerCase() === c.groupName!.toLowerCase()) : undefined
  if (!group && c.groupName) {
    const sort = Math.max(-1, ...catalog.groups.map((g) => g.sort)) + 1
    const color = c.groupColor ?? '#64748b'
    const id = Number(db.run('INSERT INTO category_groups (name, color, sort) VALUES (?, ?, ?)', c.groupName, color, sort).lastInsertRowid)
    group = { id, name: c.groupName, color, sort }
    catalog.groups.push(group)
  }
  const sort = Math.max(-1, ...catalog.categories.filter((x) => x.groupId === (group?.id ?? null)).map((x) => x.sort)) + 1
  const id = Number(
    db.run(
      'INSERT INTO categories (group_id, name, is_income, exclude_from_totals, sort) VALUES (?, ?, ?, ?, ?)',
      group?.id ?? null,
      c.name,
      c.isIncome,
      c.excludeFromTotals,
      sort,
    ).lastInsertRowid,
  )
  catalog.categories.push({ id, groupId: group?.id ?? null, name: c.name, isIncome: c.isIncome, excludeFromTotals: c.excludeFromTotals, sort })
  for (const l of labels) {
    let label = catalog.labels.find((x) => x.name.toLowerCase() === l.name.toLowerCase())
    if (!label) {
      const lsort = Math.max(-1, ...catalog.labels.map((x) => x.sort)) + 1
      const labelId = Number(db.run('INSERT INTO labels (name, color, sort) VALUES (?, ?, ?)', l.name, l.color, lsort).lastInsertRowid)
      label = { id: labelId, name: l.name, color: l.color, sort: lsort }
      catalog.labels.push(label)
    }
    db.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, label.id)
    catalog.links.push({ categoryId: id, labelId: label.id })
  }
  return id
}

/** Whether a ledger has custom reports, whose filters follow its category ids. */
const hasReports = (ctx: AppContext) => !!ctx.q.pluck('SELECT 1 FROM custom_reports WHERE ledger_id = @ledger LIMIT 1')

/** Ids a ledger's reports refer to, mapped to new ones; ids not in it (deleted ones) stay as they are. */
class KeepOthers extends Map<number, number | null> {
  override get(id: number): number | null {
    return super.has(id) ? super.get(id)! : id
  }
}

// Switching lists ------------------------------------------------------------------------

/**
 * Switches a ledger between the shared list and its own (see leaveSharedList and joinSharedList).
 * `resolve` says what happens to a joining ledger's categories the list doesn't have by name (left
 * out: they're added to it).
 */
export function setCategorySharing(storage: Storage, ctx: AppContext, shared: boolean, resolve?: Map<number, JoinResolution>) {
  if (shared === usesSharedList(ctx)) return
  if (shared) joinSharedList(storage, ctx, resolve)
  else leaveSharedList(ctx)
}

/**
 * Gives a ledger its own list: a copy of the shared one, with new ids, that it then edits by
 * itself. The categories it turned off are archived in the copy. Its transactions, recurring
 * payments, payee rules, what it learned about payees and its custom reports move to the copies.
 * The shared list isn't changed.
 */
export function leaveSharedList(ctx: AppContext) {
  if (!usesSharedList(ctx)) return
  ctx.q.transaction(() => {
    // What it uses now: the shared list, with its own off state.
    const groups = ctx.q.all<CatalogGroup>('SELECT id, name, color, sort FROM ledger_category_groups WHERE ledger_id = @ledger ORDER BY id')
    const labels = ctx.q.all<CatalogLabel>('SELECT id, name, color, sort FROM ledger_labels WHERE ledger_id = @ledger ORDER BY id')
    const categories = ctx.q.all<CatalogCategory & { archivedAt: string | null }>(
      `SELECT id, group_id AS groupId, name, is_income AS isIncome, exclude_from_totals AS excludeFromTotals, archived_at AS archivedAt, sort
       FROM ledger_categories WHERE ledger_id = @ledger ORDER BY id`,
    )
    const links = ctx.q.all<{ categoryId: number; labelId: number }>(
      `SELECT cl.category_id AS categoryId, cl.label_id AS labelId FROM category_labels cl JOIN ledger_categories c ON c.id = cl.category_id
       WHERE c.ledger_id = @ledger ORDER BY cl.category_id, cl.label_id`,
    )

    const groupIds = new Map<number, number>()
    for (const g of groups) {
      const id = ctx.q.run('INSERT INTO category_groups (ledger_id, name, color, sort) VALUES (@ledger, @name, @color, @sort)', {
        name: g.name,
        color: g.color,
        sort: g.sort,
      }).lastInsertRowid
      groupIds.set(g.id, Number(id))
    }
    const labelIds = new Map<number, number>()
    for (const l of labels) {
      const id = ctx.q.run('INSERT INTO labels (ledger_id, name, color, sort) VALUES (@ledger, @name, @color, @sort)', {
        name: l.name,
        color: l.color,
        sort: l.sort,
      }).lastInsertRowid
      labelIds.set(l.id, Number(id))
    }
    const categoryIds = new Map<number, number>()
    for (const c of categories) {
      const id = ctx.q.run(
        `INSERT INTO categories (ledger_id, group_id, name, is_income, exclude_from_totals, archived_at, sort)
         VALUES (@ledger, @groupId, @name, @isIncome, @excludeFromTotals, @archivedAt, @sort)`,
        {
          groupId: c.groupId === null ? null : (groupIds.get(c.groupId) ?? null),
          name: c.name,
          isIncome: c.isIncome,
          excludeFromTotals: c.excludeFromTotals,
          archivedAt: c.archivedAt,
          sort: c.sort,
        },
      ).lastInsertRowid
      categoryIds.set(c.id, Number(id))
    }
    for (const l of links) {
      const category = categoryIds.get(l.categoryId)
      const label = labelIds.get(l.labelId)
      if (category && label) ctx.q.run('INSERT INTO category_labels (category_id, label_id) VALUES (?, ?)', category, label)
    }

    // Everything that points at a shared category points at its copy. The copies' ids are new, so
    // one move never lands on a category another one moves from.
    for (const [from, to] of categoryIds) {
      const ids = { from, to }
      ctx.q.run('UPDATE transactions SET category_id = @to WHERE ledger_id = @ledger AND category_id = @from', ids)
      ctx.q.run('UPDATE recurring_items SET category_id = @to WHERE ledger_id = @ledger AND category_id = @from', ids)
      ctx.q.run('UPDATE payee_rules SET category_id = @to WHERE ledger_id = @ledger AND category_id = @from', ids)
      ctx.q.run('UPDATE payee_category_stats SET category_id = @to WHERE ledger_id = @ledger AND category_id = @from', ids)
    }
    const names = <T extends { id: number; name: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r.name]))
    if (hasReports(ctx)) joinCategoryRefs(ctx, {
      category: { to: new KeepOthers(categoryIds), names: names(categories) },
      group: { to: new KeepOthers(groupIds), names: names(groups) },
      label: { to: new KeepOthers(labelIds), names: names(labels) },
    })

    // Last: the switch is refused while anything still points at a shared category.
    ctx.q.run('DELETE FROM ledger_category_off WHERE ledger_id = @ledger')
    ctx.q.run("UPDATE ledgers SET category_list = 'own' WHERE id = @ledger")
  })
}

/**
 * Brings a ledger with its own list onto the shared one. Its categories are matched to the shared
 * list by name (or a former default name), or as `resolve` says; ones the list doesn't have are
 * added to it. What used them moves to the shared ones, and its own rows go. A shared category is on
 * for it when one of its categories that became it was on, or when none did.
 */
export function joinSharedList(storage: Storage, ctx: AppContext, resolve?: Map<number, JoinResolution>) {
  if (usesSharedList(ctx)) return
  const own = ownCategories(ctx)
  const ownLabels = ctx.q.all<{ categoryId: number; name: string; color: string }>(
    `SELECT cl.category_id AS categoryId, l.name, l.color FROM category_labels cl JOIN labels l ON l.id = cl.label_id
     WHERE l.ledger_id = @ledger ORDER BY l.sort, l.id`,
  )
  const ownGroups = ctx.q.all<{ id: number; name: string }>('SELECT id, name FROM category_groups WHERE ledger_id = @ledger ORDER BY id')
  const ownLabelNames = ctx.q.all<{ id: number; name: string }>('SELECT id, name FROM labels WHERE ledger_id = @ledger ORDER BY id')

  onSharedList(storage, (db) =>
    db.transaction(() => {
      const catalog = readCatalog(db)
      if (resolve) {
        const known = new Set(catalog.categories.map((c) => c.id))
        for (const to of resolve.values()) if (typeof to === 'number' && !known.has(to)) throw new Error(`The shared list has no category ${to}`)
      }
      // Each of its categories → the shared one it becomes, or null: it goes, uncategorizing its transactions.
      const map = new Map<number, number | null>()
      for (const c of own) {
        const chosen = resolve?.get(c.id)
        map.set(
          c.id,
          chosen === undefined || chosen === 'add'
            ? matchOrAdd(
                db,
                catalog,
                c,
                ownLabels.filter((l) => l.categoryId === c.id),
              )
            : chosen,
        )
      }
      // On if any of its categories that became it was on; new ones are on.
      const off = new Map<number, string | null>()
      for (const c of own) {
        const target = map.get(c.id)
        if (target === null || target === undefined) continue
        off.set(target, off.has(target) && off.get(target) === null ? null : c.archivedAt)
      }

      ctx.q.transaction(() => {
        // First: a row can be moved to a shared category only while the ledger uses the list.
        ctx.q.run("UPDATE ledgers SET category_list = 'shared' WHERE id = @ledger")
        for (const [from, to] of map) {
          if (to === null) {
            ctx.q.run(
              `UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, needs_review = 0
               WHERE ledger_id = @ledger AND category_id = @from`,
              { from },
            )
            ctx.q.run('UPDATE recurring_items SET category_id = NULL WHERE ledger_id = @ledger AND category_id = @from', { from })
            ctx.q.run('DELETE FROM payee_rules WHERE ledger_id = @ledger AND category_id = @from', { from })
            ctx.q.run('DELETE FROM payee_category_stats WHERE ledger_id = @ledger AND category_id = @from', { from })
            continue
          }
          const ids = { from, to }
          ctx.q.run('UPDATE transactions SET category_id = @to WHERE ledger_id = @ledger AND category_id = @from', ids)
          ctx.q.run('UPDATE recurring_items SET category_id = @to WHERE ledger_id = @ledger AND category_id = @from', ids)
          ctx.q.run('UPDATE payee_rules SET category_id = @to WHERE ledger_id = @ledger AND category_id = @from', ids)
          // What was learned about payees adds up where two categories became one.
          ctx.q.run(
            `INSERT INTO payee_category_stats (ledger_id, payee_key, direction, category_id, count, last_used_at)
             SELECT s.ledger_id, s.payee_key, s.direction, @to, s.count, s.last_used_at FROM payee_category_stats s
             WHERE s.ledger_id = @ledger AND s.category_id = @from
             ON CONFLICT (ledger_id, payee_key, direction, category_id) DO UPDATE SET count = count + excluded.count, last_used_at = max(last_used_at, excluded.last_used_at)`,
            ids,
          )
          ctx.q.run('DELETE FROM payee_category_stats WHERE ledger_id = @ledger AND category_id = @from', ids)
        }
        // Its own list goes (its labels' links with its categories).
        ctx.q.run('DELETE FROM categories WHERE ledger_id = @ledger')
        ctx.q.run('DELETE FROM category_groups WHERE ledger_id = @ledger')
        ctx.q.run('DELETE FROM labels WHERE ledger_id = @ledger')
        ctx.q.run('DELETE FROM ledger_category_off WHERE ledger_id = @ledger')
        for (const [id, archivedAt] of off) {
          if (archivedAt) ctx.q.run('INSERT INTO ledger_category_off (ledger_id, category_id, archived_at) VALUES (@ledger, @id, @archivedAt)', { id, archivedAt })
        }
        // Custom reports follow, losing the categories, groups and labels that went. Groups and labels are matched by name.
        const shared = readCatalog(db)
        const byName = (former: Array<{ id: number; name: string }>, now: Array<{ id: number; name: string }>) =>
          new Map(former.map((f) => [f.id, now.find((x) => x.name.toLowerCase() === f.name.toLowerCase())?.id ?? null]))
        if (hasReports(ctx)) joinCategoryRefs(ctx, {
          category: { to: map, names: new Map(own.map((c) => [c.id, c.name])) },
          group: { to: byName(ownGroups, shared.groups), names: new Map(ownGroups.map((g) => [g.id, g.name])) },
          label: { to: byName(ownLabelNames, shared.labels), names: new Map(ownLabelNames.map((l) => [l.id, l.name])) },
        })
      })
    }),
  )
}
