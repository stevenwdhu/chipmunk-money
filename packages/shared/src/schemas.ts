import { z } from 'zod'
import {
  ACCOUNT_TYPE_VALUES,
  AI_KINDS,
  BANK_PROVIDERS,
  CADENCE_VALUES,
  LINK_KINDS,
  COLUMN_WIDTH_RANGE,
  CUSTOM_COLORS_MAX,
  PLAID_ENVIRONMENTS,
  RECURRING_DETECTION,
  SIDEBAR_WIDTH,
  SYNC_INTERVALS,
  TRANSACTION_COLUMNS,
  type BankProviderKind,
  PAYEE_NAME_MATCHES,
  PAYEE_NAME_RULE_KINDS,
} from './constants'
import { DATE_FORMATS } from './csv'
import { isISODate, isValidTimeZone } from './dates'
import { FILTER_LIMITS, FILTER_SIDES, filterParam, reportSpecSchema } from './filters'

export const isoDate = z
  .string()
  .refine(isISODate, { message: 'Use a valid date (YYYY-MM-DD)' })
  .meta({ format: 'date', examples: ['2026-10-03'] })
export const monthKey = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Use a month like 2026-09')
  .meta({ examples: ['2026-10'] })
const minor = z.number().int().safe()
const id = z.number().int().positive()
const externalId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('Your own id for the transaction, e.g. from a bank export. Sending the same one twice for an account adds it only once.')
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #16a34a')
const name = (max = 80) => z.string().trim().min(1, 'Required').max(max)
const optionalText = z
  .string()
  .trim()
  .max(1000)
  .nullish()
  .transform((v) => (v ? v : null))

// Institutions & accounts -------------------------------------------------

export const institutionCreateSchema = z.object({ name: name() })
export type InstitutionCreate = z.input<typeof institutionCreateSchema>

export const institutionUpdateSchema = z.object({
  name: name().optional(),
  sort: z.number().int().optional(),
})
export type InstitutionUpdate = z.input<typeof institutionUpdateSchema>

export const institutionDeleteQuerySchema = z.object({
  moveTo: z.coerce.number().int().positive().optional().describe('Move its accounts to this institution first. Without it, only an institution with no accounts can be deleted.'),
})

/** Which institution an account is under: an existing one by id, or one by name (created if it's new). */
const institutionRef = {
  institutionId: id.optional().describe('An existing institution (see GET /institutions).'),
  institution: name().optional().describe('Or an institution by name: the one already called that, or a new one.'),
}

/** Switches an account to synced: which bank account feeds it, and from when. */
export const accountBankLinkSchema = z.object({
  bankAccountId: z.string().min(1),
  syncFrom: isoDate
    .nullish()
    .describe(
      'Don’t import transactions before this date. `null`: no limit, all the history the bank provides. Left out: no limit, except that the same bank account again keeps its date.',
    ),
})
export type AccountBankLink = z.input<typeof accountBankLinkSchema>

export const accountBankPreviewSchema = z.object({
  bankAccountId: z.string().min(1),
  from: isoDate.nullish().describe('Compare from this date. Default: the oldest of the bank account’s transactions kept from its syncs.'),
})
export type AccountBankPreview = z.input<typeof accountBankPreviewSchema>

export const accountBankSwitchSchema = z.object({
  bankAccountId: z.string().min(1),
  from: isoDate.describe('The start of what was compared (the preview’s `from`). Nothing before it is imported.'),
  version: z.string().min(1).describe('The preview’s `version`. When either side changed since (a sync), nothing is switched and you get a 409: preview again.'),
  pairs: z
    .array(
      z.object({
        transactionId: id,
        remoteId: z.string().min(1),
        keepAmount: z.boolean().default(false).describe('Keep your amount (one you corrected) instead of the bank’s. Syncs then leave it alone.'),
      }),
    )
    .max(20000)
    .describe('Your transactions and the bank’s that are the same one: yours takes the bank’s id, date and time.'),
  skip: z.array(z.string().min(1)).max(20000).default([]).describe('The bank’s transactions (by `remoteId`) not to bring in, now or later.'),
  remove: z.array(id).max(20000).default([]).describe('Your transactions to delete (they can be restored for 30 days). The others the bank doesn’t have stay.'),
})
export type AccountBankSwitch = z.input<typeof accountBankSwitchSchema>

