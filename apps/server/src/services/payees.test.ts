import { describe, expect, it } from 'vitest'
import { transactionCreateSchema } from '@chipmunk/shared'
import { categoryId, makeAccount, testContext } from '../test/helpers'
import { mergeCategory, setCategoryEnabled } from './categories'
import { aiSuggestion, suggestCategory } from './categorize'
import { userPrompt } from '../ai/prompt'
import { createCustomReport, getCustomReport } from './custom-reports'
import { createNameRule, deleteNameRule, followBankPayee, keepRuleNames, listNameRules, nameWordings, previewNameRules, rebuildPayeeKeys, renamePayee, updateNameRule, worldOfLedger } from './payee-names'
import { PAYEE_TIDY_PROMPT, previewTidy, setAiTidy, tidyAgain, tidyNewPayees, tidyStatus, type KnownNames, type PayeeTidier } from './payee-tidy'
import { getPayeeChoice, listPayeeRules, setPayeeChoice } from './payees'
import { createTransaction, getTransaction, insertTransaction, listTransactions, updateTransaction } from './transactions'

const tx = (input: Record<string, unknown>) => transactionCreateSchema.parse(input)

describe('payee choices', () => {
  it('always sets one category: on what’s waiting now, and on new ones without review', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const [dineOut, groceries] = [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Groceries')]
    const add = (date: string, extra: Record<string, unknown> = {}) =>
      createTransaction(ctx, tx({ accountId: acc, date, amountMinor: -1200, payee: 'A&W RESTAURANTS #123', ...extra }), { useAi: false })
    const confirmed = await add('2026-09-01', { categoryId: groceries })
    const waiting = await add('2026-09-02')
    const loose = await add('2026-09-03')
    ctx.sqlite.prepare('UPDATE transactions SET category_id = NULL, needs_review = 0 WHERE id = ?').run(loose.id)
    expect(getTransaction(ctx, waiting.id)).toMatchObject({ categoryId: groceries, needsReview: true })

    expect(getPayeeChoice(ctx, 'a&w restaurants 123', dineOut)).toMatchObject({ mode: 'ask', pending: 2 })
    expect(setPayeeChoice(ctx, { payeeKey: 'a&w restaurants 123', mode: 'always', categoryId: dineOut })).toMatchObject({ updated: 2 })
    expect([waiting, loose].map((t) => getTransaction(ctx, t.id))).toEqual([
      expect.objectContaining({ categoryId: dineOut, needsReview: false }),
      expect.objectContaining({ categoryId: dineOut, needsReview: false }),
    ])
    // What you set yourself stays.
    expect(getTransaction(ctx, confirmed.id).categoryId).toBe(groceries)
    expect(await add('2026-09-10')).toMatchObject({ categoryId: dineOut, needsReview: false, categorySource: 'history' })
    expect(listPayeeRules(ctx)).toEqual([expect.objectContaining({ payeeKey: 'a&w restaurants 123', payee: 'A&W RESTAURANTS #123', mode: 'always', categoryId: dineOut, transactionCount: 4 })])

    // Back to asking: a suggestion to review again.
    setPayeeChoice(ctx, { payeeKey: 'a&w restaurants 123', mode: 'ask' })
    expect(await add('2026-09-11')).toMatchObject({ needsReview: true })
    expect(listPayeeRules(ctx)).toEqual([])
  })

  it('only sets an income category on money in', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const salary = categoryId(ctx, 'Salary')
    const pay = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: 300_000, payee: 'ACME PAYROLL' }), { useAi: false })
    const fee = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-02', amountMinor: -500, payee: 'ACME PAYROLL' }), { useAi: false })
    expect(setPayeeChoice(ctx, { payeeKey: 'acme payroll', mode: 'always', categoryId: salary }).updated).toBe(1)
    expect([getTransaction(ctx, pay.id).categoryId, getTransaction(ctx, fee.id).categoryId]).toEqual([salary, null])
  })

  it('never sets a payee you always review, even when the bank and AI agree', async () => {
    const ctx = testContext({ llm: async () => ({ category: 'Rent', confidence: 0.95, agreesWithBank: true, slot: 'primary', model: 'm' }) })
    const acc = makeAccount(ctx)
    const input = { payee: 'TRANSFER OUT', amountMinor: -200_000, accountId: acc, bankCategory: 'Rent', bankConfident: true }
    expect(await aiSuggestion(ctx, input)).toMatchObject({ autoApply: true })
    setPayeeChoice(ctx, { payeeKey: 'transfer out', mode: 'review' })
    expect(await aiSuggestion(ctx, input)).toMatchObject({ categoryId: categoryId(ctx, 'Rent'), autoApply: false })
    expect(getPayeeChoice(ctx, 'transfer out')).toMatchObject({ mode: 'review', categoryId: null })
  })

  it('suggests from money the same way: an e-transfer to you isn’t one you send', async () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const [dineOut, gifts] = [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Gifts')]
    const payee = 'INTERAC E-TRANSFER SAM LEE'
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-01', amountMinor: 4_600, payee, categoryId: dineOut }))
    await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-02', amountMinor: -5_000, payee, categoryId: gifts }))
    expect((await suggestCategory(ctx, { payee, amountMinor: 2_000, useAi: false })).categoryId).toBe(dineOut)
    expect((await suggestCategory(ctx, { payee, amountMinor: -2_000, useAi: false })).categoryId).toBe(gifts)
    // Changing one moves what was learned the same way only.
    const t = await createTransaction(ctx, tx({ accountId: acc, date: '2026-09-03', amountMinor: -1_000, payee, categoryId: gifts }))
    updateTransaction(ctx, t.id, { categoryId: dineOut })
    expect((await suggestCategory(ctx, { payee, amountMinor: 2_000, useAi: false })).categoryId).toBe(dineOut)
  })

  it('follows its category when it’s merged, and goes when it’s turned off', async () => {
    const ctx = testContext()
    const [dineOut, treats, groceries] = [categoryId(ctx, 'Dine out'), categoryId(ctx, 'Drinks & treats'), categoryId(ctx, 'Groceries')]
    setPayeeChoice(ctx, { payeeKey: 'starbucks', mode: 'always', categoryId: treats })
    setPayeeChoice(ctx, { payeeKey: 'loblaws', mode: 'always', categoryId: groceries })
    mergeCategory(ctx, treats, dineOut)
    expect(getPayeeChoice(ctx, 'starbucks')).toMatchObject({ mode: 'always', categoryId: dineOut })
    setCategoryEnabled(ctx, groceries, { enabled: false, moveTo: null })
    expect(getPayeeChoice(ctx, 'loblaws').mode).toBe('ask')
    expect(() => setPayeeChoice(ctx, { payeeKey: 'loblaws', mode: 'always', categoryId: groceries })).toThrow(/off in this ledger/)
  })
})

