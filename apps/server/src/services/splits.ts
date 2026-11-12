import { formatMoney, type ISODate, type Transaction, type TransactionSplit, type TransactionSplitShare } from '@chipmunk/shared'
import { HTTPException } from 'hono/http-exception'
import { badRequest } from '../lib/http'
import type { AccountLedger, SplitRowHeld, SplitShare } from './account-rows'
import { recordActivity, type ActivityActor } from './activity'
import type { UsableLedgers } from './bank/service'
import type { AppContext, CtxOf } from './context'
import { payeeKeyOf } from './payee-namer'
import { getTransaction, transferCategoryId } from './transactions'

/**
 * Splitting a card payment between the ledgers that share its account. The payment arrives as one
 * row in the ledger that holds it (the home, unless it was moved), and without a split that ledger's
 * part takes the whole credit while the others' debts never go down. A split doesn't change the
 * bank's row: it keeps its amount, its bank id and its pairing with the withdrawal that paid it.
 * Beside it, on the same account, the split adds rows that name it (transactions.split_of):
 *
 * - a **share** in each other ledger: its amount as a credit, with the payment's payee, date and
 *   status, in that ledger's category for card payments.
 * - one **given** row in the ledger that holds the payment: a debit for everything it gave, under a
 *   payee of its own (GIVEN_PAYEE), so nothing ever takes it for a purchase from the card's merchant.
 *
 * The split rows sum to zero, so the account's total, its sync, the bank id, a CSV's duplicates and
 * the transfer pair are as they were, and each ledger's part moves by its share. They're in a
 * category left out of totals, so no ledger counts them as spending or income. They're made by hand
 * (origin manual, category yours), nothing learns from them, and no matching, recurring item or
 * link takes them. While the split lasts, the database keeps the payment and its split rows on their
 * account and in their ledgers, and live (migration 0003), and the edits here refuse what would
 * break it (checkSplitEdit, refuseSplitDelete, refuseSplitLink).
 *
 * The form gives one amount for each ledger other than the account's home, and the home keeps the
 * rest. setSplit takes it as it is (`shares`), whichever ledger holds the payment:
 * - the home holds it: each listed ledger gets a share row of its amount, and the home's given row
 *   is all of them.
 * - another ledger holds it (it was moved there, or the home changed): that ledger's own amount, when
 *   it's listed, is what it keeps (it gets no share row). The other listed ledgers get theirs, the
 *   home gets a share row for the rest, and the holder's given row is the payment less its own amount.
 * An empty list undoes the split: the holder keeps the whole payment. (For the home to have all of a
 * payment another ledger holds, that ledger moves it home.)
 *
 * A split ends or shrinks four ways. undoSplit and dropShare give amounts back to the holder, so
 * balances change. detachShare and detachSplit turn split rows into ordinary rows and change no
 * ledger's balance. leaveSplits is for a ledger leaving the account, and uses them.
 */

/** The payee of a given row: its own, never a merchant's. */
export const GIVEN_PAYEE = 'Split between ledgers'

const UNDO_FIRST = 'It’s split between ledgers. Undo the split first.'
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

/** Thrown to end a dry run's transaction: a throw out of a transaction rolls it back. */
const ROLL_BACK = new Error('dry run')

/** What a row is in a split, as the ledger that has it sees it. */
export type SplitPart =
  | { part: 'payment'; paymentId: number }
  | { part: 'given'; paymentId: number }
  | { part: 'share'; paymentId: number; holder: { slug: string; name: string } }

/** A payment as this ledger holds it, with what a split copies from it. */
interface Payment {
  id: number
  accountId: number
  accountName: string
  amount: number
  date: string
  datetime: string | null
  status: 'cleared' | 'pending'
  payee: string
  currency: string
}

interface SplittableRow extends Payment {
  categoryId: number | null
  excluded: number
  splitOf: number | null
  deletedAt: string | null
  pairId: number | null
  linked: number
  /** It's split already: this ledger has its given row. */
  isSplit: number
}

export interface SplitInput {
  /**
   * One amount for each ledger other than the account's home that gets part of the payment: the home
   * keeps the rest. When the payment's holder isn't the home, its own amount is what it keeps.
   * Empty: the split is undone.
   */
  shares: Array<{ ledger: string; amountMinor: number }>
}

export interface SplitResult {
  /** The payment, as it is with the split. */
  transaction: Transaction
  /** What the ledger that holds it keeps: its amount less the shares. */
  keptMinor: number
  /** Each other ledger's share, in the ledgers' order. */
  shares: TransactionSplitShare[]
}

const describe = (p: Pick<Payment, 'amount' | 'currency' | 'date' | 'accountName'>) =>
  `the ${formatMoney(p.amount, p.currency)} payment onto ${p.accountName} on ${p.date}`
const sum = (amounts: Iterable<number>) => [...amounts].reduce((s, n) => s + n, 0)
const ref = (l: Pick<AccountLedger, 'slug' | 'name'>) => ({ slug: l.slug, name: l.name })

/** A ledger's context: this one, or another through ctxOf. */
const contextOf = (ctx: AppContext, ctxOf: CtxOf, ledgerId: string) => (ledgerId === ctx.ledger.id ? ctx : ctxOf(ledgerId))

/** Asserts that a write by id changed one row: through the wrong ledger's context it changes none. */
function one(changes: { changes: number }, what: string, id: number) {
  if (changes.changes !== 1) throw new Error(`Expected the ${what} to change transaction ${id}, but it changed ${changes.changes}`)
}

/**
 * What a row of this ledger is in a split: a payment that's split, the given row beside it, or a
 * share of another ledger's payment (with that ledger). Null for any other row, and one that isn't here.
 */
