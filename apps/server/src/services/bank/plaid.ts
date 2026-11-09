import { localDateTimeInTz, type PlaidEnvironment } from '@st/shared'
import { decimalToMinor, sanitize } from './simplefin'
import { ProviderRequestError, type PlaidChanges, type PlaidProvider, type PlaidTransaction, type RemoteAccount, type RemoteTransaction } from './types'

/**
 * Plaid (https://plaid.com/docs/api/). Banks are connected in Plaid Link in the browser, which hands
 * back a public token; we exchange it for an access token (stored encrypted) for that bank login
 * (an "Item"). Syncs use /transactions/sync, which returns only what changed since the last cursor.
 *
 * Plaid's amounts are positive for money out, and credit and loan balances are positive amounts
 * owed; both are flipped here to the app's convention (money out and debts are negative).
 */

const HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
}
/** Plaid has Canadian and US banks; Canadian ones first. */
const COUNTRIES = ['CA', 'US']
/** Up to two years of history when a bank is first connected (Plaid's most). */
const DAYS_REQUESTED = 730
/** How long a request to Plaid may take. */
const TIMEOUT_MS = 30_000

interface PlaidAccount {
  account_id: string
  name: string
  official_name?: string | null
  mask?: string | null
  type: string
  subtype?: string | null
  balances: { current: number | null; available: number | null; iso_currency_code: string | null; unofficial_currency_code?: string | null }
}
interface PlaidTx {
  transaction_id: string
  account_id: string
  amount: number
  date: string
  authorized_date?: string | null
  /** Some banks only: when it posted, and when it was authorized (ISO 8601). */
  datetime?: string | null
  authorized_datetime?: string | null
  name: string
  merchant_name?: string | null
  pending: boolean
  pending_transaction_id?: string | null
  /** Plaid's category: e.g. TRANSPORTATION / TRANSPORTATION_GAS, with VERY_HIGH … LOW confidence. */
  personal_finance_category?: { primary: string; detailed: string; confidence_level?: string | null } | null
}

