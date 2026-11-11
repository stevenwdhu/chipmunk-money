import { formatMoney, type Transaction } from '@chipmunk/shared'
import { titleOf } from '@/lib/payee'

/**
 * How a transaction's refunds and paybacks show in a list: a label beside its payee (what the money
 * in is, or what happened to the purchase or bill), and under a purchase or bill's amount, what it
 * comes to once they're taken off.
 */
export function linkBadge(tx: Transaction): { text: string; title: string; targetId: number } | null {
  if (tx.transferPairId || !tx.links.length) return null
  const paybacks = tx.links.filter((l) => l.kind === 'payback')
  const refunds = tx.links.filter((l) => l.kind === 'refund')
  // Clicking it goes to the first of what it's labelled for.
  const open = (list: typeof tx.links, one: string, first: string) => ({ targetId: list[0]!.transactionId, opens: ` Click to go to ${list.length === 1 ? one : first}.` })
  if (tx.amountMinor > 0) {
    if (paybacks.length) {
      const { targetId, opens } = open(paybacks, 'the bill', 'the first bill')
      return { text: 'Payback', title: `Someone paying you back for bills you paid. It counts in their categories, in their months.${opens}`, targetId }
    }
    const { targetId, opens } = open(refunds, 'the purchase', 'the first purchase')
    return { text: 'Refund', title: `Money back for an earlier purchase. It always has that purchase’s category.${opens}`, targetId }
  }
  const net = netAmount(tx)
  if (net === null) return null
  if (paybacks.length) {
    const { targetId, opens } = open(paybacks, 'the payback', 'the first payback')
    return { text: 'Paid back', title: `Others paid you back for it. Your share is ${formatMoney(Math.max(-net, 0), tx.currency)}.${opens}`, targetId }
  }
  const { targetId, opens } = open(refunds, 'the refund', 'the first refund')
  const counts = formatMoney(net, tx.currency, { signed: true })
  const what = net < 0 ? `Some of it came back, so it counts as ${counts}.` : net > 0 ? `More came back than it cost, so it counts as ${counts}.` : 'It all came back, so it counts for nothing.'
  return { text: 'Refunded', title: `${what}${opens}`, targetId }
}

/**
 * For a purchase or bill with refunds or paybacks: what it comes to once they're taken off (your
 * share, when others paid you back), as reports count it, signed like its amount. Null when it has neither.
 */
export function netAmount(tx: Transaction): number | null {
  if (tx.amountMinor >= 0 || tx.transferPairId || !tx.links.length) return null
  // More than it cost can come back (a refund at another currency rate): then it's above zero.
  return tx.amountMinor + tx.links.reduce((n, l) => n + l.amountMinor, 0)
}

/** Who it's from or to, as people say it: its name, or its payee without an e-Transfer's bank wording. */
export const shortPayee = (t: Transaction) => titleOf(t).replace(/\s*-\s*INTERAC e-Transfer®?\s*$/i, '')

/** "Alex", "Alex and Sam", or "Alex and 2 others". */
export function namesOf(list: Transaction[]) {
  const names = [...new Set(list.map(shortPayee))]
  return names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`
}

/** Money in linked in full to several bills: how many (it has their categories, not one of its own). */
export const billCount = (tx: Transaction) => (tx.amountMinor > 0 && tx.categorySource === 'linked' && tx.links.length > 1 ? tx.links.length : undefined)
