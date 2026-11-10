import { z } from 'zod'
import { apiErrorSchema } from '@st/shared'
import { pathParams, type RouteSpec } from './router'

type JsonSchema = Record<string, unknown>

/** The API docs' sections, in order. */
export const TAGS: Array<{ name: string; description: string }> = [
  { name: 'Me', description: 'Who the API thinks you are, and what your key can do.' },
  { name: 'Ledgers', description: 'Separate sets of books, e.g. “Personal” and “Family”. Every other ledger route is under `/ledgers/{ledger}`.' },
  { name: 'Transactions', description: 'Money in and out of an account. Amounts are in minor units (cents): negative is money out.' },
  { name: 'Accounts', description: 'Institutions, and the accounts at them: bank accounts, cards, investments, loans and other assets.' },
  { name: 'Bank sync', description: 'Connections to your banks (SimpleFIN Bridge, Plaid and Wealthsimple), the bank accounts they bring, and syncing them.' },
  { name: 'Categories', description: 'Categories, their groups, and tags.' },
  { name: 'Payees', description: 'How payees are named (name rules, and AI tidying of what the bank sends), and your choice of category for each.' },
  { name: 'Recurring', description: 'Bills, subscriptions, income and instalment plans, detected from history or added by hand.' },
  { name: 'Reports', description: 'Totals and trends. Spending is reported as positive numbers.' },
  { name: 'Import', description: 'Bring in rows from a bank export. Preview first, then commit; every import can be undone.' },
  { name: 'Categorization', description: 'Category suggestions from your history, then AI.' },
  { name: 'Activity', description: 'Every change made through the API, by whom.' },
  { name: 'Data', description: 'Setup, backups, restore and erase.' },
  { name: 'Settings', description: 'App-wide settings: time zone and AI providers.' },
  { name: 'API keys', description: 'Keys for scripts and agents.' },
]

const DESCRIPTION = `The API behind Spending Tracker. The web app uses it too, so anything you can do in the app, you can do here.

**Authentication.** Send an API key as \`Authorization: Bearer st_…\`. Create keys in App settings → API keys. Each key has scopes (\`read\`, \`write\`, \`admin\`; each includes the ones before it) and can be limited to some ledgers. Each operation lists the scope it needs.

**Conventions**
- Money is in minor units (cents) as integers; negative is money out. Dates are \`YYYY-MM-DD\` in the app's time zone.
- Long lists are paginated: pass \`limit\` and the previous page's \`nextCursor\` as \`cursor\`.
- Send an \`Idempotency-Key\` header on a POST to make it safe to retry: the same key returns the first response instead of doing the work twice (for 24 hours).
- Transactions accept an \`externalId\` (your own id, unique per account). Adding one that already exists returns the existing transaction.
- Bulk endpoints accept \`?dryRun=true\` to see what would change without changing anything.
- Errors look like \`{ "error": { "code": "not_found", "message": "…" } }\`.`

/** `/ledgers/:ledger/transactions/:id` → `/ledgers/{ledger}/transactions/{id}` */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z_]\w*)/g, '{$1}')
}

/** "List transactions" → "listTransactions" */
export function operationId(summary: string): string {
  const words = summary
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('')
}

/**
 * Builds the OpenAPI 3.1 document from the route records. Zod schemas with an `id` become shared
 * components; everything else is inlined.
 */
