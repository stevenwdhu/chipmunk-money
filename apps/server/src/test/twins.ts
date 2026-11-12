import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { importCommitSchema, transactionCreateSchema, type ApiKeyCreated } from '@chipmunk/shared'
import { createApp } from '../app'
import { bankAccounts, bankConnections } from '../db/schema'
import { ledgerMaintenance } from '../db/scope'
import { deleteLedgerRows, TABLES } from '../db/tables'
import { leaveSharedList } from '../services/catalog'
import type { AppContext } from '../services/context'
import { keepTransactions } from '../services/bank/store'
import { commitImport } from '../services/import'
import { setLinks } from '../services/links'
import { setPayeeChoice } from '../services/payees'
import { startDemo } from '../services/setup'
import { deleteTransaction, insertTransaction } from '../services/transactions'
import type { Storage } from '../storage'
import { testLedger, testStorage } from './helpers'
import { ledgerRows } from './world'

/**
 * Two ledgers in one database seeded alike with the demo (the same accounts, payees, amounts and
 * dates, under different ids), with one of everything else on top: a refund linked to its
 * purchase, a deleted transaction, a suggestion to review, an import, a payee choice, a bank link
 * with what the bank sent, and AI calls. Each ledger's free text carries its own canary, so a
 * response for one that holds the other's canary has leaked. For the isolation test.
 */

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

export const CANARIES = { a: '⟦A⟧', b: '⟦B⟧' } as const

/** A ledger's rows by kind, for requests: the ones the demo makes and the ones added on top. */
export interface TwinIds {
  chequing: number
  card: number
  investment: number
  cash: number
  institution: number
  /** A purchase on the card, categorized, not linked to anything. */
  purchase: number
  /** Money in refunding `refunded` in full. */
  refund: number
  refunded: number
  /** Money in with no links yet: a refund to link. */
  moneyIn: number
  deleted: number
  /** A suggested category waiting for review. */
  suggestion: number
  recurring: number
  /** A transaction that is one of `recurring`'s payments. */
  payment: number
  tag: number
  report: number
  snapshot: number
  category: number
  otherCategory: number
  group: number
  label: number
  /** The bank account syncing into `chequing`. */
  bankAccount: string
  /** A chequing transaction the bank sent. */
  synced: number
  /** A failed AI request, for a payee with nothing left to categorize. */
  aiRequest: number
}

export interface Twin {
  ctx: AppContext
  slug: string
  canary: string
  ids: TwinIds
}

export interface Twins {
  storage: Storage
  app: ReturnType<typeof createApp>
  a: Twin
  b: Twin
  /** Each ledger on its own category list (else both on the shared one). */
  own: boolean
}

/** A bank account no ledger syncs from yet, for linking. */
export const FREE_BANK_ACCOUNT = 'bank-free'

const ai = async () => ({ category: 'Groceries', confidence: 0.9, slot: 'primary' as const, model: 'stub' })
const offline: typeof fetch = async () => new Response('offline', { status: 503 })

/** The first column of the first row, which must be there. */
export const one = <T>(ctx: AppContext, sql: string, ...params: unknown[]): T => {
  const v = ctx.q.pluck<T>(sql, ...params)
  if (v === undefined || v === null) throw new Error(`Twin setup found nothing for: ${sql}`)
  return v
}

