import { z } from 'zod'
import {
  formatMoney,
  type Account,
  type Category,
  type CategoryGroup,
  type CategoryList,
  type Institution,
  type Label,
  type Ledger,
  type Settings,
  type TagWithCount,
  type Transaction,
} from '@chipmunk/shared'
import type { ApiClient, Me } from './api'

/** A problem the agent can fix (unknown name, missing argument). Shown to it as the tool's error. */
export class ToolError extends Error {}

/** Dollars (as an agent writes them) to cents. Rounds via a string so 1234.565 becomes 123457. */
export const toMinor = (amount: number) => Math.round(Number((amount * 100).toFixed(4)))
export const money = (minor: number, currency = 'CAD') => formatMoney(minor, currency)

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Finds a record by id or by name: exact name first (any case), then a unique partial match.
 * Throws a ToolError listing the choices otherwise, so the agent can correct itself.
 */
function pick<T extends { id: number; name: string }>(list: T[], ref: string | number, what: string): T {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const found = list.find((x) => x.id === Number(ref))
    if (found) return found
    if (typeof ref === 'number') throw new ToolError(`There's no ${what} with id ${ref}.`)
  }
  const key = norm(String(ref))
  const exact = list.filter((x) => norm(x.name) === key)
  if (exact.length === 1) return exact[0]!
  const partial = list.filter((x) => norm(x.name).includes(key))
  if (partial.length === 1) return partial[0]!
  const names = list.map((x) => `“${x.name}”`).join(', ')
  const many = what.endsWith('y') ? `${what.slice(0, -1)}ies` : `${what}s`
  if (partial.length > 1) throw new ToolError(`“${ref}” matches several ${many}: ${partial.map((x) => `“${x.name}”`).join(', ')}. Use the full name or the id.`)
  throw new ToolError(`There's no ${what} called “${ref}”. Choose one of: ${names || '(none yet)'}.`)
}

/** Accounts, categories and tags of one ledger, for turning names into ids and back. */
export class Lookups {
  constructor(
    readonly accounts: Account[],
    readonly categories: Category[],
    readonly groups: CategoryGroup[],
    readonly labels: Label[] = [],
    /** The ledger uses the shared category list (changed app-wide) rather than its own. */
    readonly shared = false,
  ) {}

  /** Where this ledger's categories are changed: the shared list, or the ledger's own. */
  categoryBase(ledger: { slug: string }) {
    return this.shared ? '' : `/ledgers/${ledger.slug}`
  }

  accountName(id: number) {
    return this.accounts.find((a) => a.id === id)?.name ?? `account ${id}`
  }
  categoryName(id: number | null) {
    return id === null ? null : (this.categories.find((c) => c.id === id)?.name ?? `category ${id}`)
  }
  groupName(id: number | null) {
    return id === null ? null : (this.groups.find((g) => g.id === id)?.name ?? null)
  }
  account(ref: string | number): Account {
    return pick(
      this.accounts.filter((a) => !a.archived || typeof ref === 'number'),
      ref,
      'account',
    )
  }
  /** A category id from a name or id; null (or "none") clears the category. */
  category(ref: string | number | null): number | null {
    if (ref === null || (typeof ref === 'string' && ['none', 'uncategorized', ''].includes(norm(ref)))) return null
    return pick(
      this.categories.filter((c) => !c.archived || typeof ref === 'number'),
      ref,
      'category',
    ).id
  }
  group(ref: string | number): CategoryGroup {
    return pick(this.groups, ref, 'category group')
  }
  label(ref: string | number): Label {
    return pick(this.labels, ref, 'label')
  }
  labelNames(ids: number[]) {
    return ids.map((id) => this.labels.find((l) => l.id === id)?.name ?? `label ${id}`)
  }
}

/** Everything one tool call needs: the API, who's calling, and memoised lookups. */
export class ToolContext {
  private ledgerList?: Promise<Ledger[]>
  private lookupCache = new Map<string, Promise<Lookups>>()
  private settings?: Promise<Settings>

  constructor(
    readonly api: ApiClient,
    readonly me: Me,
  ) {}

  ledgers(): Promise<Ledger[]> {
    return (this.ledgerList ??= this.api.get<Ledger[]>('/ledgers'))
  }

  /** The ledger named in a tool argument (slug, name or id), or the caller's default one. */
  async ledger(ref?: string): Promise<Ledger> {
    const all = (await this.ledgers()).filter((l) => !l.archived || ref)
    if (!ref) {
      const found = all.find((l) => l.slug === this.me.defaultLedger) ?? all[0]
      if (!found) throw new ToolError('There are no ledgers this key can use.')
      return found
    }
    const key = norm(ref)
    const found = all.find((l) => l.slug === key || l.id === ref.trim() || norm(l.name) === key)
    if (!found) {
      throw new ToolError(`There's no ledger called “${ref}”. Ledgers: ${all.map((l) => `${l.name} (${l.slug})`).join(', ')}.`)
    }
    return found
  }

  /** `/ledgers/<slug>` + path. */
  async path(ledgerRef: string | undefined, path: string): Promise<{ ledger: Ledger; url: string }> {
    const ledger = await this.ledger(ledgerRef)
    return { ledger, url: `/ledgers/${ledger.slug}${path}` }
  }

  lookups(ledger: Ledger): Promise<Lookups> {
    let p = this.lookupCache.get(ledger.slug)
    if (!p) {
      p = Promise.all([
        this.api.get<Account[]>(`/ledgers/${ledger.slug}/accounts`),
        this.api.get<CategoryList>(`/ledgers/${ledger.slug}/categories`),
      ]).then(([accounts, cats]) => new Lookups(accounts, cats.categories, cats.groups, cats.labels, cats.shared ?? false))
      this.lookupCache.set(ledger.slug, p)
    }
    return p
  }

