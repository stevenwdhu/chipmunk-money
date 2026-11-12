import { z } from 'zod'
import {
  ACCOUNT_TYPE_VALUES,
  AI_KINDS,
  BANK_PROVIDERS,
  CADENCE_VALUES,
  CATEGORY_SOURCES,
  LINK_KINDS,
  PAYEE_NAME_MATCHES,
  PAYEE_NAME_RULE_KINDS,
  PLAID_ENVIRONMENTS,
  TRANSACTION_COLUMNS,
} from './constants'
import { reportSpecSchema } from './filters'
import { columnMappingSchema } from './schemas'

/**
 * Response shapes returned by the API. Each is a Zod schema (used for the OpenAPI spec and the
 * response tests) and a type of the same name. Schemas with an `id` show up as named models in
 * the API docs.
 */

const date = z.string().meta({ format: 'date', description: 'A date (YYYY-MM-DD) in the app’s time zone.', examples: ['2026-10-03'] })
const month = z.string().meta({ description: 'A month (YYYY-MM).', examples: ['2026-10'] })
const timestamp = z.string().meta({ format: 'date-time' })
const minor = z.number().int().meta({ description: 'Money in minor units (cents). Negative is money out.' })
const id = z.number().int()

// Institutions & accounts ----------------------------------------------------

export const institutionSchema = z
  .object({
    id,
    name: z.string(),
    sort: z.number().int(),
    accountCount: z.number().int().describe('Archived accounts included.'),
  })
  .meta({ id: 'Institution' })
export type Institution = z.output<typeof institutionSchema>


export const accountBankSchema = z
  .object({
    connectionId: z.string(),
    bankAccountId: z.string(),
    provider: z.enum(BANK_PROVIDERS),
    institution: z.string().nullable(),
    name: z.string().describe('The account’s name at the bank.'),
    syncFrom: date.nullable().describe('Its transactions before this date are never imported. Null: no limit.'),
    lastSyncedAt: timestamp.nullable(),
    error: z.string().nullable(),
    balanceMinor: minor.nullable().describe('The balance the bank reported on the last sync.'),
    balanceDate: timestamp.nullable(),
  })
  .describe('Where this account syncs from, if it’s linked to a bank.')

const ledgerRef = z.object({ slug: z.string(), name: z.string() })

export const accountSharingBlockSchema = z
  .object({
    home: ledgerRef.describe('The ledger new transactions from sync and CSV go to, and where the account’s settings are changed.'),
    isHome: z.boolean().describe('Whether this ledger is the home.'),
    opening: ledgerRef.describe('The ledger whose balance on the account carries its opening balance and recorded balances.'),
    ledgers: z.array(ledgerRef).describe('Every ledger that has the account, the home first.'),
    totalBalanceMinor: minor.describe('The account’s balance across every ledger that has it: for a synced account, the bank’s.'),
  })
  .describe('How the account is shared between ledgers, or null when only this ledger has it. Each ledger’s `balanceMinor` is what it holds of the account.')

export const accountSchema = z
  .object({
    id,
    name: z.string(),
    type: z.enum(ACCOUNT_TYPE_VALUES),
    currency: z.string(),
    openingBalanceMinor: minor,
    openingDate: date.nullable(),
    institutionId: id,
    institution: z.string().describe('The institution’s name.'),
    notes: z.string().nullable(),
    archived: z.boolean(),
    sort: z.number().int(),
    isLiability: z.boolean(),
    balanceMinor: minor,
    monthMinor: minor.describe(
      'This month’s transactions so far, leaving out transfers and categories excluded from totals. For a credit card, this month’s spending (negative).',
    ),
    balanceAsOf: date.nullable().describe('Date of the latest recorded balance (by hand, or the bank’s for a synced investment, loan or property).'),
    transactionCount: z.number().int(),
    importMapping: columnMappingSchema.nullable().describe('The CSV column mapping remembered from the last import.'),
    bank: accountBankSchema.nullable().describe('Where this account syncs from, if it’s linked to a bank. Null in a ledger the account is shared with: it syncs into its home.'),
    sharing: accountSharingBlockSchema.nullable(),
  })
  .meta({ id: 'Account' })
export type Account = z.output<typeof accountSchema>

const ledgerPart = ledgerRef.extend({
  archived: z.boolean().describe('Whether the ledger is archived.'),
  transactionCount: z.number().int().describe('The transactions it holds on the account, deleted ones left out.'),
  balanceMinor: minor.describe('Its balance on the account: what it holds, and for the opening ledger also the opening balance and recorded balances.'),
})

export const accountSharingSchema = z
  .object({
    accountId: id,
    home: ledgerPart,
    opening: ledgerRef,
    members: z.array(ledgerPart).describe('The other ledgers the account is shared with. Empty when it isn’t shared.'),
    totalBalanceMinor: minor.describe('The sum of every ledger’s balance on the account.'),
  })
  .meta({ id: 'AccountSharing' })
export type AccountSharing = z.output<typeof accountSharingSchema>

export const balanceSnapshotSchema = z
  .object({ id, date, balanceMinor: minor, source: z.enum(['manual', 'sync']) })
  .meta({ id: 'BalanceSnapshot' })
export type BalanceSnapshot = z.output<typeof balanceSnapshotSchema>

export const balancePointSchema = z
  .object({
    date,
    balanceMinor: minor,
    monthMinor: minor.describe(
      'The month’s transactions up to this date, leaving out transfers and categories excluded from totals. For a credit card, that month’s spending.',
    ),
  })
  .meta({ id: 'BalancePoint' })
export type BalancePoint = z.output<typeof balancePointSchema>

// Categories & tags --------------------------------------------------------

export const categoryGroupSchema = z
  .object({ id, name: z.string(), color: z.string().describe('Its categories show in this colour; they have none of their own.'), sort: z.number().int() })
  .meta({ id: 'CategoryGroup' })
export type CategoryGroup = z.output<typeof categoryGroupSchema>