export function splitPartOf(ctx: AppContext, id: number): SplitPart | null {
  const r = ctx.q.get<{ splitOf: number | null; isPayment: number; holds: number }>(
    `SELECT t.split_of AS splitOf,
       EXISTS (SELECT 1 FROM transactions g WHERE g.ledger_id = t.ledger_id AND g.split_of = t.id) AS isPayment,
       EXISTS (SELECT 1 FROM transactions p WHERE p.ledger_id = t.ledger_id AND p.id = t.split_of) AS holds
     FROM transactions t WHERE t.ledger_id = @ledger AND t.id = ?`,
    id,
  )
  if (!r) return null
  if (r.isPayment) return { part: 'payment', paymentId: id }
  if (r.splitOf === null) return null
  if (r.holds) return { part: 'given', paymentId: r.splitOf }
  const holder = ctx.accountWide.splitShares([r.splitOf])[0]!.holder
  return { part: 'share', paymentId: r.splitOf, holder: ref(holder) }
}

/**
 * What a row of this ledger that's part of a split waits for, in words: "Undo the split of the
 * $100.00 payment onto Visa on 2026-09-20 first", naming the payment, and the ledger that holds it
 * when that's another. For what can't take a split payment or a split row (a move, a switch's
 * delete). Null for a row that isn't part of a split.
 */
export function undoSplitFirst(ctx: AppContext, id: number): string | null {
  const part = splitPartOf(ctx, id)
  if (!part) return null
  if (part.part !== 'share') return `Undo the split of ${describe(heldPayment(ctx, part.paymentId))} first.`
  // The share has the payment's date and account: the payment is another ledger's.
  const share = ctx.q.get<Pick<Payment, 'date' | 'currency' | 'accountName'>>(
    `SELECT t.date, t.currency, a.name AS accountName FROM transactions t JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.id = ?`,
    id,
  )!
  const amount = ctx.accountWide.splitShares([part.paymentId])[0]!.paymentMinor
  return `Undo the split of ${describe({ ...share, amount })} in ${part.holder.name} first.`
}

/** Refuses (409) a change to a split row, saying where its split is changed. */
export function refuseSplitRow(ctx: AppContext, part: Exclude<SplitPart, { part: 'payment' }>): never {
  const message =
    part.part === 'share'
      ? `It’s ${ctx.ledger.name}’s share of a payment in ${part.holder.name}. Change the split there.`
      : 'It’s what this ledger gave the others of a split payment. Change the split on the payment.'
  throw new HTTPException(409, { message })
}

/** What a split payment of this ledger gives the other ledgers: its given row's amount, as a positive number. */
function givenOf(ctx: AppContext, paymentId: number): { minor: number; currency: string } {
  const r = ctx.q.get<{ minor: number; currency: string }>(
    'SELECT -amount_minor AS minor, currency FROM transactions WHERE ledger_id = @ledger AND split_of = ?',
    paymentId,
  )
  return r ?? { minor: 0, currency: 'CAD' }
}

/** An edit of a row, as checkSplitEdit sees it: what changes. */
export interface SplitEdit {
  /** The new amount, when it changes. */
  amountMinor?: number
  /** Its date or time of day changes. */
  date?: boolean
  account?: boolean
  payee?: boolean
  status?: boolean
  recurringItem?: boolean
  /** The new category, when it changes (null for none). */
  categoryId?: number | null
}

/**
 * Refuses (409) an edit a split doesn't allow. A split row keeps its amount, date, account, payee,
 * status and no recurring item: those come from the split. Its notes, tags and name are its own,
 * and so is its category, as long as it's one left out of totals. A split payment keeps its date,
 * status and payee, which its split rows have too, and its account, and its amount doesn't go below
 * its shares ("Lower the split first"). Anything else of it may change, "not a transfer" too.
 */
export function checkSplitEdit(ctx: AppContext, part: SplitPart, edit: SplitEdit): void {
  if (part.part === 'payment') {
    const refuse = (what: string): never => {
      throw new HTTPException(409, { message: `It’s split between ledgers. Undo the split to change its ${what}.` })
    }
    if (edit.date) refuse('date')
    if (edit.account) refuse('account')
    if (edit.status) refuse('status')
    if (edit.payee) refuse('payee')
    if (edit.amountMinor !== undefined) {
      const given = givenOf(ctx, part.paymentId)
      if (edit.amountMinor < given.minor) {
        throw new HTTPException(409, { message: `Its shares come to ${formatMoney(given.minor, given.currency)}. Lower the split first.` })
      }
    }
    return
  }
  const offTotals =
    edit.categoryId === undefined ||
    (edit.categoryId !== null && !!ctx.q.pluck('SELECT exclude_from_totals FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', edit.categoryId))
  if (edit.amountMinor !== undefined || edit.date || edit.account || edit.payee || edit.status || edit.recurringItem || !offTotals) refuseSplitRow(ctx, part)
}

/** How many split rows of this ledger are in these categories. */
function splitRowsIn(ctx: AppContext, categoryIds: readonly number[]): number {
  return ctx.q.pluck<number>(
    'SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND split_of IS NOT NULL AND category_id IN (SELECT value FROM json_each(?))',
    JSON.stringify(categoryIds),
  )!
}

/** The 409 for a category change that would leave split rows counted in totals, naming the category they use. */
function splitRowsUse(name: string): never {
  throw new HTTPException(409, { message: `Split payments use ${name}. Undo those splits first.` })
}

/**
 * Refuses (409) making a category count in totals while split rows of this ledger use it: they'd be
 * counted as income and spending. "Split payments use Credit card payment. Undo those splits first."
 */
