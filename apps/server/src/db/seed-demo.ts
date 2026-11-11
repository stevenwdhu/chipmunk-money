/**
 * ~13 months of realistic sample data (CAD) for development and demos. Loaded from the welcome
 * screen, or from the command line with `pnpm seed:demo` (seed-demo-cli.ts).
 */
import { addDays, addMonthsToDate, monthOf, recurringCreateSchema, transactionCreateSchema, type TransactionCreate } from '@st/shared'
import { createAccount, setBalance } from '../services/accounts'
import { historySuggestion } from '../services/categorize'
import type { AppContext } from '../services/context'
import { createCustomReport } from '../services/custom-reports'
import { addPayment, confirmRecurring, createRecurring, detectRecurring, listRecurring } from '../services/recurring'
import { today } from '../services/settings'
import { insertTransaction } from '../services/transactions'

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedDemo(ctx: AppContext, opts: { force?: boolean } = {}) {
  // Anything of yours stops it: the demo replaces accounts, reports, tags and recurring items too.
  const existing = ctx.sqlite
    .prepare(
      `SELECT (SELECT count(*) FROM transactions) + (SELECT count(*) FROM accounts) + (SELECT count(*) FROM recurring_items)
         + (SELECT count(*) FROM custom_reports) + (SELECT count(*) FROM tags) AS n`,
    )
    .get() as { n: number }
  if (existing.n && !opts.force) {
    throw new Error('This ledger already has data. Re-run with --force to replace it with demo data (a copy is saved in backups/ first).')
  }
  ctx.sqlite.exec(`
    DELETE FROM transaction_tags; DELETE FROM transactions; DELETE FROM recurring_items; DELETE FROM import_batches;
    DELETE FROM balance_snapshots; DELETE FROM accounts; DELETE FROM payee_category_stats; DELETE FROM tags;
    DELETE FROM ai_calls; DELETE FROM custom_reports; DELETE FROM sqlite_sequence WHERE name = 'custom_reports';
  `)

  const rand = rng(20260930)
  const between = (min: number, max: number) => Math.round((min + rand() * (max - min)) * 100)
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
  const cat = (name: string) =>
    (ctx.sqlite.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined)?.id ?? null

  const end = today(ctx)
  const start = `${monthOf(addMonthsToDate(end, -12))}-01`

  const td = createAccount(ctx, { name: 'TD Chequing', type: 'chequing', currency: 'CAD', openingBalanceMinor: 420_000, openingDate: start, institution: 'TD' })
  const amex = createAccount(ctx, { name: 'Amex Cobalt', type: 'credit', currency: 'CAD', openingBalanceMinor: -64_000, openingDate: start, institution: 'American Express' })
  const tfsa = createAccount(ctx, { name: 'Wealthsimple TFSA', type: 'investment', currency: 'CAD', openingBalanceMinor: 2_150_000, openingDate: start, institution: 'Wealthsimple' })
  const cash = createAccount(ctx, { name: 'Cash', type: 'cash', currency: 'CAD', openingBalanceMinor: 12_000, openingDate: start, institution: 'Wallet' })

  let count = 0
  const add = (input: Omit<TransactionCreate, 'status'> & { categoryName?: string | null }) => {
    if (input.date > end) return null
    const { categoryName, ...rest } = input
    const parsed = transactionCreateSchema.parse({
      ...rest,
      categoryId: categoryName === undefined ? rest.categoryId : categoryName ? cat(categoryName) : null,
    })
    count++
    return insertTransaction(ctx, parsed, { suggestion: null, skipRecurring: true })
  }

  const days: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)
  const dayOfMonth = (d: string) => Number(d.slice(8, 10))
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay()

  let cardSpendThisMonth = 0
  let cardSpendLastMonth = 0
  const card = (input: Parameters<typeof add>[0]) => {
    add({ ...input, accountId: amex.id })
    if (input.date <= end) cardSpendThisMonth += -input.amountMinor
  }

  const tripStart = addMonthsToDate(`${monthOf(end)}-10`, -4)
  let firstPayday = start
  while (weekday(firstPayday) !== 5) firstPayday = addDays(firstPayday, 1)

  for (const d of days) {
    const dom = dayOfMonth(d)
    if (dom === 1 && d !== start) {
      cardSpendLastMonth = cardSpendThisMonth
      cardSpendThisMonth = 0
    }

    // Income: biweekly payroll on Fridays
    if (weekday(d) === 5 && ((Date.parse(d) - Date.parse(firstPayday)) / 86_400_000) % 14 === 0) {
      add({ accountId: td.id, date: d, amountMinor: 265_000, payee: 'ACME CORP PAYROLL', categoryName: 'Salary' })
    }
    // Fixed bills
    if (dom === 1) add({ accountId: td.id, date: d, amountMinor: -185_000, payee: 'Rent - Maple Property Mgmt', categoryName: 'Rent' })
    if (dom === 2) {
      add({ accountId: td.id, date: d, amountMinor: -50_000, payee: 'Wealthsimple contribution', transferAccountId: tfsa.id })
    }
    if (dom === 10) add({ accountId: td.id, date: d, amountMinor: -10_000, payee: 'ATM WITHDRAWAL', transferAccountId: cash.id })
    if (dom === 8) add({ accountId: td.id, date: d, amountMinor: -7_500, payee: 'ROGERS *INTERNET', categoryName: 'Internet' })
    if (dom === 12) add({ accountId: td.id, date: d, amountMinor: -6_500, payee: 'FIDO MOBILE', categoryName: 'Phones' })
    if (dom === 15) add({ accountId: td.id, date: d, amountMinor: -between(58, 112), payee: 'TORONTO HYDRO', categoryName: 'Electricity & heating' })
    if (dom === 4) card({ accountId: amex.id, date: d, amountMinor: -1_199, payee: 'SPOTIFY P2A3B4C5D6', categoryName: 'Software & media' })
    if (dom === 28) card({ accountId: amex.id, date: d, amountMinor: -2_099, payee: 'NETFLIX.COM 866-579-7172', categoryName: 'Software & media' })
    if (dom === 18) card({ accountId: amex.id, date: d, amountMinor: -5_999, payee: 'GOODLIFE FITNESS', categoryName: 'Sports & fitness' })
    if (dom === 21 && cardSpendLastMonth > 0) {
      add({ accountId: td.id, date: d, amountMinor: -cardSpendLastMonth, payee: 'AMEX PAYMENT', transferAccountId: amex.id })
    }

    // Groceries: roughly every 5 days, one bigger Costco run a month
    if (rand() < 0.2) {
      card({ accountId: amex.id, date: d, amountMinor: -between(38, 165), payee: pick(['LOBLAWS #1032 TORONTO ON', 'NO FRILLS #3117', 'METRO #412', 'FARM BOY #23']), categoryName: 'Groceries' })
    }
    if (dom === 6) card({ accountId: amex.id, date: d, amountMinor: -between(140, 260), payee: 'COSTCO WHOLESALE #535', categoryName: 'Groceries' })
    // Dining
    if (rand() < 0.3) {
      card({ accountId: amex.id, date: d, amountMinor: -between(16, 78), payee: pick(['UBER *EATS PENDING', 'PIZZERIA LIBRETTO', 'PAI NORTHERN THAI', 'CHIPOTLE 2841', 'SQ *SEOUL SHAKE']), categoryName: 'Dine out' })
    }
    // Coffee and treats, sometimes with cash: each place's usual order most days, now and then something else
    if (weekday(d) >= 1 && weekday(d) <= 5 && rand() < 0.45) {
      const [payee, usual, others] = pick([
        ['TIM HORTONS #2814', 249, [429, 519]],
        ['STARBUCKS 04527', 625, [545, 715]],
        ['BALZACS COFFEE', 475, [595]],
      ] as const)
      const amountMinor = -(rand() < 0.75 ? usual : pick([...others]))
      if (rand() < 0.25) add({ accountId: cash.id, date: d, amountMinor, payee, categoryName: 'Drinks & treats' })
      else card({ accountId: amex.id, date: d, amountMinor, payee, categoryName: 'Drinks & treats' })
    }
    // Transit and rides
    if (weekday(d) === 1 && rand() < 0.5) add({ accountId: td.id, date: d, amountMinor: -5_000, payee: 'PRESTO FARE/5WJK2B TORONTO ON', categoryName: 'Transit' })
    if (rand() < 0.06) card({ accountId: amex.id, date: d, amountMinor: -between(12, 38), payee: 'UBER* TRIP', categoryName: 'Taxi' })
    // Shopping, health, fun
    if (rand() < 0.09) card({ accountId: amex.id, date: d, amountMinor: -between(15, 120), payee: 'AMZN Mktp CA*2K4L19R03', categoryName: 'General shopping' })
    if (rand() < 0.03) card({ accountId: amex.id, date: d, amountMinor: -between(20, 140), payee: pick(['CANADIAN TIRE #142', 'WINNERS #219', 'IKEA NORTH YORK']), categoryName: pick(['General shopping', 'Household supplies']) })
    if (rand() < 0.04) card({ accountId: amex.id, date: d, amountMinor: -between(9, 58), payee: 'SHOPPERS DRUG MART #0821', categoryName: 'Pharmacy' })
    if (rand() < 0.03) card({ accountId: amex.id, date: d, amountMinor: -between(15, 48), payee: pick(['CINEPLEX 7134', 'TICKETMASTER CA']), categoryName: 'Entertainment' })
    if (rand() < 0.015) card({ accountId: amex.id, date: d, amountMinor: -between(25, 90), payee: 'INDIGO BOOKS #876', categoryName: 'Gifts' })
    if (dom === 25 && rand() < 0.3) card({ accountId: amex.id, date: d, amountMinor: 2_150, payee: 'AMEX COBALT CASHBACK', categoryName: 'Other income' })

    // A tagged trip
    if (d === tripStart) {
      const tags = ['trip-japan']
      card({ accountId: amex.id, date: d, amountMinor: -145_000, payee: 'AIR CANADA 0142', categoryName: 'Travel', tags })
      card({ accountId: amex.id, date: addDays(d, 9), amountMinor: -98_000, payee: 'HOTEL GRACERY SHINJUKU', categoryName: 'Travel', tags })
      card({ accountId: amex.id, date: addDays(d, 10), amountMinor: -18_500, payee: 'JR EAST JAPAN RAIL PASS', categoryName: 'Travel', tags })
      card({ accountId: amex.id, date: addDays(d, 11), amountMinor: -9_250, payee: 'ICHIRAN SHIBUYA', categoryName: 'Dine out', tags })
    }
  }

  // Two instalment plans: a vacuum on Pay in 4 (half paid), and a laptop paid monthly after a down payment.
  const plans = { vacuum: { account: amex.id }, laptop: { account: td.id, down: null as number | null } }
  for (const offset of [23, 9]) card({ accountId: amex.id, date: addDays(end, -offset), amountMinor: -14_975, payee: 'KLARNA*DYSON CANADA', categoryName: 'General shopping' })
  const firstMonthly = addMonthsToDate(`${monthOf(end)}-01`, -5)
  plans.laptop.down = add({ accountId: td.id, date: addDays(firstMonthly, -30), amountMinor: -40_000, payee: 'AFFIRM *BEST BUY', categoryName: 'Electronics' })
  for (let m = firstMonthly; m <= end; m = addMonthsToDate(m, 1)) {
    add({ accountId: td.id, date: m, amountMinor: -12_500, payee: 'AFFIRM *BEST BUY', categoryName: 'Electronics' })
  }

  // Recent activity left for the app to categorize: history covers most, two are brand new.
  const recent = (offset: number) => addDays(end, -offset)
  add({ accountId: amex.id, date: recent(1), amountMinor: -6_745, payee: 'LOBLAWS #1104 TORONTO ON', categoryId: null })
  add({ accountId: amex.id, date: recent(1), amountMinor: -3_218, payee: 'UBER *EATS PENDING', categoryId: null })
  add({ accountId: amex.id, date: recent(0), amountMinor: -4_280, payee: 'SHOPPERS DRUG MART #1290', categoryId: null })
  add({ accountId: amex.id, date: recent(0), amountMinor: -1_650, payee: 'BIRDS & BEANS COFFEE', categoryId: null })
  add({ accountId: amex.id, date: recent(2), amountMinor: -8_999, payee: 'MEC MOUNTAIN EQUIPMENT', categoryId: null })

  // Investment balance updates at each month end (contributions + market moves).
  let value = 2_150_000
  for (let m = start; m <= end; m = addMonthsToDate(m, 1)) {
    const monthEnd = addDays(addMonthsToDate(m, 1), -1)
    if (monthEnd > end) break
    value = Math.round((value + 50_000) * (1 + (rand() - 0.35) * 0.04))
    setBalance(ctx, tfsa.id, { date: monthEnd, balanceMinor: value })
  }

  // Uncategorized recent rows: apply history where it is confident, otherwise flag for review.
  const pending = ctx.sqlite
    .prepare('SELECT id, payee, amount_minor AS amount FROM transactions WHERE category_id IS NULL AND transfer_pair_id IS NULL')
    .all() as Array<{ id: number; payee: string; amount: number }>
  return { count, pending, tfsa: tfsa.id, plans, end, firstMonthly }
}