export const categorySchema = z
  .object({
    id,
    groupId: id.nullable(),
    name: z.string(),
    isIncome: z.boolean(),
    excludeFromTotals: z.boolean().describe('Transfers and card payments: left out of spending and income totals.'),
    labelIds: z.array(id).describe('Your labels on this category (see `labels` in the category list).'),
    archived: z.boolean().describe('Turned off in this ledger: not offered when you categorize. Always false in the shared list.'),
    sort: z.number().int(),
    transactionCount: z
      .number()
      .int()
      .optional()
      .describe('Transactions that use it: in this ledger, or (in the shared list) across the ledgers that use the shared list.'),
  })
  .meta({ id: 'Category' })
export type Category = z.output<typeof categorySchema>

export const categoryMergeResultSchema = z
  .object({
    into: categorySchema,
    transactions: z.number().int().describe('Transactions moved over (not counting deleted ones).'),
    recurring: z.number().int().describe('Recurring payments moved over.'),
  })
  .meta({ id: 'CategoryMergeResult' })
export type CategoryMergeResult = z.output<typeof categoryMergeResultSchema>

export const labelSchema = z
  .object({
    id,
    name: z.string(),
    color: z.string(),
    sort: z.number().int(),
    categoryCount: z.number().int().describe('Categories with this label.'),
  })
  .meta({ id: 'Label' })
  .describe('Your own way to sort categories across the groups, such as needs and wants. A category can have several labels.')
export type Label = z.output<typeof labelSchema>

export const categoryListSchema = z
  .object({
    groups: z.array(categoryGroupSchema),
    categories: z.array(categorySchema),
    labels: z.array(labelSchema),
    shared: z.boolean().optional().describe('In a ledger’s list: it uses the shared list (App settings) rather than its own.'),
  })
  .meta({ id: 'CategoryList' })
export type CategoryList = z.output<typeof categoryListSchema>

export const categoryJoinItemSchema = z
  .object({
    id,
    name: z.string(),
    group: z.string().nullable(),
    transactionCount: z.number().int(),
    suggestion: id.nullable().describe('A shared category that seems to fit, to match it with.'),
  })
  .meta({ id: 'CategoryJoinItem' })
  .describe('One of a ledger’s own categories that the shared list doesn’t have by name.')
export type CategoryJoinItem = z.output<typeof categoryJoinItemSchema>

// Payees ---------------------------------------------------------------------

export const payeeRuleSchema = z
  .object({
    payeeKey: z.string(),
    payee: z.string().describe('Its name for display, from its newest transaction (“A&W Restaurants”).'),
    mode: z.enum(['always', 'review']),
    categoryId: id.nullable().describe('For `always`: the category it’s set to.'),
    transactionCount: z.number().int(),
    updatedAt: timestamp,
  })
  .meta({ id: 'PayeeRule' })
  .describe('What you chose for a payee: always one category, or always review it yourself. Payees without one ask each time.')
export type PayeeRule = z.output<typeof payeeRuleSchema>

export const payeeNameRuleSchema = z
  .object({
    id,
    kind: z.enum(PAYEE_NAME_RULE_KINDS).describe('`same`: names that are one payee. `regex`: a pattern on the payee as sent.'),
    match: z.enum(PAYEE_NAME_MATCHES).nullable().describe('For `same`: a payee fits a pattern when it `is` it, `starts` with it or `contains` it.'),
    patterns: z.array(z.string()).describe('`same`: the names that are this payee. `regex`: one pattern.'),
    name: z.string().nullable().describe('`same`: the payee’s name. `regex`: what it becomes ($1: what the first group caught).'),
    enabled: z.boolean(),
    transactionCount: z.number().int().describe('Transactions it names, in every ledger.'),
    updatedAt: timestamp,
  })
  .meta({ id: 'PayeeNameRule' })
  .describe('One of your rules for what payees are called, in every ledger. They apply before AI tidying, in order.')
export type PayeeNameRule = z.output<typeof payeeNameRuleSchema>

export const payeeTidyNameSchema = z
  .object({
    original: z.string().describe('The payee as the bank or file sent it.'),
    tidied: z.string().describe('What AI tidying called it.'),
    name: z.string().describe('What it’s called: by your rule when one names it, else what AI tidying called it.'),
    ruleId: id.nullable().describe('Your payee name rule that names it.'),
    transactions: z.number().int().describe('Transactions with this payee, in every ledger.'),
    updatedAt: timestamp,
  })
  .meta({ id: 'PayeeTidyName' })
export type PayeeTidyName = z.output<typeof payeeTidyNameSchema>

export const payeeTidyStatusSchema = z
  .object({
    enabled: z.boolean().describe('AI tidying names payees (your rules still come first).'),
    available: z.boolean().describe('An AI provider is set up to do it.'),
    running: z.boolean().describe('Payees are being tidied in the background.'),
    done: z.number().int().describe('Payees tidied so far in this run.'),
    total: z.number().int().describe('Payees this run is tidying.'),
    error: z.string().nullable().describe('Why the last batch failed, if it did.'),
    names: z.array(payeeTidyNameSchema).describe('Every payee AI tidying has named, in alphabetical order of the payee as sent.'),
  })
  .meta({ id: 'PayeeTidyStatus' })
export type PayeeTidyStatus = z.output<typeof payeeTidyStatusSchema>

export const payeeTidyPreviewSchema = z
  .object({
    samples: z.array(z.object({ original: z.string().describe('The payee as sent.'), tidied: z.string().describe('What AI tidying calls it.') })),
    page: z.number().int().describe('Which batch of 20 this is, from 0: the messiest and most used payees first.'),
    total: z.number().int().describe('Payees there are, in every ledger.'),
  })
  .meta({ id: 'PayeeTidyPreview' })
  .describe('A batch of payees AI tidying named, to see what it does before it names the rest.')
export type PayeeTidyPreview = z.output<typeof payeeTidyPreviewSchema>

export const payeeNamePreviewSchema = z
  .object({
    transactions: z.number().int().describe('Transactions whose payee name changes.'),
    changes: z
      .array(z.object({ from: z.string(), to: z.string(), payees: z.array(z.string()).describe('A few of the payees as sent.'), transactions: z.number().int() }))
      .describe('Each name that changes, and what to: the most transactions first, up to 50.'),
  })
  .meta({ id: 'PayeeNamePreview' })
  .describe('What payee names a change to the rules makes, before it’s saved.')
export type PayeeNamePreview = z.output<typeof payeeNamePreviewSchema>

