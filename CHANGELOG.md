# Changelog

What changed in each release of Chipmunk, called Spending Tracker before the rename. Versions follow [Semantic Versioning](https://semver.org), and [docs/releasing.md](docs/releasing.md) says how a release is made. Docker images are on `ghcr.io/stevenwdhu/chipmunk-money` under each version (`ghcr.io/stevenwdhu/spending-tracker` up to v0.2.3).

## Unreleased

### Breaking

- **Every ledger is now in one database, `chipmunk.db`,** in place of `meta.db` and a file per ledger in `ledgers/`. A data folder from v0.2.3 isn't read by this version: it has to be converted once, with the app stopped. Keep `secret.key` next to `chipmunk.db`.
- **One-ledger backup and restore are removed.** The only backup is the full backup, a zip of `chipmunk.db` with every ledger, in App settings → Ledgers and Ledger settings → Data. Restoring it is done by hand, and the Restore button shows the steps (also in [docs/self-hosting.md](docs/self-hosting.md#backups)).
- One-ledger backup files from v0.2.3 or earlier can't be restored by this version. Restore one with v0.2.3 first, then update. The same goes for the `deleted-…` and `pre-restore-…` files in `backups/`, and any other copy there made before updating: each holds one ledger, so it can't be put in place of `chipmunk.db`. The `pre-migrate-…`, `pre-delete-…`, `pre-erase-…` and `pre-seed-demo-…` copies made by this version or later are whole databases.
- **Undo of a CSV import is removed,** in the app and the API (`DELETE /import/batches/{id}`). To take an import back, select its transactions and delete them. Recent imports stays as a list of what was imported and when, without the count of rows still there (`remaining`).

### Added

- **Shared accounts.** A credit card used by two sets of books can be in both ledgers: **Share with…** in the account's menu. Each transaction on it is in one ledger, each ledger's balance on the card is what it holds, and together they're what the bank says you owe. One ledger is the card's home, where new transactions from sync and CSV land and its settings are changed, and the home can be changed. Credit cards only for now. [docs/features.md](docs/features.md#shared-accounts) has all of it.
- **Move to…** sends a shared account's transactions to another ledger that has it, from a transaction, the bulk bar or the account's list. That ledger treats them as new: it keeps the category when it has one of the same name, and matches refunds, transfers and recurring payments of its own. The app says first what doesn't go along (a link, a transfer's other side, a recurring item).
- **This ledger / All ledgers** on a shared account's page: this ledger's transactions, or every ledger's with the whole account's balance after each, like the bank's statement. Accounts shows this ledger's balance with the account's total under it.
- **Split between ledgers…** on a card payment gives each ledger its part of it, so each one's balance on the card goes down by what it paid. Each ledger counts its share as a card payment, not spending or income.
- **Stop sharing** asks what happens to that ledger's transactions: they move to the home, or stay in that ledger on a new manual account. Each choice shows the balances it gives before you save.
- Deleting, erasing or archiving a ledger that has a shared account asks first which ledger becomes the card's home and whether its transactions are deleted or moved, and lists what else will change.
- Bank sync, Fetch all history, switching the bank account and CSV import know a shared account's transactions in every ledger. One held by another ledger is updated where it is, never added twice, and the import marks it **Already in another ledger**. The review before switching names the ledger of each transaction.
- **Update balance** on a shared account shows what the new balance gives each ledger before it's saved.
- In the API: `GET` and `PUT /accounts/{id}/sharing`, `POST /transactions/move`, `PUT /transactions/{id}/split`, `GET /accounts/{id}/transactions`, `GET /ledgers/{ledger}/questions`, and `answers` when deleting, erasing or archiving a ledger. In MCP: `share_account`, `move_transactions`, `split_transaction`, `list_account_transactions`, and `answers` for `archive_ledger`. A key limited to some ledgers needs every ledger a call touches ([docs/security.md](docs/security.md)).

### Changed

- **Spending Tracker is now Chipmunk**, and the project is Chipmunk Money: the repo is `stevenwdhu/chipmunk-money` and the image `ghcr.io/stevenwdhu/chipmunk-money`. Set the new image in your compose file to get this release.
- A new icon: a C of a chipmunk's stripes around an acorn.
- The shared category list is stored once for every ledger, not copied into each one.
- New API keys start with `cm_`. Keys made before keep working.
- The stdio MCP server reads `CHIPMUNK_API_URL` and `CHIPMUNK_API_KEY`, in place of `ST_API_URL` and `ST_API_KEY`.
- Deleting a ledger, erasing it or `pnpm seed:demo --force` first saves a copy of the whole database in `backups/`, every ledger and the sealed bank sign-ins included, in place of a copy of that ledger alone. These copies are never deleted for you, so clear out old ones now and then.

### Fixed

- A bank connection whose saved sign-in was made with another `secret.key` now says so, and what to do, in place of "bad decrypt".
- Counts of one read right: "1 transaction", "1 row found", "1 payment".

## v0.2.3 (2026-11-10)

### Fixed

- The Overview's transactions fill their card on a wide screen, as many as fit beside the cards on the right, not just the latest 8.

### Changed

- Release images build faster: the app is built once for both amd64 and arm64, and the checks run side by side.

## v0.2.2 (2026-11-10)

### Changed

- Versions are written with a v, like v0.2.2: in App settings, here, and in the release titles.
- A release's checks run once, on its tag. Pushes that change only docs run nothing.

## v0.2.1 (2026-11-10)

### Added

- The app's version in App settings, under About, with a link to what's new in it.

### Fixed

- Review on the Overview opens every transaction to review, not just this month's, as many as the banner counts.

## v0.2.0 (2026-11-10)

### Added

- **Add a payment** to a recurring item by hand, at its own amount: an instalment plan's down payment, a first payment that covers part of a period, or a last payment that's the remainder. It counts and takes the item's category, and the usual amount stays.
- **A plan's full price** (optional). It predicts the last payment, for what's left and what's coming up. It keeps two plans from one payee apart, giving each its own payment. It finds a missing down payment when that makes the payments add up to the full price exactly.
- A plan's last payment at a smaller amount is asked about as its last payment, not a new price.
- The demo has two instalment plans, one with a full price, and its regular bills are confirmed.

### Changed

- A plan doesn't take a payment much later than its due date without asking: it may be another plan's.
- Docker images are published for releases only, not for every commit: `:latest` is the newest release.
- The README is a shorter introduction with screenshots. The details moved to pages in `docs/`, with every API endpoint and MCP tool listed from the code.

### Fixed

- A plan whose last payment was a little smaller lost its earlier payments the next time it was edited, or when the Scan found it paid off and you confirmed it.
- The Scan no longer suggests a coffee you buy at one price most weekdays as a weekly, biweekly or semi-monthly payment.
- Creating a recurring item with an account or category that doesn't exist is a clear error, not a server error.

## v0.1.0 (2026-11-09)

The first release: the first Docker image. Everything the [README](README.md) described then, including:

- Ledgers, each its own SQLite file, with accounts, categories, tags and reports of their own.
- Bank sync through SimpleFIN Bridge, Plaid and Wealthsimple, side by side, on a schedule you choose.
- Categories suggested from your history, a choice per payee (always, ask, or review), and AI for new payees: hosted providers, ChatGPT sign-in, or a local model with Ollama at a URL of your own, including models without structured output or that think first.
- Recurring payments found in your history, with alerts for missing payments and price changes, and instalment plans with their progress.
- Reports with filters, comparisons and saved custom reports, CSV import and export, backups and restore.
- A REST API with interactive docs, and an MCP server for AI agents, each with its own API key.
- A Docker image for amd64 and arm64.
