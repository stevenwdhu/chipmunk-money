# MCP server

Spending Tracker is also an [MCP](https://modelcontextprotocol.io) server, so an AI agent (Claude and others) can work with your books directly: "what did I spend on dining out last month?", "work through my review queue", "add these receipts". It works through the [REST API](api.md) with the agent's own API key. The key's access applies to everything the agent does, and everything it changes shows up in **Activity** under the key's name.

## Connect an agent

1. Create a key in **App settings → API keys**: *Read only* for questions, *Read and write* to change things. Limit it to one ledger if you like.
2. Connect the agent, over HTTP or stdio.

### Over HTTP

The simplest way, with nothing to install. The endpoint is `/mcp` on the app's server, and it always needs a key.

Claude Code:

```bash
claude mcp add --transport http spending http://localhost:8787/mcp --header "Authorization: Bearer st_…"
```

Claude Agent SDK:

```ts
mcpServers: {
  spending: { type: 'http', url: 'http://localhost:8787/mcp', headers: { Authorization: `Bearer ${process.env.ST_API_KEY}` } },
}
```

### Over stdio

For agents that start their tools as processes. Build it once with `pnpm build` (or `pnpm --filter @st/mcp build`), then point the agent at the bundled file. It needs a key too, and the address of the app's server (`ST_API_URL`, `http://localhost:8787` when left out):

```json
{
  "mcpServers": {
    "spending": {
      "command": "node",
      "args": ["/path/to/spending-tracker/apps/mcp/dist/stdio.js"],
      "env": { "ST_API_URL": "http://localhost:8787", "ST_API_KEY": "st_…" }
    }
  }
}
```

## What agents get

- **Tools**, listed below. An agent only sees the ones its key's access allows: a *Read only* key gets the read tools, *Read and write* adds the write tools, and *Full access* adds the rest. A key limited to some ledgers still sees tools for app-wide things, like `create_ledger` or changing the shared category list, and the API refuses them.
- **Resources:** `ledger://{ledger}/categories` (a ledger's categories, by group) and `ledger://{ledger}/accounts` (its accounts with balances), for agents that load context up front.
- **Prompts:** *Monthly review* (a month's spending, compared with the months before, with anything unusual) and, for keys that can write, *Work through the review queue*.
- **Instructions** the server gives every agent on how the tools fit together.

How the tools work:

- Most tools take an optional `ledger` (its slug or name). Without it, they use the ledger the app opens, or the key's first ledger when it can't use that one. `list_ledgers` lists them.
- Accounts and categories can be given by name or id.
- Amounts are in dollars, negative for money out (`-12.99`). Results give both cents and a formatted amount. Dates are `YYYY-MM-DD` in the app's time zone.
- Each result has a readable summary and structured data.
- Bulk tools accept `dryRun: true` to preview. `import_transactions` previews until you pass `confirm: true`.
- Give each transaction for `add_transactions` an `externalId` (a bank's id, a receipt number), and retrying never adds it twice.
- When the API refuses something, the tool returns its message as an error, starting "Not allowed:" for a key without the access. `add_transactions` lists the rows it couldn't add in `failed`, and is an error only when none were added.

Erasing or restoring data, deleting a ledger and managing API keys are left out on purpose: those stay in the app.

## Tools

<!-- reference:start (made by `pnpm docs:update` from the code: edit the code, not this) -->

### Read (a *Read only* key)

#### `list_ledgers`

**List ledgers.** The ledgers (separate sets of books, e.g. "Personal" and "Family") you can use. Every other tool takes an optional `ledger`.

No arguments.

#### `get_month_summary`

**Get a month summary.** Spending, income, savings rate and spending by category for one month (default: this month), compared with the previous month and the 3-month average.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `month` | string | optional | YYYY-MM. Default: this month. |

#### `get_net_worth`

**Get net worth.** Assets, liabilities and net worth today, each account’s balance, and month-end net worth for the past months. Liabilities are what’s owed on credit cards and loans.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `months` | number | optional | Default: `12`. |

#### `search_transactions`

**Search transactions.** Newest first. Filter by text (payee, name, notes or an amount like 12.99), date range, account, category ("uncategorized" for none), category label, tag, or needsReview, and by a custom report or Only count and Filter out conditions (or what they filter out). Pass `cursor` from the previous result for more.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `query` | string | optional |  |
| `from` | string | optional |  |
| `to` | string | optional |  |
| `account` | string or number | optional |  |
| `category` | string or number | optional | Category name or id, or "uncategorized". |
| `tag` | string | optional |  |
| `needsReview` | boolean | optional |  |
| `label` | string | optional | A category label (such as "Need"): transactions in categories with it. "none" for spending in categories without a label. |
| `report` | string or number | optional | A custom report’s name or id (list_custom_reports): use its filter. |
| `spending` | object | optional | Conditions for spending, added to the report’s. |
| `income` | object | optional | Conditions for income, added to the report’s. |
| `filteredOut` | boolean | optional | With a report or conditions: the transactions they filter out, not the ones they count. |
| `limit` | number | optional | Default: `50`. |
| `cursor` | string | optional |  |

#### `get_transaction`

**Get a transaction.** One transaction by id.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `id` | number | required |  |

#### `list_review_queue`

**List the review queue.** Transactions waiting for a decision: those with a suggested category to accept or change, and uncategorized ones. Also lists the categories you can choose from. Work through it with set_categories and accept_suggestions.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `limit` | number | optional | Default: `50`. |

#### `list_accounts`

**List accounts.** Accounts with current balances. Credit cards and loans are liabilities (their balance is negative when you owe).

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `includeArchived` | boolean | optional | Default: `false`. |

#### `list_categories`

**List categories.** Categories by group, with your labels on them (such as Need or Want). Categories marked excludeFromTotals (transfers, card payments) don’t count as spending.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `includeArchived` | boolean | optional | Default: `false`. |

#### `list_tags`

**List tags.** Tags with how many transactions use each.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |

#### `list_recurring`

**List recurring payments.** Bills, subscriptions, instalment plans and regular income. `suggested` ones were detected from history and wait to be confirmed or dismissed; `ended` ones include paid-off plans. Alerts flag missing payments and price changes.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `status` | "suggested" \\| "active" \\| "dismissed" \\| "ended" | optional |  |

#### `upcoming_payments`

**List upcoming payments.** Expected payments from confirmed recurring items in the next days, including overdue ones.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `days` | number | optional | Default: `30`. |

#### `recurring_payment_candidates`

**Find payments to add to a recurring payment.** Transactions you could add to a recurring item with add_recurring_payment, like an instalment plan’s down payment or its last payment (the remainder), which the app doesn’t link because their amount differs. Not linked to an item and not transfers, the same way as the item (money out or in), from its account if it has one, at any amount. Without `search`: from around its dates. Its payees’ and ones like them come first (`likely`).

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `id` | number | required | The recurring item’s id, from list_recurring. |
| `search` | string | optional | Words to find (payee, name, notes or amount), at any date. |

#### `spending_by_category`

**Spending by category.** Totals by category for a date range (default: this month so far). Use kind "income" for income. With `report` or conditions, only what they count.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `from` | string | optional |  |
| `to` | string | optional |  |
| `kind` | "expense" \\| "income" | optional | Default: `"expense"`. |
| `report` | string or number | optional | A custom report’s name or id (list_custom_reports): use its filter. |
| `spending` | object | optional | Conditions for spending, added to the report’s. |
| `income` | object | optional | Conditions for income, added to the report’s. |

#### `spending_trend`

**Spending trend.** Monthly spending and income for the past months, with the biggest categories (or groups) each month. With `report` or conditions, only what they count.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `months` | number | optional | Default: `6`. |
| `end` | string | optional | Last month to include (YYYY-MM). Default: this month. |
| `groupBy` | "category" \\| "group" | optional | Default: `"category"`. |
| `report` | string or number | optional | A custom report’s name or id (list_custom_reports): use its filter. |
| `spending` | object | optional | Conditions for spending, added to the report’s. |
| `income` | object | optional | Conditions for income, added to the report’s. |

#### `top_payees`

**Top payees.** Where the money went: payees by total spending for a date range (default: this month so far), each purchase less its refunds and paybacks. With `report` or conditions, only what they count.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `from` | string | optional |  |
| `to` | string | optional |  |
| `limit` | number | optional | Default: `15`. |
| `report` | string or number | optional | A custom report’s name or id (list_custom_reports): use its filter. |
| `spending` | object | optional | Conditions for spending, added to the report’s. |
| `income` | object | optional | Conditions for income, added to the report’s. |

#### `income_vs_spending`

**Income vs spending.** Income, spending, net and savings rate per month for the past months. With `report` or conditions, only what they count.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `months` | number | optional | Default: `12`. |
| `end` | string | optional |  |
| `report` | string or number | optional | A custom report’s name or id (list_custom_reports): use its filter. |
| `spending` | object | optional | Conditions for spending, added to the report’s. |
| `income` | object | optional | Conditions for income, added to the report’s. |

#### `list_custom_reports`

**List custom reports.** Reports you saved in the app: each one’s filter in words, its range and comparison, and anything it refers to that’s gone. Pass a name to get_report to run one.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |

#### `get_report`

**Get a report.** Spending and income for a range, filtered: a custom report by name (list_custom_reports), and/or your own Only count and Filter out conditions, added to its filter. Spending and income are filtered apart. Refunds and paybacks go with the purchase they’re linked to, and amounts are your share after them. Gives spending, the average of complete months, income, saved, the change against a comparison period by category group, and the biggest purchases filtered out. For example, regular spending: filterOut [{ tags: ["one-off"] }, { atLeast: 1000, recurring: "none" }].

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `report` | string or number | optional | A custom report’s name or id (list_custom_reports): use its filter. |
| `spending` | object | optional | Conditions for spending, added to the report’s. |
| `income` | object | optional | Conditions for income, added to the report’s. |
| `range` | string | optional | 3m, 6m, 12m or 24m (ending this month), ytd, last-year, or months like 2025-11..2026-10. Default: the report’s, or 12m. |
| `compare` | "previous" \\| "last-year" \\| "none" | optional | previous: the months just before. last-year: the same months a year before. Default: the report’s, or previous. |

### Write (a *Read and write* key)

#### `add_transactions`

**Add transactions.** Adds up to 100 transactions. Give each an `externalId` (for example the bank’s id) to make retries safe: one that the account already has is not added again. Leave out `category` and the app suggests one from your history (or AI), flagged for review.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `transactions` | object[] | required |  |

#### `update_transaction`

**Update a transaction.** Changes only the fields you give. Setting `category` also teaches the app this payee. `tags` replaces all tags.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `id` | number | required |  |
| `date` | string | optional |  |
| `time` | string or null | optional | Its time of day (HH:MM, local; null: none). Moving the date keeps it. |
| `amount` | number | optional | In dollars, e.g. -12.99. Negative is money out (spending); positive is money in. |
| `payee` | string | optional |  |
| `name` | string or null | optional | What it is, like “Suitcase”; null clears it. For a recurring item’s payment it renames the item, which all its payments share. |
| `account` | string or number | optional |  |
| `category` | string or number or null | optional | Category name (e.g. "Groceries") or id. null or "none" leaves it uncategorized. |
| `notes` | string or null | optional |  |
| `tags` | string[] | optional |  |
| `pending` | boolean | optional |  |

#### `link_transactions`

**Link refunds and paybacks.** Sets what money in pays back (or, given a bill, what paid it back), replacing its links: a `refund` from the merchant, or a `payback` from someone sharing a bill you paid. One payback can cover several bills, each with its amount, and a bill can be paid back by several. Linked in full to one bill, money in takes its category; reports count each link in its bill’s category, a payback in the bill’s month. An empty list unlinks it.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `id` | number | required | The money in (or the bill). |
| `links` | object[] | required |  |

#### `set_categories`

**Set categories.** Sets the category of many transactions at once, each to its own category. This is how to work through the review queue: it also teaches the app, so the same payee is categorized automatically next time. Try `dryRun: true` first for big changes.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `assignments` | object[] | required |  |
| `dryRun` | boolean | optional | Report what would change without changing anything. Default: `false`. |

#### `accept_suggestions`

**Accept suggested categories.** Accepts the suggested category on the given transactions (or on every one with `all: true`). Accepting teaches the app your habits.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `ids` | number[] | optional |  |
| `all` | boolean | optional |  |
| `dryRun` | boolean | optional | Report what would change without changing anything. Default: `false`. |

#### `set_payee_choice`

**Choose what happens to a payee.** For a payee (as it appears on its transactions): `always` sets one category on its transactions waiting for review or uncategorized, and on new ones without review. `review` never sets one on its own: for payees that can be several things, like e-transfers and transfers. `ask` (the default) suggests one to review each time.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `payee` | string | required | The payee, e.g. "A&W RESTAURANTS #123"; store numbers and card noise don’t matter. |
| `mode` | "always" \\| "ask" \\| "review" | required |  |
| `category` | string or number | optional | For `always`: the category, by name or id. |
| `dryRun` | boolean | optional | Report what would change without changing anything. Default: `false`. |

#### `delete_transactions`

**Delete transactions.** Deletes transactions (both sides of a transfer). They can be restored in the app for 30 days. Use `dryRun: true` to check first.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `ids` | number[] | required |  |
| `dryRun` | boolean | optional | Report what would change without changing anything. Default: `false`. |

#### `create_account`

**Create an account.** Its balance adds up its transactions, from the latest balance recorded with record_balance (or the opening balance). Investments, loans and property mostly move by recorded balances, since their value changes on its own.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `name` | string | required |  |
| `type` | "chequing" \\| "savings" \\| "credit" \\| "cash" \\| "investment" \\| "loan" \\| "property" \\| "other" | required |  |
| `openingBalance` | number | optional | In dollars. For a credit card or loan you owe on, use a negative number. Default: `0`. |
| `openingDate` | string | optional |  |
| `institution` | string | required | Where it’s held, e.g. “TD” or “Wallet”: an institution you already have (by name), or a new one. |
| `notes` | string | optional |  |

#### `update_account`

**Update an account.** Rename, change details, or archive (hide from lists while keeping its history).

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `account` | string or number | required |  |
| `name` | string | optional |  |
| `institution` | string | optional | Move it to this institution (by name; a new name adds one). |
| `notes` | string or null | optional |  |
| `archived` | boolean | optional |  |

#### `rename_institution`

**Rename an institution.** Renames the bank or other place accounts are held. Its accounts move with it, and a synced one keeps its match to the bank.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `institution` | string or number | required |  |
| `newName` | string | required |  |

#### `record_balance`

**Record an account balance.** The balance at the end of a day (default today). Mostly for investments, loans and property. Recording again on the same day replaces it. Not for a synced account, whose balance is the bank’s.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `account` | string or number | required |  |
| `balance` | number | required | In dollars; negative for money owed. |
| `date` | string | optional |  |

#### `create_category`

**Create a category.** Adds a category, in a group (created if it doesn’t exist yet). If the ledger uses the shared category list, it’s added there, so every ledger that shares gets it.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `name` | string | required |  |
| `group` | string | optional |  |
| `isIncome` | boolean | optional | Default: `false`. |
| `labels` | string[] | optional | Labels to put on it (created if new), such as "Need". |

#### `update_category`

**Update a category.** Rename, move to another group (its colour comes from the group), set its labels, or archive it (hide it from pickers). If the ledger uses the shared category list, renames, groups and labels change it for every ledger that shares, and archiving turns it off in this ledger only; turning off one its transactions use needs `moveTo` (another category for them, or null to leave them uncategorized). With its own list, its transactions keep an archived category.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `category` | string or number | required |  |
| `name` | string | optional |  |
| `group` | string or null | optional | Group name; null to remove it from its group. |
| `isIncome` | boolean | optional |  |
| `labels` | string[] | optional | Its labels, replacing the ones it has (new ones are created). [] removes them all. |
| `archived` | boolean | optional |  |
| `moveTo` | string or number or null | optional | Shared list, turning a category off: where its transactions go (null: uncategorized). |

#### `merge_category`

**Merge a category into another.** Moves every transaction, recurring payment and learned payee from one category to another, then deletes the first. The other category keeps its name, group and labels. If the ledger uses the shared category list, this happens in every ledger that shares. Ask the user before doing this.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `category` | string or number | required | The category that goes away. |
| `into` | string or number | required | The category that takes over. |

#### `label_categories`

**Label categories.** Puts a label (such as "Need" or "Want") on several categories at once, or takes it off. The label is created if it doesn’t exist yet. Other labels on those categories stay.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `label` | string | required |  |
| `add` | string or number[] | optional | Categories to put the label on. Default: `[]`. |
| `remove` | string or number[] | optional | Categories to take it off. Default: `[]`. |

#### `rename_tag`

**Rename a tag.** Renames a tag on every transaction that has it.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `tag` | string | required |  |
| `newName` | string | required |  |

#### `confirm_recurring`

**Confirm a recurring payment.** Turns a suggested recurring payment into an active one, so it shows in upcoming payments and gets alerts.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `id` | number | required |  |

#### `dismiss_recurring`

**Dismiss a recurring payment.** Dismisses a suggestion (or stops tracking an item). It won’t be suggested again.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `id` | number | required |  |

#### `add_recurring_payment`

**Add a payment to a recurring payment.** Adds a transaction to a recurring item at its own amount: an instalment plan’s down payment, a first payment that covers part of a period, its last one (the remainder), or one the app didn’t link. It’s counted and takes the item’s category, but the item’s usual amount stays (it’s no price change). Find one with recurring_payment_candidates. The item must be active or ended, the payment from its account, and a plan takes no more payments than it has. Ask the user before adding one they didn’t name.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `id` | number | required | The recurring item’s id. |
| `transactionId` | number | required |  |

#### `create_recurring`

**Create a recurring payment.** Adds a bill, subscription, instalment plan or regular income by hand. Matching transactions are linked to it as they arrive; an instalment plan (`payments`) ends after its last one.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `payee` | string | required | The payee as it appears on statements, like "Klarna"; payments are matched by it. |
| `name` | string | optional | What it is, like "Dyson vacuum", shown in place of the payee. |
| `amount` | number | required | Expected amount in dollars; negative for bills. |
| `cadence` | "weekly" \\| "biweekly" \\| "semimonthly" \\| "monthly" \\| "quarterly" \\| "yearly" | required |  |
| `nextDate` | string | required | The next (or a recent) date it happens; later dates follow the cadence. |
| `category` | string or number or null | optional | Category name (e.g. "Groceries") or id. null or "none" leaves it uncategorized. |
| `account` | string or number | optional |  |
| `secondDay` | number | optional | Semi-monthly: the other day of the month (31 for the last day); nextDate gives the first. |
| `payments` | number | optional | An instalment plan: how many payments it has in all, like 4 for Pay in 4. |
| `paidSoFar` | number | optional | An instalment plan: how many are paid already, including ones from before the ledger’s history. |
| `fullPrice` | number | optional | An instalment plan: the total of all its payments in dollars, as the lender shows it, interest included. Its last payment is what’s left of it. Negative like its amount. |

#### `save_custom_report`

**Save a custom report.** Saves a filter as a custom report the app shows under Reports (and get_report runs). A new name makes a new report, from another report’s filter (`report`) with the conditions given added. An existing name needs `replace: true`: the conditions given then take the place of that side’s Only count and Filter out (picked and put back transactions stay), and range, compare and groupBy change when given.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `name` | string | required |  |
| `report` | string or number | optional | A custom report’s name or id (list_custom_reports): use its filter. |
| `spending` | object | optional | Conditions for spending, added to the report’s. |
| `income` | object | optional | Conditions for income, added to the report’s. |
| `replace` | boolean | optional | Change the report with this name. Default: `false`. |
| `range` | string | optional | 3m, 6m, 12m or 24m (moving with today), ytd, last-year, or fixed months like 2025-11..2026-10. Default: none, so it opens with any range. |
| `compare` | "previous" \\| "last-year" \\| "none" | optional |  |
| `groupBy` | "category" \\| "group" | optional |  |

#### `delete_custom_report`

**Delete a custom report.** Deletes a saved report. Transactions don’t change.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `report` | string or number | required | Its name or id. |

#### `import_transactions`

**Import transactions.** Imports rows from a bank statement into one account. First call it without `confirm` to see which rows are new, which look like duplicates, and the category each would get. Then call again with `confirm: true` to import the new ones as one batch (which can be undone in the app).

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | optional | Ledger slug or name, e.g. "personal". Leave out to use your default ledger. |
| `account` | string or number | required |  |
| `rows` | object[] | required |  |
| `fileName` | string | optional |  |
| `confirm` | boolean | optional | Default: `false`. |

#### `sync_banks`

**Sync bank accounts.** Fetches new transactions and balances from the connected banks (through SimpleFIN, Plaid or Wealthsimple) now, instead of waiting for the next automatic sync (as often as App settings → Bank sync says for each service: by default every 6 hours for SimpleFIN, every hour for Plaid, every 2 hours for Wealthsimple). SimpleFIN allows only about 24 updates a day, so don’t call this repeatedly.

No arguments.

### Full access (a *Full access* key)

#### `create_ledger`

**Create a ledger.** A new, separate set of books with default categories. `start: "demo"` fills it with sample data.

| Argument | Type | | What it is |
|---|---|---|---|
| `name` | string | required |  |
| `color` | string | optional |  |
| `start` | "empty" \\| "demo" | optional | Default: `"empty"`. |

#### `archive_ledger`

**Archive a ledger.** Hides a ledger from the app’s switcher while keeping all its data. It can be restored in App settings → Ledgers.

| Argument | Type | | What it is |
|---|---|---|---|
| `ledger` | string | required | Ledger slug or name. |

<!-- reference:end -->
