import { z } from 'zod'
import { parseFixedRange, REPORT_PRESETS } from './dates'
import { formatMoney } from './money'

/**
 * A report's filter: for spending and for income apart, what counts (Only count), what's filtered out
 * (rules, and purchases picked one at a time) and what's put back. Refunds and paybacks are judged by
 * the purchase they're linked to. The same JSON is the API's `filter` param, the web's URL and a
 * custom report's saved filter.
 *
 *  - Only conditions must all match (none: everything counts).
 *  - A rule filters out what matches all of its conditions, and any rule is enough.
 *  - The values in one condition are "any of".
 *  - Picked transactions are filtered out, and put back ones (`keep`) aren't, whatever the rules say.
 *    Neither overrides Only.
 */
export const FILTER_LIMITS = { only: 20, rules: 20, ruleConditions: 5, ids: 200, words: 20, word: 100, json: 4000 } as const

export const FILTER_SIDES = ['spending', 'income'] as const
export type FilterSide = (typeof FILTER_SIDES)[number]

/** Where words are looked for, when not everywhere the search box looks. */
export const TEXT_SCOPES = ['name', 'payee', 'notes'] as const
export type TextScope = (typeof TEXT_SCOPES)[number]

const id = z.number().int().positive()
const list = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(FILTER_LIMITS.ids)
const share = z.number().int().nonnegative().safe()
const orNone = z.union([id, z.literal('none')])

export const conditionSchema = z
  .discriminatedUnion('field', [
    z.object({ field: z.literal('category'), ids: list(orNone) }).describe(
      'In any of these categories (`none` is uncategorized). A refund or payback is in its purchase’s.',
    ),
    z.object({ field: z.literal('group'), ids: list(orNone) }).describe(
      'In a category of any of these groups (`none`: uncategorized, or a category with no group). A refund or payback is in its purchase’s.',
    ),
    z.object({ field: z.literal('label'), ids: list(orNone) }).describe(
      'In a category with any of these labels (`none`: a category with no label, or uncategorized). A refund or payback is in its purchase’s.',
    ),
    z.object({ field: z.literal('tag'), ids: list(id) }).describe('Has any of these tags.'),
    z.object({ field: z.literal('payee'), keys: list(z.string().min(1).max(200)) }).describe('Any of these payees, by payee key.'),
    z
      .object({
        field: z.literal('text'),
        words: z.array(z.string().trim().min(1).max(FILTER_LIMITS.word)).min(1).max(FILTER_LIMITS.words),
        in: z.array(z.enum(TEXT_SCOPES)).min(1).max(TEXT_SCOPES.length).optional().describe('Only in these. Left out: everywhere the search box looks.'),
      })
      .describe('Matches any of these words, as the search box does: payee, name, notes, recurring item or exact amount.'),
    z
      .object({ field: z.literal('amount'), min: share.optional(), max: share.optional() })
      .refine((c) => c.min !== undefined || c.max !== undefined, 'Give at least one amount')
      .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, 'The lowest amount is more than the highest')
      .describe('Your share, in minor units, both ends included: what it cost less the refunds and paybacks linked to it (for income, what came in less what’s linked to bills).'),
    z.object({ field: z.literal('account'), ids: list(id) }).describe('In any of these accounts.'),
    z
      .object({ field: z.literal('recurring'), ids: z.union([z.literal('any'), z.literal('none'), list(id)]) })
      .describe('`any`: a payment of one of your recurring items (not a suggestion or a dismissed one). `none`: not one. Or these items.'),
  ])
  .meta({ id: 'FilterCondition' })
export type Condition = z.output<typeof conditionSchema>
export type ConditionField = Condition['field']

/** Only one of each of these in Only count: a second one is merged into the first (`mergeCondition`). */
const SINGLE_FIELDS = new Set<ConditionField>(['category', 'group', 'label', 'payee', 'account', 'recurring'])

const repeats = (conditions: Condition[], fields?: Set<ConditionField>) => {
  const seen = new Set<ConditionField>()
  return conditions.some((c) => {
    if (fields && !fields.has(c.field)) return false
    if (seen.has(c.field)) return true
    seen.add(c.field)
    return false
  })
}

export const ruleSchema = z
  .object({
    when: z.array(conditionSchema).min(1).max(FILTER_LIMITS.ruleConditions),
    label: z.string().trim().min(1).max(40).optional().describe('What you call it, like “One-offs”, said in place of its conditions.'),
  })
  .refine((r) => !repeats(r.when), 'Use each field once in a rule')
  .meta({ id: 'FilterRule' })
