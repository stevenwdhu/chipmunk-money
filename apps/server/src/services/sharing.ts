import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { addDays, addMonths, formatMoney, monthOf, monthRange, type Account, type AccountSharing, type ISODate } from '@chipmunk/shared'
import { aiEnabled } from '../ai/runner'
import { ledgers as ledgersTable } from '../db/schema'
import { badRequest } from '../lib/http'
import type { AccountLedger } from './account-rows'
import { balancesAt, currentParts, getAccount, requireHome } from './accounts'
import { recordActivity, type ActivityActor } from './activity'
import type { AppContext, CtxOf } from './context'
import { categorizeUncategorized } from './import'
import { getInstitution, removeIfEmpty, resolveInstitution } from './institutions'
import { MOVE_LIMIT, moveTransactions, sendAsDeleted } from './moves'
import { today } from './settings'

/**
 * Sharing an account with other ledgers. The account stays in its home (accounts.ledger_id), and
 * each other ledger it's shared with has a member row (account_ledgers) with its own institution,
 * sort order and archive, written through that ledger's own context. Sharing is changed in the
 * home only. Nothing moves when a ledger is added: each ledger holds the rows it held. The home can
 * change to a ledger the account is shared with, and nothing already recorded moves then either. A
 * ledger that stops sharing it gives its rows to the home. setSharing does all three in one go.
 */

/** "3 transactions", "1 recurring item". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Thrown to end a dry run's transaction: a throw out of a transaction rolls it back. */
const ROLL_BACK = new Error('dry run')

/** A ledger, by name, as the answers give it. */
interface LedgerName {
  slug: string
  name: string
}

const named = (l: LedgerName): LedgerName => ({ slug: l.slug, name: l.name })

function ledgerArchived(ctx: AppContext, ledgerId: string): boolean {
  return !!ctx.app.db.select({ archivedAt: ledgersTable.archivedAt }).from(ledgersTable).where(eq(ledgersTable.id, ledgerId)).get()?.archivedAt
}

/** A ledger by its slug: a 400 when there's none. */
function ledgerBySlug(ctx: AppContext, slug: string): LedgerName & { id: string } {
  const row = ctx.app.db.select({ id: ledgersTable.id, slug: ledgersTable.slug, name: ledgersTable.name }).from(ledgersTable).where(eq(ledgersTable.slug, slug)).get()
  if (!row) badRequest(`There’s no ledger “${slug}”.`)
  return row
}

/** The account, as this ledger sees it, and the ledgers that have it. A 409 naming the home when this ledger isn't the home. */
function inHome(ctx: AppContext, accountId: number): { account: Account; ledgers: AccountLedger[]; home: AccountLedger } {
  requireHome(ctx, accountId, 'sharing')
  const account = getAccount(ctx, accountId)
  const ledgers = ctx.accountWide.ledgers(accountId)
  return { account, ledgers, home: ledgers.find((l) => l.isHome)! }
}

/**
 * Refuses to delete, erase or clear a ledger that is a shared account's home, or whose part carries
 * one's opening balance: the account would be left without its home or that balance. A 409 naming
 * the account and another ledger that has it, then what to do first (`then`). Run it before the
 * safety copy and the transaction. A ledger an account is only shared with can go, and its member
 * row goes with it.
 */
export function refuseWhileSharing(ctx: AppContext, then = 'Stop sharing it first.'): void {
  for (const accountId of ctx.accountWide.sharedAccounts(ctx.ledger.id)) {
    const ledgers = ctx.accountWide.ledgers(accountId)
    const here = ledgers.find((l) => l.ledgerId === ctx.ledger.id)
    if (!here?.isHome && !here?.isOpening) continue
    const other = ledgers.find((l) => l.ledgerId !== ctx.ledger.id)!
    throw new HTTPException(409, { message: `${ctx.accountWide.account(accountId)!.name} is shared with ${other.name}. ${then}` })
  }
}

