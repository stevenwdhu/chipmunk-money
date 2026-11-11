import { z } from 'zod'
import {
  ACCOUNT_TYPE_VALUES,
  addRule,
  CADENCE_VALUES,
  comparePeriods,
  comparisonRange,
  completeMonthAverage,
  describeFilter,
  describeRule,
  EVERYTHING,
  FILTER_SIDES,
  filterSchema,
  filterToParam,
  isReportRange,
  mergeCondition,
  monthOf,
  PAYEE_CHOICES,
  rangeOf,
  RECURRING_STATUSES,
  REPORT_COMPARE,
  resolveRange,
  withSide,
  type Condition,
  type CustomReport,
  type FilterNames,
  type PayeeSearchResult,
  type PeriodSummary,
  type ReportFilter,
  type ReportPurchases,
  type ReportRange,
  type ReportSpec,
  type TransactionSpan,
  type Account,
  type ApiScope,
  type BulkResult,
  type Category,
  type CategoryAmount,
  type CategoryGroup,
  type CategoryMergeResult,
  type ImportPreviewRow,
  type ImportResult,
  type Institution,
  type Label,
  type Ledger,
  type MonthSummary,
  type MonthTotals,
  type PayeeChoice,
  type NetWorthReport,
  type PayeeTotal,
  type RecurringItem,
  type RecurringPaymentCandidate,
  type SyncResult,
  type Tag,
  type TagWithCount,
  type Transaction,
  type TransactionPage,
  type TrendReport,
  type UpcomingPayment,
} from '@st/shared'
import {
  accountView,
  categoryView,
  ledgerView,
  money,
  toMinor,
  ToolError,
  transactionLine,
  transactionView,
  viewAccount,
  viewCategory,
  viewTransaction,
  type Lookups,
  type ToolContext,
} from './context'

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string
  /** The API scope the tool needs. Tools a key can't use aren't listed for it at all. */
  scope: ApiScope
  title: string
  description: string
  input: I
  output: O
  annotations?: ToolAnnotations
  run: (args: z.output<I>, ctx: ToolContext) => Promise<{ text: string; data: z.output<O> }>
}

const tool = <I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>) => def as unknown as ToolDef

// Shared argument shapes -------------------------------------------------------

const ledger = z.string().optional().describe('Ledger slug or name, e.g. "personal". Leave out to use your default ledger.')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM')
const nameOrId = z.union([z.string().min(1), z.number().int()])
const amount = z.number().describe('In dollars, e.g. -12.99. Negative is money out (spending); positive is money in.')
const categoryRef = z
  .union([z.string(), z.number().int(), z.null()])
  .describe('Category name (e.g. "Groceries") or id. null or "none" leaves it uncategorized.')
const dryRun = z.boolean().default(false).describe('Report what would change without changing anything.')
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

const amountPair = (minor: number) => ({ minor, formatted: money(minor) })
const moneyOut = z.object({ minor: z.number(), formatted: z.string() })
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

async function monthRange(ctx: ToolContext, from?: string, to?: string) {
  const today = await ctx.today()
  return { from: from ?? `${today.slice(0, 7)}-01`, to: to ?? today }
}

/** Groups and their categories, for listing and for prompts. */
/** Label ids for these names, adding any label that doesn't exist yet. */
async function labelIds(ctx: ToolContext, l: Ledger, lk: Lookups, names: string[]): Promise<number[]> {
  const ids: number[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    const existing = lk.labels.find((x) => x.name.toLowerCase() === name.toLowerCase())
    const label = existing ?? (await ctx.api.post<Label>(`${lk.categoryBase(l)}/labels`, { name }))
    if (!existing) lk.labels.push(label)
    ids.push(label.id)
  }
  return ids
}

function categoryTree(lk: Lookups, includeArchived: boolean) {
  const visible = lk.categories.filter((c) => includeArchived || !c.archived)
  const groups = lk.groups.map((g) => ({
    group: g.name,
    categories: visible.filter((c) => c.groupId === g.id).map((c) => viewCategory(c, lk)),
  }))
  const ungrouped = visible.filter((c) => c.groupId === null || !lk.groups.some((g) => g.id === c.groupId))
  if (ungrouped.length) groups.push({ group: 'Other', categories: ungrouped.map((c) => viewCategory(c, lk)) })
  return groups.filter((g) => g.categories.length)
}

/** "Klarna (Dyson vacuum)": the payee, and the item's name when it has one. */
const described = (r: { payee: string; name: string | null }) => `${r.payee}${r.name ? ` (${r.name})` : ''}`


// Report filters, by name ---------------------------------------------------------

const reportCondition = z
  .object({
    categories: z.array(z.union([z.string(), z.number().int()])).optional().describe('Category names or ids. "Uncategorized" for none.'),
    groups: z
      .array(nameOrId)
      .optional()
      .describe('Category group names, e.g. "Food": their categories. "none" (or "Other", as list_categories shows them) for uncategorized and categories with no group.'),
    labels: z.array(nameOrId).optional().describe('Category label names, e.g. "Wants": categories with any of them. "none" for uncategorized and categories with no label.'),
    tags: z.array(z.string()).optional().describe('Tag names, e.g. "trip-japan".'),
    payees: z.array(z.string()).optional().describe('Payee names as the app shows them, e.g. "Costco".'),
    accounts: z.array(nameOrId).optional().describe('Account names or ids. A refund or payback counts with its purchase’s account.'),
    words: z.array(z.string()).optional().describe('Words to find, as the search box does: payee, name, notes or recurring item.'),
    atLeast: z.number().nonnegative().optional().describe('Your share in dollars, at least: what it cost less its refunds and paybacks (for income: what came in).'),
    atMost: z.number().nonnegative().optional().describe('Your share in dollars, at most.'),
    recurring: z.enum(['any', 'none']).optional().describe('any: payments of one of your recurring items. none: one-time ones.'),
  })
  .describe('Every field you give must match. A field with several values matches any of them.')
const reportSide = z.object({
  only: reportCondition.optional().describe('Count only what matches.'),
  filterOut: z.array(reportCondition).max(20).optional().describe('Filter out what matches any of these.'),
})

/** One report condition by name, as the filter's conditions (one per field given). */
async function conditionsOf(ctx: ToolContext, l: Ledger, lk: Lookups, c: z.output<typeof reportCondition>): Promise<Condition[]> {
  const out: Condition[] = []
  if (c.categories?.length) out.push({ field: 'category', ids: c.categories.map((r) => lk.category(r) ?? ('none' as const)) })
  const none = (r: string | number) => typeof r === 'string' && r.trim().toLowerCase() === 'none'
  // Categories without a group are listed under "Other": that's no group too, unless a group has that name.
  const ungrouped = (r: string | number) => none(r) || (typeof r === 'string' && r.trim().toLowerCase() === 'other' && !lk.groups.some((g) => g.name.toLowerCase() === 'other'))
  if (c.groups?.length) out.push({ field: 'group', ids: c.groups.map((r) => (ungrouped(r) ? ('none' as const) : lk.group(r).id)) })
  if (c.labels?.length) out.push({ field: 'label', ids: c.labels.map((r) => (none(r) ? ('none' as const) : lk.label(r).id)) })
  if (c.tags?.length) out.push({ field: 'tag', ids: await Promise.all(c.tags.map((t) => ctx.tagId(l, t))) })
  if (c.payees?.length) out.push({ field: 'payee', keys: await Promise.all(c.payees.map((p) => payeeKey(ctx, l, p))) })
  if (c.accounts?.length) out.push({ field: 'account', ids: c.accounts.map((a) => lk.account(a).id) })
  if (c.words?.length) out.push({ field: 'text', words: c.words })
  if (c.atLeast !== undefined || c.atMost !== undefined) {
    out.push({ field: 'amount', ...(c.atLeast !== undefined && { min: toMinor(c.atLeast) }), ...(c.atMost !== undefined && { max: toMinor(c.atMost) }) })
  }
  if (c.recurring) out.push({ field: 'recurring', ids: c.recurring })
  return out
}

/** A payee's key from its name as the app shows it: the exact name first, then the one name that has it. */
async function payeeKey(ctx: ToolContext, l: Ledger, name: string): Promise<string> {
  const found = await ctx.api.get<PayeeSearchResult[]>(`/ledgers/${l.slug}/payees/search`, { q: name, limit: 20 })
  const key = name.trim().toLowerCase()
  const exact = found.filter((p) => p.payee.toLowerCase() === key || p.payeeKey === key)
  const one = exact.length ? exact : found.length === 1 ? found : []
  if (one[0]) return one[0].payeeKey
  if (!found.length) throw new ToolError(`There's no payee called “${name}”. search_transactions finds how a payee is named.`)
  throw new ToolError(`“${name}” matches several payees: ${found.map((p) => `“${p.payee}”`).join(', ')}. Use the full name.`)
}

/** Names for describing filters: categories, groups, labels, tags, payees, accounts and recurring items. */
async function filterNames(ctx: ToolContext, l: Ledger, lk: Lookups, filters: ReportFilter[]): Promise<FilterNames> {
  const keys = [...new Set(filters.flatMap((f) => FILTER_SIDES.flatMap((side) => [...(f[side]?.only ?? []), ...(f[side]?.filterOut.flatMap((r) => r.when) ?? [])])).flatMap((c) => (c.field === 'payee' ? c.keys : [])))]
  const [tags, payees, items] = await Promise.all([
    ctx.api.get<TagWithCount[]>(`/ledgers/${l.slug}/tags`),
    keys.length ? ctx.api.get<PayeeSearchResult[]>(`/ledgers/${l.slug}/payees/search`, { keys: JSON.stringify(keys), limit: 200 }) : [],
    ctx.api.get<RecurringItem[]>(`/ledgers/${l.slug}/recurring`),
  ])
  return {
    category: (id) => lk.categories.find((c) => c.id === id)?.name,
    group: (id) => lk.groups.find((g) => g.id === id)?.name,
    label: (id) => lk.labels.find((x) => x.id === id)?.name,
    tag: (id) => tags.find((t) => t.id === id)?.name,
    payee: (key) => payees.find((p) => p.payeeKey === key)?.payee,
    account: (id) => lk.accounts.find((a) => a.id === id)?.name,
    recurring: (id) => items.find((r) => r.id === id)?.payee,
  }
}

const MISSING_REASON = { deleted: 'no longer exists', off: 'is turned off', unused: 'has no transactions left' } as const
const MISSING_KIND: Partial<Record<CustomReport['missing'][number]['kind'], string>> = { transaction: 'picked transaction', group: 'category group' }
const missingWarnings = (r: CustomReport) => r.missing.map((m) => `${r.name} uses a ${MISSING_KIND[m.kind] ?? m.kind} (${m.id}) that ${MISSING_REASON[m.reason]}.`)
const filterArgs = {
  report: nameOrId.optional().describe('A custom report’s name or id (list_custom_reports): use its filter.'),
  spending: reportSide.optional().describe('Conditions for spending, added to the report’s.'),
  income: reportSide.optional().describe('Conditions for income, added to the report’s.'),
}

