/**
 * Every place that runs with every ledger in scope (`allLedgers` in scope.ts): its SQL isn't pin
 * checked, and its writes may touch any ledger's rows. Each is here with why it needs to be, so
 * the list is the whole of what to review. A test keeps it equal to the calls in the source.
 */
export const UNSCOPED_SITES = {
  'ledger counts': {
    file: 'src/storage.ts',
    why: "The ledger list shows each ledger's accounts and transactions, counted for all of them in one grouped query.",
  },
  'seed the shared category list': {
    file: 'src/storage.ts',
    why: 'The shared list belongs to no ledger (ledger_id is null), so its rows are written with every ledger in scope.',
  },
  'bank links': {
    file: 'src/services/bank/service.ts',
    why: 'A bank connection is app-wide and its accounts can feed accounts in different ledgers: each link shows the ledger its account is in.',
  },
  'full backup': {
    file: 'src/storage.ts',
    why: 'The full backup is the whole database, every ledger included.',
  },
} as const satisfies Record<string, { file: string; why: string }>

export type UnscopedReason = keyof typeof UNSCOPED_SITES