/**
 * How an account of this ledger is shared: its home (this ledger), its opening ledger, and each
 * other ledger it's shared with, each with how many transactions it holds on it and its part of
 * the balance. An account that isn't shared, of any type, has no members.
 */
export function getSharing(ctx: AppContext, accountId: number): AccountSharing {
  const { ledgers, home } = inHome(ctx, accountId)
  const { totalMinor, parts } = currentParts(ctx, accountId)
  const counts = new Map(ctx.accountWide.held(accountId).map((h) => [h.ledgerId, h.count]))
  const part = (l: AccountLedger) => ({
    slug: l.slug,
    name: l.name,
    archived: l.archived,
    transactionCount: counts.get(l.ledgerId) ?? 0,
    balanceMinor: parts.get(l.ledgerId) ?? 0,
  })
  const opening = ledgers.find((l) => l.isOpening) ?? home
  return {
    accountId,
    home: part(home),
    opening: { slug: opening.slug, name: opening.name },
    members: ledgers.filter((l) => !l.isHome).map(part),
    totalBalanceMinor: totalMinor,
  }
}

/** Each ledger's part of the account today, by slug. */
function partsToday(ctx: AppContext, accountId: number): Record<string, number> {
  const { parts } = currentParts(ctx, accountId)
  return Object.fromEntries(ctx.accountWide.ledgers(accountId).map((l) => [l.slug, parts.get(l.ledgerId) ?? 0]))
}

/**
 * Shares the account with one more ledger, in a transaction. It gets the account under an
 * institution of its own with the home institution's name (found, or added), after its other
 * accounts. Refused (400) unless the account is a credit card, or when the ledger is archived.
 */
function addLedger(ctx: AppContext, ctxOf: CtxOf, account: Account, home: AccountLedger, ledgerId: string, actor: ActivityActor) {
  if (account.type !== 'credit') badRequest(`Only credit cards can be shared for now, and ${account.name} isn’t one.`)
  const member = ctxOf(ledgerId)
  if (ledgerArchived(ctx, ledgerId)) badRequest(`${member.ledger.name} is archived, so ${account.name} can’t be shared with it.`)

  ctx.q.transaction(() => {
    const placed = resolveInstitution(member, { institution: account.institution })
    const sort = member.q.pluck<number>('SELECT coalesce(max(sort), -1) FROM ledger_accounts WHERE ledger_id = @ledger')! + 1
    member.q.run('INSERT INTO account_ledgers (ledger_id, account_id, institution_id, sort) VALUES (@ledger, @accountId, @institutionId, @sort)', {
      accountId: account.id,
      institutionId: placed.id,
      sort,
    })
    if (placed.created) {
      const i = getInstitution(member, placed.id)
      recordActivity(member, actor, { action: 'create', entity: 'institution', entityId: i.id, summary: `Added the institution ${i.name}`, after: i })
    }
    recordActivity(ctx, actor, {
      action: 'share',
      entity: 'account',
      entityId: account.id,
      summary: `Shared ${account.name} with ${member.ledger.name}`,
      after: { ledger: member.ledger.slug },
    })
    recordActivity(member, actor, {
      action: 'share',
      entity: 'account',
      entityId: account.id,
      summary: `${home.name} shared ${account.name} with this ledger, at ${account.institution}`,
      after: { home: home.slug },
    })
  })
}

/**
 * Shares a credit card of this ledger (its home) with another ledger. The other ledger gets it under
 * an institution of its own with the home institution's name (found, or added), after its other
 * accounts. Nothing moves, so no balance changes. Activity in both ledgers.
 */