async function customReport(ctx: ToolContext, l: Ledger, ref: string | number): Promise<CustomReport> {
  const reports = await ctx.api.get<CustomReport[]>(`/ledgers/${l.slug}/custom-reports`)
  const key = String(ref).trim().toLowerCase()
  const found = reports.find((r) => String(r.id) === key || r.name.toLowerCase() === key)
  if (!found) throw new ToolError(`There's no custom report “${ref}”. Reports: ${reports.map((r) => `“${r.name}”`).join(', ') || '(none yet)'}.`)
  return found
}

/** A side's conditions by name, as Only count conditions and Filter out rules. */
async function sideOfArgs(ctx: ToolContext, l: Ledger, lk: Lookups, given: z.output<typeof reportSide>) {
  const only = given.only ? await conditionsOf(ctx, l, lk, given.only) : []
  const rules = (await Promise.all((given.filterOut ?? []).map((c) => conditionsOf(ctx, l, lk, c)))).filter((when) => when.length)
  return { only, rules }
}

/** A report's filter (by name), with the conditions given added to it. */
async function filterFrom(ctx: ToolContext, l: Ledger, lk: Lookups, args: { report?: string | number; spending?: z.output<typeof reportSide>; income?: z.output<typeof reportSide> }) {
  const saved = args.report === undefined ? null : await customReport(ctx, l, args.report)
  let filter: ReportFilter = saved?.spec.filter ?? { v: 1 }
  for (const side of FILTER_SIDES) {
    const given = args[side]
    if (!given) continue
    const { only, rules } = await sideOfArgs(ctx, l, lk, given)
    filter = withSide(filter, side, (s) => ({ ...s, only: only.reduce(mergeCondition, s.only), filterOut: rules.reduce((all, when) => addRule(all, { when }), s.filterOut) }))
  }
  return { saved, filter: checked(filter) }
}

function checked(filter: ReportFilter): ReportFilter {
  const valid = filterSchema.safeParse(filter)
  if (!valid.success) throw new ToolError(`That filter doesn't work: ${valid.error.issues.map((i) => i.message).join(', ')}.`)
  return valid.data
}

const RANGE_HELP = (range: string) => `“${range}” isn't a range. Use 3m, 6m, 12m, 24m, ytd, last-year or months like 2025-11..2026-10.`
const pct = (n: number | null) => (n === null ? '' : `${Math.abs(Math.round(n * 100))}% ${n < 0 ? 'less' : 'more'}`)

const pageOut = z.object({ ledger: z.string(), transactions: z.array(transactionView), nextCursor: z.string().nullable() })