function seedTwin(storage: Storage, ctx: AppContext, canary: string, own: boolean): Twin {
  startDemo(ctx)
  if (own) leaveSharedList(ctx)
  const account = (name: string) => one<number>(ctx, 'SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND name = ?', name)
  const chequing = account('TD Chequing')
  const card = account('Amex Cobalt')
  const investment = account('Wealthsimple TFSA')
  const cash = account('Cash')
  const category = (name: string) => one<number>(ctx, 'SELECT id FROM ledger_categories WHERE ledger_id = @ledger AND name = ?', name)
  const groceries = category('Groceries')
  const add = (input: Record<string, unknown>, suggestion: Parameters<typeof insertTransaction>[2]['suggestion'] = null) =>
    insertTransaction(ctx, transactionCreateSchema.parse(input), { suggestion, skipRecurring: true })

  const refunded = add({ accountId: card, date: '2026-09-12', amountMinor: -4_500, payee: 'BEST BUY #77', categoryId: category('Electronics') })
  const refund = add({ accountId: card, date: '2026-09-20', amountMinor: 4_500, payee: 'BEST BUY #77' })
  setLinks(ctx, refund, [{ transactionId: refunded, amountMinor: 4_500, kind: 'refund' }])
  const moneyIn = add({ accountId: card, date: '2026-09-22', amountMinor: 1_200, payee: 'FARM BOY #23 REFUND' })
  const deleted = add({ accountId: cash, date: '2026-09-15', amountMinor: -900, payee: 'CORNER STORE' })
  deleteTransaction(ctx, deleted)
  const suggestion = add(
    { accountId: card, date: '2026-09-25', amountMinor: -3_300, payee: 'NEW GROCER' },
    { categoryId: groceries, source: 'history', confidence: 0.7, reason: '', autoApply: false },
  )
  // An import, so the ledger has a batch in Recent imports.
  commitImport(
    ctx,
    importCommitSchema.parse({
      accountId: chequing,
      fileName: 'september.csv',
      rows: [
        { line: 1, date: '2026-09-02', payee: 'CITY OF TORONTO TAX', amountMinor: -60_000, categoryId: category('Rent') },
        { line: 2, date: '2026-09-03', payee: 'HYDRO ONE', amountMinor: -9_000 },
      ],
    }),
    { background: false },
  )
  setPayeeChoice(ctx, { payee: 'NEW GROCER', mode: 'always', categoryId: groceries })

  // The bank: one connection for the app, and a bank account syncing into each ledger's chequing.
  const bankAccount = `bank-${ctx.ledger.slug}`
  const app = storage.app.db
  if (!app.select().from(bankConnections).get()) {
    app.insert(bankConnections).values({ id: 'bank', provider: 'simplefin', name: 'The bank', secret: storage.secrets.seal('{}') }).run()
    const fetchedAt = '2026-10-03T12:00:00.000Z'
    app.insert(bankAccounts).values({ id: FREE_BANK_ACCOUNT, connectionId: 'bank', remoteId: 'free', name: 'Savings', currency: 'CAD', fetchedAt }).run()
    const remote = (remoteId: string, date: string, amountMinor: number, payee: string) => ({ remoteId, date, amountMinor, payee, description: payee, pending: false })
    keepTransactions(
      storage.app,
      FREE_BANK_ACCOUNT,
      { transactions: [remote('s1', '2026-09-30', 1_250, 'INTEREST'), remote('s2', '2026-10-01', -2_000, 'SERVICE CHARGE')], window: null, removed: [] },
      fetchedAt,
    )
  }
  app.insert(bankAccounts).values({ id: bankAccount, connectionId: 'bank', remoteId: `r-${ctx.ledger.slug}`, name: 'Chequing', currency: 'CAD', accountId: chequing }).run()
  const synced = add({ accountId: chequing, date: '2026-09-28', amountMinor: -2_500, payee: 'BANK FEE', externalId: 'bank-fee-1' })
  ctx.q.run("UPDATE transactions SET origin = 'sync' WHERE id = ? AND ledger_id = @ledger", synced)
  ctx.q.run(
    `INSERT INTO bank_payloads (account_id, provider, remote_id, transaction_id, event, payload) VALUES (?, 'simplefin', 'bank-fee-1', ?, 'added', ?)`,
    chequing,
    synced,
    JSON.stringify({ id: 'bank-fee-1', description: 'BANK FEE' }),
  )
  // An AI request that was answered, and one that failed for a payee with nothing left to categorize.
  ctx.q.run(
    `INSERT INTO ai_calls (ledger_id, created_at, slot, model, ok, latency_ms, input_tokens, output_tokens)
     VALUES (@ledger, '2026-10-01T12:00:00.000Z', 'primary', 'stub', 1, 120, 300, 20)`,
  )
  const aiRequest = Number(
    ctx.q.run(
      `INSERT INTO ai_calls (ledger_id, created_at, slot, model, ok, latency_ms, input_tokens, output_tokens, error, kind, subject, subject_key, first_failed_at, tried_at)
       VALUES (@ledger, '2026-10-02T12:00:00.000Z', 'primary', 'stub', 0, 120, 300, 20, 'timed out', 'categorize', 'Gone Cafe ' || @canary, 'out:gone cafe',
         '2026-10-02T12:00:00.000Z', '2026-10-02T12:00:00.000Z')`,
      { canary },
    ).lastInsertRowid,
  )

  const recurring = one<number>(ctx, "SELECT id FROM recurring_items WHERE ledger_id = @ledger AND status = 'active' ORDER BY name, id LIMIT 1")
  const ids: TwinIds = {
    chequing,
    card,
    investment,
    cash,
    institution: one<number>(ctx, "SELECT id FROM institutions WHERE ledger_id = @ledger AND name = 'TD'"),
    purchase: one<number>(ctx, "SELECT id FROM transactions WHERE ledger_id = @ledger AND payee = 'COSTCO WHOLESALE #535' ORDER BY date DESC LIMIT 1"),
    refund,
    refunded,
    moneyIn,
    deleted,
    suggestion,
    recurring,
    payment: one<number>(ctx, 'SELECT id FROM transactions WHERE ledger_id = @ledger AND recurring_item_id = ? ORDER BY date DESC LIMIT 1', recurring),
    tag: one<number>(ctx, "SELECT id FROM tags WHERE ledger_id = @ledger AND name = 'trip-japan'"),
    report: one<number>(ctx, 'SELECT id FROM custom_reports WHERE ledger_id = @ledger LIMIT 1'),
    snapshot: one<number>(
      ctx,
      'SELECT s.id FROM balance_snapshots s JOIN ledger_accounts a ON a.id = s.account_id AND a.ledger_id = @ledger WHERE a.id = ? ORDER BY s.date DESC LIMIT 1',
      investment,
    ),
    category: groceries,
    otherCategory: category('Dine out'),
    group: one<number>(ctx, "SELECT id FROM ledger_category_groups WHERE ledger_id = @ledger AND name = 'Food'"),
    label: one<number>(ctx, 'SELECT id FROM ledger_labels WHERE ledger_id = @ledger ORDER BY sort, id LIMIT 1'),
    bankAccount,
    synced,
    aiRequest,
  }

  // The canary, in free text of every kind the ledger has.
  ctx.q.run('UPDATE accounts SET notes = @canary WHERE ledger_id = @ledger', { canary })
  ctx.q.run("UPDATE institutions SET name = name || ' ' || @canary WHERE ledger_id = @ledger", { canary })
  ctx.q.run("UPDATE transactions SET notes = 'note ' || @canary WHERE ledger_id = @ledger", { canary })
  ctx.q.run("UPDATE recurring_items SET title = coalesce(title, name) || ' ' || @canary WHERE ledger_id = @ledger", { canary })
  // Tag names are lower case.
  ctx.q.run("UPDATE tags SET name = name || '-' || lower(@canary) WHERE ledger_id = @ledger", { canary })
  ctx.q.run("UPDATE custom_reports SET name = name || ' ' || @canary WHERE ledger_id = @ledger", { canary })
  ctx.q.run(
    "INSERT INTO activity (ledger_id, actor, action, entity, summary) VALUES (@ledger, 'web', 'update', 'ledger', 'Set up ' || @canary)",
    { canary },
  )
  if (own) {
    ctx.q.run("UPDATE categories SET name = name || ' ' || @canary WHERE ledger_id = @ledger AND id = ?", { canary }, ids.otherCategory)
    ctx.q.run("UPDATE category_groups SET name = name || ' ' || @canary WHERE ledger_id = @ledger AND id = ?", { canary }, ids.group)
    ctx.q.run("UPDATE labels SET name = name || ' ' || @canary WHERE ledger_id = @ledger AND id = ?", { canary }, ids.label)
  }
  return { ctx, slug: ctx.ledger.slug, canary, ids }
}

