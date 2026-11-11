import { eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { payeeKey, payeeNamer, type PayeeTidyPreview, type PayeeTidyStatus } from '@chipmunk/shared'
import { askStructured } from '../ai/runner'
import { payeeTidy } from '../db/schema'
import { badRequest } from '../lib/http'
import type { MetaStore } from './context'
import { forgetPayeeNamer, loadNameRules, payeeNamerFor } from './payee-namer'
import { payeesSent, renamed, type PayeeWorld } from './payee-names'
import { aiConfig, getAppSetting, setAppSetting } from './settings'

/**
 * AI tidying of payee names: each payee as sent is named by AI once ("Walmart" for "Wal-Mart
 * Supercenter#4217", "Jane Doe - e-Transfer" for "JANE DOE - INTERAC e-Transfer®"), kept in
 * payee_tidy, and used for every transaction with that payee, in every ledger, while it's on. Off,
 * payees are called what the bank sent. Turning it on names the rest in the background, in batches,
 * and new payees as they come. Your rules still come first.
 */

/**
 * The names already used, for the AI to name payees consistently: `related`, those of payees whose
 * wording or name shares a word with the ones asked about, each with its payees as sent, and
 * `others`, the rest, the most used first.
 */
export interface KnownNames {
  related: Array<{ name: string; payees: string[] }>
  others: string[]
}
/** Names payees as sent, with the names already used for consistency. */
export type PayeeTidier = (payees: string[], known: KnownNames) => Promise<{ names: Array<{ payee: string; name: string }>; model: string | null }>

const BATCH = 40
const SAMPLE = 20

/** Goes up whenever SYSTEM changes what it makes: payees named by older instructions are asked again. */
export const PAYEE_TIDY_PROMPT = 5

const SYSTEM = `You tidy payee names from Canadian bank and credit card statements, so a person can read each one at a glance.

You're given the payees to name, and the names already used: related_names are payees already named whose wording or name shares a word with the ones you're given, each with those payees as the bank sent them, and other_names_already_used are the rest.

The one rule: take out noise, keep information. Every word that says who the money went to or came from, what it was for, or how it moved stays. When you're not sure whether a word is noise, keep it.

Noise, to take out:
- Payment companies in front of the merchant (Square, Toast, Shopify, PayPal, Alipay, Nayax, PayTR, Stripe and the like).
- Store and terminal numbers, reference codes, card and phone numbers, and web address endings like .com.
- The city, province or country after a merchant, unless it's part of the name (Royal Bank of Canada, Canada Life, Toronto Hydro).
- Words that only say it was a card purchase: Purchase, Pending, POS and the like.
- How a purchase was paid at the merchant: by phone, at a pay machine, in an app, online, at a kiosk and the like.
- Trademark signs, and anything said twice: keep it once (Klarna*Klarna, or PAP, a pre-authorized payment, before Pre-authorized debit).

Then write it cleanly:
- Capitalize it as the business does (McDonald's, 7-Eleven, IKEA, Scotiabank Visa), never all capitals unless the business does.
- Write out words the bank shortened, or cut off at the end because its text has a set length (PAYMNT → Payment, MTG → Mortgage, Brewing Compa → Brewing Company). When you can't tell what a word was, keep it as the bank wrote it.
- How the money moved goes last, after " - ". Use these words when one fits: e-Transfer, Direct deposit, Bill payment, Pre-authorized debit, Dividend, Withholding tax. Otherwise keep the bank's words for it, in sentence case.
- Payees given together are often one business or person worded differently, and so are the payees in related_names. Decide which are the same, and give them the same name, however the bank words it. When a payee is the same business or person as one in related_names, and the same kind of thing, use that name exactly.
- Something that isn't the same business or person, or is a different thing from it (a parking ticket, not parking), gets its own name, however alike the wording.
- Don't guess which business a payee is. Tidy what's there.

Answer for every payee given, with the payee exactly as given.

For example:
- "WAL-MART SUPERCENTER#4217" → "Walmart"
- "SQ *BLUE BOTTLE COFFEE VANCOUVER BC" → "Blue Bottle Coffee"
- "SQ *ACME BREWING COMPA" → "Acme Brewing Company"
- "JANE DOE - INTERAC e-Transfer®" → "Jane Doe - e-Transfer"
- "ACME MTG PAYMNT - Pre-authorized debit" → "Acme Mortgage Payment - Pre-authorized debit"
- "ACME HYDRO-PAP - Pre-authorized debit" → "Acme Hydro - Pre-authorized debit"
- "ACME CARD - Bill payment" → "Acme Card - Bill payment"
- "ACME PARKING PAY MACHIN" → "Acme Parking"
- "ACME PARKING-MYPARKING APP" → "Acme Parking"
- "ACME PARKING PARKING TI" → "Acme Parking Ticket"
- "CASH BACK REDEEMED" → "Cash back redeemed"
- "Transfer to TFSA" → "Transfer to TFSA"
- "XEQT - Diy dividend" → "XEQT - Dividend"
- "XEQT - Non resident tax" → "XEQT - Withholding tax"`

const answer = z.object({ names: z.array(z.object({ payee: z.string(), name: z.string() })) })

/** The configured AI providers as a tidier, its calls logged with a ledger's AI usage. */
export function aiTidier(world: PayeeWorld): PayeeTidier {
  return async (payees, known) => {
    const ctx = world.ledgers()[0]
    if (!ctx) throw new Error('There’s no ledger to log AI calls in.')
    const res = await askStructured(ctx, {
      system: SYSTEM,
      user: JSON.stringify({ payees, related_names: known.related, other_names_already_used: known.others }),
      name: 'payee_names',
      schema: answer,
      jsonSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'object', properties: { payee: { type: 'string' }, name: { type: 'string' } }, required: ['payee', 'name'], additionalProperties: false },
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
      shape: '{"names": [{"payee": string, "name": string}]}',
      invalid: 'The model didn’t name the payees as asked',
      maxTokens: 8192,
      timeoutMs: 120_000,
    })
    return { names: res.data.names, model: res.model }
  }
}

