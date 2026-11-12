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
  'the shared category list': {
    file: 'src/services/catalog.ts',
    why: "The shared list's rows belong to no ledger (ledger_id is null): App settings edits, reading it, and a ledger joining it (which can add to it). Deleting or merging a shared category also clears it from every ledger's transactions in the same transaction.",
  },
  'bank links': {
    file: 'src/services/bank/service.ts',
    why: "A bank connection is app-wide and its accounts can feed accounts in different ledgers: each link shows its account's home ledger, which a shared account syncs into (the ledgers it's shared with don't count as where it is).",
  },
  'one account in every ledger': {
    file: 'src/services/account-rows.ts',
    why: "A shared account is held by its home and the ledgers it's shared with, so its parts, its total, its own facts and the ledgers that have it are read by account, across those ledgers. One private wrapper makes the call for every read of the module. Sums, counts and names leave it, and the rows a bank sync matches against, with the ledger that holds each, leave it for the bank code only, never for a response.",
  },
  'full backup': {
    file: 'src/storage.ts',
    why: 'The full backup is the whole database, every ledger included.',
  },
} as const satisfies Record<string, { file: string; why: string }>

export type UnscopedReason = keyof typeof UNSCOPED_SITES