export function refuseCountingSplitRows(ctx: AppContext, category: { id: number; name: string }): void {
  if (splitRowsIn(ctx, [category.id])) splitRowsUse(category.name)
}

/**
 * Before categories go away in this ledger (`going`: deleted, turned off, or merged away), or their
 * transactions go to another one (`into`: that category, or null for none), the split rows in them
 * are kept in a category left out of totals, the only thing that keeps a share from counting as
 * income and a given row as spending. When `into` is one left out of totals, they go there with the
 * rest, and nothing is done here. Otherwise they go to the ledger's other category for card
 * payments (as transferCategoryId: "Credit card payment", else its first one left out of totals
 * that's on), none of those going. When it has none, a 409 naming the category they use. Run it in
 * the caller's transaction, before the change. Returns how many split rows it filed elsewhere.
 */
export function refileSplitRows(ctx: AppContext, going: readonly number[], into: number | null): number {
  if (!going.length || !splitRowsIn(ctx, going)) return 0
  const list = JSON.stringify(going)
  if (into !== null && ctx.q.pluck('SELECT exclude_from_totals FROM ledger_categories WHERE ledger_id = @ledger AND id = ?', into)) return 0
  const to = ctx.q.pluck<number>(
    `SELECT id FROM ledger_categories
     WHERE ledger_id = @ledger AND exclude_from_totals = 1 AND archived_at IS NULL AND id NOT IN (SELECT value FROM json_each(?)) AND id IS NOT ?
     ORDER BY name = 'Credit card payment' DESC, id LIMIT 1`,
    list,
    into,
  )
  if (to === undefined) {
    const used = ctx.q.pluck<string>(
      `SELECT c.name FROM transactions t JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
       WHERE t.ledger_id = @ledger AND t.split_of IS NOT NULL AND t.category_id IN (SELECT value FROM json_each(?)) ORDER BY t.id LIMIT 1`,
      list,
    )
    splitRowsUse(used ?? 'a category that’s going')
  }
  return ctx.q.run(
    `UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, needs_review = 0, updated_at = ${NOW}
     WHERE ledger_id = @ledger AND split_of IS NOT NULL AND category_id IN (SELECT value FROM json_each(?))`,
    to,
    list,
  ).changes
}

/** Refuses (409) deleting a split payment ("Undo the split first") or a split row of this ledger. */
export function refuseSplitDelete(ctx: AppContext, id: number): void {
  const part = splitPartOf(ctx, id)
  if (!part) return
  if (part.part === 'payment') throw new HTTPException(409, { message: UNDO_FIRST })
  refuseSplitRow(ctx, part)
}

/** Refuses (409) linking a split payment or a split row of this ledger to anything, as a refund or payback. */
export function refuseSplitLink(ctx: AppContext, id: number): void {
  refuseSplitDelete(ctx, id)
}

/**
 * The split of each row that's part of one, by row id, as the Transaction DTO shows it: a payment's
 * shares and what it keeps, the given row's shares, and the ledger a share is from. Rows that aren't
 * part of a split have no entry.
 */
export function splitsFor(ctx: AppContext, rows: Array<{ id: number; amount: number; splitOf: number | null; isPayment: boolean }>): Map<number, TransactionSplit> {
  const out = new Map<number, TransactionSplit>()
  const paymentIds = [...new Set(rows.flatMap((r) => (r.isPayment ? [r.id] : r.splitOf !== null ? [r.splitOf] : [])))]
  if (!paymentIds.length) return out
  const byPayment = new Map<number, SplitShare[]>()
  for (const s of ctx.accountWide.splitShares(paymentIds)) byPayment.set(s.paymentId, [...(byPayment.get(s.paymentId) ?? []), s])
  const sharesOf = (list: SplitShare[]) => list.filter((s) => s.ledgerId !== s.holder.ledgerId).map((s) => ({ ledger: ref(s), amountMinor: s.amountMinor }))
  for (const r of rows) {
    if (r.isPayment) {
      const list = byPayment.get(r.id) ?? []
      const given = list.find((s) => s.ledgerId === s.holder.ledgerId)?.amountMinor ?? 0
      out.set(r.id, { part: 'payment', keptMinor: r.amount + given, shares: sharesOf(list) })
    } else if (r.splitOf !== null) {
      const list = byPayment.get(r.splitOf) ?? []
      const holder = list[0]?.holder
      if (!holder) continue
      out.set(r.id, holder.ledgerId === ctx.ledger.id ? { part: 'given', shares: sharesOf(list) } : { part: 'share', from: ref(holder) })
    }
  }
  return out
}

/**
 * The payment, if it can be split: money onto a shared account, held here, not deleted and not a
 * split row itself, linked to nothing (a refund or a payback isn't a payment), and a transfer or in a
 * category left out of totals. Pending is fine. Otherwise 400 "Only a card payment can be split". An id
 * another ledger holds and one that doesn't exist get the same 400.
 *
 * A payment that's split already only has to be held here, live and on an account that's still
 * shared: what it is may have changed since (its category to one that counts, "not a transfer", its
 * withdrawal unpaired by matching or a move), and its split must still be changed, lowered or undone.
 */
