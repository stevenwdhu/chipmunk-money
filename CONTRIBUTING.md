# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome. For anything big, open an issue first so we can agree on the shape before you write it.

**Never put real financial data in an issue, a test, a fixture or a screenshot.** That means real payee names, amounts, account numbers, bank exports or backups, yours or anyone's. Make up names, places and amounts instead, and take screenshots from the demo data below. `pnpm screenshots` retakes the README's from it.

## Setup

You need Node.js 24 or newer and pnpm 12 through Corepack. Node 24 comes with Corepack, and on Node 25 or newer install it first with `npm install -g corepack`.

```bash
corepack enable
pnpm install
pnpm dev         # web on http://localhost:5173, API on http://localhost:8787
```

`pnpm dev` uses `data/` in the repo, so keep your own books out of the way while you work: use a separate data directory (below), or a separate clone.

## Demo data

To work against sample data without touching your own ledgers, give the demo its own `DATA_DIR` and port. `.demo-data/` is git-ignored.

```bash
DATA_DIR=.demo-data pnpm seed:demo                   # 13 months of sample data in a new data directory
DATA_DIR=.demo-data API_PORT=8788 pnpm dev            # the app on that data, API on 8788
```

`pnpm seed:demo` refuses a ledger that already has data (accounts, transactions, recurring items, reports or tags). `--force` saves a copy of that ledger in `backups/` first, then replaces all of those. `--ledger <slug>` picks another ledger. A relative `DATA_DIR` is from the repo root.

With `API_PORT=8788`, the Vite dev server proxies `/api` there. If 5173 is taken too, set `PORT` for Vite.

## Tests and checks

```bash
pnpm test        # Vitest: shared, server and MCP
pnpm typecheck   # tsc for shared, MCP and server, vue-tsc for web
pnpm build       # the web app, the stdio MCP bundle and the server bundle
```

All three run in CI when a push to `main` or a pull request changes code. The Docker image is built only for a release, so if you change the `Dockerfile`, run `docker build .` too. Please run them before you open a pull request.

- Server tests open their databases in memory or in a temporary folder, never in `data/`. Use the helpers in `apps/server/src/test/`.
- Tests never call the real network. Bank, Plaid, Wealthsimple, ChatGPT and AI tests pass in a fake `fetch`.
- Request helpers send `sec-fetch-site: same-origin`, as a browser on the app's page would. Without it, a keyless request gets 401.

## Code style

- TypeScript everywhere, Vue 3 single-file components on the web.
- Prettier settings are in `.prettierrc.json`: no semicolons, single quotes, 110 columns.
- Match the code around you: its naming, its comment density, its idioms.
- Messages people see (errors, toasts, UI text) are plain, short sentences, with no semicolons.
- Changing the database: edit `apps/server/src/db/schema.ts` (and `src/db/tables.ts` for a new table), then run `pnpm db:generate` and commit the migration with it. Views and triggers are written by hand into the migration.
- TypeScript stays on 6.x for now (see Notes in [docs/development.md](docs/development.md)).

## Commits and pull requests

- Short, one-line [conventional commits](https://www.conventionalcommits.org), which also decide the next version (see [docs/releasing.md](docs/releasing.md)): `feat: …`, `fix: …`, `docs: …`, `test: …`, `chore: …`, with a scope when it helps (`feat(web): …`, `fix(mcp): …`). Say what changed for the person using the app, e.g. `fix: refunds of uncategorized purchases show in the Uncategorized list`.
- One change per pull request. Add or update tests for what you changed, and the README or the page in [docs/](docs) when behaviour or configuration changes. A change to an API endpoint or MCP tool also needs `pnpm docs:update`, which updates their lists in `docs/` (a test fails until you do), and the guide around them in [docs/api.md](docs/api.md) or [docs/mcp.md](docs/mcp.md) when how to use them changes.
- Security problems go through [SECURITY.md](SECURITY.md), not a public issue or pull request.
