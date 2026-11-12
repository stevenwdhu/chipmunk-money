import type { Account, MoveResult, Transaction, TransactionSplitShare } from '@chipmunk/shared'
import { money } from './format'

type LedgerRef = { slug: string; name: string }
type Split = NonNullable<Transaction['split']>

/** Names in a sentence: "Family", "Family and Trip", "Family, Trip and Cottage". */
export const listOf = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The note for a ledger that changes a shared account's transactions without carrying its opening
 * and recorded balances: the ledger that does takes up the difference. "Visa is a shared account, so
 * Personal’s balance on it may change." Null when none of the accounts is one of those.
 */
export function sharedNote(accounts: Array<Account | undefined>, ledger: string): string | null {
  const byOpening = new Map<string, string[]>()
  for (const a of accounts) {
    if (!a?.sharing || a.sharing.opening.slug === ledger) continue
    const names = byOpening.get(a.sharing.opening.name) ?? []
    if (!names.includes(a.name)) names.push(a.name)
    byOpening.set(a.sharing.opening.name, names)
  }
  const notes = [...byOpening].map(([opening, names]) =>
    names.length === 1
      ? `${names[0]} is a shared account, so ${opening}’s balance on it may change.`
      : `${listOf(names)} are shared accounts, so ${opening}’s balance on them may change.`,
  )
  return notes.length ? notes.join(' ') : null
}

/** The ledgers every one of these accounts is shared with, or none when one of them isn't shared. */
export function commonLedgers(accounts: Array<Account | undefined>): LedgerRef[] {
  const [first, ...rest] = accounts
  if (!first?.sharing) return []
  return first.sharing.ledgers.filter((l) => rest.every((a) => a?.sharing?.ledgers.some((x) => x.slug === l.slug)))
}

/** Whether a move lets go of anything: said before it's confirmed. */
export const dropsAnything = (r: MoveResult) => r.dropped.links.length + r.dropped.partlyLinked.length + r.dropped.pairs.length + r.dropped.recurring.length > 0

/** What a move lets go of, a sentence each, from its dry run. `ledgerName`: a ledger's name by its slug. */
export function moveDrops(r: MoveResult, from: string, ledgerName: (slug: string) => string): string[] {
  const { links, partlyLinked, pairs, recurring } = r.dropped
  const items = [...new Set(recurring.map((x) => x.item))]
  return [
    links.length && `${count(links.length, 'refund or payback link')} ${links.length === 1 ? 'is' : 'are'} let go, because the other side stays behind.`,
    ...partlyLinked.map((p) => `${money(p.leftMinor)} of ${p.payee} is no longer paid back, and counts as income in ${ledgerName(p.ledger)}.`),
    pairs.length && `${count(pairs.length, 'transfer')} ${pairs.length === 1 ? 'is' : 'are'} no longer paired with ${pairs.length === 1 ? 'its' : 'their'} other side, which stays in ${from}.`,
    recurring.length && `${count(recurring.length, 'payment')} ${recurring.length === 1 ? 'comes' : 'come'} off ${listOf(items)}, which ${items.length === 1 ? 'stays' : 'stay'} in ${from}.`,
  ].filter((s): s is string => !!s)
}

/** After a move: what was let go of, and what the ledger they went to matched them with. */
export function moveSummary(r: MoveResult, to: string): string | undefined {
  const dropped = [
    r.unlinked && `${count(r.unlinked, 'link')} let go`,
    r.unpaired && `${count(r.unpaired, 'transfer')} no longer paired`,
    r.recurringDetached && `${r.recurringDetached} taken off a recurring item`,
  ].filter(Boolean)
  const matched = [
    r.matched.transfers && count(r.matched.transfers, 'transfer'),
    r.matched.refunds && count(r.matched.refunds, 'refund'),
    r.matched.payments && count(r.matched.payments, 'recurring payment'),
  ].filter(Boolean)
  const said = [dropped.length && `${dropped.join(', ')}.`, matched.length && `Matched in ${to}: ${matched.join(', ')}.`].filter(Boolean)
  return said.length ? said.join(' ') : undefined
}

/** The ledgers a split gives shares to, and what they get together: "Shares for Family" and 8000. */
export function sharesFor(shares: TransactionSplitShare[]) {
  return { text: `Shares for ${listOf(shares.map((s) => s.ledger.name))}`, minor: shares.reduce((n, s) => n + s.amountMinor, 0) }
}

/** Shown on a split payment whose amount the bank lowered below what was given away. */
export const SHARES_OVER = 'The shares are more than the payment now'

/**
 * Why a row that's part of a split can't be changed here, in the words the server refuses it with.
 * `ledger`: this ledger's name.
 */
export function splitLock(split: Split, ledger: string): string {
  if (split.part === 'share') return `It’s ${ledger}’s share of a payment in ${split.from.name}. Change the split there.`
  if (split.part === 'given') return 'It’s what this ledger gave the others of a split payment. Change the split on the payment.'
  return 'It’s split between ledgers. Undo the split to change its date, account or payee, or to delete it.'
}

/** What a split row shows as in a list, in place of its payee: whose payment it's a share of, or who its shares are for. */
export function splitTitle(tx: Pick<Transaction, 'split'>): string | null {
  if (tx.split?.part === 'share') return `Share of a ${tx.split.from.name} payment`
  if (tx.split?.part === 'given') return sharesFor(tx.split.shares).text
  return null
}

/**
 * The given rows of a list that sit under their payment there, by the payment's id. A given row has
 * its payment's account and date, and the same shares. One whose payment isn't listed (a filter left
 * it out) has no entry, and shows as a row of its own.
 */
export function givenUnder<T extends Pick<Transaction, 'id' | 'accountId' | 'date' | 'split'>>(items: T[]): Map<number, T> {
  const key = (t: T, shares: TransactionSplitShare[]) => JSON.stringify([t.accountId, t.date, shares.map((s) => [s.ledger.slug, s.amountMinor])])
  const given = new Map<string, T[]>()
  for (const t of items) {
    if (t.split?.part !== 'given') continue
    const k = key(t, t.split.shares)
    given.set(k, [...(given.get(k) ?? []), t])
  }
  const out = new Map<number, T>()
  if (!given.size) return out
  for (const t of items) {
    if (t.split?.part !== 'payment') continue
    const row = given.get(key(t, t.split.shares))?.shift()
    if (row) out.set(t.id, row)
  }
  return out
}
