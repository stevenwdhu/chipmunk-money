/**
 * Every account's balance is its latest recorded balance (or its starting balance) plus the
 * transactions after it, and any account can have both.
 *
 * `revalued`: its value also moves on its own (markets, appraisals, interest), so recorded balances
 * carry it: a synced one records the bank's each sync, and its transactions don't add up to a running
 * balance. The others' transactions add up to their balance (a synced one's starting balance takes up
 * any difference from the bank's).
 *
 * `paidMonthly`: paid off every month, so its own chart shows each month's spending rather than a
 * running balance. (Net worth still counts its balance: what's owed on it.)
 */
export const ACCOUNT_TYPES = [
  { value: 'chequing', label: 'Chequing', liability: false, revalued: false, paidMonthly: false },
  { value: 'savings', label: 'Savings', liability: false, revalued: false, paidMonthly: false },
  { value: 'credit', label: 'Credit card', liability: true, revalued: false, paidMonthly: true },
  { value: 'cash', label: 'Cash', liability: false, revalued: false, paidMonthly: false },
  { value: 'investment', label: 'Investment', liability: false, revalued: true, paidMonthly: false },
  { value: 'loan', label: 'Loan / mortgage', liability: true, revalued: true, paidMonthly: false },
  { value: 'property', label: 'Property / other asset', liability: false, revalued: true, paidMonthly: false },
  { value: 'other', label: 'Other', liability: false, revalued: false, paidMonthly: false },
] as const

export type AccountType = (typeof ACCOUNT_TYPES)[number]['value']
export const ACCOUNT_TYPE_VALUES = ACCOUNT_TYPES.map((t) => t.value) as [AccountType, ...AccountType[]]

export function accountTypeInfo(type: AccountType) {
  return ACCOUNT_TYPES.find((t) => t.value === type) ?? ACCOUNT_TYPES[ACCOUNT_TYPES.length - 1]!
}

/**
 * A balance the way the bank's statement shows it: what you have in an account, or what you owe on a
 * credit card or loan. Balances are stored signed (owing $50 is -$50), so a debt's is flipped; a
 * negative one then means the card is in credit.
 */
export function statementBalance(balanceMinor: number, type: AccountType): number {
  // 0 - x, not -x: no "-$0.00".
  return accountTypeInfo(type).liability ? 0 - balanceMinor : balanceMinor
}

/** Your payee name rules: names that are one payee, or a regex (see payeeNamer). */
export const PAYEE_NAME_RULE_KINDS = ['same', 'regex'] as const
/** How a payee fits a `same` rule's pattern. */
export const PAYEE_NAME_MATCHES = ['is', 'starts', 'contains'] as const

/** Columns of the transactions table, in their default order. */
/** `balance` (the running balance) shows only for one account's transactions, with no other filter. */
export const TRANSACTION_COLUMNS = ['date', 'payee', 'notes', 'category', 'account', 'amount', 'balance'] as const
export type TransactionColumn = (typeof TRANSACTION_COLUMNS)[number]

/** Limits for a column width you set by dragging (px). */
export const COLUMN_WIDTH_RANGE = { min: 64, max: 640 } as const

/**
 * Bank-sync services, which can be used side by side (each account syncs from one): SimpleFIN Bridge
 * (a paid bridge you paste a token from), Plaid (connect each bank in Plaid's own window; free for up
 * to 10 banks on its Trial plan) and Wealthsimple (its own web app's private API, signed in to with
 * your Wealthsimple login).
 */
export const BANK_PROVIDERS = ['simplefin', 'plaid', 'wealthsimple'] as const
export type BankProviderKind = (typeof BANK_PROVIDERS)[number]
export const BANK_PROVIDER_LABELS: Record<BankProviderKind, string> = { simplefin: 'SimpleFIN Bridge', plaid: 'Plaid', wealthsimple: 'Wealthsimple' }
/** Plaid's Sandbox has test banks (user_good / pass_good); Production has your real ones. */
export const PLAID_ENVIRONMENTS = ['sandbox', 'production'] as const
export type PlaidEnvironment = (typeof PLAID_ENVIRONMENTS)[number]
/**
 * How often bank sync can run, in hours, for each service. SimpleFIN allows about 24 requests a day,
 * so it stops at every 2 hours (12 a day, leaving room for Sync now). Plaid itself checks banks 1–4
 * times a day, so asking it more than hourly wouldn't bring anything sooner.
 */
