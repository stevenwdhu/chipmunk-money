import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import { createApiClient, type FetchLike, type Me } from './api'
import { createSpendingServer } from './server'

export { ApiError, createApiClient, type ApiClient, type FetchLike, type Me } from './api'
export { createSpendingServer, SERVER_VERSION, toolsFor } from './server'
export { TOOLS, type ToolDef } from './tools'

/**
 * The Streamable HTTP endpoint (mounted at /mcp by the main server). Each request is served by a
 * fresh server for the caller's API key (passed in as `authInfo.token`), listing only the tools
 * that key's scopes allow.
 */
export function createMcpHttpHandler(opts: { fetch: FetchLike; baseUrl?: string }): McpHttpHandler {
  return createMcpHandler(
    async ({ authInfo }) => {
      const api = createApiClient({ fetch: opts.fetch, baseUrl: opts.baseUrl, apiKey: authInfo?.token })
      return createSpendingServer(api, await api.get<Me>('/me'))
    },
    { onerror: (err) => console.error('[mcp]', err.message) },
  )
}
