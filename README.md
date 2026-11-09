# Spending Tracker

A personal, self-hosted spending tracker inspired by [Lunch Money](https://lunchmoney.app). It runs on your own machine or home server, in Docker or from source. It keeps each **ledger** (say "Personal" and "Family") in its own SQLite file, syncs your banks if you want it to, and works on both desktop and phone (installable as a PWA). Everything it does goes through a documented REST API and an MCP server, so scripts and AI agents can work with your books too. It's built for one person, or one household, and has no login of its own yet: read [Security](#security) before you open it to your network.

- **Ledgers:** separate sets of books with their own accounts, categories and reports. Switch from the top of the sidebar (or the phone header). Each ledger has its own address (`/l/family/transactions`), so tabs and devices can sit in different ledgers.
- **Transactions:** quick add from a bottom sheet on your phone (or press <kbd>N</kbd> on desktop), transfers between accounts, tags, notes, search and filters, bulk edit, undo.
- **Smart categories:** the app suggests categories from the ones you've picked before, for money in and money out separately. When you set one, choose what happens to that payee: always that category (its other transactions waiting for review are done too, and new ones need no review), ask each time, or always review it yourself (for e-transfers and transfers that can be several things). Ledger settings → Payees lists your choices. New payees can go to an LLM of your choice (a primary provider and a fallback, both optional), and its suggestions wait for your review.
- **Accounts and net worth:** chequing, credit cards, cash, investments, loans and property, each under its institution (your bank, or e.g. "Wallet" for cash), which is how the sidebar groups them. Some accounts follow your transactions. Others you update by hand. Net worth history is included.
- **Recurring items:** subscriptions and bills are detected from your history for you to confirm: three payments in a row on schedule, or four of the last seven due dates (one that came early doesn't break it, nor a name the bank changed), each within 5% and a day (plus weekends) of what's expected, both adjustable. One payee can have several, like iCloud and Apple Music. Instalment plans are recurring items with a number of payments: progress, what's left and when it ends, and they end on their own after the last payment. Pay in 4 plans (Klarna, Afterpay and others) are found after two payments, named after the store when the bank's description says, and plans you've already paid off are found too, with their full price, so your history is easy to organize. Any item can have a name of its own besides its payee, shared by all its payments. Other transactions can have their own name too, like "Suitcase". Names show in the transactions table's Name column, and search finds them. The app warns when a payment is missing or the price changed, and shows the next 30 days. When the bank starts sending a slightly different payee name, it asks whether that payment is the item's, and if it is, payments under the new name match from then on.
- **Reports:** spending by month and category, income vs spending, savings rate, top payees, tag totals and CSV export. Filter what counts (by category, tag, payee, words, amount, account or recurring, or one purchase at a time), for spending and income apart, to see your regular spending without the big one-offs, and compare it with the months before or a year before. Save a filter as a custom report: it opens the same on every device, and through MCP (`get_report`).
- **CSV import:** column mapping that remembers each bank, duplicate detection, categories from history, refunds and card payments recognized, and undo.
- **Bank sync:** connect your banks through [SimpleFIN Bridge](https://www.simplefin.org/), [Plaid](https://plaid.com) or Wealthsimple (unofficial), side by side. Their transactions and balances arrive on a schedule you choose (from every hour to once a day), categorized from your history, with pending charges replaced when they post.
- **Settings:** *Ledger settings* (name and colour, which categories it uses, tags, CSV import and export, backup, restore, erase) and *App settings* (time zone, appearance, managing all ledgers with a full backup, the shared categories, bank connections, AI providers with a connection test and usage log, API keys).
- **Categories:** one shared list of groups, categories and Needs/Wants labels in App settings, reordered by dragging their handles (a category can be dragged into another group). Each ledger turns off the ones it doesn't need (choosing where their transactions go), or keeps its own list instead. Switching back matches its categories to the shared list, asking about each one the list doesn't have.
- **API:** everything the app does goes through a documented REST API (`/api/v1`, docs at `/api/docs`), so scripts and AI agents can do anything you can. Each agent gets its own API key with limited access, and **Activity** shows what each one changed.
- **MCP server:** AI agents (Claude and others) connect at `/mcp` or over stdio to search transactions, work the review queue, add transactions, and answer questions about your spending.

## Security

Spending Tracker holds your whole financial life, and the access to your banks. There's no login yet, so the server decides who's allowed in like this.

**Who can use it.** Only two things get an answer:
- **The app's own web page,** in a browser. The server checks the browser's `Sec-Fetch-Site` header (or `Origin` and `Referer` on plain HTTP over your network) to tell its own page from anything else. Other websites you visit can't call it, and a plain curl or script without a key gets 401.
- **A valid API key,** sent as `Authorization: Bearer st_…`. Scripts, agents and MCP use these. See [API](#api).

Anyone who can open the web page is treated as you. The header check stops other websites, not programs: something on your network can fake those headers. So who can reach the port is what really protects it.

**Host names.** Without a key, the server only answers at an IP address, `localhost`, a name without a dot (`nas`), or a local name (`.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`). That stops a website from pointing its own name at your server (DNS rebinding). If you open the app at another name, like `money.example.com`, add it to `ALLOWED_HOSTS` (comma-separated, and a leading dot allows subdomains: `.example.com`). Otherwise the app opens to a page saying the server won't answer at that name. Requests with an API key work at any name.

**Behind a reverse proxy.** Set `TRUSTED_AUTH_HEADER` to a header your proxy adds for people it has signed in (Tailscale Serve: `Tailscale-User-Login`, Cloudflare Access: `Cf-Access-Authenticated-User-Email`). Then requests without a key must also carry it, and a browser that reaches the app some other way gets a page asking it to come through the proxy. The server only checks that the header is there, not what it says or who added it. Anything that can reach the server's port directly can send it too, so keep the port private to the proxy: bind it to `127.0.0.1` (`HOST=127.0.0.1`, or the default `compose.yaml`) or to a private Docker network.

**The proxy must pass the browser's `Host` header on.** Without HTTPS the server tells its own page apart by comparing the page's address with that header. Caddy, Traefik, Tailscale Serve and cloudflared keep it, and nginx needs `proxy_set_header Host $host;`. A proxy that signs people in with HTTP Basic auth is fine: only `Authorization: Bearer` counts as an API key.

**Don't put it on the internet without a proxy that signs people in.** Never forward port 8787 on your router. Good options:
1. **[Tailscale Serve](https://tailscale.com/kb/1312/serve)** (the simplest): only your own devices can reach it, and it gives you HTTPS, which installing the app on a phone needs. Run `tailscale serve --bg 8787` on the server, set `TRUSTED_AUTH_HEADER=Tailscale-User-Login`, and open `https://<machine>.<tailnet>.ts.net`.
2. **Cloudflare Tunnel with Cloudflare Access**, to reach it from anywhere with a login. Add your name to `ALLOWED_HOSTS`.
3. **Caddy or Traefik with forward auth** (Authelia, Authentik) on a server of your own. Add your name to `ALLOWED_HOSTS`.

**API keys.** Give each script or agent its own key with the least access it needs. Only a hash is stored. A key limited to some ledgers can't touch anything app-wide (API keys, changing settings, bank connections, payees across ledgers, the full backup, which ledger the app opens). It only sees and links bank accounts already syncing into its ledgers, and can't restore a backup that would add categories to the shared list.

**Backups and `secret.key`.** Your data directory (`data/` from source, the `spending-data` volume in Docker) holds every ledger and `meta.db`. `secret.key` in it encrypts the access to your banks (SimpleFIN, Plaid and Wealthsimple), your Plaid secret, the ChatGPT sign-in and your AI keys. Backups leave `secret.key` out on purpose, so keep a copy of it somewhere safe and private, apart from the backups. Without it, the app works but you have to enter those keys and connect your banks again. New installs create the data directory readable only by its owner (0700, files 0600).

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Quick start with Docker

```bash
git clone https://github.com/<owner>/spending-tracker.git
cd spending-tracker
docker compose up -d
```

Then open http://localhost:8787. It builds the image the first time, and runs one container with the app, the API and the MCP endpoint.

- **Your data** lives in the `spending-data` volume, mounted at `/data`. Removing the container keeps it, `docker compose down -v` deletes it.
- **The port** is published on `127.0.0.1:8787` only, so only this machine can reach it. Put a proxy in front of it (see [Security](#security)), or change the line in `compose.yaml` to `"8787:8787"` to open it to your network.
- **Time zone:** set `TZ` for "today" and the daily jobs, e.g. `TZ=America/Toronto docker compose up -d`, or put it in `.env`. It defaults to UTC. App settings → General can also set one, and that wins.
- **Settings:** copy `.env.example` to `.env` for AI or Plaid keys and the like. Compose passes it to the container. `DATA_DIR`, `API_PORT` and `HOST` in it are ignored there, as compose sets those for the image.
- **Update:** `git pull && docker compose up -d --build`. Migrations run on start, after a copy of each database is saved in `backups/`.
- **Back up the volume:** stop it, copy `/data` out, and start it again:

  ```bash
  docker compose stop
  docker run --rm -v spending-tracker_spending-data:/data -v "$PWD":/backup busybox tar czf /backup/spending-data.tgz -C /data .
  docker compose start
  ```

  That copy includes `secret.key`, so keep it private.

The container runs as the `node` user (uid 1000). To keep the data in a folder instead of a volume, use `./data:/data` and give that folder to uid 1000 first (`sudo chown 1000:1000 data`).

## Running from source

You need Node.js 24 or newer, and pnpm 12 through Corepack. Node 24 comes with Corepack, and on Node 25 or newer install it first with `npm install -g corepack`. No build tools are needed: `better-sqlite3` ships prebuilt binaries for macOS, Linux and Windows.

```bash
corepack enable  # uses the pnpm version in package.json
pnpm install
pnpm dev         # web on http://localhost:5173, API on http://localhost:8787
```

On a fresh install the app opens on a welcome screen with three choices:
- **Start from scratch:** opens the app with the "add account" dialog.
- **Restore a backup:** upload a `.db` file from Ledger settings → Data → Download backup.
- **Explore the demo:** loads 13 months of sample data.

Add more ledgers from the ledger menu → **New ledger**. To clear one, use **Ledger settings → Data → Erase this ledger's data**, which brings its welcome screen back. Default categories are created on first start. To try it with sample data apart from your own, see the demo setup in [CONTRIBUTING.md](CONTRIBUTING.md).

### Run it like production (locally)

```bash
pnpm build       # the web app, the stdio MCP bundle and the server bundle
pnpm start       # one server for the app and the API on http://localhost:8787
```

`pnpm start` runs the bundle `pnpm build` made, so build again after you pull. It sets `NODE_ENV=production` itself.

To use it from your phone on the same network, open `http://<your-computer's-ip>:8787`. The server listens on every interface by default. Set `HOST=127.0.0.1` to keep it to this machine. Installing it as an app needs HTTPS (or `localhost`), which [Tailscale Serve](#security) gives you.

## Configuration

Copy `.env.example` to `.env` (all optional). The server reads `.env` from the repo root. In Docker, Compose passes it in.

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `data` (Docker: `/data`) | Holds `meta.db` (ledgers, app settings, bank connections), one `ledgers/<id>.db` per ledger, `secret.key` and `backups/`. A relative path is from the repo root |
| `API_PORT` | `8787` | Port for the API (and the app in production). In development the Vite dev server sends `/api` there too. Not `PORT`, which dev tools often set for the web dev server |
| `HOST` | `0.0.0.0` | Address to listen on. `0.0.0.0` is every interface, `127.0.0.1` only this machine. In Docker, leave it and choose in `compose.yaml` instead |
| `NODE_ENV` | — (`production` in `pnpm start` and Docker) | `production` serves the built web app from `apps/web/dist` and turns off request logs |
| `TZ` | your OS time zone (Docker: `UTC`) | Default time zone when App settings → General is left on "System default" |
| `TRUSTED_AUTH_HEADER` | — | A header your reverse proxy adds for signed-in people (Tailscale Serve: `Tailscale-User-Login`). When set, requests without an API key must carry it. See [Security](#security) |
| `ALLOWED_HOSTS` | — | More host names the web app may be opened at, comma-separated. A leading dot allows subdomains too (`.example.com`). IP addresses, `localhost` and local names always work. See [Security](#security) |
| `AI_PRIMARY_KIND` / `_MODEL` / `_API_KEY` / `_BASE_URL` | — | Overrides App settings → AI → Primary. `KIND` is `anthropic`, `openai`, `openrouter`, `gemini`, `mistral`, `groq`, `deepseek`, `xai`, `local` or `openai-compatible` (the only one that uses `_BASE_URL`). `KIND` and `MODEL` are both needed, and the server warns at startup when one is missing or wrong |
| `AI_FALLBACK_KIND` / `_MODEL` / `_API_KEY` / `_BASE_URL` | — | Overrides App settings → AI → Fallback |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | — | Overrides the Plaid keys in App settings → Bank sync. `PLAID_ENV` is `sandbox` (default) or `production` |

For development only:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5173` | Port for the Vite dev server |
| `VITE_ALLOWED_HOSTS` | — | More host names the Vite dev server answers to, comma-separated (it always allows localhost, `.localhost`, `.local`, `.ts.net` and IP addresses). Read from your shell, not from `.env` |
| `ST_API_URL` / `ST_API_KEY` | `http://localhost:8787` / — | Where the stdio MCP server finds the API, and the key it uses. See [MCP](#mcp-for-ai-agents) |

### AI categorization

AI is off until you add a provider in **App settings → AI** (or through the env vars above):

- **Hosted:** Claude (Anthropic), OpenAI, OpenRouter, Google Gemini, Mistral, Groq, DeepSeek or xAI. Pick the provider, a model (e.g. `claude-opus-5-5`, or `claude-haiku-4-5` for lower cost) and your API key. The URL is built in.
- **Sign in with ChatGPT:** choose *OpenAI (sign in with ChatGPT)* and **Continue with ChatGPT** to use your ChatGPT plan instead of an API key. Requests count toward your plan's usage. OpenAI sends you back to `http://127.0.0.1:<the server's port>/auth/callback`, which finishes it on its own when your browser is on the same machine as the server. Otherwise, copy the address of the page you end on and paste it into the form. This one is set up in the app only, not through the env vars.
- **Local LLM:** a local [Ollama](https://ollama.com) server at `localhost:11434` (model e.g. `llama3.2`, no key).
- **OpenAI-compatible:** any other server that speaks the OpenAI chat API (LM Studio, vLLM, a gateway, or Ollama on another machine or outside Docker). It's the only option where you give the URL. Changing the URL to another server, or the provider, clears the saved key, so enter it again.

The fallback is optional: set it to *None* to use the primary provider only. Setting the primary provider to *None* turns AI off, and the fallback with it. API keys and the ChatGPT sign-in are stored encrypted with the key in `secret.key`.

Use **Test connection** to check a provider. Only the payee, amount, date, account type, notes and your category names are sent. Account names, numbers and balances never are.

## Bank sync

Add any of these services in **App settings → Bank sync**. They work side by side, each with its own connections and schedule:

- **[SimpleFIN Bridge](https://bridge.simplefin.org)** (US$15 a year, up to 25 banks) reaches most Canadian banks (RBC, TD, Scotiabank, Wealthsimple, Tangerine and more) through MX. [Check yours](https://bridge.simplefin.org/search-institutions). Rogers Bank, for one, isn't available. You connect your banks on SimpleFIN's site, and the app reads them all through one connection.
- **[Plaid](https://plaid.com)** with your own API keys. Plaid's free Trial plan (US and Canada) covers 10 bank logins. You sign in to each bank in Plaid's own window, and the first sync brings up to two years of history.
- **Wealthsimple** (unofficial), with your Wealthsimple sign-in. See [below](#wealthsimple-unofficial) before you use it.

Choose how often each one syncs under **Sync**: every 6 hours by default for SimpleFIN (every 2 hours at the most), every 2 hours for Wealthsimple and every hour for Plaid.

**Remove…** in a service's menu removes all its connections (for Plaid, ending its access to your banks, and deleting your Plaid keys). Their accounts stop syncing, and the transactions already synced stay.

### SimpleFIN Bridge

1. Sign up at SimpleFIN Bridge and connect your banks there.
2. Create a setup token (Bridge → *New app connection*) and paste it into **App settings → Bank sync**.

SimpleFIN allows about 24 updates a day, so the app stays under 20 per connection and syncs every 2 hours at the most. It signs in to your bank on your behalf, and some banks only guarantee fraud losses if you never share your password, so check your bank's online banking agreement.

### Plaid

1. Sign up at [Plaid](https://dashboard.plaid.com/signup) and copy your client ID and a secret from *Developers → Keys*: the Sandbox secret to try it with Plaid's test banks (sign in with `user_good` / `pass_good`), or the Production one for your real banks.
2. Add **Plaid** in **App settings → Bank sync**, save the keys with the matching environment (or set the `PLAID_*` variables), and choose **Connect a bank**.
3. Sign in to your bank in Plaid's window. Each bank login becomes one connection. When a bank wants you to sign in again, its connection shows **Reconnect**.

Plaid itself checks your bank 1 to 4 times a day, so syncing more often than hourly wouldn't bring transactions sooner. **Sync now** gets what Plaid already has.

### Wealthsimple (unofficial)

Wealthsimple has no public API. This uses the private API Wealthsimple's own web app uses, following the open-source [ws-api-python](https://github.com/gboudreau/ws-api-python). It isn't made or supported by Wealthsimple, it can break or be blocked at any time, and using it may go against Wealthsimple's terms. Use it at your own risk, or reach Wealthsimple through SimpleFIN instead.

1. Add **Wealthsimple** in **App settings → Bank sync**.
2. Sign in with your Wealthsimple email, password and 2FA code.

The password is used once and never stored. Only the session is kept, encrypted with `secret.key`. It's read-only: the app sees your accounts, balances and activity, and can't move money. When Wealthsimple ends the session, sign in again.

### Linking accounts

Set each account to synced in its own settings (**Edit account → Updates → Synced**, then pick the bank account), or use **Add as account** in App settings → Bank sync for a new one. Transactions you already have are matched, not duplicated.

Synced or manual is part of an account's settings, and you can switch either way at any time: going manual keeps every transaction (they just stop updating), and going back to synced picks up where it left off without duplicates.

What happens on each sync (on your schedule, or **Sync now**):
- New transactions are added and categorized from your history (and AI, if it's set up). They show up in the review queue like an import.
- Your edits stick: the bank updates dates, amounts and pending status, but never your payee, category, notes or tags. Correct a synced transaction's amount or date (when the bank got it wrong) and syncs leave those alone too, and don't remove it. **Resume syncing** in the transaction undoes that.
- What the bank sends for each transaction is kept as it sent it (the service's JSON), when it's new and each time it changes or is removed. Open a synced transaction and choose **See what the bank sent**, or call `GET /api/v1/ledgers/{ledger}/transactions/{id}/bank-data`.
- **Fetch all history** (in a connection's ⋯ menu, after a confirmation) asks for everything again instead of only what's new: up to 2 years from Plaid, the last 90 days from SimpleFIN. Nothing is added twice.
- A pending charge that posts (even under a new id or a slightly different amount) updates the same transaction. Pending charges that disappear are removed.
- Transactions you had entered or imported are matched instead of added twice.
- A synced account's balance is always the bank's. Investment, loan and property accounts take the bank's balance instead of importing transactions. For the others, each sync moves the opening balance so the transactions add up to what the bank shows. Only manual accounts can have their balance set by hand.
- Each sync is in **Activity** as *SimpleFIN sync*, *Plaid sync* or *Wealthsimple sync*.
- A service that doesn't answer within 30 seconds fails that sync with a message, and the next one tries again.

After each sync and CSV import, the app also recognizes:
- **Refunds:** money back on the same account from a merchant you bought from in the last 60 days. It takes that purchase's category (and follows it if you change it), so spending nets out, and shows a **Refund** mark. The same amount is applied outright. A partial refund ($1 or more) is suggested for review. Interac e-Transfers are money to and from people, so they're never refunds.
- **Credit card payments:** other money onto a credit card, except cash back, rewards and credits from a merchant you buy from. It's paired as a transfer with the withdrawal from chequing or savings that paid it (the same amount, within 5 days), so neither side counts as spending or income. Without one, it goes in your *Credit card payment* category, or *Transfer*, or stays uncategorized. A category your history is sure of (cash back, say) stays.
- **The bank's category:** Plaid sends one with each transaction. AI sees it as a second opinion. When Plaid is sure, the AI agrees and is fairly sure itself, the category is applied without review. It's shown in the transaction's details.

These only change what's uncategorized or still waiting for your review, never a category you chose or accepted. To run them over all your existing transactions, use `POST /api/v1/ledgers/{ledger}/transactions/match` (add `?dryRun=true` to preview the counts). **Not a refund** and **Not a transfer** in a transaction's details undo a match, and it isn't made again.

The access each connection gives the app, and your Plaid secret, are stored encrypted with `secret.key`, which backups leave out.

## API

The web app and any scripts or agents share one API, so anything you can do in the app is available to them.

- **Docs:** open `/api/docs` for interactive docs (the spec is at `/api/v1/openapi.json`). Ledger data lives under `/api/v1/ledgers/{ledger}/…`, where `{ledger}` is the slug from the app's URL (e.g. `personal`).
- **Keys:** create one per script or agent in **App settings → API keys** and send it as `Authorization: Bearer st_…`. Choose **Read only**, **Read and write**, or **Full access** (ledgers, settings, API keys, restore and erase), optionally limited to some ledgers and with an expiry. A key limited to some ledgers can't use anything app-wide. The key is shown once, and only a hash is stored.
- **Activity:** every change records who made it (`web` or the key's name) and the fields before and after. See it under **Activity** in each ledger, filterable by who and what.
- **Safe for agents:** send an `Idempotency-Key` header on a POST to make retries harmless, give transactions an `externalId` so the same one is never added twice, and add `?dryRun=true` to bulk edits and imports to see what would change first.
- **Limits:** a JSON request can be up to 1 MB. Restores, imports and `/mcp` can be up to 200 MB.

```bash
curl -H "Authorization: Bearer $ST_API_KEY" http://localhost:8787/api/v1/ledgers/personal/reports/summary
```

**Who needs a key.** Everything except the app's own web page. A request without a key from curl, a script or another website gets 401. See [Security](#security) for how the page is told apart, and for `TRUSTED_AUTH_HEADER` behind a proxy.

## MCP (for AI agents)

Spending Tracker is also an [MCP](https://modelcontextprotocol.io) server, so an agent can work with your books directly: "what did I spend on dining out last month?", "work through my review queue", "add these receipts". It goes through the API with the agent's own key, so the key's access applies, and everything it changes shows up in **Activity** under the key's name.

1. Create a key in **App settings → API keys** (*Read only* for questions, *Read and write* to change things), limited to one ledger if you like.
2. Connect the agent.

**Over HTTP** (simplest, nothing to install). The endpoint is `/mcp` on the app's server, and it always needs a key:

```bash
claude mcp add --transport http spending http://localhost:8787/mcp --header "Authorization: Bearer st_…"
```

```ts
// Claude Agent SDK
mcpServers: {
  spending: { type: 'http', url: 'http://localhost:8787/mcp', headers: { Authorization: `Bearer ${process.env.ST_API_KEY}` } },
}
```

**Over stdio**, for agents that start their tools as processes. Build it once with `pnpm build` (or `pnpm --filter @st/mcp build`), then point the agent at the bundled file. It needs a key too:

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

**What agents get**
- **Tools** (an agent only sees the ones its key allows): `list_ledgers`, `get_month_summary`, `get_net_worth`, `search_transactions`, `get_transaction`, `list_review_queue`, `list_accounts`, `list_categories`, `list_tags`, `list_recurring`, `upcoming_payments`, `spending_by_category`, `spending_trend`, `top_payees`, `income_vs_spending`, `list_custom_reports`, `get_report` (read). `add_transactions`, `update_transaction`, `link_transactions`, `set_categories`, `accept_suggestions`, `set_payee_choice`, `delete_transactions`, `create_account`, `update_account`, `rename_institution`, `record_balance`, `create_category`, `update_category`, `merge_category`, `label_categories`, `rename_tag`, `confirm_recurring`, `dismiss_recurring`, `create_recurring`, `save_custom_report`, `delete_custom_report`, `import_transactions`, `sync_banks` (write). `create_ledger`, `archive_ledger` (full access).
- Tools take accounts and categories by name, amounts in dollars, and an optional `ledger`. Results include both a readable summary and structured data. Bulk tools accept `dryRun`, and `add_transactions` uses `externalId` so retries never add duplicates.
- **Resources:** `ledger://{ledger}/categories` and `ledger://{ledger}/accounts`. **Prompts:** *Monthly review* and *Work through the review queue*.
- Erasing or restoring data, deleting a ledger and managing API keys are deliberately left out: those stay in the app.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | API (tsx watch) and web (Vite) together |
| `pnpm build` | Production build: the web app, the stdio MCP bundle and the server bundle (`apps/server/dist/index.mjs`) |
| `pnpm start` | One server for the app and the API, from the bundle `pnpm build` made |
| `pnpm mcp:stdio` | Run the MCP server over stdio from source (`ST_API_URL`, `ST_API_KEY`) |
| `pnpm test` | Vitest: shared utilities, the server (services, API, security, scopes, idempotency, AI fallback) and MCP (with a real MCP client) |
| `pnpm typecheck` | `tsc` for shared, MCP and server, `vue-tsc` for web |
| `pnpm seed:demo [--force] [--ledger <slug>]` | Load sample data into the default (or named) ledger of `DATA_DIR`. It refuses a ledger that has data (accounts, transactions, recurring items, reports or tags) unless you pass `--force`, which first saves that ledger in `backups/` and then replaces all of those. Use a separate `DATA_DIR` for it (see [CONTRIBUTING.md](CONTRIBUTING.md)) |
| `pnpm db:generate` | Create migrations after editing `apps/server/src/db/schema.ts` (ledgers) or `meta-schema.ts` (app-wide). Each folder starts from `0000_baseline.sql`: the earlier migrations squashed into one. A database from before the squash that missed some of them can't be upgraded, so the app refuses it |

## Project layout

```
apps/
  server/   Hono API (/api/v1, OpenAPI from the route definitions), Drizzle + better-sqlite3, services, AI providers, jobs
  web/      Vue 3 + Vite SPA, shadcn-vue + Tailwind 4, PWA
  mcp/      MCP server (tools, resources, prompts) over the API, served at /mcp and as a stdio bundle
packages/
  shared/   Zod schemas for requests and responses (and the types from them), money/date utils, payee normalizer, CSV parsing
data/       meta.db, ledgers/<id>.db (one SQLite file per ledger), backups/ and secret.key (git-ignored)
Dockerfile, compose.yaml   the Docker image and how to run it
```

## Backups

- **Ledger settings → Data → Download backup** gives you a consistent copy of that ledger. **App settings → Ledgers → Full backup** zips every ledger plus `meta.db`. To move machines, stop the server and unzip it into the data directory.
- **Ledger settings → Data → Restore from backup** (or the welcome screen, or New ledger → From a backup) puts a backup into a ledger. Older backups are upgraded to the current version first.
- Before a migration, restore, erase, ledger deletion or `pnpm seed:demo --force`, the server saves a copy in `backups/` in the data directory.
- Backups don't include `secret.key`, so bank connections, the ChatGPT sign-in and the AI and Plaid keys don't come along. After moving machines, either copy that file over as well, or enter the keys again and reconnect your banks (SimpleFIN with a new setup token, Plaid in its window, Wealthsimple by signing in). If the server finds saved secrets it can't read at startup, it says how many in its log.
- In Docker, see [Back up the volume](#quick-start-with-docker).

## Notes

- **TypeScript is pinned to 6.x.** TypeScript 7 (the Go port) has no JS API, and Vue's SFC compiler needs that API to resolve shadcn-vue's imported prop types. `vite.config.ts` registers TypeScript with the compiler explicitly, because pnpm's strict layout hides it.
- **The API reads `API_PORT`, not `PORT`.** Dev tools often set `PORT` for the web dev server.
- **Amounts** are stored as integer cents. The base currency is CAD, and the schema already stores a currency per account and transaction for multi-currency later.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please never put real financial data in an issue, a test or a screenshot.

## License

See [LICENSE](LICENSE).
