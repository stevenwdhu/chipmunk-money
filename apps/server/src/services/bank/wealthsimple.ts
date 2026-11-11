import { localDateTimeInTz, todayInTz } from '@chipmunk/shared'
import { decimalToMinor, sanitize } from './simplefin'
import { ProviderRequestError, type FetchOptions, type FetchResult, type RemoteAccount, type RemoteTransaction } from './types'

/**
 * Wealthsimple, through the private GraphQL API its own web app uses (my.wealthsimple.com). There's
 * no official API; this follows https://github.com/gboudreau/ws-api-python, which tracks it.
 *
 * You sign in once with your email, password and 2FA code (read-only scope); only the session is kept:
 * an OAuth refresh token, which changes every time it's used, and the device and client ids it was
 * issued for. Each sync refreshes it, then reads accounts, balances and activity.
 */

const OAUTH = 'https://api.production.wealthsimple.com/v1/oauth/v2'
const GRAPHQL = 'https://my.wealthsimple.com/graphql'
const LOGIN_PAGE = 'https://my.wealthsimple.com/app/login'
const SCOPE = 'invest.read trade.read tax.read'
// Cloudflare in front of my.wealthsimple.com turns away requests that look like scripts.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const OAUTH_HEADERS = { 'x-wealthsimple-client': '@wealthsimple/wealthsimple' }
/** Wealthsimple's own time zone: activity it records by date only (interest, scheduled transfers) is on its date there. */
const WEALTHSIMPLE_TZ = 'America/Toronto'
/** Error codes: Wealthsimple wants a 2FA code, or you to sign in again. */
export const OTP_REQUIRED = 'WS_OTP_REQUIRED'
export const SIGN_IN_AGAIN = 'WS_SIGN_IN'

/** What's kept (encrypted) for a Wealthsimple login. */
export interface WealthsimpleSession {
  email: string
  identityId: string
  clientId: string
  /** The device id (Wealthsimple's `wssdi` cookie) the tokens were issued to. */
  deviceId: string
  sessionId: string
  accessToken: string
  refreshToken: string
}

export interface WealthsimpleProvider {
  kind: 'wealthsimple'
  /** Signs in, read-only. Throws OTP_REQUIRED when Wealthsimple wants a 2FA code that wasn't given. */
  signIn(input: { email: string; password: string; otp?: string | null }): Promise<WealthsimpleSession>
  /** New tokens; the refresh token changes, so the returned session must be kept. Throws SIGN_IN_AGAIN when it can't. */
  refresh(session: WealthsimpleSession): Promise<WealthsimpleSession>
  fetchAccounts(session: WealthsimpleSession, opts: FetchOptions): Promise<FetchResult>
}

// Wealthsimple's data ------------------------------------------------------------------

