# REST API

Everything the web app does goes through this API, so anything you can do in the app, a script or an agent can do too. This page explains how to use it, and lists every endpoint at the end. For each endpoint's fields, try it from the interactive docs that come with the app.

- **Interactive docs:** `/api/docs` on your server (for example `http://localhost:8787/api/docs`). You can make requests from there.
- **OpenAPI spec:** `/api/v1/openapi.json`, for code generators and API clients.
- **Base URL:** `/api/v1`. Ledger data lives under `/api/v1/ledgers/{ledger}/…`, where `{ledger}` is the ledger's slug from the app's address (`personal` in `/l/personal/transactions`) or its id.

```bash
curl -H "Authorization: Bearer $CHIPMUNK_API_KEY" http://localhost:8787/api/v1/ledgers/personal/reports/summary
```

## Keys

Create a key for each script or agent in **App settings → API keys**, and send it as `Authorization: Bearer cm_…`. The key is shown once, and only a hash of it is stored.

| Access | Scopes | What it can do |
|---|---|---|
| **Read only** | `read` | Look at everything: transactions, accounts, reports, settings. |
| **Read and write** | `read`, `write` | Also add and change things: transactions, categories, accounts, recurring items, imports, bank syncs. |
| **Full access** | `read`, `write`, `admin` | Also ledgers, app settings, API keys, the full backup and erase. |

Each endpoint in the reference below says the scope it needs. A key without it gets 403.

A key can also be limited to some ledgers, and given an expiry. A key limited to some ledgers can't use anything app-wide, even with full access. Those requests get 403:

- API keys, app settings, managing bank connections, the full backup, and renaming payees across ledgers.
- Creating ledgers, which ledger the app opens, the ledgers' order, and deleting or archiving the one the app opens.
- The shared category list and its labels.
- It only sees and links bank accounts that already sync into its ledgers, and only syncs connections that feed nothing but its ledgers.

`GET /me` says who the API thinks you are: the key's name, its scopes, the ids of the ledgers it's limited to (null for every ledger), and `defaultLedger`, the ledger to use when you don't name one. That's the one the app opens, or the key's first ledger when it can't use that one.

**Without a key.** Everything needs a key except the app's own web page, and `/api/docs`, `/api/v1/openapi.json` and `/healthz`, which hold no data. A request without a key from curl, a script or another website gets 401, and at a host name that isn't local and isn't in `ALLOWED_HOSTS` it's a 403. How the server tells its own page apart, and running it behind a proxy that signs people in (`TRUSTED_AUTH_HEADER`), are explained in [Security](security.md).

## Conventions

- **Money** is in minor units (cents) as integers: `-1299` is $12.99 out, `250000` is $2,500 in. Reports give spending as positive numbers.
- **Dates** are `YYYY-MM-DD`, in the app's time zone (App settings → General).
- **Lists** that can be long are paged. Pass `limit` (up to 500 for transactions) and, for the next page, the previous page's `nextCursor` as `cursor`. `nextCursor` is null on the last page.
- **Request size:** a JSON request can be up to 1 MB. Imports and `/mcp` can be up to 200 MB.

### Errors

Every error has the same shape, with a message you can show to a person:

