import { formatMoney } from '@st/shared'
import type { LlmCategoryRequest } from './types'

export const SYSTEM_PROMPT = `You categorize personal finance transactions for someone living in Canada.
Pick exactly one category from the provided list for the transaction.
The user's own past choices are the strongest signal: follow them when a payee is similar.
Negative amounts are money going out; positive amounts are money coming in. Only use an income category for money coming in.
Bank descriptions are often truncated or include store numbers, cities and payment-processor prefixes; look past them to the merchant.
Set confidence between 0 and 1: near 1 only when the merchant is unambiguous, below 0.5 when you are guessing.
When the bank's own category is given, set agreesWithBank to true only if your pick is the same kind of spending or income as the bank's category; otherwise, or with no bank category, set it to false.`

export function userPrompt(req: LlmCategoryRequest): string {
  const lines = [
    'Transaction:',
    `- Payee / description: ${req.payee}`,
    req.payeeName ? `- What the user calls this payee: ${req.payeeName}` : null,
    req.amountMinor !== null ? `- Amount: ${formatMoney(req.amountMinor)} (${req.amountMinor < 0 ? 'money out' : 'money in'})` : null,
    req.date ? `- Date: ${req.date}` : null,
    req.accountType ? `- Account type: ${req.accountType}` : null,
    req.notes ? `- Notes: ${req.notes}` : null,
    req.bankCategory ? `- The bank's category: ${req.bankCategory}` : null,
    '',
    'Categories (group › category):',
    ...req.categories.map(
      (c) =>
        `- ${c.group ? `${c.group} › ` : ''}${c.name}${c.isIncome ? ' (income)' : ''}${c.excluded ? ' (not spending or income: money moving between your own accounts, e.g. paying a credit card)' : ''}`,
    ),
  ]
  if (req.examples.length) {
    lines.push('', "The user's past choices:")
    for (const e of req.examples) lines.push(`- "${e.payee}" → ${e.category}`)
  }
  lines.push('', 'Answer with the category name exactly as written in the list.')
  return lines.filter((l) => l !== null).join('\n')
}