export const accountCreateSchema = z.object({
  name: name(),
  type: z.enum(ACCOUNT_TYPE_VALUES),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'A three-letter currency code, like CAD')
    .toUpperCase()
    .default('CAD').describe('Ignored for a synced account, which takes the bank’s currency.'),
  openingBalanceMinor: minor.default(0),
  openingDate: isoDate.optional(),
  ...institutionRef,
  notes: optionalText,
  /** Sync it from a bank account (see GET /bank-accounts). Its opening balance is then set from the bank's balance. */
  bank: accountBankLinkSchema.optional(),
})
export type AccountCreate = z.input<typeof accountCreateSchema>

export const accountUpdateSchema = z.object({
  name: name().optional(),
  type: z.enum(ACCOUNT_TYPE_VALUES).optional(),
  openingBalanceMinor: minor.optional(),
  ...institutionRef,
  notes: optionalText.optional(),
  archived: z.boolean().optional(),
  sort: z.number().int().optional(),
})
export type AccountUpdate = z.input<typeof accountUpdateSchema>

export const balanceUpdateSchema = z.object({
  date: isoDate,
  balanceMinor: minor,
})
export type BalanceUpdate = z.input<typeof balanceUpdateSchema>

// Categories & tags ------------------------------------------------------

export const groupCreateSchema = z.object({
  name: name(40),
  color: color.optional().describe('Its categories show in this colour. Left out: a colour no other group has yet.'),
})
export const groupUpdateSchema = z.object({ name: name(40).optional(), color: color.optional(), sort: z.number().int().optional() })

export const categoryCreateSchema = z.object({
  name: name(40),
  groupId: id.nullable().default(null),
  isIncome: z.boolean().default(false),
  excludeFromTotals: z.boolean().default(false),
  labelIds: z.array(id).max(50).optional().describe('Labels to put on it.'),
})
export type CategoryCreate = z.input<typeof categoryCreateSchema>

export const categoryUpdateSchema = z.object({
  name: name(40).optional(),
  groupId: id.nullable().optional(),
  isIncome: z.boolean().optional(),
  excludeFromTotals: z.boolean().optional(),
  labelIds: z.array(id).max(50).optional().describe('Its labels, replacing the ones it has.'),
  sort: z.number().int().optional(),
})
export type CategoryUpdate = z.input<typeof categoryUpdateSchema>

/**
 * A category in one ledger. A ledger using the shared list only turns its categories on and off
 * (`enabled`, with `moveTo`); one with its own list edits them here (everything else).
 */
export const ledgerCategoryUpdateSchema = categoryUpdateSchema.extend({
  enabled: z
    .boolean()
    .optional()
    .describe('On: offered when you categorize in this ledger. Off: not. With the shared list, turning off one its transactions use needs `moveTo`.'),
  moveTo: id
    .nullable()
    .optional()
    .describe('Turning off a category transactions use (shared list): the category they move to, or null to leave them uncategorized.'),
  archived: z.boolean().optional().describe('Own list only: archived categories keep their transactions but aren’t offered.'),
})
export type LedgerCategoryUpdate = z.input<typeof ledgerCategoryUpdateSchema>

export const categorySharingSchema = z.object({
  shared: z
    .boolean()
    .describe(
      'True: the ledger uses the shared list (App settings); its categories are matched to it by name. False: it keeps a copy of the shared list as its own, to edit here.',
    ),
  resolve: z
    .array(
      z.object({
        category: id.describe('One of the ledger’s own categories the shared list doesn’t have by name (GET /categories/sharing lists them).'),
        action: z
          .enum(['match', 'add', 'move', 'uncategorize'])
          .describe('`match`: it is the shared category `to`. `add`: add it to the shared list. `move`: move its transactions to `to`. `uncategorize`: leave its transactions uncategorized.'),
        to: id.optional().describe('For `match` and `move`: a category in the shared list.'),
      }),
    )
    .optional()
    .describe('Joining: what happens to each category the shared list doesn’t have by name. Ones left out are added to the shared list.'),
})
export type CategorySharing = z.input<typeof categorySharingSchema>

export const categoryMergeSchema = z.object({ into: id.describe('The category that takes over its transactions.') })
export type CategoryMerge = z.input<typeof categoryMergeSchema>