interface Job {
  running: boolean
  done: number
  total: number
  error: string | null
}
const jobs = new WeakMap<object, Job>()
const jobOf = (meta: MetaStore): Job => {
  let job = jobs.get(meta.db)
  if (!job) jobs.set(meta.db, (job = { running: false, done: 0, total: 0, error: null }))
  return job
}

const aiAvailable = (meta: MetaStore) => !!(aiConfig(meta, 'primary') || aiConfig(meta, 'fallback'))
/** The tidier given (a test's), or the configured AI providers, which must be set up. */
function tidierFor(world: PayeeWorld, tidier?: PayeeTidier): PayeeTidier {
  if (tidier) return tidier
  if (!aiAvailable(world.meta)) badRequest('Set up an AI provider first, in App settings → AI.')
  return aiTidier(world)
}

/** What AI tidying called each payee as sent, by its current instructions (older names are asked again). */
const currentNames = (meta: MetaStore) =>
  new Map(
    meta.db
      .select({ original: payeeTidy.original, tidied: payeeTidy.tidied })
      .from(payeeTidy)
      .where(gte(payeeTidy.prompt, PAYEE_TIDY_PROMPT))
      .all()
      .map((r) => [r.original, r.tidied]),
  )

/** A payee's words that can tell it apart: no numbers, nothing shorter than 3 letters. */
const wordsOf = (text: string) => payeeKey(text).split(' ').filter((w) => w.length > 2 && !/\d/.test(w))

/**
 * The names already used, for the AI to reuse: what each payee goes by now, by your rule or by AI
 * tidying's current instructions. Names of payees whose wording or name shares a word with the ones
 * asked about come with those payees as sent (“Costco”: “COSTCO WHOLESALE W123”), the most used
 * first. A word in many payees (“interac”) doesn't make them related.
 */
