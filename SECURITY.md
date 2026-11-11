# Security

## Supported versions

Only the latest version on `main` (and the image built from it) gets security fixes. Update before you report, in case it's already fixed.

## Reporting a vulnerability

Please report it privately, not in a public issue: on GitHub, open the repository's **Security** tab and choose **Report a vulnerability**. That's GitHub's private vulnerability reporting, and only the maintainers see it.

Say what you found, how to reproduce it, and what someone could do with it. Please don't include real financial data, yours or anyone's. Use the demo data (see [CONTRIBUTING.md](CONTRIBUTING.md)) to show it.

You'll get a reply as soon as possible. Once it's fixed, the fix and the advisory are published together, with credit to you if you want it.

## Threat model

Chipmunk is a self-hosted app for one person or one household. It runs on a machine you control, and the people who can reach it are you and the agents you gave a key to.

**What's sensitive**
- `chipmunk.db` in the data directory, which holds every ledger: transactions, balances, accounts, payees and notes.
- `secret.key`, which encrypts the access to your banks (SimpleFIN access URLs, Plaid access tokens, the Wealthsimple session), your Plaid secret, the ChatGPT sign-in and your AI providers' keys. Anyone with both `secret.key` and `chipmunk.db` (or a full backup) can read all of them.
- API keys. Only a SHA-256 hash of each is stored, and the key itself is shown once.
- Backups and exports, which hold the same data (but never `secret.key`).

**What it protects against**
- **Other websites.** A page you visit can't use the API through your browser (CSRF). Without an API key, the server only answers its own web page, which it tells apart by the browser's `Sec-Fetch-Site` header, or `Origin` and `Referer` on plain HTTP.
- **DNS rebinding.** Without an API key, it only answers at an IP address, `localhost`, a local name or one in `ALLOWED_HOSTS`.
- **Scripts and agents without a key.** Anything that isn't the web page needs a valid API key, and a key only gets the access it was given: read only, read and write, or full access, optionally limited to some ledgers and with an expiry. A ledger-limited key can't use anything app-wide.
- **Being framed or sniffed.** Every response has a Content Security Policy, `X-Frame-Options: DENY` and `nosniff`.
- **Spreadsheet formulas in CSV exports.** Text that starts like a formula is escaped.
- **Secrets at rest.** Bank access and keys are encrypted with `secret.key`, and new installs create the data directory readable only by its owner (0700, files 0600). Error messages from AI providers never echo the request or the key.

**What it doesn't protect against**
- **Anyone who can reach the port.** There's no login yet. Someone on your network can fake the headers a browser sends and get in as you. Keep the port on `127.0.0.1` or behind a proxy that signs people in, and never put it on the internet as is. [docs/security.md](docs/security.md) shows how.
- **A spoofed `TRUSTED_AUTH_HEADER`.** The server only checks that the header is there. Anything that can reach the port without going through the proxy can send it.
- **Someone with access to the machine** or to the data directory, `secret.key` or a backup. They can read everything. Encrypt the disk, and keep backups and `secret.key` private.
- **Plain HTTP on your network.** Traffic between your phone and the server can be read by others on the same network. Use HTTPS (Tailscale Serve gives you that) when the network isn't yours alone.
- **The services you connect.** SimpleFIN, Plaid, Wealthsimple, OpenAI and your AI providers see what you send them. The Wealthsimple integration is unofficial and uses a private API.
- **A malicious API key holder.** A key with write or full access can change or delete what it's allowed to. Every change is in **Activity**, under the key's name.
- **Guessing how busy other ledgers are.** Ids are numbered across all ledgers, so a key limited to one ledger can tell from gaps in its ids roughly how much was added elsewhere. It can't see any of it.
