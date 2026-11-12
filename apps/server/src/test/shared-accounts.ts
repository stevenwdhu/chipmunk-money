import { expect } from 'vitest'
import { addMonths, monthOf, monthRange, transactionQuerySchema, type ISODate } from '@chipmunk/shared'
import type { LlmCategorizer } from '../ai/types'
import { crossLedgerReferences } from '../db/move-rows'
import { UnscopedQuery } from '../db/scope'
import { balancesAt, getAccount } from '../services/accounts'
import type { ActivityActor } from '../services/activity'
import type { AppContext } from '../services/context'
import { netWorth } from '../services/reports'
import { today } from '../services/settings'
import { addMember } from '../services/sharing'
import { listTransactions } from '../services/transactions'
import type { Storage } from '../storage'
import { makeAccount, testLedger, testStorage } from './helpers'

/** Who the shared-account tests act as, in each ledger's activity. */
export const TESTER: ActivityActor = { name: 'Tester', apiKeyId: null }

type Other = 'family' | 'trip'

export interface SharedWorld {
  storage: Storage
  /** The home of the card. */
  personal: AppContext
  family: AppContext
  trip: AppContext
  /** Personal's credit card Visa, at TD. */
  visa: number
  ctxOf: Storage['ctxOf']
  /** Shares Visa with another ledger, through the sharing service. */
  share: (with_: AppContext) => void
  /** A transaction a ledger holds on an account, entered as by hand. */
  addTx: (ctx: AppContext, date: string, amountMinor: number, opts?: { account?: number; deleted?: boolean; payee?: string }) => number
}

/**
 * Three ledgers, Personal, Family and Trip, and Personal's credit card Visa (at TD, opening balance
 * `opening`) shared with the ledgers in `shareWith` (Family by default). Trip has the card only
 * when it's listed, so it is also the ledger that doesn't share. With `llm`, AI categorizes. With
 * `fetch`, a fake bank answers.
 */