export type Rule = z.output<typeof ruleSchema>

const ids = z.array(id).max(FILTER_LIMITS.ids).default([])
export const filterSideSchema = z
  .object({
    only: z.array(conditionSchema).max(FILTER_LIMITS.only).default([]).describe('Count only what matches all of these.'),
    filterOut: z.array(ruleSchema).max(FILTER_LIMITS.rules).default([]).describe('Filter out what matches any of these rules.'),
    picked: ids.describe('Transactions filtered out one at a time.'),
    keep: ids.describe('Transactions put back: counted, whatever the rules and picks say (Only count still applies).'),
  })
  .refine((s) => !repeats(s.only, SINGLE_FIELDS), 'Use category, group, label, payee, account and recurring once in Only count')
export type FilterSideFilter = z.output<typeof filterSideSchema>

export const filterSchema = z
  .object({
    v: z.literal(1).default(1),
    spending: filterSideSchema.optional().describe('For spending: purchases and bills, with their refunds and paybacks.'),
    income: filterSideSchema.optional().describe('For income.'),
  })
  .meta({ id: 'ReportFilter' })
export type ReportFilter = z.output<typeof filterSchema>
export type ReportFilterInput = z.input<typeof filterSchema>

/** A `filter` query param: the filter as JSON. Bad JSON is a validation error, like any other. */
export const filterParam = z
  .string()
  .max(FILTER_LIMITS.json, `Keep the filter under ${FILTER_LIMITS.json} characters`)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Use a filter as JSON' })
      return z.NEVER
    }
  })
  .pipe(filterSchema)
  .describe('A ReportFilter as JSON: for spending and income apart, Only count conditions, Filter out rules, picked and put back transactions.')

/** The filter in `s`, or null when it isn't one (never throws). */
export function safeParseFilter(s: string | null | undefined): ReportFilter | null {
  if (!s) return null
  const r = filterParam.safeParse(s)
  return r.success ? r.data : null
}

export const EMPTY_SIDE: FilterSideFilter = Object.freeze({ only: [], filterOut: [], picked: [], keep: [] }) as FilterSideFilter

export function sideOf(f: ReportFilter | null | undefined, side: FilterSide): FilterSideFilter {
  return f?.[side] ?? EMPTY_SIDE
}

export function isEmptySide(s: FilterSideFilter | null | undefined): boolean {
  return !s || (!s.only.length && !s.filterOut.length && !s.picked.length && !s.keep.length)
}

export function isEmptyFilter(f: ReportFilter | null | undefined): boolean {
  return !f || FILTER_SIDES.every((side) => isEmptySide(f[side]))
}

const sortedIds = <T extends number | 'none'>(v: T[]): T[] =>
  [...new Set(v)].sort((a, b) => (a === 'none' ? 1 : b === 'none' ? -1 : (a as number) - (b as number)))
const sortedText = (v: string[]) => [...new Set(v)].sort()

export function normalizeCondition(c: Condition): Condition {
  switch (c.field) {
    case 'category':
    case 'group':
    case 'label':
      return { field: c.field, ids: sortedIds(c.ids) }
    case 'tag':
    case 'account':
      return { field: c.field, ids: sortedIds(c.ids) }
    case 'payee':
      return { field: c.field, keys: sortedText(c.keys) }
    case 'text': {
      // The same word in another case is the same word.
      const seen = new Set<string>()
      const words = c.words.map((w) => w.trim()).filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
      const scope = c.in && [...new Set(c.in)].sort()
      return { field: c.field, words: words.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), ...(scope && { in: scope }) }
    }
    case 'amount':
      return { field: c.field, ...(c.min !== undefined && { min: c.min }), ...(c.max !== undefined && { max: c.max }) }
    case 'recurring':
      return { field: c.field, ids: Array.isArray(c.ids) ? sortedIds(c.ids) : c.ids }
  }
}

function normalizeSide(s: FilterSideFilter): FilterSideFilter {
  return {
    only: s.only.map(normalizeCondition),
    filterOut: s.filterOut.map((r) => ({ when: r.when.map(normalizeCondition), ...(r.label && { label: r.label }) })),
    picked: sortedIds(s.picked),
    keep: sortedIds(s.keep),
  }
}

