import type { ISODate } from '@st/shared'

/** What every bank-data provider returns, in the app's terms (cents, local dates). */
export interface RemoteTransaction {
  /** Unique within the account; becomes the transaction's externalId. */
  remoteId: string
  date: ISODate
  /** When it happened, if the bank says to the second: local time on `date` (YYYY-MM-DDTHH:MM:SS). */
  datetime?: string | null
  amountMinor: number
  /** A cleaned-up payee when the provider has one, otherwise the bank's description. */
  payee: string
  /** The bank's own text for the transaction. */
  description: string
  pending: boolean
  /** The provider's id for the pending transaction this posted one replaces (Plaid says so). */
  replaces?: string
  /**
   * A buy or sell inside an investment account: money changes form, not hands. Kept with the rest,
   * never taken in as a transaction.
   */
  trade?: boolean
  /** The provider's category (Plaid's), e.g. "Transportation › Gas", and whether it's sure of it. */
  category?: { name: string; confident: boolean }
  /** What the provider sent for it, as it sent it (kept in the bank payload log). */
  raw?: unknown
}

export interface RemoteAccount {
  remoteId: string
  name: string
  institution: string | null
  /** The provider's id for the institution, which stays the same when its name changes. */
  institutionId: string | null
  currency: string
  balanceMinor: number
  availableMinor: number | null
  /** When the bank's balance was last updated (ISO timestamp). */
  balanceDate: string
  transactions: RemoteTransaction[]
  /** A problem with this account (or its bank login), as the provider worded it. */
  error: string | null
}

export interface ProviderError {
  code: string
  /** Shown to the user as the provider wrote it (sanitized). */
  message: string
  remoteAccountId?: string
}

export interface FetchResult {
  accounts: RemoteAccount[]
  errors: ProviderError[]
  notice: string | null
}

export interface FetchOptions {
  start?: Date
  end?: Date
  balancesOnly?: boolean
}

/** SimpleFIN: you paste a setup token, and each sync fetches a window of dates. */
export interface BankProvider {
  kind: 'simplefin'
  /** Turns what the user pastes (a setup token) into a secret to store. */
  claim(token: string): Promise<{ secret: string }>
  fetchAccounts(secret: string, opts: FetchOptions): Promise<FetchResult>
}

/** A transaction from Plaid, and the account it belongs to. */
export type PlaidTransaction = RemoteTransaction & { accountId: string }

/**
 * What changed since the last sync (Plaid's /transactions/sync), netted out across its pages: a
 * transaction added and later removed is only in `removed`.
 */
export interface PlaidChanges {
  /** New or changed transactions, each in its latest form. */
  changed: PlaidTransaction[]
  removed: Array<{ remoteId: string; accountId: string; raw?: unknown }>
  nextCursor: string
}

/**
 * Plaid: each bank login (an Item) is connected in Plaid Link in the browser, and each sync fetches
 * only what changed since the last one.
 */
export interface PlaidProvider {
  kind: 'plaid'
  /** For Plaid Link: adding a bank, or (with an access token) signing in to one again. */
  createLinkToken(opts: { userId: string; accessToken?: string }): Promise<{ linkToken: string; expiration: string }>
  /** Link's public token → the access token to store, and Plaid's id for the bank login. */
  exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }>
  /** The login's accounts and balances (no transactions), and the bank they're at. */
  fetchAccounts(accessToken: string): Promise<{ institution: { id: string; name: string } | null; accounts: RemoteAccount[] }>
  syncTransactions(accessToken: string, cursor: string | null): Promise<PlaidChanges>
  /** Ends Plaid's access to the bank login. */
  removeItem(accessToken: string): Promise<void>
}

/**
 * A problem talking to the provider; `status` is the HTTP status when there was one, `code` the
 * provider's error code (e.g. Plaid's ITEM_LOGIN_REQUIRED).
 */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null = null,
  ) {
    super(message)
  }
}