export function assertSplittable(ctx: AppContext, id: number): SplittableRow {
  const p = ctx.q.get<SplittableRow>(
    `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.amount_minor AS amount, t.date, t.datetime, t.status, t.payee, t.currency,
       t.category_id AS categoryId, coalesce(c.exclude_from_totals, 0) AS excluded, t.split_of AS splitOf, t.deleted_at AS deletedAt,
       t.transfer_pair_id AS pairId,
       (EXISTS (SELECT 1 FROM transaction_links l WHERE l.money_in_id = t.id) OR EXISTS (SELECT 1 FROM transaction_links l WHERE l.money_out_id = t.id)) AS linked,
       EXISTS (SELECT 1 FROM transactions g WHERE g.ledger_id = t.ledger_id AND g.split_of = t.id) AS isSplit
     FROM transactions t JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
       LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.id = ?`,
    id,
  )
  if (!p) badRequest(`There’s no transaction ${id} in ${ctx.ledger.name} to split.`)
  const payment = p.isSplit ? !p.deletedAt : p.amount > 0 && !p.deletedAt && p.splitOf === null && !p.linked && (p.pairId !== null || !!p.excluded)
  if (!payment || !ctx.accountWide.isShared(p.accountId)) badRequest('Only a card payment can be split.')
  return p
}

/** A split payment this ledger holds. Throws when it isn't here, or isn't split. */
function heldPayment(ctx: AppContext, paymentId: number): Payment {
  const p = ctx.q.get<Payment>(
    `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.amount_minor AS amount, t.date, t.datetime, t.status, t.payee, t.currency
     FROM transactions t JOIN ledger_accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
     WHERE t.ledger_id = @ledger AND t.id = ?`,
    paymentId,
  )
  if (!p) throw new Error(`${ctx.ledger.name} holds no transaction ${paymentId}`)
  return p
}

/** The split rows of a payment sum to zero, or nothing of what was just done stays (a throw rolls it back). */
function assertSumsToZero(ctx: AppContext, payment: Payment): void {
  const total = sum(ctx.accountWide.splitRows(payment.accountId, payment.id).map((r) => r.amountMinor))
  if (total !== 0) throw new Error(`The split rows of transaction ${payment.id} sum to ${total}, not zero`)
}

/** A caller limited to some ledgers must be allowed in each one a split writes in: 403 otherwise. */
function requireUsable(ledgers: AccountLedger[], involved: Iterable<string>, usable: UsableLedgers): void {
  if (!usable) return
  for (const id of new Set(involved)) {
    if (usable.includes(id)) continue
    const name = ledgers.find((l) => l.ledgerId === id)?.name ?? 'another ledger'
    throw new HTTPException(403, { message: `This key can’t use ${name}, so it can’t change how this payment is split.` })
  }
}

/** A new split row of the payment in `at`'s ledger: a share (the payment's payee) or the given row (GIVEN_PAYEE). */
function insertSplitRow(at: AppContext, payment: Payment, row: { amountMinor: number; payee: string; categoryId: number }): number {
  return Number(
    at.q.run(
      `INSERT INTO transactions (ledger_id, account_id, date, datetime, amount_minor, currency, payee, payee_key, category_id, category_source,
         needs_review, status, origin, split_of)
       VALUES (@ledger, @accountId, @date, @datetime, @amountMinor, @currency, @payee, @payeeKey, @categoryId, 'user', 0, @status, 'manual', @splitOf)`,
      {
        accountId: payment.accountId,
        date: payment.date,
        datetime: payment.datetime,
        amountMinor: row.amountMinor,
        currency: payment.currency,
        payee: row.payee,
        payeeKey: payeeKeyOf(at, row.payee),
        categoryId: row.categoryId,
        status: payment.status,
        splitOf: payment.id,
      },
    ).lastInsertRowid,
  )
}

function deleteSplitRow(at: AppContext, payment: Payment, id: number): void {
  one(at.q.run('DELETE FROM transactions WHERE ledger_id = @ledger AND id = ? AND split_of = ?', id, payment.id), 'delete of a split row', id)
}

function setSplitAmount(at: AppContext, payment: Payment, id: number, amountMinor: number): void {
  one(
    at.q.run(`UPDATE transactions SET amount_minor = ?, updated_at = ${NOW} WHERE ledger_id = @ledger AND id = ? AND split_of = ?`, amountMinor, id, payment.id),
    'amount of a split row',
    id,
  )
}

/**
 * The shares a save asks for, by ledger id, worked out from the form's amounts (SplitInput): the
 * home's is the rest when another ledger holds the payment, and the holder's own amount is what it
 * keeps. Empty when nothing is given (the split is undone). Checks each amount (whole cents above
 * zero, each ledger once, one that has the account and isn't the home) and that together they're no
 * more than the payment. An archived ledger's share stays as it is: it can't be added, changed, or
 * dropped by a save that leaves it out.
 */
function wantedShares(ctx: AppContext, payment: Payment, ledgers: AccountLedger[], had: ReadonlyMap<string, SplitRowHeld>, input: SplitInput): Map<string, number> {
  const money = (minor: number) => formatMoney(minor, payment.currency)
  const listed = new Map<string, number>()
  for (const s of input.shares) {
    const l = ledgers.find((x) => x.slug === s.ledger)
    if (!l) badRequest(`There’s no ledger “${s.ledger}” that has ${payment.accountName}.`)
    if (l.isHome) badRequest(`${l.name} is ${payment.accountName}’s home, so it keeps the rest. Leave it out.`)
    if (listed.has(l.ledgerId)) badRequest(`Give ${l.name} one amount.`)
    if (!Number.isInteger(s.amountMinor) || s.amountMinor <= 0) badRequest(`Give ${l.name} an amount in whole cents, above zero.`)
    listed.set(l.ledgerId, s.amountMinor)
  }
  const total = sum(listed.values())
  if (total > payment.amount) badRequest(`The shares come to ${money(total)}, more than ${money(payment.amount)} paid.`)
  if (!listed.size) return listed

  const wanted = new Map(listed)
  wanted.delete(ctx.ledger.id)
  const home = ledgers.find((l) => l.isHome)!
  if (home.ledgerId !== ctx.ledger.id && payment.amount > total) wanted.set(home.ledgerId, payment.amount - total)
  for (const l of ledgers) {
    if (!l.archived || l.ledgerId === ctx.ledger.id) continue
    const before = had.get(l.ledgerId)?.amountMinor
    const after = wanted.get(l.ledgerId)
    if (before === after) continue
    if (before === undefined) badRequest(`${l.name} is archived, so it can’t be given a share.`)
    badRequest(`${l.name} is archived, so its share stays at ${money(before)}.`)
  }
  return wanted
}