/** Ids sorted and once each, and a side with nothing in it left out. Conditions and rules keep their order. */
export function normalizeFilter(f: ReportFilter | null | undefined): ReportFilter {
  const out: ReportFilter = { v: 1 }
  for (const side of FILTER_SIDES) {
    const s = f?.[side]
    if (!isEmptySide(s)) out[side] = normalizeSide(s!)
  }
  return out
}

const key = (v: unknown) => JSON.stringify(v)
const conditionsKey = (r: Rule) => key([...r.when].sort((a, b) => a.field.localeCompare(b.field)))
const ruleKey = (r: Rule) => key([conditionsKey(r), r.label ?? null])

/** The same filter, whatever the order of ids, conditions and rules. */
export function sameFilter(a: ReportFilter | null | undefined, b: ReportFilter | null | undefined): boolean {
  const canonical = (f: ReportFilter | null | undefined) => {
    const n = normalizeFilter(f)
    return key(
      FILTER_SIDES.map((side) => {
        const s = n[side]
        return s && { only: s.only.map(key).sort(), filterOut: s.filterOut.map(ruleKey).sort(), picked: s.picked, keep: s.keep }
      }),
    )
  }
  return canonical(a) === canonical(b)
}

/** `f` with one side changed by `fn` (normalized). */
export function withSide(f: ReportFilter | null | undefined, side: FilterSide, fn: (s: FilterSideFilter) => FilterSideFilter): ReportFilter {
  return normalizeFilter({ ...normalizeFilter(f), [side]: fn(sideOf(f, side)) })
}

/** Two conditions on the same field merged: any of both's values. An amount or recurring condition is replaced. */
function merged(into: Condition, c: Condition): Condition {
  if ((into.field === 'category' || into.field === 'group' || into.field === 'label') && into.field === c.field) {
    return { field: into.field, ids: sortedIds([...into.ids, ...c.ids]) }
  }
  if (into.field === 'payee' && c.field === 'payee') return { field: 'payee', keys: sortedText([...into.keys, ...c.keys]) }
  if (into.field === 'text' && c.field === 'text') {
    // Looked for everywhere if either one is.
    const scope = into.in && c.in && [...into.in, ...c.in]
    return normalizeCondition({ field: 'text', words: [...into.words, ...c.words], ...(scope && { in: scope }) })
  }
  if ((into.field === 'tag' || into.field === 'account') && into.field === c.field) return { field: into.field, ids: sortedIds([...into.ids, ...c.ids]) }
  return c
}

/** Adds a condition to Only count: into the condition already on its field, if any, so nothing stacks up twice. */
export function mergeCondition(conditions: Condition[], c: Condition): Condition[] {
  const i = conditions.findIndex((x) => x.field === c.field)
  if (i < 0) return [...conditions, c]
  return conditions.map((x, j) => (j === i ? merged(x, c) : x))
}

/** Sets a field's condition in Only count, in place of any already on it (a drill-down to one category, say). */
export function setCondition(conditions: Condition[], c: Condition): Condition[] {
  const i = conditions.findIndex((x) => x.field === c.field)
  if (i < 0) return [...conditions, c]
  return conditions.flatMap((x, j) => (j === i ? [c] : x.field === c.field ? [] : [x]))
}

/**
 * Adds a Filter out rule. A one-condition rule on a field another one-condition rule already has is
 * merged into it (Filter out Costco, then Walmart: one rule, Costco or Walmart), and a rule that's
 * already there isn't added again.
 */
export function addRule(rules: Rule[], rule: Rule): Rule[] {
  const [only] = rule.when
  if (rule.when.length === 1 && only && only.field !== 'amount' && only.field !== 'recurring') {
    const i = rules.findIndex((r) => r.when.length === 1 && r.when[0]!.field === only.field)
    if (i >= 0) return rules.map((r, j) => (j === i ? { ...r, when: [merged(r.when[0]!, only)] } : r))
  }
  const k = conditionsKey({ when: rule.when.map(normalizeCondition) })
  if (rules.some((r) => conditionsKey({ when: r.when.map(normalizeCondition) }) === k)) return rules
  return [...rules, rule]
}

export function removeAt<T>(items: T[], i: number): T[] {
  return items.filter((_, j) => j !== i)
}

/** Filters out one transaction (no longer put back, if it was). */
export function pick(s: FilterSideFilter, id: number): FilterSideFilter {
  return { ...s, picked: sortedIds([...s.picked, id]), keep: s.keep.filter((k) => k !== id) }
}

