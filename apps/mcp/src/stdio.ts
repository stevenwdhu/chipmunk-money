import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ApiError, createApiClient, type Me } from './api'
import { createSpendingServer } from './server'

/**
 * Spending Tracker over stdio, for agents that start their tools as processes:
 *
 *   ST_API_URL=http://localhost:8787 ST_API_KEY=st_… node apps/mcp/dist/stdio.js
 *
 * Everything goes through the REST API with the key, like the HTTP endpoint at /mcp. Logs go to
 * stderr; stdout belongs to the protocol.
 */
const baseUrl = process.env.ST_API_URL ?? 'http://localhost:8787'
const apiKey = process.env.ST_API_KEY
if (!apiKey) console.error('[spending-tracker-mcp] ST_API_KEY is not set; the server must trust keyless requests for this to work.')

const api = createApiClient({ fetch, baseUrl, apiKey })
try {
  const me = await api.get<Me>('/me')
  console.error(`[spending-tracker-mcp] Connected to ${baseUrl} as ${me.actor} (${me.scopes.join(', ')})`)
} catch (err) {
  console.error(`[spending-tracker-mcp] ${err instanceof ApiError ? err.message : String(err)}`)
  process.exit(1)
}

serveStdio(async () => createSpendingServer(api, await api.get<Me>('/me')))