export function addMember(ctx: AppContext, ctxOf: CtxOf, accountId: number, ledgerId: string, actor: ActivityActor): AccountSharing {
  const { account, ledgers, home } = inHome(ctx, accountId)
  if (account.type !== 'credit') badRequest(`Only credit cards can be shared for now, and ${account.name} isn’t one.`)
  if (ledgerArchived(ctx, home.ledgerId)) badRequest(`${home.name} is archived. Restore it before sharing ${account.name}.`)
  const already = ledgers.find((l) => l.ledgerId === ledgerId)
  if (already) throw new HTTPException(409, { message: `${already.name} already has ${account.name}.` })
  addLedger(ctx, ctxOf, account, home, ledgerId, actor)
  return getSharing(ctx, accountId)
}

/**
 * The dates a home change is checked at: today, each month's end over the last two years, and each
 * recorded balance's day and the day before it, and the opening date's (read in the home).
 */
function checkedDates(home: AppContext, accountId: number): ISODate[] {
  const t = today(home)
  const months = Array.from({ length: 24 }, (_, i) => monthRange(addMonths(monthOf(t), -(i + 1))).to)
  const recorded = home.q.column<ISODate>(
    'SELECT s.date FROM balance_snapshots s JOIN ledger_accounts a ON a.id = s.account_id AND a.ledger_id = @ledger WHERE s.account_id = ?',
    accountId,
  )
  const opening = home.accountWide.account(accountId)?.openingDate
  const around = [...recorded, ...(opening ? [opening] : [])].flatMap((d) => [addDays(d, -1), d])
  return [...new Set([...months, ...around, t])].sort()
}

/** Each ledger's part of the account, by slug in order: today's (every live row), then at each of `dates`. */
function partsAt(ctx: AppContext, ctxOf: CtxOf, accountId: number, dates: ISODate[]): Array<[string, number[]]> {
  const { parts } = currentParts(ctx, accountId)
  return ctx.accountWide
    .ledgers(accountId)
    .map((l): [string, number[]] => [l.slug, [parts.get(l.ledgerId) ?? 0, ...(balancesAt(ctxOf(l.ledgerId), dates).get(accountId) ?? [])]])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The home change itself, in the caller's transaction: checks the new home, runs the change
 * (changeHome, through ctx.accountWide), and checks that no ledger's part changed at any date it
 * can tell, or throws. Activity in both ledgers.
 */
function swapHome(ctx: AppContext, ctxOf: CtxOf, account: Account, toLedgerId: string, actor: ActivityActor): { from: LedgerName; to: LedgerName } {
  const ledgers = ctx.accountWide.ledgers(account.id)
  const home = ledgers.find((l) => l.isHome)!
  if (toLedgerId === home.ledgerId) badRequest(`${home.name} is ${account.name}’s home already.`)
  const to = ledgers.find((l) => l.ledgerId === toLedgerId)
  if (!to) badRequest(`${account.name} isn’t shared with that ledger.`)
  if (to.archived) badRequest(`${to.name} is archived, so it can’t be ${account.name}’s home.`)

  const toCtx = ctxOf(to.ledgerId)
  const dates = checkedDates(ctx, account.id)
  const before = partsAt(ctx, ctxOf, account.id, dates)
  const { payloadsCleared } = ctx.accountWide.changeHome(account.id, toCtx)
  const after = partsAt(toCtx, ctxOf, account.id, dates)
  // Nothing already recorded moves, so no ledger's balance on it changes, today or before.
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`Changing ${account.name}’s home from ${home.slug} to ${to.slug} would change its parts: ${JSON.stringify({ dates, before, after })}`)
  }

  const change = { before: { home: home.slug }, after: { home: to.slug, payloadsCleared } }
  recordActivity(ctx, actor, { action: 'change_home', entity: 'account', entityId: account.id, summary: `Made ${to.name} ${account.name}’s home`, ...change })
  recordActivity(toCtx, actor, { action: 'change_home', entity: 'account', entityId: account.id, summary: `${home.name} made this ledger ${account.name}’s home`, ...change })
  return { from: named(home), to: named(to) }
}