export const TOOLS: ToolDef[] = [
  // Ledgers -------------------------------------------------------------------
  tool({
    name: 'list_ledgers',
    scope: 'read',
    title: 'List ledgers',
    description: 'The ledgers (separate sets of books, e.g. "Personal" and "Family") you can use. Every other tool takes an optional `ledger`.',
    input: z.object({}),
    output: z.object({ ledgers: z.array(ledgerView) }),
    annotations: READ,
    run: async (_args, ctx) => {
      const ledgers = (await ctx.ledgers()).map((l) => ({
        name: l.name,
        slug: l.slug,
        isDefault: l.slug === ctx.me.defaultLedger,
        archived: l.archived,
        accounts: l.accounts,
        transactions: l.transactions,
      }))
      const text = ledgers
        .map((l) => `${l.name} (ledger: "${l.slug}")${l.isDefault ? ' · default' : ''}${l.archived ? ' · archived' : ''} · ${plural(l.accounts, 'account')}, ${plural(l.transactions, 'transaction')}`)
        .join('\n')
      return { text, data: { ledgers } }
    },
  }),

  // Overview ------------------------------------------------------------------
  tool({
    name: 'get_month_summary',
    scope: 'read',
    title: 'Get a month summary',
    description: 'Spending, income, savings rate and spending by category for one month (default: this month), compared with the previous month and the 3-month average.',
    input: z.object({ ledger, month: month.optional().describe('YYYY-MM. Default: this month.') }),
    output: z.object({
      ledger: z.string(),
      month: z.string(),
      spent: moneyOut,
      income: moneyOut,
      net: moneyOut,
      savingsRate: z.number().nullable(),
      previousMonthSpent: moneyOut,
      threeMonthAverageSpent: moneyOut,
      byCategory: z.array(z.object({ category: z.string(), group: z.string().nullable(), spent: moneyOut, count: z.number(), share: z.number() })),
      transactionCount: z.number(),
      needsReview: z.number().describe('Transactions with a suggested category to review.'),
      uncategorized: z.number(),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const { ledger: l, url } = await ctx.path(args.ledger, '/reports/summary')
      const s = await ctx.api.get<MonthSummary>(url, { month: args.month })
      const byCategory = s.byCategory.map((c) => ({
        category: c.name,
        group: c.groupName,
        spent: amountPair(c.amountMinor),
        count: c.count,
        share: s.spentMinor ? Math.round((c.amountMinor / s.spentMinor) * 1000) / 1000 : 0,
      }))
      const text = [
        `${l.name}, ${s.month}: spent ${money(s.spentMinor)}, income ${money(s.incomeMinor)}, net ${money(s.netMinor)}${s.savingsRate !== null ? ` (saved ${Math.round(s.savingsRate * 100)}%)` : ''}.`,
        `Previous month spent ${money(s.previousSpentMinor)}; 3-month average ${money(s.averageSpentMinor)}.`,
        `${plural(s.transactionCount, 'transaction')}, ${s.needsReviewCount} to review, ${s.uncategorizedCount} uncategorized.`,
        ...byCategory.slice(0, 12).map((c) => `- ${c.category}: ${c.spent.formatted} (${Math.round(c.share * 100)}%, ${plural(c.count, 'transaction')})`),
      ].join('\n')
      return {
        text,
        data: {
          ledger: l.slug,
          month: s.month,
          spent: amountPair(s.spentMinor),
          income: amountPair(s.incomeMinor),
          net: amountPair(s.netMinor),
          savingsRate: s.savingsRate,
          previousMonthSpent: amountPair(s.previousSpentMinor),
          threeMonthAverageSpent: amountPair(s.averageSpentMinor),
          byCategory,
          transactionCount: s.transactionCount,
          needsReview: s.needsReviewCount,
          uncategorized: s.uncategorizedCount,
        },
      }
    },
  }),
  tool({
    name: 'get_net_worth',
    scope: 'read',
    title: 'Get net worth',
    description:
      'Assets, liabilities and net worth today, each account’s balance, and month-end net worth for the past months. Liabilities are what’s owed on credit cards and loans.',
    input: z.object({ ledger, months: z.number().int().min(2).max(60).default(12) }),
    output: z.object({
      ledger: z.string(),
      assets: moneyOut,
      liabilities: moneyOut,
      netWorth: moneyOut,
      accounts: z.array(z.object({ name: z.string(), type: z.string(), balance: moneyOut, isLiability: z.boolean() })),
      history: z.array(z.object({ date: z.string(), netWorth: moneyOut })),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const { ledger: l, url } = await ctx.path(args.ledger, '/reports/net-worth')
      const r = await ctx.api.get<NetWorthReport>(url, { months: args.months })
      const accounts = r.byAccount.map((a) => ({
        name: a.name,
        type: a.type,
        balance: amountPair(a.balanceMinor),
        isLiability: a.isLiability,
      }))
      const text = [
        `${l.name}: net worth ${money(r.current.netWorthMinor)} (assets ${money(r.current.assetsMinor)}, liabilities ${money(r.current.liabilitiesMinor)}).`,
        ...accounts.map((a) => `- ${a.name} (${a.type}): ${a.balance.formatted}`),
      ].join('\n')
      return {
        text,
        data: {
          ledger: l.slug,
          assets: amountPair(r.current.assetsMinor),
          liabilities: amountPair(r.current.liabilitiesMinor),
          netWorth: amountPair(r.current.netWorthMinor),
          accounts,
          history: r.points.map((p) => ({ date: p.date, netWorth: amountPair(p.netWorthMinor) })),
        },
      }
    },
  }),

  // Transactions: read ----------------------------------------------------------
  tool({
    name: 'search_transactions',
    scope: 'read',
    title: 'Search transactions',
    description:
      'Newest first. Filter by text (payee, name, notes or an amount like 12.99), date range, account, category ("uncategorized" for none), category label, tag, or needsReview, and by a custom report or Only count and Filter out conditions (or what they filter out). Pass `cursor` from the previous result for more.',
    input: z.object({
      ledger,
      query: z.string().max(100).optional(),
      from: date.optional(),
      to: date.optional(),
      account: nameOrId.optional(),
      category: nameOrId.optional().describe('Category name or id, or "uncategorized".'),
      tag: z.string().optional(),
      needsReview: z.boolean().optional(),
      label: z
        .string()
        .optional()
        .describe('A category label (such as "Need"): transactions in categories with it. "none" for spending in categories without a label.'),
      ...filterArgs,
      filteredOut: z.boolean().optional().describe('With a report or conditions: the transactions they filter out, not the ones they count.'),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
    output: pageOut,
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const { filter } = await filterFrom(ctx, l, lk, args)
      // lk.category() turns "uncategorized" into null; the API calls that filter "none".
      const category = args.category === undefined ? undefined : (lk.category(args.category) ?? 'none')
      const page = await ctx.api.get<TransactionPage>(`/ledgers/${l.slug}/transactions`, {
        q: args.query,
        from: args.from,
        to: args.to,
        accountId: args.account === undefined ? undefined : lk.account(args.account).id,
        categoryId: category,
        tagId: args.tag ? await ctx.tagId(l, args.tag) : undefined,
        needsReview: args.needsReview,
        labelId: args.label === undefined ? undefined : args.label.trim().toLowerCase() === 'none' ? 'none' : lk.label(args.label).id,
        filter: filterToParam(filter),
        filteredOut: args.filteredOut,
        limit: args.limit,
        cursor: args.cursor,
      })
      const transactions = page.items.map((t) => viewTransaction(t, lk))
      const text = transactions.length
        ? [
            `${plural(transactions.length, 'transaction')} in ${l.name}${page.nextCursor ? ` (more: cursor "${page.nextCursor}")` : ''}:`,
            ...transactions.map(transactionLine),
          ].join('\n')
        : `No transactions match in ${l.name}.`
      return { text, data: { ledger: l.slug, transactions, nextCursor: page.nextCursor } }
    },
  }),
  tool({
    name: 'get_transaction',
    scope: 'read',
    title: 'Get a transaction',
    description: 'One transaction by id.',
    input: z.object({ ledger, id: z.number().int() }),
    output: z.object({ ledger: z.string(), transaction: transactionView }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const [t, lk] = await Promise.all([ctx.api.get<Transaction>(`/ledgers/${l.slug}/transactions/${args.id}`), ctx.lookups(l)])
      const v = viewTransaction(t, lk)
      return { text: transactionLine(v), data: { ledger: l.slug, transaction: v } }
    },
  }),
  tool({
    name: 'list_review_queue',
    scope: 'read',
    title: 'List the review queue',
    description:
      'Transactions waiting for a decision: those with a suggested category to accept or change, and uncategorized ones. Also lists the categories you can choose from. Work through it with set_categories and accept_suggestions.',
    input: z.object({ ledger, limit: z.number().int().min(1).max(200).default(50) }),
    output: z.object({
      ledger: z.string(),
      suggested: z.array(transactionView),
      uncategorized: z.array(transactionView),
      categories: z.array(z.object({ group: z.string(), categories: z.array(z.string()) })),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const base = `/ledgers/${l.slug}/transactions`
      const [suggested, uncategorized, lk] = await Promise.all([
        ctx.api.get<TransactionPage>(base, { needsReview: true, limit: args.limit }),
        ctx.api.get<TransactionPage>(base, { categoryId: 'none', limit: args.limit }),
        ctx.lookups(l),
      ])
      const s = suggested.items.map((t) => viewTransaction(t, lk))
      const u = uncategorized.items.map((t) => viewTransaction(t, lk))
      const categories = categoryTree(lk, false).map((g) => ({ group: g.group, categories: g.categories.map((c) => c.name) }))
      const text = [
        s.length ? `${plural(s.length, 'suggested category', 'suggested categories')} to review in ${l.name}:` : `No suggested categories to review in ${l.name}.`,
        ...s.map(transactionLine),
        u.length ? `\n${plural(u.length, 'uncategorized transaction')}:` : '\nNothing uncategorized.',
        ...u.map(transactionLine),
        `\nCategories: ${categories.map((g) => `${g.group}: ${g.categories.join(', ')}`).join(' | ')}`,
      ].join('\n')
      return { text, data: { ledger: l.slug, suggested: s, uncategorized: u, categories } }
    },
  }),

  // Transactions: write ---------------------------------------------------------
  tool({
    name: 'add_transactions',
    scope: 'write',
    title: 'Add transactions',
    description:
      'Adds up to 100 transactions. Give each an `externalId` (for example the bank’s id) to make retries safe: one that the account already has is not added again. Leave out `category` and the app suggests one from your history (or AI), flagged for review.',
    input: z.object({
      ledger,
      transactions: z
        .array(
          z.object({
            account: nameOrId.describe('Account name or id.'),
            date: date.optional().describe('Default: today.'),
            time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('Its time of day (HH:MM, local), if known: orders the day’s transactions.'),
            amount,
            payee: z.string().min(1).max(200),
            name: z.string().max(200).optional().describe('What it is, like “Suitcase”, when the payee doesn’t say.'),
            category: categoryRef.optional(),
            notes: z.string().max(1000).optional(),
            tags: z.array(z.string()).max(20).optional(),
            externalId: z.string().min(1).max(200).optional(),
            pending: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    output: z.object({
      ledger: z.string(),
      added: z.array(transactionView),
      alreadyThere: z.array(transactionView).describe('Had an externalId the account already has; nothing was added.'),
      failed: z.array(z.object({ index: z.number(), payee: z.string(), error: z.string() })),
    }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const today = await ctx.today()
      const added: Transaction[] = []
      const alreadyThere: Transaction[] = []
      const failed: Array<{ index: number; payee: string; error: string }> = []
      for (const [index, t] of args.transactions.entries()) {
        try {
          const body = {
            accountId: lk.account(t.account).id,
            date: t.date ?? today,
            datetime: t.time ? `${t.date ?? today}T${t.time}` : null,
            amountMinor: toMinor(t.amount),
            payee: t.payee,
            name: t.name,
            categoryId: t.category === undefined ? undefined : lk.category(t.category),
            notes: t.notes,
            tags: t.tags ?? [],
            externalId: t.externalId,
            status: t.pending ? 'pending' : 'cleared',
          }
          const res = await ctx.api.postWithStatus<Transaction>(`/ledgers/${l.slug}/transactions`, body)
          ;(res.status === 200 ? alreadyThere : added).push(res.data)
        } catch (err) {
          failed.push({ index, payee: t.payee, error: err instanceof Error ? err.message : String(err) })
        }
      }
      // Suggestions may have created nothing new, but the lookups are still current.
      const v = (list: Transaction[]) => list.map((t) => viewTransaction(t, lk))
      const text = [
        `Added ${plural(added.length, 'transaction')} to ${l.name}${alreadyThere.length ? `; ${alreadyThere.length} already there` : ''}${failed.length ? `; ${failed.length} failed` : ''}.`,
        ...v(added).map(transactionLine),
        ...failed.map((f) => `Failed #${f.index} (${f.payee}): ${f.error}`),
      ].join('\n')
      if (!added.length && !alreadyThere.length) throw new ToolError(text)
      return { text, data: { ledger: l.slug, added: v(added), alreadyThere: v(alreadyThere), failed } }
    },
  }),
  tool({
    name: 'update_transaction',
    scope: 'write',
    title: 'Update a transaction',
    description: 'Changes only the fields you give. Setting `category` also teaches the app this payee. `tags` replaces all tags.',
    input: z.object({
      ledger,
      id: z.number().int(),
      date: date.optional(),
      time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional().describe('Its time of day (HH:MM, local; null: none). Moving the date keeps it.'),
      amount: amount.optional(),
      payee: z.string().min(1).max(200).optional(),
      name: z.string().max(200).nullable().optional().describe('What it is, like “Suitcase”; null clears it. For a recurring item’s payment it renames the item, which all its payments share.'),
      account: nameOrId.optional(),
      category: categoryRef.optional(),
      notes: z.string().max(1000).nullable().optional(),
      tags: z.array(z.string()).max(20).optional(),
      pending: z.boolean().optional(),
    }),
    output: z.object({ ledger: z.string(), transaction: transactionView }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const t = await ctx.api.patch<Transaction>(`/ledgers/${l.slug}/transactions/${args.id}`, {
        date: args.date,
        // A time goes on the date given, or the one it has.
        datetime: args.time === undefined ? undefined : args.time === null ? null : `${args.date ?? (await ctx.api.get<Transaction>(`/ledgers/${l.slug}/transactions/${args.id}`)).date}T${args.time}`,
        amountMinor: args.amount === undefined ? undefined : toMinor(args.amount),
        payee: args.payee,
        name: args.name,
        accountId: args.account === undefined ? undefined : lk.account(args.account).id,
        categoryId: args.category === undefined ? undefined : lk.category(args.category),
        notes: args.notes,
        tags: args.tags,
        status: args.pending === undefined ? undefined : args.pending ? 'pending' : 'cleared',
      })
      const v = viewTransaction(t, lk)
      return { text: `Updated: ${transactionLine(v)}`, data: { ledger: l.slug, transaction: v } }
    },
  }),
  tool({
    name: 'link_transactions',
    scope: 'write',
    title: 'Link refunds and paybacks',
    description:
      'Sets what money in pays back (or, given a bill, what paid it back), replacing its links: a `refund` from the merchant, or a `payback` from someone sharing a bill you paid. One payback can cover several bills, each with its amount, and a bill can be paid back by several. Linked in full to one bill, money in takes its category; reports count each link in its bill’s category, a payback in the bill’s month. An empty list unlinks it.',
    input: z.object({
      ledger,
      id: z.number().int().describe('The money in (or the bill).'),
      links: z
        .array(
          z.object({
            transactionId: z.number().int().describe('The purchase or bill it pays back (or, for a bill, the money in).'),
            amount: z.number().positive().describe('In dollars: how much of the money in goes to it.'),
            kind: z.enum(['refund', 'payback']),
          }),
        )
        .max(100),
    }),
    output: z.object({ ledger: z.string(), transaction: transactionView }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const t = await ctx.api.put<Transaction>(`/ledgers/${l.slug}/transactions/${args.id}/links`, {
        links: args.links.map((x) => ({ transactionId: x.transactionId, amountMinor: toMinor(x.amount), kind: x.kind })),
      })
      const v = viewTransaction(t, lk)
      return { text: `Linked: ${transactionLine(v)}`, data: { ledger: l.slug, transaction: v } }
    },
  }),
  tool({
    name: 'set_categories',
    scope: 'write',
    title: 'Set categories',
    description:
      'Sets the category of many transactions at once, each to its own category. This is how to work through the review queue: it also teaches the app, so the same payee is categorized automatically next time. Try `dryRun: true` first for big changes.',
    input: z.object({
      ledger,
      assignments: z
        .array(z.object({ id: z.number().int(), category: categoryRef }))
        .min(1)
        .max(500),
      dryRun,
    }),
    output: z.object({
      ledger: z.string(),
      dryRun: z.boolean(),
      updated: z.number(),
      changes: z.array(z.object({ id: z.number(), payee: z.string(), date: z.string(), amount: z.string(), from: z.string().nullable(), to: z.string().nullable() })),
    }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const groups = new Map<number | null, number[]>()
      for (const a of args.assignments) {
        const id = lk.category(a.category)
        groups.set(id, [...(groups.get(id) ?? []), a.id])
      }
      const changes: Array<{ id: number; payee: string; date: string; amount: string; from: string | null; to: string | null }> = []
      for (const [categoryId, ids] of groups) {
        const r = await ctx.api.post<BulkResult>(`/ledgers/${l.slug}/transactions/bulk`, { ids, categoryId }, { dryRun: args.dryRun })
        for (const c of r.changes) {
          if (!('categoryId' in c.after) && !('needsReview' in c.after)) continue
          changes.push({
            id: c.id,
            payee: c.payee,
            date: c.date,
            amount: money(c.amountMinor),
            from: 'categoryId' in c.before ? lk.categoryName(c.before.categoryId as number | null) : lk.categoryName(categoryId),
            to: lk.categoryName(categoryId),
          })
        }
      }
      const verb = args.dryRun ? 'Would change' : 'Changed'
      const text = [
        `${verb} ${plural(changes.length, 'transaction')} in ${l.name}.`,
        ...changes.map((c) => `#${c.id} ${c.date} ${c.payee} ${c.amount}: ${c.from ?? 'uncategorized'} → ${c.to ?? 'uncategorized'}`),
      ].join('\n')
      return { text, data: { ledger: l.slug, dryRun: args.dryRun, updated: changes.length, changes } }
    },
  }),
  tool({
    name: 'accept_suggestions',
    scope: 'write',
    title: 'Accept suggested categories',
    description: 'Accepts the suggested category on the given transactions (or on every one with `all: true`). Accepting teaches the app your habits.',
    input: z.object({ ledger, ids: z.array(z.number().int()).max(1000).optional(), all: z.boolean().optional(), dryRun }),
    output: z.object({ ledger: z.string(), dryRun: z.boolean(), accepted: z.number() }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      let accepted: number
      if (args.all) {
        accepted = (await ctx.api.post<{ accepted: number }>(`/ledgers/${l.slug}/transactions/accept-all`, {}, { dryRun: args.dryRun })).accepted
      } else {
        if (!args.ids?.length) throw new ToolError('Pass the transaction `ids` to accept, or `all: true`.')
        const r = await ctx.api.post<BulkResult>(`/ledgers/${l.slug}/transactions/bulk`, { ids: args.ids, acceptSuggestions: true }, { dryRun: args.dryRun })
        accepted = r.updated
      }
      return {
        text: `${args.dryRun ? 'Would accept' : 'Accepted'} ${plural(accepted, 'suggested category', 'suggested categories')} in ${l.name}.`,
        data: { ledger: l.slug, dryRun: args.dryRun, accepted },
      }
    },
  }),
  tool({
    name: 'set_payee_choice',
    scope: 'write',
    title: 'Choose what happens to a payee',
    description:
      'For a payee (as it appears on its transactions): `always` sets one category on its transactions waiting for review or uncategorized, and on new ones without review. `review` never sets one on its own: for payees that can be several things, like e-transfers and transfers. `ask` (the default) suggests one to review each time.',
    input: z.object({
      ledger,
      payee: z.string().min(1).describe('The payee, e.g. "A&W RESTAURANTS #123"; store numbers and card noise don’t matter.'),
      mode: z.enum(PAYEE_CHOICES),
      category: z.union([z.string(), z.number()]).optional().describe('For `always`: the category, by name or id.'),
      dryRun,
    }),
    output: z.object({ ledger: z.string(), dryRun: z.boolean(), payee: z.string(), mode: z.enum(PAYEE_CHOICES), category: z.string().nullable(), updated: z.number() }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const categoryId = args.mode === 'always' ? lk.category(args.category ?? null) : null
      if (args.mode === 'always' && !categoryId) throw new ToolError('Say which `category` to always set.')
      // The server makes it into its payee, by the ledger's payee name rules.
      const r = await ctx.api.put<PayeeChoice & { updated: number }>(
        `/ledgers/${l.slug}/payees/choice`,
        { payee: args.payee, mode: args.mode, ...(categoryId ? { categoryId } : {}) },
        { dryRun: args.dryRun },
      )
      const category = lk.categoryName(r.categoryId)
      const would = args.dryRun ? 'would be' : 'is'
      const text =
        args.mode === 'always'
          ? `“${r.payeeKey}” ${would} always ${category} in ${l.name}${r.updated ? `; ${plural(r.updated, 'transaction')} ${args.dryRun ? 'would be' : ''} set and marked as reviewed` : ''}.`.replace('  ', ' ')
          : args.mode === 'review'
            ? `“${r.payeeKey}” ${would} never set on its own in ${l.name}; you review each one.`
            : `“${r.payeeKey}” ${would} suggested a category to review each time in ${l.name}.`
      return { text, data: { ledger: l.slug, dryRun: args.dryRun, payee: r.payeeKey, mode: args.mode, category, updated: r.updated } }
    },
  }),
  tool({
    name: 'delete_transactions',
    scope: 'write',
    title: 'Delete transactions',
    description: 'Deletes transactions (both sides of a transfer). They can be restored in the app for 30 days. Use `dryRun: true` to check first.',
    input: z.object({ ledger, ids: z.array(z.number().int()).min(1).max(1000), dryRun }),
    output: z.object({
      ledger: z.string(),
      dryRun: z.boolean(),
      deleted: z.array(z.object({ id: z.number(), date: z.string(), payee: z.string(), amount: z.string() })),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const r = await ctx.api.post<BulkResult>(`/ledgers/${l.slug}/transactions/bulk`, { ids: args.ids, delete: true }, { dryRun: args.dryRun })
      const deleted = r.changes.map((c) => ({ id: c.id, date: c.date, payee: c.payee, amount: money(c.amountMinor) }))
      const text = [
        `${args.dryRun ? 'Would delete' : 'Deleted'} ${plural(deleted.length, 'transaction')} in ${l.name}.`,
        ...deleted.map((d) => `#${d.id} ${d.date} ${d.payee} ${d.amount}`),
      ].join('\n')
      return { text, data: { ledger: l.slug, dryRun: args.dryRun, deleted } }
    },
  }),

  // Accounts --------------------------------------------------------------------
  tool({
    name: 'list_accounts',
    scope: 'read',
    title: 'List accounts',
    description: 'Accounts with current balances. Credit cards and loans are liabilities (their balance is negative when you owe).',
    input: z.object({ ledger, includeArchived: z.boolean().default(false) }),
    output: z.object({ ledger: z.string(), accounts: z.array(accountView) }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const accounts = (await ctx.api.get<Account[]>(`/ledgers/${l.slug}/accounts`)).filter((a) => args.includeArchived || !a.archived).map(viewAccount)
      const text = accounts.length
        ? accounts.map((a) => `#${a.id} ${a.name} at ${a.institution} (${a.type}${a.archived ? ', archived' : ''}): ${a.balance}`).join('\n')
        : `${l.name} has no accounts yet.`
      return { text, data: { ledger: l.slug, accounts } }
    },
  }),
  tool({
    name: 'create_account',
    scope: 'write',
    title: 'Create an account',
    description:
      'Its balance adds up its transactions, from the latest balance recorded with record_balance (or the opening balance). Investments, loans and property mostly move by recorded balances, since their value changes on its own.',
    input: z.object({
      ledger,
      name: z.string().min(1).max(80),
      type: z.enum(ACCOUNT_TYPE_VALUES),
      openingBalance: z.number().default(0).describe('In dollars. For a credit card or loan you owe on, use a negative number.'),
      openingDate: date.optional(),
      institution: z.string().min(1).max(80).describe('Where it’s held, e.g. “TD” or “Wallet”: an institution you already have (by name), or a new one.'),
      notes: z.string().max(1000).optional(),
    }),
    output: z.object({ ledger: z.string(), account: accountView }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const a = await ctx.api.post<Account>(`/ledgers/${l.slug}/accounts`, {
        name: args.name,
        type: args.type,
        openingBalanceMinor: toMinor(args.openingBalance),
        openingDate: args.openingDate,
        institution: args.institution,
        notes: args.notes,
      })
      return { text: `Created the account #${a.id} ${a.name} in ${l.name}.`, data: { ledger: l.slug, account: viewAccount(a) } }
    },
  }),
  tool({
    name: 'update_account',
    scope: 'write',
    title: 'Update an account',
    description: 'Rename, change details, or archive (hide from lists while keeping its history).',
    input: z.object({
      ledger,
      account: nameOrId,
      name: z.string().min(1).max(80).optional(),
      institution: z.string().min(1).max(80).optional().describe('Move it to this institution (by name; a new name adds one).'),
      notes: z.string().max(1000).nullable().optional(),
      archived: z.boolean().optional(),
    }),
    output: z.object({ ledger: z.string(), account: accountView }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const target = (await ctx.lookups(l)).account(args.account)
      const a = await ctx.api.patch<Account>(`/ledgers/${l.slug}/accounts/${target.id}`, {
        name: args.name,
        institution: args.institution,
        notes: args.notes,
        archived: args.archived,
      })
      return { text: `Updated the account #${a.id} ${a.name}.`, data: { ledger: l.slug, account: viewAccount(a) } }
    },
  }),
  tool({
    name: 'rename_institution',
    scope: 'write',
    title: 'Rename an institution',
    description: 'Renames the bank or other place accounts are held. Its accounts move with it, and a synced one keeps its match to the bank.',
    input: z.object({ ledger, institution: nameOrId, newName: z.string().min(1).max(80) }),
    output: z.object({ ledger: z.string(), institution: z.object({ id: z.number(), name: z.string() }) }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const before = await ctx.institution(l, args.institution)
      const i = await ctx.api.patch<Institution>(`/ledgers/${l.slug}/institutions/${before.id}`, { name: args.newName })
      return { text: `Renamed ${before.name} to ${i.name}.`, data: { ledger: l.slug, institution: { id: i.id, name: i.name } } }
    },
  }),
  tool({
    name: 'record_balance',
    scope: 'write',
    title: 'Record an account balance',
    description:
      'The balance at the end of a day (default today). Mostly for investments, loans and property. Recording again on the same day replaces it. Not for a synced account, whose balance is the bank’s.',
    input: z.object({ ledger, account: nameOrId, balance: z.number().describe('In dollars; negative for money owed.'), date: date.optional() }),
    output: z.object({ ledger: z.string(), account: accountView }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const target = (await ctx.lookups(l)).account(args.account)
      const a = await ctx.api.post<Account>(`/ledgers/${l.slug}/accounts/${target.id}/balance`, {
        date: args.date ?? (await ctx.today()),
        balanceMinor: toMinor(args.balance),
      })
      return { text: `${a.name} is now ${money(a.balanceMinor, a.currency)}.`, data: { ledger: l.slug, account: viewAccount(a) } }
    },
  }),

  // Categories & tags -----------------------------------------------------------
  tool({
    name: 'list_categories',
    scope: 'read',
    title: 'List categories',
    description:
      'Categories by group, with your labels on them (such as Need or Want). Categories marked excludeFromTotals (transfers, card payments) don’t count as spending.',
    input: z.object({ ledger, includeArchived: z.boolean().default(false) }),
    output: z.object({ ledger: z.string(), groups: z.array(z.object({ group: z.string(), categories: z.array(categoryView) })) }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const groups = categoryTree(await ctx.lookups(l), args.includeArchived)
      const text = groups
        .map((g) => `${g.group}: ${g.categories.map((c) => `${c.name} (#${c.id})${c.labels.length ? ` [${c.labels.join(', ')}]` : ''}`).join(', ')}`)
        .join('\n')
      return { text, data: { ledger: l.slug, groups } }
    },
  }),
  tool({
    name: 'list_tags',
    scope: 'read',
    title: 'List tags',
    description: 'Tags with how many transactions use each.',
    input: z.object({ ledger }),
    output: z.object({ ledger: z.string(), tags: z.array(z.object({ id: z.number(), name: z.string(), count: z.number() })) }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const tags = (await ctx.api.get<TagWithCount[]>(`/ledgers/${l.slug}/tags`)).map((t) => ({ id: t.id, name: t.name, count: t.count }))
      return { text: tags.length ? tags.map((t) => `#${t.name} (${t.count})`).join(', ') : 'No tags yet.', data: { ledger: l.slug, tags } }
    },
  }),
  tool({
    name: 'create_category',
    scope: 'write',
    title: 'Create a category',
    description:
      'Adds a category, in a group (created if it doesn’t exist yet). If the ledger uses the shared category list, it’s added there, so every ledger that shares gets it.',
    input: z.object({
      ledger,
      name: z.string().min(1).max(40),
      group: z.string().min(1).max(40).optional(),
      isIncome: z.boolean().default(false),
      labels: z.array(z.string().min(1).max(40)).optional().describe('Labels to put on it (created if new), such as "Need".'),
    }),
    output: z.object({ ledger: z.string(), category: categoryView }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      let groupId: number | null = null
      if (args.group) {
        const existing = lk.groups.find((g) => g.name.toLowerCase() === args.group!.trim().toLowerCase())
        const group = existing ?? (await ctx.api.post<CategoryGroup>(`${lk.categoryBase(l)}/category-groups`, { name: args.group }))
        if (!existing) lk.groups.push(group)
        groupId = group.id
      }
      const c = await ctx.api.post<Category>(`${lk.categoryBase(l)}/categories`, {
        name: args.name,
        groupId,
        isIncome: args.isIncome,
        labelIds: args.labels ? await labelIds(ctx, l, lk, args.labels) : undefined,
      })
      const where = lk.shared ? ' in the shared list (every ledger that shares has it)' : ''
      return { text: `Created the category #${c.id} ${c.name}${args.group ? ` in ${args.group}` : ''}${where}.`, data: { ledger: l.slug, category: viewCategory(c, lk) } }
    },
  }),
  tool({
    name: 'update_category',
    scope: 'write',
    title: 'Update a category',
    description:
      'Rename, move to another group (its colour comes from the group), set its labels, or archive it (hide it from pickers). If the ledger uses the shared category list, renames, groups and labels change it for every ledger that shares, and archiving turns it off in this ledger only; turning off one its transactions use needs `moveTo` (another category for them, or null to leave them uncategorized). With its own list, its transactions keep an archived category.',
    input: z.object({
      ledger,
      category: nameOrId,
      name: z.string().min(1).max(40).optional(),
      group: z.string().nullable().optional().describe('Group name; null to remove it from its group.'),
      isIncome: z.boolean().optional(),
      labels: z.array(z.string().min(1).max(40)).optional().describe('Its labels, replacing the ones it has (new ones are created). [] removes them all.'),
      archived: z.boolean().optional(),
      moveTo: nameOrId.nullable().optional().describe('Shared list, turning a category off: where its transactions go (null: uncategorized).'),
    }),
    output: z.object({ ledger: z.string(), category: categoryView }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const id = lk.category(args.category)
      if (id === null) throw new ToolError('Name the category to update.')
      const changes = {
        name: args.name,
        groupId: args.group === undefined ? undefined : args.group === null ? null : lk.group(args.group).id,
        isIncome: args.isIncome,
        labelIds: args.labels ? await labelIds(ctx, l, lk, args.labels) : undefined,
      }
      let c: Category
      if (lk.shared) {
        // The category itself is shared; whether it's on is this ledger's.
        if (Object.values(changes).some((v) => v !== undefined)) c = await ctx.api.patch<Category>(`/categories/${id}`, changes)
        if (args.archived !== undefined) {
          const moveTo = args.moveTo === undefined ? undefined : args.moveTo === null ? null : lk.category(args.moveTo)
          c = await ctx.api.patch<Category>(`/ledgers/${l.slug}/categories/${id}`, { enabled: !args.archived, moveTo })
        }
        c ??= lk.categories.find((x) => x.id === id)!
      } else {
        c = await ctx.api.patch<Category>(`/ledgers/${l.slug}/categories/${id}`, { ...changes, archived: args.archived })
      }
      return { text: `Updated the category #${c.id} ${c.name}.`, data: { ledger: l.slug, category: viewCategory(c, lk) } }
    },
  }),
  tool({
    name: 'merge_category',
    scope: 'write',
    title: 'Merge a category into another',
    description:
      'Moves every transaction, recurring payment and learned payee from one category to another, then deletes the first. The other category keeps its name, group and labels. If the ledger uses the shared category list, this happens in every ledger that shares. Ask the user before doing this.',
    input: z.object({ ledger, category: nameOrId.describe('The category that goes away.'), into: nameOrId.describe('The category that takes over.') }),
    output: z.object({ ledger: z.string(), into: categoryView, transactions: z.number(), recurring: z.number() }),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const from = lk.category(args.category)
      const into = lk.category(args.into)
      if (from === null || into === null) throw new ToolError('Name both categories.')
      const r = await ctx.api.post<CategoryMergeResult>(`${lk.categoryBase(l)}/categories/${from}/merge`, { into })
      return {
        text: `Merged ${lk.categoryName(from)} into ${r.into.name}: ${r.transactions} transaction${r.transactions === 1 ? '' : 's'}${r.recurring ? ` and ${r.recurring} recurring payment${r.recurring === 1 ? '' : 's'}` : ''} moved.`,
        data: { ledger: l.slug, into: viewCategory(r.into, lk), transactions: r.transactions, recurring: r.recurring },
      }
    },
  }),
  tool({
    name: 'label_categories',
    scope: 'write',
    title: 'Label categories',
    description:
      'Puts a label (such as "Need" or "Want") on several categories at once, or takes it off. The label is created if it doesn’t exist yet. Other labels on those categories stay.',
    input: z.object({
      ledger,
      label: z.string().min(1).max(40),
      add: z.array(nameOrId).default([]).describe('Categories to put the label on.'),
      remove: z.array(nameOrId).default([]).describe('Categories to take it off.'),
    }),
    output: z.object({ ledger: z.string(), label: z.string(), categoryCount: z.number() }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const ids = (refs: Array<string | number>) =>
        refs.map((ref) => {
          const id = lk.category(ref)
          if (id === null) throw new ToolError('Name the categories to label.')
          return id
        })
      const add = ids(args.add)
      const remove = ids(args.remove)
      const [labelId] = await labelIds(ctx, l, lk, [args.label])
      const label = await ctx.api.post<Label>(`${lk.categoryBase(l)}/labels/${labelId}/categories`, { add, remove })
      const parts = [add.length && `put it on ${add.length}`, remove.length && `took it off ${remove.length}`].filter(Boolean)
      return {
        text: `Label ${label.name}: ${parts.join(', ') || 'no changes'}. It’s on ${label.categoryCount} categor${label.categoryCount === 1 ? 'y' : 'ies'} now.`,
        data: { ledger: l.slug, label: label.name, categoryCount: label.categoryCount },
      }
    },
  }),
  tool({
    name: 'rename_tag',
    scope: 'write',
    title: 'Rename a tag',
    description: 'Renames a tag on every transaction that has it.',
    input: z.object({ ledger, tag: z.string().min(1), newName: z.string().min(1).max(40) }),
    output: z.object({ ledger: z.string(), tag: z.object({ id: z.number(), name: z.string() }) }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const id = await ctx.tagId(l, args.tag)
      const t = await ctx.api.patch<Tag>(`/ledgers/${l.slug}/tags/${id}`, { name: args.newName })
      return { text: `Renamed #${args.tag.replace(/^#/, '')} to #${t.name}.`, data: { ledger: l.slug, tag: { id: t.id, name: t.name } } }
    },
  }),

  // Recurring -------------------------------------------------------------------
  tool({
    name: 'list_recurring',
    scope: 'read',
    title: 'List recurring payments',
    description:
      'Bills, subscriptions, instalment plans and regular income. `suggested` ones were detected from history and wait to be confirmed or dismissed; `ended` ones include paid-off plans. Alerts flag missing payments and price changes.',
    input: z.object({ ledger, status: z.enum(RECURRING_STATUSES).optional() }),
    output: z.object({
      ledger: z.string(),
      items: z.array(
        z.object({
          id: z.number(),
          name: z.string().nullable().describe('What it is, like "Dyson vacuum"; null when it has none.'),
          payee: z.string(),
          status: z.string(),
          amount: z.string(),
          amountMinor: z.number(),
          cadence: z.string(),
          nextDueDate: z.string(),
          monthlyCost: z.string(),
          category: z.string().nullable(),
          account: z.string().nullable(),
          lastSeenDate: z.string().nullable(),
          alerts: z.array(z.string()),
          instalments: z
            .object({
              paid: z.number(),
              total: z.number(),
              left: z.string(),
              endDate: z.string().nullable(),
              fullPrice: z.string().nullable().describe('The total of its payments, when it was given.'),
              lastPayment: z.string().nullable().describe('Its last payment, what’s left of the full price, when that’s known.'),
            })
            .nullable()
            .describe('An instalment plan: payments made of its total, what’s left to pay, when the last one is due, and its full price and last payment.'),
        }),
      ),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const [list, lk] = await Promise.all([ctx.api.get<RecurringItem[]>(`/ledgers/${l.slug}/recurring`, { status: args.status }), ctx.lookups(l)])
      const items = list.map((r) => ({
        id: r.id,
        name: r.name,
        payee: r.payee,
        status: r.status,
        amount: money(r.expectedAmountMinor),
        amountMinor: r.expectedAmountMinor,
        cadence: r.cadence,
        nextDueDate: r.nextDueDate,
        monthlyCost: money(r.monthlyCostMinor),
        category: lk.categoryName(r.categoryId),
        account: r.accountId === null ? null : lk.accountName(r.accountId),
        lastSeenDate: r.lastSeenDate,
        alerts: r.alerts,
        otherPayees: r.otherPayees,
        possiblePayment: r.possiblePayment && {
          transactionId: r.possiblePayment.transactionId,
          payee: r.possiblePayment.payee,
          amount: money(r.possiblePayment.amountMinor),
          date: r.possiblePayment.date,
          newAmount: r.possiblePayment.newAmount,
          role: r.possiblePayment.role,
          dueDate: r.possiblePayment.dueDate,
        },
        instalments:
          r.totalPayments === null
            ? null
            : {
                paid: r.paidPayments,
                total: r.totalPayments,
                left: money(r.remainingAmountMinor ?? 0),
                endDate: r.endDate,
                fullPrice: money(r.fullPriceMinor ?? r.totalAmountMinor ?? 0),
                lastPayment: r.lastPaymentMinor === null ? null : money(r.lastPaymentMinor),
              },
      }))
      const plan = (p: (typeof items)[number]['instalments']) =>
        p ? ` · ${p.paid} of ${p.total} paid, ${p.left} left of ${p.fullPrice}${p.lastPayment ? `, last payment ${p.lastPayment}` : ''}, ends ${p.endDate}` : ''
      const text = items.length
        ? items
            .map(
              (r) =>
                `#${r.id} ${r.payee}${r.otherPayees.length ? ` (also ${r.otherPayees.join(', ')})` : ''}${r.name ? ` (${r.name})` : ''} ${r.amount} ${r.cadence}, next ${r.nextDueDate} · ${r.status}${plan(r.instalments)}${r.alerts.length ? ` · ${r.alerts.join(', ')}` : ''}${r.possiblePayment ? ` · possible payment from ${r.possiblePayment.payee}: ${r.possiblePayment.amount} on ${r.possiblePayment.date} for ${r.possiblePayment.dueDate}${r.possiblePayment.role ? `, its ${r.possiblePayment.role} payment` : r.possiblePayment.newAmount ? ', a new amount' : ''} (to confirm in the app)` : ''}`,
            )
            .join('\n')
        : 'No recurring payments.'
      return { text, data: { ledger: l.slug, items } }
    },
  }),
  tool({
    name: 'upcoming_payments',
    scope: 'read',
    title: 'List upcoming payments',
    description: 'Expected payments from confirmed recurring items in the next days, including overdue ones.',
    input: z.object({ ledger, days: z.number().int().min(1).max(366).default(30) }),
    output: z.object({
      ledger: z.string(),
      total: moneyOut,
      payments: z.array(z.object({ name: z.string().nullable(), payee: z.string(), dueDate: z.string(), amount: z.string(), amountMinor: z.number(), overdue: z.boolean(), category: z.string().nullable() })),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const [list, lk] = await Promise.all([ctx.api.get<UpcomingPayment[]>(`/ledgers/${l.slug}/recurring/upcoming`, { days: args.days }), ctx.lookups(l)])
      const payments = list.map((p) => ({
        name: p.name,
        payee: p.payee,
        dueDate: p.dueDate,
        amount: money(p.amountMinor),
        amountMinor: p.amountMinor,
        overdue: p.overdue,
        category: lk.categoryName(p.categoryId),
      }))
      const total = payments.reduce((s, p) => s + p.amountMinor, 0)
      const text = payments.length
        ? [`${plural(payments.length, 'payment')} in the next ${args.days} days, ${money(total)} in all:`, ...payments.map((p) => `${p.dueDate} ${p.payee}${p.name ? ` (${p.name})` : ''} ${p.amount}${p.overdue ? ' (overdue)' : ''}`)].join('\n')
        : `Nothing due in the next ${args.days} days.`
      return { text, data: { ledger: l.slug, total: amountPair(total), payments } }
    },
  }),
  tool({
    name: 'confirm_recurring',
    scope: 'write',
    title: 'Confirm a recurring payment',
    description: 'Turns a suggested recurring payment into an active one, so it shows in upcoming payments and gets alerts.',
    input: z.object({ ledger, id: z.number().int() }),
    output: z.object({ ledger: z.string(), id: z.number(), payee: z.string(), name: z.string().nullable(), status: z.string() }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const r = await ctx.api.post<RecurringItem>(`/ledgers/${l.slug}/recurring/${args.id}/confirm`)
      return { text: `Confirmed ${described(r)}; next due ${r.nextDueDate}.`, data: { ledger: l.slug, id: r.id, payee: r.payee, name: r.name, status: r.status } }
    },
  }),
  tool({
    name: 'dismiss_recurring',
    scope: 'write',
    title: 'Dismiss a recurring payment',
    description: 'Dismisses a suggestion (or stops tracking an item). It won’t be suggested again.',
    input: z.object({ ledger, id: z.number().int() }),
    output: z.object({ ledger: z.string(), id: z.number(), payee: z.string(), name: z.string().nullable(), status: z.string() }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const r = await ctx.api.post<RecurringItem>(`/ledgers/${l.slug}/recurring/${args.id}/dismiss`)
      return { text: `Dismissed ${described(r)}.`, data: { ledger: l.slug, id: r.id, payee: r.payee, name: r.name, status: r.status } }
    },
  }),
  tool({
    name: 'recurring_payment_candidates',
    scope: 'read',
    title: 'Find payments to add to a recurring payment',
    description:
      'Transactions you could add to a recurring item with add_recurring_payment, like an instalment plan’s down payment or its last payment (the remainder), which the app doesn’t link because their amount differs. Not linked to an item and not transfers, the same way as the item (money out or in), from its account if it has one, at any amount. Without `search`: from around its dates. Its payees’ and ones like them come first (`likely`).',
    input: z.object({
      ledger,
      id: z.number().int().describe('The recurring item’s id, from list_recurring.'),
      search: z.string().max(100).optional().describe('Words to find (payee, name, notes or amount), at any date.'),
    }),
    output: z.object({ ledger: z.string(), candidates: z.array(z.object({ transaction: transactionView, likely: z.boolean() })) }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const [list, lk] = await Promise.all([
        ctx.api.get<RecurringPaymentCandidate[]>(`/ledgers/${l.slug}/recurring/${args.id}/payment-candidates`, { q: args.search || undefined }),
        ctx.lookups(l),
      ])
      const candidates = list.map((c) => ({ transaction: viewTransaction(c.transaction, lk), likely: c.likely }))
      const text = candidates.length
        ? [`${plural(candidates.length, 'payment')} you could add:`, ...candidates.map((c) => `${transactionLine(c.transaction)}${c.likely ? ' (its payee)' : ''}`)].join('\n')
        : args.search
          ? 'No payment you could add matches.'
          : 'No payment around its dates to add. Search for one.'
      return { text, data: { ledger: l.slug, candidates } }
    },
  }),
  tool({
    name: 'add_recurring_payment',
    scope: 'write',
    title: 'Add a payment to a recurring payment',
    description:
      'Adds a transaction to a recurring item at its own amount: an instalment plan’s down payment, a first payment that covers part of a period, its last one (the remainder), or one the app didn’t link. It’s counted and takes the item’s category, but the item’s usual amount stays (it’s no price change). Find one with recurring_payment_candidates. The item must be active or ended, the payment from its account, and a plan takes no more payments than it has. Ask the user before adding one they didn’t name.',
    input: z.object({ ledger, id: z.number().int().describe('The recurring item’s id.'), transactionId: z.number().int() }),
    output: z.object({
      ledger: z.string(),
      id: z.number(),
      payee: z.string(),
      name: z.string().nullable(),
      status: z.string(),
      amount: z.string(),
      instalments: z.object({ paid: z.number(), total: z.number(), left: z.string(), endDate: z.string().nullable() }).nullable(),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const r = await ctx.api.post<RecurringItem>(`/ledgers/${l.slug}/recurring/${args.id}/add-payment`, { transactionId: args.transactionId })
      const instalments = r.totalPayments === null ? null : { paid: r.paidPayments, total: r.totalPayments, left: money(r.remainingAmountMinor ?? 0), endDate: r.endDate }
      const plan = instalments ? `: ${instalments.paid} of ${instalments.total} paid${r.status === 'ended' ? ', paid off' : `, ${instalments.left} left`}` : ''
      return {
        text: `Added transaction #${args.transactionId} to ${described(r)}${plan}. Its usual amount stays ${money(r.expectedAmountMinor)}.`,
        data: { ledger: l.slug, id: r.id, payee: r.payee, name: r.name, status: r.status, amount: money(r.expectedAmountMinor), instalments },
      }
    },
  }),
  tool({
    name: 'create_recurring',
    scope: 'write',
    title: 'Create a recurring payment',
    description:
      'Adds a bill, subscription, instalment plan or regular income by hand. Matching transactions are linked to it as they arrive; an instalment plan (`payments`) ends after its last one.',
    input: z.object({
      ledger,
      payee: z.string().min(1).max(200).describe('The payee as it appears on statements, like "Klarna"; payments are matched by it.'),
      name: z.string().min(1).max(120).optional().describe('What it is, like "Dyson vacuum", shown in place of the payee.'),
      amount: amount.describe('Expected amount in dollars; negative for bills.'),
      cadence: z.enum(CADENCE_VALUES),
      nextDate: date.describe('The next (or a recent) date it happens; later dates follow the cadence.'),
      category: categoryRef.optional(),
      account: nameOrId.optional(),
      secondDay: z.number().int().min(1).max(31).optional().describe('Semi-monthly: the other day of the month (31 for the last day); nextDate gives the first.'),
      payments: z.number().int().min(2).max(600).optional().describe('An instalment plan: how many payments it has in all, like 4 for Pay in 4.'),
      paidSoFar: z.number().int().min(0).max(600).optional().describe('An instalment plan: how many are paid already, including ones from before the ledger’s history.'),
      fullPrice: z
        .number()
        .optional()
        .describe('An instalment plan: the total of all its payments in dollars, as the lender shows it, interest included. Its last payment is what’s left of it. Negative like its amount.'),
    }),
    output: z.object({ ledger: z.string(), id: z.number(), payee: z.string(), name: z.string().nullable(), nextDueDate: z.string() }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const r = await ctx.api.post<RecurringItem>(`/ledgers/${l.slug}/recurring`, {
        payee: args.payee,
        name: args.name ?? null,
        expectedAmountMinor: toMinor(args.amount),
        cadence: args.cadence,
        anchorDate: args.nextDate,
        categoryId: args.category === undefined ? null : lk.category(args.category),
        accountId: args.account === undefined ? null : lk.account(args.account).id,
        ...(args.payments ? { totalPayments: args.payments, paidPayments: args.paidSoFar, ...(args.fullPrice !== undefined ? { fullPriceMinor: toMinor(args.fullPrice) } : {}) } : {}),
        ...(args.secondDay ? { secondDay: args.secondDay } : {}),
      })
      const plan = r.totalPayments ? `, ${r.paidPayments} of ${r.totalPayments} paid` : ''
      return {
        text: `Created ${described(r)}, ${money(r.expectedAmountMinor)} ${r.cadence}${plan}; next due ${r.nextDueDate}.`,
        data: { ledger: l.slug, id: r.id, payee: r.payee, name: r.name, nextDueDate: r.nextDueDate },
      }
    },
  }),

  // Reports ---------------------------------------------------------------------
  tool({
    name: 'spending_by_category',
    scope: 'read',
    title: 'Spending by category',
    description: 'Totals by category for a date range (default: this month so far). Use kind "income" for income. With `report` or conditions, only what they count.',
    input: z.object({ ledger, from: date.optional(), to: date.optional(), kind: z.enum(['expense', 'income']).default('expense'), ...filterArgs }),
    output: z.object({
      ledger: z.string(),
      from: z.string(),
      to: z.string(),
      total: moneyOut,
      categories: z.array(z.object({ category: z.string(), group: z.string().nullable(), amount: moneyOut, count: z.number(), share: z.number() })),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const range = await monthRange(ctx, args.from, args.to)
      const { filter } = await filterFrom(ctx, l, await ctx.lookups(l), args)
      const rows = await ctx.api.get<CategoryAmount[]>(`/ledgers/${l.slug}/reports/by-category`, { ...range, kind: args.kind, filter: filterToParam(filter) })
      const total = rows.reduce((s, r) => s + r.amountMinor, 0)
      const categories = rows.map((r) => ({
        category: r.name,
        group: r.groupName,
        amount: amountPair(r.amountMinor),
        count: r.count,
        share: total ? Math.round((r.amountMinor / total) * 1000) / 1000 : 0,
      }))
      const text = [
        `${args.kind === 'income' ? 'Income' : 'Spending'} in ${l.name}, ${range.from} to ${range.to}: ${money(total)}`,
        ...categories.map((c) => `- ${c.category}: ${c.amount.formatted} (${Math.round(c.share * 100)}%)`),
      ].join('\n')
      return { text, data: { ledger: l.slug, ...range, total: amountPair(total), categories } }
    },
  }),
  tool({
    name: 'spending_trend',
    scope: 'read',
    title: 'Spending trend',
    description: 'Monthly spending and income for the past months, with the biggest categories (or groups) each month. With `report` or conditions, only what they count.',
    input: z.object({
      ledger,
      months: z.number().int().min(1).max(36).default(6),
      end: month.optional().describe('Last month to include (YYYY-MM). Default: this month.'),
      groupBy: z.enum(['category', 'group']).default('category'),
      ...filterArgs,
    }),
    output: z.object({
      ledger: z.string(),
      months: z.array(z.object({ month: z.string(), spent: moneyOut, income: moneyOut, net: moneyOut, top: z.array(z.object({ name: z.string(), amount: moneyOut })) })),
      series: z.array(z.object({ name: z.string(), total: moneyOut })),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const { filter } = await filterFrom(ctx, l, await ctx.lookups(l), args)
      const r = await ctx.api.get<TrendReport>(`/ledgers/${l.slug}/reports/trend`, { months: args.months, end: args.end, groupBy: args.groupBy, filter: filterToParam(filter) })
      const names = new Map(r.series.map((s) => [s.key, s.name]))
      const months = r.points.map((p) => ({
        month: p.month,
        spent: amountPair(p.spentMinor),
        income: amountPair(p.incomeMinor),
        net: amountPair(p.netMinor),
        top: Object.entries(p.byKey)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([key, v]) => ({ name: names.get(key) ?? key, amount: amountPair(v) })),
      }))
      const text = months.map((m) => `${m.month}: spent ${m.spent.formatted}, income ${m.income.formatted} · ${m.top.map((t) => `${t.name} ${t.amount.formatted}`).join(', ')}`).join('\n')
      return { text, data: { ledger: l.slug, months, series: r.series.map((s) => ({ name: s.name, total: amountPair(s.totalMinor) })) } }
    },
  }),
  tool({
    name: 'top_payees',
    scope: 'read',
    title: 'Top payees',
    description: 'Where the money went: payees by total spending for a date range (default: this month so far), each purchase less its refunds and paybacks. With `report` or conditions, only what they count.',
    input: z.object({ ledger, from: date.optional(), to: date.optional(), limit: z.number().int().min(1).max(100).default(15), ...filterArgs }),
    output: z.object({
      ledger: z.string(),
      from: z.string(),
      to: z.string(),
      payees: z.array(z.object({ payee: z.string(), amount: moneyOut, count: z.number(), category: z.string().nullable() })),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const range = await monthRange(ctx, args.from, args.to)
      const lk = await ctx.lookups(l)
      const { filter } = await filterFrom(ctx, l, lk, args)
      const rows = await ctx.api.get<PayeeTotal[]>(`/ledgers/${l.slug}/reports/payees`, { ...range, limit: args.limit, filter: filterToParam(filter) })
      const payees = rows.map((p) => ({ payee: p.payee, amount: amountPair(p.amountMinor), count: p.count, category: lk.categoryName(p.categoryId) }))
      const text = [`Top payees in ${l.name}, ${range.from} to ${range.to}:`, ...payees.map((p) => `- ${p.payee}: ${p.amount.formatted} (${plural(p.count, 'transaction')})`)].join('\n')
      return { text, data: { ledger: l.slug, ...range, payees } }
    },
  }),
  tool({
    name: 'income_vs_spending',
    scope: 'read',
    title: 'Income vs spending',
    description: 'Income, spending, net and savings rate per month for the past months. With `report` or conditions, only what they count.',
    input: z.object({ ledger, months: z.number().int().min(1).max(36).default(12), end: month.optional(), ...filterArgs }),
    output: z.object({
      ledger: z.string(),
      months: z.array(z.object({ month: z.string(), income: moneyOut, spent: moneyOut, net: moneyOut, savingsRate: z.number().nullable() })),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const param = filterToParam((await filterFrom(ctx, l, await ctx.lookups(l), args)).filter)
      // Filtered, the trend has the same totals a month at a time.
      const rows: MonthTotals[] = param
        ? (await ctx.api.get<TrendReport>(`/ledgers/${l.slug}/reports/trend`, { months: args.months, end: args.end, filter: param })).points
        : await ctx.api.get<MonthTotals[]>(`/ledgers/${l.slug}/reports/income-vs-expense`, { months: args.months, end: args.end })
      const months = rows.map((m) => ({
        month: m.month,
        income: amountPair(m.incomeMinor),
        spent: amountPair(m.spentMinor),
        net: amountPair(m.netMinor),
        savingsRate: m.incomeMinor > 0 ? Math.round((m.netMinor / m.incomeMinor) * 1000) / 1000 : null,
      }))
      const text = months.map((m) => `${m.month}: income ${m.income.formatted}, spent ${m.spent.formatted}, net ${m.net.formatted}${m.savingsRate !== null ? ` (${Math.round(m.savingsRate * 100)}%)` : ''}`).join('\n')
      return { text, data: { ledger: l.slug, months } }
    },
  }),

  tool({
    name: 'list_custom_reports',
    scope: 'read',
    title: 'List custom reports',
    description: 'Reports you saved in the app: each one’s filter in words, its range and comparison, and anything it refers to that’s gone. Pass a name to get_report to run one.',
    input: z.object({ ledger }),
    output: z.object({
      ledger: z.string(),
      reports: z.array(
        z.object({ id: z.number(), name: z.string(), filter: z.string(), range: z.string(), compare: z.string(), warnings: z.array(z.string()) }),
      ),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const [rows, today] = await Promise.all([ctx.api.get<CustomReport[]>(`/ledgers/${l.slug}/custom-reports`), ctx.today()])
      const reports = rows.map((r) => ({
        id: r.id,
        name: r.name,
        filter: r.description,
        range: r.spec.range ? resolveRange(r.spec.range as ReportRange, today).label : 'Any range',
        compare: r.spec.compare,
        warnings: missingWarnings(r),
      }))
      const text = reports.length
        ? [`Custom reports in ${l.name}:`, ...reports.map((r) => `- ${r.name}: ${r.filter} · ${r.range}${r.warnings.length ? ` (${r.warnings.join(' ')})` : ''}`)].join('\n')
        : `There are no custom reports in ${l.name} yet. get_report takes a filter of its own too.`
      return { text, data: { ledger: l.slug, reports } }
    },
  }),
  tool({
    name: 'get_report',
    scope: 'read',
    title: 'Get a report',
    description:
      'Spending and income for a range, filtered: a custom report by name (list_custom_reports), and/or your own Only count and Filter out conditions, added to its filter. Spending and income are filtered apart. Refunds and paybacks go with the purchase they’re linked to, and amounts are your share after them. Gives spending, the average of complete months, income, saved, the change against a comparison period by category group, and the biggest purchases filtered out. For example, regular spending: filterOut [{ tags: ["one-off"] }, { atLeast: 1000, recurring: "none" }].',
    input: z.object({
      ledger,
      ...filterArgs,
      range: z.string().optional().describe('3m, 6m, 12m or 24m (ending this month), ytd, last-year, or months like 2025-11..2026-10. Default: the report’s, or 12m.'),
      compare: z.enum(REPORT_COMPARE).optional().describe('previous: the months just before. last-year: the same months a year before. Default: the report’s, or previous.'),
    }),
    output: z.object({
      ledger: z.string(),
      report: z.string().nullable(),
      filter: z.string(),
      from: z.string(),
      to: z.string(),
      range: z.string(),
      spent: moneyOut,
      perMonth: moneyOut.nullable().describe('The average of complete months (not the one in progress).'),
      income: moneyOut,
      saved: moneyOut,
      savingsRate: z.number().nullable(),
      comparison: z.object({ from: z.string(), to: z.string(), range: z.string(), spent: moneyOut, change: z.number().nullable() }).nullable(),
      groups: z.array(z.object({ group: z.string(), spent: moneyOut, previous: moneyOut.nullable(), change: z.number().nullable() })),
      filteredOut: z
        .object({ spent: moneyOut, count: z.number(), biggest: z.array(z.object({ transaction: transactionView, inRange: moneyOut, why: z.array(z.string()) })) })
        .nullable(),
      warnings: z.array(z.string()),
    }),
    annotations: READ,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const base = `/ledgers/${l.slug}`
      const [lk, today] = await Promise.all([ctx.lookups(l), ctx.today()])
      if (args.range !== undefined && !isReportRange(args.range)) throw new ToolError(RANGE_HELP(args.range))
      const { saved, filter } = await filterFrom(ctx, l, lk, args)

      const spec: ReportSpec = { ...(saved?.spec ?? EVERYTHING), filter, range: (args.range as ReportSpec['range']) ?? saved?.spec.range ?? null, compare: args.compare ?? saved?.spec.compare ?? 'previous' }
      const range = resolveRange(rangeOf(spec), today)
      const cmp = spec.compare === 'none' ? null : comparisonRange(range, spec.compare, today)
      const param = filterToParam(filter)
      const [cur, prev, trend, span, out, names] = await Promise.all([
        ctx.api.get<PeriodSummary>(`${base}/reports/period`, { from: range.from, to: range.to, filter: param }),
        cmp ? ctx.api.get<PeriodSummary>(`${base}/reports/period`, { from: cmp.from, to: cmp.to, filter: param }) : null,
        ctx.api.get<TrendReport>(`${base}/reports/trend`, { end: range.end, months: range.months.length, filter: param }),
        ctx.api.get<TransactionSpan>(`${base}/transactions/span`),
        filter.spending ? ctx.api.get<ReportPurchases>(`${base}/reports/purchases`, { from: range.from, to: range.to, set: 'filtered-out', limit: 10, filter: param }) : null,
        filterNames(ctx, l, lk, [filter]),
      ])

      const perMonth = completeMonthAverage(
        trend.points.map((p) => ({ month: p.month, value: p.spentMinor })),
        { currentMonth: monthOf(today), firstMonth: span.first ? monthOf(span.first) : null },
      )
      const change = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 1000 : null)
      const groups = prev
        ? comparePeriods(cur, prev).map((g) => ({ group: g.name, spent: amountPair(g.currentMinor), previous: amountPair(g.previousMinor), change: g.changePct }))
        : cur.expenses.map((g) => ({ group: g.name, spent: amountPair(g.amountMinor), previous: null, change: null }))
      const rules = filter.spending?.filterOut ?? []
      const filteredOut = out && {
        spent: amountPair(out.totalMinor),
        count: out.count,
        biggest: out.items.map((i) => ({
          transaction: viewTransaction(i.transaction, lk),
          inRange: amountPair(i.inRangeMinor),
          why: [...i.rules.map((r) => describeRule(rules[r]!, 'spending', names)), ...(i.picked ? ['Picked'] : [])],
        })),
      }
      const comparison = cmp && prev ? { from: cmp.from, to: cmp.to, range: cmp.label, spent: amountPair(prev.spentMinor), change: change(cur.spentMinor, prev.spentMinor) } : null
      const words = describeFilter(filter, names)
      const warnings = saved ? missingWarnings(saved) : []

      const title = `${saved?.name ?? (words === 'Everything' ? 'Everything' : 'Filtered')}, ${range.label} (${range.from} to ${range.to})`
      const text = [
        `${title}: spent ${money(cur.spentMinor)}${perMonth !== null ? `, ${money(perMonth)} a month` : ''}${comparison?.change != null ? `, ${pct(comparison.change)} than ${comparison.range}` : ''}. Income ${money(cur.incomeMinor)}, saved ${money(cur.netMinor)}.`,
        `Filter: ${words}`,
        ...(filteredOut ? [`Filtered out ${filteredOut.spent.formatted} in ${plural(filteredOut.count, 'purchase')}${filteredOut.biggest.length ? `, the biggest:` : '.'}`, ...filteredOut.biggest.map((b) => `- ${transactionLine(b.transaction)} (${b.why.join(', ')})`)] : []),
        ...(groups.length ? ['By group:', ...groups.map((g) => `- ${g.group}: ${g.spent.formatted}${g.previous ? ` (was ${g.previous.formatted}${g.change !== null ? `, ${pct(g.change)}` : ''})` : ''}`)] : []),
        ...warnings.map((w) => `Note: ${w}`),
      ].join('\n')
      return {
        text,
        data: {
          ledger: l.slug,
          report: saved?.name ?? null,
          filter: words,
          from: range.from,
          to: range.to,
          range: range.label,
          spent: amountPair(cur.spentMinor),
          perMonth: perMonth === null ? null : amountPair(perMonth),
          income: amountPair(cur.incomeMinor),
          saved: amountPair(cur.netMinor),
          savingsRate: cur.incomeMinor > 0 ? Math.round((cur.netMinor / cur.incomeMinor) * 1000) / 1000 : null,
          comparison,
          groups,
          filteredOut,
          warnings,
        },
      }
    },
  }),

  tool({
    name: 'save_custom_report',
    scope: 'write',
    title: 'Save a custom report',
    description:
      'Saves a filter as a custom report the app shows under Reports (and get_report runs). A new name makes a new report, from another report’s filter (`report`) with the conditions given added. An existing name needs `replace: true`: the conditions given then take the place of that side’s Only count and Filter out (picked and put back transactions stay), and range, compare and groupBy change when given.',
    input: z.object({
      ledger,
      name: z.string().trim().min(1).max(60),
      ...filterArgs,
      replace: z.boolean().default(false).describe('Change the report with this name.'),
      range: z.string().optional().describe('3m, 6m, 12m or 24m (moving with today), ytd, last-year, or fixed months like 2025-11..2026-10. Default: none, so it opens with any range.'),
      compare: z.enum(REPORT_COMPARE).optional(),
      groupBy: z.enum(['category', 'group']).optional(),
    }),
    output: z.object({ ledger: z.string(), id: z.number(), name: z.string(), filter: z.string(), created: z.boolean() }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      if (args.range !== undefined && !isReportRange(args.range)) throw new ToolError(RANGE_HELP(args.range))
      const reports = await ctx.api.get<CustomReport[]>(`/ledgers/${l.slug}/custom-reports`)
      const existing = reports.find((r) => r.name.toLowerCase() === args.name.toLowerCase())
      if (existing && !args.replace) throw new ToolError(`There's already a report called “${existing.name}”. Pass replace: true to change it, or choose another name.`)
      const changes = { ...(args.range !== undefined && { range: args.range }), ...(args.compare && { compare: args.compare }), ...(args.groupBy && { groupBy: args.groupBy }) }
      let saved: CustomReport
      if (existing) {
        let filter = existing.spec.filter
        for (const side of FILTER_SIDES) {
          const given = args[side]
          if (!given) continue
          const { only, rules } = await sideOfArgs(ctx, l, lk, given)
          filter = withSide(filter, side, (s) => ({ ...s, only, filterOut: rules.map((when) => ({ when })) }))
        }
        saved = await ctx.api.patch<CustomReport>(`/ledgers/${l.slug}/custom-reports/${existing.id}`, { spec: { ...existing.spec, filter: checked(filter), ...changes } })
      } else {
        const { filter } = await filterFrom(ctx, l, lk, args)
        saved = await ctx.api.post<CustomReport>(`/ledgers/${l.slug}/custom-reports`, { name: args.name, spec: { filter, range: null, ...changes } })
      }
      return {
        text: `${existing ? 'Changed' : 'Saved'} the custom report ${saved.name}: ${saved.description}.`,
        data: { ledger: l.slug, id: saved.id, name: saved.name, filter: saved.description, created: !existing },
      }
    },
  }),
  tool({
    name: 'delete_custom_report',
    scope: 'write',
    title: 'Delete a custom report',
    description: 'Deletes a saved report. Transactions don’t change.',
    input: z.object({ ledger, report: nameOrId.describe('Its name or id.') }),
    output: z.object({ ledger: z.string(), id: z.number(), name: z.string() }),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const r = await customReport(ctx, l, args.report)
      await ctx.api.del(`/ledgers/${l.slug}/custom-reports/${r.id}`)
      return { text: `Deleted the custom report ${r.name}. Its transactions don’t change.`, data: { ledger: l.slug, id: r.id, name: r.name } }
    },
  }),

  // Import ----------------------------------------------------------------------
  tool({
    name: 'import_transactions',
    scope: 'write',
    title: 'Import transactions',
    description:
      'Imports rows from a bank statement into one account. First call it without `confirm` to see which rows are new, which look like duplicates, and the category each would get. Then call again with `confirm: true` to import the new ones as one batch (which can be undone in the app).',
    input: z.object({
      ledger,
      account: nameOrId,
      rows: z
        .array(
          z.object({
            date,
            payee: z.string().min(1).max(200),
            amount,
            notes: z.string().max(1000).optional(),
            externalId: z.string().min(1).max(200).optional().describe('The bank’s id for the row, if it has one. Rows already imported are skipped.'),
          }),
        )
        .min(1)
        .max(2000),
      fileName: z.string().max(200).optional(),
      confirm: z.boolean().default(false),
    }),
    output: z.object({
      ledger: z.string(),
      committed: z.boolean(),
      newRows: z.number(),
      duplicates: z.number(),
      categorized: z.number(),
      needsReview: z.number().optional(),
      preview: z
        .array(z.object({ date: z.string(), payee: z.string(), amount: z.string(), duplicateOf: z.number().nullable(), category: z.string().nullable() }))
        .optional(),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const l = await ctx.ledger(args.ledger)
      const lk = await ctx.lookups(l)
      const accountId = lk.account(args.account).id
      const rows = args.rows.map((r, i) => ({ line: i + 1, date: r.date, payee: r.payee, amountMinor: toMinor(r.amount), notes: r.notes, externalId: r.externalId }))
      if (!args.confirm) {
        const preview = await ctx.api.post<ImportPreviewRow[]>(`/ledgers/${l.slug}/import/preview`, { accountId, rows })
        const fresh = preview.filter((p) => p.duplicateOf === null)
        const categorized = fresh.filter((p) => p.suggestion.categoryId !== null).length
        const view = preview.slice(0, 100).map((p) => ({
          date: p.date,
          payee: p.payee,
          amount: money(p.amountMinor),
          duplicateOf: p.duplicateOf,
          category: lk.categoryName(p.suggestion.categoryId),
        }))
        const text = [
          `Preview for ${lk.accountName(accountId)} in ${l.name}: ${plural(fresh.length, 'new row')}, ${plural(preview.length - fresh.length, 'duplicate')}; ${categorized} of the new rows would get a category from history. Nothing was imported yet: call again with confirm: true.`,
          ...view.map((p) => `${p.date} ${p.payee} ${p.amount} · ${p.duplicateOf ? `duplicate of #${p.duplicateOf}` : (p.category ?? 'uncategorized')}`),
        ].join('\n')
        return { text, data: { ledger: l.slug, committed: false, newRows: fresh.length, duplicates: preview.length - fresh.length, categorized, preview: view } }
      }
      const r = await ctx.api.post<ImportResult>(`/ledgers/${l.slug}/import/commit`, { accountId, rows, fileName: args.fileName })
      return {
        text: `Imported ${plural(r.imported, 'transaction')} into ${lk.accountName(accountId)} (${r.skippedDuplicates} duplicates skipped); ${r.categorized} categorized, ${r.needsReview} to review.`,
        data: { ledger: l.slug, committed: true, newRows: r.imported, duplicates: r.skippedDuplicates, categorized: r.categorized, needsReview: r.needsReview },
      }
    },
  }),

  // Bank sync -------------------------------------------------------------------
  tool({
    name: 'sync_banks',
    scope: 'write',
    title: 'Sync bank accounts',
    description:
      'Fetches new transactions and balances from the connected banks (through SimpleFIN, Plaid or Wealthsimple) now, instead of waiting for the next automatic sync (as often as App settings → Bank sync says for each service: by default every 6 hours for SimpleFIN, every hour for Plaid, every 2 hours for Wealthsimple). SimpleFIN allows only about 24 updates a day, so don’t call this repeatedly.',
    input: z.object({}),
    output: z.object({
      synced: z.array(
        z.object({
          account: z.string(),
          ledger: z.string(),
          added: z.number(),
          updated: z.number(),
          matched: z.number(),
          removed: z.number(),
          error: z.string().nullable(),
        }),
      ),
      errors: z.array(z.string()),
    }),
    annotations: { ...WRITE, idempotentHint: true, openWorldHint: true },
    run: async (_args, ctx) => {
      const results = await ctx.api.post<SyncResult[]>('/bank/sync')
      const synced = results.flatMap((r) =>
        r.accounts.map((a) => ({ account: a.accountName, ledger: a.ledger, added: a.added, updated: a.updated, matched: a.adopted, removed: a.removed, error: a.error })),
      )
      const errors = results.filter((r) => !r.ok).map((r) => r.error ?? 'Sync failed')
      const text = results.length
        ? [
            ...synced.map((a) => `${a.account} (${a.ledger}): ${a.added} new, ${a.updated} updated, ${a.matched} matched, ${a.removed} removed${a.error ? ` · ${a.error}` : ''}`),
            ...errors.map((e) => `Error: ${e}`),
          ].join('\n')
        : 'No bank accounts are set up to sync. Connect one in App settings → Bank sync.'
      return { text, data: { synced, errors } }
    },
  }),

  // Admin -----------------------------------------------------------------------
  tool({
    name: 'create_ledger',
    scope: 'admin',
    title: 'Create a ledger',
    description: 'A new, separate set of books with default categories. `start: "demo"` fills it with sample data.',
    input: z.object({
      name: z.string().min(1).max(40),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      start: z.enum(['empty', 'demo']).default('empty'),
    }),
    output: z.object({ ledger: ledgerView }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const l = await ctx.api.post<Ledger>('/ledgers', { name: args.name, color: args.color, start: args.start })
      return {
        text: `Created the ledger ${l.name} (ledger: "${l.slug}").`,
        data: { ledger: { name: l.name, slug: l.slug, isDefault: false, archived: l.archived, accounts: l.accounts, transactions: l.transactions } },
      }
    },
  }),
  tool({
    name: 'archive_ledger',
    scope: 'admin',
    title: 'Archive a ledger',
    description: 'Hides a ledger from the app’s switcher while keeping all its data. It can be restored in App settings → Ledgers.',
    input: z.object({ ledger: z.string().min(1).describe('Ledger slug or name.') }),
    output: z.object({ ledger: ledgerView }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, ctx) => {
      const target = await ctx.ledger(args.ledger)
      const l = await ctx.api.patch<Ledger>(`/ledgers/${target.id}`, { archived: true })
      return {
        text: `Archived ${l.name}.`,
        data: { ledger: { name: l.name, slug: l.slug, isDefault: false, archived: l.archived, accounts: l.accounts, transactions: l.transactions } },
      }
    },
  }),
]

export { categoryTree }
