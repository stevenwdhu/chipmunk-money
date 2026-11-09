export interface LlmCategoryRequest {
  payee: string
  /** What the user named the payee, when the bank's name says little (“Corner Bakery” for “KWAN HOLDINGS INC”). */
  payeeName?: string | null
  amountMinor: number | null
  date: string | null
  accountType: string | null
  notes: string | null
  /** The bank's own category for it (Plaid's), as a second opinion. */
  bankCategory?: string | null
  /** `excluded`: left out of spending and income (transfers, card payments). */
  categories: Array<{ name: string; group: string | null; isIncome: boolean; excluded?: boolean }>
  /** The user's past choices for similar payees, used as few-shot hints. */
  examples: Array<{ payee: string; category: string }>
}

export interface LlmCategoryResult {
  category: string
  confidence: number
  /** The pick means the same kind of spending as the bank's category (false without one). */
  agreesWithBank?: boolean
  slot: 'primary' | 'fallback'
  model: string
}

export type LlmCategorizer = (req: LlmCategoryRequest) => Promise<LlmCategoryResult | null>

export interface ProviderCallResult {
  category: string
  confidence: number
  agreesWithBank?: boolean
  inputTokens: number | null
  outputTokens: number | null
}