interface WsMoney {
  amount: string
  currency: string
}
interface WsAccount {
  id: string
  status: string
  unifiedAccountType: string
  nickname: string | null
  currency: string
  accountOwnerConfiguration: string | null
  financials: { currentCombined: { netLiquidationValue: WsMoney | null } | null } | null
}
/** An activity feed item (only the fields used). */
export interface WsActivity {
  accountId: string
  canonicalId: string
  occurredAt: string
  status: string | null
  unifiedStatus: string | null
  type: string
  subType: string | null
  amount: string | null
  amountSign: 'positive' | 'negative' | null
  currency: string | null
  spendMerchant: string | null
  aftOriginatorName: string | null
  billPayCompanyName: string | null
  billPayPayeeNickname: string | null
  eTransferName: string | null
  eTransferEmail: string | null
  /** The security a trade, dividend or tax is about (e.g. VFV), and how many units. */
  assetSymbol?: string | null
  assetQuantity?: string | null
  p2pHandle: string | null
  counterPartyName: string | null
  institutionName: string | null
  opposingAccountId: string | null
}
interface Connection<T> {
  edges: Array<{ node: T }>
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

// Only the fields a sync uses (the web app asks for far more).
const ACCOUNTS = `query FetchAllAccountFinancials($identityId: ID!, $cursor: String) {
  identity(id: $identityId) {
    id
    accounts(filter: {}, first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id status unifiedAccountType nickname currency accountOwnerConfiguration
        financials { currentCombined { id netLiquidationValue { amount currency } } }
      } }
    }
  }
}`
const CREDIT_CARD = `query FetchCreditCardAccount($id: ID!) {
  creditCardAccount(id: $id) { id balance { current availableCreditLimit } }
}`
const ACTIVITIES = `query FetchActivityFeedItems($first: Int, $cursor: Cursor, $condition: ActivityCondition, $orderBy: [ActivitiesOrderBy!] = OCCURRED_AT_DESC) {
  activityFeedItems(first: $first, after: $cursor, condition: $condition, orderBy: $orderBy) {
    edges { node {
      accountId canonicalId occurredAt status unifiedStatus type subType amount amountSign currency
      spendMerchant aftOriginatorName billPayCompanyName billPayPayeeNickname eTransferName eTransferEmail
      p2pHandle counterPartyName institutionName opposingAccountId assetSymbol assetQuantity
    } }
    pageInfo { hasNextPage endCursor }
  }
}`

/** Buys and sells (DIY_BUY, MANAGED_SELL, CRYPTO_BUY…): kept, but not money in or out. */
const TRADE = /_(BUY|SELL)$/
/** What didn't happen: left out. */
const NOT_DONE = /^(failed|rejected|cancell?ed|expired)$/i

const ACCOUNT_NAMES: Record<string, string> = {
  CASH: 'Chequing',
  CASH_USD: 'Chequing (USD)',
  CREDIT_CARD: 'Credit card',
  SELF_DIRECTED_TFSA: 'TFSA',
  SELF_DIRECTED_RRSP: 'RRSP',
  SELF_DIRECTED_FHSA: 'FHSA',
  HISA_FHSA: 'FHSA',
  SELF_DIRECTED_CRYPTO: 'Crypto',
  SELF_DIRECTED_NON_REGISTERED: 'Non-registered',
  SELF_DIRECTED_NON_REGISTERED_MARGIN: 'Non-registered (margin)',
  CUSTOM_PORTFOLIO_NON_REGISTERED: 'Non-registered (custom portfolio)',
  HISA_PORTFOLIO_NON_REGISTERED: 'Savings',
  MANAGED_NON_REGISTERED: 'Managed non-registered',
  MANAGED_PORTFOLIO_NON_REGISTERED: 'Managed non-registered',
  MANAGED_TFSA: 'Managed TFSA',
  MANAGED_RRSP: 'Managed RRSP',
  PORTFOLIO_LINE_OF_CREDIT: 'Portfolio line of credit',
}
const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
function accountName(a: WsAccount): string {
  if (a.nickname) return sanitize(a.nickname)
  const name = ACCOUNT_NAMES[a.unifiedAccountType] ?? humanize(a.unifiedAccountType)
  return a.unifiedAccountType === 'CASH' && a.accountOwnerConfiguration === 'MULTI_OWNER' ? 'Joint chequing' : name
}

/**
 * Who it's with: a merchant as Wealthsimple sends it (“Amazon.Ca*7Q3KX81Z2”: the payee name rules call
 * it Amazon), the rest worded like Plaid's Wealthsimple data (which passes Wealthsimple's own on):
 * "Name - INTERAC e-Transfer®". What was set for Plaid's wording carries over when an account
 * switches (followBankPayee).
 */
export function wealthsimplePayee(a: WsActivity, accountNames: Map<string, string>): string {
  const name = (s: string | null) => (s ? sanitize(s) : '')
  const other = a.opposingAccountId ? accountNames.get(a.opposingAccountId) : undefined
  const sub = a.subType ?? ''
  switch (a.type) {
    case 'CREDIT_CARD':
      return sub === 'PAYMENT' ? 'Credit card payment' : name(a.spendMerchant) || 'Credit card'
    case 'SPEND':
      return name(a.spendMerchant) || 'Card purchase'
    case 'CREDIT_CARD_PAYMENT':
      return 'Credit card payment'
    case 'INTERNAL_TRANSFER':
      return sub === 'SOURCE' ? `Transfer to ${other ?? 'another account'}` : `Transfer from ${other ?? 'another account'}`
    case 'INTEREST':
      return 'Interest'
    case 'REIMBURSEMENT':
      return sub === 'CASHBACK' ? 'Cash back' : humanize(sub || 'Reimbursement')
    case 'PROMOTION':
    case 'REFERRAL':
      return `${humanize(a.type)} bonus`
    case 'OVERDRAFT_TRANSFER':
      return `Overdraft transfer${other ? ` from ${other}` : ''}`
    case 'INSTITUTIONAL_TRANSFER_INTENT':
      return `Transfer ${a.amountSign === 'negative' ? 'to' : 'from'} ${name(a.institutionName) || 'another institution'}`
  }
  if (TRADE.test(a.type)) return `${a.type.endsWith('BUY') ? 'Buy' : 'Sell'}${a.assetSymbol ? ` ${name(a.assetSymbol)}` : ''}`
  if (sub === 'E_TRANSFER') return `${name(a.eTransferName) || name(a.eTransferEmail) || 'Someone'} - INTERAC e-Transfer®`
  if (sub === 'AFT') return `${name(a.aftOriginatorName) || 'Unknown'} - ${a.type === 'DEPOSIT' ? 'Direct deposit' : 'Pre-authorized debit'}`
  if (sub === 'BILL_PAY') return `${name(a.billPayPayeeNickname) || name(a.billPayCompanyName) || 'Bill'} - Bill payment`
  if (sub === 'CHEQUE') return a.type === 'DEPOSIT' ? 'Cheque deposit' : 'Cheque'
  if (a.type === 'P2P_PAYMENT') return name(a.p2pHandle) || 'Wealthsimple transfer'
  // A dividend or withholding tax: the security it's from.
  const who = name(a.counterPartyName) || name(a.institutionName) || name(a.assetSymbol ?? null)
  const what = sub === 'EFT' ? 'Electronic funds transfer' : sub === 'WIRE' ? 'Wire transfer' : sub === 'BANK_DRAFT' ? 'Bank draft' : humanize(sub || a.type)
  return who ? `${who} - ${what}` : what
}

/**
 * An activity as a transaction: its date and time in your time zone, except what Wealthsimple
 * records by date only (on the hour exactly: interest, scheduled transfers), which keeps its date there.
 */
export function wealthsimpleTransaction(a: WsActivity, tz: string, accountNames: Map<string, string>): RemoteTransaction {
  const at = new Date(a.occurredAt.replace(/(\.\d{3})\d+/, '$1'))
  const dateOnly = at.getUTCMinutes() === 0 && at.getUTCSeconds() === 0 && at.getUTCMilliseconds() === 0
  const datetime = dateOnly ? null : localDateTimeInTz(tz, at)
  const cents = a.amount ? decimalToMinor(a.amount) : 0
  const raw = sanitize(a.spendMerchant ?? a.aftOriginatorName ?? a.billPayCompanyName ?? a.eTransferName ?? a.counterPartyName ?? '')
  const units = a.assetSymbol ? sanitize([a.assetQuantity, a.assetSymbol].filter(Boolean).join(' ')) : ''
  return {
    remoteId: a.canonicalId,
    date: todayInTz(dateOnly ? WEALTHSIMPLE_TZ : tz, at),
    ...(datetime ? { datetime } : {}),
    amountMinor: a.amountSign === 'negative' ? -Math.abs(cents) : Math.abs(cents),
    payee: wealthsimplePayee(a, accountNames),
    description: [humanize(a.type), a.subType && humanize(a.subType), raw, units].filter(Boolean).join(' · '),
    pending: (a.unifiedStatus ?? 'COMPLETED').toUpperCase() !== 'COMPLETED' || /^authori[sz]ed$/i.test(a.status ?? ''),
    ...(TRADE.test(a.type) ? { trade: true } : {}),
    raw: a,
  }
}

// Talking to Wealthsimple ------------------------------------------------------------------

/** How long a request to Wealthsimple may take. */
const TIMEOUT_MS = 30_000

export function createWealthsimple(opts: { fetch: typeof fetch; timeZone: () => string; now: () => Date }): WealthsimpleProvider {
  async function request(url: string, init: { headers?: Record<string, string>; body?: unknown } = {}, session?: Partial<WealthsimpleSession>) {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: '*/*', ...init.headers }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (session?.sessionId) headers['x-ws-session-id'] = session.sessionId
    if (session?.deviceId) headers['x-ws-device-id'] = session.deviceId
    let res: Response
    try {
      res = await opts.fetch(url, {
        method: init.body !== undefined ? 'POST' : 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new ProviderRequestError(`Wealthsimple didn’t answer within ${TIMEOUT_MS / 1000} seconds. Try again later.`, null)
      throw new ProviderRequestError(`Couldn't reach Wealthsimple: ${err instanceof Error ? err.message : err}`, null)
    }
    const text = await res.text()
    if (res.status === 429 || (res.status === 403 && /cloudflare|cf-ray/i.test(text))) {
      throw new ProviderRequestError('Wealthsimple is turning requests away for now (rate limited). The next sync tries again.', res.status)
    }
    let json: Record<string, any> | null = null // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text)
    } catch {
      // The login page and the app bundle aren't JSON.
    }
    return { res, text, json }
  }

  /** The device id (a cookie the login page sets) and the web app's OAuth client id (in its JS bundle). */
  async function bootstrap() {
    const page = await request(LOGIN_PAGE)
    const deviceId = page.res.headers
      .getSetCookie()
      .map((c) => /^wssdi=([a-f0-9-]+)/i.exec(c)?.[1])
      .find(Boolean)
    const bundle = /<script[^>]*src="([^"]+\/app-[a-f0-9]+\.js)"/i.exec(page.text)?.[1]
    if (!deviceId || !bundle) throw new ProviderRequestError('Wealthsimple’s sign-in page has changed, so this app can’t sign in for now.', page.res.status)
    const js = await request(new URL(bundle, LOGIN_PAGE).toString())
    const clientId = /"production"[^}]*clientId:"([a-f0-9]+)"/i.exec(js.text)?.[1]
    if (!clientId) throw new ProviderRequestError('Wealthsimple’s web app has changed, so this app can’t sign in for now.', js.res.status)
    return { deviceId, clientId }
  }

  async function graphql<T>(session: WealthsimpleSession, operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const { res, json } = await request(
      GRAPHQL,
      {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'x-ws-profile': 'trade',
          'x-ws-api-version': '12',
          'x-ws-locale': 'en-CA',
          'x-platform-os': 'web',
        },
        body: { operationName, query, variables },
      },
      session,
    )
    const errors = (json?.errors ?? []) as Array<{ message?: string; extensions?: { code?: string } }>
    if (res.status === 401 || errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED' || /not authori[sz]ed/i.test(e.message ?? ''))) {
      throw new ProviderRequestError('Wealthsimple wants you to sign in again.', 401, SIGN_IN_AGAIN)
    }
    if (!json?.data) {
      throw new ProviderRequestError(`Wealthsimple didn’t answer ${operationName} (HTTP ${res.status}${errors[0]?.message ? `: ${sanitize(errors[0].message)}` : ''}).`, res.status)
    }
    return json.data as T
  }

  async function allPages<T>(page: (cursor: string | null) => Promise<Connection<T>>): Promise<T[]> {
    const out: T[] = []
    let cursor: string | null = null
    // Thousands of transactions at most, 100 at a time.
    for (let i = 0; i < 200; i++) {
      const conn = await page(cursor)
      out.push(...conn.edges.map((e) => e.node))
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break
      cursor = conn.pageInfo.endCursor
    }
    return out
  }

  return {
    kind: 'wealthsimple',

    async signIn({ email, password, otp }) {
      const { deviceId, clientId } = await bootstrap()
      const pre = { deviceId, sessionId: crypto.randomUUID() }
      const headers: Record<string, string> = { ...OAUTH_HEADERS, 'x-ws-profile': 'undefined' }
      if (otp) headers['x-wealthsimple-otp'] = `${otp.replace(/\s+/g, '')};remember=true`
      const body = { grant_type: 'password', username: email, password, skip_provision: 'true', scope: SCOPE, client_id: clientId, otp_claim: null }
      const token = await request(`${OAUTH}/token`, { headers, body }, pre)
      if (!token.json?.access_token) {
        // Without a code, Wealthsimple refuses until it gets one (and sends it, or your authenticator app has it).
        if (token.json?.error === 'invalid_grant' && !otp) throw new ProviderRequestError('Enter the 2FA code from Wealthsimple.', 401, OTP_REQUIRED)
        throw new ProviderRequestError('Wealthsimple didn’t accept that. Check your email and password, and the 2FA code.', token.res.status)
      }
      const session: WealthsimpleSession = {
        email,
        identityId: '',
        clientId,
        ...pre,
        accessToken: token.json.access_token,
        refreshToken: token.json.refresh_token,
      }
      const info = await request(`${OAUTH}/token/info`, { headers: { ...OAUTH_HEADERS, Authorization: `Bearer ${session.accessToken}` } }, session)
      session.identityId = info.json?.identity_canonical_id ?? ''
      if (!session.identityId) throw new ProviderRequestError('Wealthsimple signed you in but didn’t say who you are.', info.res.status)
      return session
    },

    async refresh(session) {
      const res = await request(
        `${OAUTH}/token`,
        {
          headers: { ...OAUTH_HEADERS, 'x-ws-profile': 'invest' },
          body: { grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId },
        },
        session,
      )
      if (!res.json?.access_token || !res.json.refresh_token) {
        throw new ProviderRequestError('Wealthsimple wants you to sign in again.', res.res.status, SIGN_IN_AGAIN)
      }
      return { ...session, accessToken: res.json.access_token, refreshToken: res.json.refresh_token }
    },

    async fetchAccounts(session, { start, end, balancesOnly }) {
      const all = await allPages<WsAccount>(
        async (cursor) =>
          (await graphql<{ identity: { accounts: Connection<WsAccount> } }>(session, 'FetchAllAccountFinancials', ACCOUNTS, { identityId: session.identityId, cursor }))
            .identity.accounts,
      )
      const open = all.filter((a) => a.status === 'open')
      const names = new Map(all.map((a) => [a.id, accountName(a)]))
      const tz = opts.timeZone()
      const now = opts.now()

      // Every open account's activity in the window, all at once: chequing, cards and savings, and
      // investments (their trades kept, but marked).
      const ids = open.map((a) => a.id)
      const activity = new Map<string, RemoteTransaction[]>()
      if (!balancesOnly && ids.length) {
        const condition = {
          ...(start ? { startDate: todayInTz(WEALTHSIMPLE_TZ, new Date(start.getTime() - 86_400_000)) } : {}),
          endDate: todayInTz(WEALTHSIMPLE_TZ, end ?? new Date(now.getTime() + 86_400_000)),
          accountIds: ids,
        }
        const items = await allPages<WsActivity>(
          async (cursor) =>
            (await graphql<{ activityFeedItems: Connection<WsActivity> }>(session, 'FetchActivityFeedItems', ACTIVITIES, { first: 100, cursor, condition }))
              .activityFeedItems,
        )
        for (const a of items) {
          if (a.type === 'LEGACY_TRANSFER' || NOT_DONE.test(a.status ?? '') || NOT_DONE.test(a.unifiedStatus ?? '')) continue
          const list = activity.get(a.accountId) ?? []
          list.push(wealthsimpleTransaction(a, tz, names))
          activity.set(a.accountId, list)
        }
      }

      const accounts: RemoteAccount[] = []
      for (const a of open) {
        let balanceMinor = decimalToMinor(a.financials?.currentCombined?.netLiquidationValue?.amount ?? '0')
        let availableMinor: number | null = null
        if (a.unifiedAccountType === 'CREDIT_CARD') {
          // What's owed, as the app keeps a card's balance: negative.
          const card = (await graphql<{ creditCardAccount: { balance: { current: string; availableCreditLimit: string } } }>(session, 'FetchCreditCardAccount', CREDIT_CARD, { id: a.id }))
            .creditCardAccount
          balanceMinor = -decimalToMinor(card.balance.current)
          availableMinor = decimalToMinor(card.balance.availableCreditLimit)
        }
        accounts.push({
          remoteId: a.id,
          name: names.get(a.id)!,
          institution: 'Wealthsimple',
          institutionId: 'wealthsimple',
          currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'CAD',
          balanceMinor,
          availableMinor,
          balanceDate: now.toISOString(),
          transactions: activity.get(a.id) ?? [],
          error: null,
        })
      }
      return { accounts, errors: [], notice: null }
    },
  }
}
