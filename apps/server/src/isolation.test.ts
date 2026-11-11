import { describe, expect, it } from 'vitest'
import { createApi } from './app'
import {
  apiKey,
  deleteRows,
  FREE_BANK_ACCOUNT,
  ledgerHash,
  mcpClient,
  one,
  send,
  settle,
  twins,
  type Req,
  type Res,
  type ToolRes,
  type Twin,
  type TwinIds,
  type Twins,
} from './test/twins'

/**
 * The twin isolation test: two ledgers seeded alike in one database, each with its canary in its
 * free text. Every route under /ledgers/:ledger and every MCP tool is run for one of them (the
 * subject), and must neither show nor change the other:
 * - Reads: the subject's answers are the same with the other's rows deleted, and never hold its canary.
 * - Id probes: the other's ids, in a path or a request, are answered as an id that doesn't exist is.
 * - Writes: the other's rows (every table) are the same after the subject's writes, except for an
 *   app-wide change, which changes both ledgers the same way.
 * - Keys: a key limited to the other gets 403 on the subject.
 * All of it in both directions, with both ledgers on the shared category list and on their own.
 * The cases come from the API's own specs and the MCP server's tools/list: a new route or tool
 * without a case fails the test.
 */

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface C {
  t: Twins
  me: Twin
  other: Twin
}

type NumberKind = { [K in keyof TwinIds]: TwinIds[K] extends number ? K : never }[keyof TwinIds]

interface Case {
  /** The spec's method and path, like `PATCH /ledgers/:ledger/transactions/:id`. */
  route: string
  params?: (c: C) => Record<string, number>
  query?: (c: C) => Record<string, unknown>
  body?: (c: C) => unknown
  /** The kind of id each path parameter is, when it isn't the usual one for its path. */
  kinds?: Record<string, NumberKind>
  /** The status it answers on purpose when it isn't a success (a 409, say). */
  status?: (c: C) => number | undefined
  /** All of its pages, by `nextCursor`. */
  pages?: boolean
  /** An app-wide change (payee names): it changes every ledger, the same way. */
  appWide?: boolean
  /** What may differ between captures for reasons outside the ledgers (bank accounts are app-wide). */
  normalize?: (body: Json) => Json
}

const MISSING = 999_999_999
const FOREIGN = 'other'

const ledgerOf = (c: C) => c.me.ctx.ledger.id
const ids = (c: C) => c.me.ids
const find = (c: C, sql: string, ...params: unknown[]) => one<number>(c.me.ctx, sql, ...params)
const column = (c: C, sql: string) => c.me.ctx.q.column<number>(sql)
const tx = (c: C, payee: string) => find(c, 'SELECT id FROM transactions WHERE ledger_id = @ledger AND payee = ? ORDER BY id DESC LIMIT 1', payee)
const payeeKey = (c: C, id: number) => one<string>(c.me.ctx, 'SELECT payee_key FROM transactions WHERE ledger_id = @ledger AND id = ?', id)
const tagName = (c: C) => one<string>(c.me.ctx, 'SELECT name FROM tags WHERE ledger_id = @ledger AND id = ?', ids(c).tag)
/**
 * The category list's rows as they are now: leaving or joining the shared list gives a ledger's
 * categories new ids, so writes look them up by name.
 */
const live = {
  category: (c: C) => find(c, "SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND name LIKE 'Groceries%'"),
  otherCategory: (c: C) => find(c, "SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND (name LIKE 'Dine out%' OR name = 'Eating out')"),
  group: (c: C) => find(c, "SELECT id FROM ledger_category_groups WHERE ledger_id = @ledger AND name LIKE 'Food%'"),
  label: (c: C) => find(c, "SELECT id FROM ledger_labels WHERE ledger_id = @ledger AND name LIKE 'Needs%'"),
}
const own = (c: C) => !c.me.ctx.q.pluck("SELECT 1 FROM ledgers WHERE id = @ledger AND category_list = 'shared'")

/** A report filter with a condition of every kind, on both sides, with picks and keeps. */
function filter(c: C) {
  const i = ids(c)
  return {
    v: 1,
    spending: {
      only: [
        { field: 'account', ids: [i.card, i.chequing, i.cash] },
        { field: 'amount', min: 100 },
      ],
      filterOut: [
        { when: [{ field: 'tag', ids: [i.tag] }] },
        { when: [{ field: 'category', ids: [i.otherCategory, 'none'] }, { field: 'text', words: ['uber', 'note'] }] },
        { when: [{ field: 'group', ids: [i.group] }, { field: 'payee', keys: [payeeKey(c, i.purchase)] }] },
        { when: [{ field: 'label', ids: [i.label] }, { field: 'recurring', ids: [i.recurring] }] },
      ],
      picked: [i.purchase],
      keep: [i.refunded],
    },
    income: { only: [{ field: 'recurring', ids: 'none' }], filterOut: [{ when: [{ field: 'category', ids: ['none'] }] }], picked: [], keep: [] },
  }
}

const RANGE = { from: '2025-10-01', to: '2026-10-03' }

// Reads ------------------------------------------------------------------------------------