/**
 * Makes another ledger the account is shared with its home, in one transaction. New transactions
 * from sync and CSV land there from now on, and its bank link, recorded balances, import mapping
 * and the account's own settings go with it. Every row stays in the ledger that holds it, every
 * import batch in the ledger that made it, and the opening balance where it is, so no ledger's
 * balance on it changes at any date (checked, or it all rolls back). The old home is a member from
 * then on, and keeps being the opening ledger. Refused under a member (409), and when the ledger
 * isn't a member, is archived, or is the home already (400). Activity in both ledgers. Returns the
 * sharing as the new home has it.
 */
export function changeHome(homeCtx: AppContext, ctxOf: CtxOf, accountId: number, toLedgerId: string, actor: ActivityActor): AccountSharing {
  const { account } = inHome(homeCtx, accountId)
  homeCtx.q.transaction(() => swapHome(homeCtx, ctxOf, account, toLedgerId, actor))
  return getSharing(ctxOf(toLedgerId), accountId)
}

/** What happens to a leaving ledger's transactions on the account: they go home, or stay in it on an account of their own. */
export type RowsChoice = 'home' | 'keep'

/** What a ledger that stopped sharing the account gave up. */
export interface Left {
  ledger: LedgerName
  /** What was said of its transactions, or null when it had none. */
  rows: RowsChoice | null
  /** Live transactions it moved home. */
  moved: number
  /** Deleted transactions it sent home, still deleted. */
  sentAsDeleted: number
  /** Its recurring items that were on the account, on none now. */
  recurringItems: number
  /** Its imports into the account (it had some only if it was the home once), deleted. */
  importBatches: number
}

/**
 * The leaving ledger's live rows on the account, in chunks of at most MOVE_LIMIT. Rows linked to
 * each other (a purchase and its refund) go in one chunk, so their links are carried home with them.
 */
function moveChunks(member: AppContext, accountId: number): number[][] {
  const ids = member.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NULL ORDER BY date, id', accountId)
  if (ids.length <= MOVE_LIMIT) return ids.length ? [ids] : []
  const links = member.q.all<{ a: number; b: number }>(
    `SELECT l.money_in_id AS a, l.money_out_id AS b FROM transaction_links l
       JOIN transactions i ON i.id = l.money_in_id JOIN transactions o ON o.id = l.money_out_id
     WHERE i.ledger_id = @ledger AND o.ledger_id = i.ledger_id AND i.account_id = ? AND o.account_id = i.account_id
       AND i.deleted_at IS NULL AND o.deleted_at IS NULL`,
    accountId,
  )
  const parent = new Map(ids.map((id) => [id, id]))
  const root = (id: number): number => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(id, r)
    return r
  }
  for (const { a, b } of links) parent.set(root(a), root(b))
  const groups = new Map<number, number[]>()
  for (const id of ids) {
    const r = root(id)
    groups.set(r, [...(groups.get(r) ?? []), id])
  }
  const chunks: number[][] = [[]]
  for (let group of groups.values()) {
    while (group.length) {
      let last = chunks[chunks.length - 1]!
      if (last.length + Math.min(group.length, MOVE_LIMIT) > MOVE_LIMIT) chunks.push((last = []))
      const take = group.slice(0, MOVE_LIMIT - last.length)
      last.push(...take)
      group = group.slice(take.length)
    }
  }
  return chunks.filter((c) => c.length)
}

/**
 * Stops sharing the account with a ledger, in the caller's transaction, through the home's context
 * (`home`) and the leaving ledger's own:
 * 1. If it's the opening ledger, the home becomes the opening ledger. What that alone adds to the
 *    home's part today is returned (`openingBase`): measured before the rows move home, it's the
 *    opening balance and recorded balances' share, not the whole change in the home's part.
 * 2. Its live rows on the account move home (moveTransactions, in chunks, the categorizing deferred
 *    to the caller), and its deleted ones go home still deleted (sendAsDeleted).
 * 3. Its recurring items on the account are on no account from then on.
 * 4. Its imports into the account go (it has some only if it was the home once).
 * 5. Its member row goes, then its institution if no other account is there.
 * Activity in both ledgers. `deferred` is what to categorize in the home once committed.
 */
