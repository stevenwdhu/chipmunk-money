# Changelog

What changed in each release of Spending Tracker. Versions follow [Semantic Versioning](https://semver.org), and [docs/releasing.md](docs/releasing.md) says how a release is made. Docker images are on `ghcr.io/stevenwdhu/spending-tracker` under each version.

## Unreleased

### Added

- **Add a payment** to a recurring item by hand, at its own amount: an instalment plan's down payment, a first payment that covers part of a period, or a last payment that's the remainder. It counts and takes the item's category, and the usual amount stays.
- **A plan's full price** (optional). It predicts the last payment, for what's left and what's coming up. It keeps two plans from one payee apart, giving each its own payment. It finds a missing down payment when that makes the payments add up to the full price exactly.
- A plan's last payment at a smaller amount is asked about as its last payment, not a new price.
- The demo has two instalment plans, and its regular bills are confirmed.

### Changed

- A plan doesn't take a payment much later than its due date without asking: it may be another plan's.
- Docker images are published for releases only, not for every commit: `:latest` is the newest release.
- The README is a shorter introduction with screenshots. The details moved to pages in `docs/`, with every API endpoint and MCP tool listed from the code.

### Fixed

- A plan whose last payment was a little smaller lost its earlier payments the next time it was edited, or when the Scan found it paid off and you confirmed it.
- The Scan no longer suggests a coffee you buy at one price most weekdays as a weekly or semi-monthly payment.
- Creating a recurring item with an account or category that doesn't exist is a clear error, not a server error.

## 0.1.0 (2026-11-09)

The first release: the first Docker image. Everything the [README](README.md) described then, including:

- Ledgers, each its own SQLite file, with accounts, categories, tags and reports of their own.
- Bank sync through SimpleFIN Bridge, Plaid and Wealthsimple, side by side, on a schedule you choose.
- Categories suggested from your history, a choice per payee (always, ask, or review), and AI for new payees: hosted providers, ChatGPT sign-in, or a local model with Ollama at a URL of your own, including models without structured output or that think first.
- Recurring payments found in your history, with alerts for missing payments and price changes, and instalment plans with their progress.
- Reports with filters, comparisons and saved custom reports, CSV import and export, backups and restore.
- A REST API with interactive docs, and an MCP server for AI agents, each with its own API key.
- A Docker image for amd64 and arm64.
