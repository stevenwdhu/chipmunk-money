import { localDateTimeInTz, todayInTz } from '@chipmunk/shared'
import { ProviderRequestError, type BankProvider, type FetchResult, type ProviderError, type RemoteAccount } from './types'

/**
 * SimpleFIN (https://www.simplefin.org/protocol.html), usually through SimpleFIN Bridge.
 * The user pastes a setup token (a base64 claim URL); claiming it once returns an Access URL with
 * Basic Auth credentials, which is the secret we keep.
 */

/** "-12.345" → -1235 (cents, rounding half away from zero). Exact: no floating point. */
export function decimalToMinor(value: string | number): number {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?\s*$/.exec(String(value))
  if (!m || (!m[2] && !m[3])) throw new Error(`Not an amount: ${value}`)
  const frac = (m[3] ?? '').padEnd(3, '0')
  const cents = Number(m[2] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0)
  return m[1] === '-' && cents !== 0 ? -cents : cents
}

/** Provider text is shown to the user, so strip markup and control characters and keep it short. */
export function sanitize(text: unknown): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function httpsUrl(text: string, what: string): URL {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    throw new ProviderRequestError(`That doesn't look like a SimpleFIN ${what}.`, null)
  }
  if (url.protocol !== 'https:') throw new ProviderRequestError(`The SimpleFIN ${what} must use HTTPS.`, null)
  return url
}

interface SfAccount {
  id: string
  name: string
  conn_id?: string
  currency: string
  balance: string
  'available-balance'?: string
  'balance-date': number
  transactions?: Array<{
    id: string
    posted: number
    amount: string
    description: string
    payee?: string
    memo?: string
    transacted_at?: number
    pending?: boolean
  }>
  /** Version 1 servers describe the institution on each account. */
  org?: { id?: string; name?: string; domain?: string }
}

interface SfAccountSet {
  errlist?: Array<{ code: string; msg: string; conn_id?: string; account_id?: string }>
  errors?: string[]
  connections?: Array<{ conn_id: string; name: string; org_id?: string; org_name?: string }>
  accounts?: SfAccount[]
  'x-api-message'?: string | string[]
}

/** How long a request to SimpleFIN Bridge may take. */
const TIMEOUT_MS = 30_000

function unreachable(err: unknown) {
  if (err instanceof Error && err.name === 'TimeoutError') return new ProviderRequestError(`SimpleFIN didn't answer within ${TIMEOUT_MS / 1000} seconds. Try again later.`, null)
  return new ProviderRequestError(`Couldn't reach SimpleFIN: ${err instanceof Error ? err.message : err}`, null)
}