  /** An institution by name or id. */
  async institution(ledger: Ledger, ref: string | number): Promise<Institution> {
    return pick(await this.api.get<Institution[]>(`/ledgers/${ledger.slug}/institutions`), ref, 'institution')
  }

  async tagId(ledger: Ledger, name: string): Promise<number> {
    const tags = await this.api.get<TagWithCount[]>(`/ledgers/${ledger.slug}/tags`)
    const key = norm(name).replace(/^#/, '')
    const tag = tags.find((t) => t.name === key)
    if (!tag) throw new ToolError(`There's no tag “${name}”. Tags: ${tags.map((t) => `#${t.name}`).join(', ') || '(none yet)'}.`)
    return tag.id
  }

  /** Today in the app's time zone. */
  async today(): Promise<string> {
    return (await (this.settings ??= this.api.get<Settings>('/settings'))).today
  }
}

// Views: what tools return. Names next to ids, amounts in cents and formatted. -------------

export const transactionView = z.object({
  id: z.number(),
  date: z.string(),
  time: z.string().nullable().describe('Its time of day (HH:MM, local), when known.'),
  payee: z.string(),
  name: z.string().nullable().describe('What it is, like “Suitcase”: its recurring item’s name for a payment of one.'),
  amountMinor: z.number().describe('Cents; negative is money out.'),
  amount: z.string().describe('Formatted, e.g. "-$84.32".'),
  account: z.string(),
  accountId: z.number(),
  category: z.string().nullable(),
  categoryId: z.number().nullable(),
  needsReview: z.boolean().describe('The category is a suggestion waiting to be accepted or changed.'),
  suggestedBy: z.enum(['history', 'ai']).nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  pending: z.boolean(),
  isTransfer: z.boolean(),
  links: z
    .array(z.object({ kind: z.enum(['refund', 'payback']), transactionId: z.number(), amount: z.string() }))
    .describe(
      'Refunds (from the merchant) and paybacks (someone’s share of a bill you paid). For money in: the purchases or bills it pays back, and how much of it goes to each. Linked in full to one, it has that one’s category. For money out: what paid it back.',
    ),
  externalId: z.string().nullable(),
})
export type TransactionView = z.output<typeof transactionView>

export function viewTransaction(t: Transaction, lk: Lookups): TransactionView {
  return {
    id: t.id,
    date: t.date,
    time: t.datetime?.slice(11, 16) ?? null,
    payee: t.payee,
    name: t.name,
    amountMinor: t.amountMinor,
    amount: money(t.amountMinor, t.currency),
    account: lk.accountName(t.accountId),
    accountId: t.accountId,
    category: lk.categoryName(t.categoryId),
    categoryId: t.categoryId,
    needsReview: t.needsReview,
    suggestedBy: t.needsReview && (t.categorySource === 'ai' || t.categorySource === 'history') ? t.categorySource : null,
    notes: t.notes,
    tags: t.tags.map((x) => x.name),
    pending: t.status === 'pending',
    isTransfer: t.transferPairId !== null,
    links: t.links.map((l) => ({ kind: l.kind, transactionId: l.transactionId, amount: money(l.amountMinor, t.currency) })),
    externalId: t.externalId,
  }
}

/** One line per transaction for the text part of a result. */
export function transactionLine(t: TransactionView): string {
  const cat = t.category ? `${t.category}${t.needsReview ? ` (suggested${t.suggestedBy ? ` from ${t.suggestedBy}` : ''})` : ''}` : 'uncategorized'
  const extra = [
    ...t.links.map((l) => `${l.kind} ${l.amount} ${t.amountMinor > 0 ? 'for' : 'from'} #${l.transactionId}`),
    t.tags.length ? t.tags.map((x) => `#${x}`).join(' ') : '',
    t.notes ? `“${t.notes}”` : '',
    t.pending ? 'pending' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return `#${t.id} ${t.date}${t.time ? ` ${t.time}` : ''} ${t.payee}${t.name ? ` (${t.name})` : ''} ${t.amount} · ${cat} · ${t.account}${extra ? ` · ${extra}` : ''}`
}

export const accountView = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  balanceMinor: z.number(),
  balance: z.string(),
  isLiability: z.boolean(),
  institution: z.string().describe('Where it’s held, e.g. a bank.'),
  archived: z.boolean(),
  transactionCount: z.number(),
})

export function viewAccount(a: Account): z.output<typeof accountView> {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    balanceMinor: a.balanceMinor,
    balance: money(a.balanceMinor, a.currency),
    isLiability: a.isLiability,
    institution: a.institution,
    archived: a.archived,
    transactionCount: a.transactionCount,
  }
}

export const categoryView = z.object({
  id: z.number(),
  name: z.string(),
  group: z.string().nullable(),
  isIncome: z.boolean(),
  excludeFromTotals: z.boolean().describe('Transfers and card payments: left out of spending totals.'),
  labels: z.array(z.string()).describe('Your labels on it, such as Need or Want.'),
  archived: z.boolean(),
})

export function viewCategory(c: Category, lk: Pick<Lookups, 'groupName' | 'labelNames'>): z.output<typeof categoryView> {
  return {
    id: c.id,
    name: c.name,
    group: lk.groupName(c.groupId),
    isIncome: c.isIncome,
    excludeFromTotals: c.excludeFromTotals,
    labels: lk.labelNames(c.labelIds),
    archived: c.archived,
  }
}

export const ledgerView = z.object({
  name: z.string(),
  slug: z.string().describe('Pass as `ledger` to other tools.'),
  isDefault: z.boolean().describe('Used when a tool is called without `ledger`.'),
  archived: z.boolean(),
  accounts: z.number(),
  transactions: z.number(),
})
