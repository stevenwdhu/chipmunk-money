import { asc, eq, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import {
  accountTypeInfo,
  addDays,
  BANK_PROVIDER_LABELS,
  formatMoney,
  todayInTz,
  type BankAccount,
  type BankConnection,
  type BankConnectionCreate,
  type BankProviderKind,
  type LinkableBankAccount,
  type PlaidConnect,
  type PlaidLinkToken,
  type SyncResult,
  type ISODate,
  type LinkPreview,
  type SwitchResult,
  type WealthsimpleConnect,
  type WealthsimpleConnectResult,
} from '@chipmunk/shared'
import type { z } from 'zod'
import type { accountBankSwitchSchema } from '@chipmunk/shared'
import { aiEnabled } from '../../ai/runner'
import { bankAccounts, bankConnections } from '../../db/meta-schema'
import { badRequest, notFound } from '../../lib/http'
import { ulid } from '../../lib/ids'
import type { Storage } from '../../storage'
import * as accounts from '../accounts'
import { recordActivity } from '../activity'
import type { AppContext } from '../context'
import * as institutions from '../institutions'
import { categorizeUncategorized } from '../import'
import { matchTransactions } from '../matching'
import { detectRecurring } from '../recurring'
import { bankSyncHours, effectiveTimezone, getAppSetting, plaidCredentials, setAppSetting } from '../settings'
import { keepRuleNames, rebuildPayeeKeys, worldOf } from '../payee-names'
import { applyPayeeChoices } from '../payees'
import { tidyNewPayees } from '../payee-tidy'
import { payeeKeyOf, payeeNameOf } from '../payee-namer'
import { applyRemoteTransactions, type ApplyScope } from './apply'
import { keepTransactions, oldestStored, storedStamp, storedTransactions, type Received } from './store'
import { applySwitch, localStamp, planSwitch } from './switching'
import { createPlaid } from './plaid'
import { createSimpleFin } from './simplefin'
import {
  createWealthsimple,
  OTP_REQUIRED,
  SIGN_IN_AGAIN as WS_SIGN_IN_AGAIN,
  wealthsimplePayee,
  type WealthsimpleProvider,
  type WealthsimpleSession,
  type WsActivity,
} from './wealthsimple'
import { ProviderRequestError, type BankProvider, type FetchResult, type PlaidChanges, type PlaidProvider, type RemoteAccount, type RemoteTransaction } from './types'

type ConnectionRow = typeof bankConnections.$inferSelect
type AccountRow = typeof bankAccounts.$inferSelect
/** What a provider sent: what each bank account's part of it is to keep, and how a linked one's is applied. */
interface Fetched_ {
  data: FetchResult
  /** Plaid: where the next sync picks up. */
  cursor?: string
  received: (acct: AccountRow, remote: RemoteAccount) => Received
  changesFor: (acct: AccountRow, remote: RemoteAccount) => { transactions: RemoteTransaction[]; scope: ApplyScope }
}
type Fetched = Fetched_ | { error: string }

const DAY = 86_400_000
/** SimpleFIN expects at most about 24 requests a day; keep some room for manual syncs. */
const MAX_REQUESTS_PER_DAY = 20
const HOUR = 60 * 60_000
/** After a failed sync, try again within 2 hours (sooner if syncs are more often than that). */
const RETRY_AFTER_ERROR_MS = 2 * HOUR
/** Re-read this many days before the last sync, to catch late-posting and changed transactions. */
const OVERLAP_DAYS = 5
/** SimpleFIN returns at most 90 days per request. */
const MAX_HISTORY_DAYS = 90
/**
 * How far back a newly linked, empty account starts: SimpleFIN's 90 days, Plaid's two years, or (as
 * far as it goes) Wealthsimple's whole history.
 */
const HISTORY_DAYS: Record<BankProviderKind, number> = { simplefin: MAX_HISTORY_DAYS, plaid: 730, wealthsimple: 3650 }
/** Who the activity log says made a change. */
const actor = (provider: BankProviderKind) => ({ name: { simplefin: 'SimpleFIN sync', plaid: 'Plaid sync', wealthsimple: 'Wealthsimple sync' }[provider], apiKeyId: null })
/** Plaid's error code for a bank that wants you to sign in again. */
const SIGN_IN_AGAIN = 'ITEM_LOGIN_REQUIRED'
/** How long a switch's review keeps its connections from syncing on their own, unless it ends first. */
const REVIEW_HOLD_MS = 15 * 60_000

/**
 * Bank connections, the accounts they bring, and syncing those accounts into ledgers.
 * Connections are app-wide (meta.db), from any of the services side by side: SimpleFIN (one
 * connection for all the banks you add there) and Plaid (one per bank login). Each ledger account
 * syncs from at most one bank account, so from one service.
 */
export class BankService {
  /** Syncs in progress, by connection. */
  private running = new Map<string, Promise<SyncResult>>()
  /**
   * Switches being reviewed (by ledger and account), and the connections they involve: those don't
   * sync on their own meanwhile, so what you review stays what's switched.
   */
  private holds = new Map<string, { connectionIds: string[]; until: number }>()
  private simplefin: BankProvider
  private plaid: PlaidProvider
  private wealthsimple: WealthsimpleProvider

  constructor(private storage: Storage) {
    this.simplefin = createSimpleFin({ fetch: storage.fetch, timeZone: () => effectiveTimezone(storage.meta), now: storage.now })
    this.plaid = createPlaid({ fetch: storage.fetch, credentials: () => plaidCredentials(storage.meta), timeZone: () => effectiveTimezone(storage.meta), now: storage.now })
    this.wealthsimple = createWealthsimple({ fetch: storage.fetch, timeZone: () => effectiveTimezone(storage.meta), now: storage.now })
  }

  private get db() {
    return this.storage.meta.db
  }
  private now() {
    return this.storage.now()
  }
  private tz() {
    return effectiveTimezone(this.storage.meta)
  }
  private localDate(at: Date | string) {
    return todayInTz(this.tz(), typeof at === 'string' ? new Date(at) : at)
  }

  private row(id: string): ConnectionRow {
    const row = this.db.select().from(bankConnections).where(eq(bankConnections.id, id)).get()
    if (!row) notFound('Bank connection not found')
    return row
  }
  private accountRows(connectionId?: string): AccountRow[] {
    const q = this.db.select().from(bankAccounts)
    // In the order the provider listed them.
    return (connectionId ? q.where(eq(bankAccounts.connectionId, connectionId)) : q).orderBy(sql`rowid`).all()
  }

  private recentRequests(row: ConnectionRow): string[] {
    const cutoff = this.now().getTime() - DAY
    return row.requestLog.filter((t) => Date.parse(t) > cutoff)
  }

  /** Records a request against the daily limit, or refuses when the limit is reached. */
  private takeRequest(row: ConnectionRow) {
    const recent = this.recentRequests(row)
    // Only SimpleFIN has a daily budget; Plaid's requests are just logged.
    if (row.provider === 'simplefin' && recent.length >= MAX_REQUESTS_PER_DAY) {
      const next = new Date(Date.parse(recent[0]!) + DAY)
      throw new HTTPException(429, {
        message: `SimpleFIN allows about 24 updates a day, and this connection has used them. Try again after ${next.toLocaleTimeString('en-CA', { timeZone: this.tz(), hour: 'numeric', minute: '2-digit' })}.`,
      })
    }
    const log = [...recent, this.now().toISOString()]
    this.db.update(bankConnections).set({ requestLog: log }).where(eq(bankConnections.id, row.id)).run()
    row.requestLog = log
  }

  /** Every connection with accounts syncs, linked or not, so what's kept of each bank account stays current. */
  private nextSyncAt(row: ConnectionRow, hasAccounts: boolean): string | null {
    if (!hasAccounts) return null
    if (!row.lastAttemptAt) return this.now().toISOString()
    const every = bankSyncHours(this.storage.meta, row.provider) * HOUR
    const wait = row.status === 'error' ? Math.min(RETRY_AFTER_ERROR_MS, every) : every
    return new Date(Date.parse(row.lastAttemptAt) + wait).toISOString()
  }

  private accountDTO(a: AccountRow): BankAccount {
    let link: BankAccount['link'] = null
    if (a.ledgerId && a.accountId) {
      const ledger = this.storage.registry.find(a.ledgerId)
      if (ledger) {
        const name = this.storage.registry
          .context(ledger.id)
          .sqlite.prepare('SELECT name FROM accounts WHERE id = ?')
          .get(a.accountId) as { name: string } | undefined
        if (name) link = { ledgerId: ledger.id, ledgerSlug: ledger.slug, ledgerName: ledger.name, accountId: a.accountId, accountName: name.name }
      }
    }
    return {
      id: a.id,
      remoteId: a.remoteId,
      name: a.name,
      institution: a.institution,
      remoteInstitutionId: a.remoteInstitutionId,
      currency: a.currency,
      balanceMinor: a.balanceMinor,
      availableMinor: a.availableMinor,
      balanceDate: a.balanceDate,
      link,
      syncFrom: a.syncFrom,
      lastSyncedAt: a.lastSyncedAt,
      error: a.error,
    }
  }

  private dto(row: ConnectionRow): BankConnection {
    const list = this.accountRows(row.id).map((a) => this.accountDTO(a))
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      status: row.status,
      errors: row.errors,
      notice: row.notice,
      lastAttemptAt: row.lastAttemptAt,
      lastSyncedAt: row.lastSyncedAt,
      nextSyncAt: this.nextSyncAt(row, list.length > 0),
      requestsLast24h: this.recentRequests(row).length,
      needsSignIn: row.errors.some((e) => e.code === (row.provider === 'wealthsimple' ? WS_SIGN_IN_AGAIN : SIGN_IN_AGAIN)),
      createdAt: row.createdAt,
      accounts: list,
    }
  }

  list(): BankConnection[] {
    return this.db.select().from(bankConnections).orderBy(asc(bankConnections.createdAt)).all().map((r) => this.dto(r))
  }

  get(id: string): BankConnection {
    return this.dto(this.row(id))
  }

  /** Claims a setup token, stores the access (encrypted) and lists the accounts it can see. */
  async connect(input: Omit<BankConnectionCreate, 'provider'>): Promise<BankConnection> {
    let secret: string
    try {
      ;({ secret } = await this.simplefin.claim(input.setupToken))
    } catch (err) {
      if (err instanceof ProviderRequestError) badRequest(err.message)
      throw err
    }
    const row: ConnectionRow = {
      id: ulid(this.now().getTime()),
      provider: 'simplefin',
      remoteId: null,
      cursor: null,
      name: input.name ?? 'SimpleFIN Bridge',
      secret: this.storage.secrets.seal(secret),
      status: 'ok',
      errors: [],
      notice: null,
      requestLog: [],
      lastAttemptAt: null,
      lastSyncedAt: null,
      createdAt: this.now().toISOString(),
    }
    this.db.insert(bankConnections).values(row).run()
    // Balances only: cheap, and enough to list the accounts for linking. Their transactions come with
    // the first sync, at the next check.
    try {
      this.takeRequest(row)
      const result = await this.simplefin.fetchAccounts(secret, { balancesOnly: true })
      this.saveRemote(row, result, { listing: true })
    } catch (err) {
      this.recordFailure(row, err)
    }
    return this.get(row.id)
  }

  /** This app's id at Plaid (Link wants one per user, and this app has one). */
  private plaidUserId(): string {
    let id = getAppSetting<string | null>(this.storage.meta, 'plaid.userId', null)
    if (!id) {
      id = ulid(this.now().getTime())
      setAppSetting(this.storage.meta, 'plaid.userId', id)
    }
    return id
  }

  /** A token for Plaid Link: to add a bank, or (with a connection) to sign in to it again. */
  async plaidLinkToken(connectionId?: string): Promise<PlaidLinkToken> {
    const row = connectionId ? this.row(connectionId) : null
    if (row && row.provider !== 'plaid') badRequest('That connection isn’t a Plaid one.')
    try {
      return await this.plaid.createLinkToken({ userId: this.plaidUserId(), accessToken: row ? this.storage.secrets.open(row.secret) : undefined })
    } catch (err) {
      if (err instanceof ProviderRequestError) badRequest(err.message)
      throw err
    }
  }

  /** Adds a bank connected in Plaid Link: stores its access (encrypted) and lists its accounts. */
  async connectPlaid(input: PlaidConnect): Promise<BankConnection> {
    let exchanged: { accessToken: string; itemId: string }
    let listed: { institution: { id: string; name: string } | null; accounts: RemoteAccount[] }
    try {
      exchanged = await this.plaid.exchange(input.publicToken)
      listed = await this.plaid.fetchAccounts(exchanged.accessToken)
    } catch (err) {
      if (err instanceof ProviderRequestError) badRequest(err.message)
      throw err
    }
    const secret = this.storage.secrets.seal(exchanged.accessToken)
    // The same bank login again (same item id at Plaid): keep the one connection, with the new access.
    const existing = this.db.select().from(bankConnections).where(eq(bankConnections.remoteId, exchanged.itemId)).get()
    const row: ConnectionRow = existing
      ? { ...existing, secret }
      : {
          id: ulid(this.now().getTime()),
          provider: 'plaid',
          remoteId: exchanged.itemId,
          cursor: null,
          name: input.name ?? listed.institution?.name ?? 'Plaid',
          secret,
          status: 'ok',
          errors: [],
          notice: null,
          requestLog: [],
          lastAttemptAt: null,
          lastSyncedAt: null,
          createdAt: this.now().toISOString(),
        }
    if (existing) this.db.update(bankConnections).set({ secret }).where(eq(bankConnections.id, row.id)).run()
    else this.db.insert(bankConnections).values(row).run()
    this.saveRemote(row, { accounts: listed.accounts, errors: [], notice: null }, { listing: !existing })
    return this.get(row.id)
  }

  /**
   * Signs in to Wealthsimple (read-only) and keeps the session, encrypted, never the password: a new
   * connection that lists your accounts, or (`connectionId`, or the same login again) the same one,
   * signed in again and synced. When Wealthsimple wants a 2FA code that wasn't given, nothing is kept
   * and `otpRequired` says to send the request again with it.
   */
  async connectWealthsimple(input: WealthsimpleConnect): Promise<WealthsimpleConnectResult> {
    const target = input.connectionId ? this.row(input.connectionId) : null
    if (target && target.provider !== 'wealthsimple') badRequest('That connection isn’t a Wealthsimple one.')
    let session: WealthsimpleSession
    try {
      session = await this.wealthsimple.signIn({ email: input.email, password: input.password, otp: input.otp })
    } catch (err) {
      if (err instanceof ProviderRequestError && err.code === OTP_REQUIRED) return { otpRequired: true, connection: null }
      if (err instanceof ProviderRequestError) badRequest(err.message)
      throw err
    }
    const secret = this.storage.secrets.seal(JSON.stringify(session))
    const same = this.db.select().from(bankConnections).all().find((c) => c.provider === 'wealthsimple' && c.remoteId === session.identityId)
    const existing = target ?? same
    if (target && same && same.id !== target.id) badRequest('That’s a different Wealthsimple login, already connected as another connection.')
    let row: ConnectionRow
    if (existing) {
      const patch = { secret, remoteId: session.identityId, status: 'ok' as const, errors: [] }
      this.db.update(bankConnections).set(patch).where(eq(bankConnections.id, existing.id)).run()
      row = { ...existing, ...patch }
    } else {
      const others = this.db.select().from(bankConnections).all().filter((c) => c.provider === 'wealthsimple').length
      row = {
        id: ulid(this.now().getTime()),
        provider: 'wealthsimple',
        remoteId: session.identityId,
        cursor: null,
        // Named after the login when there's more than one.
        name: input.name ?? (others ? `Wealthsimple (${session.email})` : 'Wealthsimple'),
        secret,
        status: 'ok',
        errors: [],
        notice: null,
        requestLog: [],
        lastAttemptAt: null,
        lastSyncedAt: null,
        createdAt: this.now().toISOString(),
      }
      this.db.insert(bankConnections).values(row).run()
    }
    // Signed in again: catch up straight away. New: list the accounts and balances, to choose from
    // (their transactions come with the first sync, at the next check).
    if (existing && this.accountRows(row.id).some((a) => a.ledgerId)) {
      await this.sync(row.id)
    } else {
      try {
        this.takeRequest(row)
        this.saveRemote(row, await this.wealthsimple.fetchAccounts(session, { balancesOnly: true }), { listing: true })
      } catch (err) {
        this.recordFailure(row, err)
      }
    }
    return { otpRequired: false, connection: this.get(row.id) }
  }

  rename(id: string, name: string): BankConnection {
    this.row(id)
    this.db.update(bankConnections).set({ name }).where(eq(bankConnections.id, id)).run()
    return this.get(id)
  }

  /**
   * Forgets the connection (for Plaid, also ending Plaid's access to the bank). Transactions already
   * synced stay; they just stop updating. Returns a note when Plaid couldn't be told.
   */
  async remove(id: string): Promise<{ note: string | null }> {
    const row = this.row(id)
    let note: string | null = null
    if (row.provider === 'plaid') {
      try {
        await this.plaid.removeItem(this.storage.secrets.open(row.secret))
      } catch (err) {
        note = `Plaid couldn’t be told to stop (${err instanceof Error ? err.message : err}); you can remove the bank in Plaid’s dashboard.`
      }
    }
    this.db.delete(bankConnections).where(eq(bankConnections.id, id)).run()
    return { note }
  }

  /** Bank accounts a ledger can sync from: those not syncing anywhere yet, and its own. */
  available(ledgerId: string): LinkableBankAccount[] {
    const connections = new Map(this.db.select().from(bankConnections).all().map((c) => [c.id, c]))
    return this.accountRows()
      .filter((a) => !a.ledgerId || a.ledgerId === ledgerId)
      .map((a) => {
        const c = connections.get(a.connectionId)!
        return { ...this.accountDTO(a), connectionId: c.id, connectionName: c.name, provider: c.provider }
      })
  }

  /** The bank account syncing into this ledger account, if any. */
  linkedTo(ledgerId: string, accountId: number): AccountRow | undefined {
    return this.accountRows().find((a) => a.ledgerId === ledgerId && a.accountId === accountId)
  }

  /**
   * Switches a ledger account to synced from `bankAccountId`. Transactions before `syncFrom` are never
   * imported, and by default there's no such date: it takes everything kept of the bank account, and
   * any older history a later fetch brings (one it has the same transactions in is matched, not added
   * twice, where it can tell; an account with transactions is better switched with a review, see
   * `previewSwitch`). Then `fill` brings it up to date. From then on its balance is the bank's (see
   * `alignWithBank`).
   */
  linkAccount(ctx: AppContext, accountId: number, input: { bankAccountId: string; syncFrom?: string | null }) {
    const acct = this.db.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId)).get()
    if (!acct) notFound('Bank account not found')
    const target = accounts.getAccount(ctx, accountId)
    if (acct.ledgerId && (acct.ledgerId !== ctx.ledger.id || acct.accountId !== target.id)) {
      const other = acct.ledgerId === ctx.ledger.id ? accounts.getAccount(ctx, acct.accountId!).name : 'an account in another ledger'
      throw new HTTPException(409, { message: `“${acct.name}” already syncs into ${other}. Switch that account to manual first.` })
    }
    // Switching which bank account feeds this account: the old one stops.
    const previous = this.linkedTo(ctx.ledger.id, target.id)
    if (previous && previous.id !== acct.id) {
      this.db.update(bankAccounts).set({ ledgerId: null, accountId: null }).where(eq(bankAccounts.id, previous.id)).run()
    }
    const sameLink = acct.accountId === target.id && acct.ledgerId === ctx.ledger.id
    // A date, or null for no limit. Not given: the same link keeps its date, and a new one has none.
    const syncFrom = input.syncFrom !== undefined ? input.syncFrom : sameLink ? acct.syncFrom : null
    this.db
      .update(bankAccounts)
      .set({
        ledgerId: ctx.ledger.id,
        accountId: target.id,
        syncFrom,
        // Re-linking the same account keeps its sync position; a new link starts from syncFrom.
        ...(sameLink && syncFrom === acct.syncFrom ? {} : { lastSyncedAt: null }),
        error: null,
      })
      .where(eq(bankAccounts.id, acct.id))
      .run()
    return { bankAccount: this.accountDTO(this.db.select().from(bankAccounts).where(eq(bankAccounts.id, acct.id)).get()!), connectionId: acct.connectionId }
  }

  /**
   * Brings a newly linked account up to date from what's kept of its bank account, without fetching:
   * its transactions from "sync from" on, and its balance. When nothing was fetched for it yet, its
   * connection's next sync brings them, and this returns null.
   */
  fill(ctx: AppContext, accountId: number): { added: number; adopted: number } | null {
    const acct = this.linkedTo(ctx.ledger.id, accountId)
    if (!acct?.fetchedAt || acct.lastSyncedAt) return null
    const provider = this.row(acct.connectionId).provider
    const meta = this.storage.meta.sqlite
    const from = acct.syncFrom ?? oldestStored(meta, acct.id) ?? this.localDate(this.now())
    const applied = applyRemoteTransactions(ctx, accountId, storedTransactions(meta, acct.id, acct.syncFrom), { from, to: this.localDate(this.now()), floor: acct.syncFrom }, provider)
    this.caughtUp(ctx, accountId, acct)
    this.settle(ctx, applied.newIds)
    return { added: applied.added, adopted: applied.adopted }
  }

  /**
   * A linked account now has everything kept of its bank account: the next sync carries on from when
   * that was fetched. Its balance is the bank's, and its opening date moves back to its oldest
   * transaction, so the balance chart covers them.
   */
  private caughtUp(ctx: AppContext, accountId: number, acct: AccountRow) {
    this.db.update(bankAccounts).set({ lastSyncedAt: acct.fetchedAt, error: null }).where(eq(bankAccounts.id, acct.id)).run()
    const target = accounts.getAccount(ctx, accountId)
    const oldest = ctx.sqlite.prepare('SELECT min(date) FROM transactions WHERE account_id = ? AND deleted_at IS NULL').pluck().get(accountId) as string | null
    if (target.openingDate && oldest && oldest < target.openingDate) ctx.sqlite.prepare('UPDATE accounts SET opening_date = ? WHERE id = ?').run(oldest, accountId)
    if (acct.balanceMinor !== null && acct.balanceDate) this.alignWithBank(ctx, accountId, { balanceMinor: acct.balanceMinor, balanceDate: acct.balanceDate })
  }

  /** As after a sync: refunds and card payments first, then recurring payments, then AI for the new ones. */
  private settle(ctx: AppContext, newIds: number[]) {
    const earliest = newIds.length
      ? (ctx.sqlite.prepare('SELECT min(date) FROM transactions WHERE id IN (SELECT value FROM json_each(?))').pluck().get(JSON.stringify(newIds)) as string)
      : null
    const { cleared } = matchTransactions(ctx, { earliest })
    if (!newIds.length && !cleared.length) return
    detectRecurring(ctx)
    if (aiEnabled(ctx)) void categorizeUncategorized(ctx, { ids: [...newIds, ...cleared] })
  }

  /** A bank account a ledger account can switch to: one that isn't syncing into another account. */
  private switchTarget(ctx: AppContext, accountId: number, bankAccountId: string): AccountRow {
    const acct = this.db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get()
    if (!acct) notFound('Bank account not found')
    if (acct.ledgerId && (acct.ledgerId !== ctx.ledger.id || acct.accountId !== accountId)) {
      throw new HTTPException(409, { message: `“${acct.name}” already syncs into another account. Switch that account to manual first.` })
    }
    return acct
  }

  /** What a switch's review was made from: the bank account's kept transactions, and the account's. */
  private switchVersion(ctx: AppContext, accountId: number, acct: AccountRow) {
    return `${storedStamp(this.storage.meta.sqlite, acct.id)}.${localStamp(ctx, accountId)}`
  }

  /** While a switch is reviewed, its connections (the account's and the bank account's) don't sync on their own. */
  private hold(ctx: AppContext, accountId: number, acct: AccountRow) {
    const current = this.linkedTo(ctx.ledger.id, accountId)
    const connectionIds = [...new Set([acct.connectionId, ...(current ? [current.connectionId] : [])])]
    this.holds.set(`${ctx.ledger.id}:${accountId}`, { connectionIds, until: this.now().getTime() + REVIEW_HOLD_MS })
  }

  /** The review of a switch ended (switched, or closed): its connections sync on their own again. */
  endReview(ctx: AppContext, accountId: number) {
    this.holds.delete(`${ctx.ledger.id}:${accountId}`)
  }

  private held(connectionId: string) {
    const now = this.now().getTime()
    for (const [key, h] of this.holds) {
      if (h.until < now) this.holds.delete(key)
      else if (h.connectionIds.includes(connectionId)) return true
    }
    return false
  }

  /**
   * An account's transactions next to what's kept of a bank account's, paired where they're the
   * same, to review before switching the account to sync from it. Nothing changes and nothing is
   * fetched. It compares from the oldest one kept, or from `from`. While it's reviewed, the
   * connections involved don't sync on their own (until `endReview`, or 15 minutes on).
   */
  previewSwitch(ctx: AppContext, accountId: number, input: { bankAccountId: string; from?: string | null }): LinkPreview {
    const target = accounts.getAccount(ctx, accountId)
    const acct = this.switchTarget(ctx, target.id, input.bankAccountId)
    const meta = this.storage.meta.sqlite
    const provider = this.row(acct.connectionId).provider
    const today = this.localDate(this.now())
    const first = ctx.sqlite.prepare('SELECT min(date) FROM transactions WHERE account_id = ? AND deleted_at IS NULL').pluck().get(target.id) as string | null
    const earliest = oldestStored(meta, acct.id) ?? today
    const from = input.from && input.from > earliest ? input.from : earliest
    const base = { from, to: today, earliest, first, provider, fetchedAt: acct.fetchedAt, version: this.switchVersion(ctx, target.id, acct) }
    // Nothing fetched for it yet: nothing to compare with.
    if (!acct.fetchedAt) return { ...base, rows: [] }
    const remote = storedTransactions(meta, acct.id, from)
    const rows = ctx.sqlite
      .prepare(
        `SELECT id, date, amount_minor AS amountMinor, name, payee, payee_key AS payeeKey, deleted_at IS NOT NULL AS deleted
         FROM transactions WHERE account_id = ? AND date >= ?`,
      )
      .all(target.id, addDays(from, -1)) as Array<{ id: number; date: string; amountMinor: number; name: string | null; payee: string; payeeKey: string; deleted: number }>
    const local = rows.map((r) => ({ ...r, deleted: !!r.deleted }))
    const plan = planSwitch(local, remote, (payee) => payeeKeyOf(ctx, payee))
    const L = new Map(local.map((l) => [l.id, l]))
    const R = new Map(remote.map((r) => [r.remoteId, r]))
    // Each side as it shows: its name, or what the payee name rules call its payee.
    const side = (id: number) => {
      const l = L.get(id)!
      return { id: l.id, date: l.date, payee: l.name ?? payeeNameOf(ctx, l.payee).name, amountMinor: l.amountMinor, deleted: l.deleted }
    }
    const remoteSide = (id: string) => {
      const r = R.get(id)!
      return { remoteId: r.remoteId, date: r.date, payee: payeeNameOf(ctx, r.payee).name, amountMinor: r.amountMinor, pending: r.pending }
    }
    const out: LinkPreview['rows'] = [
      ...plan.pairs.map((p) => ({ kind: p.guessed ? ('guessed' as const) : ('matched' as const), local: side(p.localId), remote: remoteSide(p.remoteId) })),
      ...plan.near.map((p) => ({ kind: 'near' as const, local: side(p.localId), remote: remoteSide(p.remoteId) })),
      ...plan.localOnly.filter((id) => L.get(id)!.date >= from).map((id) => ({ kind: 'local' as const, local: side(id), remote: null })),
      ...plan.remoteOnly.map((id) => ({ kind: 'remote' as const, local: null, remote: remoteSide(id) })),
    ]
    const dateOf = (r: LinkPreview['rows'][number]) => (r.remote?.date ?? r.local!.date) > (r.local?.date ?? '') ? (r.remote?.date ?? r.local!.date) : r.local!.date
    out.sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
    this.hold(ctx, target.id, acct)
    return { ...base, rows: out }
  }

  /**
   * Switches an account to sync from a bank account, as you decided in the review (`previewSwitch`),
   * from the same kept transactions: the pairs take the bank's ids, the bank's others are added or
   * skipped, and yours it doesn't have are deleted or kept. When either side changed since the review
   * (a sync, an edit), nothing changes: review it again. The next sync carries on from there.
   */
  switchAccount(ctx: AppContext, accountId: number, input: z.output<typeof accountBankSwitchSchema>): SwitchResult & { bankAccount: BankAccount } {
    const target = accounts.getAccount(ctx, accountId)
    const acct = this.switchTarget(ctx, target.id, input.bankAccountId)
    if (input.version !== this.switchVersion(ctx, target.id, acct)) {
      throw new HTTPException(409, { message: 'Transactions changed since this review was made (a sync, or an edit). It has been made again: check it, then switch.' })
    }
    const provider = this.row(acct.connectionId).provider
    const remote = storedTransactions(this.storage.meta.sqlite, acct.id, input.from)
    // Reviewed from the oldest one kept (as it starts): no limit. From later, only from there on.
    const oldest = oldestStored(this.storage.meta.sqlite, acct.id)
    const { bankAccount } = this.linkAccount(ctx, target.id, { bankAccountId: acct.id, syncFrom: oldest && input.from > oldest ? input.from : null })
    const { newIds, ...result } = applySwitch(ctx, target.id, provider, remote, input)
    this.caughtUp(ctx, target.id, acct)
    // As after a sync: refunds and card payments, recurring payments, then AI for the new ones.
    matchTransactions(ctx, { earliest: input.from })
    detectRecurring(ctx)
    if (newIds.length && aiEnabled(ctx)) void categorizeUncategorized(ctx, { ids: newIds })
    this.endReview(ctx, target.id)
    return { ...result, bankAccount: { ...bankAccount, lastSyncedAt: acct.fetchedAt } }
  }

  /**
   * What each synced account's connection sent, as kept, applied again to the transactions it's
   * on: nothing is fetched, added (one you deleted for good stays gone) or removed. They then have
   * what the connection says now (its payees, since they follow it), as a sync bringing all of it
   * would. Returns how many changed.
   */
  applyKept(): number {
    const linked = this.storage.meta.sqlite
      .prepare(
        `SELECT a.id, a.ledger_id AS ledgerId, a.account_id AS accountId, a.sync_from AS syncFrom, c.provider
         FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id
         WHERE a.ledger_id IS NOT NULL AND a.account_id IS NOT NULL`,
      )
      .all() as Array<{ id: string; ledgerId: string; accountId: number; syncFrom: string | null; provider: BankProviderKind }>
    let changed = 0
    for (const a of linked) {
      if (!this.storage.registry.find(a.ledgerId)) continue
      const ctx = this.storage.registry.context(a.ledgerId)
      if (!ctx.sqlite.prepare('SELECT 1 FROM accounts WHERE id = ?').get(a.accountId)) continue
      const ids = new Set(ctx.sqlite.prepare('SELECT external_id FROM transactions WHERE account_id = ? AND external_id IS NOT NULL').pluck().all(a.accountId) as string[])
      const remote = storedTransactions(this.storage.meta.sqlite, a.id, a.syncFrom).filter((r) => ids.has(r.remoteId))
      changed += applyRemoteTransactions(ctx, a.accountId, remote, { removed: [], floor: a.syncFrom }, a.provider).updated
    }
    return changed
  }

  /**
   * After how payees are named changes (PAYEE_RULES_VERSION), nothing fetched: Wealthsimple's
   * merchants, as kept, are made again from what it sent (the rest of its wording names accounts this
   * one may not know), then applied. Coming from before the built-in cleanup went (`from`, the
   * version payees were made by, under 6), payees your rules named stay named (keepRuleNames). Then
   * every transaction whose payee is now another one moves to it, carrying over what was set for the
   * old one. From before 8, payees you always set one way give their category to transactions that
   * became theirs without it. Returns how many changed.
   */
  refreshPayees(from = 0): number {
    const meta = this.storage.meta.sqlite
    const accounts = meta
      .prepare(`SELECT a.id, a.connection_id AS connectionId, a.remote_id AS remoteId, a.name FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id WHERE c.provider = 'wealthsimple'`)
      .all() as Array<{ id: string; connectionId: string; remoteId: string; name: string }>
    const update = meta.prepare("UPDATE bank_transactions SET data = json_set(data, '$.payee', ?) WHERE bank_account_id = ? AND remote_id = ?")
    meta.transaction(() => {
      for (const a of accounts) {
        const names = new Map(accounts.filter((o) => o.connectionId === a.connectionId).map((o) => [o.remoteId, o.name]))
        const kept = meta.prepare('SELECT remote_id AS remoteId, data FROM bank_transactions WHERE bank_account_id = ?').all(a.id) as Array<{ remoteId: string; data: string }>
        for (const k of kept) {
          const r = JSON.parse(k.data) as RemoteTransaction
          if (!(r.raw as WsActivity | undefined)?.spendMerchant) continue
          const payee = wealthsimplePayee(r.raw as WsActivity, names)
          if (payee !== r.payee) update.run(payee, a.id, k.remoteId)
        }
      }
    })()
    // Payees your rules named by what the built-in cleanup made of them stay named.
    if (from < 6) keepRuleNames(worldOf(this.storage))
    let changed = this.applyKept()
    for (const l of this.storage.registry.list()) {
      const ctx = this.storage.registry.context(l.id)
      changed += rebuildPayeeKeys(ctx).length
      // Transactions that became a payee you always set one way before that applied (from version 8).
      if (from < 8) changed += applyPayeeChoices(ctx).length
    }
    return changed
  }

  /** Switches a ledger account back to manual. Its transactions stay; they just stop updating. */
  unlinkAccount(ctx: AppContext, accountId: number) {
    const linked = this.linkedTo(ctx.ledger.id, accountId)
    if (!linked) throw new HTTPException(409, { message: 'This account isn’t synced.' })
    this.db.update(bankAccounts).set({ ledgerId: null, accountId: null }).where(eq(bankAccounts.id, linked.id)).run()
    return this.accountDTO(linked)
  }

  /** `listing`: only listing a new connection's accounts, so its first full sync is still due. */
  private saveRemote(row: ConnectionRow, result: FetchResult, opts: { listing?: boolean } = {}) {
    const existing = new Map(this.accountRows(row.id).map((a) => [a.remoteId, a]))
    for (const r of result.accounts) {
      const values = {
        name: r.name,
        institution: r.institution,
        remoteInstitutionId: r.institutionId,
        currency: r.currency,
        balanceMinor: r.balanceMinor,
        availableMinor: r.availableMinor,
        balanceDate: r.balanceDate,
      }
      const found = existing.get(r.remoteId)
      if (found) this.db.update(bankAccounts).set(values).where(eq(bankAccounts.id, found.id)).run()
      else this.db.insert(bankAccounts).values({ id: ulid(this.now().getTime()), connectionId: row.id, remoteId: r.remoteId, ...values }).run()
    }
    const patch = {
      status: (result.errors.length ? 'attention' : 'ok') as ConnectionRow['status'],
      errors: result.errors,
      notice: result.notice,
      lastAttemptAt: opts.listing ? row.lastAttemptAt : this.now().toISOString(),
      lastSyncedAt: this.now().toISOString(),
    }
    this.db.update(bankConnections).set(patch).where(eq(bankConnections.id, row.id)).run()
    Object.assign(row, patch)
  }

  /** Keeps what each bank account's part of a sync brought (all of them, linked or not). */
  private keep(row: ConnectionRow, fetched: Fetched_) {
    const now = this.now().toISOString()
    for (const acct of this.accountRows(row.id)) {
      const remote = fetched.data.accounts.find((r) => r.remoteId === acct.remoteId)
      // Not reported, or with a problem: what it sent may be partial.
      if (!remote || remote.error) continue
      keepTransactions(this.storage.meta.sqlite, acct.id, fetched.received(acct, remote), now)
      this.db.update(bankAccounts).set({ fetchedAt: now }).where(eq(bankAccounts.id, acct.id)).run()
    }
  }

  private recordFailure(row: ConnectionRow, err: unknown) {
    if (err instanceof HTTPException && err.status === 429) throw err
    const message = err instanceof Error ? err.message : String(err)
    // Keep the provider's code (say, Plaid's ITEM_LOGIN_REQUIRED, which offers Reconnect).
    const code = (err instanceof ProviderRequestError && err.code) || 'gen.'
    const patch = { status: 'error' as const, errors: [{ code, message }], lastAttemptAt: this.now().toISOString() }
    this.db.update(bankConnections).set(patch).where(eq(bankConnections.id, row.id)).run()
    Object.assign(row, patch)
    if (!(err instanceof ProviderRequestError)) console.error('[bank] sync failed', err)
  }

  /**
   * Fetches new data for every bank account of the connection, keeps it, and applies it to the
   * linked ones. With `full`, it fetches all the history the provider gives instead of what's new:
   * Plaid's from the start (up to 2 years), SimpleFIN's 90 days, Wealthsimple's all of it.
   */
  async sync(id: string, opts: { full?: boolean } = {}): Promise<SyncResult> {
    const row = this.row(id)
    if (this.running.has(id)) throw new HTTPException(409, { message: 'This connection is already syncing.' })
    const run = this.runSync(row, !!opts.full)
    this.running.set(id, run)
    try {
      return await run
    } finally {
      this.running.delete(id)
    }
  }

  private async runSync(row: ConnectionRow, full: boolean): Promise<SyncResult> {
    const all = this.accountRows(row.id)
    const fetched =
      row.provider === 'plaid'
        ? await this.fetchPlaid(row, all, full)
        : row.provider === 'wealthsimple'
          ? await this.fetchWealthsimple(row, all, full)
          : await this.fetchSimpleFin(row, all, full)
    const result: SyncResult = { connectionId: row.id, ok: true, error: null, notice: null, accounts: [] }
    if ('error' in fetched) return { ...result, ok: false, error: fetched.error }
    this.saveRemote(row, fetched.data)
    this.keep(row, fetched)
    result.notice = fetched.data.notice
    // Linked now, not when the fetch started: an account switched meanwhile takes this in, and the
    // bank account it left doesn't.
    const linked = this.accountRows(row.id).filter((a) => a.ledgerId && a.accountId)
    this.applyToLinked(row, linked, fetched.data.accounts, fetched.changesFor, result)
    // Plaid: the next sync picks up where this one left off, now that its changes are in.
    if (fetched.cursor !== undefined) this.db.update(bankConnections).set({ cursor: fetched.cursor }).where(eq(bankConnections.id, row.id)).run()
    // New payees get named by AI tidying, when it's on (in the background).
    void tidyNewPayees(worldOf(this.storage))
    return result
  }

  /**
   * Where a window starts for an account (SimpleFIN, Wealthsimple): just before its last sync (unless
   * `full`), or its "sync from" date, but no further back than the service goes.
   */
  private fromFor(a: AccountRow, today: string, full = false, maxDays = MAX_HISTORY_DAYS) {
    const oldest = addDays(today, -maxDays)
    const since = a.lastSyncedAt && !full ? addDays(this.localDate(a.lastSyncedAt), -OVERLAP_DAYS) : (a.syncFrom ?? oldest)
    const floor = a.syncFrom && a.syncFrom > since ? a.syncFrom : since
    return floor < oldest ? oldest : floor
  }

  /**
   * Where the fetch starts for a bank account (SimpleFIN, Wealthsimple): just before it was last
   * fetched, or (never fetched, or `full`) as far back as the service goes. A linked one's no later
   * than its ledger account needs (`fromFor`).
   */
  private fetchFrom(a: AccountRow, today: string, full: boolean, maxDays: number) {
    const oldest = addDays(today, -maxDays)
    const kept = a.fetchedAt && !full ? addDays(this.localDate(a.fetchedAt), -OVERLAP_DAYS) : oldest
    const needed = a.ledgerId && a.accountId ? this.fromFor(a, today, full, maxDays) : kept
    const from = needed < kept ? needed : kept
    return from < oldest ? oldest : from
  }

  /** SimpleFIN: one request covers every account, from the earliest point any of them needs. */
  private async fetchSimpleFin(row: ConnectionRow, all: AccountRow[], full: boolean): Promise<Fetched> {
    const now = this.now()
    const today = this.localDate(now)
    const start = all.length ? all.map((a) => this.fetchFrom(a, today, full, MAX_HISTORY_DAYS)).sort()[0]! : null
    try {
      this.takeRequest(row)
      // SimpleFIN caps a request at 90 days, so start no earlier than 89 days before the end.
      const end = new Date(now.getTime() + DAY)
      const earliest = end.getTime() - (MAX_HISTORY_DAYS - 1) * DAY
      const from = start ? new Date(Math.max(Date.parse(`${addDays(start, -1)}T00:00:00Z`), earliest)) : undefined
      const data = await this.simplefin.fetchAccounts(this.storage.secrets.open(row.secret), { start: from, end, balancesOnly: !all.length })
      const window = from ? { from: this.localDate(from), to: today } : null
      return {
        data,
        received: (_, remote) => ({ transactions: remote.transactions, window, removed: [] }),
        changesFor: (acct, remote) => ({ transactions: remote.transactions, scope: { from: this.fromFor(acct, today, full), to: today, floor: acct.syncFrom } }),
      }
    } catch (err) {
      this.recordFailure(row, err)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** A fresh Wealthsimple session, kept straight away: the old refresh token stops working. */
  private async wealthsimpleSession(row: ConnectionRow): Promise<WealthsimpleSession> {
    const session = await this.wealthsimple.refresh(JSON.parse(this.storage.secrets.open(row.secret)) as WealthsimpleSession)
    const secret = this.storage.secrets.seal(JSON.stringify(session))
    this.db.update(bankConnections).set({ secret }).where(eq(bankConnections.id, row.id)).run()
    row.secret = secret
    return session
  }

  /**
   * Wealthsimple: a fresh session first (kept straight away: the old refresh token stops working),
   * then one window covering every linked account, as far back as each needs.
   */
  private async fetchWealthsimple(row: ConnectionRow, all: AccountRow[], full: boolean): Promise<Fetched> {
    const now = this.now()
    const today = this.localDate(now)
    const maxDays = HISTORY_DAYS.wealthsimple
    const start = all.length ? all.map((a) => this.fetchFrom(a, today, full, maxDays)).sort()[0]! : null
    try {
      this.takeRequest(row)
      const session = await this.wealthsimpleSession(row)
      const data = await this.wealthsimple.fetchAccounts(session, {
        start: start ? new Date(`${start}T00:00:00Z`) : undefined,
        end: new Date(now.getTime() + DAY),
        balancesOnly: !all.length,
      })
      const window = start ? { from: start, to: today } : null
      return {
        data,
        received: (_, remote) => ({ transactions: remote.transactions, window, removed: [] }),
        changesFor: (acct, remote) => ({ transactions: remote.transactions, scope: { from: this.fromFor(acct, today, full, maxDays), to: today, floor: acct.syncFrom } }),
      }
    } catch (err) {
      this.recordFailure(row, err)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Plaid: the login's accounts and balances, then what changed since the last sync. */
  private async fetchPlaid(row: ConnectionRow, all: AccountRow[], full: boolean): Promise<Fetched> {
    try {
      this.takeRequest(row)
      const access = this.storage.secrets.open(row.secret)
      const { accounts: remoteAccounts } = await this.plaid.fetchAccounts(access)
      // From the start, Plaid sends everything it has again (applying it twice changes nothing): when
      // asked, or when an account's transactions were never kept.
      const fresh = full || all.some((a) => !a.fetchedAt)
      const changes: PlaidChanges = await this.plaid.syncTransactions(access, fresh ? null : row.cursor)
      return {
        data: { accounts: remoteAccounts, errors: [], notice: null },
        cursor: changes.nextCursor,
        received: (acct) => ({
          transactions: changes.changed.filter((t) => t.accountId === acct.remoteId),
          window: null,
          removed: changes.removed.filter((r) => r.accountId === acct.remoteId),
        }),
        changesFor: (acct) => ({
          transactions: changes.changed.filter((t) => t.accountId === acct.remoteId),
          scope: { removed: changes.removed.filter((r) => r.accountId === acct.remoteId), floor: acct.syncFrom },
        }),
      }
    } catch (err) {
      this.recordFailure(row, err)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * A synced account's balance is the bank's. An investment's, loan's or property's value also moves
   * on its own, so the bank's is recorded as its balance that day (as it is for any account with
   * balances recorded on it). Otherwise its starting balance takes up any difference, so its history
   * adds up to what the bank shows.
   */
  private alignWithBank(ctx: AppContext, accountId: number, remote: Pick<RemoteAccount, 'balanceMinor' | 'balanceDate'>) {
    const current = accounts.getAccount(ctx, accountId)
    const gap = remote.balanceMinor - current.balanceMinor
    if (!gap) return
    if (accountTypeInfo(current.type).revalued || current.balanceAsOf) {
      accounts.setBalance(ctx, accountId, { date: this.localDate(remote.balanceDate), balanceMinor: remote.balanceMinor }, 'sync')
    } else {
      accounts.updateAccount(ctx, accountId, { openingBalanceMinor: current.openingBalanceMinor + gap })
    }
  }

  /** Puts what the bank reported into each linked ledger account. */
  private applyToLinked(row: ConnectionRow, linked: AccountRow[], remoteAccounts: RemoteAccount[], changesFor: Fetched_['changesFor'], result: SyncResult) {
    const now = this.now()
    const touched = new Map<string, { ctx: AppContext; newIds: number[] }>()
    for (const acct of linked) {
      const remote = remoteAccounts.find((r) => r.remoteId === acct.remoteId)
      const ledger = this.storage.registry.find(acct.ledgerId!)
      const ctx = ledger ? this.storage.registry.context(ledger.id) : null
      const target = ctx
        ? (ctx.sqlite.prepare('SELECT id, name, institution_id AS institutionId FROM accounts WHERE id = ?').get(acct.accountId) as
            | { id: number; name: string; institutionId: number }
            | undefined)
        : undefined
      if (!ledger || !ctx || !target) {
        // The ledger or account is gone: stop syncing it.
        this.db.update(bankAccounts).set({ ledgerId: null, accountId: null }).where(eq(bankAccounts.id, acct.id)).run()
        continue
      }
      const providerError = remote?.error ?? null
      const summary = { bankAccountId: acct.id, name: acct.name, ledger: ledger.slug, accountId: target.id, accountName: target.name, added: 0, updated: 0, adopted: 0, removed: 0, error: providerError }
      if (!remote) {
        summary.error = `${BANK_PROVIDER_LABELS[row.provider]} didn’t return this account this time.`
        this.db.update(bankAccounts).set({ error: summary.error }).where(eq(bankAccounts.id, acct.id)).run()
        result.accounts.push(summary)
        continue
      }

      const { transactions, scope } = changesFor(acct, remote)
      const applied = applyRemoteTransactions(ctx, target.id, transactions, scope, row.provider)
      Object.assign(summary, { added: applied.added, updated: applied.updated, adopted: applied.adopted, removed: applied.removed })
      if (!providerError) this.alignWithBank(ctx, target.id, remote)
      const entry = touched.get(ledger.id) ?? { ctx, newIds: [] }
      entry.newIds.push(...applied.newIds)
      touched.set(ledger.id, entry)

      const changed = summary.added + summary.updated + summary.adopted + summary.removed
      if (changed) {
        const parts = [
          summary.added && `${summary.added} new`,
          summary.updated && `${summary.updated} updated`,
          summary.adopted && `${summary.adopted} matched`,
          summary.removed && `${summary.removed} removed`,
        ].filter(Boolean)
        recordActivity(ctx, actor(row.provider), {
          action: 'sync',
          entity: 'account',
          entityId: target.id,
          summary: `Synced ${target.name} from ${acct.institution ?? acct.name}: ${parts.join(', ')}`,
          after: { added: summary.added, updated: summary.updated, adopted: summary.adopted, removed: summary.removed, bankBalance: formatMoney(remote.balanceMinor, remote.currency) },
        })
      }
      this.db
        .update(bankAccounts)
        .set({ lastSyncedAt: now.toISOString(), error: providerError })
        .where(eq(bankAccounts.id, acct.id))
        .run()
      result.accounts.push(summary)
    }

    for (const { ctx, newIds } of touched.values()) this.settle(ctx, newIds)
  }

  /** Connections whose scheduled sync is due (not while a switch involving them is reviewed). */
  due(): string[] {
    const now = this.now().toISOString()
    return this.list()
      .filter((c) => c.nextSyncAt && c.nextSyncAt <= now && !this.held(c.id))
      .map((c) => c.id)
  }
}
