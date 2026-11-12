import { describe, expect, it } from 'vitest'
import { importCommitSchema, importPreviewSchema } from '@chipmunk/shared'
import { makeAccount } from '../test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, sharedWorld, TESTER, type SharedWorld } from '../test/shared-accounts'
import type { AppContext } from './context'
import { commitImport, previewImport } from './import'
import { cardPaymentCategory } from './matching'
import { moveTransactions } from './moves'
import { setSharing } from './sharing'
import { deleteTransaction } from './transactions'

/**
 * CSV import and matching on a shared account: Personal is Visa's home, where its CSV files are
 * imported, and Family has it. The rows Family holds got there by a real move.
 */

type CsvRow = { line: number; date: string; payee: string; amountMinor: number; externalId?: string }

const csv = (account: number, rows: CsvRow[]) => ({ accountId: account, rows })

function world(w: SharedWorld) {
  const preview = (rows: CsvRow[], account = w.visa) => previewImport(w.personal, importPreviewSchema.parse(csv(account, rows)))
  const commit = (rows: CsvRow[], account = w.visa) => commitImport(w.personal, importCommitSchema.parse(csv(account, rows)), { background: false })
  /** Visa's rows in every ledger, deleted ones too. */
  const rows = () =>
    [w.personal, w.family, w.trip].flatMap((c) =>
      c.q
        .all<{ id: number; payee: string; amount: number; externalId: string | null; deleted: number }>(
          `SELECT id, payee, amount_minor AS amount, external_id AS externalId, deleted_at IS NOT NULL AS deleted
           FROM transactions WHERE ledger_id = @ledger AND account_id = ? ORDER BY id`,
          w.visa,
        )
        .map((r) => ({ ledger: c.ledger.slug, ...r })),
    )
  const idOf = (payee: string) => rows().find((r) => r.payee === payee)!.id
  const move = (from: AppContext, payees: string[], to: AppContext) => moveTransactions(from, w.ctxOf, { ids: payees.map(idOf), to: to.ledger.id }, TESTER)
  const check = () => {
    expectPartsSumToAccount(w.storage, w.visa)
    expectNoCrossLedgerReferences(w.storage)
  }
  return { preview, commit, rows, idOf, move, check }
}

const statement: CsvRow[] = [
  { line: 2, date: '2026-09-27', payee: 'Corner Cafe', amountMinor: -1_200 },
  { line: 3, date: '2026-09-28', payee: 'Book Shop', amountMinor: -3_000, externalId: 'b1' },
  { line: 4, date: '2026-09-29', payee: 'Gas Bar', amountMinor: -4_500 },
  { line: 5, date: '2026-09-30', payee: 'Corner Store', amountMinor: -800, externalId: 'b2' },
]

describe('a CSV import on a shared account', () => {
  it('adds nothing for an overlapping file, and the preview names no row another ledger holds', () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    expect(w.commit(statement)).toMatchObject({ imported: 4, skippedDuplicates: 0 })
    w.move(w.personal, ['Book Shop', 'Gas Bar', 'Corner Store'], w.family)
    // Family deleted one it moved: a deleted one isn't imported again either.
    deleteTransaction(w.family, w.idOf('Corner Store'))
    w.check()

    // The same file again, a little later, with one new row.
    const again = [...statement.map((r, i) => (i === 2 ? { ...r, date: '2026-09-30' } : r)), { line: 6, date: '2026-10-01', payee: 'Bakery', amountMinor: -600 }]
    const shown = w.preview(again)
    expect(shown.map((r) => ({ payee: r.payee, duplicateOf: r.duplicateOf, duplicateElsewhere: r.duplicateElsewhere }))).toEqual([
      { payee: 'Corner Cafe', duplicateOf: w.idOf('Corner Cafe'), duplicateElsewhere: false },
      // By its bank id, and by its date, amount and payee: Family has them, so they aren't named.
      { payee: 'Book Shop', duplicateOf: null, duplicateElsewhere: true },
      { payee: 'Gas Bar', duplicateOf: null, duplicateElsewhere: true },
      { payee: 'Corner Store', duplicateOf: null, duplicateElsewhere: true },
      { payee: 'Bakery', duplicateOf: null, duplicateElsewhere: false },
    ])
    const familyIds = w.rows().filter((r) => r.ledger === 'family').map((r) => r.id)
    expect(familyIds).toHaveLength(3)
    for (const id of familyIds) expect(JSON.stringify(shown)).not.toContain(`"duplicateOf":${id}`)

    // The commit skips them, even when they're sent (a ticked duplicate).
    const before = w.rows()
    expect(w.commit(again)).toMatchObject({ imported: 1, skippedDuplicates: 4 })
    const after = w.rows()
    expect(after.filter((r) => before.every((b) => b.id !== r.id))).toMatchObject([{ ledger: 'personal', payee: 'Bakery' }])
    expect(after.filter((r) => before.some((b) => b.id === r.id))).toEqual(before)
    expect(w.commit(again)).toMatchObject({ imported: 0, skippedDuplicates: 5 })
    w.check()
  })

  it('imports into an account that isn’t shared as before', () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    const chequing = makeAccount(w.personal, 'Chequing', 'chequing')
    w.commit(statement, chequing)
    expect(w.preview(statement, chequing).map((r) => [r.duplicateOf !== null, r.duplicateElsewhere])).toEqual(statement.map(() => [true, false]))
  })
})

