/**
 * Payee names. A payee is kept as the bank or file sent it ("WAL-MART SUPERCENTER#4217"), and it's
 * called that unless your payee name rules or AI tidying (on the server) call it otherwise. Payees
 * called the same are one payee: the name, folded, is the key that tells them apart.
 */

/**
 * Goes up whenever what payees are called changes in a way kept payee keys must follow, so every
 * transaction's payee_key is made again (the server's refreshPayees, at startup).
 */
export const PAYEE_RULES_VERSION = 8

export type PayeeNameRuleKind = 'same' | 'regex'
export type PayeeNameMatch = 'is' | 'starts' | 'contains'
/** One of your rules for payee names (see payeeNamer). */
export interface PayeeNameRuleSpec {
  id: number
  kind: PayeeNameRuleKind
  /** For `same`: how a payee fits a pattern. */
  match: PayeeNameMatch | null
  /** `same`: names that are this payee. `regex`: one pattern. */
  patterns: string[]
  /** `same`: the payee's name. `regex`: what it becomes ($1 for what the first group caught). */
  name: string | null
  enabled: boolean
}
/** What a payee is called, and the key that tells payees apart (the same key: the same payee). */
export interface PayeeNaming {
  name: string
  key: string
  /** Your rule that named it. Null: AI tidying named it, or it's as sent. */
  ruleId: number | null
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
/** Which payee a name is: case, accents and punctuation left out (“Tim Hortons #2241” → “tim hortons 2241”). */
export const payeeKey = (name: string): string =>
  fold(name)
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}& ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fold(name)

/** A regex you gave, or null when it isn't one. */
export function payeeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}
const expand = (template: string, m: RegExpMatchArray) => template.replace(/\$(&|\d{1,2})/g, (_, g: string) => (g === '&' ? m[0] : (m[Number(g)] ?? '')))
const fits = (match: PayeeNameMatch | null, text: string, pattern: string) =>
  match === 'contains' ? text.includes(pattern) : match === 'starts' ? text.startsWith(pattern) : text === pattern

/**
 * Names payees: by your rules first, then AI tidying (`tidied`: the name it gave a payee as sent, when
 * it's on and has), and otherwise as sent. Your rules match the payee as sent only, never what AI
 * tidying called it.
 *
 * 1. Your regex rules: the first that matches names it.
 * 2. Your "one payee" rules: the first whose pattern is it, starts it or is in it names it, leaving
 *    out case, accents and punctuation.
 * 3. Otherwise what AI tidying called it, or the payee as sent.
 *
 * A name is the payee: payees named the same are one.
 */
export function payeeNamer(rules: readonly PayeeNameRuleSpec[] = [], tidied?: (raw: string) => string | undefined): (raw: string) => PayeeNaming {
  const live = rules.filter((r) => r.enabled)
  const regexes = live.flatMap((r) => {
    const re = r.kind === 'regex' && r.patterns[0] ? payeeRegex(r.patterns[0]) : null
    return re ? [{ r, re }] : []
  })
  const sames = live.filter((r) => r.kind === 'same' && r.name?.trim()).map((r) => ({ r, keys: r.patterns.map(payeeKey).filter(Boolean) }))
  const memo = new Map<string, PayeeNaming>()
  const name = (raw: string): PayeeNaming => {
    for (const { r, re } of regexes) {
      const m = raw.match(re)
      const out = m ? expand(r.name ?? '', m).trim() : ''
      if (out) return { name: out, key: payeeKey(out), ruleId: r.id }
    }
    const sent = payeeKey(raw)
    for (const { r, keys } of sames) {
      if (keys.some((k) => fits(r.match, sent, k))) return { name: r.name!.trim(), key: payeeKey(r.name!), ruleId: r.id }
    }
    const named = tidied?.(raw)?.trim() || raw
    return { name: named, key: payeeKey(named), ruleId: null }
  }
  return (raw) => {
    let n = memo.get(raw)
    if (!n) {
      if (memo.size > 20_000) memo.clear()
      n = name(raw)
      memo.set(raw, n)
    }
    return n
  }
}

/** A key's words for telling payees alike: numbers (a store's, a code) only when they're all there is. */
function words(key: string) {
  const all = key.split(' ').filter((t) => t.length > 1)
  const named = all.filter((t) => !/\d/.test(t))
  return named.length ? named : all
}
/** How alike two payees are when one's words start the other's (“loblaws” and “loblaws toronto on”). */
const LEADS = 0.78

/**
 * Token-set similarity (0..1) of payee keys, for fuzzy payee matching. Store numbers and codes are
 * left out (“tim hortons 2241” is “tim hortons 1032”), and a payee whose words start another's is
 * likely it (“loblaws”, “loblaws toronto on”).
 */
export function payeeSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const [wa, wb] = [words(a), words(b)]
  if (!wa.length || !wb.length) return 0
  const [ta, tb] = [new Set(wa), new Set(wb)]
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  const jaccard = common / (ta.size + tb.size - common)
  // Prefix bonus: "tim horton" vs "tim hortons"
  const prefix = a.startsWith(b) || b.startsWith(a) ? 0.25 : 0
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  const leads = short.every((w, i) => long[i] === w)
  return Math.min(1, Math.max(jaccard + prefix, leads ? (short.length === long.length ? 1 : LEADS) : 0))
}

/**
 * Buy-now-pay-later services: their payments are instalments. Every 2 weeks it's "Pay in 4";
 * monthly plans vary in length, so you say how many.
 */
const INSTALMENT_SERVICES = /\b(klarna|afterpay|clearpay|sezzle|affirm|paybright|uplift|pay ?in ?4)\b|^zip\b/
export const isInstalmentService = (key: string) => INSTALMENT_SERVICES.test(key)

/**
 * The store in a buy-now-pay-later charge's description: "KLARNA*BOSE" → "BOSE", "AFTERPAY *
 * SEPHORA" → "SEPHORA". Null without one.
 */
export function instalmentStore(raw: string): string | null {
  const m = raw.match(/^\s*(?:klarna|afterpay|clearpay|sezzle|zip(?:\s?pay|\.co)?|affirm|paybright|uplift)\b[\s*#:|.-]*(.*)$/i)
  const rest = m?.[1]?.replace(/\b(pay\s?in\s?4|instal+ments?|payments?|purchase|inc|ltd|llc)\b/gi, ' ').trim()
  if (!rest || !/[a-z]{2,}/i.test(rest)) return null
  const store = rest.replace(/\s+/g, ' ').replace(/[\s*#:|.,-]+$/, '')
  return isInstalmentService(store.toLowerCase()) ? null : store
}
