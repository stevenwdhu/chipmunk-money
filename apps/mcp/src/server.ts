import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ApiClient, Me } from './api'
import { ApiError } from './api'
import { ToolContext, ToolError, viewAccount } from './context'
import { categoryTree, TOOLS, type ToolDef } from './tools'

export const SERVER_VERSION = '1.0.0'

const INSTRUCTIONS = `Chipmunk keeps personal finances in ledgers (separate sets of books, e.g. "Personal" and "Family").

- Every tool takes an optional \`ledger\` (slug or name). Leave it out to use your default ledger; list_ledgers shows them.
- Amounts you send are in dollars: negative is money out (spending), positive is money in. Results show both cents (\`amountMinor\`) and formatted amounts. Dates are YYYY-MM-DD in the app's time zone.
- Accounts and categories can be given by name or id.
- To categorize: list_review_queue, then set_categories (each transaction to its own category) and accept_suggestions. Choosing categories improves the suggestions; for a payee that's always the same category, set_payee_choice with \`always\` sets its transactions now and from then on, without review.
- When adding transactions from a bank or receipt, give each an externalId so retries never add duplicates.
- Bulk tools accept dryRun: true to preview. Everything you change is recorded in the ledger's Activity log under your API key's name.`

/** The tools a caller can see: only those its scopes allow. */
export function toolsFor(me: Me): ToolDef[] {
  return TOOLS.filter((t) => me.scopes.includes(t.scope))
}

function errorText(err: unknown): string {
  if (err instanceof ToolError) return err.message
  if (err instanceof ApiError) return err.status === 403 ? `Not allowed: ${err.message}` : err.message
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * An MCP server for one caller. It talks to the REST API with the caller's key, so every action is
 * checked, validated and logged by the API itself.
 */
export function createSpendingServer(api: ApiClient, me: Me): McpServer {
  const server = new McpServer(
    { name: 'chipmunk', title: 'Chipmunk', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  )

  for (const t of toolsFor(me)) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input, outputSchema: t.output, annotations: t.annotations },
      async (args: unknown) => {
        try {
          const { text, data } = await t.run(args as never, new ToolContext(api, me))
          return { content: [{ type: 'text' as const, text }], structuredContent: data as Record<string, unknown> }
        } catch (err) {
          return { isError: true, content: [{ type: 'text' as const, text: errorText(err) }] }
        }
      },
    )
  }

  // Resources: a ledger's categories and accounts, for clients that load context up front.
  const ledgerList = async () => (await new ToolContext(api, me).ledgers()).filter((l) => !l.archived)
  const json = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] })
  server.registerResource(
    'categories',
    new ResourceTemplate('ledger://{ledger}/categories', {
      list: async () => ({
        resources: (await ledgerList()).map((l) => ({ uri: `ledger://${l.slug}/categories`, name: `${l.name} categories`, mimeType: 'application/json' })),
      }),
    }),
    { title: 'Categories', description: 'A ledger’s categories, by group.', mimeType: 'application/json' },
    async (uri, vars) => {
      const ctx = new ToolContext(api, me)
      const l = await ctx.ledger(String(vars.ledger))
      return json(uri, { ledger: l.slug, groups: categoryTree(await ctx.lookups(l), false) })
    },
  )
  server.registerResource(
    'accounts',
    new ResourceTemplate('ledger://{ledger}/accounts', {
      list: async () => ({
        resources: (await ledgerList()).map((l) => ({ uri: `ledger://${l.slug}/accounts`, name: `${l.name} accounts`, mimeType: 'application/json' })),
      }),
    }),
    { title: 'Accounts', description: 'A ledger’s accounts with balances.', mimeType: 'application/json' },
    async (uri, vars) => {
      const ctx = new ToolContext(api, me)
      const l = await ctx.ledger(String(vars.ledger))
      const { accounts } = await ctx.lookups(l)
      return json(uri, { ledger: l.slug, accounts: accounts.filter((a) => !a.archived).map(viewAccount) })
    },
  )

  // Prompts --------------------------------------------------------------------
  const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] })
  const where = (ledger?: string) => (ledger ? ` in the "${ledger}" ledger` : '')
  server.registerPrompt(
    'monthly-review',
    {
      title: 'Monthly review',
      description: 'Review a month’s spending: totals, changes, categories, recurring payments and anything unusual.',
      argsSchema: z.object({
        ledger: z.string().optional().describe('Ledger slug or name'),
        month: z.string().optional().describe('YYYY-MM; default this month'),
      }),
    },
    ({ ledger, month }) =>
      user(
        `Review my spending${where(ledger)} for ${month ?? 'this month'}.
1. get_month_summary for the month, and spending_trend for the last 6 months for context. If list_custom_reports has reports I saved (regular spending, say), also get_report for the ones that fit, with the range set to the month (YYYY-MM..YYYY-MM), and give their numbers too.
2. Compare with the previous month and the 3-month average. Name the categories that moved most, with amounts.
3. top_payees for the month: point out anything unusual or new.
4. list_recurring: flag missing payments and price changes, and suggest subscriptions worth a second look.
5. If list_review_queue has items, mention how many and offer to work through them.
Finish with three short, concrete observations. Don't change anything.`,
      ),
  )
  if (me.scopes.includes('write')) {
    server.registerPrompt(
      'review-queue',
      {
        title: 'Work through the review queue',
        description: 'Accept or fix suggested categories and categorize uncategorized transactions.',
        argsSchema: z.object({ ledger: z.string().optional().describe('Ledger slug or name') }),
      },
      ({ ledger }) =>
        user(
          `Work through my review queue${where(ledger)}.
1. list_review_queue to see suggested and uncategorized transactions and the categories available.
2. For each, pick the best category from that list. When unsure, search_transactions for the same payee to see how I categorized it before; if still unsure, leave it and tell me.
3. Apply your choices with one set_categories call (dryRun: true first if there are more than 20), and accept_suggestions for suggestions that were already right.
4. Summarize what you changed, list anything you left for me with a short reason, and name payees that look like they're always the same category: set_payee_choice can make them automatic if I agree.`,
        ),
    )
  }

  return server
}