function leave(
  home: AppContext,
  ctxOf: CtxOf,
  account: Account,
  ledgerId: string,
  rows: RowsChoice | null,
  actor: ActivityActor,
): { left: Left; openingBase: number | null; deferred: number[] } {
  const accountId = account.id
  const leaving = home.accountWide.ledgers(accountId).find((l) => l.ledgerId === ledgerId)!
  const member = ctxOf(ledgerId)

  // 1. The opening ledger, measured before any row moves.
  let openingBase: number | null = null
  if (leaving.isOpening) {
    const before = currentParts(home, accountId).parts.get(home.ledger.id) ?? 0
    const { changes } = home.q.run('UPDATE accounts SET opening_ledger_id = NULL WHERE ledger_id = @ledger AND id = ?', accountId)
    if (changes !== 1) throw new Error(`Expected to give account ${accountId}'s opening balance to its home, changed ${changes}`)
    openingBase = (currentParts(home, accountId).parts.get(home.ledger.id) ?? 0) - before
  }

  // 2. Its rows, live then deleted.
  let moved = 0
  const deferred: number[] = []
  for (const ids of moveChunks(member, accountId)) {
    const result = moveTransactions(member, ctxOf, { ids, to: home.ledger.id, defer: true }, actor)
    moved += result.moved
    deferred.push(...result.deferred!)
  }
  const gone = member.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NOT NULL ORDER BY id', accountId)
  let sentAsDeleted = 0
  for (let i = 0; i < gone.length; i += MOVE_LIMIT) sentAsDeleted += sendAsDeleted(member, ctxOf, { ids: gone.slice(i, i + MOVE_LIMIT), to: home.ledger.id })

  // 3 and 4. Its recurring items and imports.
  const recurringItems = member.q.run('UPDATE recurring_items SET account_id = NULL WHERE ledger_id = @ledger AND account_id = ?', accountId).changes
  const importBatches = member.q.run('DELETE FROM import_batches WHERE ledger_id = @ledger AND account_id = ?', accountId).changes

  // 5. Its member row, and its institution.
  const institutionId = member.q.pluck<number>('SELECT institution_id FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', accountId)!
  const { changes } = member.q.run('DELETE FROM account_ledgers WHERE ledger_id = @ledger AND account_id = ?', accountId)
  if (changes !== 1) throw new Error(`Expected to remove one member row of account ${accountId}, removed ${changes}`)
  const left: Left = { ledger: named(leaving), rows, moved, sentAsDeleted, recurringItems, importBatches }
  const after = { rows, moved, sentAsDeleted, recurringItems, importBatches, ...(openingBase === null ? {} : { openingBaseMinor: openingBase }) }
  recordActivity(home, actor, {
    action: 'stop_sharing',
    entity: 'account',
    entityId: accountId,
    summary: `Stopped sharing ${account.name} with ${member.ledger.name}`,
    before: { ledger: member.ledger.slug },
    after,
  })
  recordActivity(member, actor, {
    action: 'stop_sharing',
    entity: 'account',
    entityId: accountId,
    summary: `${home.ledger.name} stopped sharing ${account.name} with this ledger`,
    before: { home: home.ledger.slug },
    after,
  })
  const removed = removeIfEmpty(member, institutionId)
  if (removed) {
    recordActivity(member, actor, {
      action: 'delete',
      entity: 'institution',
      entityId: removed.id,
      summary: `Removed the institution ${removed.name}, which had no accounts left`,
      before: removed,
    })
  }
  return { left, openingBase, deferred }
}

/**
 * What a ledger that leaves must be told about its transactions on the account: nothing when it
 * holds none (deleted ones count), else `rows` must say. A 400 when it doesn't.
 */
