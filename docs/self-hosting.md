# Self-hosting

Spending Tracker is one server: the web app, the API and the MCP endpoint. Run it in Docker (the easiest) or from source with Node.js. Either way, read [Security](security.md) before anyone but you can reach it.

## Docker

The quickest start is the prebuilt image. Each release is published as `ghcr.io/stevenwdhu/spending-tracker` for amd64 and arm64 (Apple silicon and Raspberry Pi too): `:latest` is the newest release, `:0.4` its newest fixes for one minor version, and `:0.4.2` that exact release (see [Releasing](releasing.md)). Save this as `compose.yaml` in a folder of its own:

```yaml
services:
  spending-tracker:
    image: ghcr.io/stevenwdhu/spending-tracker:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"   # only this machine: see Security before opening it up
    volumes:
      - spending-data:/data     # your ledgers, backups and secret.key
    environment:
      TZ: America/Toronto       # your time zone, for "today" and the daily jobs
volumes:
  spending-data:
```

Then `docker compose up -d`, open http://localhost:8787, and update with `docker compose pull && docker compose up -d`.

### Building it yourself

The repo's own `compose.yaml` builds the image from source:

```bash
git clone https://github.com/stevenwdhu/spending-tracker.git
cd spending-tracker
docker compose up -d
```

Then open http://localhost:8787. It builds the image the first time, and runs one container with the app, the API and the MCP endpoint.

- **Your data** lives in the `spending-data` volume, mounted at `/data`. Removing the container keeps it, `docker compose down -v` deletes it.
- **The port** is published on `127.0.0.1:8787` only, so only this machine can reach it. Put a proxy in front of it (see [Security](security.md)), or change the line in `compose.yaml` to `"8787:8787"` to open it to your network.
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

Add more ledgers from the ledger menu → **New ledger**. To clear one, use **Ledger settings → Data → Erase this ledger's data**, which brings its welcome screen back. Default categories are created on first start. To try it with sample data apart from your own, see the demo setup in [CONTRIBUTING.md](../CONTRIBUTING.md).

### Run it like production (locally)

```bash
pnpm build       # the web app, the stdio MCP bundle and the server bundle
pnpm start       # one server for the app and the API on http://localhost:8787
```

`pnpm start` runs the bundle `pnpm build` made, so build again after you pull. It sets `NODE_ENV=production` itself.

To use it from your phone on the same network, open `http://<your-computer's-ip>:8787`. The server listens on every interface by default. Set `HOST=127.0.0.1` to keep it to this machine. Installing it as an app needs HTTPS (or `localhost`), which [Tailscale Serve](security.md) gives you.

## Backups

- **Ledger settings → Data → Download backup** gives you a consistent copy of that ledger. **App settings → Ledgers → Full backup** zips every ledger plus `meta.db`. To move machines, stop the server and unzip it into the data directory.
- **Ledger settings → Data → Restore from backup** (or the welcome screen, or New ledger → From a backup) puts a backup into a ledger. Older backups are upgraded to the current version first.
- Before a migration, restore, erase, ledger deletion or `pnpm seed:demo --force`, the server saves a copy in `backups/` in the data directory.
- Backups don't include `secret.key`, so bank connections, the ChatGPT sign-in and the AI and Plaid keys don't come along. After moving machines, either copy that file over as well, or enter the keys again and reconnect your banks (SimpleFIN with a new setup token, Plaid in its window, Wealthsimple by signing in). If the server finds saved secrets it can't read at startup, it says how many in its log.
- In Docker, see [Back up the volume](#docker).
