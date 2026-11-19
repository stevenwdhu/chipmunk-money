import { formatMoney, type CategorySource, type LinkKind } from '@chipmunk/shared'
import { aiEnabled } from '../ai/runner'
import type { MovedCategory } from '../db/move-rows'
import { HTTPException } from 'hono/http-exception'
import { badRequest } from '../lib/http'
import { recordActivity, type ActivityActor } from './activity'
import { upsertTags } from './categories'
import { historySuggestion } from './categorize'
import type { AppContext, CtxOf } from './context'
import { categorizeUncategorized } from './import'
import { releaseTransactionLinks, settleLinkedCategory } from './links'
import { matchTransactions } from './matching'
import { deleteRecurring, detachPayments, itemToCarry, matchRecurring, itemsOf, matchingItem, recalculateRecurring, receiveItem } from './recurring'
import { undoSplitFirst } from './splits'
import { transferCategoryId, unpairTransfer } from './transactions'

/**
 * Moving transactions to another ledger that has their account: a shared account's home, or a
 * ledger it's shared with, either way. A moved row belongs to that ledger only, which treats it as
 * a new transaction: what the old ledger said about it (its links, transfer pair, tags and
 * category) is carried over where it fits there and let go where it doesn't, and the new ledger's
 * own matching and categorizing run on it. A recurring item goes with its payments: moving one of
 * them moves them all, and the item. There's no undo: moving it back is another move, which works
 * it all out again. A ledger giving up an account sends its deleted rows on it away as they are,
 * still deleted (sendAsDeleted). And a new transaction on a shared account goes from the home to
 * the one ledger whose recurring item it's a payment of (routeToItems).
 */

/** The most transactions one move takes. */
export const MOVE_LIMIT = 1000

export interface MoveInput {
  ids: number[]
  /** The ledger they go to, by id. */
  to: string
  /** Work it all out and report it, then change nothing in either ledger. */
  dryRun?: boolean
  /**
   * For a caller that runs the move inside its own transaction: nothing is categorized afterwards,
   * and the rows to categorize in `to` are returned (`deferred`) for the caller to do once it has
   * committed (and not at all in a dry run).
   */
  defer?: boolean
  /**
   * Just these rows: a recurring item stays where it is and lets go of them, as before items moved.
   * For a ledger giving up an account, whose rows on it all go while its items stay its own.
   */
  plain?: boolean
  /**
   * A new row following its recurring item (routeToItems), named here: the activity says so in both
   * ledgers, and the row moves only if that ledger's items take it (a 400 otherwise).
   */
  routed?: string
}

export interface MoveResult {
  moved: number
  /** Links kept, both their sides moving (a purchase with its refund). */
  carried: number
  /** Links let go, one side moving and the other staying. */
  unlinked: number
  /** Transfers no longer paired (each pair once). */
  unpaired: number
  /** Moved rows whose category in `to` isn't the one they had (by name), or that have none there. */
  recategorized: number
  /** Moved rows taken off a recurring item that stayed (`plain`). */
  recurringDetached: number
  /**
   * The recurring items that went with their payments: `payments` of each moved (the picked ones
   * and the rest of them), `left` couldn't (the item stays with those, ended), and `joined` says
   * they're all payments of an item `to` already had for the payee (active, or ended and active again),
   * not of this one made there. One never comes to be beside an active item `to` has for the payee:
   * that move is refused.
   */
  recurringItems: Array<{ itemId: number; item: string; payments: number; left: number; joined: boolean }>
  /** Tags `to` didn't have, added for the moved rows. */
  tagsCreated: number
  /** What `to`'s matching found afterwards (matchTransactions), `cleared` counted. */
  matched: { refunds: number; transfers: number; payments: number; cleared: number }
  /** What the move lets go of, row by row, for a dry run to say before it happens. */
  dropped: {
    links: Array<{ moneyIn: number; moneyOut: number; kind: LinkKind; amountMinor: number }>
    /**
     * Money in that keeps some of its links but loses others: the rest of it, `leftMinor`, is no
     * longer paid back and counts as income in the ledger that holds it (`ledger`, a slug).
     */
    partlyLinked: Array<{ id: number; ledger: string; payee: string; leftMinor: number }>
    pairs: Array<{ id: number; pairId: number }>
    recurring: Array<{ id: number; itemId: number; item: string }>
  }
  /** With `defer`: the rows to categorize in `to` once the caller has committed. Null otherwise. */
  deferred: number[] | null
}

interface MovingRow {
  id: number
  accountId: number
  accountName: string
  accountType: string
  date: string
  amount: number
  currency: string
  payee: string
  name: string | null
  deletedAt: string | null
  transferPairId: number | null
  recurringItemId: number | null
  itemName: string | null
  categoryName: string | null
  /** It's a split row (split_of), or a payment that's split. */
  split: number
}

interface CategoryNow {
  id: number
  categoryId: number | null
  source: CategorySource | null
  confidence: number | null
  needsReview: number
  name: string | null
  excluded: number
}