function knownNames(world: PayeeWorld, payees: string[]): KnownNames {
  const tidied = currentNames(world.meta)
  const rules = loadNameRules(world.meta)
  const byRule = payeeNamer(rules)
  const asking = new Set(payees)
  const sent = payeesSent(world)
  const named = new Map<string, { payees: Array<[string, number]>; uses: number }>()
  for (const [payee, n] of sent) {
    if (asking.has(payee)) continue
    const r = byRule(payee)
    const name = r.ruleId !== null ? r.name : tidied.get(payee)
    if (!name) continue
    const e = named.get(name) ?? { payees: [], uses: 0 }
    e.payees.push([payee, n])
    e.uses += n
    named.set(name, e)
  }
  for (const r of rules) if (r.kind === 'same' && r.name && !named.has(r.name)) named.set(r.name, { payees: [], uses: 0 })

  // Words in many payees say little about which are alike.
  const counts = new Map<string, number>()
  for (const payee of sent.keys()) for (const w of new Set(wordsOf(payee))) counts.set(w, (counts.get(w) ?? 0) + 1)
  const common = Math.max(10, sent.size * 0.04)
  const telling = (text: string) => wordsOf(text).filter((w) => (counts.get(w) ?? 0) <= common)
  const asked = new Set(payees.flatMap(telling))
  const related = (name: string, e: { payees: Array<[string, number]> }) => [name, ...e.payees.map(([p]) => p)].some((t) => telling(t).some((w) => asked.has(w)))

  const byUse = [...named.entries()].sort((a, b) => b[1].uses - a[1].uses)
  const near = byUse.filter(([name, e]) => related(name, e)).slice(0, 50)
  const nearNames = new Set(near.map(([name]) => name))
  return {
    related: near.map(([name, e]) => ({ name, payees: e.payees.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p) })),
    others: byUse
      .filter(([name]) => !nearNames.has(name))
      .slice(0, 200)
      .map(([name]) => name),
  }
}

/** Asks for names, keeps them (the payee as sent → its name). Returns the ones kept. */
async function tidyBatch(world: PayeeWorld, payees: string[], tidier: PayeeTidier) {
  const { names, model } = await tidier(payees, knownNames(world, payees))
  const asked = new Set(payees)
  const keep = (original: string, tidied: string) =>
    world.meta.db
      .insert(payeeTidy)
      .values({ original, tidied, model, prompt: PAYEE_TIDY_PROMPT })
      .onConflictDoUpdate({
        target: payeeTidy.original,
        set: {
          tidied: sql`excluded.tidied`,
          model: sql`excluded.model`,
          prompt: sql`excluded.prompt`,
          updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        },
      })
      .run()
  const kept = names.filter((n) => asked.has(n.payee) && n.name.trim())
  world.meta.db.transaction(() => kept.forEach((n) => keep(n.payee, n.name.trim().slice(0, 120))))
  return kept
}

export function tidyStatus(world: PayeeWorld): PayeeTidyStatus {
  const sent = payeesSent(world)
  // Names by older instructions are left out: they're asked again.
  const rows = world.meta.db
    .select({ original: payeeTidy.original, tidied: payeeTidy.tidied, updatedAt: payeeTidy.updatedAt })
    .from(payeeTidy)
    .where(gte(payeeTidy.prompt, PAYEE_TIDY_PROMPT))
    .all()
  const job = jobOf(world.meta)
  const named = payeeNamerFor(world)
  return {
    enabled: getAppSetting<boolean>(world.meta, 'payees.aiTidy', false),
    available: aiAvailable(world.meta),
    running: job.running,
    done: job.done,
    total: job.total,
    error: job.error,
    names: rows
      .sort((a, b) => a.original.localeCompare(b.original, undefined, { sensitivity: 'base', numeric: true }))
      .map((r) => {
        const n = named(r.original)
        return { ...r, name: n.ruleId !== null ? n.name : r.tidied, ruleId: n.ruleId, transactions: sent.get(r.original) ?? 0 }
      }),
  }
}