describe('payee name rules', () => {
  const setup = () => {
    const ctx = testContext()
    const acc = makeAccount(ctx)
    const sync = (date: string, payee: string, amountMinor = -1596) =>
      insertTransaction(ctx, tx({ accountId: acc, date, amountMinor, payee }), { origin: 'sync', skipRecurring: true, suggestion: null })
    return { ctx, acc, sync, world: worldOfLedger(ctx) }
  }

  it('names a payee on all its transactions from one, past and future, keeping the payee as sent', () => {
    const { ctx, sync, world } = setup()
    const first = sync('2026-10-01', 'KWAN HOLDINGS INC')
    const second = sync('2026-10-09', 'KWAN HOLDINGS INC')
    const other = sync('2026-10-09', 'KWAN HOLDINGS INC #2')
    expect(getTransaction(ctx, first)).toMatchObject({ payee: 'KWAN HOLDINGS INC', payeeKey: 'kwan holdings inc', payeeName: 'KWAN HOLDINGS INC', payeeNameRule: null })

    const { rule, changed } = renamePayee(world, { payee: 'KWAN HOLDINGS INC', name: 'Corner Bakery' })
    expect(rule).toMatchObject({ kind: 'same', match: 'is', patterns: ['KWAN HOLDINGS INC'], name: 'Corner Bakery', transactionCount: 2 })
    expect(changed).toBe(2)
    const later = sync('2026-10-12', 'KWAN HOLDINGS INC')
    for (const id of [first, second, later]) expect(getTransaction(ctx, id)).toMatchObject({ payeeName: 'Corner Bakery', payeeKey: 'corner bakery', payeeNameRule: rule!.id })
    // Worded otherwise by the bank: another payee, until AI tidying or a rule says it's this one.
    expect(getTransaction(ctx, other)).toMatchObject({ payeeName: 'KWAN HOLDINGS INC #2', payeeNameRule: null })
    expect(getTransaction(ctx, first).payee).toBe('KWAN HOLDINGS INC')
    expect(listTransactions(ctx, { q: 'corner bakery', limit: 10 }).items).toHaveLength(3)
    // AI hears it too.
    const req = { payee: 'KWAN HOLDINGS INC', payeeName: 'Corner Bakery', amountMinor: -1596, date: null, accountType: null, notes: null, categories: [], examples: [] }
    expect(userPrompt(req)).toContain('- What the user calls this payee: Corner Bakery')

    // The bank's payee isn't yours to change. Its name is.
    expect(() => updateTransaction(ctx, first, { payee: 'Corner Bakery' })).toThrow('Its payee is what the bank or file sent.')
    expect(updateTransaction(ctx, first, { name: 'Birthday cake' })).toMatchObject({ name: 'Birthday cake', payeeName: 'Corner Bakery' })

    // Renamed again: its rule changes. No name: the rule goes, and it's as sent again.
    expect(renamePayee(world, { payee: 'KWAN HOLDINGS INC', name: 'Corner Bakery Cafe' }).rule).toMatchObject({ id: rule!.id, name: 'Corner Bakery Cafe' })
    expect(renamePayee(world, { payee: 'KWAN HOLDINGS INC', name: null })).toEqual({ rule: null, changed: 3 })
    expect(listNameRules(world)).toEqual([])
    expect(getTransaction(ctx, first)).toMatchObject({ payeeName: 'KWAN HOLDINGS INC', payeeKey: 'kwan holdings inc' })
  })

  it('makes two payees one by naming them the same, with what was set for them', () => {
    const { ctx, sync, world } = setup()
    const dineOut = categoryId(ctx, 'Dine out')
    const a = sync('2026-10-01', 'FROSTY CUP*4471')
    const b = sync('2026-10-02', 'Frosty Cup Frozen Yogurt')
    setPayeeChoice(ctx, { payeeKey: 'frosty cup frozen yogurt', mode: 'always', categoryId: dineOut })
    const frosty = renamePayee(world, { payee: 'FROSTY CUP*4471', name: 'Frosty' }).rule!
    // The same name: it joins that rule, and its choice comes along.
    expect(renamePayee(world, { payee: 'Frosty Cup Frozen Yogurt', name: 'frosty' }).rule).toMatchObject({ id: frosty.id, patterns: ['FROSTY CUP*4471', 'Frosty Cup Frozen Yogurt'] })
    expect([a, b].map((id) => getTransaction(ctx, id).payeeKey)).toEqual(['frosty', 'frosty'])
    expect(listPayeeRules(ctx)).toEqual([expect.objectContaining({ payeeKey: 'frosty', payee: 'Frosty', categoryId: dineOut })])
  })

  it('names by starting with or containing, and by regex, in the order they apply', () => {
    const { ctx, sync, world } = setup()
    const prime = sync('2026-10-02', 'AMAZON PRIME*2K4L19R03')
    const book = sync('2026-10-03', 'Amazon.ca*7Q3KX81Z2')
    const bbq = sync('2026-10-04', 'HOLLIS BAR-B-Q #12')
    const coop = sync('2026-10-05', 'CALGARY CO-OP #12 MIDTOWN')
    const name = (id: number) => getTransaction(ctx, id).payeeName

    // A preview first: what it would change.
    expect(previewNameRules(world, { rule: { kind: 'same', match: 'starts', patterns: ['Amazon Prime'], name: 'Prime Video' } })).toEqual({
      transactions: 1,
      changes: [{ from: 'AMAZON PRIME*2K4L19R03', to: 'Prime Video', payees: ['AMAZON PRIME*2K4L19R03'], transactions: 1 }],
    })
    expect(createNameRule(world, { kind: 'same', match: 'starts', patterns: ['Amazon Prime'], name: 'Prime Video' })).toMatchObject({ changed: 1, rule: { transactionCount: 1 } })
    expect([name(prime), name(book)]).toEqual(['Prime Video', 'Amazon.ca*7Q3KX81Z2'])
    createNameRule(world, { kind: 'same', match: 'contains', patterns: ['co-op'], name: 'Co-op' })
    expect(name(coop)).toBe('Co-op')

    const { rule } = createNameRule(world, { kind: 'regex', patterns: ['^HOLLIS (BAR-B-Q)'], name: 'Hollis $1 Smokehouse' })
    expect(name(bbq)).toBe('Hollis BAR-B-Q Smokehouse')
    expect(() => createNameRule(world, { kind: 'regex', patterns: ['(unclosed'], name: 'x' })).toThrow('isn’t a regex that works')
    expect(() => createNameRule(world, { kind: 'same', patterns: ['Frosty Cup'] })).toThrow('Give the payee a name.')

    // Off, and removed.
    updateNameRule(world, rule.id, { enabled: false })
    expect(name(bbq)).toBe('HOLLIS BAR-B-Q #12')
    deleteNameRule(world, rule.id)
    expect(listNameRules(world).map((r) => r.name)).toEqual(['Prime Video', 'Co-op'])
  })

  it('moves a payee keyed by older naming to the one it is now, with what was set for it', () => {
    const { ctx } = setup()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const groceries = categoryId(ctx, 'Groceries')
    const id = insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-07', amountMinor: -2040, payee: 'Nbx*Snackbox', categoryId: groceries }), { origin: 'sync', skipRecurring: true, suggestion: null })
    // Keyed as the old built-in cleanup made it, with a choice for that payee.
    ctx.sqlite.prepare("UPDATE transactions SET payee_key = 'snackbox' WHERE id = ?").run(id)
    setPayeeChoice(ctx, { payeeKey: 'snackbox', mode: 'always', categoryId: groceries })

    expect(rebuildPayeeKeys(ctx)).toEqual([id])
    expect(getTransaction(ctx, id)).toMatchObject({ payeeKey: 'nbx snackbox', payeeName: 'Nbx*Snackbox' })
    expect(listPayeeRules(ctx).map((r) => [r.payeeKey, r.categoryId])).toEqual([['nbx snackbox', groceries]])
    expect(rebuildPayeeKeys(ctx)).toEqual([])
  })

  it('carries custom reports over to payees’ new keys, all at once', () => {
    const { ctx } = setup()
    const acc = makeAccount(ctx, 'Visa', 'credit')
    const add = (payee: string, olderKey?: string) => {
      const id = insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-07', amountMinor: -2040, payee }), { origin: 'sync', skipRecurring: true, suggestion: null })
      if (olderKey) ctx.sqlite.prepare('UPDATE transactions SET payee_key = ? WHERE id = ?').run(olderKey, id)
      return id
    }
    // Keyed as older naming made them: one of snackbox's transactions moves, and all of corner cafe's.
    const snack = add('Nbx*Snackbox', 'snackbox')
    add('Snackbox')
    const cafe = add('Tst-Corner Cafe', 'corner cafe')
    const report = createCustomReport(ctx, {
      name: 'Treats',
      spec: { filter: { spending: { only: [{ field: 'payee', keys: ['snackbox'] }], filterOut: [{ when: [{ field: 'payee', keys: ['corner cafe'] }] }] } } },
    })
    const other = createCustomReport(ctx, { name: 'Other', spec: { filter: { income: { only: [{ field: 'payee', keys: ['acme payroll'] }] } } } })

    expect(rebuildPayeeKeys(ctx)).toEqual([snack, cafe])
    const [snackKey, cafeKey] = [snack, cafe].map((id) => getTransaction(ctx, id).payeeKey)
    expect(getCustomReport(ctx, report.id).spec.filter.spending).toMatchObject({
      only: [{ field: 'payee', keys: [snackKey, 'snackbox'].sort() }],
      filterOut: [{ when: [{ field: 'payee', keys: [cafeKey] }] }],
    })
    expect(getCustomReport(ctx, other.id)).toEqual(other)
    expect(ctx.sqlite.prepare("SELECT actor, entity_id AS id, summary FROM activity WHERE entity = 'custom_report'").all()).toEqual([
      { actor: 'Chipmunk', id: String(report.id), summary: 'Treats now filters by the payees’ new names, Nbx*Snackbox, Tst-Corner Cafe' },
    ])
  })

  it('carries a custom report over when the bank words a payee otherwise', () => {
    const { ctx, sync } = setup()
    const id = sync('2026-10-07', 'SQ *PENDING BLUE CAFE')
    const was = getTransaction(ctx, id)
    const report = createCustomReport(ctx, { name: 'Cafe', spec: { filter: { spending: { only: [{ field: 'payee', keys: [was.payeeKey] }] } } } })
    followBankPayee(ctx, { id, payee: was.payee, payeeKey: was.payeeKey, origin: 'sync' }, 'BLUE CAFE TORONTO')
    const key = getTransaction(ctx, id).payeeKey
    expect(key).not.toBe(was.payeeKey)
    expect(getCustomReport(ctx, report.id).spec.filter.spending!.only).toEqual([{ field: 'payee', keys: [key] }])
  })

  it('keeps a payee your rule named by what older naming made of it', () => {
    const { ctx, sync, world } = setup()
    const id = sync('2026-10-07', 'Tst-Corner Cafe')
    const { rule } = createNameRule(world, { kind: 'same', patterns: ['Corner Cafe'], name: 'The Corner' })
    // Named when the built-in cleanup dropped Toast's “Tst-”.
    ctx.sqlite.prepare("UPDATE transactions SET payee_key = 'the corner' WHERE id = ?").run(id)
    expect(keepRuleNames(world)).toBe(1)
    expect(listNameRules(world)).toEqual([expect.objectContaining({ id: rule.id, patterns: ['Corner Cafe', 'Tst-Corner Cafe'], transactionCount: 1 })])
    expect(rebuildPayeeKeys(ctx)).toEqual([])
    expect(keepRuleNames(world)).toBe(0)
  })
})