export const payeeChoiceSchema = z
  .object({
    payeeKey: z.string(),
    mode: z.enum(['always', 'ask', 'review']),
    categoryId: id.nullable(),
    pending: z.number().int().describe('Transactions `always` (with the category asked about) sets: ones waiting for review or uncategorized.'),
  })
  .meta({ id: 'PayeeChoice' })
export type PayeeChoice = z.output<typeof payeeChoiceSchema>

export const tagSchema = z.object({ id, name: z.string(), color: z.string().nullable() }).meta({ id: 'Tag' })
export type Tag = z.output<typeof tagSchema>

export const tagWithCountSchema = tagSchema
  .extend({ count: z.number().int().describe('Transactions with this tag.') })
  .meta({ id: 'TagWithCount' })
export type TagWithCount = z.output<typeof tagWithCountSchema>

// Transactions -------------------------------------------------------------

export const transactionLinkSchema = z
  .object({
    id,
    kind: z.enum(LINK_KINDS).describe('`refund`: money back from the merchant. `payback`: someone paying you back their share of a bill you paid.'),
    transactionId: id.describe('The other side: for money in, the purchase or bill it pays back. For money out, money in that pays it back.'),
    amountMinor: minor.describe('How much of the money in goes to that purchase or bill, as a positive number.'),
  })
  .meta({ id: 'TransactionLink' })
export type TransactionLink = z.output<typeof transactionLinkSchema>