export function createSimpleFin(opts: { fetch: typeof fetch; timeZone: () => string; now: () => Date }): BankProvider {
  return {
    kind: 'simplefin',

    async claim(token) {
      let decoded: string
      try {
        decoded = Buffer.from(token.replace(/\s+/g, ''), 'base64').toString('utf8')
      } catch {
        throw new ProviderRequestError("That isn't a SimpleFIN setup token.", null)
      }
      const claimUrl = httpsUrl(decoded, 'setup token')
      let res: Response
      try {
        res = await opts.fetch(claimUrl, { method: 'POST', headers: { 'content-length': '0' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (err) {
        throw unreachable(err)
      }
      if (res.status === 403) {
        throw new ProviderRequestError(
          'This setup token was already used or is not valid. If you didn’t use it yourself, disable it in SimpleFIN Bridge, since someone else may have claimed it.',
          403,
        )
      }
      if (!res.ok) throw new ProviderRequestError(`SimpleFIN couldn't claim the token (HTTP ${res.status}).`, res.status)
      const access = httpsUrl(await res.text(), 'access URL')
      if (!access.username || !access.password) throw new ProviderRequestError('SimpleFIN returned an access URL without credentials.', null)
      return { secret: access.toString() }
    },

    async fetchAccounts(secret, { start, end, balancesOnly }) {
      const access = httpsUrl(secret, 'access URL')
      const auth = Buffer.from(`${decodeURIComponent(access.username)}:${decodeURIComponent(access.password)}`).toString('base64')
      const url = new URL(`${access.origin}${access.pathname.replace(/\/+$/, '')}/accounts`)
      url.searchParams.set('version', '2')
      if (balancesOnly) url.searchParams.set('balances-only', '1')
      else url.searchParams.set('pending', '1')
      if (start) url.searchParams.set('start-date', String(Math.floor(start.getTime() / 1000)))
      if (end) url.searchParams.set('end-date', String(Math.floor(end.getTime() / 1000)))

      let res: Response
      try {
        res = await opts.fetch(url, { headers: { authorization: `Basic ${auth}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (err) {
        throw unreachable(err)
      }
      if (res.status === 403) {
        throw new ProviderRequestError('SimpleFIN refused the stored access. It may have been disabled; connect again with a new setup token.', 403)
      }
      if (res.status === 402) throw new ProviderRequestError('Your SimpleFIN Bridge subscription needs payment.', 402)
      if (!res.ok) throw new ProviderRequestError(`SimpleFIN returned an error (HTTP ${res.status}). Try again later.`, res.status)
      const data = (await res.json()) as SfAccountSet

      const institutions = new Map(
        (data.connections ?? []).map((c) => [c.conn_id, { name: sanitize(c.org_name || c.name), id: c.org_id ? sanitize(c.org_id) : null }]),
      )
      const tz = opts.timeZone()
      const today = todayInTz(tz, opts.now())
      const errors: ProviderError[] = [
        ...(data.errlist ?? []).map((e) => ({
          code: sanitize(e.code) || 'gen.',
          message: sanitize(e.msg),
          ...(e.account_id ? { remoteAccountId: e.account_id } : {}),
        })),
        // Version 1 servers only send plain strings.
        ...(data.errlist ? [] : (data.errors ?? []).map((m) => ({ code: 'gen.', message: sanitize(m) }))),
      ]
      // An account's own error, or its bank login's (e.g. the bank wants you to sign in again).
      const errorFor = (a: SfAccount) => {
        const e = (data.errlist ?? []).find((x) => x.account_id === a.id) ?? (data.errlist ?? []).find((x) => x.conn_id && !x.account_id && x.conn_id === a.conn_id)
        return e ? sanitize(e.msg) : null
      }

      const accounts: RemoteAccount[] = (data.accounts ?? []).map((a) => ({
        remoteId: String(a.id),
        name: sanitize(a.name) || 'Account',
        institution: (a.conn_id && institutions.get(a.conn_id)?.name) || (a.org?.name ? sanitize(a.org.name) : null),
        institutionId: (a.conn_id && institutions.get(a.conn_id)?.id) || (a.org && (a.org.id || a.org.domain) ? sanitize(a.org.id || a.org.domain) : null),
        currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'CAD',
        balanceMinor: decimalToMinor(a.balance),
        availableMinor: a['available-balance'] === undefined ? null : decimalToMinor(a['available-balance']),
        balanceDate: new Date((a['balance-date'] || 0) * 1000 || opts.now().getTime()).toISOString(),
        transactions: (a.transactions ?? []).map((t) => {
          // When it happened if the bank says; pending ones may not have a posted date yet.
          const ts = t.transacted_at || t.posted
          const description = sanitize(t.description) || sanitize(t.memo) || 'Transaction'
          const datetime = t.transacted_at ? localDateTimeInTz(tz, new Date(t.transacted_at * 1000)) : null
          return {
            remoteId: String(t.id),
            date: ts ? todayInTz(tz, new Date(ts * 1000)) : today,
            ...(datetime ? { datetime } : {}),
            amountMinor: decimalToMinor(t.amount),
            payee: sanitize(t.payee) || description,
            description,
            pending: t.pending === true,
            raw: t,
          }
        }),
        error: errorFor(a),
      }))

      const message = data['x-api-message']
      const notice = message ? sanitize(Array.isArray(message) ? message.join(' ') : message) || null : null
      return { accounts, errors, notice } satisfies FetchResult
    },
  }
}
