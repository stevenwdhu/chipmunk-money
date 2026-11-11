# Security

Chipmunk holds your whole financial life, and the access to your banks. There's no login yet, so the server decides who's allowed in like this.

**Who can use it.** Only two things get an answer:
- **The app's own web page,** in a browser. The server checks the browser's `Sec-Fetch-Site` header (or `Origin` and `Referer` on plain HTTP over your network) to tell its own page from anything else. Other websites you visit can't call it, and a plain curl or script without a key gets 401.
- **A valid API key,** sent as `Authorization: Bearer cm_…`. Scripts, agents and MCP use these. See [docs/api.md](api.md).

Anyone who can open the web page is treated as you. The header check stops other websites, not programs: something on your network can fake those headers. So who can reach the port is what really protects it.

**Host names.** Without a key, the server only answers at an IP address, `localhost`, a name without a dot (`nas`), or a local name (`.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`). That stops a website from pointing its own name at your server (DNS rebinding). If you open the app at another name, like `money.example.com`, add it to `ALLOWED_HOSTS` (comma-separated, and a leading dot allows subdomains: `.example.com`). Otherwise the app opens to a page saying the server won't answer at that name. Requests with an API key work at any name.

**Behind a reverse proxy.** Set `TRUSTED_AUTH_HEADER` to a header your proxy adds for people it has signed in (Tailscale Serve: `Tailscale-User-Login`, Cloudflare Access: `Cf-Access-Authenticated-User-Email`). Then requests without a key must also carry it, and a browser that reaches the app some other way gets a page asking it to come through the proxy. The server only checks that the header is there, not what it says or who added it. Anything that can reach the server's port directly can send it too, so keep the port private to the proxy: bind it to `127.0.0.1` (`HOST=127.0.0.1`, or the default `compose.yaml`) or to a private Docker network.

**The proxy must pass the browser's `Host` header on.** Without HTTPS the server tells its own page apart by comparing the page's address with that header. Caddy, Traefik, Tailscale Serve and cloudflared keep it, and nginx needs `proxy_set_header Host $host;`. A proxy that signs people in with HTTP Basic auth is fine: only `Authorization: Bearer` counts as an API key.

**Don't put it on the internet without a proxy that signs people in.** Never forward port 8787 on your router. Good options:
1. **[Tailscale Serve](https://tailscale.com/kb/1312/serve)** (the simplest): only your own devices can reach it, and it gives you HTTPS, which installing the app on a phone needs. Run `tailscale serve --bg 8787` on the server, set `TRUSTED_AUTH_HEADER=Tailscale-User-Login`, and open `https://<machine>.<tailnet>.ts.net`.
2. **Cloudflare Tunnel with Cloudflare Access**, to reach it from anywhere with a login. Add your name to `ALLOWED_HOSTS`.
3. **Caddy or Traefik with forward auth** (Authelia, Authentik) on a server of your own. Add your name to `ALLOWED_HOSTS`.

**API keys.** Give each script or agent its own key with the least access it needs. Only a hash is stored. A key limited to some ledgers can't touch anything app-wide (API keys, changing settings, bank connections, payees across ledgers, the full backup, which ledger the app opens). It only sees and links bank accounts already syncing into its ledgers. Ids are numbered across all ledgers, so such a key can tell from gaps in its ids roughly how much was added to the others, though it can't see any of it.

**Backups and `secret.key`.** Your data directory (`data/` from source, the `chipmunk-data` volume in Docker) holds `chipmunk.db`, the one database with every ledger in it. `secret.key` in it encrypts the access to your banks (SimpleFIN, Plaid and Wealthsimple), your Plaid secret, the ChatGPT sign-in and your AI keys. Backups leave `secret.key` out on purpose, so keep a copy of it somewhere safe and private, apart from the backups. Without `secret.key`, the app works but you have to enter those keys and connect your banks again. The safety copies in `backups/` are whole databases, every ledger and the sealed bank sign-ins included, so keep that folder as private as `chipmunk.db`. New installs create the data directory readable only by its owner (0700, files 0600).

To report a vulnerability, see [SECURITY.md](../SECURITY.md).