export const transactionSchema = z
  .object({
    id,
    accountId: id,
    date,
    amountMinor: minor,
    currency: z.string(),
    payee: z.string().describe('As the bank or file sent it (or as you entered it), never tidied.'),
    payeeKey: z.string().describe('Which payee it is: transactions with the same key are one payee. Made from `payee` by the payee name rules.'),
    payeeName: z.string().describe('What its payee is called: by your payee name rules, or AI tidying (“Walmart” for “Wal-Mart Supercenter#4217”), or as sent.'),
    payeeNameRule: id.nullable().describe('Your payee name rule that named it. Null: AI tidying named it, or it’s as sent.'),
    datetime: z
      .string()
      .nullable()
      .describe('When it happened, when known: local time like `date`, on the same day (YYYY-MM-DDTHH:MM:SS). Orders a day’s transactions; most banks only give the day.'),
    name: z.string().nullable().describe('What it is, like “Suitcase”: its recurring item’s name when it’s a payment of one that has a name, otherwise its own.'),
    categoryId: id.nullable(),
    categorySource: z.enum(CATEGORY_SOURCES).nullable(),
    categoryConfidence: z.number().nullable(),
    needsReview: z.boolean().describe('The category was suggested and is waiting for you to accept or change it.'),
    notes: z.string().nullable(),
    recurringItemId: id.nullable(),
    transferPairId: id.nullable().describe('The other side of a transfer between two of your accounts.'),
    transferMatched: z
      .boolean()
      .describe(
        'The transfer was matched from two separate records (a card payment and the withdrawal that paid it), so editing one side doesn’t change the other. False for a transfer you entered as one, whose sides stay in step.',
      ),
    links: z
      .array(transactionLinkSchema)
      .describe(
        'Refunds and paybacks. For money in, the purchases or bills it pays back: linked in full to one, it takes that one’s category (`categorySource` `linked`), and to several it has none of its own. Reports count each link in its bill’s category, a payback on the bill’s date. For money out, what paid it back.',
      ),
    bankCategory: z.string().nullable().describe('The bank’s own category for it (Plaid’s, e.g. “Transportation › Gas”), when the bank gives one.'),
    status: z.enum(['cleared', 'pending']),
    origin: z.enum(['manual', 'import', 'sync']),
    externalId: z.string().nullable().describe('Your own id for this transaction, unique per account.'),
    correctedAt: timestamp.nullable().describe('When you corrected its amount or date after it came from the bank; syncs leave those alone from then on.'),
    tags: z.array(tagSchema),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Transaction' })
export type Transaction = z.output<typeof transactionSchema>

export const bankPayloadSchema = z
  .object({
    id,
    provider: z.enum(BANK_PROVIDERS),
    remoteId: z.string().describe('The provider’s id for the transaction.'),
    event: z.enum(['added', 'changed', 'removed']).describe('Sent as new, sent again with something different, or removed (Plaid).'),
    receivedAt: timestamp,
    payload: z.unknown().describe('Exactly what the provider sent (Plaid’s or SimpleFIN’s JSON).'),
  })
  .meta({ id: 'BankPayload' })
  .describe('What the bank sync service sent for a transaction, as it sent it.')
export type BankPayload = z.output<typeof bankPayloadSchema>

export const transactionListItemSchema = transactionSchema
  .extend({
    balanceAfterMinor: minor
      .nullable()
      .describe(
        'The account’s balance after this transaction, like a bank statement’s running balance. Only when listing one account’s transactions with no filter other than dates; null otherwise.',
      ),
  })
  .meta({ id: 'TransactionListItem' })
export type TransactionListItem = z.output<typeof transactionListItemSchema>

export const transactionPageSchema = z
  .object({
    items: z.array(transactionListItemSchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page. Null on the last page.'),
  })
  .meta({ id: 'TransactionPage' })
export type TransactionPage = z.output<typeof transactionPageSchema>

export const linkCandidateSchema = z
  .object({
    transaction: transactionSchema,
    leftMinor: minor.describe('How much of it is left to link, as a positive number: for a purchase or bill, its amount less what paid it back so far; for money in, what isn’t linked yet.'),
    likely: z.boolean().describe('A refund: from the same or a similar payee. A payback: the amounts fit (one is a whole share of the other, or what’s left matches).'),
  })
  .meta({ id: 'LinkCandidate' })
  .describe('A transaction one could be linked to: a purchase or bill money in pays back, or money in that pays a bill back.')
export type LinkCandidate = z.output<typeof linkCandidateSchema>

export const linkedTransactionSchema = z
  .object({ link: transactionLinkSchema, transaction: transactionSchema })
  .meta({ id: 'LinkedTransaction' })
  .describe('A link and the transaction on its other side.')
export type LinkedTransaction = z.output<typeof linkedTransactionSchema>

const changedFields = z.record(z.string(), z.unknown())

export const bulkResultSchema = z
  .object({
    updated: z.number().int(),
    dryRun: z.boolean(),
    changes: z
      .array(
        z.object({
          id,
          payee: z.string(),
          date,
          amountMinor: minor,
          deleted: z.boolean(),
          before: changedFields.describe('The fields that change, before.'),
          after: changedFields.describe('The fields that change, after.'),
        }),
      )
      .describe('One entry per transaction that changes.'),
  })
  .meta({ id: 'BulkResult' })
export type BulkResult = z.output<typeof bulkResultSchema>

export const categorySuggestionSchema = z
  .object({
    categoryId: id.nullable(),
    source: z.enum(['history', 'fuzzy', 'ai', 'none']),
    confidence: z.number(),
    reason: z.string().describe('Short explanation, e.g. "You picked Groceries 4 times for loblaws".'),
    provider: z.enum(['primary', 'fallback']).optional(),
  })
  .meta({ id: 'CategorySuggestion' })
export type CategorySuggestion = z.output<typeof categorySuggestionSchema>

export const aiJobStatusSchema = z
  .object({
    running: z.boolean(),
    total: z.number().int().describe('Distinct payees to ask about.'),
    done: z.number().int(),
    categorized: z.number().int().describe('Transactions that got a suggested category.'),
    startedAt: timestamp.nullable(),
  })
  .meta({ id: 'AiJobStatus' })
export type AiJobStatus = z.output<typeof aiJobStatusSchema>

// Reports ------------------------------------------------------------------

export const categoryAmountSchema = z
  .object({
    categoryId: id.nullable(),
    name: z.string(),
    color: z.string().describe('Its group’s colour (categories have none of their own).'),
    groupId: id.nullable(),
    groupName: z.string().nullable(),
    amountMinor: minor.describe('Spending as a positive number (or income, for income reports).'),
    count: z.number().int(),
  })
  .meta({ id: 'CategoryAmount' })
export type CategoryAmount = z.output<typeof categoryAmountSchema>

export const monthSummarySchema = z
  .object({
    month,
    from: date,
    to: date,
    spentMinor: minor,
    incomeMinor: minor,
    netMinor: minor,
    savingsRate: z.number().nullable(),
    previousSpentMinor: minor,
    averageSpentMinor: minor.describe('Average spending over the previous three months.'),
    byCategory: z.array(categoryAmountSchema),
    needsReviewCount: z.number().int(),
    transactionCount: z.number().int(),
    uncategorizedCount: z.number().int(),
  })
  .meta({ id: 'MonthSummary' })
export type MonthSummary = z.output<typeof monthSummarySchema>

export const transactionSpanSchema = z
  .object({
    first: date.nullable().describe('The earliest transaction’s date; null when there are none.'),
    last: date.nullable(),
  })
  .meta({ id: 'TransactionSpan' })
export type TransactionSpan = z.output<typeof transactionSpanSchema>

const amountCount = z.object({ amountMinor: minor, count: z.number().int().describe('Purchases, bills or deposits it comes from.') })
export const filteredOutSchema = amountCount
  .extend({
    amountMinor: minor.describe('Net of refunds and paybacks, as a positive number for spending (it can be negative).'),
    byRule: z.array(amountCount).describe('Each Filter out rule’s own share, in order. Rules can overlap, so these can add up to more than the total.'),
    picked: amountCount.describe('The share of what was picked.'),
  })
  .meta({ id: 'FilteredOut' })
export type FilteredOut = z.output<typeof filteredOutSchema>

export const periodSummarySchema = z
  .object({
    from: date,
    to: date,
    months: z.number().int().describe('Calendar months the period touches, for monthly averages.'),
    incomeMinor: minor,
    spentMinor: minor,
    netMinor: minor,
    income: z.array(categoryAmountSchema),
    expenses: z
      .array(z.object({ groupId: id.nullable(), name: z.string(), amountMinor: minor, categories: z.array(categoryAmountSchema) }))
      .describe('Spending by category group, in the groups’ order; categories without a group come last.'),
    excluded: z
      .object({ amountMinor: minor, categories: z.array(categoryAmountSchema) })
      .describe('Transfers and categories left out of totals, as net amounts (negative is money out).'),
    labels: z
      .object({
        items: z.array(z.object({ labelId: id, name: z.string(), color: z.string(), spentMinor: minor, incomeMinor: minor })),
        unlabelledSpentMinor: minor.describe('Spending in categories without a label, and uncategorized spending.'),
      })
      .describe(
        'Spending and income by your category labels, in the labels’ order (only labels that are on a category). A category with several labels counts under each, so these can add up to more than the totals.',
      ),
    transactionCount: z.number().int(),
    uncategorizedCount: z.number().int(),
    filteredOut: z
      .object({ spending: filteredOutSchema, income: filteredOutSchema })
      .nullable()
      .describe('What the filter filters out, for spending and for income (null without a filter).'),
  })
  .meta({ id: 'PeriodSummary' })
export type PeriodSummary = z.output<typeof periodSummarySchema>

export const trendPointSchema = z.object({
  month,
  spentMinor: minor,
  incomeMinor: minor,
  netMinor: minor,
  filteredOutMinor: minor.describe('Spending the filter filters out that month (0 without one).'),
  byKey: z.record(z.string(), z.number()).describe('Spending per series key (category or group id).'),
})
export type TrendPoint = z.output<typeof trendPointSchema>

export const trendReportSchema = z
  .object({
    months: z.array(month),
    points: z.array(trendPointSchema),
    series: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        color: z.string().describe('By group: the group’s colour. By category: a chart colour by rank, so they’re easy to tell apart.'),
        totalMinor: minor,
      }),
    ),
  })
  .meta({ id: 'TrendReport' })
export type TrendReport = z.output<typeof trendReportSchema>

export const monthTotalsSchema = z
  .object({ month, incomeMinor: minor, spentMinor: minor, netMinor: minor })
  .meta({ id: 'MonthTotals' })
export type MonthTotals = z.output<typeof monthTotalsSchema>

export const payeeTotalSchema = z
  .object({ payeeKey: z.string(), payee: z.string(), amountMinor: minor, count: z.number().int(), categoryId: id.nullable() })
  .meta({ id: 'PayeeTotal' })
