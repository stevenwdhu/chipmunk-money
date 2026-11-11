import type { Context } from 'hono'
import { z } from 'zod'
import {
  accountBankLinkSchema,
  accountCreateSchema,
  accountSchema,
  accountUpdateSchema,
  activityPageSchema,
  activityQuerySchema,
  aiJobStatusSchema,
  aiUsageSchema,
  backupResultSchema,
  balancePointSchema,
  balanceSnapshotSchema,
  balanceUpdateSchema,
  bankPayloadSchema,
  bulkResultSchema,
  bulkUpdateSchema,
  categoryAmountSchema,
  categoryListSchema,
  ledgerCategoryUpdateSchema,
  categorySharingSchema,
  categoryJoinItemSchema,
  categoryCreateSchema,
  categoryMergeResultSchema,
  categoryMergeSchema,
  categoryGroupSchema,
  customReportCreateSchema,
  customReportOrderSchema,
  customReportSchema,
  customReportUpdateSchema,
  groupCreateSchema,
  groupUpdateSchema,
  labelCategoriesSchema,
  labelCreateSchema,
  labelSchema,
  labelUpdateSchema,
  categorySchema,
  categorySuggestionSchema,
  demoResultSchema,
  formatMoney,
  importBatchSchema,
  importCommitSchema,
  transactionMatchSchema,
  linkCandidateSchema,
  linkedTransactionSchema,
  linkCandidatesQuerySchema,
  transactionLinksSetSchema,
  transactionLinksSetTogetherSchema,
  importPreviewRowSchema,
  importPreviewSchema,
  importResultSchema,
  institutionCreateSchema,
  institutionDeleteQuerySchema,
  institutionSchema,
  institutionUpdateSchema,
  isoDate,
  linkableBankAccountSchema,
  linkPreviewSchema,
  switchResultSchema,
  accountBankPreviewSchema,
  accountBankSwitchSchema,
  monthKey,
  monthOf,
  monthSummarySchema,
  monthTotalsSchema,
  netWorthReportSchema,
  payeeChoiceQuerySchema,
  payeeChoiceSchema,
  payeeNameRuleSchema,
  payeeRenameSchema,
  payeeChoiceUpdateSchema,
  payeeRuleSchema,
  payeeTotalSchema,
  recurringLabel,
  periodSummarySchema,
  RECURRING_STATUSES,
  recurringCreateSchema,
  recurringItemSchema,
  recurringPaymentCandidateSchema,
  recurringPaymentCandidatesQuerySchema,
  recurringPaymentSchema,
  recurringUpdateSchema,
  reorderSchema,
  setupStatusSchema,
  recategorizeSchema,
  suggestCategorySchema,
  tagCreateSchema,
  tagSchema,
  tagTotalSchema,
  tagUpdateSchema,
  tagWithCountSchema,
  transactionCreateSchema,
  transactionPageSchema,
  transactionQuerySchema,
  transactionSchema,
  transactionSpanSchema,
  transactionUpdateSchema,
  trendReportSchema,
  upcomingPaymentSchema,
  type AiUsage,
  type CustomReport,
  type Transaction,
  filterParam,
  FILTER_SIDES,
  payeeSearchQuerySchema,
  payeeSearchResultSchema,
  reportPurchasesSchema,
} from '@chipmunk/shared'
import { HTTPException } from 'hono/http-exception'
import { badRequest } from '../lib/http'
import { actorName, requireLedger, type Actor } from '../api/auth'
import { ApiRouter } from '../api/router'
import { aiEnabled } from '../ai/runner'
import * as accounts from '../services/accounts'
import { activityActors, diff, listActivity, recordActivity, type ActivityEntry } from '../services/activity'
import { joinPreview, requireOwnList, setCategorySharing, usesSharedList, type JoinResolution } from '../services/catalog'
import * as cats from '../services/categories'
import * as customReports from '../services/custom-reports'
import * as labels from '../services/labels'
import * as names from '../services/payee-names'
import { tidyNewPayees } from '../services/payee-tidy'
import * as payees from '../services/payees'
import { suggestCategory } from '../services/categorize'
import type { AppContext } from '../services/context'
import * as imports from '../services/import'
import * as institutions from '../services/institutions'
import { matchTransactions } from '../services/matching'
import * as recurring from '../services/recurring'
import * as reports from '../services/reports'
import { today } from '../services/settings'
import * as setup from '../services/setup'
import { setLinks, setLinksTogether } from '../services/links'
import * as txs from '../services/transactions'
import { latestBankPayload } from '../services/bank/apply'
import type { BankService } from '../services/bank/service'
import type { Storage } from '../storage'

export type LedgerEnv = { Variables: { actor: Actor; ctx: AppContext } }
type C = Context<LedgerEnv>

const rangeQuery = z.object({ from: isoDate, to: isoDate })
const FILTERED =
  ' With `filter` (a ReportFilter as JSON), only what it counts: for spending and for income apart, Only count conditions must all match, any Filter out rule filters out what matches all of its conditions, and picked transactions are filtered out unless put back. Refunds and paybacks are judged by the purchase they’re linked to.'
const filterQuery = z.object({ filter: filterParam.optional() })
const monthsQuery = (min: number, max: number, def: number) => z.coerce.number().int().min(min).max(max).default(def)

/** Columns of the CSV export that hold text from you or your bank (amount is a number, and left alone). */
const CSV_TEXT = new Set(['account', 'payee', 'category', 'categoryGroup', 'notes', 'tags', 'currency'])

export function toCsv(rows: Array<Record<string, unknown>>, text: ReadonlySet<string> = CSV_TEXT): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0]!)
  const esc = (v: unknown, col: string) => {
    let s = v === null || v === undefined ? '' : String(v)
    // Spreadsheets run text that starts like a formula (a payee "=HYPERLINK(…)" from a bank feed):
    // a leading ' keeps it text.
    if (text.has(col) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c], c)).join(','))].join('\n')
}

/** Records a change in this ledger's activity log, as whoever made the request. */
function log(c: C, entry: ActivityEntry) {
  const actor = c.var.actor
  recordActivity(c.var.ctx, { name: actorName(actor), apiKeyId: actor.kind === 'key' ? actor.key.id : null }, entry)
}

/** Whether the caller is a key limited to some ledgers. */
const limitedKey = (c: C) => c.var.actor.kind === 'key' && !!c.var.actor.key.ledgers

/**
 * Bank connections belong to the whole app, so a key limited to some ledgers can only use the bank
 * accounts already syncing into this ledger: the others may be someone else's.
 */
function requireOwnBankAccount(c: C, bank: BankService, bankAccountId: string) {
  if (!limitedKey(c)) return
  if (!bank.available(c.var.ctx.ledger.id).some((b) => b.id === bankAccountId && b.link)) {
    throw new HTTPException(403, {
      message: 'A key limited to some ledgers can only use bank accounts already syncing into this ledger. Link others in the app.',
    })
  }
}

/** A ledger that uses the shared category list changes it in App settings, not here. */
function ownList(c: C) {
  requireOwnList(c.var.ctx)
}

/** Logs an update with only the fields that changed (nothing when nothing did). */
function logUpdate<T extends object>(c: C, entity: string, id: number, summary: string, before: T, after: T) {
  const d = diff(before, after)
  if (d) log(c, { action: 'update', entity, entityId: id, summary, before: d.before, after: d.after })
}

const money = (t: { amountMinor: number; currency?: string }) => formatMoney(t.amountMinor, t.currency ?? 'CAD')
/** " and 2 custom reports" when a category's reports moved with it. */
const andReports = (n: number) => (n ? ` and ${n} custom report${n === 1 ? '' : 's'}` : '')
const describe = (t: Transaction) => `${t.payee} ${money(t)} on ${t.date}`