export const SYNC_INTERVALS: Record<BankProviderKind, readonly number[]> = {
  simplefin: [2, 3, 4, 6, 12, 24],
  plaid: [1, 2, 3, 4, 6, 12, 24],
  wealthsimple: [1, 2, 3, 4, 6, 12, 24],
}
/**
 * Finding recurring payments: how much a payment may differ from the latest one in amount (%) and
 * in date (± days around when it's due, stretched over a weekend to the business day either side).
 */
export const RECURRING_DETECTION = {
  priceVariationPct: { default: 5, min: 0, max: 50 },
  dateVariationDays: { default: 1, min: 0, max: 7 },
} as const

/** Payments in a buy-now-pay-later "Pay in 4" plan, made every 2 weeks. */
export const PAY_IN_4 = 4

export const DEFAULT_SYNC_HOURS: Record<BankProviderKind, number> = { simplefin: 6, plaid: 1, wealthsimple: 2 }
/** "every hour", "every 6 hours", "once a day". */
export function syncIntervalLabel(hours: number): string {
  return hours === 1 ? 'every hour' : hours === 24 ? 'once a day' : `every ${hours} hours`
}
/** How many custom colours the colour picker remembers. */
export const CUSTOM_COLORS_MAX = 16

/** The main sidebar's width (px): its default and the limits for dragging its edge. */
export const SIDEBAR_WIDTH = { default: 240, min: 200, max: 400 } as const

/** A saved column order (unknown columns dropped), with columns added since it was saved after the one before them by default. */
export function normalizeColumns(saved: readonly string[] | null | undefined): TransactionColumn[] {
  const order = [...new Set((saved ?? []).filter((c): c is TransactionColumn => (TRANSACTION_COLUMNS as readonly string[]).includes(c)))]
  TRANSACTION_COLUMNS.forEach((c, i) => {
    if (order.includes(c)) return
    const after = order.indexOf(TRANSACTION_COLUMNS[i - 1]!)
    order.splice(after + 1, 0, c)
  })
  return order
}

export interface AiProviderInfo {
  kind: string
  label: string
  group: 'hosted' | 'local' | 'custom'
  /**
   * Claude has its own API, and signing in with ChatGPT uses OpenAI's Responses API on your plan.
   * Every other provider speaks the OpenAI chat API.
   */
  protocol: 'anthropic' | 'openai' | 'chatgpt'
  /** Fixed for every provider but "OpenAI-compatible", where you give the URL. */
  baseUrl: string | null
  apiKey: 'required' | 'optional' | 'none'
  defaultModel: string
  modelExample: string
}

/** AI providers for categorization. Only "OpenAI-compatible" takes a server URL of your own. */
export const AI_PROVIDERS = [
  { kind: 'anthropic', label: 'Claude (Anthropic)', group: 'hosted', protocol: 'anthropic', baseUrl: null, apiKey: 'required', defaultModel: 'claude-opus-5-5', modelExample: 'claude-opus-5-5, claude-haiku-4-5' },
  { kind: 'openai', label: 'OpenAI', group: 'hosted', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'required', defaultModel: '', modelExample: 'gpt-5-mini' },
  { kind: 'chatgpt', label: 'OpenAI (sign in with ChatGPT)', group: 'hosted', protocol: 'chatgpt', baseUrl: 'https://api.openai.com/v1', apiKey: 'none', defaultModel: '', modelExample: 'a model your ChatGPT plan offers' },
  { kind: 'openrouter', label: 'OpenRouter', group: 'hosted', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'required', defaultModel: '', modelExample: 'openai/gpt-5-mini' },
  { kind: 'gemini', label: 'Google Gemini', group: 'hosted', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey: 'required', defaultModel: '', modelExample: 'gemini-2.5-flash' },
  { kind: 'mistral', label: 'Mistral', group: 'hosted', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'required', defaultModel: '', modelExample: 'mistral-small-latest' },
  { kind: 'groq', label: 'Groq', group: 'hosted', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'required', defaultModel: '', modelExample: 'llama-3.3-70b-versatile' },
  { kind: 'deepseek', label: 'DeepSeek', group: 'hosted', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'required', defaultModel: '', modelExample: 'deepseek-chat' },
  { kind: 'xai', label: 'xAI (Grok)', group: 'hosted', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', apiKey: 'required', defaultModel: '', modelExample: 'grok-4' },
  { kind: 'local', label: 'Local LLM (Ollama)', group: 'local', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: 'none', defaultModel: '', modelExample: 'llama3.2, qwen2.5' },
  { kind: 'openai-compatible', label: 'OpenAI-compatible (custom URL)', group: 'custom', protocol: 'openai', baseUrl: null, apiKey: 'optional', defaultModel: '', modelExample: 'the model name your server expects' },
] as const satisfies readonly AiProviderInfo[]

export type AiKind = (typeof AI_PROVIDERS)[number]['kind']
export const AI_KINDS = AI_PROVIDERS.map((p) => p.kind) as [AiKind, ...AiKind[]]

export function aiProviderInfo(kind: AiKind): AiProviderInfo {
  return AI_PROVIDERS.find((p) => p.kind === kind) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1]!
}