export type PayeeTotal = z.output<typeof payeeTotalSchema>

export const payeeSearchResultSchema = z
  .object({
    payeeKey: z.string(),
    payee: z.string().describe('What the payee name rules call it.'),
    count: z.number().int().describe('Its transactions.'),
    lastDate: date,
  })
  .meta({ id: 'PayeeSearchResult' })
export type PayeeSearchResult = z.output<typeof payeeSearchResultSchema>

export const tagTotalSchema = z
  .object({
    tagId: id,
    name: z.string(),
    color: z.string().nullable(),
    spentMinor: minor,
    incomeMinor: minor,
    count: z.number().int(),
  })
  .meta({ id: 'TagTotal' })
export type TagTotal = z.output<typeof tagTotalSchema>

export const reportPurchaseSchema = z.object({
  transaction: transactionSchema,
  inRangeMinor: minor.describe('How much of it falls in the period: the purchase, less its refunds and paybacks dated in it (positive for spending).'),
  shareMinor: minor.describe('Your share of it: what it cost, less all its refunds and paybacks (for a deposit: what came in, less what’s linked to bills).'),
  rules: z.array(z.number().int()).describe('The Filter out rules it matches, by index.'),
  picked: z.boolean(),
  kept: z.boolean().describe('Put back: counted, although a rule or pick would filter it out.'),
})
export const reportPurchasesSchema = z
  .object({
    totalMinor: minor.describe('All of them in the period, not just the ones listed.'),
    count: z.number().int(),
    items: z.array(reportPurchaseSchema),
  })
  .meta({ id: 'ReportPurchases' })
export type ReportPurchases = z.output<typeof reportPurchasesSchema>

export const netWorthPointSchema = z.object({ date, assetsMinor: minor, liabilitiesMinor: minor, netWorthMinor: minor })
export type NetWorthPoint = z.output<typeof netWorthPointSchema>