/** Thrown to roll a transaction back on purpose (a dry run's, and a try at joining an item): a throw out of one rolls it back. */
const ROLL_BACK = new Error('roll back')

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const describe = (r: Pick<MovingRow, 'name' | 'payee' | 'amount' | 'currency' | 'date'>) =>
  `${r.name ?? r.payee} (${formatMoney(r.amount, r.currency)} on ${r.date})`
const json = (values: readonly unknown[]) => JSON.stringify(values)
/** The given rows of the ledger, by a JSON array of ids as the first parameter. */
const THESE = 'id IN (SELECT value FROM json_each(?))'
/** `t` is a split row, or a payment that's split (the given row beside it, in its ledger, names it). */
const SPLIT = '(t.split_of IS NOT NULL OR EXISTS (SELECT 1 FROM transactions g WHERE g.ledger_id = t.ledger_id AND g.split_of = t.id))'

/**
 * Split payments and their split rows don't move: the split is undone first. A 400 naming the
 * payment ("Undo the split of <payment> first"), before anything changes.
 */
function refuseSplitRows(from: AppContext, rows: MovingRow[]): void {
  const split = rows.find((r) => r.split)
  if (split) badRequest(undoSplitFirst(from, split.id)!)
}

/**
 * The rows, read and checked before anything changes: each held by `from` and not deleted, on an
 * account `to` has, `to` not archived, and none of them part of a split. An id another ledger holds and one that doesn't exist get
 * the same 400, so the answer doesn't say which it is. So does a row kept only for its bank id.
 */
function movingRows(from: AppContext, to: AppContext, ids: number[]): MovingRow[] {
  const rows = from.q.all<MovingRow>(
    `SELECT t.id, t.account_id AS accountId, a.name AS accountName, a.type AS accountType, t.date, t.amount_minor AS amount, t.currency, t.payee,
       t.name, t.deleted_at AS deletedAt, t.transfer_pair_id AS transferPairId, t.recurring_item_id AS recurringItemId,
       (SELECT r.title FROM recurring_items r WHERE r.id = t.recurring_item_id AND r.ledger_id = t.ledger_id) AS itemName,
       (SELECT c.name FROM ledger_categories c WHERE c.id = t.category_id AND c.ledger_id = t.ledger_id) AS categoryName, ${SPLIT} AS split
     FROM transactions t JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.${THESE} AND t.bank_id_only = 0
     ORDER BY t.date, t.id`,
    json(ids),
  )
  const found = new Set(rows.map((r) => r.id))
  const missing = ids.find((id) => !found.has(id))
  if (missing !== undefined) badRequest(`There’s no transaction ${missing} in ${from.ledger.name} to move.`)
  const deleted = rows.find((r) => r.deletedAt)
  if (deleted) badRequest(`${describe(deleted)} is deleted. Restore it to move it.`)
  const ledgersOf = new Map<number, ReturnType<AppContext['accountWide']['ledgers']>>()
  for (const r of rows) {
    if (!ledgersOf.has(r.accountId)) ledgersOf.set(r.accountId, from.accountWide.ledgers(r.accountId))
    const there = ledgersOf.get(r.accountId)!.find((l) => l.ledgerId === to.ledger.id)
    if (!there) badRequest(`${r.accountName} isn’t shared with ${to.ledger.name}, so ${describe(r)} can’t move there.`)
    if (there.archived) badRequest(`${to.ledger.name} is archived. Restore it to move transactions to it.`)
  }
  refuseSplitRows(from, rows)
  return rows
}

/** A category in `to`, by its id and name where it's from: itself when `to` uses it too (a shared category), else `to`'s of the same name. */
function categoryThere(to: AppContext, categoryId: number | null, name: string | null): { id: number; excluded: number } | undefined {
  if (categoryId === null) return undefined
  return (
    to.q.get('SELECT id, exclude_from_totals AS excluded FROM ledger_categories WHERE ledger_id = @ledger AND id = ? AND archived_at IS NULL', categoryId) ??
    (name === null
      ? undefined
      : to.q.get(
          'SELECT id, exclude_from_totals AS excluded FROM ledger_categories WHERE ledger_id = @ledger AND lower(name) = lower(?) AND archived_at IS NULL ORDER BY id LIMIT 1',
          name,
        ))
  )
}

/**
 * The picked rows with the rest of their recurring items' payments: a recurring item goes with any
 * of its payments, so the others that can move come along (live, on an account `to` has, not part of
 * a split). The ones that can't are counted (`left`, and `leftMinor` their amounts): the item stays
 * with those. A 400 when that makes more than MOVE_LIMIT.
 */