/**
 * Splits a payment this ledger holds between the ledgers that share its account, or changes or
 * undoes its split (an empty list), in one transaction. `shares` is the form's: see SplitInput and
 * the module's comment for how the home's and the holder's amounts follow from it. The payment must
 * be one that can be split, or be split already (assertSplittable). A caller limited to some ledgers (`usable`, the
 * switch's value) must be allowed in this one and in every ledger that has a share, before or after.
 *
 * Through each ledger's own context: share rows no longer wanted are deleted, the others updated or
 * added (the payment's account, date, payee, currency and status, origin manual, category yours: the
 * ledger's category for card payments), and the given row added or updated (the holder's card
 * payment category, or the payment's own when that one is left out of totals). Every ledger that
 * gets a new row needs such a category, the holder included: 400 "Family has no category for card
 * payments" otherwise, since an uncategorized split row would count as spending or income. Nothing
 * learns from them, and no recurring item takes them. The payment is marked reviewed. Activity in
 * each ledger whose rows changed, and the split rows must sum to zero, or it all rolls back. A dry
 * run works it all out and changes nothing.
 */
export function setSplit(
  ctx: AppContext,
  ctxOf: CtxOf,
  id: number,
  input: SplitInput,
  opts: { dryRun?: boolean; actor: ActivityActor; usable: UsableLedgers },
): SplitResult {
  let result!: SplitResult
  const run = () => {
    const payment = assertSplittable(ctx, id)
    const ledgers = ctx.accountWide.ledgers(payment.accountId)
    const rows = ctx.accountWide.splitRows(payment.accountId, id)
    const given = rows.find((r) => r.ledgerId === ctx.ledger.id)
    const had = new Map(rows.filter((r) => r.ledgerId !== ctx.ledger.id).map((r) => [r.ledgerId, r]))
    const wanted = wantedShares(ctx, payment, ledgers, had, input)
    requireUsable(ledgers, [ctx.ledger.id, ...had.keys(), ...wanted.keys()], opts.usable)
    const name = (ledgerId: string) => ledgers.find((l) => l.ledgerId === ledgerId)!.name
    const money = (minor: number) => formatMoney(minor, payment.currency)

    if (!wanted.size) {
      if (rows.length) removeSplit(ctx, ctxOf, payment, rows, opts.actor)
    } else {
      // Every new row's category, before anything is written.
      const cardPayment = (ledgerId: string) => {
        const categoryId = transferCategoryId(contextOf(ctx, ctxOf, ledgerId), 'credit')
        if (categoryId === null) badRequest(`${name(ledgerId)} has no category for card payments.`)
        return categoryId
      }
      const categories = new Map([...wanted.keys()].filter((l) => !had.has(l)).map((l) => [l, cardPayment(l)]))
      const givenCategory = given ? null : payment.excluded && payment.categoryId !== null ? payment.categoryId : cardPayment(ctx.ledger.id)

      const changed: Array<{ ledgerId: string; before: number | null; after: number | null }> = []
      for (const [ledgerId, r] of had) {
        if (wanted.has(ledgerId)) continue
        deleteSplitRow(ctxOf(ledgerId), payment, r.id)
        changed.push({ ledgerId, before: r.amountMinor, after: null })
      }
      for (const [ledgerId, amountMinor] of wanted) {
        const at = ctxOf(ledgerId)
        const r = had.get(ledgerId)
        if (r && r.amountMinor === amountMinor) continue
        if (r) setSplitAmount(at, payment, r.id, amountMinor)
        else insertSplitRow(at, payment, { amountMinor, payee: payment.payee, categoryId: categories.get(ledgerId)! })
        changed.push({ ledgerId, before: r?.amountMinor ?? null, after: amountMinor })
      }
      const givenMinor = -sum(wanted.values())
      if (!given) insertSplitRow(ctx, payment, { amountMinor: givenMinor, payee: GIVEN_PAYEE, categoryId: givenCategory! })
      else if (given.amountMinor !== givenMinor) setSplitAmount(ctx, payment, given.id, givenMinor)
      ctx.q.run('UPDATE transactions SET needs_review = 0 WHERE ledger_id = @ledger AND id = ? AND needs_review = 1', payment.id)

      if (changed.length) {
        const list = ledgers.filter((l) => wanted.has(l.ledgerId)).map((l) => `${l.name} ${money(wanted.get(l.ledgerId)!)}`)
        recordActivity(ctx, opts.actor, {
          action: 'split',
          entity: 'transaction',
          entityId: payment.id,
          summary: `Split ${describe(payment)}: ${list.join(', ')}, and ${ctx.ledger.name} keeps ${money(payment.amount + givenMinor)}`,
          before: { shares: Object.fromEntries([...had].map(([l, r]) => [ledgers.find((x) => x.ledgerId === l)!.slug, r.amountMinor])) },
          after: { shares: Object.fromEntries([...wanted].map(([l, amount]) => [ledgers.find((x) => x.ledgerId === l)!.slug, amount])) },
        })
        for (const c of changed) {
          const summary =
            c.after === null
              ? `${ctx.ledger.name} took back this ledger’s share of ${money(c.before!)} of ${describe(payment)}`
              : c.before === null
                ? `${ctx.ledger.name} gave this ledger a share of ${money(c.after)} of ${describe(payment)}`
                : `${ctx.ledger.name} changed this ledger’s share of ${describe(payment)} from ${money(c.before)} to ${money(c.after)}`
          recordActivity(ctxOf(c.ledgerId), opts.actor, { action: 'split', entity: 'transaction', summary, after: { from: ctx.ledger.slug, amountMinor: c.after } })
        }
      }
      assertSumsToZero(ctx, payment)
    }

    const shares = ledgers.filter((l) => wanted.has(l.ledgerId)).map((l) => ({ ledger: ref(l), amountMinor: wanted.get(l.ledgerId)! }))
    result = { transaction: getTransaction(ctx, id), keptMinor: payment.amount - sum(wanted.values()), shares }
    if (opts.dryRun) throw ROLL_BACK
  }

  try {
    ctx.q.transaction(run)
  } catch (err) {
    if (err !== ROLL_BACK) throw err
  }
  return result
}