/** Routes for one ledger's data, mounted at /api/v1/ledgers/:ledger. */
export function ledgerRoutes(storage: Storage, bank: BankService) {
  const r = new ApiRouter<LedgerEnv>({ mount: '/ledgers/:ledger', tag: 'Ledgers', sqlite: storage.sqlite })
  r.hono.use('*', async (c, next) => {
    const ctx = storage.registry.context(c.req.param('ledger')!)
    requireLedger(c.var.actor, ctx.ledger.id)
    c.set('ctx', ctx)
    await next()
  })

  // Transactions ---------------------------------------------------------
  const tx = { tag: 'Transactions' } as const
  r.get(
    '/transactions',
    {
      ...tx,
      scope: 'read',
      summary: 'List transactions',
      description: 'Newest first. Filter by date range, account, category (`none` for uncategorized), tag, recurring item, text, or `needsReview`.',
      query: transactionQuerySchema,
      response: transactionPageSchema,
    },
    (c, { query }) => txs.listTransactions(c.var.ctx, query),
  )
  r.get(
    '/transactions/span',
    { ...tx, scope: 'read', summary: 'Get the date span of transactions', description: 'The earliest and latest transaction dates.', response: transactionSpanSchema },
    (c) => txs.transactionSpan(c.var.ctx),
  )
  r.post(
    '/transactions',
    {
      ...tx,
      scope: 'write',
      summary: 'Create a transaction',
      description:
        'Leave out `categoryId` to let the app suggest one from your history (or AI); suggestions are flagged `needsReview`. With an `externalId` that the account already has, nothing is added and the existing transaction is returned with status 200.',
      body: transactionCreateSchema,
      response: transactionSchema,
      status: 201,
    },
    async (c, { body }) => {
      if (body.externalId) {
        const existing = txs.findByExternalId(c.var.ctx, body.accountId, body.externalId)
        if (existing?.deleted) {
          throw new HTTPException(409, {
            message: `Transaction ${existing.id} with this externalId was deleted. Restore it instead of adding it again.`,
          })
        }
        if (existing) return c.json(txs.getTransaction(c.var.ctx, existing.id), 200)
      }
      const t = await txs.createTransaction(c.var.ctx, body)
      log(c, { action: 'create', entity: 'transaction', entityId: t.id, summary: `Added ${describe(t)}`, after: t })
      void tidyNewPayees(names.worldOf(storage))
      return t
    },
  )
  r.post(
    '/transactions/bulk',
    {
      ...tx,
      scope: 'write',
      summary: 'Change many transactions',
      description:
        'Set a category, add or remove tags, accept suggestions, or delete, for up to 1,000 transactions at once. The result lists each change. Try it with `dryRun=true` first.',
      body: bulkUpdateSchema,
      response: bulkResultSchema,
      dryRun: true,
    },
    (c, { body, dryRun }) => {
      const result = txs.withChanges(c.var.ctx, body.ids, () => txs.bulkUpdate(c.var.ctx, body))
      const what = body.delete ? 'Deleted' : 'Changed'
      if (result.updated) {
        log(c, {
          action: body.delete ? 'bulk_delete' : 'bulk_update',
          entity: 'transaction',
          summary: `${what} ${result.updated} transaction${result.updated === 1 ? '' : 's'}`,
          before: result.changes.map((x) => ({ id: x.id, ...x.before })),
          after: result.changes.map((x) => ({ id: x.id, ...x.after })),
        })
      }
      return { ...result, dryRun }
    },
  )
  r.post(
    '/transactions/accept-all',
    {
      ...tx,
      scope: 'write',
      summary: 'Accept all suggested categories',
      description: 'Confirms the suggested category on every transaction waiting for review, which also teaches the app your habits.',
      response: z.object({ accepted: z.number().int(), dryRun: z.boolean() }),
      dryRun: true,
    },
    (c, { dryRun }) => {
      const accepted = txs.acceptAllSuggestions(c.var.ctx)
      if (accepted) log(c, { action: 'accept_all', entity: 'transaction', summary: `Accepted ${accepted} suggested categor${accepted === 1 ? 'y' : 'ies'}` })
      return { accepted, dryRun }
    },
  )
  r.post(
    '/transactions/match',
    {
      ...tx,
      scope: 'write',
      summary: 'Find refunds and card payments',
      description:
        'Runs the rules that run after each sync and import over transactions from `since` on (all of them when left out): refunds take their purchase’s category, and money onto a credit card is paired with the withdrawal that paid it, or goes in the card payment category. Only uncategorized transactions and suggestions waiting for review change.',
      body: transactionMatchSchema,
      response: z.object({
        refunds: z.number().int(),
        transfers: z.number().int(),
        payments: z.number().int(),
        cleared: z.number().int().describe('Earlier card payment calls that no longer hold (cash back, say), uncategorized again for AI or you.'),
        dryRun: z.boolean(),
      }),
      dryRun: true,
    },
    (c, { body, dryRun }) => {
      const { cleared: clearedIds, ...counts } = matchTransactions(c.var.ctx, { since: body.since ?? '0000-01-01' })
      const result = { ...counts, cleared: clearedIds.length }
      if (!dryRun && clearedIds.length && aiEnabled(c.var.ctx)) void imports.categorizeUncategorized(c.var.ctx, { ids: clearedIds })
      const parts = [
        result.refunds && `${result.refunds} refund${result.refunds === 1 ? '' : 's'}`,
        result.transfers && `${result.transfers} card payment${result.transfers === 1 ? '' : 's'} paired with the withdrawal that paid ${result.transfers === 1 ? 'it' : 'them'}`,
        result.payments && `${result.payments} other card payment${result.payments === 1 ? '' : 's'}`,
        result.cleared && `${result.cleared} earlier card payment${result.cleared === 1 ? '' : 's'} that ${result.cleared === 1 ? 'wasn’t' : 'weren’t'}`,
      ].filter(Boolean)
      if (parts.length) log(c, { action: 'update', entity: 'transaction', summary: `Found ${parts.join(', ')}`, after: result })
      return { ...result, dryRun }
    },
  )
  r.get('/transactions/:id', { ...tx, scope: 'read', summary: 'Get a transaction', response: transactionSchema }, (c, { params }) =>
    txs.getTransaction(c.var.ctx, params.id),
  )
  r.get(
    '/transactions/:id/bank-data',
    {
      ...tx,
      scope: 'read',
      summary: 'Get what the bank last sent for a transaction',
      description:
        'For a synced transaction (deleted ones too): what its current sync service last sent for it, exactly as sent. Null for one you entered or imported, or synced before this was kept.',
      response: bankPayloadSchema.nullable(),
    },
    (c, { params }) => latestBankPayload(c.var.ctx, params.id),
  )
  r.get(
    '/transactions/:id/link-candidates',
    {
      ...tx,
      scope: 'read',
      summary: 'Find what a transaction could pay back, or be paid back by',
      description:
        'In the same currency and any account, with something left to link, not money moving between accounts (a category left out of totals). For money in as a `refund`: purchases from the 6 months before it, of any amount (all of a refund refunds one, even more than it has left), the same or a similar payee first (the same amount first), then the most recent. As a `payback`: bills from 60 days before it to 7 days after, fitting amounts first (it’s a whole share of the bill, or what’s left of it), then the nearest. For money out (a bill): money in from 7 days before it to 60 days after, fitting amounts first, then e-Transfers, then the nearest. With `q` or `categoryId`, any that match, at any date, ranked the same way but the newest first instead of the nearest. Up to 50. Link them with PUT /transactions/{id}/links.',
      query: linkCandidatesQuerySchema,
      response: z.array(linkCandidateSchema),
    },
    (c, { params, query }) => txs.linkCandidates(c.var.ctx, params.id, query),
  )
  r.get(
    '/transactions/:id/links',
    {
      ...tx,
      scope: 'read',
      summary: 'List what a transaction pays back, or what paid it back',
      description: 'Its refunds and paybacks, each with the transaction on the other side.',
      response: z.array(linkedTransactionSchema),
    },
    (c, { params }) => txs.linkedTransactions(c.var.ctx, params.id),
  )
  r.put(
    '/transactions/:id/links',
    {
      ...tx,
      scope: 'write',
      summary: 'Set what a transaction pays back, or what paid it back',
      description:
        'Replaces all of its links. For money in: the purchases or bills it pays back (a `refund` from the merchant, a `payback` from someone sharing the bill), with how much goes to each. For money out: the money in that paid it back. Together they can’t be more than its amount, nor more than what’s left on each. Money in linked in full to one takes its category and follows it, to several has none of its own, and reports count each link in its bill’s category (a payback on the bill’s date). An empty list unlinks it: it keeps its category as yours.',
      body: transactionLinksSetSchema,
      response: transactionSchema,
    },
    (c, { params, body }) => {
      const before = txs.getTransaction(c.var.ctx, params.id)
      setLinks(c.var.ctx, params.id, body.links)
      const after = txs.getTransaction(c.var.ctx, params.id)
      logUpdate(c, 'transaction', after.id, `Linked ${describe(before)}`, before, after)
      return after
    },
  )
  r.put(
    '/transactions/links',
    {
      ...tx,
      scope: 'write',
      summary: 'Set what several money in pays back, together',
      description:
        'Like PUT /transactions/{id}/links for each money in, all at once: all of them change, or none do. For paybacks from a few people for the same bills, each with its part of each bill. Their links are replaced first, so each is checked against the others’ new links.',
      body: transactionLinksSetTogetherSchema,
      response: z.array(transactionSchema),
    },
    (c, { body }) => {
      const ids = body.sets.map((s) => s.id)
      const before = ids.map((id) => txs.getTransaction(c.var.ctx, id))
      setLinksTogether(c.var.ctx, body.sets)
      const after = ids.map((id) => txs.getTransaction(c.var.ctx, id))
      after.forEach((a, i) => logUpdate(c, 'transaction', a.id, `Linked ${describe(before[i]!)}`, before[i]!, a))
      return after
    },
  )
  r.patch(
    '/transactions/:id',
    {
      ...tx,
      scope: 'write',
      summary: 'Update a transaction',
      description: 'Only the fields you send change. Setting `categoryId` also teaches the app for this payee. `tags` replaces all tags.',
      body: transactionUpdateSchema,
      response: transactionSchema,
    },
    (c, { params, body }) => {
      const before = txs.getTransaction(c.var.ctx, params.id)
      const after = txs.updateTransaction(c.var.ctx, params.id, body)
      logUpdate(c, 'transaction', after.id, `Edited ${describe(before)}`, before, after)
      return after
    },
  )
  r.delete(
    '/transactions/:id',
    { ...tx, scope: 'write', summary: 'Delete a transaction', description: 'Deleted transactions can be restored for 30 days. Deleting one side of a transfer deletes both.', status: 204 },
    (c, { params }) => {
      const before = txs.getTransaction(c.var.ctx, params.id)
      txs.deleteTransaction(c.var.ctx, params.id)
      log(c, { action: 'delete', entity: 'transaction', entityId: before.id, summary: `Deleted ${describe(before)}`, before })
    },
  )
  r.post(
    '/transactions/:id/restore',
    { ...tx, scope: 'write', summary: 'Restore a deleted transaction', response: transactionSchema },
    (c, { params }) => {
      const t = txs.restoreTransaction(c.var.ctx, params.id)
      log(c, { action: 'restore', entity: 'transaction', entityId: t.id, summary: `Restored ${describe(t)}`, after: t })
      return t
    },
  )
  r.post(
    '/transactions/:id/accept-suggestion',
    { ...tx, scope: 'write', summary: 'Accept a suggested category', response: transactionSchema },
    (c, { params }) => {
      const before = txs.getTransaction(c.var.ctx, params.id)
      const after = txs.acceptSuggestion(c.var.ctx, params.id)
      logUpdate(c, 'transaction', after.id, `Accepted the category for ${describe(before)}`, before, after)
      return after
    },
  )

  // Institutions ---------------------------------------------------------
  const acc = { tag: 'Accounts' } as const
  /** Logs an institution made along the way (e.g. typed in when adding an account). */
  const logNewInstitution = (c: C, placed: { id: number; created: boolean }) => {
    if (!placed.created) return
    const i = institutions.getInstitution(c.var.ctx, placed.id)
    log(c, { action: 'create', entity: 'institution', entityId: i.id, summary: `Added the institution ${i.name}`, after: i })
  }
  /** An institution goes away with its last account (deleted, or moved to another institution). */
  const removeIfEmpty = (c: C, id: number) => {
    const removed = institutions.removeIfEmpty(c.var.ctx, id)
    if (removed) log(c, { action: 'delete', entity: 'institution', entityId: removed.id, summary: `Removed the institution ${removed.name}, which had no accounts left`, before: removed })
  }
  r.get(
    '/institutions',
    { ...acc, scope: 'read', summary: 'List institutions', description: 'Banks and other places your accounts are held, in their display order.', response: z.array(institutionSchema) },
    (c) => institutions.listInstitutions(c.var.ctx),
  )
  r.post(
    '/institutions',
    { ...acc, scope: 'write', summary: 'Create an institution', body: institutionCreateSchema, response: institutionSchema, status: 201 },
    (c, { body }) => {
      const i = institutions.createInstitution(c.var.ctx, { name: body.name })
      log(c, { action: 'create', entity: 'institution', entityId: i.id, summary: `Added the institution ${i.name}`, after: i })
      return i
    },
  )
  r.post(
    '/institutions/reorder',
    { ...acc, scope: 'write', summary: 'Reorder institutions', description: 'Send institution ids in the new order.', body: reorderSchema, response: z.array(institutionSchema) },
    (c, { body }) => {
      cats.reorder(c.var.ctx, 'institutions', body.ids)
      log(c, { action: 'reorder', entity: 'institution', summary: 'Reordered institutions', after: body.ids })
      return institutions.listInstitutions(c.var.ctx)
    },
  )
  r.patch(
    '/institutions/:id',
    {
      ...acc,
      scope: 'write',
      summary: 'Update an institution',
      body: institutionUpdateSchema,
      response: institutionSchema,
    },
    (c, { params, body }) => {
      const before = institutions.getInstitution(c.var.ctx, params.id)
      const after = institutions.updateInstitution(c.var.ctx, params.id, { name: body.name, sort: body.sort })
      logUpdate(c, 'institution', after.id, `Edited the institution ${before.name}`, before, after)
      return after
    },
  )
  r.delete(
    '/institutions/:id',
    {
      ...acc,
      scope: 'write',
      summary: 'Delete an institution',
      description: 'An institution with accounts needs `moveTo`: its accounts (and its bank match, if that one has none) move there first.',
      query: institutionDeleteQuerySchema,
      status: 204,
    },
    (c, { params, query }) => {
      const { before, movedTo } = institutions.deleteInstitution(c.var.ctx, params.id, query.moveTo)
      log(c, {
        action: 'delete',
        entity: 'institution',
        entityId: before.id,
        summary: movedTo ? `Merged the institution ${before.name} into ${movedTo.name}` : `Deleted the institution ${before.name}`,
        before,
      })
    },
  )

  // Accounts -------------------------------------------------------------
  r.get('/accounts', { ...acc, scope: 'read', summary: 'List accounts', description: 'Includes current balances. Archived accounts come last.', response: z.array(accountSchema) }, (c) =>
    accounts.listAccounts(c.var.ctx),
  )
  r.post(
    '/accounts',
    {
      ...acc,
      scope: 'write',
      summary: 'Create an account',
      description:
        'Give its institution as `institutionId` or `institution` (a name). With `bank`, the account is synced from that bank account (see GET /bank-accounts): it takes the bank account’s transactions kept from its syncs, and its opening balance is set so its balance is the bank’s (when nothing was fetched for it yet, its connection’s next sync does that). Without an institution it goes under the one matched to the bank’s, or a new one named after it.',
      body: accountCreateSchema,
      response: accountSchema,
      status: 201,
    },
    (c, { body }) => {
      const ctx = c.var.ctx
      const { bank: link, institutionId, institution, ...input } = body
      if (link) requireOwnBankAccount(c, bank, link.bankAccountId)
      const remote = link ? bank.available(ctx.ledger.id).find((b) => b.id === link.bankAccountId) : undefined
      if (link && !remote) throw new HTTPException(404, { message: 'That bank account isn’t available to this ledger.' })
      const { a, placed } = ctx.q.transaction(() => {
        // Where you put it, or (synced) the institution named after its bank, added if it's new.
        const placed = institutions.resolveInstitution(
          ctx,
          institutionId !== undefined || institution !== undefined || !remote ? { institutionId, institution } : { institution: remote.institution ?? remote.connectionName },
        )
        const created = accounts.createAccount(ctx, { ...input, institutionId: placed.id, currency: remote?.currency ?? input.currency })
        if (link) bank.linkAccount(ctx, created.id, link)
        return { a: accounts.getAccount(ctx, created.id), placed }
      })
      const filled = link ? bank.fill(ctx, a.id) : null
      logNewInstitution(c, placed)
      log(c, {
        action: 'create',
        entity: 'account',
        entityId: a.id,
        summary: `Added the account ${a.name} at ${a.institution}${remote ? `, synced from “${remote.name}”` : ''}${filled ? ` (${filled.added} transactions)` : ''}`,
        after: a,
      })
      return filled ? accounts.getAccount(ctx, a.id) : a
    },
  )
  r.get(
    '/bank-accounts',
    {
      ...acc,
      scope: 'read',
      summary: 'List bank accounts to sync from',
      description:
        'Accounts at your connected banks that this ledger can sync from: those not synced anywhere yet, and the ones already syncing into this ledger. A key limited to some ledgers sees only the ones already syncing into this ledger.',
      response: z.array(linkableBankAccountSchema),
    },
    (c) => bank.available(c.var.ctx.ledger.id).filter((b) => !limitedKey(c) || b.link),
  )
  r.put(
    '/accounts/:id/bank',
    {
      ...acc,
      scope: 'write',
      summary: 'Switch an account to synced',
      description:
        'Syncs the account from a bank account from now on. It takes the bank account’s transactions kept from its syncs straight away (when nothing was fetched for it yet, its connection’s next sync brings them), all of them unless `syncFrom` says from when. Transactions you already have are matched where the amount, date and payee say so. For an account with transactions, review the switch first with POST /accounts/{id}/bank/preview, since another service words payees differently.',
      body: accountBankLinkSchema,
      response: accountSchema,
    },
    (c, { params, body }) => {
      requireOwnBankAccount(c, bank, body.bankAccountId)
      const { bankAccount } = bank.linkAccount(c.var.ctx, params.id, body)
      const filled = bank.fill(c.var.ctx, params.id)
      const a = accounts.getAccount(c.var.ctx, params.id)
      log(c, {
        action: 'link_bank',
        entity: 'account',
        entityId: a.id,
        summary: `Switched ${a.name} to synced from “${bankAccount.name}” at ${bankAccount.institution ?? 'your bank'}${bankAccount.syncFrom ? `, from ${bankAccount.syncFrom}` : ''}${filled ? `: ${filled.added} added, ${filled.adopted} matched` : ''}`,
      })
      return a
    },
  )
  r.post(
    '/accounts/:id/bank/preview',
    {
      ...acc,
      scope: 'write',
      summary: 'Compare an account with a bank account before switching',
      description:
        'Pairs the bank account’s transactions kept from its syncs (nothing is fetched) with the account’s: the same amount within a day, with the payee telling apart ones with the same amount and day. Lists what’s paired, guessed, nearly the same, and only on one side. Nothing changes. Then POST /accounts/{id}/bank/switch with what to do, or DELETE this when you don’t. Meanwhile the connections involved don’t sync on their own (for 15 minutes at most).',
      body: accountBankPreviewSchema,
      response: linkPreviewSchema,
    },
    (c, { params, body }) => {
      requireOwnBankAccount(c, bank, body.bankAccountId)
      return bank.previewSwitch(c.var.ctx, params.id, body)
    },
  )
  r.delete(
    '/accounts/:id/bank/preview',
    {
      ...acc,
      scope: 'write',
      summary: 'End a switch’s review without switching',
      description: 'The connections the review involved sync on their own again.',
      status: 204,
    },
    (c, { params }) => {
      bank.endReview(c.var.ctx, params.id)
      return undefined
    },
  )
  r.post(
    '/accounts/:id/bank/switch',
    {
      ...acc,
      scope: 'write',
      summary: 'Switch an account to sync from a bank account, as reviewed',
      description:
        'Links the account to the bank account and applies the review, to the same transactions it showed: `pairs` take the bank’s ids, dates and times, the bank’s others are added except `skip`, and yours it doesn’t have are kept except `remove`. Its balance becomes the bank’s. When either side changed since the review (`version`), nothing changes and you get a 409.',
      body: accountBankSwitchSchema,
      response: z.object({ account: accountSchema, result: switchResultSchema }),
    },
    (c, { params, body }) => {
      requireOwnBankAccount(c, bank, body.bankAccountId)
      const { bankAccount, ...result } = bank.switchAccount(c.var.ctx, params.id, body)
      const a = accounts.getAccount(c.var.ctx, params.id)
      log(c, {
        action: 'link_bank',
        entity: 'account',
        entityId: a.id,
        summary: `Switched ${a.name} to sync from “${bankAccount.name}” at ${bankAccount.institution ?? 'your bank'}: ${result.matched} matched, ${result.added} added, ${result.removed} deleted, ${result.kept} kept`,
        after: result,
      })
      return { account: a, result }
    },
  )
  r.delete(
    '/accounts/:id/bank',
    {
      ...acc,
      scope: 'write',
      summary: 'Switch an account to manual',
      description: 'Stops syncing it. Its transactions stay, and you can switch back to synced later without duplicates.',
      response: accountSchema,
    },
    (c, { params }) => {
      const was = bank.unlinkAccount(c.var.ctx, params.id)
      const a = accounts.getAccount(c.var.ctx, params.id)
      log(c, { action: 'unlink_bank', entity: 'account', entityId: a.id, summary: `Switched ${a.name} to manual (was synced from “${was.name}”)` })
      return a
    },
  )
  r.post(
    '/accounts/reorder',
    { ...acc, scope: 'write', summary: 'Reorder accounts', description: 'Send every account id in the new order.', body: reorderSchema, response: z.array(accountSchema) },
    (c, { body }) => {
      cats.reorder(c.var.ctx, 'accounts', body.ids)
      log(c, { action: 'reorder', entity: 'account', summary: 'Reordered accounts', after: body.ids })
      return accounts.listAccounts(c.var.ctx)
    },
  )
  r.get('/accounts/:id', { ...acc, scope: 'read', summary: 'Get an account', response: accountSchema }, (c, { params }) =>
    accounts.getAccount(c.var.ctx, params.id),
  )
  r.patch(
    '/accounts/:id',
    { ...acc, scope: 'write', summary: 'Update an account', description: 'Set `archived` to hide it from lists while keeping its history.', body: accountUpdateSchema, response: accountSchema },
    (c, { params, body }) => {
      const before = accounts.getAccount(c.var.ctx, params.id)
      // The account's own opening balance (a shared account's other ledgers show none of it).
      if (body.openingBalanceMinor !== undefined && body.openingBalanceMinor !== c.var.ctx.accountWide.account(params.id)?.openingBalanceMinor) {
        accounts.requireManualBalance(c.var.ctx, params.id)
      }
      const { institutionId, institution, ...rest } = body
      const placed = institutionId !== undefined || institution !== undefined ? institutions.resolveInstitution(c.var.ctx, { institutionId, institution }) : null
      if (placed) logNewInstitution(c, placed)
      const after = accounts.updateAccount(c.var.ctx, params.id, { ...rest, ...(placed ? { institutionId: placed.id } : {}) })
      logUpdate(c, 'account', after.id, `Edited the account ${before.name}`, before, after)
      if (after.institutionId !== before.institutionId) removeIfEmpty(c, before.institutionId)
      return after
    },
  )
  r.delete(
    '/accounts/:id',
    {
      ...acc,
      scope: 'write',
      summary: 'Delete an account',
      description: 'Deletes the account and all of its transactions, and its institution if no other account is there. To keep the history, archive it instead.',
      status: 204,
    },
    (c, { params }) => {
      const before = accounts.getAccount(c.var.ctx, params.id)
      accounts.deleteAccount(c.var.ctx, params.id)
      log(c, { action: 'delete', entity: 'account', entityId: before.id, summary: `Deleted the account ${before.name}`, before })
      removeIfEmpty(c, before.institutionId)
    },
  )
  r.post(
    '/accounts/:id/balance',
    {
      ...acc,
      scope: 'write',
      summary: 'Record a balance',
      description: 'The account’s balance at the end of `date`. One per day; recording again replaces it. Mostly for investments, loans and property. Not for a synced account, whose balance is the bank’s.',
      body: balanceUpdateSchema,
      response: accountSchema,
    },
    (c, { params, body }) => {
      accounts.requireManualBalance(c.var.ctx, params.id)
      const a = accounts.setBalance(c.var.ctx, params.id, body)
      log(c, { action: 'record_balance', entity: 'account', entityId: a.id, summary: `Recorded ${a.name}’s balance as ${formatMoney(body.balanceMinor, a.currency)} on ${body.date}`, after: body })
      return a
    },
  )
  r.get(
    '/accounts/:id/history',
    {
      ...acc,
      scope: 'read',
      summary: 'Get an account’s balance history',
      description: 'Month-end balances, then today.',
      query: z.object({ months: monthsQuery(2, 60, 12) }),
      response: z.array(balancePointSchema),
    },
    (c, { params, query }) => accounts.accountHistory(c.var.ctx, params.id, query.months, today(c.var.ctx)),
  )
  r.get(
    '/accounts/:id/snapshots',
    { ...acc, scope: 'read', summary: 'List recorded balances', response: z.array(balanceSnapshotSchema) },
    (c, { params }) => accounts.listSnapshots(c.var.ctx, params.id),
  )
  r.delete(
    '/accounts/:id/snapshots/:snapshotId',
    { ...acc, scope: 'write', summary: 'Delete a recorded balance', status: 204 },
    (c, { params }) => {
      accounts.requireManualBalance(c.var.ctx, params.id)
      const before = accounts.deleteSnapshot(c.var.ctx, params.id, params.snapshotId)
      log(c, { action: 'delete_balance', entity: 'account', entityId: params.id, summary: `Deleted the balance recorded on ${before.date}`, before })
    },
  )

  // Categories & tags ----------------------------------------------------
  const cat = { tag: 'Categories' } as const
  r.get(
    '/categories',
    {
      ...cat,
      scope: 'read',
      summary: 'List categories',
      description:
        'This ledger’s categories: every group, category and label, with whether each category is on here (`archived`: off) and how many of its transactions use it. `shared`: they follow the shared list (change it with /categories, app-wide); otherwise the ledger edits its own list here.',
      response: categoryListSchema,
    },
    (c) => ({ ...cats.listCategories(c.var.ctx), shared: usesSharedList(c.var.ctx) }),
  )
  r.patch(
    '/categories/:id',
    {
      ...cat,
      scope: 'write',
      summary: 'Update a category in this ledger',
      description:
        'With the shared list, a ledger only turns categories on and off (`enabled`); turning off one its transactions use needs `moveTo`: the category they move to, or null to leave them uncategorized (409 without it). With its own list, everything can change here.',
      body: ledgerCategoryUpdateSchema,
      response: categorySchema,
    },
    (c, { params, body }) => {
      const { enabled, moveTo, ...rest } = body
      const before = cats.getCategory(c.var.ctx, params.id)
      if (!usesSharedList(c.var.ctx)) {
        const after = cats.updateCategory(c.var.ctx, params.id, { ...rest, ...(enabled === undefined ? {} : { archived: !enabled }) })
        logUpdate(c, 'category', after.id, `Edited the category ${before.name}`, before, after)
        return after
      }
      if (enabled === undefined || Object.values(rest).some((v) => v !== undefined)) {
        throw new HTTPException(409, {
          message: 'This ledger uses the shared category list, so here you can only turn categories on and off. Change the list in App settings → Categories.',
        })
      }
      const { category, moved, reports } = cats.setCategoryEnabled(c.var.ctx, params.id, { enabled, moveTo })
      if (category.archived !== before.archived) {
        const where = moveTo
          ? ` and moved its ${moved} transaction${moved === 1 ? '' : 's'}${andReports(reports)} to ${cats.getCategory(c.var.ctx, moveTo).name}`
          : moved
            ? ` and left its ${moved} transaction${moved === 1 ? '' : 's'} uncategorized`
            : ''
        log(c, {
          action: 'update',
          entity: 'category',
          entityId: category.id,
          summary: category.archived ? `Turned off the category ${category.name}${where}` : `Turned on the category ${category.name}`,
          before: { archived: before.archived },
          after: { archived: category.archived, moved, moveTo: moveTo ?? null },
        })
      }
      return category
    },
  )
  r.get(
    '/categories/sharing',
    {
      ...cat,
      scope: 'read',
      summary: 'Preview joining the shared category list',
      description:
        'For a ledger with its own list: its categories the shared list doesn’t have by name, with how many transactions use each and a shared category that seems to fit. Choose what happens to each with PUT /categories/sharing.',
      response: z.object({ shared: z.boolean(), differing: z.array(categoryJoinItemSchema) }),
    },
    (c) => {
      const shared = usesSharedList(c.var.ctx)
      return { shared, differing: shared ? [] : joinPreview(storage, c.var.ctx) }
    },
  )
  r.put(
    '/categories/sharing',
    {
      ...cat,
      scope: 'write',
      summary: 'Use the shared category list, or the ledger’s own',
      description:
        'Shared: the ledger follows App settings → Categories and turns categories on and off; its categories are matched to the shared list by name, and ones the list doesn’t have are added to it. Own: it keeps a copy of the shared list, with new ids, to edit here, and changes to the shared list no longer reach it.',
      body: categorySharingSchema,
      response: categoryListSchema,
    },
    (c, { body }) => {
      if (body.shared && c.var.actor.kind === 'key' && c.var.actor.key.ledgers) {
        throw new HTTPException(403, { message: 'Joining the shared list can add categories to every ledger, so a key limited to some ledgers can’t do it.' })
      }
      const was = usesSharedList(c.var.ctx)
      const resolve = new Map<number, JoinResolution>()
      for (const r of body.resolve ?? []) {
        if ((r.action === 'match' || r.action === 'move') && !r.to) badRequest(`Say which shared category ${cats.getCategory(c.var.ctx, r.category).name} goes to.`)
        resolve.set(r.category, r.action === 'add' ? 'add' : r.action === 'uncategorize' ? null : r.to!)
      }
      try {
        setCategorySharing(storage, c.var.ctx, body.shared, resolve)
      } catch (err) {
        if (err instanceof Error && /shared list has no category/.test(err.message)) badRequest(err.message)
        throw err
      }
      if (was !== body.shared) {
        log(c, { action: 'update', entity: 'ledger', summary: body.shared ? 'Switched to the shared category list' : 'Switched to its own category list' })
      }
      return { ...cats.listCategories(c.var.ctx), shared: body.shared }
    },
  )

  // A ledger with its own list edits it here.
  r.post(
    '/categories',
    { ...cat, scope: 'write', summary: 'Create a category', body: categoryCreateSchema, response: categorySchema, status: 201 },
    (c, { body }) => {
      ownList(c)
      const x = cats.createCategory(c.var.ctx, body)
      log(c, { action: 'create', entity: 'category', entityId: x.id, summary: `Added the category ${x.name}`, after: x })
      return x
    },
  )
  r.post(
    '/categories/reorder',
    { ...cat, scope: 'write', summary: 'Reorder categories', description: 'Send category ids in the new order.', body: reorderSchema, response: categoryListSchema },
    (c, { body }) => {
      ownList(c)
      cats.reorder(c.var.ctx, 'categories', body.ids)
      log(c, { action: 'reorder', entity: 'category', summary: 'Reordered categories', after: body.ids })
      return cats.listCategories(c.var.ctx)
    },
  )
  r.delete(
    '/categories/:id',
    { ...cat, scope: 'write', summary: 'Delete a category', description: 'Its transactions become uncategorized. Archive it instead to keep them.', status: 204 },
    (c, { params }) => {
      ownList(c)
      const before = cats.getCategory(c.var.ctx, params.id)
      cats.deleteCategory(c.var.ctx, params.id)
      log(c, { action: 'delete', entity: 'category', entityId: before.id, summary: `Deleted the category ${before.name}`, before })
    },
  )

  // Labels: your own way to sort categories across the groups (say, needs and wants).
  r.post(
    '/labels',
    { ...cat, scope: 'write', summary: 'Create a label', description: 'Names are unique, whatever their case.', body: labelCreateSchema, response: labelSchema, status: 201 },
    (c, { body }) => {
      ownList(c)
      const l = labels.createLabel(c.var.ctx, body)
      log(c, { action: 'create', entity: 'label', entityId: l.id, summary: `Added the label ${l.name}`, after: l })
      return l
    },
  )
  r.patch(
    '/labels/:id',
    { ...cat, scope: 'write', summary: 'Update a label', body: labelUpdateSchema, response: labelSchema },
    (c, { params, body }) => {
      ownList(c)
      const before = labels.getLabel(c.var.ctx, params.id)
      const after = labels.updateLabel(c.var.ctx, params.id, body)
      logUpdate(c, 'label', after.id, `Edited the label ${before.name}`, before, after)
      return after
    },
  )
  r.delete(
    '/labels/:id',
    { ...cat, scope: 'write', summary: 'Delete a label', description: 'Its categories just lose the label.', status: 204 },
    (c, { params }) => {
      ownList(c)
      const before = labels.deleteLabel(c.var.ctx, params.id)
      log(c, { action: 'delete', entity: 'label', entityId: before.id, summary: `Deleted the label ${before.name}`, before })
    },
  )
  r.post(
    '/labels/:id/categories',
    {
      ...cat,
      scope: 'write',
      summary: 'Put a label on categories',
      description: 'Puts the label on the categories in `add` and takes it off those in `remove`; others keep theirs.',
      body: labelCategoriesSchema,
      response: labelSchema,
    },
    (c, { params, body }) => {
      ownList(c)
      const l = labels.applyLabel(c.var.ctx, params.id, body)
      const names = (ids: number[]) => ids.map((id) => cats.getCategory(c.var.ctx, id).name).join(', ')
      const parts = [body.add.length && `put it on ${names(body.add)}`, body.remove.length && `took it off ${names(body.remove)}`].filter(Boolean)
      if (parts.length) log(c, { action: 'update', entity: 'label', entityId: l.id, summary: `Label ${l.name}: ${parts.join('; ')}`, after: body })
      return l
    },
  )

  r.post(
    '/categories/:id/merge',
    {
      ...cat,
      scope: 'write',
      summary: 'Merge a category into another',
      description:
        'Moves its transactions, recurring payments and learned payees to `into`, then deletes it. `into` keeps its own name, group and labels.',
      body: categoryMergeSchema,
      response: categoryMergeResultSchema,
    },
    (c, { params, body }) => {
      ownList(c)
      const { from, reports, ...result } = cats.mergeCategory(c.var.ctx, params.id, body.into)
      log(c, {
        action: 'delete',
        entity: 'category',
        entityId: from.id,
        summary: `Merged the category ${from.name} into ${result.into.name} (${result.transactions} transaction${result.transactions === 1 ? '' : 's'}${andReports(reports)})`,
        before: from,
        after: { into: result.into.id, transactions: result.transactions, recurring: result.recurring },
      })
      return result
    },
  )
  r.post(
    '/category-groups',
    { ...cat, scope: 'write', summary: 'Create a category group', body: groupCreateSchema, response: categoryGroupSchema, status: 201 },
    (c, { body }) => {
      ownList(c)
      const g = cats.createGroup(c.var.ctx, body)
      log(c, { action: 'create', entity: 'category_group', entityId: g.id, summary: `Added the group ${g.name}`, after: g })
      return g
    },
  )
  r.post(
    '/category-groups/reorder',
    { ...cat, scope: 'write', summary: 'Reorder category groups', body: reorderSchema, response: categoryListSchema },
    (c, { body }) => {
      ownList(c)
      cats.reorder(c.var.ctx, 'category_groups', body.ids)
      log(c, { action: 'reorder', entity: 'category_group', summary: 'Reordered category groups', after: body.ids })
      return cats.listCategories(c.var.ctx)
    },
  )
  r.patch(
    '/category-groups/:id',
    { ...cat, scope: 'write', summary: 'Update a category group', body: groupUpdateSchema, response: categoryGroupSchema },
    (c, { params, body }) => {
      ownList(c)
      const before = cats.getGroup(c.var.ctx, params.id)
      const after = cats.updateGroup(c.var.ctx, params.id, body)
      logUpdate(c, 'category_group', after.id, `Edited the group ${before.name}`, before, after)
      return after
    },
  )
  r.delete(
    '/category-groups/:id',
    {
      ...cat,
      scope: 'write',
      summary: 'Delete a category group',
      description: 'Also deletes its categories; their transactions become uncategorized. To keep a category, move it to another group first.',
      status: 204,
    },
    (c, { params }) => {
      ownList(c)
      const before = cats.getGroup(c.var.ctx, params.id)
      const removed = cats.deleteGroup(c.var.ctx, params.id)
      for (const r of removed) {
        log(c, { action: 'delete', entity: 'category', entityId: r.id, summary: `Deleted the category ${r.name} with its group ${before.name}`, before: r })
      }
      const what = removed.length ? ` and its ${removed.length} categor${removed.length === 1 ? 'y' : 'ies'}` : ''
      log(c, { action: 'delete', entity: 'category_group', entityId: before.id, summary: `Deleted the group ${before.name}${what}`, before })
    },
  )
  r.get('/tags', { ...cat, scope: 'read', summary: 'List tags', response: z.array(tagWithCountSchema) }, (c) => cats.listTags(c.var.ctx))
  r.post(
    '/tags',
    { ...cat, scope: 'write', summary: 'Create a tag', description: 'Names are lower-cased with spaces turned into dashes. Creating an existing tag returns it.', body: tagCreateSchema, response: tagSchema, status: 201 },
    (c, { body }) => {
      const t = cats.createTag(c.var.ctx, body.name, body.color)
      log(c, { action: 'create', entity: 'tag', entityId: t.id, summary: `Added the tag #${t.name}`, after: t })
      return t
    },
  )
  r.patch(
    '/tags/:id',
    { ...cat, scope: 'write', summary: 'Update a tag', body: tagUpdateSchema, response: tagSchema },
    (c, { params, body }) => {
      const before = cats.getTag(c.var.ctx, params.id)
      const after = cats.updateTag(c.var.ctx, params.id, body)
      logUpdate(c, 'tag', after.id, `Edited the tag #${before.name}`, before, after)
      return after
    },
  )
  r.delete(
    '/tags/:id',
    { ...cat, scope: 'write', summary: 'Delete a tag', description: 'Removes it from every transaction.', status: 204 },
    (c, { params }) => {
      const before = cats.getTag(c.var.ctx, params.id)
      cats.deleteTag(c.var.ctx, params.id)
      log(c, { action: 'delete', entity: 'tag', entityId: before.id, summary: `Deleted the tag #${before.name}`, before })
    },
  )

  // Recurring ------------------------------------------------------------
  const rec = { tag: 'Recurring' } as const
  r.get(
    '/recurring',
    { ...rec, scope: 'read', summary: 'List recurring items', query: z.object({ status: z.enum(RECURRING_STATUSES).optional() }), response: z.array(recurringItemSchema) },
    (c, { query }) => recurring.listRecurring(c.var.ctx, query.status),
  )
  r.get(
    '/recurring/upcoming',
    {
      ...rec,
      scope: 'read',
      summary: 'List upcoming payments',
      description: 'Expected payments from active recurring items, including overdue ones.',
      query: z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }),
      response: z.array(upcomingPaymentSchema),
    },
    (c, { query }) => recurring.upcomingPayments(c.var.ctx, query.days),
  )
  r.post(
    '/recurring/detect',
    {
      ...rec,
      scope: 'write',
      summary: 'Detect recurring payments',
      description: 'Looks through history for repeating payments and adds them as suggestions. Also runs nightly and after imports.',
      response: z.object({ created: z.number().int() }),
    },
    (c) => {
      const result = recurring.detectRecurring(c.var.ctx)
      if (result.created) log(c, { action: 'detect', entity: 'recurring', summary: `Found ${result.created} possible recurring payment${result.created === 1 ? '' : 's'}` })
      return result
    },
  )
  r.post(
    '/recurring',
    { ...rec, scope: 'write', summary: 'Create a recurring item', body: recurringCreateSchema, response: recurringItemSchema, status: 201 },
    (c, { body }) => {
      const item = recurring.createRecurring(c.var.ctx, body)
      log(c, { action: 'create', entity: 'recurring', entityId: item.id, summary: `Added the recurring item ${recurringLabel(item)}`, after: item })
      return item
    },
  )
  r.patch(
    '/recurring/:id',
    { ...rec, scope: 'write', summary: 'Update a recurring item', body: recurringUpdateSchema, response: recurringItemSchema },
    (c, { params, body }) => {
      const before = recurring.getRecurring(c.var.ctx, params.id)
      const after = recurring.updateRecurring(c.var.ctx, params.id, body)
      logUpdate(c, 'recurring', after.id, `Edited the recurring item ${recurringLabel(before)}`, before, after)
      return after
    },
  )
  r.get(
    '/recurring/:id/transactions',
    {
      ...rec,
      scope: 'read',
      summary: 'List a recurring item’s payments',
      description: 'Newest first: the payments linked to it, or for a suggestion, the ones that were found (linked when it’s confirmed).',
      response: z.array(transactionSchema),
    },
    (c, { params }) => recurring.recurringPaymentIds(c.var.ctx, params.id).map((id) => txs.getTransaction(c.var.ctx, id)),
  )
  r.post(
    '/recurring/:id/link-payment',
    {
      ...rec,
      scope: 'write',
      summary: 'Link a payment from another payee, or at a new amount',
      description:
        'Says a payment (usually its `possiblePayment`) is the item’s: its payee becomes one of the item’s, and the payment and others like it are linked. Beyond its price variation it’s the item’s amount from then on (a price change), except for an instalment plan’s last payment, which is added at its own amount as with POST /recurring/{id}/add-payment.',
      body: recurringPaymentSchema,
      response: recurringItemSchema,
    },
    (c, { params, body }) => {
      const tx = txs.getTransaction(c.var.ctx, body.transactionId)
      const item = recurring.linkPossiblePayment(c.var.ctx, params.id, body.transactionId)
      log(c, { action: 'update', entity: 'recurring', entityId: item.id, summary: `Linked ${describe(tx)} to ${recurringLabel(item)}` })
      return item
    },
  )
  r.get(
    '/recurring/:id/payment-candidates',
    {
      ...rec,
      scope: 'read',
      summary: 'Find payments to add to a recurring item',
      description:
        'Payments to add with POST /recurring/{id}/add-payment: not linked to a recurring item and not transfers, money out for a bill or plan (money in for income), from its account if it has one, at any amount. From around its dates: its first payment (or next due date) back 3 periods, until a period after its next due date. With `q`, any that match, at any date. Its payees’ and ones like them first, then the newest. Up to 50.',
      query: recurringPaymentCandidatesQuerySchema,
      response: z.array(recurringPaymentCandidateSchema),
    },
    (c, { params, query }) => txs.recurringPaymentCandidates(c.var.ctx, params.id, query),
  )
  r.post(
    '/recurring/:id/add-payment',
    {
      ...rec,
      scope: 'write',
      summary: 'Add a payment to a recurring item at its own amount',
      description:
        'For a payment the app didn’t link, like an instalment plan’s down payment, a first payment that covers part of a period, or its last one (the remainder). It’s counted and takes the item’s category, but the item’s usual amount stays: it’s no price change. It’s for the due date it falls in (or, when another payment has that one, the one before or after it). Its payee isn’t added to the item’s. An active or ended item only, a payment from its account, and a plan takes no more payments than it has (one from before its linked payments counts as one of those paid before your history). Undo it with POST /recurring/{id}/not-payment.',
      body: recurringPaymentSchema,
      response: recurringItemSchema,
    },
    (c, { params, body }) => {
      const tx = txs.getTransaction(c.var.ctx, body.transactionId)
      const item = recurring.addPayment(c.var.ctx, params.id, body.transactionId)
      log(c, { action: 'update', entity: 'recurring', entityId: item.id, summary: `Added ${describe(tx)} to ${recurringLabel(item)}` })
      return item
    },
  )
  r.post(
    '/recurring/:id/not-payment',
    {
      ...rec,
      scope: 'write',
      summary: 'Say a payment isn’t the item’s',
      description:
        'One of its payments that shouldn’t be (it’s unlinked and left uncategorized, and the item recalculated), or one offered as its `possiblePayment`. It isn’t linked or offered again.',
      body: recurringPaymentSchema,
      response: recurringItemSchema,
    },
    (c, { params, body }) => {
      const tx = txs.getTransaction(c.var.ctx, body.transactionId)
      const item = recurring.notItsPayment(c.var.ctx, params.id, body.transactionId)
      if (tx.recurringItemId === item.id) log(c, { action: 'update', entity: 'recurring', entityId: item.id, summary: `Took ${describe(tx)} off ${recurringLabel(item)}` })
      return item
    },
  )
  r.post(
    '/recurring/:id/confirm',
    { ...rec, scope: 'write', summary: 'Confirm a recurring item', description: 'Turns a suggestion into an active item.', response: recurringItemSchema },
    (c, { params }) => {
      const item = recurring.confirmRecurring(c.var.ctx, params.id)
      log(c, { action: 'confirm', entity: 'recurring', entityId: item.id, summary: `Confirmed the recurring item ${recurringLabel(item)}` })
      return item
    },
  )
  r.post(
    '/recurring/:id/dismiss',
    { ...rec, scope: 'write', summary: 'Dismiss a recurring item', description: 'It won’t be suggested again.', response: recurringItemSchema },
    (c, { params }) => {
      const item = recurring.dismissRecurring(c.var.ctx, params.id)
      log(c, { action: 'dismiss', entity: 'recurring', entityId: item.id, summary: `Dismissed the recurring item ${recurringLabel(item)}` })
      return item
    },
  )
  r.delete('/recurring/:id', { ...rec, scope: 'write', summary: 'Delete a recurring item', status: 204 }, (c, { params }) => {
    const before = recurring.getRecurring(c.var.ctx, params.id)
    recurring.deleteRecurring(c.var.ctx, params.id)
    log(c, { action: 'delete', entity: 'recurring', entityId: before.id, summary: `Deleted the recurring item ${recurringLabel(before)}`, before })
  })

  // Reports --------------------------------------------------------------
  const rep = { tag: 'Reports' } as const
  r.get(
    '/reports/summary',
    { ...rep, scope: 'read', summary: 'Get a month summary', description: 'Spending, income and categories for one month (default: this month).', query: z.object({ month: monthKey.optional() }), response: monthSummarySchema },
    (c, { query }) => reports.monthSummary(c.var.ctx, query.month ?? monthOf(today(c.var.ctx))),
  )
  r.get(
    '/reports/period',
    {
      ...rep,
      scope: 'read',
      summary: 'Get a period summary',
      description: `Income, spending by category group and category, and transfers left out of totals. Leave out \`from\` and \`to\` for all time.${FILTERED} \`filteredOut\` is then what it filters out.`,
      query: z.object({ from: isoDate.optional(), to: isoDate.optional() }).extend(filterQuery.shape),
      response: periodSummarySchema,
    },
    (c, { query }) => reports.periodSummary(c.var.ctx, query.from, query.to, query.filter),
  )
  r.get(
    '/reports/by-category',
    {
      ...rep,
      scope: 'read',
      summary: 'Get totals by category',
      description: FILTERED.trim(),
      query: rangeQuery.extend({ kind: z.enum(['expense', 'income']).default('expense'), ...filterQuery.shape }),
      response: z.array(categoryAmountSchema),
    },
    (c, { query }) => reports.byCategory(c.var.ctx, query.from, query.to, query.kind, query.filter),
  )
  r.get(
    '/reports/trend',
    {
      ...rep,
      scope: 'read',
      summary: 'Get the spending trend',
      description: `Monthly spending split by category or category group, ending at \`end\` (default: this month).${FILTERED} Each month's \`filteredOutMinor\` is the spending it filters out.`,
      query: z.object({ end: monthKey.optional(), months: monthsQuery(1, 36, 12), groupBy: z.enum(['category', 'group']).default('category'), ...filterQuery.shape }),
      response: trendReportSchema,
    },
    (c, { query }) => reports.trend(c.var.ctx, query.end ?? monthOf(today(c.var.ctx)), query.months, query.groupBy, query.filter),
  )
  r.get(
    '/reports/income-vs-expense',
    { ...rep, scope: 'read', summary: 'Get income vs spending', query: z.object({ end: monthKey.optional(), months: monthsQuery(1, 36, 12) }), response: z.array(monthTotalsSchema) },
    (c, { query }) => reports.incomeVsExpense(c.var.ctx, query.end ?? monthOf(today(c.var.ctx)), query.months),
  )
  r.get(
    '/reports/payees',
    {
      ...rep,
      scope: 'read',
      summary: 'Get top payees',
      description: FILTERED.trim(),
      query: rangeQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(15), ...filterQuery.shape }),
      response: z.array(payeeTotalSchema),
    },
    (c, { query }) => reports.topPayees(c.var.ctx, query.from, query.to, query.limit, query.filter),
  )
  r.get(
    '/reports/tags',
    { ...rep, scope: 'read', summary: 'Get totals by tag', description: FILTERED.trim(), query: rangeQuery.extend(filterQuery.shape), response: z.array(tagTotalSchema) },
    (c, { query }) => reports.tagTotals(c.var.ctx, query.from, query.to, query.filter),
  )
  r.get(
    '/reports/purchases',
    {
      ...rep,
      scope: 'read',
      summary: 'Get the biggest purchases, or what a filter filters out',
      description: `\`counted\`: the biggest purchases (or deposits) the filter counts in the period, by your share (what it cost, less its refunds and paybacks), leaving out recurring payments. \`filtered-out\`: everything the filter filters out of the period, by how much of it falls in it, with the rules that match each.${FILTERED}`,
      query: rangeQuery.extend({
        side: z.enum(FILTER_SIDES).default('spending'),
        set: z.enum(['counted', 'filtered-out']).default('counted'),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        ...filterQuery.shape,
      }),
      response: reportPurchasesSchema,
    },
    (c, { query }) => reports.purchases(c.var.ctx, query),
  )
  r.get(
    '/reports/net-worth',
    { ...rep, scope: 'read', summary: 'Get net worth', description: 'Assets minus liabilities at each month end, then today, plus each account’s balance.', query: z.object({ months: monthsQuery(2, 60, 12) }), response: netWorthReportSchema },
    (c, { query }) => reports.netWorth(c.var.ctx, query.months),
  )

  // Custom reports: a filter, range and comparison you saved under a name.
  const saved = (x: CustomReport) => ({ name: x.name, spec: x.spec })
  r.get(
    '/custom-reports',
    {
      ...rep,
      scope: 'read',
      summary: 'List custom reports',
      description:
        'Your saved reports, in your order: each one’s spec (filter, range, comparison, grouping), its filter in words (`description`), and what the filter refers to that’s gone or off (`missing`), which matches nothing.',
      response: z.array(customReportSchema),
    },
    (c) => customReports.listCustomReports(c.var.ctx),
  )
  r.get('/custom-reports/:id', { ...rep, scope: 'read', summary: 'Get a custom report', response: customReportSchema }, (c, { params }) =>
    customReports.getCustomReport(c.var.ctx, params.id),
  )
  r.post(
    '/custom-reports',
    {
      ...rep,
      scope: 'write',
      summary: 'Save a custom report',
      description:
        'A name, unique whatever its case (409 when you have one called that), and a spec. Ids in the filter aren’t checked: ones that no longer exist are listed in `missing`. Up to 50 reports.',
      body: customReportCreateSchema,
      response: customReportSchema,
      status: 201,
    },
    (c, { body }) => {
      const x = customReports.createCustomReport(c.var.ctx, body)
      log(c, { action: 'create', entity: 'custom_report', entityId: x.id, summary: `Added the custom report ${x.name}`, after: saved(x) })
      return x
    },
  )
  r.patch(
    '/custom-reports/:id',
    {
      ...rep,
      scope: 'write',
      summary: 'Update a custom report',
      description: 'Renames it, or replaces its spec. The last change wins.',
      body: customReportUpdateSchema,
      response: customReportSchema,
    },
    (c, { params, body }) => {
      const before = customReports.getCustomReport(c.var.ctx, params.id)
      const after = customReports.updateCustomReport(c.var.ctx, params.id, body)
      logUpdate(c, 'custom_report', after.id, `Edited the custom report ${before.name}`, saved(before), saved(after))
      return after
    },
  )
  r.put(
    '/custom-reports/order',
    { ...rep, scope: 'write', summary: 'Reorder custom reports', body: customReportOrderSchema, response: z.array(customReportSchema) },
    (c, { body }) => {
      const list = customReports.reorderCustomReports(c.var.ctx, body.ids)
      log(c, { action: 'update', entity: 'custom_report', summary: 'Reordered the custom reports', after: { order: list.map((x) => x.name) } })
      return list
    },
  )
  r.delete(
    '/custom-reports/:id',
    { ...rep, scope: 'write', summary: 'Delete a custom report', description: 'To undo, save its name and spec again.', status: 204 },
    (c, { params }) => {
      const before = customReports.deleteCustomReport(c.var.ctx, params.id)
      log(c, { action: 'delete', entity: 'custom_report', entityId: before.id, summary: `Deleted the custom report ${before.name}`, before: saved(before) })
    },
  )

  // Import ---------------------------------------------------------------
  const imp = { tag: 'Import' } as const
  r.post(
    '/import/preview',
    {
      ...imp,
      scope: 'read',
      summary: 'Preview an import',
      description: 'For parsed rows, shows which ones look like duplicates and the category each would get. Changes nothing.',
      body: importPreviewSchema,
      response: z.array(importPreviewRowSchema),
    },
    (c, { body }) => imports.previewImport(c.var.ctx, body),
  )
  r.post(
    '/import/commit',
    {
      ...imp,
      scope: 'write',
      summary: 'Import transactions',
      description: 'Adds the rows that aren’t duplicates as one batch. Rows with an `externalId` the account already has are skipped. To take an import back, delete its transactions.',
      body: importCommitSchema,
      response: importResultSchema,
      status: 201,
      dryRun: true,
    },
    (c, { body, dryRun }) => {
      const result = imports.commitImport(c.var.ctx, body, { background: !dryRun })
      if (dryRun) return { ...result, batchId: null, dryRun }
      log(c, {
        action: 'import',
        entity: 'import',
        entityId: result.batchId,
        summary: `Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'}${body.fileName ? ` from ${body.fileName}` : ''}${result.skippedDuplicates ? ` (${result.skippedDuplicates} duplicates skipped)` : ''}`,
        after: result,
      })
      // Its new payees get named by AI tidying, when it's on (in the background).
      void tidyNewPayees(names.worldOf(storage))
      return result
    },
  )
  r.get(
    '/import/batches',
    { ...imp, scope: 'read', summary: 'List recent imports', description: 'The last 50 imports, newest first: the file, the account, how many rows it added and when.', response: z.array(importBatchSchema) },
    (c) => imports.listBatches(c.var.ctx),
  )

  // Categorization -------------------------------------------------------
  const ai = { tag: 'Categorization' } as const
  r.post(
    '/categorize/suggest',
    {
      ...ai,
      scope: 'read',
      summary: 'Suggest a category',
      description: 'Uses your history first, then AI if it’s set up (`useAi: false` to skip it). Changes nothing.',
      body: suggestCategorySchema,
      response: categorySuggestionSchema,
    },
    async (c, { body }) => {
      const { autoApply: _autoApply, ...suggestion } = await suggestCategory(c.var.ctx, body)
      return suggestion
    },
  )
  r.post(
    '/categorize/run',
    {
      ...ai,
      scope: 'write',
      summary: 'Categorize uncategorized transactions with AI',
      description: 'Starts in the background and returns at once; poll the status. Suggestions are flagged for review.',
      response: aiJobStatusSchema,
      status: 202,
    },
    (c) => {
      void imports.categorizeUncategorized(c.var.ctx)
      log(c, { action: 'categorize', entity: 'transaction', summary: 'Started AI categorization of uncategorized transactions' })
      return imports.aiJobStatus(c.var.ctx)
    },
  )
  r.post(
    '/categorize/again',
    {
      ...ai,
      scope: 'write',
      summary: 'Ask AI again about transactions’ categories',
      description:
        'AI only, not your history, in the background: poll the status. A different pick replaces the category as a suggestion to review. Transfers, refunds and paybacks that follow their purchase, payments a recurring item categorizes, and payees you always set one way are left as they are.',
      body: recategorizeSchema,
      response: aiJobStatusSchema,
      status: 202,
    },
    (c, { body }) => {
      const ctx = c.var.ctx
      const actor = c.var.actor
      const by = { name: actorName(actor), apiKeyId: actor.kind === 'key' ? actor.key.id : null }
      return imports.recategorize(ctx, body.ids, (changed) => {
        if (!changed.length) return
        recordActivity(ctx, by, {
          action: 'bulk_update',
          entity: 'transaction',
          summary: `AI changed the category of ${changed.length} transaction${changed.length === 1 ? '' : 's'}, to review`,
          before: changed.map((x) => ({ id: x.id, categoryId: x.before })),
          after: changed.map((x) => ({ id: x.id, categoryId: x.after })),
        })
      })
    },
  )
  r.get('/categorize/status', { ...ai, scope: 'read', summary: 'Get the AI categorization status', response: aiJobStatusSchema }, (c) =>
    imports.aiJobStatus(c.var.ctx),
  )
  r.get('/ai/usage', { ...ai, scope: 'read', summary: 'Get this ledger’s AI usage', response: aiUsageSchema }, (c) => ledgerAiUsage(c.var.ctx))

  // Payees ---------------------------------------------------------------
  const pay = { tag: 'Payees' } as const
  r.get(
    '/payees',
    {
      ...pay,
      scope: 'read',
      summary: 'List payee choices',
      description: 'Payees you chose to always set to one category, or to always review yourself. The others get a suggestion to review each time.',
      response: z.array(payeeRuleSchema),
    },
    (c) => payees.listPayeeRules(c.var.ctx),
  )
  r.get(
    '/payees/search',
    {
      ...pay,
      scope: 'read',
      summary: 'Search payees',
      description: 'Payees of your transactions (not transfers), most used first, with what the payee name rules call them. Search by name, or look up payee keys. With neither, the most used.',
      query: payeeSearchQuerySchema,
      response: z.array(payeeSearchResultSchema),
    },
    (c, { query }) => payees.searchPayees(c.var.ctx, query),
  )
  r.post(
    '/payees/rename',
    {
      ...pay,
      scope: 'write',
      summary: 'Rename a payee',
      description:
        'Makes or changes the payee name rule that names it (app-wide), so every transaction with the payee has the name, in every ledger, past and future. A name another payee has makes them one payee. Null: it goes back to what it’s called otherwise. Not for a key limited to some ledgers.',
      body: payeeRenameSchema,
      response: z.object({ rule: payeeNameRuleSchema.nullable(), changed: z.number().int() }),
    },
    (c, { body }) => {
      // Payee name rules are app-wide.
      if (limitedKey(c)) throw new HTTPException(403, { message: 'That’s for the whole app, so a key limited to some ledgers can’t use it.' })
      const result = names.renamePayee(names.worldOf(storage), body)
      log(c, { action: 'update', entity: 'payee', summary: body.name ? `Renamed the payee “${body.payee}” ${body.name}` : `“${body.payee}” goes by what the rules call it again` })
      return result
    },
  )
  r.get(
    '/payees/choice',
    {
      ...pay,
      scope: 'read',
      summary: 'Get a payee choice',
      description: 'What you chose for a payee, and how many of its transactions `always` (with `categoryId`, or its current category) would set.',
      query: payeeChoiceQuerySchema,
      response: payeeChoiceSchema,
    },
    (c, { query }) => payees.getPayeeChoice(c.var.ctx, query.payeeKey, query.categoryId),
  )
  r.put(
    '/payees/choice',
    {
      ...pay,
      scope: 'write',
      summary: 'Choose what happens to a payee',
      description:
        '`always` sets the category on its transactions waiting for review or uncategorized now, and on new ones without review. `review` never sets one on its own. `ask` (the default) suggests one to review each time.',
      body: payeeChoiceUpdateSchema,
      response: payeeChoiceSchema.extend({ updated: z.number().int(), dryRun: z.boolean() }),
      dryRun: true,
    },
    (c, { body, dryRun }) => {
      const result = payees.setPayeeChoice(c.var.ctx, body, { dryRun })
      if (!dryRun) {
        const what =
          body.mode === 'always'
            ? `Always ${cats.getCategory(c.var.ctx, result.categoryId!).name} for “${result.payeeKey}”${result.updated ? `, set on ${result.updated} transaction${result.updated === 1 ? '' : 's'}` : ''}`
            : body.mode === 'review'
              ? `Always review “${result.payeeKey}”`
              : `Ask each time for “${result.payeeKey}”`
        log(c, { action: 'update', entity: 'payee', summary: what })
      }
      return { ...result, dryRun }
    },
  )

  // Activity -------------------------------------------------------------
  r.get(
    '/activity',
    { tag: 'Activity', scope: 'read', summary: 'List activity', description: 'Newest first. Filter by `actor` (`web` or an API key’s name) and `entity`.', query: activityQuerySchema, response: activityPageSchema },
    (c, { query }) => listActivity(c.var.ctx, query),
  )
  r.get('/activity/actors', { tag: 'Activity', scope: 'read', summary: 'List activity actors', description: 'Everyone who changed something in this ledger.', response: z.array(z.string()) }, (c) =>
    activityActors(c.var.ctx),
  )

  // Setup and data -------------------------------------------------------
  const data = { tag: 'Data' } as const
  r.get('/setup', { ...data, scope: 'read', summary: 'Get setup status', description: 'Whether the ledger is new and should show the welcome screen.', response: setupStatusSchema }, (c) =>
    setup.setupStatus(c.var.ctx),
  )
  r.post('/setup/start', { ...data, scope: 'write', summary: 'Start from scratch', description: 'Marks a new ledger as set up, with no data.', response: setupStatusSchema }, (c) => {
    const status = setup.startEmpty(c.var.ctx)
    log(c, { action: 'setup', entity: 'ledger', summary: 'Started from scratch' })
    return status
  })
  r.post(
    '/setup/demo',
    { ...data, scope: 'write', summary: 'Load the demo data', description: 'Fills an empty ledger with a year of sample accounts and transactions.', response: demoResultSchema },
    (c) => {
      const result = setup.startDemo(c.var.ctx)
      log(c, { action: 'setup', entity: 'ledger', summary: `Loaded the demo data (${result.transactions} transactions)` })
      return result
    },
  )
  r.post(
    '/erase',
    {
      ...data,
      scope: 'admin',
      summary: 'Erase this ledger’s data',
      description: 'Deletes all accounts, transactions, recurring items and tags, and resets the categories. A copy of the whole database is saved in data/backups first (`pre-erase-<slug>-<time>.db`). Send `{ "confirm": "erase" }`.',
      body: z.object({ confirm: z.literal('erase') }),
      response: backupResultSchema,
    },
    (c) => {
      const result = setup.eraseAll(storage, c.var.ctx)
      log(c, { action: 'erase', entity: 'ledger', summary: 'Erased all data', after: result })
      return result
    },
  )
  r.get(
    '/export/transactions.csv',
    {
      ...data,
      scope: 'read',
      summary: 'Export transactions as CSV',
      description: 'With `filter` (a ReportFilter as JSON), the transactions it counts, as GET /transactions lists them: transfers and what’s left out of totals stay in.',
      query: z.object({ from: isoDate.optional(), to: isoDate.optional() }).extend(filterQuery.shape),
      file: { contentType: 'text/csv', description: 'date, account, payee, amount, currency, category, group, notes, status, tags' },
    },
    (c, { query }) => {
      const rows = reports.exportRows(c.var.ctx, query.from, query.to, query.filter).map(({ amountMinor, ...rest }) => ({
        ...rest,
        amount: (Number(amountMinor) / 100).toFixed(2),
      }))
      c.header('Content-Type', 'text/csv; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="transactions-${today(c.var.ctx)}.csv"`)
      return c.body(toCsv(rows))
    },
  )

  return r
}

/** AI calls made while categorizing this ledger's transactions. */
export function ledgerAiUsage(ctx: AppContext): AiUsage {
  const totals = ctx.q.get<Omit<AiUsage, 'recent'>>(
    `SELECT count(*) AS calls, coalesce(sum(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures,
       coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens
     FROM ai_calls WHERE ledger_id = @ledger`,
  )!
  const recent = ctx.q.all<AiUsage['recent'][number]>(
    `SELECT id, created_at AS createdAt, slot, model, ok, latency_ms AS latencyMs, error
     FROM ai_calls WHERE ledger_id = @ledger ORDER BY id DESC LIMIT 20`,
  )
  return { ...totals, recent: recent.map((r) => ({ ...r, ok: !!r.ok })) }
}