/**
 * What AI tidying makes of a batch of 20 payees, before it names the rest: the messiest and most used
 * first, a batch at a time. A payee it named before isn't asked again, so a batch seen before comes
 * back as it was. What it says is kept.
 */
export async function previewTidy(world: PayeeWorld, page = 0, given?: PayeeTidier): Promise<PayeeTidyPreview> {
  const tidied = currentNames(world.meta)
  const messy = (p: string) => (/[A-Z]{3,}|\d{3,}|[*#]/.test(p) ? 1 : 0)
  const all = [...payeesSent(world).entries()].sort((a, b) => messy(b[0]) - messy(a[0]) || b[1] - a[1]).map(([p]) => p)
  const batch = all.slice(page * SAMPLE, (page + 1) * SAMPLE)
  const fresh = batch.filter((p) => !tidied.has(p))
  if (fresh.length) {
    const tidier = tidierFor(world, given)
    try {
      for (const n of await tidyBatch(world, fresh, tidier)) tidied.set(n.payee, n.name)
    } catch (err) {
      badRequest(err instanceof Error ? err.message : String(err))
    }
  }
  return { samples: batch.filter((p) => tidied.has(p)).map((original) => ({ original, tidied: tidied.get(original)! })), page, total: all.length }
}

/**
 * Names, in the background, every payee AI tidying hasn't yet (or did by older instructions): in batches, each kept and applied (the
 * payees named again in every ledger) as it comes. One run at a time; nothing while it's off. A batch
 * that fails stops the run, saying why, and the rest wait for the next.
 */
export async function tidyNewPayees(world: PayeeWorld, given?: PayeeTidier): Promise<void> {
  const job = jobOf(world.meta)
  if (job.running || !getAppSetting<boolean>(world.meta, 'payees.aiTidy', false)) return
  if (!given && !aiAvailable(world.meta)) return
  const tidier = given ?? aiTidier(world)
  const tidied = currentNames(world.meta)
  // In order of their words, so a business's wordings are named together.
  const todo = [...payeesSent(world).keys()].filter((p) => !tidied.has(p)).sort((a, b) => payeeKey(a).localeCompare(payeeKey(b)))
  if (!todo.length) return
  Object.assign(job, { running: true, done: 0, total: todo.length, error: null })
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      if (!getAppSetting<boolean>(world.meta, 'payees.aiTidy', false)) break
      const batch = todo.slice(i, i + BATCH)
      await tidyBatch(world, batch, tidier)
      job.done += batch.length
      renamed(world)
    }
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err)
  } finally {
    job.running = false
  }
}

/** Turns AI tidying on (it names the rest in the background) or off (payees are called what the bank sent again). */
export function setAiTidy(world: PayeeWorld, enabled: boolean, given?: PayeeTidier): PayeeTidyStatus {
  const tidier = enabled ? tidierFor(world, given) : given
  setAppSetting(world.meta, 'payees.aiTidy', enabled)
  forgetPayeeNamer(world.meta)
  renamed(world)
  if (enabled) void tidyNewPayees(world, tidier)
  return tidyStatus(world)
}

/** Payees AI tidying named wrong, to name again: forgotten, then asked again together (while it's on). */
export function tidyAgain(world: PayeeWorld, originals: string[], tidier?: PayeeTidier): PayeeTidyStatus {
  world.meta.db.transaction(() => originals.forEach((o) => world.meta.db.delete(payeeTidy).where(eq(payeeTidy.original, o)).run()))
  renamed(world)
  void tidyNewPayees(world, tidier)
  return tidyStatus(world)
}