export const labelCreateSchema = z.object({ name: name(40), color: color.optional().describe('Left out: a colour no other label has yet.') })
export type LabelCreate = z.input<typeof labelCreateSchema>
export const labelUpdateSchema = z.object({ name: name(40).optional(), color: color.optional(), sort: z.number().int().optional() })
export type LabelUpdate = z.input<typeof labelUpdateSchema>
export const labelCategoriesSchema = z
  .object({ add: z.array(id).max(500).default([]), remove: z.array(id).max(500).default([]) })
  .describe('Categories to put the label on, and to take it off.')
export type LabelCategories = z.input<typeof labelCategoriesSchema>

export const tagCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((s) => s.replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')),
  color: color.nullish(),
})
export const tagUpdateSchema = tagCreateSchema.partial()

// Transactions -----------------------------------------------------------

const tagNames = z.array(z.string().trim().min(1).max(40)).max(20)
/** Local time on the transaction's day, like 2026-09-22T14:30 (seconds optional). */
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'A local date and time, like 2026-09-22T14:30')
  .transform((v) => (v.length === 16 ? `${v}:00` : v))

export const transactionCreateSchema = z.object({
  accountId: id,
  date: isoDate,
  datetime: localDateTime.nullish().describe('When it happened, when known: local time on `date`, like 2026-09-22T14:30. Orders the day’s transactions.'),
  amountMinor: minor,
  payee: name(200),
  name: z.string().trim().max(200).nullish().describe('What it is, like “Suitcase”. A recurring item’s payments go by the item’s name instead.'),
  /** Omit (or null) to let the app categorize from history / AI. */
  categoryId: id.nullish().describe('Leave out to let the app suggest one from your history (or AI).'),
  notes: optionalText,
  tags: tagNames.default([]),
  status: z.enum(['cleared', 'pending']).default('cleared'),
  /** Creates a linked transfer into this account (amount mirrored). */
  transferAccountId: id.nullish().describe('Makes this a transfer: a mirrored transaction is added to this account.'),
  externalId: externalId.nullish(),
})
export type TransactionCreate = z.input<typeof transactionCreateSchema>

export const transactionUpdateSchema = z.object({
  accountId: id.optional(),
  date: isoDate.optional(),
  datetime: localDateTime.nullable().optional().describe('When it happened: local time on its date (null: the day only). Moving the date keeps the time.'),
  amountMinor: minor.optional(),
  payee: name(200)
    .optional()
    .describe('Only for one you entered: a synced or imported one’s payee is what the bank or file sent. Give the payee an alias instead (PUT /payees/aliases).'),
  name: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .describe('What it is (null or empty: none). For a recurring item’s payment, it renames the item, so all its payments share it. A refund of one purchase has that purchase’s name, so it can’t be changed.'),
  categoryId: id.nullable().optional(),
  notes: optionalText.optional(),
  tags: tagNames.optional(),
  status: z.enum(['cleared', 'pending']).optional(),
  recurringItemId: id.nullable().optional(),
  transferPairId: z.null().optional().describe('null: it isn’t a transfer. Unlinks both sides, which keep their categories as yours.'),
  corrected: z
    .boolean()
    .optional()
    .describe('false: let bank syncs update its amount and date again. true: keep them as they are. Changing the amount or date of a synced transaction marks it on its own.'),
})
export type TransactionUpdate = z.input<typeof transactionUpdateSchema>

/** In any of these categories, as a query parameter: ids, and `none` for uncategorized, comma-separated. */
const categoryIdsParam = z
  .union([z.number().int().positive(), z.string().regex(/^(none|\d+)(,(none|\d+))*$/, 'Category ids or `none`, comma-separated')])
  .transform((v) => String(v).split(',').map((c) => (c === 'none' ? ('none' as const) : Number(c))))

export const linkCandidatesQuerySchema = z.object({
  kind: z.enum(LINK_KINDS).default('refund'),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe(
      'Search payees, names, notes and amounts, at any date. Left out: for a refund, purchases from the 6 months before it; for a payback, bills from 60 days before it to 7 days after (from a bill: money in from 7 days before it to 60 days after).',
    ),
  categoryId: categoryIdsParam
    .optional()
    .describe('Only ones in any of these categories (ids, and `none` for uncategorized, comma-separated), at any date, like a search.'),
})