/** "FOOD_AND_DRINK" → "Food and drink". */
const words = (code: string) => {
  const s = code.toLowerCase().replace(/_/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Plaid's category as "Transportation › Gas" (the detailed one repeats the primary as a prefix). */
export function plaidCategory(pfc: PlaidTx['personal_finance_category']): RemoteTransaction['category'] {
  if (!pfc?.primary) return undefined
  const detail = pfc.detailed?.startsWith(`${pfc.primary}_`) ? pfc.detailed.slice(pfc.primary.length + 1) : pfc.detailed
  const name = detail && detail !== pfc.primary ? `${words(pfc.primary)} › ${words(detail)}` : words(pfc.primary)
  return { name, confident: pfc.confidence_level === 'VERY_HIGH' || pfc.confidence_level === 'HIGH' }
}

export interface PlaidCredentialsSource {
  clientId: string
  secret: string
  environment: PlaidEnvironment
}

export function createPlaid(opts: {
  fetch: typeof fetch
  credentials: () => PlaidCredentialsSource | null
  timeZone: () => string
  now: () => Date
}): PlaidProvider {
  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const creds = opts.credentials()
    if (!creds) throw new ProviderRequestError('Add your Plaid API keys in App settings → Bank sync first.', null, 'NOT_CONFIGURED')
    let res: Response
    try {
      res = await opts.fetch(`${HOSTS[creds.environment]}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'plaid-version': '2020-09-14' },
        body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new ProviderRequestError(`Plaid didn't answer within ${TIMEOUT_MS / 1000} seconds. Try again later.`, null)
      throw new ProviderRequestError(`Couldn't reach Plaid: ${err instanceof Error ? err.message : err}`, null)
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const code = typeof json.error_code === 'string' ? json.error_code : null
      const message = sanitize(json.display_message) || sanitize(json.error_message) || `Plaid returned an error (HTTP ${res.status}).`
      throw new ProviderRequestError(friendly(code) ?? message, res.status, code)
    }
    return json as T
  }

  function toAccount(a: PlaidAccount, institution: { id: string; name: string } | null): RemoteAccount {
    // Plaid reports what's owed on a card or loan as a positive balance.
    const owed = a.type === 'credit' || a.type === 'loan'
    const signed = (n: number | null) => (n === null || n === undefined ? null : owed ? -decimalToMinor(n) : decimalToMinor(n))
    const currency = a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? 'CAD'
    return {
      remoteId: a.account_id,
      name: `${sanitize(a.name) || sanitize(a.official_name) || 'Account'}${a.mask ? ` (${sanitize(a.mask)})` : ''}`,
      institution: institution?.name ?? null,
      institutionId: institution?.id ?? null,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : 'CAD',
      balanceMinor: signed(a.balances.current) ?? 0,
      // A card's "available" is credit left, not a balance.
      availableMinor: owed ? null : signed(a.balances.available),
      balanceDate: opts.now().toISOString(),
      transactions: [],
      error: null,
    }
  }

  function toTransaction(t: PlaidTx): PlaidTransaction {
    const description = sanitize(t.name) || 'Transaction'
    const category = plaidCategory(t.personal_finance_category)
    // When it happened, if the bank says; otherwise when it posted. Its time goes with whichever it is.
    const date = t.authorized_date || t.date
    const at = t.authorized_date ? t.authorized_datetime : t.datetime
    const datetime = at ? localDateTimeInTz(opts.timeZone(), new Date(at)) : null
    return {
      accountId: t.account_id,
      remoteId: t.transaction_id,
      date,
      ...(datetime?.startsWith(date) ? { datetime } : {}),
      amountMinor: -decimalToMinor(t.amount),
      payee: sanitize(t.merchant_name) || description,
      description,
      pending: t.pending === true,
      ...(t.pending_transaction_id ? { replaces: t.pending_transaction_id } : {}),
      ...(category ? { category } : {}),
      raw: t,
    }
  }

  return {
    kind: 'plaid',

    async createLinkToken({ userId, accessToken }) {
      const r = await call<{ link_token: string; expiration: string }>('/link/token/create', {
        client_name: 'Spending Tracker',
        user: { client_user_id: userId },
        language: 'en',
        country_codes: COUNTRIES,
        // With an access token, Link signs in to that bank again ("update mode").
        ...(accessToken ? { access_token: accessToken } : { products: ['transactions'], transactions: { days_requested: DAYS_REQUESTED } }),
      })
      return { linkToken: r.link_token, expiration: r.expiration }
    },

    async exchange(publicToken) {
      const r = await call<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken })
      return { accessToken: r.access_token, itemId: r.item_id }
    },

    async fetchAccounts(accessToken) {
      const r = await call<{ accounts: PlaidAccount[]; item: { institution_id?: string | null } }>('/accounts/get', { access_token: accessToken })
      let institution: { id: string; name: string } | null = null
      const institutionId = r.item.institution_id
      if (institutionId) {
        try {
          const i = await call<{ institution: { institution_id: string; name: string } }>('/institutions/get_by_id', {
            institution_id: institutionId,
            country_codes: COUNTRIES,
          })
          institution = { id: institutionId, name: sanitize(i.institution.name) || institutionId }
        } catch {
          // The accounts matter more than the bank's name.
          institution = { id: institutionId, name: institutionId }
        }
      }
      return { institution, accounts: r.accounts.map((a) => toAccount(a, institution)) }
    },

    async syncTransactions(accessToken, cursor) {
      // Pages until has_more is false; if the data changes mid-way, Plaid asks to start again.
      for (let attempt = 0; ; attempt++) {
        // In order, so a later page's removal cancels an earlier page's addition.
        const changed = new Map<string, PlaidTransaction>()
        const removed = new Map<string, { remoteId: string; accountId: string; raw: unknown }>()
        let next = cursor
        try {
          for (;;) {
            const r = await call<{
              added: PlaidTx[]
              modified: PlaidTx[]
              removed: Array<{ transaction_id: string; account_id: string }>
              next_cursor: string
              has_more: boolean
            }>('/transactions/sync', { access_token: accessToken, count: 500, ...(next ? { cursor: next } : {}) })
            for (const t of [...r.added, ...r.modified].map(toTransaction)) {
              changed.set(t.remoteId, t)
              removed.delete(t.remoteId)
            }
            for (const x of r.removed) {
              changed.delete(x.transaction_id)
              removed.set(x.transaction_id, { remoteId: x.transaction_id, accountId: x.account_id, raw: x })
            }
            next = r.next_cursor
            if (!r.has_more) break
          }
          return { changed: [...changed.values()], removed: [...removed.values()], nextCursor: next ?? '' } satisfies PlaidChanges
        } catch (err) {
          if (err instanceof ProviderRequestError && err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 2) continue
          throw err
        }
      }
    },

    async removeItem(accessToken) {
      await call('/item/remove', { access_token: accessToken })
    },
  }
}

/** Plaid's errors in the app's words, where the generic message isn't enough. */
function friendly(code: string | null): string | null {
  switch (code) {
    case 'ITEM_LOGIN_REQUIRED':
      return 'The bank wants you to sign in again. Choose Reconnect to do it in Plaid.'
    case 'INVALID_API_KEYS':
      return 'Plaid didn’t accept your client ID and secret. Check them in App settings → Bank sync (and that the environment matches the secret).'
    case 'INVALID_ACCESS_TOKEN':
    case 'ITEM_NOT_FOUND':
      return 'Plaid no longer has this bank connection. Remove it and connect the bank again.'
    case 'PRODUCTS_NOT_SUPPORTED':
    case 'INSTITUTION_NOT_SUPPORTED':
      return 'Plaid can’t get transactions from this bank.'
    default:
      return null
  }
}