export const CADENCES = [
  { value: 'weekly', label: 'Weekly', days: 7, tolerance: 1 },
  { value: 'biweekly', label: 'Bi-weekly', days: 14, tolerance: 2 },
  { value: 'semimonthly', label: 'Semi-monthly', days: 15.22, tolerance: 2 },
  { value: 'monthly', label: 'Monthly', days: 30.44, tolerance: 4 },
  { value: 'quarterly', label: 'Quarterly', days: 91.3, tolerance: 8 },
  { value: 'yearly', label: 'Yearly', days: 365.25, tolerance: 12 },
] as const
export type Cadence = (typeof CADENCES)[number]['value']

/**
 * Semi-monthly's other day of the month for one payday, when you don't say: the 1st goes with the
 * 15th, the 15th with the last day (31), and a day at the month's end with the 15th; otherwise 15
 * days apart.
 */
export function semiMonthlyPartner(day: number): number {
  if (day === 1) return 15
  if (day === 15) return 31
  if (day >= 28) return 15
  return day < 15 ? day + 15 : day - 15
}
export const CADENCE_VALUES = CADENCES.map((c) => c.value) as [Cadence, ...Cadence[]]

/**
 * `linked`: money in linked in full to purchases or bills it pays back (a refund, a payback), which
 * takes the one's category (none of its own for several); `rule`: a credit card payment or a transfer
 * the app matched.
 */
export const CATEGORY_SOURCES = ['user', 'history', 'ai', 'recurring', 'import', 'linked', 'rule'] as const
export type CategorySource = (typeof CATEGORY_SOURCES)[number]