function withItems(from: AppContext, to: AppContext, picked: number[]): { ids: number[]; items: Array<{ itemId: number; item: string; left: number; leftMinor: number }> } {
  const found = from.q.all<{ itemId: number; item: string }>(
    `SELECT DISTINCT r.id AS itemId, coalesce(r.title, r.name) AS item FROM transactions t JOIN recurring_items r ON r.id = t.recurring_item_id AND r.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.${THESE} AND t.deleted_at IS NULL ORDER BY r.id`,
    json(picked),
  )
  const ids = new Set(picked)
  const shared = new Map<number, boolean>()
  const items = found.map((i) => {
    const payments = from.q.all<{ id: number; accountId: number; amount: number; split: number }>(
      `SELECT t.id, t.account_id AS accountId, t.amount_minor AS amount, ${SPLIT} AS split FROM transactions t
       WHERE t.ledger_id = @ledger AND t.recurring_item_id = ? AND t.deleted_at IS NULL AND t.bank_id_only = 0 ORDER BY t.id`,
      i.itemId,
    )
    for (const p of payments) {
      if (!shared.has(p.accountId)) shared.set(p.accountId, from.accountWide.ledgers(p.accountId).some((l) => l.ledgerId === to.ledger.id))
      if (!p.split && shared.get(p.accountId)) ids.add(p.id)
    }
    const left = payments.filter((p) => !ids.has(p.id))
    return { ...i, left: left.length, leftMinor: left.reduce((s, p) => s + p.amount, 0) }
  })
  if (ids.size > MOVE_LIMIT) {
    badRequest(`With the other payments of ${items.map((i) => i.item).join(', ')} that’s ${ids.size} transactions. Move at most ${MOVE_LIMIT} at a time.`)
  }
  return { ids: [...ids], items }
}

/**
 * Each moved row's category in `to`: its own when `to` uses it too (a shared category), else `to`'s
 * category of the same name, else what `to`'s history suggests for it, as for a new row from a sync
 * or an import (historySuggestion: to review unless it's a payee you always set one way), else none,
 * for `to`'s AI. A row in a category left out of totals (a card payment, a transfer) is never left
 * without one, since money in without a category counts as income: it takes `to`'s card payment or
 * transfer category, as yours. Your history isn't taught anything by it.
 */