export const transactionLinksSetSchema = z.object({
  links: z
    .array(
      z.object({
        transactionId: id.describe('The other side: a purchase or bill for money in, money in for a purchase or bill.'),
        amountMinor: z.number().int().positive().describe('How much of the money in goes to that purchase or bill.'),
        kind: z.enum(LINK_KINDS),
      }),
    )
    .max(100)
    .describe('All of its links, replacing the ones it has (an empty list unlinks it). Together they can’t be more than its amount, nor more than what’s left on each other side.'),
})
export type TransactionLinksSet = z.input<typeof transactionLinksSetSchema>

export const transactionLinksSetTogetherSchema = z.object({
  sets: z
    .array(z.object({ id: id.describe('Money in.'), links: transactionLinksSetSchema.shape.links }))
    .min(1)
    .max(50)
    .describe('Each money in with all of its links, replacing the ones it has.'),
})
export type TransactionLinksSetTogether = z.input<typeof transactionLinksSetTogetherSchema>

export const transactionMatchSchema = z.object({
  since: isoDate.optional().describe('Only transactions from this date on. Left out: all of them.'),
})

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')

export const transactionQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountId: z.coerce.number().int().positive().optional(),
  categoryId: categoryIdsParam.optional().describe('In any of these categories: ids, and `none` for uncategorized, comma-separated (`12,none`).'),
  tagId: z.coerce.number().int().positive().optional(),
  recurringItemId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
  needsReview: boolish.optional(),
  labelId: z
    .union([z.literal('none'), z.coerce.number().int().positive()])
    .optional()
    .describe('Transactions in categories with this label; `none` for spending in categories without a label (or uncategorized).'),
  filter: filterParam
    .optional()
    .describe('A report’s filter (ReportFilter, as JSON): transactions with something it counts, a refund or payback judged by its purchase. Transfers and what’s left out of totals stay listed, as without one.'),
  filteredOut: boolish.optional().describe('Instead, the transactions `filter` filters out of totals.'),
  side: z
    .enum(FILTER_SIDES)
    .optional()
    .describe('Only what reports count as spending (purchases and bills, with their refunds and paybacks) or as income: no transfers, nor what’s left out of totals.'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
})
export type TransactionQuery = z.input<typeof transactionQuerySchema>

export const payeeSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional().describe('Words in the payee’s name, as the name rules call it or as the bank sent it.'),
  keys: z
    .string()
    .max(FILTER_LIMITS.json)
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Use payee keys as a JSON array' })
        return z.NEVER
      }
    })
    .pipe(z.array(z.string()).max(FILTER_LIMITS.ids))
    .optional()
    .describe('Just these payee keys, as a JSON array (to name the ones a filter has).'),
  limit: z.coerce.number().int().min(1).max(200).default(20),
})

export const bulkUpdateSchema = z.object({
  ids: z.array(id).min(1).max(1000),
  categoryId: id.nullable().optional(),
  addTags: tagNames.optional(),
  removeTags: tagNames.optional(),
  delete: z.boolean().optional(),
  acceptSuggestions: z.boolean().optional(),
})
export type BulkUpdate = z.input<typeof bulkUpdateSchema>

export const recategorizeSchema = z.object({
  ids: z.array(id).min(1).max(1000).describe('Transactions to ask AI about again.'),
})

export const suggestCategorySchema = z.object({
  payee: z.string().trim().min(1).max(200),
  amountMinor: minor.optional(),
  accountId: id.optional(),
  date: isoDate.optional(),
  useAi: z.boolean().default(true),
})
export type SuggestCategoryInput = z.input<typeof suggestCategorySchema>

// Payees -----------------------------------------------------------------

export const PAYEE_CHOICES = ['always', 'ask', 'review'] as const
export type PayeeChoiceMode = (typeof PAYEE_CHOICES)[number]

const payeeKey = z.string().trim().min(1).max(200).describe('The payee as the app matches it (a transaction’s `payeeKey`).')
const payeeChoiceMode = z
  .enum(PAYEE_CHOICES)
  .describe(
    '`always`: always set this category, without review (it’s set now on the payee’s transactions waiting for review or uncategorized, too). `ask`: suggest one each time to review. `review`: never set one on its own, even when the bank and AI agree.',
  )

