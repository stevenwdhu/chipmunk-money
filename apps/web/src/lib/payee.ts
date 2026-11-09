import type { Transaction } from '@st/shared'

type Named = Pick<Transaction, 'payee' | 'payeeName' | 'payeeNameRule' | 'name'>

/** Its payee as it's called: by your payee name rules, by AI tidying (“Walmart”), or as sent. */
export const payeeOf = (tx: Pick<Transaction, 'payeeName'>) => tx.payeeName

/** What a transaction shows as: its own name, or what its payee is called. */
export const titleOf = (tx: Named) => tx.name ?? payeeOf(tx)

/**
 * Its payee as the bank or file sent it, said small under it when you named it otherwise: its own
 * name, or a payee name rule of yours. (AI tidying alone isn't said.)
 */
export const sentPayeeUnder = (tx: Named) => ((tx.name || tx.payeeNameRule !== null) && titleOf(tx) !== tx.payee ? tx.payee : null)
