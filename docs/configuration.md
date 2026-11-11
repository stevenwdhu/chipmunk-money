# Configuration

Copy `.env.example` to `.env` (all optional). The server reads `.env` from the repo root. In Docker, Compose passes it in.

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `data` (Docker: `/data`) | Holds `chipmunk.db` (one SQLite database with every ledger, the app settings and the bank connections), `secret.key` and `backups/`. A relative path is from the repo root |
| `API_PORT` | `8787` | Port for the API (and the app in production). In development the Vite dev server sends `/api` there too. Not `PORT`, which dev tools often set for the web dev server |
| `HOST` | `0.0.0.0` | Address to listen on. `0.0.0.0` is every interface, `127.0.0.1` only this machine. In Docker, leave it and choose in `compose.yaml` instead |
| `NODE_ENV` | — (`production` in `pnpm start` and Docker) | `production` serves the built web app from `apps/web/dist` and turns off request logs |
| `TZ` | your OS time zone (Docker: `UTC`) | Default time zone when App settings → General is left on "System default" |
| `TRUSTED_AUTH_HEADER` | — | A header your reverse proxy adds for signed-in people (Tailscale Serve: `Tailscale-User-Login`). When set, requests without an API key must carry it. See [Security](security.md) |
| `ALLOWED_HOSTS` | — | More host names the web app may be opened at, comma-separated. A leading dot allows subdomains too (`.example.com`). IP addresses, `localhost` and local names always work. See [Security](security.md) |
| `AI_PRIMARY_KIND` / `_MODEL` / `_API_KEY` / `_BASE_URL` | — | Overrides App settings → AI → Primary (see [AI categorization](ai.md)). `KIND` is `anthropic`, `openai`, `openrouter`, `gemini`, `mistral`, `groq`, `deepseek`, `xai`, `local` or `openai-compatible` (the only one that uses `_BASE_URL`). `KIND` and `MODEL` are both needed, and the server warns at startup when one is missing or wrong |
| `AI_FALLBACK_KIND` / `_MODEL` / `_API_KEY` / `_BASE_URL` | — | Overrides App settings → AI → Fallback |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | — | Overrides the Plaid keys in App settings → Bank sync (see [Bank sync](bank-sync.md)). `PLAID_ENV` is `sandbox` (default) or `production` |

For development only:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5173` | Port for the Vite dev server |
| `VITE_ALLOWED_HOSTS` | — | More host names the Vite dev server answers to, comma-separated (it always allows localhost, `.localhost`, `.local`, `.ts.net` and IP addresses). Read from your shell, not from `.env` |
| `CHIPMUNK_API_URL` / `CHIPMUNK_API_KEY` | `http://localhost:8787` / — | Where the stdio MCP server finds the API, and the key it uses. See [MCP](mcp.md) |