export const payeeChoiceUpdateSchema = z
  .object({
    payeeKey: payeeKey.optional(),
    payee: z.string().trim().min(1).max(200).optional().describe('Or the payee as a transaction has it, made into its key by the payee name rules.'),
    mode: payeeChoiceMode,
    categoryId: id.optional().describe('For `always`: the category.'),
  })
  .refine((v) => v.payeeKey || v.payee, { message: 'Say which payee: `payeeKey` or `payee`', path: ['payeeKey'] })
  .refine((v) => v.mode !== 'always' || v.categoryId !== undefined, { message: 'Choose the category to always set', path: ['categoryId'] })
export type PayeeChoiceUpdate = z.input<typeof payeeChoiceUpdateSchema>

const payeeNameRuleFields = {
  kind: z.enum(PAYEE_NAME_RULE_KINDS).describe('`same`: names that are one payee. `regex`: a pattern on the payee as sent.'),
  match: z.enum(PAYEE_NAME_MATCHES).nullable().default(null).describe('For `same`: a payee fits a pattern when it `is` it, `starts` with it or `contains` it.'),
  patterns: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(50)
    .describe('`same`: the names that are this payee. `regex`: one pattern, tried without regard to case.'),
  name: z.string().trim().max(120).nullable().default(null).describe('`same`: the payee’s name. `regex`: what it becomes ($1: what the first group caught).'),
  enabled: z.boolean().default(true),
}
export const payeeNameRuleCreateSchema = z.object(payeeNameRuleFields)
export type PayeeNameRuleCreate = z.input<typeof payeeNameRuleCreateSchema>
export const payeeNameRuleUpdateSchema = z.object(payeeNameRuleFields).partial()
export type PayeeNameRuleUpdate = z.input<typeof payeeNameRuleUpdateSchema>

export const payeeNameRuleOrderSchema = z.object({ ids: z.array(id).max(500).describe('All your rules, in the order they apply.') })

export const payeeTidyUpdateSchema = z.object({
  enabled: z.boolean().describe('On: every payee not tidied yet is, in the background, and new ones as they come. Off: payees are called what the bank sent again.'),
})
export const payeeTidyPreviewQuerySchema = z.object({
  page: z.number().int().min(0).default(0).describe('Which batch of 20, from 0: the messiest and most used payees first. One asked about before isn’t asked again.'),
})
export const payeeTidyAgainSchema = z.object({ originals: z.array(z.string().min(1).max(200)).min(1).max(1000).describe('Payees as sent, to tidy again, together.') })

export const payeeNamePreviewQuerySchema = z.object({
  rule: z
    .object({ id: id.optional().describe('The rule it changes. Left out: a new one.'), ...payeeNameRuleFields })
    .optional()
    .describe('A rule as it would be saved.'),
  remove: id.optional().describe('Or a rule to remove.'),
})
export type PayeeNamePreviewQuery = z.input<typeof payeeNamePreviewQuerySchema>

export const payeeRenameSchema = z.object({
  payee: z.string().trim().min(1).max(200).describe('The payee as a transaction has it (its `payee`).'),
  name: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .describe(
      'What to call it, and every payee named the same way: a rule for it is made or changed. A name another payee has makes them one payee. Null or empty: the name the rules give it otherwise.',
    ),
})
export type PayeeRename = z.input<typeof payeeRenameSchema>

export const payeeWordingsNameSchema = z.object({
  payees: z.array(z.string().trim().min(1).max(200)).min(1).max(1000).describe('Payees as the bank or file sent them.'),
  name: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .describe('What they’re called, by one rule of yours: one with this name already, or a new one. Null or empty: off your rules, they go by what AI tidying called them.'),
})
export type PayeeWordingsName = z.input<typeof payeeWordingsNameSchema>

export const payeeChoiceQuerySchema = z.object({
  payeeKey,
  categoryId: z.coerce.number().int().positive().optional().describe('How many transactions `always` this category would set.'),
})
export type PayeeChoiceQuery = z.input<typeof payeeChoiceQuerySchema>

// Reports ----------------------------------------------------------------

const reportName = name(60).describe('Unique in the ledger, whatever its case.')