/** Counts a filtered out transaction again: no longer picked, and put back if a rule still filters it out. */
export function putBack(s: FilterSideFilter, id: number, ruleMatches: boolean): FilterSideFilter {
  return { ...s, picked: s.picked.filter((p) => p !== id), keep: ruleMatches ? sortedIds([...s.keep, id]) : s.keep }
}

/** Lets the rules filter it out again. */
export function unkeep(s: FilterSideFilter, id: number): FilterSideFilter {
  return { ...s, keep: s.keep.filter((k) => k !== id) }
}

/** Names for describing a filter. Left out or unknown: the reference no longer exists. */
export type FilterNames = {
  category?: (id: number) => string | undefined
  group?: (id: number) => string | undefined
  label?: (id: number) => string | undefined
  tag?: (id: number) => string | undefined
  payee?: (key: string) => string | undefined
  account?: (id: number) => string | undefined
  recurring?: (id: number) => string | undefined
  currency?: string
}

const join = (items: string[]) => items.join(', ')
const quoted = (words: string[]) => join(words.map((w) => `“${w}”`))
const and = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? ''))

/**
 * Groups and labels named as what they are, so they aren't taken for categories: "the Food group",
 * "Food and Housing groups", "no label", "the Wants label or no label".
 */
function setWords(ids: Array<number | 'none'>, noun: 'group' | 'label', name: FilterNames['group']) {
  const known = ids.flatMap((i) => (i === 'none' || !name?.(i) ? [] : [name(i)!]))
  // Ones that are gone are said once: "a deleted group", "2 deleted groups".
  const gone = ids.filter((i) => i !== 'none' && !name?.(i)).length
  const named = known.length === 1 && !gone ? `the ${known[0]} ${noun}` : known.length ? `${and(known)} ${noun}${known.length > 1 || gone ? 's' : ''}` : ''
  const deleted = gone ? (gone === 1 ? `a deleted ${noun}` : `${gone} deleted ${noun}s`) : ''
  return [[named, deleted].filter(Boolean).join(' and '), ids.includes('none') ? `no ${noun}` : ''].filter(Boolean).join(' or ')
}

/** No group (or no label) alone: said of the charges it's on, as "Only no label" wouldn't read. */
const noneAlone = (c: Condition) => (c.field === 'group' || c.field === 'label') && c.ids.every((i) => i === 'none')

function money(minor: number, names: FilterNames) {
  return formatMoney(minor, names.currency).replace(/\.00$/, '')
}

function amountWords(c: Extract<Condition, { field: 'amount' }>, names: FilterNames) {
  if (c.min !== undefined && c.max !== undefined) return c.min === c.max ? `of ${money(c.min, names)}` : `of ${money(c.min, names)}–${money(c.max, names)}`
  return c.min !== undefined ? `of ${money(c.min, names)} or more` : `of ${money(c.max!, names)} or less`
}

/** What each value of a condition is called: names, `#tags`, “words”. */
function valueWords(c: Condition, names: FilterNames): string {
  switch (c.field) {
    case 'category':
      return join(c.ids.map((i) => (i === 'none' ? 'Uncategorized' : (names.category?.(i) ?? 'Deleted category'))))
    case 'group':
    case 'label':
      return setWords(c.ids, c.field, names[c.field])
    case 'tag':
      return join(c.ids.map((i) => (names.tag?.(i) ? `#${names.tag(i)}` : 'Deleted tag')))
    case 'payee':
      return join(c.keys.map((k) => names.payee?.(k) ?? k))
    case 'text':
      return `${quoted(c.words)}${c.in ? ` in ${TEXT_SCOPES.filter((x) => c.in!.includes(x)).join(' or ')}` : ''}`
    case 'account':
      return join(c.ids.map((i) => names.account?.(i) ?? 'Deleted account'))
    case 'recurring':
      return Array.isArray(c.ids) ? join(c.ids.map((i) => names.recurring?.(i) ?? 'Deleted recurring item')) : c.ids === 'any' ? 'recurring' : 'one-time'
    case 'amount':
      return amountWords(c, names)
  }
}

const NOUN: Record<FilterSide, string> = { spending: 'charges', income: 'deposits' }

/** "Only Groceries, Dining", "Only the Food group", "Only one-time", "Only charges of $1,000 or more". */
export function describeCondition(c: Condition, side: FilterSide, names: FilterNames = {}): string {
  if (noneAlone(c)) return `Only ${NOUN[side]} with ${valueWords(c, names)}`
  switch (c.field) {
    case 'text':
      return `Only matching ${valueWords(c, names)}`
    case 'amount':
      return `Only ${NOUN[side]} ${amountWords(c, names)}`
    case 'account':
      return `Only on ${valueWords(c, names)}`
    case 'recurring':
      return Array.isArray(c.ids) ? `Only recurring ${valueWords(c, names)}` : `Only ${valueWords(c, names)}`
    default:
      return `Only ${valueWords(c, names)}`
  }
}