export function sharedWorld(opts: { shareWith?: Other[]; opening?: number; now?: string; llm?: LlmCategorizer; fetch?: typeof fetch } = {}): SharedWorld {
  const storage = testStorage({ now: opts.now, llm: opts.llm, fetch: opts.fetch })
  const personal = storage.registry.defaultContext()
  const family = testLedger(storage, 'Family')
  const trip = testLedger(storage, 'Trip')
  const visa = makeAccount(personal, 'Visa', 'credit', opts.opening ?? 0, 'TD')
  const share = (with_: AppContext) => void addMember(personal, storage.ctxOf, visa, with_.ledger.id, TESTER)
  for (const name of opts.shareWith ?? ['family']) share({ family, trip }[name])
  const addTx: SharedWorld['addTx'] = (ctx, date, amountMinor, more = {}) =>
    Number(
      ctx.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, deleted_at)
         VALUES (@ledger, @account, @date, @amountMinor, @payee, lower(@payee), @deletedAt)`,
        { account: more.account ?? visa, date, amountMinor, payee: more.payee ?? 'Shop', deletedAt: more.deleted ? '2026-10-01T00:00:00Z' : null },
      ).lastInsertRowid,
    )
  return { storage, personal, family, trip, visa, ctxOf: storage.ctxOf, share, addTx }
}

const sum = (rows: Array<{ amount: number }>) => rows.reduce((s, r) => s + r.amount, 0)

/**
 * Checks one account's balance in every ledger that has it, today and at past dates (`dates`, or
 * each month's end over the last year): the parts sum to the account's total, and the total is what
 * the same rows give an account that isn't shared (the latest recorded balance and every row after
 * it, or the opening balance and every row). Only the opening ledger's part carries the opening
 * balance and the recorded balances: every other part is what its ledger holds. Each ledger's net
 * worth counts exactly its part, and on every page of its register each row's running balance is
 * the part less the ledger's own rows listed above it. What it expects is worked out here from each
 * ledger's own rows, not by the code it checks. Returns today's parts, by ledger slug, and the total.
 */
export function expectPartsSumToAccount(storage: Storage, accountId: number, opts: { dates?: ISODate[] } = {}) {
  const ledgers = storage.registry.defaultContext().accountWide.ledgers(accountId)
  expect(ledgers.length, `account ${accountId} is in no ledger`).toBeGreaterThan(0)
  const ctxs = ledgers.map((l) => storage.ctxOf(l.ledgerId))
  const home = ctxs[ledgers.findIndex((l) => l.isHome)]!
  const opening = ledgers.find((l) => l.isOpening)!.ledgerId
  const account = home.q.get<{ opening: number; openingDate: string | null }>(
    'SELECT opening_balance_minor AS opening, opening_date AS openingDate FROM ledger_accounts WHERE ledger_id = @ledger AND id = ?',
    accountId,
  )!
  const recorded = home.q.all<{ date: string; balance: number }>(
    `SELECT s.date, s.balance_minor AS balance FROM balance_snapshots s JOIN ledger_accounts a ON a.id = s.account_id AND a.ledger_id = @ledger
     WHERE s.account_id = ? ORDER BY s.date DESC, s.id DESC`,
    accountId,
  )
  const rows = new Map(
    ctxs.map((c) => [
      c.ledger.id,
      c.q.all<{ id: number; date: string; amount: number }>(
        'SELECT id, date, amount_minor AS amount FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NULL',
        accountId,
      ),
    ]),
  )
  const upTo = (ledgerId: string | null, d?: ISODate) => [...rows].flatMap(([id, rs]) => (ledgerId === null || id === ledgerId ? rs : [])).filter((r) => !d || r.date <= d)
  const latest = (d?: ISODate) => recorded.find((s) => !d || s.date <= d)
  const before = (d?: ISODate) => !!d && !!account.openingDate && d < account.openingDate

  // As if it weren't shared: every ledger's rows on one account. No date: every row, as the account shows.
  const total = (d?: ISODate) => {
    if (before(d)) return 0
    const s = latest(d)
    return s ? s.balance + sum(upTo(null, d).filter((r) => r.date > s.date)) : account.opening + sum(upTo(null, d))
  }
  const part = (ledgerId: string, d?: ISODate) => {
    if (before(d)) return 0
    const own = upTo(ledgerId, d)
    if (ledgerId !== opening) return sum(own)
    const s = latest(d)
    if (!s) return account.opening + sum(own)
    const others = [...ctxs].filter((c) => c.ledger.id !== ledgerId).flatMap((c) => upTo(c.ledger.id, s.date))
    return s.balance + sum(own.filter((r) => r.date > s.date)) - sum(others)
  }

  const t = today(home)
  const dates = opts.dates ?? Array.from({ length: 12 }, (_, i) => monthRange(addMonths(monthOf(t), -(12 - i))).to)
  const slugs = ledgers.map((l) => l.slug)

  // Today, as each ledger shows the account.
  const shown = ctxs.map((c) => getAccount(c, accountId))
  const parts = ledgers.map((l) => part(l.ledgerId))
  expect(shown.map((a) => a.balanceMinor), 'each ledger’s part today').toEqual(parts)
  expect(sum(parts.map((amount) => ({ amount }))), 'the parts sum to the total today').toBe(total())
  for (const a of shown) expect(a.sharing?.totalBalanceMinor ?? a.balanceMinor, 'the total each ledger shows').toBe(total())

  // At each date, and today with today as the upper date (as the charts have it).
  for (const d of [...dates, t]) {
    const at = ctxs.map((c) => balancesAt(c, [d]).get(accountId)![0]!)
    expect(at, `each ledger’s part on ${d} (${slugs.join(', ')})`).toEqual(ledgers.map((l) => part(l.ledgerId, d)))
    expect(sum(at.map((amount) => ({ amount }))), `the parts sum to the total on ${d}`).toBe(total(d))
  }

  ctxs.forEach((c, i) => {
    const l = ledgers[i]!
    // Net worth is every account's balance (a debt's is negative): what's left once the ledger's other accounts are taken out is its part.
    const report = netWorth(c, 13)
    const others = c.q.column<number>('SELECT id FROM ledger_accounts WHERE ledger_id = @ledger AND id <> ?', accountId)
    const balances = balancesAt(c, report.points.map((p) => p.date))
    report.points.forEach((p, k) => {
      const rest = others.reduce((s, id) => s + (balances.get(id)?.[k] ?? 0), 0)
      expect(p.netWorthMinor - rest, `${l.slug}’s net worth on ${p.date} counts its part`).toBe(part(l.ledgerId, p.date))
    })
    const listed = report.byAccount.find((a) => a.accountId === accountId)
    if (listed) expect(listed.balanceMinor, `${l.slug}’s net worth lists its part`).toBe(part(l.ledgerId, t))

    // The register's running balance, page by page: each row's is the part less the ledger's own rows listed above it.
    const own = new Map(rows.get(l.ledgerId)!.map((r) => [r.id, r.amount]))
    const register: Array<{ id: number; date: string; balanceAfterMinor: number | null }> = []
    for (let cursor: string | undefined; ; ) {
      const page = listTransactions(c, transactionQuerySchema.parse({ accountId, limit: 2, cursor }))
      register.push(...page.items)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(register.map((t) => t.id).sort((a, b) => a - b), `${l.slug}’s register lists its own rows`).toEqual([...own.keys()].sort((a, b) => a - b))
    expect(register.map((t) => t.date), `${l.slug}’s register, newest first`).toEqual(register.map((t) => t.date).sort().reverse())
    let above = 0
    register.forEach((t, k) => {
      if (t.balanceAfterMinor !== null) expect(t.balanceAfterMinor, `${l.slug}’s running balance after its row ${k + 1}`).toBe(parts[i]! - above)
      above += own.get(t.id)!
    })
  })

  return { parts: Object.fromEntries(ledgers.map((l, i) => [l.slug, parts[i]!])), totalMinor: total() }
}

/**
 * Nothing in the whole database refers across ledgers (crossLedgerReferences): a transaction's
 * account, category, recurring item, import batch and transfer pair, links, rejected pairs, tags,
 * dues and not-payments, and bank payloads, which point only at rows the home holds. What every
 * move, home change and stop sharing must leave.
 */
export function expectNoCrossLedgerReferences(storage: Storage) {
  expect(crossLedgerReferences(new UnscopedQuery(storage.sqlite)), 'references across ledgers').toEqual({})
}