export const customReportCreateSchema = z.object({ name: reportName, spec: reportSpecSchema })
export type CustomReportCreate = z.input<typeof customReportCreateSchema>

export const customReportUpdateSchema = z.object({
  name: reportName.optional(),
  spec: reportSpecSchema.optional().describe('Replaces the saved one.'),
})
export type CustomReportUpdate = z.input<typeof customReportUpdateSchema>

export const customReportOrderSchema = z.object({ ids: z.array(id).min(1).max(50).describe('Report ids in the order you want them. Ones left out follow, as they were.') })
export type CustomReportOrder = z.input<typeof customReportOrderSchema>

// Recurring --------------------------------------------------------------

const totalPayments = z
  .number()
  .int()
  .min(2)
  .max(600)
  .nullable()
  .describe('An instalment plan: how many payments it has. It ends after the last one. Null: no end (a bill, subscription or income).')
const paidPayments = z
  .number()
  .int()
  .min(0)
  .max(600)
  .describe('An instalment plan: how many are paid so far, counting ones from before your history. The app counts the ones it links itself.')

const secondDay = z
  .number()
  .int()
  .min(1)
  .max(31)
  .nullable()
  .describe('Semi-monthly: the other day of the month it’s due, 31 for the last day. Left out: the 1st goes with the 15th, the 15th with the last day, otherwise 15 days apart.')

const recurringName = name(120).nullable().describe('What it is, like “Dyson vacuum”, shown in place of the payee. Null: it goes by its payee.')

export const recurringCreateSchema = z.object({
  payee: z.string().trim().min(1, 'Enter the payee').max(200).describe('The payee as it appears on payments, like “Klarna”. Payments are matched by it.'),
  name: recurringName.default(null),
  categoryId: id.nullable().default(null),
  accountId: id.nullable().default(null),
  expectedAmountMinor: minor,
  amountTolerancePct: z.number().min(0).max(100).default(10),
  cadence: z.enum(CADENCE_VALUES),
  anchorDate: isoDate,
  totalPayments: totalPayments.default(null),
  paidPayments: paidPayments.optional(),
  secondDay: secondDay.optional(),
})
export type RecurringCreate = z.input<typeof recurringCreateSchema>

export const recurringUpdateSchema = z.object({
  name: recurringName.optional(),
  payee: z.string().trim().min(1).max(200).optional().describe('The payee as shown. Payments stay matched by the one it started with.'),
  categoryId: id.nullable().optional(),
  accountId: id.nullable().optional(),
  expectedAmountMinor: minor.optional(),
  amountTolerancePct: z.number().min(0).max(100).optional(),
  cadence: z.enum(CADENCE_VALUES).optional(),
  nextDueDate: isoDate.optional(),
  status: z.enum(['suggested', 'active', 'dismissed', 'ended']).optional(),
  totalPayments: totalPayments.optional(),
  paidPayments: paidPayments.optional(),
  secondDay: secondDay.optional(),
  otherPayees: z.array(z.string().trim().min(1).max(200)).max(20).optional().describe('More payees its payments come from, besides its own. Replaces the list.'),
})
export type RecurringUpdate = z.input<typeof recurringUpdateSchema>

/** A payment from a similar payee: link it to a recurring item, or say it isn't the item's. */
export const recurringPaymentSchema = z.object({ transactionId: id })

// Settings ---------------------------------------------------------------

export const aiProviderInputSchema = z
  .object({
    kind: z.enum(AI_KINDS),
    model: z.string().trim().min(1).max(120),
    baseUrl: z
      .string()
      .trim()
      .url()
      .nullish()
      .or(z.literal('').transform(() => null))
      .describe('The server’s URL: required for `openai-compatible`, optional for `local` (default http://localhost:11434/v1). The other providers have fixed URLs.'),
    /** undefined keeps the stored key, null or '' clears it. */
    apiKey: z.string().trim().max(400).nullish(),
  })
  .refine((p) => p.kind !== 'openai-compatible' || !!p.baseUrl, { message: 'Enter the server’s URL, ending in /v1', path: ['baseUrl'] })
export type AiProviderInput = z.input<typeof aiProviderInputSchema>