function categoriesIn(from: AppContext, to: AppContext, rows: MovingRow[]): Map<number, MovedCategory> {
  const now = from.q.all<CategoryNow>(
    `SELECT t.id, t.category_id AS categoryId, t.category_source AS source, t.category_confidence AS confidence, t.needs_review AS needsReview,
       c.name, coalesce(c.exclude_from_totals, 0) AS excluded
     FROM transactions t LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.${THESE}`,
    json(rows.map((r) => r.id)),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = new Map<number, MovedCategory>()
  for (const c of now) {
    const there = categoryThere(to, c.categoryId, c.name)
    if (c.excluded) {
      const row = byId.get(c.id)!
      const categoryId = there?.excluded ? there.id : transferCategoryId(to, row.accountType)
      if (categoryId === null) badRequest(`${to.ledger.name} has no category for card payments, so ${describe(row)} can’t move there.`)
      out.set(c.id, { categoryId, categorySource: 'user', categoryConfidence: null, needsReview: false })
    } else if (there) {
      out.set(c.id, { categoryId: there.id, categorySource: c.source, categoryConfidence: c.confidence, needsReview: !!c.needsReview })
    } else {
      const row = byId.get(c.id)!
      const s = historySuggestion(to, row.payee, row.amount)
      out.set(
        c.id,
        s?.categoryId
          ? { categoryId: s.categoryId, categorySource: s.source === 'ai' ? 'ai' : 'history', categoryConfidence: s.confidence, needsReview: !s.autoApply }
          : { categoryId: null, categorySource: null, categoryConfidence: null, needsReview: false },
      )
    }
  }
  return out
}

/**
 * Moves transactions from the ledger that holds them (`from`) to another ledger that has their
 * account, in one transaction: all of them or, if one doesn't fit, none (a 400 naming it). Up to
 * MOVE_LIMIT at a time. A caller limited to some ledgers must be allowed in both.
 *
 * 1. Checks each row (movingRows).
 * 2. Links: those between two moving rows are carried over. The others are let go, as for a row
 *    deleted for good (releaseTransactionLinks), and the money in on either side settles its category.
 * 3. A transfer is unpaired on both sides ("not a transfer", without remembering it as a rejected
 *    pair, which can't be kept across ledgers), and the rows' rejected pairs go.
 * 4. Recurring items: an item goes with its payments, so the rest of an item's payments that can
 *    move were added to the rows at the start (withItems), and each item is read to be carried
 *    (itemToCarry). Then the items let go of the rows (detachPayments): nothing of an item may stay
 *    attached to a row as it changes ledger. With `plain` the items stay and that's all.
 * 5. Category in `to` (categoriesIn), from `to`'s history when it has none of its own there.
 * 6. Tags go by name, made in `to` when it has none of that name.
 * 7. Bank payloads that point at them point at no row: only the home's rows have payloads.
 * 8. One UPDATE changes their ledger (moveRows, through ctx.accountWide).
 * 9. In `to`: the carried links and the tags, then the items that came: the payments are those of
 *    its own active item for the payee (or, with none active, the one it ended) when it has one that
 *    takes them all and gives up none of its own, and neither is a plan. Else, with an active item
 *    for the payee there, nothing moves (a 400), and with none the item is made there as it was
 *    (receiveItem), its category by the rule of step 5 without the history. Then its matching (from
 *    the earliest moved date) and its recurring items, each moved row as a new one. In `from`: an item with no payment left is gone, one that kept some
 *    (they couldn't move) works them out again and is ended, and one that only let go (`plain`)
 *    works them out again.
 * 10. Activity in both ledgers.
 * 11. Nothing refers across the two ledgers afterwards, or it all rolls back.
 * After the commit, not in a dry run and not deferred: AI categorizes, in `to`, the moved rows
 * left without a category and the ones `to`'s matching uncategorized again (`cleared`), as after a
 * sync (and, as there, not money onto a card that isn't a reward). A moved id is then not found in
 * `from`.
 */
export function moveTransactions(fromCtx: AppContext, ctxOf: CtxOf, input: MoveInput, actor: ActivityActor): MoveResult {
  const picked = [...new Set(input.ids)]
  if (!picked.length) badRequest('Pick the transactions to move.')
  if (picked.length > MOVE_LIMIT) badRequest(`Move at most ${MOVE_LIMIT} transactions at a time.`)
  if (input.to === fromCtx.ledger.id) badRequest(`They’re in ${fromCtx.ledger.name} already.`)
  const toCtx = ctxOf(input.to)
  const from = fromCtx.ledger.id
  const to = toCtx.ledger.id

  let result: MoveResult
  let categorize: number[] = []
  const run = () => {
    const { ids, items } = input.plain ? { ids: picked, items: [] } : withItems(fromCtx, toCtx, picked)
    const rows = movingRows(fromCtx, toCtx, ids)
    const moving = new Set(ids)
    const these = json(ids)

    // 2. Links, read from their money in (a link's two sides are in one ledger).
    const links = fromCtx.q.all<{ moneyIn: number; moneyOut: number; kind: LinkKind; amountMinor: number }>(
      `SELECT l.money_in_id AS moneyIn, l.money_out_id AS moneyOut, l.kind, l.amount_minor AS amountMinor
       FROM transaction_links l JOIN transactions i ON i.id = l.money_in_id
       WHERE i.ledger_id = @ledger AND (l.money_in_id IN (SELECT value FROM json_each(@ids)) OR l.money_out_id IN (SELECT value FROM json_each(@ids)))
       ORDER BY l.id`,
      { ids: these },
    )
    const carried = links.filter((l) => moving.has(l.moneyIn) && moving.has(l.moneyOut))
    const dropped = links.filter((l) => !(moving.has(l.moneyIn) && moving.has(l.moneyOut)))
    const partlyLinked = leftPartlyLinked(fromCtx, toCtx, dropped, moving)
    const moneyIn = [...new Set(links.map((l) => l.moneyIn))]
    releaseTransactionLinks(fromCtx, THESE, these)
    // Releasing settles the money in that stays. The money in that moves settles here: unlinked, it keeps its category as yours.
    for (const id of moneyIn) if (moving.has(id)) settleLinkedCategory(fromCtx, id)

    // 3. Transfers, each pair once (its second side is no longer paired when it comes up), and the rows' rejected pairs.
    const pairs: MoveResult['dropped']['pairs'] = []
    for (const r of rows) {
      if (!r.transferPairId) continue
      const pairId = unpairTransfer(fromCtx, r.id, { reject: false })
      if (pairId !== null) pairs.push({ id: r.id, pairId })
    }
    fromCtx.q.run(`DELETE FROM transfer_rejections WHERE in_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND ${THESE})`, these)
    fromCtx.q.run(`DELETE FROM transfer_rejections WHERE out_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND ${THESE})`, these)

    // 4. Recurring items: the ones that go are read first, then every item lets go of the rows.
    const going = new Map(items.map((i) => [i.itemId, { ...i, carried: itemToCarry(fromCtx, i.itemId, ids), payments: rows.filter((r) => r.recurringItemId === i.itemId).map((r) => r.id) }]))
    const itemCategories = new Map(
      [...going.values()].map((i) => [i.itemId, fromCtx.q.pluck<string>('SELECT name FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', i.carried.categoryId) ?? null]),
    )
    const detached = detachPayments(fromCtx, ids)
    const recurring = rows.flatMap((r) => (r.recurringItemId && !going.has(r.recurringItemId) ? [{ id: r.id, itemId: r.recurringItemId, item: r.itemName ?? '' }] : []))

    // 5. Categories, as they are once the steps above have let go.
    const fields = categoriesIn(fromCtx, toCtx, rows)

    // 6. Tags, by name.
    const tags = fromCtx.q.all<{ txId: number; name: string; color: string | null }>(
      `SELECT tt.transaction_id AS txId, g.name, g.color FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
       WHERE g.ledger_id = @ledger AND tt.transaction_id IN (SELECT value FROM json_each(?))`,
      these,
    )
    fromCtx.q.run(`DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND ${THESE})`, these)

    // 7. Bank payloads: only the home has them, so only a row moving from the home has any.
    fromCtx.q.run(
      `UPDATE bank_payloads SET transaction_id = NULL
       WHERE account_id IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND home_ledger_id = @ledger) AND transaction_id IN (SELECT value FROM json_each(?))`,
      these,
    )

    // 8. The move.
    const moved = fromCtx.accountWide.moveRows({ to: toCtx, ids, fields })

    // 9. In `to`, as new rows: their links, tags, matching and recurring items.
    for (const l of carried) {
      toCtx.q.run('INSERT INTO transaction_links (kind, money_in_id, money_out_id, amount_minor) VALUES (?, ?, ?, ?)', l.kind, l.moneyIn, l.moneyOut, l.amountMinor)
    }
    for (const id of new Set(carried.map((l) => l.moneyIn))) settleLinkedCategory(toCtx, id)
    const tagsCreated = moveTags(toCtx, tags)
    const recurringItems = [...going.values()].map((i) => {
      // `to`'s own active items for the payee take the payments when they take them all and keep every
      // payment they had (an item has one payment for a due date), and neither side is a plan, whose count
      // of payments would be wrong. Otherwise nothing moves: two active items for one payee would take each
      // other's payments. With no active one, an active item that comes tries the newest one `to` ended (the
      // one a move left behind, when the payments come back), active again if it takes them, and else the
      // item is made there.
      const active = itemsOf(toCtx, i.carried.payeeKey)
      const own = active.length || !i.carried.active ? active : itemsOf(toCtx, i.carried.payeeKey, 'ended').filter((o) => !o.plan).slice(-1)
      const theirs = () => toCtx.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND recurring_item_id IN (SELECT value FROM json_each(?))', json(own.map((o) => o.id)))
      let joined = own.length > 0 && ![i.carried, ...own].some((o) => o.plan)
      try {
        if (joined) {
          toCtx.q.transaction(() => {
            const had = theirs()
            if (!active.length) toCtx.q.run(`UPDATE recurring_items SET status = 'active' WHERE ledger_id = @ledger AND ${THESE}`, json(own.map((o) => o.id)))
            for (const o of own) recalculateRecurring(toCtx, o.id, { followAmount: true })
            const have = new Set(theirs())
            if (![...had, ...i.payments].every((id) => have.has(id))) throw ROLL_BACK
          })
        }
      } catch (err) {
        if (err !== ROLL_BACK) throw err
        joined = false
      }
      if (!joined && active.length) {
        badRequest(`${toCtx.ledger.name} already has a recurring item for ${i.carried.payee} that these payments don’t fit. End or change one of the two items, then move them.`)
      }
      if (!joined) {
        receiveItem(toCtx, i.carried, {
          categoryId: categoryThere(toCtx, i.carried.categoryId, itemCategories.get(i.itemId) ?? null)?.id ?? null,
          accountId: toCtx.q.pluck<number>('SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', i.carried.accountId) ?? null,
          txIds: i.payments,
          left: i.left,
          leftMinor: i.leftMinor,
        })
      }
      return { itemId: i.itemId, item: i.item, payments: i.payments.length, left: i.left, joined }
    })
    const earliest = rows.reduce((d, r) => (r.date < d ? r.date : d), rows[0]!.date)
    const match = matchTransactions(toCtx, { earliest })
    const taken = rows.map((r) => matchRecurring(toCtx, r.id))
    if (input.routed && taken[0] == null) badRequest(`${describe(rows[0]!)} isn’t a payment of ${input.routed} in ${toCtx.ledger.name} after all.`)
    // In `from`: an item that went with all its payments is gone, and the others work theirs out without these.
    for (const item of detached) {
      const went = going.get(item.itemId)
      if (went?.left === 0) deleteRecurring(fromCtx, item.itemId)
      else recalculateRecurring(fromCtx, item.itemId, { removed: true, followAmount: true, wasPaidOff: item.wasPaidOff })
      // One that went and also stays, with what couldn't move, is ended here: the next payments are the other ledger's item's.
      if (went?.left) fromCtx.q.run("UPDATE recurring_items SET status = 'ended' WHERE ledger_id = @ledger AND id = ?", item.itemId)
    }

    // 10. Activity.
    const after = { ids, carried: carried.length, unlinked: dropped.length, unpaired: pairs.length, recurringDetached: recurring.length, recurringItems: recurringItems.length }
    const what = moved === 1 ? describe(rows[0]!) : count(moved, 'transaction')
    const withThem = recurringItems.length ? `, with the recurring item${recurringItems.length === 1 ? '' : 's'} ${recurringItems.map((i) => i.item).join(', ')}` : ''
    recordActivity(fromCtx, actor, {
      action: 'move',
      entity: 'transaction',
      summary: input.routed ? `${what} went to ${toCtx.ledger.name}, where it’s a payment of ${input.routed}` : `Moved ${what} to ${toCtx.ledger.name}${withThem}`,
      after: { to: toCtx.ledger.slug, ...after },
    })
    // A routed row comes in as a new one on the account: the ledger that gets it isn't told where its home is.
    recordActivity(toCtx, actor, {
      action: 'move',
      entity: 'transaction',
      summary: input.routed ? `${what} is new on ${rows[0]!.accountName}, a payment of ${input.routed}` : `${fromCtx.ledger.name} moved ${what} to this ledger${withThem}`,
      after: input.routed ? after : { from: fromCtx.ledger.slug, ...after },
    })

    // 11. Nothing crosses the two ledgers.
    const crossing = fromCtx.accountWide.crossings([from, to])
    if (Object.keys(crossing).length) {
      throw new Error(`A move from ${from} to ${to} left references across ledgers: ${Object.entries(crossing).map(([k, n]) => `${n} ${k}`).join(', ')}`)
    }

    const named = new Map(
      toCtx.q
        .all<{ id: number; name: string | null }>(
          `SELECT t.id, (SELECT c.name FROM ledger_categories c WHERE c.id = t.category_id AND c.ledger_id = t.ledger_id) AS name
           FROM transactions t WHERE t.ledger_id = @ledger AND t.${THESE}`,
          these,
        )
        .map((r) => [r.id, r.name]),
    )
    const recategorized = rows.filter((r) => {
      const now = named.get(r.id) ?? null
      return now === null ? r.categoryName !== null : now.toLowerCase() !== r.categoryName?.toLowerCase()
    }).length
    const uncategorized = toCtx.q.column<number>(`SELECT id FROM transactions WHERE ledger_id = @ledger AND category_id IS NULL AND ${THESE}`, these)
    categorize = [...new Set([...uncategorized, ...match.cleared])]

    result = {
      moved,
      carried: carried.length,
      unlinked: dropped.length,
      unpaired: pairs.length,
      recategorized,
      recurringDetached: recurring.length,
      recurringItems,
      tagsCreated,
      matched: { refunds: match.refunds, transfers: match.transfers, payments: match.payments, cleared: match.cleared.length },
      dropped: { links: dropped, partlyLinked, pairs, recurring },
      deferred: input.defer ? categorize : null,
    }
    if (input.dryRun) throw ROLL_BACK
  }

  try {
    fromCtx.q.transaction(run)
  } catch (err) {
    if (err !== ROLL_BACK) throw err
  }
  if (!input.dryRun && !input.defer && categorize.length && aiEnabled(toCtx)) void categorizeUncategorized(toCtx, { ids: categorize })
  return result!
}

/** A new transaction that went to another ledger, where it's a payment of a recurring item. */
export interface Routed {
  id: number
  accountId: number
  /** Its name, or its payee when it has none. */
  payee: string
  /** The ledger it went to, by name. */
  ledger: string
  /** The recurring item there it's a payment of. */
  item: string
}

/**
 * New payments follow their recurring item. Of the transactions a sync or an import just added in
 * the home (`ids`), one that's no payment of an active item in the home, and would be one in exactly
 * one other ledger that has its account and isn't archived (matchingItem, the check matchRecurring
 * links by), moves there, by an ordinary move: that ledger's item takes it and categorizes it. With
 * no such ledger, or two, it stays in the home. So does a card payment or a transfer (a row in a
 * category left out of totals, or paired) and a row linked to another (a purchase and its refund),
 * so run this after the home's matching has found those, and a split row. Nothing is asked of a
 * sync's key: a sync writes in every ledger that has the account as it is. An import's rows are the
 * caller's own choice, so its key's ledgers are given (`usable`, null for all): a row whose item is
 * in a ledger the key can't use stays in the home, and nothing says why. With `defer`, AI
 * categorizes nothing afterwards (a dry run). Returns what went.
 */
export function routeToItems(home: AppContext, ctxOf: CtxOf, ids: number[], actor: ActivityActor, opts: { defer?: boolean; usable?: readonly string[] | null } = {}): Routed[] {
  if (!ids.length) return []
  const rows = home.q.all<{ id: number; accountId: number; date: string; amount: number; payeeKey: string; payee: string }>(
    `SELECT t.id, t.account_id AS accountId, t.date, t.amount_minor AS amount, t.payee_key AS payeeKey, coalesce(t.name, t.payee) AS payee
     FROM transactions t
     WHERE t.ledger_id = @ledger AND t.${THESE} AND t.deleted_at IS NULL AND t.bank_id_only = 0 AND t.recurring_item_id IS NULL AND t.transfer_pair_id IS NULL
       AND NOT ${SPLIT}
       AND NOT EXISTS (SELECT 1 FROM transaction_links l JOIN transactions i ON i.id = l.money_in_id WHERE i.ledger_id = @ledger AND (l.money_in_id = t.id OR l.money_out_id = t.id))
       AND NOT EXISTS (SELECT 1 FROM ledger_categories c WHERE c.ledger_id = t.ledger_id AND c.id = t.category_id AND c.exclude_from_totals <> 0)
     ORDER BY t.date, t.id`,
    json(ids),
  )
  const others = new Map<number, AppContext[]>()
  const routed: Routed[] = []
  for (const r of rows) {
    if (!others.has(r.accountId)) {
      others.set(
        r.accountId,
        home.accountWide
          .ledgers(r.accountId)
          .filter((l) => l.ledgerId !== home.ledger.id && !l.archived)
          .map((l) => ctxOf(l.ledgerId)),
      )
    }
    const there = others.get(r.accountId)!
    if (!there.length || matchingItem(home, r)) continue
    const waiting = there.flatMap((ctx) => {
      const item = matchingItem(ctx, r)
      return item ? [{ ctx, item: ctx.q.pluck<string>('SELECT coalesce(title, name) FROM recurring_items WHERE ledger_id = @ledger AND id = ?', item.id)! }] : []
    })
    if (waiting.length !== 1) continue
    const { ctx, item } = waiting[0]!
    if (opts.usable && !opts.usable.includes(ctx.ledger.id)) continue
    try {
      moveTransactions(home, ctxOf, { ids: [r.id], to: ctx.ledger.id, routed: item, defer: opts.defer }, actor)
    } catch (err) {
      // One that doesn't fit there after all (a 400) stays in the home, as it was.
      if (err instanceof HTTPException && err.status === 400) continue
      throw err
    }
    routed.push({ id: r.id, accountId: r.accountId, payee: r.payee, ledger: ctx.ledger.name, item })
  }
  return routed
}

/**
 * Sends transactions to another ledger that has their account as deleted rows: for a ledger that
 * gives up an account (stopping sharing it, being deleted) and whose rows on it must not come back.
 * A deleted row keeps its bank id, so the account's sync knows it and doesn't add it again. Unlike a
 * move, nothing of what the rows were in `from` is carried over or worked out again in `to`.
 *
 * In `from`: the live ones are deleted (soft), then every link they have goes (the money in that
 * stays settles its category), their transfers are unpaired on both sides, their rejected pairs and
 * tags go, recurring items let go of them (dues and not-payments too) and work out their payments
 * again, and their bank payloads point at no row. Then one UPDATE (moveRows) puts them in `to` with
 * no category, recurring item, transfer pair or import batch. Up to MOVE_LIMIT at a time, all of
 * them held by `from`, and none part of a split (the caller lets those go first, with leaveSplits).
 * Run it inside the caller's transaction. Returns how many went.
 */
export function sendAsDeleted(fromCtx: AppContext, ctxOf: CtxOf, input: { ids: number[]; to: string }): number {
  const ids = [...new Set(input.ids)]
  if (!ids.length) return 0
  if (ids.length > MOVE_LIMIT) throw new Error(`Send at most ${MOVE_LIMIT} transactions at a time, not ${ids.length}`)
  const toCtx = ctxOf(input.to)
  const these = json(ids)
  return fromCtx.q.transaction(() => {
    const held = fromCtx.q.column<number>(`SELECT id FROM transactions WHERE ledger_id = @ledger AND ${THESE}`, these)
    if (held.length !== ids.length) throw new Error(`${fromCtx.ledger.name} holds ${held.length} of the ${ids.length} transactions to send as deleted`)
    // Its splits were let go of first (leaveSplits): a split row or a split payment can't be deleted or leave its ledger.
    const split = fromCtx.q.column<number>(`SELECT t.id FROM transactions t WHERE t.ledger_id = @ledger AND t.${THESE} AND ${SPLIT}`, these)
    if (split.length) throw new Error(`Transactions ${split.join(', ')} are part of a split, which must be let go of before they're sent away (leaveSplits)`)
    const stamp = fromCtx.now().toISOString()
    fromCtx.q.run(`UPDATE transactions SET deleted_at = ? WHERE ledger_id = @ledger AND deleted_at IS NULL AND ${THESE}`, stamp, these)
    // Deleted for good by the ledger leaving, not by the bank: a sync never brings one back.
    fromCtx.q.run(`UPDATE transactions SET removed_at = NULL WHERE ledger_id = @ledger AND removed_at IS NOT NULL AND ${THESE}`, these)

    releaseTransactionLinks(fromCtx, THESE, these)
    // Both sides of each pair, the other one whichever account or state it's in.
    fromCtx.q.run(`UPDATE transactions SET transfer_pair_id = NULL WHERE ledger_id = @ledger AND transfer_pair_id IN (SELECT value FROM json_each(?))`, these)
    fromCtx.q.run(`UPDATE transactions SET transfer_pair_id = NULL WHERE ledger_id = @ledger AND transfer_pair_id IS NOT NULL AND ${THESE}`, these)
    fromCtx.q.run(`DELETE FROM transfer_rejections WHERE in_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND ${THESE})`, these)
    fromCtx.q.run(`DELETE FROM transfer_rejections WHERE out_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND ${THESE})`, these)
    fromCtx.q.run(`DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger AND ${THESE})`, these)
    const detached = detachPayments(fromCtx, ids)
    fromCtx.q.run(
      `UPDATE bank_payloads SET transaction_id = NULL
       WHERE account_id IN (SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND home_ledger_id = @ledger) AND transaction_id IN (SELECT value FROM json_each(?))`,
      these,
    )

    const none: MovedCategory = { categoryId: null, categorySource: null, categoryConfidence: null, needsReview: false }
    const sent = fromCtx.accountWide.moveRows({ to: toCtx, ids, fields: new Map(ids.map((id) => [id, none])) })
    for (const item of detached) recalculateRecurring(fromCtx, item.itemId, { removed: true, followAmount: true, wasPaidOff: item.wasPaidOff })
    return sent
  })
}

/**
 * Sends transactions to another ledger that has their account as rows kept only for their bank ids
 * (transactions.bank_id_only): for a ledger that goes for good (deleted or erased) and whose rows
 * on a shared account are deleted with it. They go as sendAsDeleted sends them, and each one with a
 * bank id is then marked in `to`: deleted for good, which the purge leaves, which can't be restored,
 * edited or moved, and which goes with the account. So the account's sync, a bank switch and a CSV
 * import know it for as long as the account is there, and never add it again. One without a bank id
 * has nothing to be known by: it's an ordinary deleted row in `to`, which the purge removes. The
 * same limits as sendAsDeleted. Run it inside the caller's transaction. Returns how many went.
 */
export function sendAsBankIds(fromCtx: AppContext, ctxOf: CtxOf, input: { ids: number[]; to: string }): number {
  const ids = [...new Set(input.ids)]
  if (!ids.length) return 0
  const toCtx = ctxOf(input.to)
  return fromCtx.q.transaction(() => {
    const sent = sendAsDeleted(fromCtx, ctxOf, { ids, to: input.to })
    toCtx.q.run(`UPDATE transactions SET bank_id_only = 1 WHERE ledger_id = @ledger AND external_id IS NOT NULL AND bank_id_only = 0 AND ${THESE}`, json(ids))
    return sent
  })
}

/**
 * Money in, on either side of the links let go, that keeps some of its links: the ones to bills
 * still in its ledger once the move is done. What's left of it is no longer paid back.
 */
function leftPartlyLinked(
  from: AppContext,
  to: AppContext,
  dropped: Array<{ moneyIn: number }>,
  moving: ReadonlySet<number>,
): MoveResult['dropped']['partlyLinked'] {
  const losing = [...new Set(dropped.map((l) => l.moneyIn))]
  if (!losing.length) return []
  const links = from.q.all<{ moneyIn: number; moneyOut: number; amountMinor: number; amount: number; payee: string; billDeleted: number }>(
    `SELECT l.money_in_id AS moneyIn, l.money_out_id AS moneyOut, l.amount_minor AS amountMinor, i.amount_minor AS amount, i.payee,
       b.deleted_at IS NOT NULL AS billDeleted
     FROM transaction_links l JOIN transactions i ON i.id = l.money_in_id JOIN transactions b ON b.id = l.money_out_id
     WHERE i.ledger_id = @ledger AND b.ledger_id = i.ledger_id AND l.money_in_id IN (SELECT value FROM json_each(?))`,
    json(losing),
  )
  return losing.flatMap((id) => {
    const mine = links.filter((l) => l.moneyIn === id)
    // A link stays when both its sides end up in one ledger: both moving, or both staying.
    const kept = mine.filter((l) => moving.has(l.moneyOut) === moving.has(id) && !l.billDeleted)
    const leftMinor = mine[0]!.amount - kept.reduce((s, l) => s + l.amountMinor, 0)
    if (!kept.length || leftMinor <= 0) return []
    return [{ id, ledger: (moving.has(id) ? to : from).ledger.slug, payee: mine[0]!.payee, leftMinor }]
  })
}

/** The moved rows' tags, by name in `to`: one it doesn't have is added, with its color. Returns how many were added. */
function moveTags(to: AppContext, tags: Array<{ txId: number; name: string; color: string | null }>): number {
  if (!tags.length) return 0
  const names = [...new Set(tags.map((t) => t.name))]
  const had = new Set(to.q.column<string>('SELECT name FROM tags WHERE ledger_id = @ledger AND name IN (SELECT value FROM json_each(?))', json(names)))
  upsertTags(to, names)
  const idOf = new Map(
    to.q
      .all<{ id: number; name: string }>('SELECT id, name FROM tags WHERE ledger_id = @ledger AND name IN (SELECT value FROM json_each(?))', json(names))
      .map((t) => [t.name, t.id]),
  )
  const created = names.filter((n) => !had.has(n))
  for (const name of created) {
    const color = tags.find((t) => t.name === name)!.color
    if (color) to.q.run('UPDATE tags SET color = ? WHERE ledger_id = @ledger AND id = ?', color, idOf.get(name))
  }
  for (const t of tags) to.q.run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', t.txId, idOf.get(t.name))
  return created.length
}