function rowsChoiceFor(ctx: AppContext, account: Account, leaving: AccountLedger, choice: string | undefined): RowsChoice | null {
  const has = ctx.accountWide.holdings(account.id, leaving.ledgerId)
  if (!has.transactions && !has.deletedTransactions) return null
  if (choice === undefined) {
    const n = has.transactions || has.deletedTransactions
    const what = count(n, has.transactions ? 'transaction' : 'deleted transaction')
    const [go, stay] = n === 1 ? ['goes', 'stays'] : ['go', 'stay']
    badRequest(`Say whether ${leaving.name}’s ${what} ${go} home or ${stay} in ${leaving.name}.`)
  }
  // Keeping them in the leaving ledger, on an account of their own, comes later: until then only "home".
  if (choice === 'keep') badRequest(`Keeping ${leaving.name}’s transactions in ${leaving.name} isn’t available yet. Send them home instead.`)
  if (choice !== 'home') badRequest(`Say “home” or “keep” for ${leaving.name}’s transactions.`)
  return choice
}

export interface SharingInput {
  /** Every ledger that will have the account, by slug, the home included. */
  ledgers: string[]
  /** The home's slug: the current home when left out. It must be in `ledgers`. */
  home?: string
  /** For each ledger taken out that holds transactions on the account, by slug: where they go. */
  rows?: Record<string, string>
}

/** What a sharing change did, or would do in a dry run. */
export interface SharingChange {
  dryRun: boolean
  /** The sharing afterwards, as the home (the new one, after a home change) has it. */
  sharing: AccountSharing
  added: LedgerName[]
  home: { from: LedgerName; to: LedgerName } | null
  removed: Left[]
  /**
   * The opening balance going to the home, because the ledger that had it left. `baseMinor` is what
   * the opening balance and recorded balances alone add to the home's part today, before the leaving
   * ledger's rows come home: not the whole change in its part, which `parts` has.
   */
  opening: { from: LedgerName; to: LedgerName; baseMinor: number } | null
  /** Each ledger's part today, by slug, before and after (a ledger that left has none after). */
  parts: { before: Record<string, number>; after: Record<string, number> }
  /** What to tell the owner about it, in words. */
  notices: string[]
}

/**
 * Changes how an account of this ledger (its home) is shared, in one transaction: `ledgers` is every
 * ledger that will have it, the home included, and `home` the one that will be its home (the current
 * one when left out). A list with only the home ends the sharing. In this order:
 * 1. Ledgers added (addLedger).
 * 2. The home change (swapHome), when `home` names another ledger.
 * 3. Ledgers taken out (leave), through the home's context, the new one after a change. A ledger that
 *    holds transactions on it must be told where they go in `rows` (a 400 otherwise): "home" sends
 *    them to the home.
 * Refused: under a member (409), while the home ledger is archived, a ledger that doesn't exist, the
 * current home left out without naming a new one, a home not in the list (400), and what each step
 * refuses. A dry run works it all out and reports it (the counts, each ledger's part before and
 * after, what the opening balance going to the home brings it), then changes nothing. After the commit, and not in
 * a dry run, AI categorizes in the home what came to it uncategorized (when AI is on).
 */