describe('AI tidying of payee names', () => {
  /** A stand-in for the AI: names payees from a list, and says what it was asked. */
  const fakeAi = (names: Record<string, string>) => {
    const asked: string[][] = []
    const tidier: PayeeTidier = async (payees) => {
      asked.push(payees)
      return { names: payees.flatMap((payee) => (names[payee] ? [{ payee, name: names[payee]! }] : [])), model: 'test-model' }
    }
    return { tidier, asked }
  }
  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('previews 20 payees, then names the rest in the background, each payee asked once', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    const acc = makeAccount(ctx)
    const raw = Array.from({ length: 30 }, (_, i) => `STORE ${i} #${1000 + i} TORONTO ON`)
    raw.forEach((payee, i) => insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-01', amountMinor: -100 - i, payee }), { origin: 'sync', skipRecurring: true, suggestion: null }))
    // Walmart, the most used, first.
    const walmart = insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-02', amountMinor: -4567, payee: 'WAL-MART SUPERCENTER#4217' }), { origin: 'sync', skipRecurring: true, suggestion: null })
    insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-02', amountMinor: -1200, payee: 'WAL-MART SUPERCENTER#4217' }), { origin: 'sync', skipRecurring: true, suggestion: null })
    const ai = fakeAi({ ...Object.fromEntries(raw.map((p, i) => [p, `Shop ${i}`])), 'WAL-MART SUPERCENTER#4217': 'Walmart' })

    // The preview: 20 payees, as sent and as AI calls them. Still off: they're as sent.
    const { samples, total } = await previewTidy(world, 0, ai.tidier)
    expect([samples.length, total]).toEqual([20, 31])
    expect(samples).toContainEqual({ original: 'WAL-MART SUPERCENTER#4217', tidied: 'Walmart' })
    expect(samples).toContainEqual({ original: 'STORE 0 #1000 TORONTO ON', tidied: 'Shop 0' })
    expect(getTransaction(ctx, walmart).payeeName).toBe('WAL-MART SUPERCENTER#4217')
    expect(tidyStatus(world)).toMatchObject({ enabled: false, names: expect.arrayContaining([expect.objectContaining({ original: 'WAL-MART SUPERCENTER#4217', tidied: 'Walmart', transactions: 2 })]) })

    // On: the other 11 are named in the background, and every transaction goes by its AI name.
    setAiTidy(world, true, ai.tidier)
    await settle()
    expect(ai.asked.slice(1).flat()).toHaveLength(11)
    expect(tidyStatus(world)).toMatchObject({ enabled: true, running: false, done: 11, total: 11, error: null })
    expect(tidyStatus(world).names).toHaveLength(31)
    expect(getTransaction(ctx, walmart)).toMatchObject({ payeeName: 'Walmart', payeeKey: 'walmart' })
    const store = getTransaction(ctx, insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-03', amountMinor: -1, payee: 'STORE 3 #1003 TORONTO ON' }), { origin: 'sync', skipRecurring: true, suggestion: null }))
    expect(store).toMatchObject({ payeeName: 'Shop 3', payeeKey: 'shop 3' })
    // The same payee again isn't asked again.
    await tidyNewPayees(world, ai.tidier)
    expect(ai.asked).toHaveLength(2)

    // Your rules still come first.
    renamePayee(world, { payee: 'STORE 3 #1003 TORONTO ON', name: 'Corner shop' })
    expect(getTransaction(ctx, store.id)).toMatchObject({ payeeName: 'Corner shop', payeeNameRule: expect.any(Number) })

    // Named again on request.
    tidyAgain(world, ['STORE 4 #1004 TORONTO ON'], fakeAi({ 'STORE 4 #1004 TORONTO ON': 'Store Four' }).tidier)
    await settle()
    expect(tidyStatus(world).names.find((n) => n.original === 'STORE 4 #1004 TORONTO ON')).toMatchObject({ tidied: 'Store Four' })

    // Off: payees are as sent again, and what AI said is kept for later.
    setAiTidy(world, false)
    expect(getTransaction(ctx, walmart)).toMatchObject({ payeeName: 'WAL-MART SUPERCENTER#4217', payeeKey: 'wal mart supercenter 4217' })
    expect(listTransactions(ctx, { q: 'store 5', limit: 5 }).items[0]).toMatchObject({ payeeName: 'STORE 5 #1005 TORONTO ON' })
    expect(tidyStatus(world)).toMatchObject({ enabled: false, names: expect.any(Array) })
    expect(tidyStatus(world).names).toHaveLength(31)
  })

  it('previews a batch at a time, the next ones asked, ones seen before as they were', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    const acc = makeAccount(ctx)
    const raw = Array.from({ length: 45 }, (_, i) => `STORE ${String(i).padStart(2, '0')} #${1000 + i}`)
    raw.forEach((payee, i) => insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-01', amountMinor: -100 - i, payee }), { origin: 'sync', skipRecurring: true, suggestion: null }))
    const ai = fakeAi(Object.fromEntries(raw.map((p, i) => [p, `Shop ${i}`])))

    const first = await previewTidy(world, 0, ai.tidier)
    const second = await previewTidy(world, 1, ai.tidier)
    const last = await previewTidy(world, 2, ai.tidier)
    expect([first, second, last].map((p) => [p.page, p.samples.length, p.total])).toEqual([
      [0, 20, 45],
      [1, 20, 45],
      [2, 5, 45],
    ])
    expect(second.samples[0]).toEqual({ original: 'STORE 20 #1020', tidied: 'Shop 20' })
    // Back to the first: nothing asked, without an AI provider too.
    expect(await previewTidy(world, 0)).toEqual(first)
    expect(ai.asked.map((a) => a.length)).toEqual([20, 20, 5])
    expect((await previewTidy(world, 3, ai.tidier)).samples).toEqual([])
  })

  it('sends the names already used, related ones with their payees as sent, by your rule or AI', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    const acc = makeAccount(ctx)
    const sync = (payee: string, n = 1) => {
      for (let i = 0; i < n; i++) insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-01', amountMinor: -100, payee }), { origin: 'sync', skipRecurring: true, suggestion: null })
    }
    sync('ACME PARKING PAY MACHIN', 2)
    sync('ACME PARKING-MYPARKING APP')
    sync('ACME PARKING BY PHON')
    sync('UBER *TRIP', 5)
    const ai = fakeAi({
      'ACME PARKING PAY MACHIN': 'Acme Parking',
      'ACME PARKING-MYPARKING APP': 'Acme Parking',
      'ACME PARKING BY PHON': 'Acme Parking By Phone',
      'UBER *TRIP': 'Uber',
      'ACME PARKING VIRTUALPAY': 'Acme Parking',
    })
    await previewTidy(world, 0, ai.tidier)
    // Yours goes by your rule's name.
    nameWordings(world, { payees: ['ACME PARKING BY PHON'], name: 'Acme Parking (phone)' })
    sync('ACME PARKING VIRTUALPAY')
    const known: KnownNames[] = []
    setAiTidy(world, true, async (payees, names) => (known.push(names), ai.tidier(payees, names)))
    await settle()
    expect(known).toEqual([
      {
        related: [
          { name: 'Acme Parking', payees: ['ACME PARKING PAY MACHIN', 'ACME PARKING-MYPARKING APP'] },
          { name: 'Acme Parking (phone)', payees: ['ACME PARKING BY PHON'] },
        ],
        others: ['Uber'],
      },
    ])
  })

  it('names wordings from the tidied payees, one or several, apart from others named the same', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    const acc = makeAccount(ctx)
    const sync = (payee: string) => insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-01', amountMinor: -100, payee }), { origin: 'sync', skipRecurring: true, suggestion: null })
    const [store, other, third] = [sync('WAL-MART SUPERCENTER#4217'), sync('WALMART STORE #3010'), sync('WALMART.CA')]
    const ai = fakeAi({ 'WAL-MART SUPERCENTER#4217': 'Walmart', 'WALMART STORE #3010': 'Walmart', 'WALMART.CA': 'Walmart' })
    await previewTidy(world, 0, ai.tidier)
    setAiTidy(world, true, ai.tidier)
    await settle()
    const names = () => [store, other, third].map((id) => getTransaction(ctx, id).payeeName)

    // One: a rule for that wording only.
    const { rule } = nameWordings(world, { payees: ['WAL-MART SUPERCENTER#4217'], name: 'Walmart Supercentre' })
    expect(rule).toMatchObject({ kind: 'same', match: 'is', patterns: ['WAL-MART SUPERCENTER#4217'], name: 'Walmart Supercentre' })
    expect(names()).toEqual(['Walmart Supercentre', 'Walmart', 'Walmart'])
    expect(tidyStatus(world).names.map((n) => [n.original, n.tidied, n.name, n.ruleId])).toEqual([
      ['WAL-MART SUPERCENTER#4217', 'Walmart', 'Walmart Supercentre', rule!.id],
      ['WALMART STORE #3010', 'Walmart', 'Walmart', null],
      ['WALMART.CA', 'Walmart', 'Walmart', null],
    ])

    // Several: one rule. One of them comes off the rule that named it, which goes once it has none.
    const both = nameWordings(world, { payees: ['WAL-MART SUPERCENTER#4217', 'WALMART STORE #3010'], name: 'In store' }).rule!
    expect(both.patterns).toEqual(['WAL-MART SUPERCENTER#4217', 'WALMART STORE #3010'])
    expect(listNameRules(world).map((r) => r.name)).toEqual(['In store'])
    expect(names()).toEqual(['In store', 'In store', 'Walmart'])
    // A name a rule gives already: they join it.
    expect(nameWordings(world, { payees: ['WALMART.CA'], name: 'in store' }).rule).toMatchObject({ id: both.id, patterns: ['WAL-MART SUPERCENTER#4217', 'WALMART STORE #3010', 'WALMART.CA'] })

    // No name: off your rules, back to AI's names.
    expect(nameWordings(world, { payees: ['WALMART STORE #3010', 'WALMART.CA'], name: null }).rule).toBeNull()
    expect(names()).toEqual(['In store', 'Walmart', 'Walmart'])

    // From a transaction: every wording that's this payee, as sent.
    const all = renamePayee(world, { payee: 'WALMART.CA', name: 'Big shop' }).rule!
    expect(all.patterns.sort()).toEqual(['WALMART STORE #3010', 'WALMART.CA'])
  })

  it('asks AI again about several payees together', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    const acc = makeAccount(ctx)
    for (const payee of ['STORE 1', 'STORE 2', 'STORE 3']) insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-01', amountMinor: -100, payee }), { origin: 'sync', skipRecurring: true, suggestion: null })
    const ai = fakeAi({ 'STORE 1': 'One', 'STORE 2': 'Two', 'STORE 3': 'Three' })
    await previewTidy(world, 0, ai.tidier)
    setAiTidy(world, true, ai.tidier)
    await settle()
    const again = fakeAi({ 'STORE 1': 'Store One', 'STORE 3': 'Store Three' })
    tidyAgain(world, ['STORE 1', 'STORE 3'], again.tidier)
    await settle()
    expect(again.asked).toEqual([['STORE 1', 'STORE 3']])
    expect(tidyStatus(world).names.map((n) => n.name)).toEqual(['Store One', 'Two', 'Store Three'])
  })

  it('gives a transaction that becomes a payee you always set one way its category', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    const acc = makeAccount(ctx)
    const groceries = categoryId(ctx, 'Groceries')
    const sync = (payee: string) => insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-01', amountMinor: -100, payee }), { origin: 'sync', skipRecurring: true, suggestion: null })
    const [first, other] = [sync('ACME MARKET #1'), sync('ACME MARKET-NORTH')]
    setPayeeChoice(ctx, { payeeKey: getTransaction(ctx, first).payeeKey, mode: 'always', categoryId: groceries })
    expect([first, other].map((id) => getTransaction(ctx, id).categoryId)).toEqual([groceries, null])

    // AI tidying calls both Acme Market: one payee, always Groceries.
    const ai = fakeAi({ 'ACME MARKET #1': 'Acme Market', 'ACME MARKET-NORTH': 'Acme Market' })
    await previewTidy(world, 0, ai.tidier)
    setAiTidy(world, true, ai.tidier)
    await settle()
    expect(getTransaction(ctx, other)).toMatchObject({ payeeKey: 'acme market', categoryId: groceries, needsReview: false })
  })

  it('asks again for names given by older instructions', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    const acc = makeAccount(ctx)
    const id = insertTransaction(ctx, tx({ accountId: acc, date: '2026-10-01', amountMinor: 5000, payee: 'JANE DOE - INTERAC e-Transfer®' }), { origin: 'sync', skipRecurring: true, suggestion: null })
    ctx.meta.sqlite.prepare('INSERT INTO payee_tidy (original, tidied, prompt) VALUES (?, ?, ?)').run('JANE DOE - INTERAC e-Transfer®', 'Jane Doe', PAYEE_TIDY_PROMPT - 1)
    const ai = fakeAi({ 'JANE DOE - INTERAC e-Transfer®': 'Jane Doe - e-Transfer' })

    // The old name isn't shown as one to reuse, and the preview asks again.
    expect(tidyStatus(world).names).toEqual([])
    const known: KnownNames[] = []
    const { samples } = await previewTidy(world, 0, async (payees, names) => (known.push(names), ai.tidier(payees, names)))
    expect(known).toEqual([{ related: [], others: [] }])
    expect(samples).toEqual([{ original: 'JANE DOE - INTERAC e-Transfer®', tidied: 'Jane Doe - e-Transfer' }])
    setAiTidy(world, true, ai.tidier)
    await settle()
    expect(getTransaction(ctx, id)).toMatchObject({ payeeName: 'Jane Doe - e-Transfer' })
    expect(ai.asked).toHaveLength(1)
  })

  it('needs an AI provider, and says why a batch failed', async () => {
    const ctx = testContext()
    const world = worldOfLedger(ctx)
    insertTransaction(ctx, tx({ accountId: makeAccount(ctx), date: '2026-10-01', amountMinor: -100, payee: 'SOMEWHERE #12' }), { origin: 'sync', skipRecurring: true, suggestion: null })
    await expect(previewTidy(world)).rejects.toThrow('Set up an AI provider first')
    expect(() => setAiTidy(world, true)).toThrow('Set up an AI provider first')
    setAiTidy(world, true, async () => {
      throw new Error('Rate limited')
    })
    await settle()
    expect(tidyStatus(world)).toMatchObject({ enabled: true, running: false, error: 'Rate limited', names: [] })
  })
})