/**
 * "Filter out #trip-japan", "Filter out Costco", "Filter out the Wants label", or for several
 * conditions one phrase: "Filter out one-time charges of $1,000 or more", "Filter out charges of
 * $200 or more at Costco", "Filter out charges in the Food group".
 */
export function describeRule(rule: Rule, side: FilterSide, names: FilterNames = {}): string {
  if (rule.label) return `Filter out ${rule.label}`
  const [first] = rule.when
  if (rule.when.length === 1 && first && ['category', 'group', 'label', 'tag', 'payee', 'text'].includes(first.field) && !noneAlone(first)) {
    return `Filter out ${valueWords(first, names)}`
  }
  const of = <F extends ConditionField>(field: F) => rule.when.find((c): c is Extract<Condition, { field: F }> => c.field === field)
  const recurring = of('recurring')
  const words = [
    recurring && !Array.isArray(recurring.ids) ? valueWords(recurring, names) : '',
    NOUN[side],
    of('amount') ? amountWords(of('amount')!, names) : '',
    of('payee') ? `${side === 'spending' ? 'at' : 'from'} ${valueWords(of('payee')!, names)}` : '',
    of('category') ? `in ${valueWords(of('category')!, names)}` : '',
    of('group') ? `${noneAlone(of('group')!) ? 'with' : 'in'} ${valueWords(of('group')!, names)}` : '',
    // "with no group and the Wants label", not "with … with …".
    of('label') ? `${of('group') && noneAlone(of('group')!) ? 'and' : 'with'} ${valueWords(of('label')!, names)}` : '',
    of('account') ? `on ${valueWords(of('account')!, names)}` : '',
    of('tag') ? `tagged ${valueWords(of('tag')!, names)}` : '',
    of('text') ? `matching ${valueWords(of('text')!, names)}` : '',
    recurring && Array.isArray(recurring.ids) ? `for ${valueWords(recurring, names)}` : '',
  ]
  return `Filter out ${words.filter(Boolean).join(' ')}`
}

/** A side's filter in words, one item per condition, rule, picks and put backs. */
export function describeSide(s: FilterSideFilter | undefined, side: FilterSide, names: FilterNames = {}): string[] {
  if (!s) return []
  return [
    ...s.only.map((c) => describeCondition(c, side, names)),
    ...s.filterOut.map((r) => describeRule(r, side, names)),
    ...(s.picked.length ? [`Filter out ${s.picked.length} picked`] : []),
    ...(s.keep.length ? [`Put back ${s.keep.length}`] : []),
  ]
}

/** "Spending: Only Groceries · Filter out #trip-japan. Income: Filter out deposits of $5,000 or more", or "Everything". */
export function describeFilter(f: ReportFilter | null | undefined, names: FilterNames = {}): string {
  const parts = FILTER_SIDES.flatMap((side) => {
    const items = describeSide(f?.[side], side, names)
    return items.length ? [`${side === 'spending' ? 'Spending' : 'Income'}: ${items.join(' · ')}`] : []
  })
  return parts.length ? parts.join('. ') : 'Everything'
}

/** The ids and keys a filter refers to, by kind (to name them, or find the ones that no longer exist). */
export function filterRefs(f: ReportFilter | null | undefined) {
  const refs = {
    category: new Set<number>(),
    group: new Set<number>(),
    label: new Set<number>(),
    tag: new Set<number>(),
    payee: new Set<string>(),
    account: new Set<number>(),
    recurring: new Set<number>(),
    transaction: new Set<number>(),
  }
  for (const side of FILTER_SIDES) {
    const s = f?.[side]
    if (!s) continue
    for (const c of [...s.only, ...s.filterOut.flatMap((r) => r.when)]) {
      if (c.field === 'category' || c.field === 'group' || c.field === 'label') c.ids.forEach((i) => i !== 'none' && refs[c.field].add(i))
      else if (c.field === 'tag') c.ids.forEach((i) => refs.tag.add(i))
      else if (c.field === 'payee') c.keys.forEach((k) => refs.payee.add(k))
      else if (c.field === 'account') c.ids.forEach((i) => refs.account.add(i))
      else if (c.field === 'recurring' && Array.isArray(c.ids)) c.ids.forEach((i) => refs.recurring.add(i))
    }
    ;[...s.picked, ...s.keep].forEach((i) => refs.transaction.add(i))
  }
  return refs
}

