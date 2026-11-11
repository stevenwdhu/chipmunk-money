# Changelog

What changed in each release of Spending Tracker. Versions follow [Semantic Versioning](https://semver.org), and [docs/releasing.md](docs/releasing.md) says how a release is made. Docker images are on `ghcr.io/stevenwdhu/spending-tracker` under each version.

## Unreleased

The first release. Everything the [README](README.md) describes, including:

### Added

- Ledgers, each its own SQLite file, with accounts, categories, tags and reports of their own.
- Bank sync through SimpleFIN Bridge, Plaid and Wealthsimple, side by side, on a schedule you choose.
- Categories suggested from your history, a choice per payee (always, ask, or review), and AI for new payees: hosted providers, ChatGPT sign-in, or a local model with Ollama.
- Recurring payments found in your history, with alerts for missing payments and price changes.
- Instalment plans: progress, what's left and when they end. A payment at an amount of its own, like a down payment or a last payment that's the remainder, can be added by hand. A full price predicts the last payment, keeps two plans from one payee apart, and finds a missing down payment.
- Reports with filters, comparisons and saved custom reports, CSV import and export, backups and restore.
- A REST API with interactive docs, and an MCP server for AI agents, each with its own API key.
- A Docker image for amd64 and arm64.