function syncHours(provider: BankProviderKind) {
  const allowed = SYNC_INTERVALS[provider]
  return z.number().int().refine((h) => allowed.includes(h), { message: `Choose ${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)} hours` })
}

export const settingsUpdateSchema = z.object({
  /** null means "use the system default". */
  timezone: z
    .string()
    .refine(isValidTimeZone, { message: 'Unknown time zone' })
    .nullable()
    .optional(),
  firstDayOfWeek: z.union([z.literal(0), z.literal(1)]).optional(),
  transactionColumns: z
    .array(z.enum(TRANSACTION_COLUMNS))
    .max(TRANSACTION_COLUMNS.length)
    .refine((cols) => new Set(cols).size === cols.length, { message: 'List each column once' })
    .nullable()
    .optional()
    .describe('The transactions table’s column order. Columns left out go at the end; null restores the default.'),
  transactionColumnWidths: z
    .partialRecord(z.enum(TRANSACTION_COLUMNS), z.number().int().min(COLUMN_WIDTH_RANGE.min).max(COLUMN_WIDTH_RANGE.max))
    .nullable()
    .optional()
    .describe('Widths (px) of the transactions table’s columns. Columns left out use their default width; null restores all of them.'),
  sidebarWidth: z
    .number()
    .int()
    .min(SIDEBAR_WIDTH.min)
    .max(SIDEBAR_WIDTH.max)
    .nullable()
    .optional()
    .describe('The main sidebar’s width (px); null restores the default.'),
  customColors: z
    .array(color)
    .max(CUSTOM_COLORS_MAX)
    .nullable()
    .optional()
    .describe('Colours you picked outside the palette, newest first, offered again in every colour picker. null clears them.'),
  ai: z
    .object({
      primary: aiProviderInputSchema.nullable().optional(),
      fallback: aiProviderInputSchema.nullable().optional(),
    })
    .optional(),
  plaid: z
    .object({
      clientId: z.string().trim().min(1, 'Enter your Plaid client ID').max(100),
      secret: z.string().trim().min(1).max(200).nullable().optional().describe('Leave out to keep the saved secret.'),
      environment: z.enum(PLAID_ENVIRONMENTS),
    })
    .nullable()
    .optional()
    .describe('Your Plaid API keys (dashboard.plaid.com → Developers → Keys), stored encrypted. null removes them.'),
  bankSyncHours: z
    .object({ simplefin: syncHours('simplefin'), plaid: syncHours('plaid'), wealthsimple: syncHours('wealthsimple') })
    .partial()
    .optional()
    .describe('How often bank sync runs, in hours, for each service. SimpleFIN: 2, 3, 4, 6, 12 or 24 (it allows about 24 requests a day). Plaid: 1, 2, 3, 4, 6, 12 or 24.'),
  recurringDetection: z
    .object({
      priceVariationPct: z.number().min(RECURRING_DETECTION.priceVariationPct.min).max(RECURRING_DETECTION.priceVariationPct.max),
      dateVariationDays: z.number().int().min(RECURRING_DETECTION.dateVariationDays.min).max(RECURRING_DETECTION.dateVariationDays.max),
    })
    .partial()
    .optional()
    .describe('Finding recurring payments: how much a payment’s amount (% of the latest, default 5) and date (± days around when it’s due, plus weekends; default 1) may vary.'),
})
export type SettingsUpdate = z.input<typeof settingsUpdateSchema>

export const aiTestSchema = z.object({ slot: z.enum(['primary', 'fallback']) })

export const chatgptFinishSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe('The address the browser ended on after you approved (http://127.0.0.1:…/auth/callback?code=…), when it couldn’t reach this server on its own.'),
})

// Import -----------------------------------------------------------------

export const columnMappingSchema = z.object({
  hasHeader: z.boolean(),
  date: z.number().int().min(0),
  dateFormat: z.enum(DATE_FORMATS),
  payee: z.number().int().min(0),
  amount: z.number().int().min(0).nullish(),
  debit: z.number().int().min(0).nullish(),
  credit: z.number().int().min(0).nullish(),
  notes: z.number().int().min(0).nullish(),
  category: z.number().int().min(0).nullish(),
  negate: z.boolean().optional(),
})