/** Deletes every split row of the payment, each through its holder's context, with activity in each ledger. */
function removeSplit(ctx: AppContext, ctxOf: CtxOf, payment: Payment, rows: SplitRowHeld[], actor: ActivityActor): void {
  const money = (minor: number) => formatMoney(minor, payment.currency)
  for (const r of rows) deleteSplitRow(contextOf(ctx, ctxOf, r.ledgerId), payment, r.id)
  recordActivity(ctx, actor, { action: 'split', entity: 'transaction', entityId: payment.id, summary: `Undid the split of ${describe(payment)}`, after: { shares: {} } })
  for (const r of rows) {
    if (r.ledgerId === ctx.ledger.id) continue
    recordActivity(ctxOf(r.ledgerId), actor, {
      action: 'split',
      entity: 'transaction',
      summary: `${ctx.ledger.name} undid the split of ${describe(payment)}, and this ledger’s share of ${money(r.amountMinor)} with it`,
      after: { from: ctx.ledger.slug, amountMinor: null },
    })
  }
}

/**
 * Undoes the split of a payment this ledger holds: every split row is deleted, in each ledger
 * through its own context, so each share goes back to the holder. For Undo split, and for when the
 * bank removes the payment (the split goes before the payment is deleted). Activity in each ledger.
 * Returns how many split rows went (none for a payment that isn't split).
 */
export function undoSplit(ctx: AppContext, ctxOf: CtxOf, paymentId: number, actor: ActivityActor): { removed: number } {
  return ctx.q.transaction(() => {
    const payment = heldPayment(ctx, paymentId)
    const rows = ctx.accountWide.splitRows(payment.accountId, paymentId)
    if (rows.length) removeSplit(ctx, ctxOf, payment, rows, actor)
    return { removed: rows.length }
  })
}

/** The payment's split rows, its given row (this ledger's) and the share of `ledgerId`, which must be another ledger's. */
function shareOf(ctx: AppContext, payment: Payment, ledgerId: string) {
  const rows = ctx.accountWide.splitRows(payment.accountId, payment.id)
  const share = ledgerId === ctx.ledger.id ? undefined : rows.find((r) => r.ledgerId === ledgerId)
  const given = rows.find((r) => r.ledgerId === ctx.ledger.id)
  if (!share || !given) throw new Error(`Ledger ${ledgerId} has no share of transaction ${payment.id}`)
  return { rows, share, given, last: rows.length === 2 }
}

/**
 * Takes one ledger's share of a payment this ledger holds back: its share row is deleted, in its
 * ledger, and the given row is lowered by it. When it was the last share, the given row goes too and
 * the payment is no longer split. For when that ledger's rows are being deleted, or are going to
 * this ledger: its balance on the account drops by the share, and this ledger's rises by it.
 * Activity in both. Returns the share's amount and whether it was the last.
 */
export function dropShare(ctx: AppContext, ctxOf: CtxOf, paymentId: number, ledgerId: string, actor: ActivityActor): { amountMinor: number; last: boolean } {
  return ctx.q.transaction(() => {
    const payment = heldPayment(ctx, paymentId)
    const { share, given, last } = shareOf(ctx, payment, ledgerId)
    const at = ctxOf(ledgerId)
    deleteSplitRow(at, payment, share.id)
    if (last) deleteSplitRow(ctx, payment, given.id)
    else setSplitAmount(ctx, payment, given.id, given.amountMinor + share.amountMinor)
    const money = formatMoney(share.amountMinor, payment.currency)
    recordActivity(ctx, actor, {
      action: 'split',
      entity: 'transaction',
      entityId: payment.id,
      summary: `Took back ${at.ledger.name}’s share of ${money} of ${describe(payment)}`,
      after: { dropped: at.ledger.slug },
    })
    recordActivity(at, actor, {
      action: 'split',
      entity: 'transaction',
      summary: `${ctx.ledger.name} took back this ledger’s share of ${money} of ${describe(payment)}`,
      after: { from: ctx.ledger.slug, amountMinor: null },
    })
    assertSumsToZero(ctx, payment)
    return { amountMinor: share.amountMinor, last }
  })
}

/**
 * Lets one ledger's share of a payment this ledger holds go, changing no balance: its share row
 * becomes an ordinary row of that ledger (split_of cleared), and the given row is lowered by it,
 * with an ordinary row of the same amount beside it in this ledger, copied from the given row (its
 * date, time and status, its payee GIVEN_PAYEE and its category, made by hand, the category yours).
 * When it was the last share, the given row itself becomes that ordinary row. For when that ledger
 * leaves the account and keeps or moves its rows. Activity in both. Returns the share's amount, the
 * ordinary row left in this ledger, and whether it was the last.
 */
