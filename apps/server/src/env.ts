import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const envFile = path.join(repoRoot, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const dataDir = path.resolve(repoRoot, process.env.DATA_DIR ?? 'data')

export const env = {
  // API_PORT (not PORT): dev tooling often sets PORT for the web dev server.
  port: Number(process.env.API_PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  /** Holds chipmunk.db, secret.key and backups/. */
  dataDir,
  isProduction: process.env.NODE_ENV === 'production',
  /**
   * A header your reverse proxy adds for signed-in people (Tailscale Serve: Tailscale-User-Login).
   * When set, requests without an API key must carry it too. Unset, coming from the app's own page is enough.
   */
  trustedAuthHeader: process.env.TRUSTED_AUTH_HEADER?.trim() || null,
  /**
   * More host names the web app may be opened at, comma-separated (a leading dot allows subdomains
   * too). IP addresses, localhost and local names (nas, .local, .lan, .home.arpa, .internal,
   * .ts.net) always work. Requests with an API key work at any name.
   */
  allowedHosts: (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  webDist: path.join(repoRoot, 'apps/web/dist'),
  /** The migrations of chipmunk.db. */
  migrations: path.join(repoRoot, 'apps/server/drizzle'),
}