/** The twin world: ledger A (Personal, the default) and B (Family). */
export function twins(opts: { own?: boolean } = {}): Twins {
  const own = !!opts.own
  const storage = testStorage({ llm: ai, fetch: offline })
  const a = seedTwin(storage, storage.registry.defaultContext(), CANARIES.a, own)
  const b = seedTwin(storage, testLedger(storage, 'Family'), CANARIES.b, own)
  return { storage, app: createApp(storage, { trustedHeader: null }), a, b, own }
}

/** Deletes every row of a ledger (not the ledger itself), as deleting it would. */
export function deleteRows(storage: Storage, ledgerId: string) {
  ledgerMaintenance(storage.sqlite, ledgerId, () => deleteLedgerRows(storage.sqlite, ledgerId))
}

/**
 * A hash of each table's rows of one ledger (child rows through their parents), its row in
 * `ledgers` and the bank accounts syncing into its accounts: what another ledger's requests must
 * never change.
 */
export function ledgerHash(storage: Storage, ledgerId: string): Record<string, string> {
  const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
  const out = Object.fromEntries(Object.entries(ledgerRows(storage.sqlite, ledgerId)).map(([t, rows]) => [t, `${rows.length}:${hash(rows)}`]))
  const ctx = storage.registry.context(ledgerId)
  out.ledgers = hash(storage.registry.get(ledgerId))
  out.bank_accounts = hash(
    storage.app.db
      .select()
      .from(bankAccounts)
      .all()
      .filter((r) => r.accountId !== null && ctx.q.pluck('SELECT 1 FROM ledger_accounts WHERE ledger_id = @ledger AND home_ledger_id = @ledger AND id = ?', r.accountId)),
  )
  if (TABLES.some((t) => !(t.name in out) && t.kind !== 'app')) throw new Error('ledgerHash missed a table')
  return out
}