export function setSharing(homeCtx: AppContext, ctxOf: CtxOf, accountId: number, input: SharingInput, opts: { dryRun?: boolean; actor: ActivityActor }): SharingChange {
  const { account, ledgers, home } = inHome(homeCtx, accountId)
  if (ledgerArchived(homeCtx, home.ledgerId)) badRequest(`${home.name} is archived. Restore it before changing how ${account.name} is shared.`)
  const wanted = [...new Map(input.ledgers.map((slug) => ledgerBySlug(homeCtx, slug)).map((l) => [l.id, l])).values()]
  if (!wanted.length) badRequest(`List the ledgers that will have ${account.name}, its home included.`)
  if (input.home === undefined && !wanted.some((l) => l.id === home.ledgerId)) {
    badRequest(`${home.name} is ${account.name}’s home. Keep it in the list, or name the new home.`)
  }
  const newHome = input.home === undefined ? { id: home.ledgerId, slug: home.slug, name: home.name } : ledgerBySlug(homeCtx, input.home)
  if (!wanted.some((l) => l.id === newHome.id)) badRequest(`${newHome.name} isn’t in the list, so it can’t be ${account.name}’s home.`)
  const adds = wanted.filter((l) => !ledgers.some((m) => m.ledgerId === l.id))
  const removes = ledgers.filter((m) => !wanted.some((l) => l.id === m.ledgerId)).map((m) => ({ ledger: m, rows: rowsChoiceFor(homeCtx, account, m, input.rows?.[m.slug]) }))

  const before = partsToday(homeCtx, accountId)
  const homeAfter = newHome.id === home.ledgerId ? homeCtx : ctxOf(newHome.id)
  let report: SharingChange
  const deferred: number[] = []
  const run = () => {
    for (const l of adds) addLedger(homeCtx, ctxOf, account, home, l.id, opts.actor)
    const changed = newHome.id === home.ledgerId ? null : swapHome(homeCtx, ctxOf, account, newHome.id, opts.actor)
    const removed: Left[] = []
    let opening: SharingChange['opening'] = null
    for (const r of removes) {
      const out = leave(homeAfter, ctxOf, account, r.ledger.ledgerId, r.rows, opts.actor)
      removed.push(out.left)
      deferred.push(...out.deferred)
      if (out.openingBase !== null) opening = { from: named(r.ledger), to: named(newHome), baseMinor: out.openingBase }
    }

    const sharing = getSharing(homeAfter, accountId)
    const notices: string[] = []
    if (changed) {
      const kept = sharing.opening.slug === newHome.slug ? '' : ` ${sharing.opening.name} keeps ${account.name}’s opening balance, and differences with the bank still land in ${sharing.opening.name}.`
      notices.push(`${newHome.name} is the home from now on.${kept}`)
    }
    if (opening) {
      notices.push(
        `${account.name}’s opening balance and recorded balances move to ${opening.to.name}: ${formatMoney(opening.baseMinor, account.currency)} of its balance today, and earlier balances shift too.`,
      )
    }
    report = {
      dryRun: !!opts.dryRun,
      sharing,
      added: adds.map(named),
      home: changed,
      removed,
      opening,
      parts: { before, after: partsToday(homeAfter, accountId) },
      notices,
    }
    if (opts.dryRun) throw ROLL_BACK
  }

  try {
    homeCtx.q.transaction(run)
  } catch (err) {
    if (err !== ROLL_BACK) throw err
  }
  if (!opts.dryRun && deferred.length && aiEnabled(homeAfter)) void categorizeUncategorized(homeAfter, { ids: [...new Set(deferred)] })
  return report!
}

/**
 * Stops sharing an account of this ledger (its home) with another ledger (setSharing with every
 * ledger but that one). A ledger that holds transactions on it must be told where they go (`rows`):
 * "home" moves them to the home. Activity in both ledgers.
 */
export function removeMember(
  ctx: AppContext,
  ctxOf: CtxOf,
  accountId: number,
  ledgerId: string,
  actor: ActivityActor,
  opts: { rows?: RowsChoice; dryRun?: boolean } = {},
): AccountSharing {
  const { account, ledgers, home } = inHome(ctx, accountId)
  if (ledgerId === home.ledgerId) badRequest(`${home.name} is ${account.name}’s home, so it keeps the account.`)
  const leaving = ledgers.find((l) => l.ledgerId === ledgerId)
  if (!leaving) badRequest(`${account.name} isn’t shared with that ledger.`)
  const input: SharingInput = { ledgers: ledgers.filter((l) => l !== leaving).map((l) => l.slug), ...(opts.rows ? { rows: { [leaving.slug]: opts.rows } } : {}) }
  return setSharing(ctx, ctxOf, accountId, input, { dryRun: opts.dryRun, actor }).sharing
}
