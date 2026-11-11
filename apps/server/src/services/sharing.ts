import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import type { Account, AccountSharing } from '@chipmunk/shared'
import { ledgers as ledgersTable } from '../db/schema'
import { badRequest } from '../lib/http'
import type { AccountLedger } from './account-rows'
import { currentParts, getAccount, requireHome } from './accounts'
import { recordActivity, type ActivityActor } from './activity'
import type { AppContext, CtxOf } from './context'
import { getInstitution, removeIfEmpty, resolveInstitution } from './institutions'

/**
 * Sharing an account with other ledgers. The account stays in its home (accounts.ledger_id), and
 * each other ledger it's shared with has a member row (account_ledgers) with its own institution,
 * sort order and archive, written through that ledger's own context. Sharing is changed in the
 * home only. Nothing moves when a ledger is added: each ledger holds the rows it held.
 */

/** "3 transactions", "1 recurring item". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function ledgerArchived(ctx: AppContext, ledgerId: string): boolean {
  return !!ctx.app.db.select({ archivedAt: ledgersTable.archivedAt }).from(ledgersTable).where(eq(ledgersTable.id, ledgerId)).get()?.archivedAt
}

/** The account, as this ledger sees it, and the ledgers that have it. A 409 naming the home when this ledger isn't the home. */
function inHome(ctx: AppContext, accountId: number): { account: Account; ledgers: AccountLedger[]; home: AccountLedger } {
  requireHome(ctx, accountId, 'sharing')
  const account = getAccount(ctx, accountId)
  const ledgers = ctx.accountWide.ledgers(accountId)
  return { account, ledgers, home: ledgers.find((l) => l.isHome)! }
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
  const member = ctxOf(ledgerId)
  if (ledgerArchived(ctx, ledgerId)) badRequest(`${member.ledger.name} is archived, so ${account.name} can’t be shared with it.`)

  ctx.q.transaction(() => {
    const placed = resolveInstitution(member, { institution: account.institution })
    const sort = member.q.pluck<number>('SELECT coalesce(max(sort), -1) FROM ledger_accounts WHERE ledger_id = @ledger')! + 1
    member.q.run('INSERT INTO account_ledgers (ledger_id, account_id, institution_id, sort) VALUES (@ledger, @accountId, @institutionId, @sort)', {
      accountId,
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
      entityId: accountId,
      summary: `Shared ${account.name} with ${member.ledger.name}`,
      after: { ledger: member.ledger.slug },
    })
    recordActivity(member, actor, {
      action: 'share',
      entity: 'account',
      entityId: accountId,
      summary: `${home.name} shared ${account.name} with this ledger, at ${account.institution}`,
      after: { home: home.slug },
    })
  })
  return getSharing(ctx, accountId)
}

/**
 * Stops sharing an account of this ledger (its home) with another ledger that has nothing on it:
 * no transaction (deleted ones count), recurring item or import, and not its opening balance. Its
 * member row goes, through its own context, then its institution when no other account is there.
 * Activity in both ledgers.
 */
export function removeMember(ctx: AppContext, ctxOf: CtxOf, accountId: number, ledgerId: string, actor: ActivityActor): AccountSharing {
  const { account, ledgers, home } = inHome(ctx, accountId)
  if (ledgerId === home.ledgerId) badRequest(`${home.name} is ${account.name}’s home, so it keeps the account.`)
  const leaving = ledgers.find((l) => l.ledgerId === ledgerId)
  if (!leaving) badRequest(`${account.name} isn’t shared with that ledger.`)
  if (leaving.isOpening) {
    throw new HTTPException(409, { message: `${leaving.name} carries ${account.name}’s opening balance, so it can’t stop sharing it yet.` })
  }
  const has = ctx.accountWide.holdings(accountId, ledgerId)
  const transactions = has.transactions + has.deletedTransactions
  const what = [
    transactions && `${count(transactions, 'transaction')}${has.deletedTransactions ? ` (${has.deletedTransactions} deleted)` : ''}`,
    has.recurringItems && count(has.recurringItems, 'recurring item'),
    has.importBatches && count(has.importBatches, 'import'),
  ].filter(Boolean)
  if (what.length) {
    throw new HTTPException(409, { message: `${leaving.name} still has ${what.join(' and ')} on ${account.name}, so it can’t stop sharing it yet.` })
  }

  const member = ctxOf(ledgerId)
  ctx.q.transaction(() => {
    const institutionId = member.q.pluck<number>('SELECT institution_id FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?', accountId)!
    const { changes } = member.q.run('DELETE FROM account_ledgers WHERE ledger_id = @ledger AND account_id = ?', accountId)
    if (changes !== 1) throw new Error(`Expected to remove one member row of account ${accountId}, removed ${changes}`)
    recordActivity(ctx, actor, {
      action: 'stop_sharing',
      entity: 'account',
      entityId: accountId,
      summary: `Stopped sharing ${account.name} with ${member.ledger.name}`,
      before: { ledger: member.ledger.slug },
    })
    recordActivity(member, actor, {
      action: 'stop_sharing',
      entity: 'account',
      entityId: accountId,
      summary: `${home.name} stopped sharing ${account.name} with this ledger`,
      before: { home: home.slug },
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
  })
  return getSharing(ctx, accountId)
}