```json
{ "error": { "code": "validation_failed", "message": "payee: Required", "issues": [{ "path": "payee", "message": "Required" }] } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request`, `validation_failed` | The request can't be done as sent. `validation_failed` lists each wrong field in `issues`. |
| 401 | `unauthorized` | No key, a key that's wrong, expired or revoked, an `Authorization: Bearer` header that isn't `Bearer <key>`, or (behind a proxy with `TRUSTED_AUTH_HEADER`) a request without the proxy's header. |
| 403 | `forbidden` | The key doesn't have the scope or the ledger, or it's limited to some ledgers and the request is app-wide. Also a request without a key at a host name that isn't allowed. |
| 404 | `not_found` | There's no such ledger, transaction, account… |
| 409 | `conflict` | It already exists, or it conflicts with how things are (the only ledger, a category in use, a connection that's already syncing). Also an `Idempotency-Key` reused for another request, or one whose request is still running. |
| 413 | `payload_too_large` | The request is over the size limit. |
| 429 | `rate_limited` | A SimpleFIN connection used its updates for the day. The message says when to try again. |
| 500 | `internal` | Something went wrong on the server. The server log has the details. |

### Retries without doing things twice

- **`Idempotency-Key`** on any POST: the first successful (2xx) JSON response is kept for 24 hours, and a retry with the same key gets that response back (with an `Idempotent-Replayed: true` header) instead of doing the work again. A retry has to be the same request: the same path, query and body, byte for byte. Anything else with that key is a 409, and so is a retry sent while the first is still running. Use a new key for each new request. A failed request isn't remembered, so you can fix it and retry with the same key. Keys are up to 200 characters, and each API key has its own.
- **`externalId`** on a transaction: your own id for it, unique in its account (a bank's transaction id, a receipt number). Adding a transaction with an `externalId` the account already has adds nothing and returns the existing one with status 200. If that one was deleted, it's a 409: restore it instead.
- **`?dryRun=true`** on bulk edits and imports (marked in the reference below): the request runs and reports what it would change, then nothing is kept.

### Activity

Every change records who made it (`web` for the app, or the key's name) and what it did, with the fields before and after for most changes. See it under **Activity** in each ledger, or through the Activity endpoints.

## Examples

Add a transaction, safe to retry:

```bash
curl -X POST http://localhost:8787/api/v1/ledgers/personal/transactions \
  -H "Authorization: Bearer $CHIPMUNK_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: receipt-2026-11-10-001" \
  -d '{"accountId": 2, "date": "2026-11-10", "amountMinor": -1299, "payee": "Corner Bakery", "externalId": "receipt-001"}'
```

Leave out `categoryId` and the app suggests one from your history (or AI). A suggestion waits for your review (`needsReview`), unless it's the payee's *always* category, which is applied. With no suggestion, it stays uncategorized.

Page through this month's uncategorized transactions:

```bash
curl -G http://localhost:8787/api/v1/ledgers/personal/transactions -H "Authorization: Bearer $CHIPMUNK_API_KEY" \
  --data-urlencode "from=2026-11-01" --data-urlencode "categoryId=none" --data-urlencode "limit=100"
# then again with --data-urlencode "cursor=<nextCursor from the last page>"
```

See what a bulk change would do before doing it:

```bash
curl -X POST "http://localhost:8787/api/v1/ledgers/personal/transactions/bulk?dryRun=true" \
  -H "Authorization: Bearer $CHIPMUNK_API_KEY" -H "Content-Type: application/json" \
  -d '{"ids": [101, 102, 103], "categoryId": 7}'
```

Add an instalment plan's down payment, which the app didn't link because its amount is its own:

```bash
# Payments you could add, its payees' first
curl http://localhost:8787/api/v1/ledgers/personal/recurring/15/payment-candidates -H "Authorization: Bearer $CHIPMUNK_API_KEY"
# Add one: it counts as a payment, and the plan's usual amount stays
curl -X POST http://localhost:8787/api/v1/ledgers/personal/recurring/15/add-payment \
  -H "Authorization: Bearer $CHIPMUNK_API_KEY" -H "Content-Type: application/json" -d '{"transactionId": 684}'
```

## Endpoints

Paths are under `/api/v1`. A **Scope** of `read` works with any key, `write` needs *Read and write* or *Full access*, and `admin` needs *Full access*.

<!-- reference:start (made by `pnpm docs:update` from the code: edit the code, not this) -->

### Me

Who the API thinks you are, and what your key can do.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/me` | Get the current caller. | read |

### Ledgers

Separate sets of books, e.g. “Personal” and “Family”. Every other ledger route is under `/ledgers/{ledger}`.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/ledgers` | List ledgers. | read |
| POST | `/ledgers` | Create a ledger. | admin |
| GET | `/ledgers/{ledger}` | Get a ledger. | read |
| PATCH | `/ledgers/{ledger}` | Update a ledger. | admin |
| DELETE | `/ledgers/{ledger}` | Delete a ledger. | admin |

### Transactions

Money in and out of an account. Amounts are in minor units (cents): negative is money out.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/ledgers/{ledger}/transactions` | List transactions. | read |
| GET | `/ledgers/{ledger}/transactions/span` | Get the date span of transactions. | read |
| POST | `/ledgers/{ledger}/transactions` | Create a transaction. | write |
| POST | `/ledgers/{ledger}/transactions/bulk` | Change many transactions. Accepts `?dryRun=true`. | write |
| POST | `/ledgers/{ledger}/transactions/accept-all` | Accept all suggested categories. Accepts `?dryRun=true`. | write |
| POST | `/ledgers/{ledger}/transactions/match` | Find refunds and card payments. Accepts `?dryRun=true`. | write |
| GET | `/ledgers/{ledger}/transactions/{id}` | Get a transaction. | read |
| GET | `/ledgers/{ledger}/transactions/{id}/bank-data` | Get what the bank last sent for a transaction. | read |
| GET | `/ledgers/{ledger}/transactions/{id}/link-candidates` | Find what a transaction could pay back, or be paid back by. | read |
| GET | `/ledgers/{ledger}/transactions/{id}/links` | List what a transaction pays back, or what paid it back. | read |
| PUT | `/ledgers/{ledger}/transactions/{id}/links` | Set what a transaction pays back, or what paid it back. | write |
| PUT | `/ledgers/{ledger}/transactions/links` | Set what several money in pays back, together. | write |
| PATCH | `/ledgers/{ledger}/transactions/{id}` | Update a transaction. | write |
| DELETE | `/ledgers/{ledger}/transactions/{id}` | Delete a transaction. | write |
| POST | `/ledgers/{ledger}/transactions/{id}/restore` | Restore a deleted transaction. | write |
| POST | `/ledgers/{ledger}/transactions/{id}/accept-suggestion` | Accept a suggested category. | write |

### Accounts

Institutions, and the accounts at them: bank accounts, cards, investments, loans and other assets.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/ledgers/{ledger}/institutions` | List institutions. | read |
| POST | `/ledgers/{ledger}/institutions` | Create an institution. | write |
| POST | `/ledgers/{ledger}/institutions/reorder` | Reorder institutions. | write |
| PATCH | `/ledgers/{ledger}/institutions/{id}` | Update an institution. | write |
| DELETE | `/ledgers/{ledger}/institutions/{id}` | Delete an institution. | write |
| GET | `/ledgers/{ledger}/accounts` | List accounts. | read |
| POST | `/ledgers/{ledger}/accounts` | Create an account. | write |
| GET | `/ledgers/{ledger}/bank-accounts` | List bank accounts to sync from. | read |
| PUT | `/ledgers/{ledger}/accounts/{id}/bank` | Switch an account to synced. | write |
| POST | `/ledgers/{ledger}/accounts/{id}/bank/preview` | Compare an account with a bank account before switching. | write |
| DELETE | `/ledgers/{ledger}/accounts/{id}/bank/preview` | End a switch’s review without switching. | write |
| POST | `/ledgers/{ledger}/accounts/{id}/bank/switch` | Switch an account to sync from a bank account, as reviewed. | write |
| DELETE | `/ledgers/{ledger}/accounts/{id}/bank` | Switch an account to manual. | write |
| POST | `/ledgers/{ledger}/accounts/reorder` | Reorder accounts. | write |
| GET | `/ledgers/{ledger}/accounts/{id}` | Get an account. | read |
| PATCH | `/ledgers/{ledger}/accounts/{id}` | Update an account. | write |
| DELETE | `/ledgers/{ledger}/accounts/{id}` | Delete an account. | write |
| POST | `/ledgers/{ledger}/accounts/{id}/balance` | Record a balance. | write |
| GET | `/ledgers/{ledger}/accounts/{id}/history` | Get an account’s balance history. | read |
| GET | `/ledgers/{ledger}/accounts/{id}/snapshots` | List recorded balances. | read |
| DELETE | `/ledgers/{ledger}/accounts/{id}/snapshots/{snapshotId}` | Delete a recorded balance. | write |

### Bank sync

Connections to your banks (SimpleFIN Bridge, Plaid and Wealthsimple), the bank accounts they bring, and syncing them.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/bank/connections` | List bank connections. | admin |
| POST | `/bank/connections` | Connect SimpleFIN. | admin |
| PATCH | `/bank/connections/{id}` | Rename a bank connection. | admin |
| DELETE | `/bank/connections/{id}` | Remove a bank connection. | admin |
| POST | `/bank/connections/{id}/sync` | Sync a bank connection. | write |
| POST | `/bank/connections/{id}/fetch-history` | Fetch a bank connection’s history again. | write |
| POST | `/bank/plaid/link-token` | Start Plaid Link. | admin |
| POST | `/bank/plaid/connections` | Connect a bank through Plaid. | admin |
| POST | `/bank/wealthsimple/connections` | Connect Wealthsimple. | admin |
| POST | `/bank/sync` | Sync all bank connections. | write |

### Categories

Categories, their groups, and tags.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/categories` | List the shared categories. | read |
| POST | `/categories` | Add a shared category. | write |
| POST | `/categories/reorder` | Reorder shared categories. | write |
| PATCH | `/categories/{id}` | Update a shared category. | write |
| DELETE | `/categories/{id}` | Delete a shared category. | write |
| POST | `/categories/{id}/merge` | Merge a shared category into another. | write |
| POST | `/category-groups` | Add a shared category group. | write |
| POST | `/category-groups/reorder` | Reorder shared category groups. | write |
| PATCH | `/category-groups/{id}` | Update a shared category group. | write |
| DELETE | `/category-groups/{id}` | Delete a shared category group. | write |
| POST | `/labels` | Add a shared label. | write |
| PATCH | `/labels/{id}` | Update a shared label. | write |
| DELETE | `/labels/{id}` | Delete a shared label. | write |
| POST | `/labels/{id}/categories` | Put a shared label on categories. | write |
| GET | `/ledgers/{ledger}/categories` | List categories. | read |
| PATCH | `/ledgers/{ledger}/categories/{id}` | Update a category in this ledger. | write |
| GET | `/ledgers/{ledger}/categories/sharing` | Preview joining the shared category list. | read |
| PUT | `/ledgers/{ledger}/categories/sharing` | Use the shared category list, or the ledger’s own. | write |
| POST | `/ledgers/{ledger}/categories` | Create a category. | write |
| POST | `/ledgers/{ledger}/categories/reorder` | Reorder categories. | write |
| DELETE | `/ledgers/{ledger}/categories/{id}` | Delete a category. | write |
| POST | `/ledgers/{ledger}/labels` | Create a label. | write |
| PATCH | `/ledgers/{ledger}/labels/{id}` | Update a label. | write |
| DELETE | `/ledgers/{ledger}/labels/{id}` | Delete a label. | write |
| POST | `/ledgers/{ledger}/labels/{id}/categories` | Put a label on categories. | write |
| POST | `/ledgers/{ledger}/categories/{id}/merge` | Merge a category into another. | write |
| POST | `/ledgers/{ledger}/category-groups` | Create a category group. | write |
| POST | `/ledgers/{ledger}/category-groups/reorder` | Reorder category groups. | write |
| PATCH | `/ledgers/{ledger}/category-groups/{id}` | Update a category group. | write |
| DELETE | `/ledgers/{ledger}/category-groups/{id}` | Delete a category group. | write |
| GET | `/ledgers/{ledger}/tags` | List tags. | read |
| POST | `/ledgers/{ledger}/tags` | Create a tag. | write |
| PATCH | `/ledgers/{ledger}/tags/{id}` | Update a tag. | write |
| DELETE | `/ledgers/{ledger}/tags/{id}` | Delete a tag. | write |

### Payees

How payees are named (name rules, and AI tidying of what the bank sends), and your choice of category for each.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/payees/name-rules` | List the payee name rules. | read |
| POST | `/payees/name-rules` | Add a payee name rule. | admin |
| PATCH | `/payees/name-rules/{id}` | Change a payee name rule. | admin |
| DELETE | `/payees/name-rules/{id}` | Remove a payee name rule. | admin |
| POST | `/payees/wordings/name` | Name payees as sent. | admin |
| PUT | `/payees/name-rules/order` | Order the payee name rules. | admin |
| POST | `/payees/name-rules/preview` | Preview a change to the payee name rules. | read |
| GET | `/payees/tidy` | Get AI tidying of payee names. | read |
| POST | `/payees/tidy/preview` | Preview AI tidying. | admin |
| PUT | `/payees/tidy` | Turn AI tidying on or off. | admin |
| POST | `/payees/tidy/again` | Ask AI to name payees again. | admin |
| GET | `/ledgers/{ledger}/payees` | List payee choices. | read |
| GET | `/ledgers/{ledger}/payees/search` | Search payees. | read |
| POST | `/ledgers/{ledger}/payees/rename` | Rename a payee. | write |
| GET | `/ledgers/{ledger}/payees/choice` | Get a payee choice. | read |
| PUT | `/ledgers/{ledger}/payees/choice` | Choose what happens to a payee. Accepts `?dryRun=true`. | write |

### Recurring

Bills, subscriptions, income and instalment plans, detected from history or added by hand.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/ledgers/{ledger}/recurring` | List recurring items. | read |
| GET | `/ledgers/{ledger}/recurring/upcoming` | List upcoming payments. | read |
| POST | `/ledgers/{ledger}/recurring/detect` | Detect recurring payments. | write |
| POST | `/ledgers/{ledger}/recurring` | Create a recurring item. | write |
| PATCH | `/ledgers/{ledger}/recurring/{id}` | Update a recurring item. | write |
| GET | `/ledgers/{ledger}/recurring/{id}/transactions` | List a recurring item’s payments. | read |
| POST | `/ledgers/{ledger}/recurring/{id}/link-payment` | Link a payment from another payee, or at a new amount. | write |
| GET | `/ledgers/{ledger}/recurring/{id}/payment-candidates` | Find payments to add to a recurring item. | read |
| POST | `/ledgers/{ledger}/recurring/{id}/add-payment` | Add a payment to a recurring item at its own amount. | write |
| POST | `/ledgers/{ledger}/recurring/{id}/not-payment` | Say a payment isn’t the item’s. | write |
| POST | `/ledgers/{ledger}/recurring/{id}/confirm` | Confirm a recurring item. | write |
| POST | `/ledgers/{ledger}/recurring/{id}/dismiss` | Dismiss a recurring item. | write |
| DELETE | `/ledgers/{ledger}/recurring/{id}` | Delete a recurring item. | write |

### Reports

Totals and trends. Spending is reported as positive numbers.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/ledgers/{ledger}/reports/summary` | Get a month summary. | read |
| GET | `/ledgers/{ledger}/reports/period` | Get a period summary. | read |
| GET | `/ledgers/{ledger}/reports/by-category` | Get totals by category. | read |
| GET | `/ledgers/{ledger}/reports/trend` | Get the spending trend. | read |
| GET | `/ledgers/{ledger}/reports/income-vs-expense` | Get income vs spending. | read |
| GET | `/ledgers/{ledger}/reports/payees` | Get top payees. | read |
| GET | `/ledgers/{ledger}/reports/tags` | Get totals by tag. | read |
| GET | `/ledgers/{ledger}/reports/purchases` | Get the biggest purchases, or what a filter filters out. | read |
| GET | `/ledgers/{ledger}/reports/net-worth` | Get net worth. | read |
| GET | `/ledgers/{ledger}/custom-reports` | List custom reports. | read |
| GET | `/ledgers/{ledger}/custom-reports/{id}` | Get a custom report. | read |
| POST | `/ledgers/{ledger}/custom-reports` | Save a custom report. | write |
| PATCH | `/ledgers/{ledger}/custom-reports/{id}` | Update a custom report. | write |
| PUT | `/ledgers/{ledger}/custom-reports/order` | Reorder custom reports. | write |
| DELETE | `/ledgers/{ledger}/custom-reports/{id}` | Delete a custom report. | write |

### Import

Bring in rows from a bank export. Preview first, then commit.

| Method | Path | What it does | Scope |
|---|---|---|---|
| POST | `/ledgers/{ledger}/import/preview` | Preview an import. | read |
| POST | `/ledgers/{ledger}/import/commit` | Import transactions. Accepts `?dryRun=true`. | write |
| GET | `/ledgers/{ledger}/import/batches` | List recent imports. | read |

### Categorization

Category suggestions from your history, then AI.

| Method | Path | What it does | Scope |
|---|---|---|---|
| POST | `/ledgers/{ledger}/categorize/suggest` | Suggest a category. | read |
| POST | `/ledgers/{ledger}/categorize/run` | Categorize uncategorized transactions with AI. | write |
| POST | `/ledgers/{ledger}/categorize/again` | Ask AI again about transactions’ categories. | write |
| GET | `/ledgers/{ledger}/categorize/status` | Get the AI categorization status. | read |
| GET | `/ledgers/{ledger}/ai/usage` | Get this ledger’s AI usage. | read |

### Activity

Every change made through the API, by whom.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/ledgers/{ledger}/activity` | List activity. | read |
| GET | `/ledgers/{ledger}/activity/actors` | List activity actors. | read |

### Data

Setup, the full backup, erase and export.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/backup/full` | Download a full backup. | admin |
| GET | `/ledgers/{ledger}/setup` | Get setup status. | read |
| POST | `/ledgers/{ledger}/setup/start` | Start from scratch. | write |
| POST | `/ledgers/{ledger}/setup/demo` | Load the demo data. | write |
| POST | `/ledgers/{ledger}/erase` | Erase this ledger’s data. | admin |
| GET | `/ledgers/{ledger}/export/transactions.csv` | Export transactions as CSV. | read |

### Settings

App-wide settings: time zone and AI providers.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/settings` | Get app settings. | read |
| PATCH | `/settings` | Update app settings. | admin |
| POST | `/settings/ai/test` | Test an AI provider. | admin |
| GET | `/settings/ai/chatgpt` | Get the ChatGPT sign-in. | admin |
| POST | `/settings/ai/chatgpt/sign-in` | Start signing in with ChatGPT. | admin |
| POST | `/settings/ai/chatgpt/finish` | Finish signing in with ChatGPT. | admin |
| DELETE | `/settings/ai/chatgpt` | Sign out of ChatGPT. | admin |
| GET | `/settings/ai/chatgpt/models` | List the models your ChatGPT plan offers. | admin |
| GET | `/ai/usage` | Get AI usage. | read |

### API keys

Keys for scripts and agents.

| Method | Path | What it does | Scope |
|---|---|---|---|
| GET | `/api-keys` | List API keys. | admin |
| POST | `/api-keys` | Create an API key. | admin |
| DELETE | `/api-keys/{id}` | Revoke an API key. | admin |

<!-- reference:end -->