/** How money in pays back money out: `refund`, from the merchant; `payback`, someone's share of a bill you paid. */
export const LINK_KINDS = ['refund', 'payback'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const CATEGORY_COLORS = [
  '#6366f1', '#16a34a', '#f59e0b', '#ef4444', '#0ea5e9', '#a855f7', '#14b8a6', '#ec4899',
  '#84cc16', '#f97316', '#64748b', '#06b6d4', '#8b5cf6', '#22c55e', '#e11d48', '#78716c',
]

/** Labels seeded with the default categories: a second way to sort spending, across the groups. */
export const DEFAULT_LABELS = [
  { name: 'Needs', color: '#16a34a' },
  { name: 'Wants', color: '#0ea5e9' },
] as const

/**
 * Default categories seeded on first run, for a household: groups say what the money was for (and
 * have the colour their categories show in), and the Needs and Wants labels sort spending across them. "Transfer" and "Credit card payment" are
 * what transfers between your accounts are filed under, so keep those names.
 */
export const DEFAULT_CATEGORY_GROUPS: Array<{
  name: string
  /** Its categories show in this colour. */
  color: string
  categories: Array<{ name: string; isIncome?: boolean; excludeFromTotals?: boolean; labels?: string[] }>
}> = [
  {
    name: 'Income',
    color: '#22c55e',
    categories: [
      { name: 'Salary', isIncome: true },
      { name: 'Interest & investment income', isIncome: true },
      { name: 'Refunds & reimbursements', isIncome: true },
      { name: 'Other income', isIncome: true },
    ],
  },
  {
    name: 'Food',
    color: '#f97316',
    categories: [
      { name: 'Groceries', labels: ['Needs'] },
      { name: 'Dine out', labels: ['Wants'] },
      { name: 'Drinks & treats', labels: ['Wants'] },
    ],
  },
  {
    name: 'Housing',
    color: '#6366f1',
    categories: [
      { name: 'Rent', labels: ['Needs'] },
      { name: 'Mortgage', labels: ['Needs'] },
      { name: 'Property tax', labels: ['Needs'] },
      { name: 'Condo fees', labels: ['Needs'] },
      { name: 'Repairs & maintenance', labels: ['Needs'] },
      { name: 'Household supplies', labels: ['Needs'] },
      { name: 'Relocation', labels: ['Needs'] },
      { name: 'Furniture & decorations', labels: ['Wants'] },
      { name: 'Renovations', labels: ['Wants'] },
    ],
  },
  {
    name: 'Utilities',
    color: '#0ea5e9',
    categories: [
      { name: 'Electricity & heating', labels: ['Needs'] },
      { name: 'Water', labels: ['Needs'] },
      { name: 'Internet', labels: ['Needs'] },
      { name: 'Phones', labels: ['Needs'] },
    ],
  },
  {
    name: 'Transportation',
    color: '#f59e0b',
    categories: [
      { name: 'Fuel', labels: ['Needs'] },
      { name: 'Transit', labels: ['Needs'] },
      { name: 'Car payment', labels: ['Needs'] },
      { name: 'Car maintenance', labels: ['Needs'] },
      { name: 'Parking & tolls', labels: ['Needs'] },
      { name: 'Licences & registration', labels: ['Needs'] },
      { name: 'Taxi', labels: ['Wants'] },
    ],
  },
  {
    name: 'Insurance',
    color: '#14b8a6',
    categories: [
      { name: 'Car insurance', labels: ['Needs'] },
      { name: 'Home insurance', labels: ['Needs'] },
      { name: 'Life insurance', labels: ['Needs'] },
      { name: 'Health insurance', labels: ['Needs'] },
    ],
  },
  {
    name: 'Health',
    color: '#10b981',
    categories: [
      { name: 'Pharmacy', labels: ['Needs'] },
      { name: 'Doctor, dental & vision', labels: ['Needs'] },
      { name: 'Therapy & counselling', labels: ['Needs'] },
    ],
  },
  {
    name: 'Kids',
    color: '#eab308',
    categories: [
      { name: 'Childcare & daycare', labels: ['Needs'] },
      { name: 'School fees & supplies', labels: ['Needs'] },
      { name: "Kids' clothing", labels: ['Needs'] },
      { name: 'Activities & lessons', labels: ['Wants'] },
      { name: 'Toys & games', labels: ['Wants'] },
      { name: 'Allowance', labels: ['Wants'] },
    ],
  },
  {
    name: 'Personal',
    color: '#ec4899',
    categories: [
      { name: 'Toiletries & haircuts', labels: ['Needs'] },
      { name: 'Beauty & spa', labels: ['Wants'] },
      { name: 'Courses & books', labels: ['Wants'] },
    ],
  },
  {
    name: 'Shopping',
    color: '#f43f5e',
    categories: [
      { name: 'Clothing & shoes', labels: ['Wants'] },
      { name: 'Electronics', labels: ['Wants'] },
      { name: 'General shopping', labels: ['Wants'] },
    ],
  },
  {
    name: 'Fun',
    color: '#a855f7',
    categories: [
      { name: 'Entertainment', labels: ['Wants'] },
      { name: 'Sports & fitness', labels: ['Wants'] },
      { name: 'Software & media', labels: ['Wants'] },
    ],
  },
  {
    name: 'Travel',
    color: '#3b82f6',
    categories: [
      { name: 'Travel', labels: ['Wants'] },
    ],
  },
  {
    name: 'Giving',
    color: '#84cc16',
    categories: [
      { name: 'Gifts', labels: ['Wants'] },
      { name: 'Donations', labels: ['Wants'] },
    ],
  },
  {
    name: 'Financial',
    color: '#78716c',
    categories: [
      { name: 'Bank & card fees', labels: ['Needs'] },
      { name: 'Interest charges', labels: ['Needs'] },
      { name: 'Income tax', labels: ['Needs'] },
      { name: 'Professional services', labels: ['Needs'] },
    ],
  },
  {
    name: 'Transfers',
    color: '#9ca3af',
    categories: [
      { name: 'Transfer', excludeFromTotals: true },
      { name: 'Credit card payment', excludeFromTotals: true },
      { name: 'Savings & investments', excludeFromTotals: true },
    ],
  },
]