export const netWorthReportSchema = z
  .object({
    points: z.array(netWorthPointSchema).describe('Month ends, then today: every account’s balance, with what’s owed on credit cards and loans as liabilities.'),
    current: netWorthPointSchema,
    byAccount: z.array(
      z.object({
        accountId: id,
        name: z.string(),
        type: z.enum(ACCOUNT_TYPE_VALUES),
        balanceMinor: minor,
        isLiability: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'NetWorthReport' })
export type NetWorthReport = z.output<typeof netWorthReportSchema>

export const CUSTOM_REPORT_REF_KINDS = ['category', 'group', 'label', 'tag', 'payee', 'account', 'recurring', 'transaction'] as const

export const customReportMissingSchema = z.object({
  kind: z.enum(CUSTOM_REPORT_REF_KINDS),
  id: z.union([id, z.string()]).describe('Its id, or a payee’s payee key.'),
  reason: z
    .enum(['deleted', 'off', 'unused'])
    .describe('`deleted`: it no longer exists (a transaction: or it was deleted). `off`: a category turned off in this ledger. `unused`: a payee no transaction has any more.'),
})
export type CustomReportMissing = z.output<typeof customReportMissingSchema>

export const customReportSchema = z
  .object({
    id,
    name: z.string(),
    spec: reportSpecSchema,
    description: z.string().describe('The filter in words, like “Spending: Filter out #trip-japan”, or “Everything”.'),
    missing: z.array(customReportMissingSchema).describe('What the filter refers to that’s gone or off. It matches nothing.'),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'CustomReport' })
  .describe('A report you saved: its filter, range and comparison, under a name.')
export type CustomReport = z.output<typeof customReportSchema>

// Recurring ----------------------------------------------------------------

export const RECURRING_STATUSES = ['suggested', 'active', 'dismissed', 'ended'] as const
export type RecurringStatus = (typeof RECURRING_STATUSES)[number]
export type RecurringAlert = 'missing' | 'price_changed'

export const recurringItemSchema = z
  .object({
    id,
    name: z.string().nullable().describe('What it is, like “Dyson vacuum”. Null: it goes by its payee.'),
    payee: z.string().describe('The payee as shown, like “Klarna”.'),
    payeeKey: z.string().describe('The payee as payments are matched by it.'),
    categoryId: id.nullable(),
    accountId: id.nullable(),
    expectedAmountMinor: minor,
    amountTolerancePct: z.number(),
    cadence: z.enum(CADENCE_VALUES),
    anchorDate: date,
    nextDueDate: date,
    status: z.enum(RECURRING_STATUSES).describe('`suggested` items were detected and wait for you to confirm or dismiss them.'),
    origin: z.enum(['detected', 'manual']),
    detectionScore: z.number().nullable(),
    occurrences: z.number().int(),
    lastSeenDate: date.nullable(),
    lastAmountMinor: minor.nullable(),
    alerts: z.array(z.enum(['missing', 'price_changed'])),
    monthlyCostMinor: minor,
    secondDay: z.number().int().nullable().describe('Semi-monthly: the other day of the month it’s due (31: the last day). The first is the anchor date’s.'),
    totalPayments: z.number().int().nullable().describe('An instalment plan: how many payments it has. Null for bills, subscriptions and income, which have no end.'),
    paidPayments: z.number().int().describe('Payments made: the linked ones (for a suggestion, the ones found), plus any from before your history.'),
    remainingPayments: z.number().int().nullable().describe('An instalment plan: payments still to make.'),
    remainingAmountMinor: minor.nullable().describe('An instalment plan: what’s left to pay, its last payment as `lastPaymentMinor` when it has a full price and the others at its amount.'),
    totalAmountMinor: minor.nullable().describe('An instalment plan: its full price. What’s been paid, plus what’s left (`remainingAmountMinor`). Payments from before your history count at the usual amount.'),
    endDate: date.nullable().describe('An instalment plan: when the last payment is due (or was made).'),
    fullPriceMinor: minor.nullable().describe('An instalment plan: the total of all its payments, as you gave it. Null: every payment is its amount.'),
    lastPaymentMinor: minor
      .nullable()
      .describe(
        'An instalment plan with a full price and payments to go: its last payment, what’s left of the full price after the payments made and the others to come at its amount. Null without a full price, once it’s paid off, or when the full price is less than its payments add up to.',
      ),
    instalmentService: z.boolean().describe('The payee is a buy-now-pay-later service (Klarna, Affirm…), so it’s likely an instalment plan.'),
    stopped: z.boolean().describe('A suggestion whose payments have stopped (or a plan that’s paid off): confirming it keeps it in Ended, its payments linked.'),
    otherPayees: z
      .array(z.string())
      .describe('More payees its payments come from besides its own, like “PayHub” for “PayHub Tax” (the bank started sending another name). Their payments match only within its price variation and on its schedule.'),
    possiblePayment: z
      .object({
        transactionId: id,
        date,
        payee: z.string(),
        amountMinor: minor,
        newAmount: z.boolean().describe('From its own payee, beyond its price variation: linking it makes this the item’s amount from its due date on. Not for a `role` payment.'),
        role: z
          .enum(['first', 'last'])
          .nullable()
          .describe(
            'An instalment plan’s `first` payment (one missing before its others, at exactly what makes its payments add up to its full price, like a down payment) or its `last` (what’s left of its price). Linking it adds it at its own amount: the plan’s amount stays.',
          ),
        dueDate: date.describe('The due date it would be the payment for: its next one, or one in its history that has none (it came early or late).'),
      })
      .nullable()
      .describe(
        'An active item: an unlinked payment near its next due date that may be its: from a similar payee within its price variation, or from its own payee at a new amount. Link it (a new payee is added; a new amount becomes the item’s) or say it isn’t this item’s.',
      ),
  })
  .meta({ id: 'RecurringItem' })
export type RecurringItem = z.output<typeof recurringItemSchema>

/** What a recurring item is called: its name, or its payee. */
export const recurringLabel = (i: { name: string | null; payee: string }) => i.name ?? i.payee

export const recurringPaymentCandidateSchema = z
  .object({
    transaction: transactionSchema,
    likely: z.boolean().describe('From one of its payees, or a payee like them.'),
  })
  .meta({ id: 'RecurringPaymentCandidate' })
  .describe('A payment you could add to a recurring item: not linked to one, and not a transfer.')
export type RecurringPaymentCandidate = z.output<typeof recurringPaymentCandidateSchema>

export const upcomingPaymentSchema = z
  .object({
    recurringItemId: id,
    name: z.string().nullable().describe('What it is; null: it goes by its payee.'),
    payee: z.string(),
    dueDate: date,
    amountMinor: minor,
    categoryId: id.nullable(),
    accountId: id.nullable(),
    overdue: z.boolean(),
    paymentNumber: z.number().int().nullable().describe('An instalment plan: which payment this is, of `totalPayments`.'),
    totalPayments: z.number().int().nullable(),
  })
  .meta({ id: 'UpcomingPayment' })
export type UpcomingPayment = z.output<typeof upcomingPaymentSchema>

// Settings & AI ------------------------------------------------------------

export const aiProviderPublicSchema = z.object({
  kind: z.enum(AI_KINDS),
  model: z.string(),
  baseUrl: z.string().nullable().describe('The URL of an `openai-compatible` server, or of a `local` one when it isn’t at localhost:11434.'),
  hasApiKey: z.boolean(),
  apiKeyHint: z.string().nullable().describe('The last few characters of the key.'),
  source: z.enum(['settings', 'env']),
})
export type AiProviderPublic = z.output<typeof aiProviderPublicSchema>

export const chatgptStatusSchema = z
  .object({
    signedIn: z.boolean(),
    email: z.string().nullable().describe('The ChatGPT account signed in.'),
    planUsage: z.boolean().describe('The sign-in allows requests on the ChatGPT plan (without it, sign in again to enable it).'),
    registered: z.boolean().describe('This app was registered with a ChatGPT account before (signed in at least once).'),
    usageUrl: z.string().describe('Where to see and manage the plan’s usage in ChatGPT.'),
  })
  .meta({ id: 'ChatgptStatus' })
  .describe('Signing in with ChatGPT, for the “ChatGPT plan” AI provider: requests use your ChatGPT plan instead of an API key.')
export type ChatgptStatus = z.output<typeof chatgptStatusSchema>

export const chatgptModelSchema = z
  .object({ slug: z.string().describe('What to set as the model.'), displayName: z.string() })
  .meta({ id: 'ChatgptModel' })
export type ChatgptModel = z.output<typeof chatgptModelSchema>

export const plaidPublicSchema = z
  .object({
    clientId: z.string().nullable(),
    hasSecret: z.boolean(),
    secretHint: z.string().nullable().describe('The last few characters of the secret.'),
    environment: z.enum(PLAID_ENVIRONMENTS),
    source: z.enum(['settings', 'env']).nullable().describe('Where the credentials come from; null when not set.'),
    configured: z.boolean().describe('A client id and secret are set, so banks can be connected.'),
  })
  .meta({ id: 'PlaidSettings' })
export type PlaidPublic = z.output<typeof plaidPublicSchema>

export const settingsSchema = z
  .object({
    timezone: z.string().nullable().describe('Null means the server’s time zone.'),
    systemTimezone: z.string(),
    effectiveTimezone: z.string(),
    today: date,
    baseCurrency: z.string(),
    firstDayOfWeek: z.union([z.literal(0), z.literal(1)]),
    transactionColumns: z.array(z.enum(TRANSACTION_COLUMNS)).describe('The transactions table’s column order, the same everywhere the app is used.'),
    transactionColumnWidths: z
      .partialRecord(z.enum(TRANSACTION_COLUMNS), z.number().int())
      .describe('Column widths (px) you set; columns not listed use their default width.'),
    sidebarWidth: z.number().int().describe('The main sidebar’s width (px).'),
    customColors: z.array(z.string()).describe('Colours you picked outside the palette, newest first.'),
    ai: z.object({
      primary: aiProviderPublicSchema.nullable(),
      fallback: aiProviderPublicSchema.nullable(),
      enabled: z.boolean(),
    }),
    bank: z.object({
      plaid: plaidPublicSchema,
      syncHours: z
        .object({ simplefin: z.number().int(), plaid: z.number().int(), wealthsimple: z.number().int() })
        .describe('How often bank sync runs, in hours, for each service. Change it with PATCH /settings (bankSyncHours).'),
    }),
    recurringDetection: z
      .object({ priceVariationPct: z.number(), dateVariationDays: z.number().int() })
      .describe('How much a payment may vary and still count toward a recurring pattern: its amount (% of the latest) and its date (± days, plus weekends).'),
  })
  .meta({ id: 'Settings' })
export type Settings = z.output<typeof settingsSchema>

export const aiUsageSchema = z
  .object({
    calls: z.number().int(),
    failures: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    recent: z.array(
      z.object({
        id,
        createdAt: timestamp,
        slot: z.enum(['primary', 'fallback']),
        model: z.string(),
        ok: z.boolean(),
        latencyMs: z.number().int(),
        error: z.string().nullable(),
        ledger: z.string().optional().describe('Which ledger’s categorization made the call (app-wide usage only).'),
      }),
    ),
  })
  .meta({ id: 'AiUsage' })
export type AiUsage = z.output<typeof aiUsageSchema>

export const aiTestResultSchema = z
  .object({
    ok: z.boolean(),
    category: z.string().optional(),
    confidence: z.number().optional(),
    model: z.string().optional(),
    latencyMs: z.number().int(),
    error: z.string().optional(),
  })
  .meta({ id: 'AiTestResult' })
export type AiTestResult = z.output<typeof aiTestResultSchema>

// Import -------------------------------------------------------------------

export const importPreviewRowSchema = z
  .object({
    line: z.number().int(),
    date,
    payee: z.string(),
    amountMinor: minor,
    notes: z.string().nullable(),
    category: z.string().nullable().optional().describe('The category the bank or another app gave it, kept as its bank category.'),
    externalId: z.string().nullable().optional(),
    duplicateOf: id.nullable().describe('An existing transaction that looks like the same one. Null when there’s none, or another ledger has it (`duplicateElsewhere`).'),
    duplicateElsewhere: z
      .boolean()
      .describe('It looks like a transaction another ledger has on this shared account: a duplicate too, so it isn’t imported, but that transaction isn’t named.'),
    suggestion: categorySuggestionSchema,
  })
  .meta({ id: 'ImportPreviewRow' })
export type ImportPreviewRow = z.output<typeof importPreviewRowSchema>

export const importResultSchema = z
  .object({
    batchId: id.nullable().describe('Null for a dry run.'),
    imported: z.number().int(),
    skippedDuplicates: z.number().int(),
    categorized: z.number().int(),
    needsReview: z.number().int(),
    dryRun: z.boolean(),
  })
  .meta({ id: 'ImportResult' })
export type ImportResult = z.output<typeof importResultSchema>

export const importBatchSchema = z
  .object({
    id,
    accountId: id,
    accountName: z.string(),
    fileName: z.string().nullable(),
    rowCount: z.number().int(),
    createdAt: timestamp,
  })
  .meta({ id: 'ImportBatch' })
export type ImportBatch = z.output<typeof importBatchSchema>

// Ledgers & data -----------------------------------------------------------

export const ledgerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().describe('Used in URLs. Changes when the ledger is renamed; the id never does.'),
    color: z.string(),
    icon: z.string().nullable(),
    sort: z.number().int(),
    archived: z.boolean(),
    isDefault: z.boolean(),
    createdAt: timestamp,
    accounts: z.number().int(),
    transactions: z.number().int(),
  })
  .meta({ id: 'Ledger' })
export type Ledger = z.output<typeof ledgerSchema>

export const setupStatusSchema = z
  .object({
    needsSetup: z.boolean().describe('True for a new ledger: no data yet and no choice made on the welcome screen.'),
    accounts: z.number().int(),
    transactions: z.number().int(),
  })
  .meta({ id: 'SetupStatus' })
export type SetupStatus = z.output<typeof setupStatusSchema>

export const demoResultSchema = z.object({ transactions: z.number().int(), recurringSuggestions: z.number().int() })
export type DemoResult = z.output<typeof demoResultSchema>

export const backupResultSchema = z.object({
  backup: z.string().nullable().describe('File name of the safety copy saved in data/backups: a copy of the whole database. Null when no copy was made.'),
})
export type BackupResult = z.output<typeof backupResultSchema>

// API keys -----------------------------------------------------------------

export const API_SCOPES = ['read', 'write', 'admin'] as const
export type ApiScope = (typeof API_SCOPES)[number]

export const apiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().describe('The start of the key, to recognise it.'),
    scopes: z.array(z.enum(API_SCOPES)),
    ledgers: z.array(z.string()).nullable().describe('Ledger ids this key can use. Null means every ledger.'),
    expiresAt: timestamp.nullable(),
    lastUsedAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .meta({ id: 'ApiKey' })
export type ApiKey = z.output<typeof apiKeySchema>

export const apiKeyCreatedSchema = apiKeySchema
  .extend({ key: z.string().describe('The full key. It is only shown this once.') })
  .meta({ id: 'ApiKeyCreated' })
export type ApiKeyCreated = z.output<typeof apiKeyCreatedSchema>

// Activity -----------------------------------------------------------------

export const activitySchema = z
  .object({
    id,
    createdAt: timestamp,
    actor: z.string().describe('`web` for the app itself, otherwise the API key’s name.'),
    action: z.string().describe('What happened, e.g. `create`, `update`, `delete`, `bulk_update`, `import`.'),
    entity: z.string().describe('What it happened to, e.g. `transaction`, `account`, `category`.'),
    entityId: z.string().nullable(),
    summary: z.string(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
  })
  .meta({ id: 'Activity' })
export type Activity = z.output<typeof activitySchema>

export const activityPageSchema = z
  .object({ items: z.array(activitySchema), nextCursor: z.string().nullable() })
  .meta({ id: 'ActivityPage' })
export type ActivityPage = z.output<typeof activityPageSchema>

// Bank sync ----------------------------------------------------------------

export const bankAccountSchema = z
  .object({
    id: z.string(),
    remoteId: z.string(),
    name: z.string(),
    institution: z.string().nullable(),
    remoteInstitutionId: z.string().nullable().describe('The provider’s id for the institution.'),
    currency: z.string(),
    balanceMinor: minor.nullable(),
    availableMinor: minor.nullable(),
    balanceDate: timestamp.nullable(),
    link: z
      .object({ ledgerId: z.string(), ledgerSlug: z.string(), ledgerName: z.string(), accountId: id, accountName: z.string() })
      .nullable()
      .describe('The ledger account this syncs into. Null: not synced.'),
    syncFrom: date.nullable(),
    lastSyncedAt: timestamp.nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'BankAccount' })
export type BankAccount = z.output<typeof bankAccountSchema>

export const linkableBankAccountSchema = bankAccountSchema
  .extend({ connectionId: z.string(), connectionName: z.string(), provider: z.enum(BANK_PROVIDERS).describe('The service its connection is at.') })
  .meta({ id: 'LinkableBankAccount' })
export type LinkableBankAccount = z.output<typeof linkableBankAccountSchema>

const previewLocal = z.object({
  id,
  date,
  payee: z.string(),
  amountMinor: minor,
  deleted: z.boolean().describe('You deleted it: matched, it stays deleted.'),
  elsewhere: z
    .object({ ledger: z.object({ slug: z.string(), name: z.string() }), account: z.string().nullable().describe('The account it’s on there. Null: this one.') })
    .optional()
    .describe('Another ledger has it, on this shared account: the switch changes or deletes it there. Left out for this ledger’s own.'),
})
const previewRemote = z.object({ remoteId: z.string(), date, payee: z.string(), amountMinor: minor, pending: z.boolean() })

export const linkPreviewSchema = z
  .object({
    from: date,
    to: date,
    earliest: date.describe('As far back as it can compare: the oldest of the bank account’s transactions kept from its syncs.'),
    first: date.nullable().describe('The account’s first transaction. The bank’s from before it are only the bank’s (`remote`).'),
    provider: z.enum(BANK_PROVIDERS),
    fetchedAt: timestamp
      .nullable()
      .describe('When the bank account’s transactions were last fetched (by a sync). The comparison uses those, without fetching. Null: never, so sync its connection first.'),
    version: z.string().describe('Send it with POST /accounts/{id}/bank/switch, so it applies to what you reviewed.'),
    rows: z
      .array(
        z.object({
          kind: z
            .enum(['matched', 'guessed', 'near', 'local', 'remote'])
            .describe(
              '`matched`: the same one (the same amount within a day, the only one or by far the closest payee). `guessed`: the same amount and day as others it couldn’t tell apart by payee. `near`: the same day and payee but not the same amount (not paired). `local`: only yours. `remote`: only the bank’s.',
            ),
          local: previewLocal.nullable(),
          remote: previewRemote.nullable(),
        }),
      )
      .describe('Newest first.'),
  })
  .meta({ id: 'LinkPreview' })
  .describe('An account’s transactions next to a bank account’s, before switching it to sync from there.')
export type LinkPreview = z.output<typeof linkPreviewSchema>

export const switchResultSchema = z
  .object({
    matched: z.number().int(),
    added: z.number().int(),
    skipped: z.number().int(),
    removed: z.number().int(),
    kept: z.number().int().describe('Yours the bank doesn’t have, kept as they are (syncs leave them alone).'),
  })
  .meta({ id: 'SwitchResult' })
export type SwitchResult = z.output<typeof switchResultSchema>

export const bankConnectionSchema = z
  .object({
    id: z.string(),
    provider: z
      .enum(BANK_PROVIDERS)
      .describe('`simplefin`: one connection to SimpleFIN Bridge for all your banks. `plaid`: one connection per bank login. `wealthsimple`: one per Wealthsimple login.'),
    name: z.string(),
    status: z.enum(['ok', 'attention', 'error']).describe('`attention`: the provider reported a problem, e.g. a bank needs you to sign in again.'),
    errors: z.array(z.object({ code: z.string(), message: z.string(), remoteAccountId: z.string().optional() })),
    notice: z.string().nullable(),
    lastAttemptAt: timestamp.nullable(),
    lastSyncedAt: timestamp.nullable(),
    nextSyncAt: timestamp.nullable().describe('When the next automatic sync runs. Null when it has no accounts.'),
    requestsLast24h: z.number().int().describe('Requests in the last day. SimpleFIN expects about 24 a day at most; Plaid has no such limit.'),
    needsSignIn: z.boolean().describe('The bank wants you to sign in again (Plaid: reconnect in Plaid Link; Wealthsimple: POST /bank/wealthsimple/connections with `connectionId`).'),
    createdAt: timestamp,
    accounts: z.array(bankAccountSchema),
  })
  .meta({ id: 'BankConnection' })
export type BankConnection = z.output<typeof bankConnectionSchema>

export const wealthsimpleConnectResultSchema = z
  .object({
    otpRequired: z.boolean().describe('Wealthsimple wants a 2FA code: send the same request again with `otp`.'),
    connection: bankConnectionSchema.nullable(),
  })
  .meta({ id: 'WealthsimpleConnectResult' })
export type WealthsimpleConnectResult = z.output<typeof wealthsimpleConnectResultSchema>

export const plaidLinkTokenSchema = z
  .object({ linkToken: z.string(), expiration: timestamp })
  .meta({ id: 'PlaidLinkToken' })
  .describe('Opens Plaid Link in the browser (Plaid.create({ token })).')
export type PlaidLinkToken = z.output<typeof plaidLinkTokenSchema>

export const syncResultSchema = z
  .object({
    connectionId: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
    notice: z.string().nullable(),
    accounts: z.array(
      z.object({
        bankAccountId: z.string(),
        name: z.string(),
        ledger: z.string(),
        accountId: id,
        accountName: z.string(),
        added: z.number().int(),
        updated: z.number().int(),
        adopted: z.number().int().describe('Matched to transactions you had entered or imported.'),
        removed: z.number().int().describe('Pending transactions the bank no longer reports.'),
        error: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'SyncResult' })
export type SyncResult = z.output<typeof syncResultSchema>

// Errors -------------------------------------------------------------------

export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'internal',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const apiErrorSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string().describe('A sentence you can show to a person.'),
      issues: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .optional()
        .describe('For `validation_failed`: each field that was wrong.'),
    }),
  })
  .meta({ id: 'Error' })
export type ApiErrorBody = z.output<typeof apiErrorSchema>