/**
 * Every condition in a filter rewritten by `fn` (told whether it's in Only count or a rule), for
 * remapping ids. Null is a condition none of whose values exist any more: it goes from Only count,
 * and its rule goes (it can't match anything).
 */
export function mapConditions(f: ReportFilter, fn: (c: Condition, place: 'only' | 'rule') => Condition | null): ReportFilter {
  const out: ReportFilter = { v: 1 }
  for (const side of FILTER_SIDES) {
    const s = f[side]
    if (!s) continue
    out[side] = {
      ...s,
      only: s.only.flatMap((c) => fn(c, 'only') ?? []),
      filterOut: s.filterOut.flatMap((r) => {
        const when = r.when.map((c) => fn(c, 'rule'))
        return when.every(Boolean) ? [{ ...r, when: when as Condition[] }] : []
      }),
    }
  }
  return normalizeFilter(out)
}

const nameMap = z.record(z.string(), z.string().max(200)).optional()
const refNamesSchema = z.object({ category: nameMap, group: nameMap, label: nameMap, tag: nameMap, payee: nameMap, account: nameMap, recurring: nameMap })

export const REPORT_COMPARE = ['previous', 'last-year', 'none'] as const
export type ReportCompare = (typeof REPORT_COMPARE)[number]
export const REPORT_GROUP_BY = ['category', 'group'] as const

export const reportRangeSchema = z
  .union([z.enum(REPORT_PRESETS), z.string().refine((v) => parseFixedRange(v) !== null, 'Use months like 2025-11..2026-10, at most 36 of them')])
  .describe('Last 3, 6, 12 or 24 months (moving with today), this year, last year, or fixed months `YYYY-MM..YYYY-MM`.')

/** What a custom report keeps: its filter, and how it shows (left out: as it was). */
export const reportSpecSchema = z
  .object({
    v: z.literal(1).default(1),
    // As long as the report endpoints take it in `filter`.
    filter: filterSchema
      .default({ v: 1 })
      .refine((f) => JSON.stringify(normalizeFilter(f)).length <= FILTER_LIMITS.json, `Keep the filter under ${FILTER_LIMITS.json} characters`),
    range: reportRangeSchema.nullable().default(null).describe('Null: the report opens with whatever range you have.'),
    compare: z.enum(REPORT_COMPARE).default('previous').describe('Compared with the months just before, the same months a year before, or nothing.'),
    groupBy: z.enum(REPORT_GROUP_BY).default('category'),
    names: refNamesSchema.optional().describe('What the filter’s ids were called when it was last saved, to name ones that are gone. Set by the server.'),
  })
  .meta({ id: 'ReportSpec' })
export type ReportSpec = z.output<typeof reportSpecSchema>
export type RefNames = z.output<typeof refNamesSchema>

/**
 * Names for a saved report's filter: what they're called now, or, for one that's gone, what it was
 * called when the report was saved ("#moving (deleted)"; a payee with no transactions keeps its name).
 */
export function withSavedNames(live: FilterNames, saved: RefNames | undefined): FilterNames {
  const was = (kind: keyof RefNames, id: number | string, gone = ' (deleted)') => {
    const name = saved?.[kind]?.[String(id)]
    return name === undefined ? undefined : `${name}${gone}`
  }
  return {
    ...live,
    category: (id) => live.category?.(id) ?? was('category', id),
    group: (id) => live.group?.(id) ?? was('group', id),
    label: (id) => live.label?.(id) ?? was('label', id),
    tag: (id) => live.tag?.(id) ?? was('tag', id),
    payee: (key) => live.payee?.(key) ?? was('payee', key, ''),
    account: (id) => live.account?.(id) ?? was('account', id),
    recurring: (id) => live.recurring?.(id) ?? was('recurring', id),
  }
}

/** `spec` is still what's `saved`: a range kept as a preset is the same however today moves, and with none kept, any range is. */
export function sameSpec(spec: ReportSpec, saved: ReportSpec): boolean {
  return (
    sameFilter(spec.filter, saved.filter) &&
    spec.compare === saved.compare &&
    spec.groupBy === saved.groupBy &&
    (saved.range === null || spec.range === saved.range)
  )
}