export function buildOpenApi(specs: RouteSpec[], opts: { version: string }) {
  // Each named schema as requests send it and as responses return it (defaults are optional in one, always there in the other).
  const named: Record<'input' | 'output', Record<string, JsonSchema>> = { input: {}, output: {} }

  // Zod writes named schemas under `$defs`; move them to components and point the refs there.
  const hoist = (node: unknown, io: 'input' | 'output'): unknown => {
    if (Array.isArray(node)) return node.map((n) => hoist(n, io))
    if (!node || typeof node !== 'object') return node
    const out: JsonSchema = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema') continue
      // z.number().int() adds the safe-integer range to every integer; it's noise in the docs.
      if ((k === 'minimum' || k === 'maximum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue
      if (k === '$defs') {
        for (const [name, def] of Object.entries(v as Record<string, unknown>)) named[io][name] ??= hoist(def, io) as JsonSchema
        continue
      }
      out[k] = k === '$ref' && typeof v === 'string' ? v.replace('#/$defs/', `${REF}${io}:`) : hoist(v, io)
    }
    return out
  }
  const schemaOf = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema => {
    const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema
    const id = (json.id as string | undefined) ?? (z.globalRegistry.get(schema)?.id as string | undefined)
    const { id: _id, ...rest } = hoist(json, io) as JsonSchema
    if (!id) return rest
    named[io][id] ??= rest
    return { $ref: `${REF}${io}:${id}` }
  }

  const paths: Record<string, Record<string, unknown>> = {}
  for (const spec of specs) {
    const parameters: unknown[] = []
    const paramSchema = spec.params ? (schemaOf(spec.params, 'input') as { properties?: Record<string, JsonSchema> }) : null
    for (const name of pathParams(spec.path)) {
      parameters.push({
        name,
        in: 'path',
        required: true,
        ...(name === 'ledger'
          ? { description: 'The ledger’s slug (e.g. `personal`) or id.', schema: { type: 'string' } }
          : { schema: paramSchema?.properties?.[name] ?? { type: 'integer', minimum: 1 } }),
      })
    }
    if (spec.query) {
      const q = schemaOf(spec.query, 'input') as { properties?: Record<string, JsonSchema>; required?: string[] }
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        const { description, ...rest } = schema
        parameters.push({ name, in: 'query', required: q.required?.includes(name) ?? false, description, schema: rest })
      }
    }
    if (spec.dryRun) {
      parameters.push({
        name: 'dryRun',
        in: 'query',
        description: 'Report what would change without changing anything.',
        schema: { type: 'boolean', default: false },
      })
    }

    const status = spec.status ?? 200
    const ok =
      status === 204
        ? { description: 'Done. No content.' }
        : spec.file
          ? { description: spec.file.description, content: { [spec.file.contentType]: { schema: { type: 'string', format: 'binary' } } } }
          : {
              description: status === 201 ? 'Created' : status === 202 ? 'Started' : 'OK',
              content: { 'application/json': { schema: spec.response ? schemaOf(spec.response, 'output') : {} } },
            }

    const operation: Record<string, unknown> = {
      operationId: operationId(spec.summary),
      summary: spec.summary,
      description: [spec.description, `Scope: \`${spec.scope}\``].filter(Boolean).join('\n\n'),
      tags: [spec.tag],
      'x-scope': spec.scope,
      parameters: parameters.length ? parameters : undefined,
      responses: { [status]: ok, default: { $ref: '#/components/responses/Error' } },
    }
    if (spec.body) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(spec.body, 'input') } } }
    } else if (spec.upload) {
      operation.requestBody = {
        required: true,
        description: spec.upload.description,
        content: { [spec.upload.contentType]: { schema: { type: 'string', format: 'binary' } } },
      }
    }
    if (spec.method === 'post') {
      operation.parameters = [
        ...((operation.parameters as unknown[] | undefined) ?? []),
        { $ref: '#/components/parameters/IdempotencyKey' },
      ]
    }
    ;(paths[openApiPath(spec.path)] ??= {})[spec.method] = operation
  }

  const errorSchema = schemaOf(apiErrorSchema, 'output')
  const { components, resolve } = settleComponents(named)
  return resolve({
    openapi: '3.1.0',
    info: { title: 'Spending Tracker API', version: opts.version, description: DESCRIPTION },
    servers: [{ url: '/api/v1' }],
    security: [{ apiKey: [] }],
    tags: TAGS.filter((t) => specs.some((s) => s.tag === t.name)),
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'An API key from App settings → API keys, e.g. `st_…`' },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description: 'Any unique string (a UUID is ideal). Retrying with the same key returns the first response.',
          schema: { type: 'string', maxLength: 200 },
        },
      },
      responses: {
        Error: { description: 'Something went wrong. See `error.code`.', content: { 'application/json': { schema: errorSchema } } },
      },
    },
  })
}

/** Where a ref points before components are settled: `${REF}input:Name`. */
const REF = '#ref:'

/**
 * One component per named schema, and a `NameInput` one beside it where requests send it differently
 * (fields with defaults are optional), or it holds one that does. `resolve` points the refs at them.
 */
function settleComponents(named: Record<'input' | 'output', Record<string, JsonSchema>>) {
  const plain = (v: unknown) => JSON.stringify(v).replaceAll(`${REF}input:`, REF).replaceAll(`${REF}output:`, REF)
  const split = new Set(Object.keys(named.input).filter((n) => named.output[n] && plain(named.input[n]) !== plain(named.output[n])))
  // One that refers to a split one is split too.
  for (let grew = true; grew; ) {
    grew = false
    for (const [n, def] of Object.entries(named.input)) {
      if (split.has(n) || !named.output[n]) continue
      if ([...split].some((s) => JSON.stringify(def).includes(`"${REF}input:${s}"`))) {
        split.add(n)
        grew = true
      }
    }
  }
  const target = (io: string, n: string) => `#/components/schemas/${io === 'input' && split.has(n) ? `${n}Input` : n}`
  const resolve = <T>(v: T): T =>
    JSON.parse(JSON.stringify(v).replace(new RegExp(`"${REF}(input|output):([^"]+)"`, 'g'), (_m, io: string, n: string) => JSON.stringify(target(io, n))))
  const components: Record<string, JsonSchema> = {}
  for (const [n, def] of Object.entries(named.output)) components[n] = def
  for (const [n, def] of Object.entries(named.input)) components[split.has(n) ? `${n}Input` : n] ??= def
  return { components, resolve }
}

/**
 * Scalar's API reference, at an exact version, with the hash of that file (Subresource Integrity), so
 * the browser runs it only if the CDN sends exactly that file. To update it, change the version and
 * set the sha384 of the new file: `curl -s <src> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
export const SCALAR = {
  src: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0/dist/browser/standalone.js',
  integrity: 'sha384-oH1C0RwqcwbVXkC+r8A+4qRoyEUQdtxAzOwumkxZtQBBcsy61FOoPt7B50OVJYYQ',
}

/** The interactive docs page (Scalar, loaded from a CDN), and its inline script (for the page's CSP). */
export function docsPage(specUrl: string): { html: string; script: string } {
  // Everything stays on this server: no Scalar cloud tools, AI chat, fonts or telemetry.
  const script = `
      Scalar.createApiReference('#app', {
        url: ${JSON.stringify(specUrl)},
        showDeveloperTools: 'never',
        agent: { disabled: true },
        mcp: { name: 'Spending Tracker', url: '/mcp', disabled: true },
        telemetry: false,
        withDefaultFonts: false,
        showExtensions: ['x-scope'],
        authentication: { preferredSecurityScheme: 'apiKey' },
      })
    `
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Spending Tracker API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous"></script>
    <script>${script}</script>
  </body>
</html>`
  return { html, script }
}