const importRow = z.object({
  line: z.number().int().describe('Row number in the file, for messages.'),
  date: isoDate,
  payee: name(200),
  amountMinor: minor,
  notes: optionalText,
  category: z
    .string()
    .trim()
    .max(120)
    .nullish()
    .describe('The category the bank or another app gave it: kept as its bank category, which AI goes by (like Plaid’s), not set as its category.'),
  externalId: externalId.nullish(),
})

export const importPreviewSchema = z.object({
  accountId: id,
  rows: z.array(importRow).min(1).max(20000),
})
export type ImportPreviewInput = z.input<typeof importPreviewSchema>

export const importCommitSchema = z.object({
  accountId: id,
  fileName: z.string().max(200).optional(),
  mapping: columnMappingSchema.optional(),
  rows: z
    .array(
      importRow.extend({
        categoryId: id.nullish(),
        tags: tagNames.optional(),
      }),
    )
    .min(1)
    .max(20000),
})
export type ImportCommitInput = z.input<typeof importCommitSchema>

// Ledgers ------------------------------------------------------------------

export const ledgerCreateSchema = z.object({
  name: name(40),
  color: color.optional(),
  icon: z.string().trim().max(40).nullish(),
  /** "empty" marks the ledger as set up; "demo" loads sample data. Omit to show the ledger's welcome screen. */
  start: z.enum(['empty', 'demo']).optional(),
})
export type LedgerCreate = z.input<typeof ledgerCreateSchema>

export const ledgerUpdateSchema = z.object({
  name: name(40).optional(),
  color: color.optional(),
  icon: z.string().trim().max(40).nullish(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
  /** Make this the ledger the app opens by default. */
  isDefault: z.literal(true).optional(),
})
export type LedgerUpdate = z.input<typeof ledgerUpdateSchema>

/** Deleting a ledger requires repeating its name. */
export const ledgerDeleteSchema = z.object({ confirm: z.string() })

/** A new order for a list: every id, first to last. */
export const reorderSchema = z.object({ ids: z.array(id).min(1).max(1000) })
export type Reorder = z.input<typeof reorderSchema>

// API keys -----------------------------------------------------------------

export const apiKeyCreateSchema = z.object({
  name: name(60),
  /** Lower scopes are included: write implies read, admin implies both. */
  scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
  /** Ledger ids or slugs. Null or omitted means every ledger. */
  ledgers: z.array(z.string().min(1)).min(1).nullish(),
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
})
export type ApiKeyCreate = z.input<typeof apiKeyCreateSchema>

// Activity -----------------------------------------------------------------

export const activityQuerySchema = z.object({
  actor: z.string().max(80).optional(),
  entity: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
})
export type ActivityQuery = z.input<typeof activityQuerySchema>

// Bank sync ------------------------------------------------------------------

export const bankConnectionCreateSchema = z.object({
  provider: z.literal('simplefin').default('simplefin'),
  /** The setup token from SimpleFIN Bridge (a long base64 string). It can only be used once. */
  setupToken: z.string().trim().min(16, 'Paste the whole setup token').max(4000),
  name: name(60).optional(),
})
export type BankConnectionCreate = z.input<typeof bankConnectionCreateSchema>

export const bankConnectionUpdateSchema = z.object({ name: name(60) })

export const plaidLinkTokenRequestSchema = z.object({
  connectionId: z.string().optional().describe('Reconnect this Plaid connection (when the bank wants you to sign in again) instead of adding a bank.'),
})
export type PlaidLinkTokenRequest = z.input<typeof plaidLinkTokenRequestSchema>

export const plaidConnectSchema = z.object({
  publicToken: z.string().trim().min(10).max(500).describe('From Plaid Link’s onSuccess.'),
  name: name(60).optional(),
})
export type PlaidConnect = z.input<typeof plaidConnectSchema>

export const wealthsimpleConnectSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(500).describe('Used once to sign in, never stored.'),
  otp: z
    .string()
    .trim()
    .max(20)
    .nullish()
    .describe('The 2FA code. Leave it out at first: if Wealthsimple wants one, the answer says so (`otpRequired`), and it sends the code (or your authenticator app has it).'),
  connectionId: z.string().optional().describe('Sign in again to this Wealthsimple connection (when its session ended) instead of adding one.'),
  name: name(60).optional(),
})
export type WealthsimpleConnect = z.input<typeof wealthsimpleConnectSchema>