// Requests --------------------------------------------------------------------------------

export interface Res {
  status: number
  /** JSON, text, or for a file of bytes its sha256. */
  body: Json
  /** The error message, for an error. */
  message?: string
}

export interface Req {
  method: string
  /** Under /api/v1, with the ledger and ids filled in. */
  path: string
  query?: Record<string, unknown>
  body?: unknown
}

/** Lets work a request left running (AI categorizing, payee tidying) finish. */
export const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

export function queryString(query: Record<string, unknown> | undefined): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** Sends a request as the web app does (or with an API key's authorization header). */
export async function send(app: Twins['app'], req: Req, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }): Promise<Res> {
  const res = await app.request(`/api/v1${req.path}${queryString(req.query)}`, {
    method: req.method,
    headers: { ...headers, ...(req.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  })
  const type = res.headers.get('content-type') ?? ''
  let body: Json
  if (res.status === 204) body = null
  else if (type.includes('json')) body = await res.json()
  else if (type.startsWith('text/')) body = await res.text()
  else body = { sha256: createHash('sha256').update(new Uint8Array(await res.arrayBuffer())).digest('hex') }
  return { status: res.status, body, message: res.status >= 400 ? body?.error?.message : undefined }
}

/** A new API key (from the web app), as an authorization header. */
export async function apiKey(app: Twins['app'], scopes: string[], ledgers?: string[]): Promise<Record<string, string>> {
  const res = await send(app, { method: 'POST', path: '/api-keys', body: { name: `key ${scopes.join(' ')} ${ledgers?.join(' ') ?? 'all'}`, scopes, ledgers } })
  if (res.status !== 201) throw new Error(`Couldn't make a key: ${res.message}`)
  return { authorization: `Bearer ${(res.body as ApiKeyCreated).key}` }
}

export interface ToolRes {
  isError: boolean
  text: string
  data: Json
}

/** An MCP client for an API key, on the app in-process. */
export async function mcpClient(app: Twins['app'], auth: Record<string, string>) {
  const client = new Client({ name: 'twins', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: auth },
    fetch: async (url, init) => app.request(String(url), init),
  })
  await client.connect(transport)
  return {
    tools: async () => (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown>): Promise<ToolRes> => {
      const res = (await client.callTool({ name, arguments: args })) as Json
      return { isError: !!res.isError, text: res.content.map((c: Json) => c.text).join('\n'), data: res.structuredContent ?? null }
    },
    close: () => client.close(),
  }
}