describe('matching on a shared account', () => {
  /** A transaction's category, pair and refund link, read in the ledger that holds it. */
  const filed = (ctx: AppContext, id: number) =>
    ctx.q.get<{ categoryId: number | null; source: string | null; pair: number | null; links: number }>(
      `SELECT category_id AS categoryId, category_source AS source, transfer_pair_id AS pair,
         (SELECT count(*) FROM transaction_links l WHERE l.money_in_id = t.id) AS links
       FROM transactions t WHERE t.ledger_id = @ledger AND t.id = ?`,
      id,
    )

  it('files no card payment for money back whose purchase another ledger holds, and pairs it with no withdrawal', () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    const chequing = makeAccount(w.personal, 'Chequing', 'chequing')
    w.commit([{ line: 2, date: '2026-09-10', payee: 'BEST BUY #123', amountMinor: -12_000 }])
    w.move(w.personal, ['BEST BUY #123'], w.family)

    // Money back from Best Buy, and an unrelated withdrawal of the same amount from chequing.
    w.commit([{ line: 2, date: '2026-09-20', payee: 'Unrelated Withdrawal', amountMinor: -12_000 }], chequing)
    w.commit([{ line: 2, date: '2026-09-21', payee: 'BEST BUY #456', amountMinor: 12_000 }])
    const refund = w.idOf('BEST BUY #456')
    const withdrawal = w.personal.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND payee = 'Unrelated Withdrawal'")!
    // An ordinary uncategorized credit in the home: no payment, no pair, and no link across ledgers.
    expect(filed(w.personal, refund)).toEqual({ categoryId: null, source: null, pair: null, links: 0 })
    expect(filed(w.personal, withdrawal)).toMatchObject({ pair: null })
    expect(w.rows().map((r) => [r.ledger, r.payee])).toEqual([
      ['personal', 'BEST BUY #456'],
      ['family', 'BEST BUY #123'],
    ])
    w.check()
  })

  it('files no card payment for money back whose purchase a ledger kept on an account of its own when it stopped sharing', () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    const chequing = makeAccount(w.personal, 'Chequing', 'chequing')
    w.commit([{ line: 2, date: '2026-09-10', payee: 'BEST BUY #123', amountMinor: -12_000 }])
    w.move(w.personal, ['BEST BUY #123'], w.family)
    // Family stops sharing Visa and keeps the purchase: Visa is shared with no one now.
    setSharing(w.personal, w.ctxOf, w.visa, { ledgers: ['personal'], rows: { family: 'keep' } }, { actor: TESTER, usable: null })
    expect(w.personal.accountWide.isShared(w.visa)).toBe(false)

    w.commit([{ line: 2, date: '2026-09-20', payee: 'Unrelated Withdrawal', amountMinor: -12_000 }], chequing)
    w.commit([{ line: 2, date: '2026-09-21', payee: 'BEST BUY #456', amountMinor: 12_000 }])
    const refund = w.idOf('BEST BUY #456')
    const withdrawal = w.personal.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND payee = 'Unrelated Withdrawal'")!
    expect(filed(w.personal, refund)).toEqual({ categoryId: null, source: null, pair: null, links: 0 })
    expect(filed(w.personal, withdrawal)).toMatchObject({ categoryId: null, pair: null })
    w.check()
  })

  it('still files card payments as payments when no ledger has a purchase from that payee', () => {
    const w0 = sharedWorld()
    const w = { ...w0, ...world(w0) }
    const chequing = makeAccount(w.personal, 'Chequing', 'chequing')
    w.commit([{ line: 2, date: '2026-09-10', payee: 'BEST BUY #123', amountMinor: -12_000 }])
    w.move(w.personal, ['BEST BUY #123'], w.family)

    w.commit([{ line: 2, date: '2026-09-20', payee: 'TD VISA PREAUTH', amountMinor: -5_000 }], chequing)
    w.commit([
      { line: 2, date: '2026-09-21', payee: 'PAYMENT - THANK YOU', amountMinor: 5_000 },
      { line: 3, date: '2026-09-25', payee: 'PAYMENT RECEIVED', amountMinor: 2_500 },
    ])
    const withdrawal = w.personal.q.pluck<number>("SELECT id FROM transactions WHERE ledger_id = @ledger AND payee = 'TD VISA PREAUTH'")!
    const payment = cardPaymentCategory(w.personal)
    // Paired with the withdrawal that paid it, and one without a withdrawal (yet) in the payment category.
    expect(filed(w.personal, w.idOf('PAYMENT - THANK YOU'))).toMatchObject({ categoryId: payment, source: payment ? 'rule' : null, pair: withdrawal })
    expect(filed(w.personal, withdrawal)).toMatchObject({ pair: w.idOf('PAYMENT - THANK YOU') })
    expect(filed(w.personal, w.idOf('PAYMENT RECEIVED'))).toMatchObject({ categoryId: payment, pair: null })
    expect(payment).not.toBeNull()
    w.check()
  })
})