/** Seeds demo data and runs the same follow-up the app would: history categories and recurring detection. */
export function loadDemo(ctx: AppContext, opts: { force?: boolean } = {}) {
  const { count, pending, plans, end, firstMonthly } = seedDemo(ctx, opts)

  for (const p of pending) {
    const s = historySuggestion(ctx, p.payee, p.amount)
    if (!s?.categoryId) continue
    ctx.sqlite
      .prepare(`UPDATE transactions SET category_id = ?, category_source = 'history', category_confidence = ?, needs_review = ? WHERE id = ?`)
      .run(s.categoryId, s.confidence, s.confidence >= 0.8 ? 0 : 1, p.id)
  }

  // The plans, as you'd add them: named, with their number of payments, and the laptop's down payment added at its own amount.
  const category = (name: string) => (ctx.sqlite.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number | undefined) ?? null
  createRecurring(
    ctx,
    recurringCreateSchema.parse({
      payee: 'KLARNA*DYSON CANADA',
      name: 'Dyson vacuum',
      expectedAmountMinor: -14_975,
      cadence: 'biweekly',
      anchorDate: addDays(end, -23),
      totalPayments: 4,
      accountId: plans.vacuum.account,
      categoryId: category('General shopping'),
    }),
  )
  const laptop = createRecurring(
    ctx,
    recurringCreateSchema.parse({
      payee: 'AFFIRM *BEST BUY',
      name: 'Laptop',
      expectedAmountMinor: -12_500,
      cadence: 'monthly',
      anchorDate: firstMonthly,
      totalPayments: 13,
      accountId: plans.laptop.account,
      categoryId: category('Electronics'),
    }),
  )
  if (plans.laptop.down) addPayment(ctx, laptop.id, plans.laptop.down)

  const { created } = detectRecurring(ctx)
  // Confirm the obvious ones; leave the rest as suggestions to review in the app.
  for (const item of listRecurring(ctx, 'suggested')) {
    if (/rent|netflix|spotify|rogers|payroll|fido|goodlife|hydro|cashback/i.test(item.payee)) confirmRecurring(ctx, item.id)
  }
  // Mark the newest Uber Eats charge as an AI-style suggestion to show the review flow.
  ctx.sqlite
    .prepare(
      `UPDATE transactions SET category_source = 'ai', category_confidence = 0.86, needs_review = 1
       WHERE id = (SELECT id FROM transactions WHERE payee LIKE 'UBER *EATS%' ORDER BY date DESC LIMIT 1)`,
    )
    .run()
  // A custom report (id 1): spending without the trip and other big one-offs. Rent is a recurring item, so it stays.
  const trip = ctx.sqlite.prepare("SELECT id FROM tags WHERE name = 'trip-japan'").pluck().get() as number
  createCustomReport(ctx, {
    name: 'Everyday spending',
    spec: {
      filter: {
        spending: {
          filterOut: [
            { when: [{ field: 'tag', ids: [trip] }] },
            { when: [{ field: 'amount', min: 100_000 }, { field: 'recurring', ids: 'none' }] },
          ],
        },
      },
      range: '12m',
      compare: 'previous',
      groupBy: 'category',
    },
  })
  return { transactions: count, recurringSuggestions: created }
}
