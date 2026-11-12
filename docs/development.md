# Development

Setting up, the demo data and how to contribute are in [CONTRIBUTING.md](../CONTRIBUTING.md). This page is the reference: scripts, the project's layout, and a few notes.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | API (tsx watch) and web (Vite) together |
| `pnpm build` | Production build: the web app, the stdio MCP bundle and the server bundle (`apps/server/dist/index.mjs`) |
| `pnpm start` | One server for the app and the API, from the bundle `pnpm build` made |
| `pnpm mcp:stdio` | Run the MCP server over stdio from source (`CHIPMUNK_API_URL`, `CHIPMUNK_API_KEY`) |
| `pnpm test` | Vitest: shared utilities, the server (services, API, security, scopes, idempotency, AI fallback) and MCP (with a real MCP client) |
| `pnpm typecheck` | `tsc` for shared, MCP and server, `vue-tsc` for web |
| `pnpm seed:demo [--force] [--ledger <slug>]` | Load sample data into the default (or named) ledger of `DATA_DIR`. It refuses a ledger that has data (accounts, transactions, recurring items, reports or tags) unless you pass `--force`, which first saves a copy of the whole database in `backups/` and then replaces all of those. A ledger that has a shared account is refused even with `--force`: erase it in the app first. Use a separate `DATA_DIR` for it (see [CONTRIBUTING.md](../CONTRIBUTING.md)) |
| `pnpm screenshots` | Retake the README's screenshots in `docs/images/` from the demo data, in light and dark, with your installed Chrome. Run `pnpm build` first. `pnpm screenshots reports` retakes only the ones whose names start with that |
| `pnpm docs:update` | Update the endpoint list in [docs/api.md](api.md) and the tool list in [docs/mcp.md](mcp.md) from the code. A test fails when they're out of date |
| `pnpm db:generate` | Create a migration in `apps/server/drizzle/` after editing `apps/server/src/db/schema.ts`. There's one schema and one migrations folder for the whole database. The folder starts from `0000_baseline.sql`, whose views and triggers are written by hand at its end |

## Project layout

```
apps/
  server/   Hono API (/api/v1, OpenAPI from the route definitions), Drizzle + better-sqlite3, services, AI providers, jobs
  web/      Vue 3 + Vite SPA, shadcn-vue + Tailwind 4, PWA
  mcp/      MCP server (tools, resources, prompts) over the API, served at /mcp and as a stdio bundle
packages/
  shared/   Zod schemas for requests and responses (and the types from them), money/date utils, payee normalizer, CSV parsing
docs/       api.md and mcp.md: using the API and connecting agents, with every endpoint and tool
data/       chipmunk.db (one SQLite database for every ledger), backups/ and secret.key (git-ignored)
Dockerfile, compose.yaml   the Docker image and how to run it
```

## Notes

- **TypeScript is pinned to 6.x.** TypeScript 7 (the Go port) has no JS API, and Vue's SFC compiler needs that API to resolve shadcn-vue's imported prop types. `vite.config.ts` registers TypeScript with the compiler explicitly, because pnpm's strict layout hides it.
- **The API reads `API_PORT`, not `PORT`.** Dev tools often set `PORT` for the web dev server.
- **One database.** Every ledger is in `chipmunk.db`, and each row of a ledger's data carries its `ledger_id`. Services reach it through `ctx.q` (`src/db/scope.ts`), which checks each statement for a ledger pin before preparing it (`src/db/pins.ts`) and binds `@ledger` itself. Write guards on the connection refuse a write to another ledger's rows. The app-wide tables go through `ctx.app.db`. Code outside `src/db/` doesn't use better-sqlite3 directly, and the few places that work on every ledger at once are listed, with why, in `src/db/unscoped-sites.ts`. Tests check all three, and `src/isolation.test.ts` runs every route and MCP tool on two ledgers seeded alike to check that neither sees or changes the other.
- **Amounts** are stored as integer cents. The base currency is CAD, and the schema already stores a currency per account and transaction for multi-currency later.