export function detachShare(
  ctx: AppContext,
  ctxOf: CtxOf,
  paymentId: number,
  ledgerId: string,
  actor: ActivityActor,
): { amountMinor: number; plainId: number; last: boolean } {
  return ctx.q.transaction(() => {
    const payment = heldPayment(ctx, paymentId)
    const { share, given, last } = shareOf(ctx, payment, ledgerId)
    const at = ctxOf(ledgerId)
    detachRow(at, payment, share.id)
    let plainId = given.id
    if (last) detachRow(ctx, payment, given.id)
    else {
      setSplitAmount(ctx, payment, given.id, given.amountMinor + share.amountMinor)
      plainId = Number(
        ctx.q.run(
          `INSERT INTO transactions (ledger_id, account_id, date, datetime, amount_minor, currency, payee, payee_key, category_id, category_source,
             needs_review, status, origin)
           SELECT @ledger, g.account_id, g.date, g.datetime, @amountMinor, g.currency, g.payee, g.payee_key, g.category_id, 'user', 0, g.status, 'manual'
           FROM transactions g WHERE g.ledger_id = @ledger AND g.id = @given`,
          { amountMinor: -share.amountMinor, given: given.id },
        ).lastInsertRowid,
      )
    }
    const money = formatMoney(share.amountMinor, payment.currency)
    recordActivity(ctx, actor, {
      action: 'split',
      entity: 'transaction',
      entityId: payment.id,
      summary: `${at.ledger.name}’s share of ${money} of ${describe(payment)} is its own transaction now`,
      after: { detached: at.ledger.slug, transactionId: plainId },
    })
    recordActivity(at, actor, {
      action: 'split',
      entity: 'transaction',
      entityId: share.id,
      summary: `This ledger’s share of ${money} of ${describe(payment)} in ${ctx.ledger.name} is its own transaction now`,
      after: { from: ctx.ledger.slug },
    })
    assertSumsToZero(ctx, payment)
    return { amountMinor: share.amountMinor, plainId, last }
  })
}

function detachRow(at: AppContext, payment: Payment, id: number): void {
  one(at.q.run(`UPDATE transactions SET split_of = NULL, updated_at = ${NOW} WHERE ledger_id = @ledger AND id = ? AND split_of = ?`, id, payment.id), 'detach of a split row', id)
}

/**
 * Lets the whole split of a payment this ledger holds go, changing no balance: every split row
 * becomes an ordinary row where it is (split_of cleared), each through its holder's context. For
 * when this ledger leaves the account, or is deleted or erased. A detached row is ordinary from then
 * on: it can be edited, moved or deleted, and no longer follows the payment. Activity in each ledger.
 * Returns how many rows were let go.
 */
export function detachSplit(ctx: AppContext, ctxOf: CtxOf, paymentId: number, actor: ActivityActor): { detached: number } {
  return ctx.q.transaction(() => {
    const payment = heldPayment(ctx, paymentId)
    const rows = ctx.accountWide.splitRows(payment.accountId, paymentId)
    if (!rows.length) return { detached: 0 }
    for (const r of rows) detachRow(contextOf(ctx, ctxOf, r.ledgerId), payment, r.id)
    recordActivity(ctx, actor, {
      action: 'split',
      entity: 'transaction',
      entityId: payment.id,
      summary: `The split of ${describe(payment)} is ordinary transactions now`,
      after: { detached: rows.length },
    })
    for (const r of rows) {
      if (r.ledgerId === ctx.ledger.id) continue
      recordActivity(ctxOf(r.ledgerId), actor, {
        action: 'split',
        entity: 'transaction',
        entityId: r.id,
        summary: `This ledger’s share of ${formatMoney(r.amountMinor, payment.currency)} of ${describe(payment)} in ${ctx.ledger.name} is its own transaction now`,
        after: { from: ctx.ledger.slug },
      })
    }
    return { detached: rows.length }
  })
}

/**
 * Copies a split payment's date, time of day and status to its split rows, and its payee to the
 * shares, each through its holder's context: for when the bank changes the payment. Its amount isn't
 * copied: the shares are what was typed, so the holder takes a new amount. Returns how many rows changed.
 */
export function followPayment(ctx: AppContext, ctxOf: CtxOf, paymentId: number): number {
  return ctx.q.transaction(() => {
    const payment = heldPayment(ctx, paymentId)
    let changed = 0
    for (const r of ctx.accountWide.splitRows(payment.accountId, paymentId)) {
      const at = contextOf(ctx, ctxOf, r.ledgerId)
      const facts = { id: r.id, splitOf: payment.id, date: payment.date, datetime: payment.datetime, status: payment.status }
      const share = r.ledgerId !== ctx.ledger.id
      changed += share
        ? at.q.run(
            `UPDATE transactions SET date = @date, datetime = @datetime, status = @status, payee = @payee, payee_key = @payeeKey, updated_at = ${NOW}
             WHERE ledger_id = @ledger AND id = @id AND split_of = @splitOf
               AND (date IS NOT @date OR datetime IS NOT @datetime OR status IS NOT @status OR payee IS NOT @payee OR payee_key IS NOT @payeeKey)`,
            { ...facts, payee: payment.payee, payeeKey: payeeKeyOf(at, payment.payee) },
          ).changes
        : at.q.run(
            `UPDATE transactions SET date = @date, datetime = @datetime, status = @status, updated_at = ${NOW}
             WHERE ledger_id = @ledger AND id = @id AND split_of = @splitOf AND (date IS NOT @date OR datetime IS NOT @datetime OR status IS NOT @status)`,
            facts,
          ).changes
    }
    return changed
  })
}