const READS: Case[] = [
  { route: 'GET /ledgers/:ledger' },
  { route: 'GET /ledgers/:ledger/transactions', query: () => ({ limit: 60 }), pages: true },
  { route: 'GET /ledgers/:ledger/transactions', query: () => ({ needsReview: true }) },
  { route: 'GET /ledgers/:ledger/transactions', query: (c) => ({ accountId: ids(c).card, from: '2026-06-01', to: '2026-09-30' }) },
  { route: 'GET /ledgers/:ledger/transactions', query: (c) => ({ categoryId: `${ids(c).category},none` }) },
  { route: 'GET /ledgers/:ledger/transactions', query: (c) => ({ tagId: ids(c).tag }) },
  { route: 'GET /ledgers/:ledger/transactions', query: (c) => ({ recurringItemId: ids(c).recurring }) },
  { route: 'GET /ledgers/:ledger/transactions', query: () => ({ q: 'costco' }) },
  { route: 'GET /ledgers/:ledger/transactions', query: (c) => ({ labelId: ids(c).label }) },
  { route: 'GET /ledgers/:ledger/transactions', query: () => ({ labelId: 'none', limit: 500 }) },
  { route: 'GET /ledgers/:ledger/transactions', query: (c) => ({ filter: filter(c), side: 'spending', limit: 500 }) },
  { route: 'GET /ledgers/:ledger/transactions', query: (c) => ({ filter: filter(c), filteredOut: true, limit: 500 }) },
  { route: 'GET /ledgers/:ledger/transactions', query: () => ({ side: 'income', limit: 500 }) },
  { route: 'GET /ledgers/:ledger/transactions/span' },
  { route: 'GET /ledgers/:ledger/transactions/:id', params: (c) => ({ id: ids(c).purchase }) },
  { route: 'GET /ledgers/:ledger/transactions/:id', params: (c) => ({ id: ids(c).refund }), kinds: { id: 'refund' } },
  { route: 'GET /ledgers/:ledger/transactions/:id/bank-data', params: (c) => ({ id: ids(c).synced }), kinds: { id: 'synced' } },
  { route: 'GET /ledgers/:ledger/transactions/:id/link-candidates', params: (c) => ({ id: ids(c).moneyIn }), kinds: { id: 'moneyIn' } },
  { route: 'GET /ledgers/:ledger/transactions/:id/link-candidates', params: (c) => ({ id: ids(c).moneyIn }), query: () => ({ kind: 'payback' }), kinds: { id: 'moneyIn' } },
  { route: 'GET /ledgers/:ledger/transactions/:id/link-candidates', params: (c) => ({ id: ids(c).moneyIn }), query: (c) => ({ q: 'best', categoryId: `${ids(c).category},none` }), kinds: { id: 'moneyIn' } },
  { route: 'GET /ledgers/:ledger/transactions/:id/link-candidates', params: (c) => ({ id: ids(c).refunded }), kinds: { id: 'refunded' } },
  { route: 'GET /ledgers/:ledger/transactions/:id/links', params: (c) => ({ id: ids(c).refund }), kinds: { id: 'refund' } },
  { route: 'GET /ledgers/:ledger/transactions/:id/links', params: (c) => ({ id: ids(c).refunded }), kinds: { id: 'refunded' } },
  { route: 'GET /ledgers/:ledger/institutions' },
  { route: 'GET /ledgers/:ledger/accounts' },
  // Bank accounts are the app's: one the other ledger synced into is free once its rows are gone.
  { route: 'GET /ledgers/:ledger/bank-accounts', normalize: (body: Json[]) => body.filter((b) => b.link) },
  { route: 'GET /ledgers/:ledger/accounts/:id', params: (c) => ({ id: ids(c).card }) },
  { route: 'GET /ledgers/:ledger/accounts/:id', params: (c) => ({ id: ids(c).chequing }), kinds: { id: 'chequing' } },
  { route: 'GET /ledgers/:ledger/accounts/:id/history', params: (c) => ({ id: ids(c).investment }), query: () => ({ months: 24 }), kinds: { id: 'investment' } },
  { route: 'GET /ledgers/:ledger/accounts/:id/snapshots', params: (c) => ({ id: ids(c).investment }), kinds: { id: 'investment' } },
  { route: 'GET /ledgers/:ledger/categories' },
  { route: 'GET /ledgers/:ledger/categories/sharing' },
  { route: 'GET /ledgers/:ledger/tags' },
  { route: 'GET /ledgers/:ledger/recurring' },
  { route: 'GET /ledgers/:ledger/recurring', query: () => ({ status: 'dismissed' }) },
  { route: 'GET /ledgers/:ledger/recurring/upcoming', query: () => ({ days: 90 }) },
  { route: 'GET /ledgers/:ledger/recurring/:id/transactions', params: (c) => ({ id: ids(c).recurring }) },
  { route: 'GET /ledgers/:ledger/recurring/:id/payment-candidates', params: (c) => ({ id: ids(c).recurring }) },
  { route: 'GET /ledgers/:ledger/recurring/:id/payment-candidates', params: (c) => ({ id: ids(c).recurring }), query: () => ({ q: 'costco' }) },
  { route: 'GET /ledgers/:ledger/reports/summary', query: () => ({ month: '2026-09' }) },
  { route: 'GET /ledgers/:ledger/reports/period', query: (c) => ({ ...RANGE, filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/by-category', query: () => RANGE },
  { route: 'GET /ledgers/:ledger/reports/by-category', query: (c) => ({ ...RANGE, kind: 'income', filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/by-category', query: (c) => ({ ...RANGE, filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/trend', query: (c) => ({ end: '2026-09', months: 12, filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/trend', query: () => ({ end: '2026-09', months: 12, groupBy: 'group' }) },
  { route: 'GET /ledgers/:ledger/reports/income-vs-expense', query: () => ({ end: '2026-09', months: 13 }) },
  { route: 'GET /ledgers/:ledger/reports/payees', query: (c) => ({ ...RANGE, limit: 100, filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/tags', query: (c) => ({ ...RANGE, filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/tags', query: () => RANGE },
  { route: 'GET /ledgers/:ledger/reports/purchases', query: (c) => ({ ...RANGE, limit: 100, filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/purchases', query: (c) => ({ ...RANGE, set: 'filtered-out', limit: 100, filter: filter(c) }) },
  { route: 'GET /ledgers/:ledger/reports/purchases', query: () => ({ ...RANGE, side: 'income' }) },
  { route: 'GET /ledgers/:ledger/reports/net-worth', query: () => ({ months: 24 }) },
  { route: 'GET /ledgers/:ledger/custom-reports' },
  { route: 'GET /ledgers/:ledger/custom-reports/:id', params: (c) => ({ id: ids(c).report }) },
  { route: 'GET /ledgers/:ledger/import/batches' },
  { route: 'GET /ledgers/:ledger/categorize/status' },
  { route: 'GET /ledgers/:ledger/ai/usage' },
  { route: 'GET /ledgers/:ledger/payees' },
  { route: 'GET /ledgers/:ledger/payees/search', query: () => ({ q: 'co', limit: 200 }) },
  { route: 'GET /ledgers/:ledger/payees/search', query: (c) => ({ keys: JSON.stringify([payeeKey(c, ids(c).purchase), 'new grocer']) }) },
  { route: 'GET /ledgers/:ledger/payees/choice', query: () => ({ payeeKey: 'new grocer' }) },
  { route: 'GET /ledgers/:ledger/payees/choice', query: (c) => ({ payeeKey: payeeKey(c, ids(c).purchase), categoryId: ids(c).category }) },
  { route: 'GET /ledgers/:ledger/activity', query: () => ({ limit: 20 }), pages: true },
  { route: 'GET /ledgers/:ledger/activity', query: () => ({ actor: 'web', entity: 'ledger' }) },
  { route: 'GET /ledgers/:ledger/activity/actors' },
  { route: 'GET /ledgers/:ledger/setup' },
  { route: 'GET /ledgers/:ledger/export/transactions.csv' },
  { route: 'GET /ledgers/:ledger/export/transactions.csv', query: (c) => ({ ...RANGE, filter: filter(c) }) },
]

// Writes, in the order they run ---------------------------------------------------------------

/** The routes for a ledger's own category list. On the shared list they're refused (409). */
function ownListCases(refused: boolean): Case[] {
  const status = refused ? () => 409 : undefined
  const made = (name: string, table = 'ledger_categories') => (c: C) =>
    refused ? live.category(c) : find(c, `SELECT id FROM ${table} WHERE ledger_id = @ledger AND name = ?`, name)
  return [
    { route: 'POST /ledgers/:ledger/categories', body: (c) => ({ name: 'Twin category', groupId: live.group(c) }), status },
    { route: 'POST /ledgers/:ledger/categories', body: () => ({ name: 'Twin doomed' }), status },
    { route: 'POST /ledgers/:ledger/categories/reorder', body: (c) => ({ ids: column(c, 'SELECT id FROM ledger_categories WHERE ledger_id = @ledger ORDER BY id DESC') }), status },
    { route: 'PATCH /ledgers/:ledger/categories/:id', params: (c) => ({ id: live.category(c) }), body: (c) => ({ name: 'Groceries and more', labelIds: [live.label(c)] }), status },
    { route: 'POST /ledgers/:ledger/labels', body: () => ({ name: 'Twin label' }), status },
    { route: 'PATCH /ledgers/:ledger/labels/:id', params: (c) => ({ id: live.label(c) }), body: () => ({ color: '#0ea5e9' }), status },
    { route: 'POST /ledgers/:ledger/labels/:id/categories', params: (c) => ({ id: live.label(c) }), body: (c) => ({ add: [live.otherCategory(c)], remove: [] }), status },
    { route: 'POST /ledgers/:ledger/categories/:id/merge', params: (c) => ({ id: made('Twin category')(c) }), body: (c) => ({ into: live.category(c) }), status },
    { route: 'POST /ledgers/:ledger/category-groups', body: () => ({ name: 'Twin group' }), status },
    { route: 'POST /ledgers/:ledger/category-groups/reorder', body: (c) => ({ ids: column(c, 'SELECT id FROM ledger_category_groups WHERE ledger_id = @ledger ORDER BY id DESC') }), status },
    { route: 'PATCH /ledgers/:ledger/category-groups/:id', params: (c) => ({ id: live.group(c) }), body: () => ({ color: '#0ea5e9' }), status },
    { route: 'DELETE /ledgers/:ledger/category-groups/:id', params: (c) => ({ id: refused ? live.group(c) : made('Twin group', 'ledger_category_groups')(c) }), status },
    { route: 'DELETE /ledgers/:ledger/labels/:id', params: (c) => ({ id: refused ? live.label(c) : made('Twin label', 'ledger_labels')(c) }), status },
    { route: 'DELETE /ledgers/:ledger/categories/:id', params: (c) => ({ id: made('Twin doomed')(c) }), status },
  ]
}

const sharing = (shared: boolean): Case => ({ route: 'PUT /ledgers/:ledger/categories/sharing', body: () => ({ shared }) })

/** Every write route, for a world on the shared list or on own lists. Ones that end things come last. */
function writeCases(ownLists: boolean): Case[] {
  const categories: Case[] = ownLists
    ? [...ownListCases(false), sharing(true), sharing(false)]
    : [
        { route: 'PATCH /ledgers/:ledger/categories/:id', params: (c) => ({ id: live.otherCategory(c) }), body: (c) => ({ enabled: false, moveTo: live.category(c) }) },
        { route: 'PATCH /ledgers/:ledger/categories/:id', params: (c) => ({ id: live.otherCategory(c) }), body: () => ({ enabled: true }) },
        ...ownListCases(true),
        sharing(false),
        ...ownListCases(false),
        sharing(true),
      ]
  const preview = async (c: C) =>
    (await send(c.t.app, { method: 'POST', path: `/ledgers/${ledgerOf(c)}/accounts/${ids(c).cash}/bank/preview`, body: { bankAccountId: FREE_BANK_ACCOUNT } })).body
  return [
    // Transactions
    { route: 'POST /ledgers/:ledger/transactions', body: (c) => ({ accountId: ids(c).chequing, date: '2026-10-01', amountMinor: -1_234, payee: 'TWIN SHOP', categoryId: live.category(c), tags: ['twin'] }) },
    { route: 'POST /ledgers/:ledger/transactions', body: (c) => ({ accountId: ids(c).card, date: '2026-10-02', amountMinor: -2_200, payee: 'MYSTERY MERCHANT' }) },
    { route: 'POST /ledgers/:ledger/transactions', body: (c) => ({ accountId: ids(c).chequing, date: '2026-10-02', amountMinor: -5_000, payee: 'To savings', transferAccountId: ids(c).investment }) },
    { route: 'POST /ledgers/:ledger/transactions/:id/accept-suggestion', params: (c) => ({ id: ids(c).suggestion }), kinds: { id: 'suggestion' } },
    { route: 'POST /ledgers/:ledger/transactions/bulk', query: () => ({ dryRun: true }), body: (c) => ({ ids: [ids(c).purchase], categoryId: live.otherCategory(c), addTags: ['bulk'] }) },
    { route: 'POST /ledgers/:ledger/transactions/bulk', body: (c) => ({ ids: [ids(c).purchase], categoryId: live.otherCategory(c), addTags: ['bulk'] }) },
    { route: 'POST /ledgers/:ledger/transactions/accept-all', query: () => ({ dryRun: true }) },
    { route: 'POST /ledgers/:ledger/transactions/accept-all' },
    { route: 'POST /ledgers/:ledger/transactions/match', query: () => ({ dryRun: true }), body: () => ({ since: '2026-01-01' }) },
    { route: 'POST /ledgers/:ledger/transactions/match', body: () => ({}) },
    { route: 'PUT /ledgers/:ledger/transactions/:id/links', params: (c) => ({ id: ids(c).moneyIn }), body: (c) => ({ links: [{ transactionId: ids(c).purchase, amountMinor: 1_200, kind: 'refund' }] }), kinds: { id: 'moneyIn' } },
    { route: 'PUT /ledgers/:ledger/transactions/links', body: (c) => ({ sets: [{ id: ids(c).moneyIn, links: [] }] }) },
    { route: 'PATCH /ledgers/:ledger/transactions/:id', params: (c) => ({ id: ids(c).purchase }), body: () => ({ notes: 'edited', tags: ['edited'] }) },
    { route: 'DELETE /ledgers/:ledger/transactions/:id', params: (c) => ({ id: tx(c, 'TWIN SHOP') }) },
    { route: 'POST /ledgers/:ledger/transactions/:id/restore', params: (c) => ({ id: ids(c).deleted }), kinds: { id: 'deleted' } },
    // Institutions and accounts
    { route: 'POST /ledgers/:ledger/institutions', body: () => ({ name: 'Twin Credit Union' }) },
    { route: 'POST /ledgers/:ledger/institutions/reorder', body: (c) => ({ ids: column(c, 'SELECT id FROM institutions WHERE ledger_id = @ledger ORDER BY id DESC') }) },
    { route: 'PATCH /ledgers/:ledger/institutions/:id', params: (c) => ({ id: ids(c).institution }), body: () => ({ name: 'TD Bank' }) },
    { route: 'DELETE /ledgers/:ledger/institutions/:id', params: (c) => ({ id: find(c, "SELECT id FROM institutions WHERE ledger_id = @ledger AND name = 'Twin Credit Union'") }) },
    { route: 'POST /ledgers/:ledger/accounts', body: (c) => ({ name: 'Twin Savings', type: 'savings', institutionId: ids(c).institution, openingBalanceMinor: 10_000 }) },
    { route: 'POST /ledgers/:ledger/accounts/:id/bank/preview', params: (c) => ({ id: ids(c).cash }), body: () => ({ bankAccountId: FREE_BANK_ACCOUNT }), kinds: { id: 'cash' } },
    { route: 'DELETE /ledgers/:ledger/accounts/:id/bank/preview', params: (c) => ({ id: ids(c).cash }), kinds: { id: 'cash' } },
    { route: 'PUT /ledgers/:ledger/accounts/:id/bank', params: (c) => ({ id: ids(c).cash }), body: () => ({ bankAccountId: FREE_BANK_ACCOUNT }), kinds: { id: 'cash' } },
    { route: 'DELETE /ledgers/:ledger/accounts/:id/bank', params: (c) => ({ id: ids(c).cash }), kinds: { id: 'cash' } },
    {
      route: 'POST /ledgers/:ledger/accounts/:id/bank/switch',
      params: (c) => ({ id: ids(c).cash }),
      body: async (c) => {
        const p = await preview(c)
        return { bankAccountId: FREE_BANK_ACCOUNT, from: p.from, version: p.version, pairs: [], skip: [], remove: [] }
      },
      kinds: { id: 'cash' },
    },
    { route: 'DELETE /ledgers/:ledger/accounts/:id/bank', params: (c) => ({ id: ids(c).cash }), kinds: { id: 'cash' } },
    { route: 'POST /ledgers/:ledger/accounts', body: () => ({ name: 'Linked Savings', type: 'savings', bank: { bankAccountId: FREE_BANK_ACCOUNT } }) },
    { route: 'POST /ledgers/:ledger/accounts/reorder', body: (c) => ({ ids: column(c, 'SELECT id FROM ledger_accounts WHERE ledger_id = @ledger ORDER BY id DESC') }) },
    { route: 'PATCH /ledgers/:ledger/accounts/:id', params: (c) => ({ id: ids(c).card }), body: () => ({ name: 'Amex', notes: 'mine' }) },
    { route: 'POST /ledgers/:ledger/accounts/:id/balance', params: (c) => ({ id: ids(c).investment }), body: () => ({ date: '2026-10-01', balanceMinor: 2_600_000 }), kinds: { id: 'investment' } },
    { route: 'DELETE /ledgers/:ledger/accounts/:id/snapshots/:snapshotId', params: (c) => ({ id: ids(c).investment, snapshotId: ids(c).snapshot }), kinds: { id: 'investment' } },
    { route: 'DELETE /ledgers/:ledger/accounts/:id', params: (c) => ({ id: find(c, "SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND name = 'Twin Savings'") }) },
    {
      route: 'DELETE /ledgers/:ledger/institutions/:id',
      params: (c) => ({ id: find(c, "SELECT institution_id FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?", ids(c).cash) }),
      query: (c) => ({ moveTo: ids(c).institution }),
    },
    // Tags and categories
    { route: 'POST /ledgers/:ledger/tags', body: () => ({ name: 'twin tag' }) },
    { route: 'PATCH /ledgers/:ledger/tags/:id', params: (c) => ({ id: ids(c).tag }), body: () => ({ name: 'japan', color: '#16a34a' }) },
    { route: 'DELETE /ledgers/:ledger/tags/:id', params: (c) => ({ id: find(c, "SELECT id FROM tags WHERE ledger_id = @ledger AND name = 'twin-tag'") }) },
    ...categories,
    // Recurring
    { route: 'POST /ledgers/:ledger/recurring/detect' },
    { route: 'POST /ledgers/:ledger/recurring', body: (c) => ({ payee: 'GYM', expectedAmountMinor: -5_000, cadence: 'monthly', anchorDate: '2026-09-01', accountId: ids(c).chequing, categoryId: live.category(c) }) },
    { route: 'PATCH /ledgers/:ledger/recurring/:id', params: (c) => ({ id: gym(c) }), body: () => ({ status: 'suggested' }) },
    { route: 'POST /ledgers/:ledger/recurring/:id/confirm', params: (c) => ({ id: gym(c) }) },
    { route: 'POST /ledgers/:ledger/recurring/:id/dismiss', params: (c) => ({ id: gym(c) }) },
    { route: 'PATCH /ledgers/:ledger/recurring/:id', params: (c) => ({ id: ids(c).recurring }), body: () => ({ otherPayees: ['TWIN PAYEE'], amountTolerancePct: 15 }) },
    { route: 'POST /ledgers/:ledger/recurring/:id/not-payment', params: (c) => ({ id: ids(c).recurring }), body: (c) => ({ transactionId: ids(c).payment }) },
    { route: 'POST /ledgers/:ledger/recurring/:id/add-payment', params: (c) => ({ id: ids(c).recurring }), body: (c) => ({ transactionId: ids(c).payment }) },
    { route: 'POST /ledgers/:ledger/recurring/:id/link-payment', params: (c) => ({ id: ids(c).recurring }), body: (c) => ({ transactionId: ids(c).purchase }) },
    { route: 'DELETE /ledgers/:ledger/recurring/:id', params: (c) => ({ id: gym(c) }) },
    // Custom reports
    { route: 'POST /ledgers/:ledger/custom-reports', body: (c) => ({ name: 'Twin report', spec: { filter: filter(c), range: '12m' } }) },
    { route: 'PATCH /ledgers/:ledger/custom-reports/:id', params: (c) => ({ id: twinReport(c) }), body: () => ({ name: 'Twin report 2' }) },
    { route: 'PUT /ledgers/:ledger/custom-reports/order', body: (c) => ({ ids: [twinReport(c), ids(c).report] }) },
    { route: 'DELETE /ledgers/:ledger/custom-reports/:id', params: (c) => ({ id: twinReport(c) }) },
    // Import
    { route: 'POST /ledgers/:ledger/import/preview', body: (c) => ({ accountId: ids(c).chequing, rows: importRows }) },
    { route: 'POST /ledgers/:ledger/import/commit', query: () => ({ dryRun: true }), body: (c) => ({ accountId: ids(c).chequing, fileName: 'october.csv', rows: importRows }) },
    { route: 'POST /ledgers/:ledger/import/commit', body: (c) => ({ accountId: ids(c).chequing, fileName: 'october.csv', rows: importRows }) },
    { route: 'DELETE /ledgers/:ledger/import/batches/:id', params: (c) => ({ id: ids(c).batch }) },
    // Categorizing and payees
    { route: 'POST /ledgers/:ledger/categorize/suggest', body: (c) => ({ payee: 'COSTCO WHOLESALE #535', accountId: ids(c).card, amountMinor: -15_000 }) },
    { route: 'POST /ledgers/:ledger/categorize/run' },
    { route: 'POST /ledgers/:ledger/categorize/again', body: (c) => ({ ids: [ids(c).purchase] }) },
    { route: 'PUT /ledgers/:ledger/payees/choice', query: () => ({ dryRun: true }), body: (c) => ({ payee: 'HYDRO ONE', mode: 'always', categoryId: live.category(c) }) },
    { route: 'PUT /ledgers/:ledger/payees/choice', body: () => ({ payee: 'HYDRO ONE', mode: 'review' }) },
    // Payee names are the app's: renaming one renames it in every ledger.
    { route: 'POST /ledgers/:ledger/payees/rename', body: () => ({ payee: 'COSTCO WHOLESALE #535', name: 'Costco' }), appWide: true },
    { route: 'POST /ledgers/:ledger/setup/start' },
    { route: 'POST /ledgers/:ledger/setup/demo', status: () => 409 },
  ]
}

const gym = (c: C) => find(c, "SELECT id FROM recurring_items WHERE ledger_id = @ledger AND name = 'GYM'")
const twinReport = (c: C) => find(c, "SELECT id FROM custom_reports WHERE ledger_id = @ledger AND name LIKE 'Twin report%'")
const importRows = [
  { line: 1, date: '2026-10-01', payee: 'IMPORTED SHOP', amountMinor: -4_200 },
  { line: 2, date: '2026-10-02', payee: 'HYDRO ONE', amountMinor: -9_100 },
]

/** After the MCP tools: the ledger as a whole. */
const ENDINGS: Case[] = [
  { route: 'PATCH /ledgers/:ledger', body: (c) => ({ color: '#16a34a', name: `${c.me.ctx.ledger.name} renamed` }) },
  { route: 'POST /ledgers/:ledger/erase', body: () => ({ confirm: 'erase' }) },
  { route: 'POST /ledgers/:ledger/setup/demo' },
  { route: 'DELETE /ledgers/:ledger', body: (c) => ({ confirm: c.t.storage.registry.get(ledgerOf(c)).name }) },
]

// MCP ------------------------------------------------------------------------------------------

interface ToolCase {
  tool: string
  args: (c: C) => Record<string, unknown>
  /** It answers with an error on purpose (a key limited to some ledgers can't do it, say). */
  error?: (c: C) => boolean
}

const L = (c: C) => ({ ledger: c.me.slug })

const MCP_READS: ToolCase[] = [
  { tool: 'list_ledgers', args: () => ({}) },
  { tool: 'get_month_summary', args: (c) => ({ ...L(c), month: '2026-09' }) },
  { tool: 'get_net_worth', args: (c) => ({ ...L(c), months: 24 }) },
  { tool: 'search_transactions', args: (c) => ({ ...L(c), query: 'costco' }) },
  { tool: 'search_transactions', args: (c) => ({ ...L(c), account: ids(c).card, category: ids(c).category, from: '2026-01-01', to: '2026-09-30' }) },
  { tool: 'search_transactions', args: (c) => ({ ...L(c), tag: tagName(c) }) },
  { tool: 'search_transactions', args: (c) => ({ ...L(c), report: ids(c).report, spending: { only: { accounts: [ids(c).card] } } }) },
  { tool: 'get_transaction', args: (c) => ({ ...L(c), id: ids(c).refund }) },
  { tool: 'list_review_queue', args: (c) => ({ ...L(c), limit: 200 }) },
  { tool: 'list_accounts', args: (c) => ({ ...L(c), includeArchived: true }) },
  { tool: 'list_categories', args: (c) => ({ ...L(c), includeArchived: true }) },
  { tool: 'list_tags', args: L },
  { tool: 'list_recurring', args: L },
  { tool: 'upcoming_payments', args: (c) => ({ ...L(c), days: 90 }) },
  { tool: 'recurring_payment_candidates', args: (c) => ({ ...L(c), id: ids(c).recurring }) },
  { tool: 'spending_by_category', args: (c) => ({ ...L(c), ...RANGE, spending: { only: { accounts: [ids(c).card] }, filterOut: [{ tags: [tagName(c)] }] } }) },
  { tool: 'spending_trend', args: (c) => ({ ...L(c), months: 12, end: '2026-09', groupBy: 'group' }) },
  { tool: 'top_payees', args: (c) => ({ ...L(c), ...RANGE, limit: 50, report: ids(c).report }) },
  { tool: 'income_vs_spending', args: (c) => ({ ...L(c), months: 12, end: '2026-09' }) },
  { tool: 'list_custom_reports', args: L },
  { tool: 'get_report', args: (c) => ({ ...L(c), report: ids(c).report }) },
]

const sharedList = (c: C) => !own(c)

const MCP_WRITES: ToolCase[] = [
  { tool: 'add_transactions', args: (c) => ({ ...L(c), transactions: [{ account: ids(c).chequing, date: '2026-10-02', amount: -12.5, payee: 'MCP SHOP', category: live.category(c) }] }) },
  { tool: 'update_transaction', args: (c) => ({ ...L(c), id: ids(c).purchase, notes: 'via mcp' }) },
  { tool: 'link_transactions', args: (c) => ({ ...L(c), id: ids(c).moneyIn, links: [{ transactionId: ids(c).purchase, amount: 12, kind: 'refund' }] }) },
  { tool: 'set_categories', args: (c) => ({ ...L(c), assignments: [{ id: ids(c).purchase, category: live.otherCategory(c) }], dryRun: true }) },
  { tool: 'set_categories', args: (c) => ({ ...L(c), assignments: [{ id: ids(c).purchase, category: live.otherCategory(c) }] }) },
  { tool: 'accept_suggestions', args: (c) => ({ ...L(c), all: true }) },
  { tool: 'set_payee_choice', args: (c) => ({ ...L(c), payee: 'HYDRO ONE', mode: 'ask' }) },
  { tool: 'delete_transactions', args: (c) => ({ ...L(c), ids: [tx(c, 'MCP SHOP')] }) },
  { tool: 'create_account', args: (c) => ({ ...L(c), name: 'MCP Cash', type: 'cash', institution: 'Wallet' }) },
  { tool: 'update_account', args: (c) => ({ ...L(c), account: find(c, "SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND name = 'MCP Cash'"), notes: 'from mcp' }) },
  { tool: 'rename_institution', args: (c) => ({ ...L(c), institution: ids(c).institution, newName: 'TD Canada Trust' }) },
  { tool: 'record_balance', args: (c) => ({ ...L(c), account: ids(c).investment, balance: 26_000, date: '2026-10-02' }) },
  { tool: 'create_category', args: (c) => ({ ...L(c), name: 'MCP category' }), error: sharedList },
  { tool: 'update_category', args: (c) => (own(c) ? { ...L(c), category: live.otherCategory(c), name: 'Eating out' } : { ...L(c), category: live.otherCategory(c), archived: true, moveTo: live.category(c) }) },
  { tool: 'merge_category', args: (c) => ({ ...L(c), category: own(c) ? 'MCP category' : live.otherCategory(c), into: live.category(c) }), error: sharedList },
  { tool: 'label_categories', args: (c) => ({ ...L(c), label: 'Wants', add: [live.category(c)] }), error: sharedList },
  { tool: 'rename_tag', args: (c) => ({ ...L(c), tag: tagName(c), newName: 'japan-2026' }) },
  { tool: 'create_recurring', args: (c) => ({ ...L(c), payee: 'MCP GYM', amount: -40, cadence: 'monthly', nextDate: '2026-10-15', account: ids(c).chequing }) },
  { tool: 'dismiss_recurring', args: (c) => ({ ...L(c), id: find(c, "SELECT id FROM recurring_items WHERE ledger_id = @ledger AND name = 'MCP GYM'") }) },
  { tool: 'confirm_recurring', args: (c) => ({ ...L(c), id: find(c, "SELECT id FROM recurring_items WHERE ledger_id = @ledger AND name = 'MCP GYM'") }) },
  {
    tool: 'add_recurring_payment',
    args: (c) => ({
      ...L(c),
      id: ids(c).recurring,
      transactionId: find(
        c,
        `SELECT t.id FROM transactions t JOIN recurring_items r ON r.id = ? AND r.ledger_id = t.ledger_id
         WHERE t.ledger_id = @ledger AND t.account_id = r.account_id AND t.recurring_item_id IS NULL AND t.amount_minor < 0 AND t.deleted_at IS NULL
         ORDER BY t.date DESC LIMIT 1`,
        ids(c).recurring,
      ),
    }),
  },
  { tool: 'save_custom_report', args: (c) => ({ ...L(c), name: 'MCP report', spending: { only: { accounts: [ids(c).card] } } }) },
  { tool: 'delete_custom_report', args: (c) => ({ ...L(c), report: 'MCP report' }) },
  { tool: 'import_transactions', args: (c) => ({ ...L(c), account: ids(c).chequing, rows: [{ date: '2026-10-02', payee: 'MCP IMPORT', amount: -3 }] }) },
  { tool: 'import_transactions', args: (c) => ({ ...L(c), account: ids(c).chequing, rows: [{ date: '2026-10-02', payee: 'MCP IMPORT', amount: -3 }], confirm: true }) },
  // The bank connection also feeds the other ledger, so a key limited to this one syncs nothing.
  { tool: 'sync_banks', args: () => ({}) },
  // For the whole app: a key limited to some ledgers can't.
  { tool: 'create_ledger', args: () => ({ name: 'MCP ledger' }), error: () => true },
  // The default ledger can't be archived by a key limited to some ledgers (it would change which opens).
  { tool: 'archive_ledger', args: (c) => ({ ledger: c.me.slug }), error: (c) => c.t.storage.registry.defaultLedger().id === ledgerOf(c) },
]

// Running cases ------------------------------------------------------------------------------

const label = (k: Case, req: Req) => `${k.route} ${JSON.stringify({ path: req.path, query: req.query, body: req.body })}`

const segmentKind: Record<string, NumberKind> = {
  transactions: 'purchase',
  accounts: 'card',
  institutions: 'institution',
  categories: 'category',
  labels: 'label',
  'category-groups': 'group',
  tags: 'tag',
  recurring: 'recurring',
  'custom-reports': 'report',
  batches: 'batch',
}
/** Kinds whose ids are the same in both ledgers on the shared list. */
const CATALOG = new Set<NumberKind>(['category', 'otherCategory', 'group', 'label'])

function pathParams(route: string): Array<{ name: string; kind: NumberKind }> {
  const parts = route.split(' ')[1]!.split('/')
  return parts.flatMap((p, i) => {
    if (!p.startsWith(':') || p === ':ledger') return []
    const name = p.slice(1)
    return [{ name, kind: name === 'snapshotId' ? 'snapshot' : segmentKind[parts[i - 1]!]! }]
  })
}

async function request(c: C, k: Case, override: Record<string, number> = {}): Promise<Req> {
  const [method, pattern] = k.route.split(' ') as [string, string]
  const params = { ...k.params?.(c), ...override }
  const path = pattern.replace(':ledger', ledgerOf(c)).replace(/:(\w+)/g, (_, p: string) => {
    if (params[p] === undefined) throw new Error(`${k.route}: no ${p}`)
    return String(params[p])
  })
  return { method, path, query: k.query?.(c), body: await k.body?.(c) }
}

async function run(c: C, k: Case, override?: Record<string, number>): Promise<{ req: Req; res: Res }> {
  const req = await request(c, k, override)
  if (!k.pages) return { req, res: await send(c.t.app, req) }
  const all: Json[] = []
  let res: Res
  let cursor: string | undefined
  do {
    res = await send(c.t.app, { ...req, query: { ...req.query, cursor } })
    all.push(res.body)
    cursor = res.body?.nextCursor ?? undefined
  } while (res.status === 200 && cursor)
  return { req, res: { ...res, body: all } }
}

/** Whether an answer holds a ledger's canary (in any case: tag names are lower case). */
const holds = (body: unknown, canary: string) => JSON.stringify(body ?? null).toLowerCase().includes(canary.toLowerCase())
const SERVER_ERROR = /internal|sqlite|ledgerscope|ledger pin|outside the ledger scope|cross-ledger/i

const WORLDS = [
  { name: 'on the shared category list', own: false },
  { name: 'on their own category lists', own: true },
]
const DIRECTIONS = [
  { name: 'For A', pick: (t: Twins) => ({ me: t.a, other: t.b }) },
  { name: 'For B', pick: (t: Twins) => ({ me: t.b, other: t.a }) },
]

// The tests ------------------------------------------------------------------------------------

describe('the isolation test’s cases', () => {
  it('cover every route of a ledger, and every MCP tool', async () => {
    const t = twins()
    const specs = createApi(t.storage).specs.filter((s) => s.path === '/ledgers/:ledger' || s.path.startsWith('/ledgers/:ledger/'))
    expect(specs.length).toBeGreaterThan(100)
    const covered = new Set([...READS, ...writeCases(false), ...writeCases(true), ...ENDINGS].map((k) => k.route))
    const missing = specs.map((s) => `${s.method.toUpperCase()} ${s.path}`).filter((r) => !covered.has(r))
    expect(missing, 'routes with no isolation case').toEqual([])
    const known = new Set(specs.map((s) => `${s.method.toUpperCase()} ${s.path}`))
    expect([...covered].filter((r) => !known.has(r)), 'cases for routes that are gone').toEqual([])

    const client = await mcpClient(t.app, await apiKey(t.app, ['admin']))
    const tools = (await client.tools()).map((x) => x.name)
    const toolCases = new Set([...MCP_READS, ...MCP_WRITES].map((x) => x.tool))
    expect(tools.filter((x) => !toolCases.has(x)), 'MCP tools with no isolation case').toEqual([])
    expect([...toolCases].filter((x) => !tools.includes(x)), 'cases for tools that are gone').toEqual([])
    await client.close()
  })
})

for (const world of WORLDS) {
  // Each case walks every route. That is about 2s here and over the default 5s on a CI runner.
  describe(`Two ledgers ${world.name}`, { timeout: 30_000 }, () => {
    for (const direction of DIRECTIONS) {
      it(`${direction.name}, answer reads the same with the other ledger's rows gone, never with its canary`, async () => {
        const t = twins({ own: world.own })
        const c: C = { t, ...direction.pick(t) }
        const client = await mcpClient(t.app, await apiKey(t.app, ['read'], [c.me.ctx.ledger.id]))
        const capture = async () => {
          const out = new Map<string, Json>()
          for (const k of READS) {
            const { req, res } = await run(c, k)
            expect([k.route, res.status, res.message]).toEqual([k.route, 200, undefined])
            out.set(label(k, req), k.normalize ? k.normalize(res.body) : res.body)
          }
          for (const x of MCP_READS) {
            const args = x.args(c)
            const res = await client.call(x.tool, args)
            expect([x.tool, res.isError, res.isError ? res.text : '']).toEqual([x.tool, false, ''])
            out.set(`${x.tool} ${JSON.stringify(args)}`, res)
          }
          return out
        }
        const before = await capture()
        const leaks = [...before].filter(([, body]) => holds(body, c.other.canary)).map(([key]) => key)
        expect(leaks, `answers holding ${c.other.canary}`).toEqual([])
        // Its own canary shows, so the other's would have.
        expect([...before.values()].some((body) => holds(body, c.me.canary))).toBe(true)

        deleteRows(t.storage, c.other.ctx.ledger.id)
        expect(c.other.ctx.q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger')).toBe(0)
        const after = await capture()
        for (const [key, body] of before) expect(after.get(key), key).toEqual(body)
        await client.close()
      })

      it(`${direction.name}, answer the other ledger's ids as ids that don't exist, and leave it as it was`, async () => {
        const t = twins({ own: world.own })
        const c: C = { t, ...direction.pick(t) }
        const otherBefore = ledgerHash(t.storage, c.other.ctx.ledger.id)
        const probes: Array<{ name: string; make: (id: (kind: NumberKind) => number) => Promise<Req> }> = []
        // Every path id, with the request that works for the subject's own.
        for (const k of [...READS, ...writeCases(world.own)]) {
          for (const p of pathParams(k.route)) {
            const kind = k.kinds?.[p.name] ?? p.kind
            if (!world.own && CATALOG.has(kind)) continue
            probes.push({
              name: `${k.route} :${p.name}`,
              make: async (id) => {
                let params: Record<string, number>
                try {
                  params = k.params?.(c) ?? {}
                } catch {
                  params = {}
                }
                for (const q of pathParams(k.route)) params[q.name] ??= ids(c)[q.kind]
                return request(c, { ...k, params: () => params }, { [p.name]: id(kind) })
              },
            })
          }
        }
        for (const b of bodyProbes(c, world.own)) probes.push(b)

        const failures: unknown[] = []
        for (const p of probes) {
          const foreign = await send(t.app, await p.make((kind) => c.other.ids[kind] as number))
          const missing = await send(t.app, await p.make(() => MISSING))
          const words = (m?: string) => m?.replace(/\d+/g, '#')
          const ok =
            foreign.status === missing.status &&
            words(foreign.message) === words(missing.message) &&
            foreign.status < 500 &&
            !holds(foreign.body, c.other.canary)
          if (!ok) failures.push({ probe: p.name, foreign: [foreign.status, foreign.message], missing: [missing.status, missing.message] })
        }
        expect(failures).toEqual([])

        const client = await mcpClient(t.app, await apiKey(t.app, ['admin'], [c.me.ctx.ledger.id]))
        const toolFailures: unknown[] = []
        for (const x of toolProbes()) {
          const foreign = await client.call(x.tool, x.args(c, (kind) => c.other.ids[kind] as number))
          const missing = await client.call(x.tool, x.args(c, () => MISSING))
          const words = (s: string) => s.replace(/\d+/g, '#')
          if (foreign.isError !== missing.isError || words(foreign.text) !== words(missing.text) || holds(foreign, c.other.canary) || SERVER_ERROR.test(foreign.text)) {
            toolFailures.push({ tool: x.tool, foreign: foreign.text, missing: missing.text })
          }
        }
        expect(toolFailures).toEqual([])
        await client.close()
        expect(ledgerHash(t.storage, c.other.ctx.ledger.id)).toEqual(otherBefore)
      })

      it(`${direction.name}, keep every write to its own rows`, async () => {
        const t = twins({ own: world.own })
        const c: C = { t, ...direction.pick(t) }
        let otherBefore = ledgerHash(t.storage, c.other.ctx.ledger.id)
        const check = async (what: string, appWide = false) => {
          await settle()
          const now = ledgerHash(t.storage, c.other.ctx.ledger.id)
          if (appWide) {
            // Each payee is called the same in both ledgers again.
            const names = (x: Twin) => new Map(x.ctx.q.all<{ payee: string; key: string }>('SELECT DISTINCT payee, payee_key AS key FROM transactions WHERE ledger_id = @ledger').map((r) => [r.payee, r.key]))
            const mine = names(c.me)
            const differ = [...names(c.other)].filter(([payee, key]) => mine.has(payee) && mine.get(payee) !== key)
            expect(differ, what).toEqual([])
            otherBefore = now
          }
          expect(now, what).toEqual(otherBefore)
        }
        const writes = async (cases: Case[]) => {
          for (const k of cases) {
            const { req, res } = await run(c, k)
            const expected = k.status?.(c)
            const what = `${label(k, req)} → ${res.status} ${res.message ?? ''}`
            if (expected) expect(res.status, what).toBe(expected)
            else expect(res.status, what).toBeLessThan(400)
            expect(holds(res.body, c.other.canary), what).toBe(false)
            await check(what, k.appWide)
          }
        }
        await writes(writeCases(world.own))

        const client = await mcpClient(t.app, await apiKey(t.app, ['admin'], [c.me.ctx.ledger.id]))
        for (const x of MCP_WRITES) {
          const args = x.args(c)
          const res: ToolRes = await client.call(x.tool, args)
          const what = `${x.tool} ${JSON.stringify(args)} → ${res.text}`
          expect(res.isError, what).toBe(x.error?.(c) ?? false)
          expect(SERVER_ERROR.test(res.text), what).toBe(false)
          expect(holds(res, c.other.canary), what).toBe(false)
          await check(what)
        }
        await client.close()

        await writes(ENDINGS)
        expect(t.storage.registry.find(ledgerOf(c))).toBeUndefined()
      })

      it(`${direction.name}, refuse a key limited to the other ledger`, async () => {
        const t = twins({ own: world.own })
        const c: C = { t, ...direction.pick(t) }
        const meBefore = ledgerHash(t.storage, c.me.ctx.ledger.id)
        const limited = await apiKey(t.app, ['admin'], [c.other.ctx.ledger.id])
        const refused = "This API key isn't allowed to use that ledger."
        const specs = createApi(t.storage).specs.filter((s) => s.path === '/ledgers/:ledger' || s.path.startsWith('/ledgers/:ledger/'))
        const answers: unknown[] = []
        for (const ledger of [c.me.slug, c.me.ctx.ledger.id]) {
          for (const s of specs) {
            const path = s.path.replace(':ledger', ledger).replace(/:\w+/g, String(c.me.ids.purchase))
            // The ledger's own routes read their body first: send ones that would work.
            const whole = { patch: { color: '#16a34a' }, delete: { confirm: c.me.ctx.ledger.name } } as Record<string, unknown>
            const body = s.method === 'get' ? undefined : s.path === '/ledgers/:ledger' ? whole[s.method] : {}
            const res = await send(t.app, { method: s.method.toUpperCase(), path, body }, limited)
            if (res.status !== 403 || res.message !== refused) answers.push([s.method, path, res.status, res.message])
          }
        }
        expect(answers).toEqual([])

        const client = await mcpClient(t.app, limited)
        const toolAnswers: unknown[] = []
        for (const x of [...MCP_READS, ...MCP_WRITES]) {
          let args: Record<string, unknown>
          try {
            args = x.args(c)
          } catch {
            // Its arguments are for rows an earlier write makes: the tool is tried with others.
            continue
          }
          if (!('ledger' in args)) continue
          const res = await client.call(x.tool, args)
          if (!res.isError || holds(res, c.me.canary)) toolAnswers.push([x.tool, res.text])
        }
        expect(toolAnswers).toEqual([])
        const listed = await client.call('list_ledgers', {})
        expect(listed.data.ledgers.map((l: Json) => l.slug)).toEqual([c.other.slug])
        await client.close()
        expect(ledgerHash(t.storage, c.me.ctx.ledger.id)).toEqual(meBefore)
      })
    }
  })
}

// Ids in requests -------------------------------------------------------------------------------

type Id = (kind: NumberKind) => number

/** Requests with another ledger's ids in their bodies and queries. */
function bodyProbes(c: C, ownLists: boolean): Array<{ name: string; make: (id: Id) => Promise<Req> }> {
  const base = `/ledgers/${ledgerOf(c)}`
  const i = ids(c)
  const r = (name: string, method: string, path: string, body?: (id: Id) => unknown, query?: (id: Id) => Record<string, unknown>) => ({
    name,
    make: async (id: Id) => ({ method, path: `${base}${path}`, body: body?.(id), query: query?.(id) }),
  })
  const tx = (accountId: number, extra: Record<string, unknown> = {}) => ({ accountId, date: '2026-10-01', amountMinor: -1_000, payee: 'PROBE', ...extra })
  const probes = [
    r('transactions?accountId', 'GET', '/transactions', undefined, (id) => ({ accountId: id('card') })),
    r('transactions?tagId', 'GET', '/transactions', undefined, (id) => ({ tagId: id('tag') })),
    r('transactions?recurringItemId', 'GET', '/transactions', undefined, (id) => ({ recurringItemId: id('recurring') })),
    r('transactions?filter', 'GET', '/transactions', undefined, (id) => ({
      filter: { v: 1, spending: { only: [{ field: 'account', ids: [id('card')] }, { field: 'tag', ids: [id('tag')] }], filterOut: [], picked: [id('purchase')], keep: [id('refund')] } },
    })),
    r('reports/by-category?filter', 'GET', '/reports/by-category', undefined, (id) => ({
      ...RANGE,
      filter: { v: 1, spending: { only: [{ field: 'recurring', ids: [id('recurring')] }], filterOut: [], picked: [id('purchase')], keep: [] } },
    })),
    r('POST transactions accountId', 'POST', '/transactions', (id) => tx(id('card'))),
    r('POST transactions transferAccountId', 'POST', '/transactions', (id) => tx(i.chequing, { transferAccountId: id('investment') })),
    r('PATCH transaction accountId', 'PATCH', `/transactions/${i.purchase}`, (id) => ({ accountId: id('card') })),
    r('PATCH transaction recurringItemId', 'PATCH', `/transactions/${i.purchase}`, (id) => ({ recurringItemId: id('recurring') })),
    r('bulk ids', 'POST', '/transactions/bulk', (id) => ({ ids: [id('purchase')], addTags: ['probe'] })),
    r('bulk delete', 'POST', '/transactions/bulk', (id) => ({ ids: [id('purchase')], delete: true })),
    r('links transactionId', 'PUT', `/transactions/${i.moneyIn}/links`, (id) => ({ links: [{ transactionId: id('purchase'), amountMinor: 100, kind: 'refund' }] })),
    r('links together id', 'PUT', '/transactions/links', (id) => ({ sets: [{ id: id('refund'), links: [] }] })),
    r('links together transactionId', 'PUT', '/transactions/links', (id) => ({ sets: [{ id: i.moneyIn, links: [{ transactionId: id('purchase'), amountMinor: 100, kind: 'refund' }] }] })),
    r('account institutionId', 'PATCH', `/accounts/${i.card}`, (id) => ({ institutionId: id('institution') })),
    r('POST account institutionId', 'POST', '/accounts', (id) => ({ name: 'Probe', type: 'cash', institutionId: id('institution') })),
    r('institution moveTo', 'DELETE', `/institutions/${i.institution}`, undefined, (id) => ({ moveTo: id('institution') })),
    r('accounts reorder', 'POST', '/accounts/reorder', (id) => ({ ids: [id('card')] })),
    r('institutions reorder', 'POST', '/institutions/reorder', (id) => ({ ids: [id('institution')] })),
    r('custom reports order', 'PUT', '/custom-reports/order', (id) => ({ ids: [id('report')] })),
    r('POST recurring accountId', 'POST', '/recurring', (id) => ({ payee: 'PROBE', expectedAmountMinor: -100, cadence: 'monthly', anchorDate: '2026-09-01', accountId: id('card') })),
    r('PATCH recurring accountId', 'PATCH', `/recurring/${i.recurring}`, (id) => ({ accountId: id('card') })),
    r('recurring link-payment', 'POST', `/recurring/${i.recurring}/link-payment`, (id) => ({ transactionId: id('purchase') })),
    r('recurring add-payment', 'POST', `/recurring/${i.recurring}/add-payment`, (id) => ({ transactionId: id('payment') })),
    r('recurring not-payment', 'POST', `/recurring/${i.recurring}/not-payment`, (id) => ({ transactionId: id('payment') })),
    r('import preview accountId', 'POST', '/import/preview', (id) => ({ accountId: id('chequing'), rows: importRows })),
    r('import commit accountId', 'POST', '/import/commit', (id) => ({ accountId: id('chequing'), rows: importRows }), () => ({ dryRun: true })),
    r('suggest accountId', 'POST', '/categorize/suggest', (id) => ({ payee: 'COSTCO WHOLESALE #535', accountId: id('card') })),
    r('categorize again ids', 'POST', '/categorize/again', (id) => ({ ids: [id('purchase')] })),
    r('switch pairs', 'POST', `/accounts/${i.cash}/bank/switch`, (id) => ({ bankAccountId: FREE_BANK_ACCOUNT, from: '2026-09-01', version: 'x', pairs: [{ transactionId: id('purchase'), remoteId: 's1' }], remove: [id('purchase')] })),
  ]
  if (ownLists) {
    probes.push(
      r('transactions?categoryId', 'GET', '/transactions', undefined, (id) => ({ categoryId: id('category') })),
      r('transactions?labelId', 'GET', '/transactions', undefined, (id) => ({ labelId: id('label') })),
      r('POST transactions categoryId', 'POST', '/transactions', (id) => tx(i.chequing, { categoryId: id('category') })),
      r('PATCH transaction categoryId', 'PATCH', `/transactions/${i.purchase}`, (id) => ({ categoryId: id('category') })),
      r('bulk categoryId', 'POST', '/transactions/bulk', (id) => ({ ids: [i.purchase], categoryId: id('category') })),
      r('POST recurring categoryId', 'POST', '/recurring', (id) => ({ payee: 'PROBE', expectedAmountMinor: -100, cadence: 'monthly', anchorDate: '2026-09-01', categoryId: id('category') })),
      r('payee choice categoryId', 'PUT', '/payees/choice', (id) => ({ payee: 'HYDRO ONE', mode: 'always', categoryId: id('category') }), () => ({ dryRun: true })),
      r('payee choice ?categoryId', 'GET', '/payees/choice', undefined, (id) => ({ payeeKey: 'new grocer', categoryId: id('category') })),
      r('merge into', 'POST', `/categories/${i.otherCategory}/merge`, (id) => ({ into: id('category') })),
      r('label add', 'POST', `/labels/${i.label}/categories`, (id) => ({ add: [id('category')], remove: [] })),
      r('category groupId', 'PATCH', `/categories/${i.category}`, (id) => ({ groupId: id('group') })),
      r('category labelIds', 'PATCH', `/categories/${i.category}`, (id) => ({ labelIds: [id('label')] })),
      r('POST category groupId', 'POST', '/categories', (id) => ({ name: 'Probe', groupId: id('group') })),
      r('categories reorder', 'POST', '/categories/reorder', (id) => ({ ids: [id('category')] })),
      r('groups reorder', 'POST', '/category-groups/reorder', (id) => ({ ids: [id('group')] })),
      r('import commit categoryId', 'POST', '/import/commit', (id) => ({ accountId: i.chequing, rows: [{ ...importRows[0], categoryId: id('category') }] }), () => ({ dryRun: true })),
      r('report filter category', 'POST', '/custom-reports', (id) => ({ name: `Probe report ${id('category')}`, spec: { filter: { v: 1, spending: { only: [{ field: 'category', ids: [id('category')] }] } } } })),
    )
  } else {
    probes.push(r('turn off moveTo', 'PATCH', `/categories/${i.otherCategory}`, (id) => ({ enabled: false, moveTo: id('category') })))
  }
  return probes
}

/** MCP tools with another ledger's ids. */
function toolProbes(): Array<{ tool: string; args: (c: C, id: Id) => Record<string, unknown> }> {
  return [
    { tool: 'get_transaction', args: (c, id) => ({ ...L(c), id: id('purchase') }) },
    { tool: 'update_transaction', args: (c, id) => ({ ...L(c), id: id('purchase'), notes: 'probe' }) },
    { tool: 'update_transaction', args: (c, id) => ({ ...L(c), id: ids(c).purchase, account: id('card') }) },
    { tool: 'link_transactions', args: (c, id) => ({ ...L(c), id: id('refund'), links: [] }) },
    { tool: 'link_transactions', args: (c, id) => ({ ...L(c), id: ids(c).moneyIn, links: [{ transactionId: id('purchase'), amount: 1, kind: 'refund' }] }) },
    { tool: 'set_categories', args: (c, id) => ({ ...L(c), assignments: [{ id: id('purchase'), category: null }], dryRun: true }) },
    { tool: 'accept_suggestions', args: (c, id) => ({ ...L(c), ids: [id('suggestion')], dryRun: true }) },
    { tool: 'delete_transactions', args: (c, id) => ({ ...L(c), ids: [id('purchase')], dryRun: true }) },
    { tool: 'add_transactions', args: (c, id) => ({ ...L(c), transactions: [{ account: id('card'), date: '2026-10-01', amount: -1, payee: 'PROBE' }] }) },
    { tool: 'search_transactions', args: (c, id) => ({ ...L(c), account: id('card') }) },
    { tool: 'update_account', args: (c, id) => ({ ...L(c), account: id('card'), notes: 'probe' }) },
    { tool: 'record_balance', args: (c, id) => ({ ...L(c), account: id('investment'), balance: 1, date: '2026-10-01' }) },
    { tool: 'rename_institution', args: (c, id) => ({ ...L(c), institution: id('institution'), newName: 'Probe' }) },
    { tool: 'confirm_recurring', args: (c, id) => ({ ...L(c), id: id('recurring') }) },
    { tool: 'dismiss_recurring', args: (c, id) => ({ ...L(c), id: id('recurring') }) },
    { tool: 'recurring_payment_candidates', args: (c, id) => ({ ...L(c), id: id('recurring') }) },
    { tool: 'add_recurring_payment', args: (c, id) => ({ ...L(c), id: id('recurring'), transactionId: ids(c).payment }) },
    { tool: 'add_recurring_payment', args: (c, id) => ({ ...L(c), id: ids(c).recurring, transactionId: id('payment') }) },
    { tool: 'get_report', args: (c, id) => ({ ...L(c), report: id('report') }) },
    { tool: 'delete_custom_report', args: (c, id) => ({ ...L(c), report: id('report') }) },
    { tool: 'import_transactions', args: (c, id) => ({ ...L(c), account: id('chequing'), rows: [{ date: '2026-10-01', payee: 'PROBE', amount: -1 }] }) },
  ]
}

