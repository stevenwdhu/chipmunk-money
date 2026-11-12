/**
 * A fake SimpleFIN Bridge with one card, "visa", for tests that run a real sync (BankService) without
 * a bank: hand `fakeBridge(card)` to the storage as its fetch, connect with TOKEN, and change
 * `card` between syncs.
 */

export interface FakeTx {
  id: string
  posted: number
  transacted_at: number
  amount: string
  description: string
  payee: string
  pending?: boolean
}

export interface FakeCard {
  balance: string
  transactions: FakeTx[]
}

const at = (date: string) => Math.floor(Date.parse(`${date}T16:00:00Z`) / 1000)

/** A transaction as the bridge sends it. */
export const fakeTx = (id: string, date: string, amount: string, payee: string, opts: { pending?: boolean } = {}): FakeTx => ({
  id,
  posted: opts.pending ? 0 : at(date),
  transacted_at: at(date),
  amount,
  description: payee.toUpperCase(),
  payee,
  ...(opts.pending ? { pending: true } : {}),
})

/** The setup token the fake bridge takes. */
export const TOKEN = Buffer.from('https://bridge.test/simplefin/claim/TOKEN1').toString('base64')

export function fakeBridge(card: FakeCard, balanceDate = '2026-10-03') {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (/\/simplefin\/claim\/\w+$/.test(url.pathname) && init?.method === 'POST') return new Response('https://user%40x:s3cret@bridge.test/simplefin')
    if (url.pathname !== '/simplefin/accounts') return new Response('not found', { status: 404 })
    const start = Number(url.searchParams.get('start-date') ?? 0)
    const end = Number(url.searchParams.get('end-date') ?? Infinity)
    return Response.json({
      errlist: [],
      connections: [{ conn_id: 'CON-1', name: 'TD - Me', org_name: 'TD Canada Trust', org_id: 'td' }],
      accounts: [
        {
          id: 'visa',
          name: 'Visa',
          conn_id: 'CON-1',
          currency: 'CAD',
          balance: card.balance,
          'balance-date': at(balanceDate),
          transactions: url.searchParams.get('balances-only') === '1' ? undefined : card.transactions.filter((t) => t.transacted_at >= start && t.transacted_at < end),
        },
      ],
    })
  }) as typeof globalThis.fetch
}