/**
 * The ledgers that hold a split row of a payment this ledger holds, by id: its own and each with a
 * share. For a sync or a switch, which settles each ledger a split row changed in.
 */
export function splitLedgers(ctx: AppContext, paymentId: number): string[] {
  const payment = heldPayment(ctx, paymentId)
  return ctx.accountWide.splitRows(payment.accountId, paymentId).map((r) => r.ledgerId)
}

/** What a ledger leaving an account did to one split it took part in (leaveSplits). */
export interface LeftSplit {
  /**
   * `detachedSplit`: a payment it holds, whose split rows are ordinary rows now, each where it is.
   * `droppedShare`: its share of another ledger's payment went back to that ledger. `detachedShare`:
   * its share is an ordinary row of its own now, and so is what the payment's holder gave for it.
   */
  done: 'detachedSplit' | 'droppedShare' | 'detachedShare'
  /** The ledger that holds the payment. */
  holder: { slug: string; name: string }
  date: ISODate
  /** The payment's amount. */
  paymentMinor: number
  /** The leaving ledger's share, or what it gave the others of a payment it holds, as a positive number. */
  amountMinor: number
  currency: string
}

/**
 * The splits a ledger takes part in on an account, let go of before it leaves the account: stopping
 * sharing it, and (for the questions asked before a ledger goes) deleting or erasing the ledger. A
 * split payment it holds has its split detached (detachSplit). Its share of another ledger's payment
 * is dropped or detached in the ledger that holds the payment, as `shares` says for that ledger (by
 * id): dropped when this ledger's rows are deleted or go to the payment's holder, detached when they
 * stay or go elsewhere. Run it in the caller's transaction, before the rows go. Returns what it did,
 * split by split, in the order of this ledger's split rows.
 */
export function leaveSplits(
  ctx: AppContext,
  ctxOf: CtxOf,
  accountId: number,
  opts: { shares: (holderLedgerId: string) => 'drop' | 'detach'; actor: ActivityActor },
): { detachedSplits: number; droppedShares: number; detachedShares: number; splits: LeftSplit[] } {
  return ctx.q.transaction(() => {
    const mine = ctx.q.all<{ paymentId: number; amountMinor: number; given: number }>(
      `SELECT t.split_of AS paymentId, t.amount_minor AS amountMinor,
         EXISTS (SELECT 1 FROM transactions p WHERE p.ledger_id = t.ledger_id AND p.id = t.split_of) AS given
       FROM transactions t WHERE t.ledger_id = @ledger AND t.account_id = ? AND t.split_of IS NOT NULL ORDER BY t.id`,
      accountId,
    )
    const done = { detachedSplits: 0, droppedShares: 0, detachedShares: 0, splits: [] as LeftSplit[] }
    const left = (at: AppContext, payment: Payment, what: LeftSplit['done'], amountMinor: number): LeftSplit => ({
      done: what,
      holder: ref(at.ledger),
      date: payment.date,
      paymentMinor: payment.amount,
      amountMinor,
      currency: payment.currency,
    })
    for (const m of mine) {
      if (m.given) {
        const payment = heldPayment(ctx, m.paymentId)
        detachSplit(ctx, ctxOf, m.paymentId, opts.actor)
        done.detachedSplits++
        done.splits.push(left(ctx, payment, 'detachedSplit', -m.amountMinor))
        continue
      }
      const holder = ctxOf(ctx.accountWide.splitShares([m.paymentId])[0]!.holder.ledgerId)
      const payment = heldPayment(holder, m.paymentId)
      if (opts.shares(holder.ledger.id) === 'drop') {
        dropShare(holder, ctxOf, m.paymentId, ctx.ledger.id, opts.actor)
        done.droppedShares++
        done.splits.push(left(holder, payment, 'droppedShare', m.amountMinor))
      } else {
        detachShare(holder, ctxOf, m.paymentId, ctx.ledger.id, opts.actor)
        done.detachedShares++
        done.splits.push(left(holder, payment, 'detachedShare', m.amountMinor))
      }
    }
    return done
  })
}

/**
 * The splits a ledger takes part in, on every account, let go of before the ledger itself goes
 * (deleted or erased): leaveSplits for each account it has split rows on. Its shares of other
 * ledgers' payments are dropped, since its rows are going (or detached, where `shares` says so for
 * an account and the payment's holder), and a payment it holds has its split detached, so the other
 * ledgers keep their shares as ordinary rows and no balance of theirs changes. The questions asked
 * before a ledger goes do the same account by account (leaveSplits, in questions.ts), in their
 * transaction before the ledger's rows go. Archiving keeps a ledger's rows, so its splits can stay:
 * an archived ledger's share stays at its amount. Returns what it did, by account id.
 */
export function leaveLedgerSplits(
  ctx: AppContext,
  ctxOf: CtxOf,
  opts: { actor: ActivityActor; shares?: (accountId: number, holderLedgerId: string) => 'drop' | 'detach' },
): Map<number, LeftSplit[]> {
  return ctx.q.transaction(() => {
    const out = new Map<number, LeftSplit[]>()
    const accountIds = ctx.q.column<number>('SELECT DISTINCT account_id FROM transactions WHERE ledger_id = @ledger AND split_of IS NOT NULL ORDER BY account_id')
    for (const accountId of accountIds) {
      const shares = (holder: string) => opts.shares?.(accountId, holder) ?? 'drop'
      out.set(accountId, leaveSplits(ctx, ctxOf, accountId, { shares, actor: opts.actor }).splits)
    }
    return out
  })
}
