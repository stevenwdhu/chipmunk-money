import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { type ISODate, type LedgerAction, type LedgerAnswers, type LedgerQuestion, type LedgerQuestions } from '@chipmunk/shared'
import { aiEnabled } from '../ai/runner'
import { bankAccounts } from '../db/schema'
import { badRequest } from '../lib/http'
import type { AccountFacts, AccountLedger, Held } from './account-rows'
import { leaveSplitOffBankIds, partsOf } from './accounts'
import { recordActivity, type ActivityActor } from './activity'
import type { AppContext, CtxOf } from './context'
import { categorizeUncategorized } from './import'
import { MOVE_LIMIT, moveTransactions, sendAsBankIds, sendAsDeleted } from './moves'
import { today } from './settings'
import { changeHome, changeWords, moveChunks, splitNotice, stepWords } from './sharing'
import { leaveSplits } from './splits'

/**
 * What's asked before a ledger is deleted, erased or archived, and what the answers then do. The
 * three actions share one process: each topic (TOPICS) says what it asks, what it does without a
 * choice (notices) and what stops the action whatever the answers (blockers), and applies the
 * answers in the action's own transaction, before the action itself. A feature that needs to ask
 * something of its own adds a topic.
 *
 * The one topic so far is shared accounts. A ledger that goes can't stay an account's home, keep
 * its opening balance, or take part in a split payment on it, and its transactions on it can't just
 * vanish: the bank would send the synced ones again, and they'd come back as new rows in the home.
 * So the home is asked for, and whether its transactions are deleted or moved to another ledger
 * that has the account. Archiving keeps the ledger's rows, so only the home and the opening balance
 * are handed over.
 */

/** A ledger, by name, as the answers and the changes give it. */
interface LedgerName {
  slug: string
  name: string
}

/** What a topic did with the answers. */
export interface Applied {
  /** What was done, in words, for the action's answer. */
  changes: string[]
  /** Transactions that came to another ledger uncategorized, by that ledger's id: for AI to categorize there once the action has committed. */
  categorize: Map<string, number[]>
}

interface Topic {
  /** What it asks and says before `action` on this ledger. Without `notes`, the questions carry none (they cost reads the action doesn't need). */
  ask(ctx: AppContext, action: LedgerAction, allowed: ReadonlySet<string> | null, opts: { notes: boolean }): LedgerQuestions
  /** Does what the answers say, in the caller's transaction. They were checked against `ask` just before. */
  apply(ctx: AppContext, ctxOf: CtxOf, action: LedgerAction, answers: LedgerAnswers, actor: ActivityActor): Applied
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "a", "a, and b", "a, b, and c". */
const list = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`)

const VERB: Record<LedgerAction, string> = { delete: 'delete', erase: 'erase', archive: 'archive' }

// Shared accounts ---------------------------------------------------------

const homeQuestion = (accountId: number) => `home:${accountId}`
const rowsQuestion = (accountId: number) => `rows:${accountId}`
const DELETE = 'delete'
const moveTo = (slug: string) => `move:${slug}`

/** A shared account this ledger has, as the questions need it. */
interface SharedAccount {
  id: number
  facts: AccountFacts
  /** Every ledger that has it, the home first. */
  ledgers: AccountLedger[]
  me: AccountLedger
  home: AccountLedger
  /** The other ledgers that can take its home or this ledger's rows: the ones that aren't archived. */
  takers: AccountLedger[]
  /** This ledger's live transactions on it, split rows included. */
  live: number
}

function sharedAccountsOf(ctx: AppContext): SharedAccount[] {
  return ctx.accountWide.sharedAccounts(ctx.ledger.id).map((id) => {
    const ledgers = ctx.accountWide.ledgers(id)
    return {
      id,
      facts: ctx.accountWide.account(id)!,
      ledgers,
      me: ledgers.find((l) => l.ledgerId === ctx.ledger.id)!,
      home: ledgers.find((l) => l.isHome)!,
      takers: ledgers.filter((l) => l.ledgerId !== ctx.ledger.id && !l.archived),
      live: ctx.accountWide.holdings(id, ctx.ledger.id).transactions,
    }
  })
}

/**
 * The accounts this ledger kept its rows on when it stopped sharing one, that go with it: each with
 * the account it was split off from and that one's home, where the bank ids must stay known. None
 * for one whose parent is gone, or is this ledger's own.
 */
function splitOffAccounts(ctx: AppContext): Array<{ id: number; name: string; parent: { id: number; name: string; home: AccountLedger } }> {
  return ctx.q.all<{ id: number; name: string }>('SELECT id, name FROM ledger_accounts WHERE ledger_id = @ledger AND home_ledger_id = @ledger AND split_from_id IS NOT NULL ORDER BY id').flatMap((a) => {
    const parent = ctx.accountWide.splitOffParent(a.id)
    if (!parent || parent.homeLedgerId === ctx.ledger.id) return []
    const home = ctx.accountWide.ledgers(parent.id).find((l) => l.isHome)!
    return [{ ...a, parent: { id: parent.id, name: parent.name, home } }]
  })
}

/** What happens to this ledger's rows on an account: they stay (archiving), go with it, or move to another ledger. */
type RowsChoice = 'stay' | 'delete' | { move: string }

/** This ledger's share of another ledger's split payment on an account: what goes back to that ledger when the share is deleted. */
interface Share {
  holderId: string
  date: ISODate
  amountMinor: number
}

/** What working out the parts needs of an account, read once. */
interface PartsModel {
  facts: AccountFacts
  today: ISODate
  /** It syncs from a bank, which takes up any difference with its balance at the next sync. */
  linked: boolean
  /** What each ledger holds, split at a date (as accountWide.held). */
  held: (split: ISODate | undefined) => Held[]
  shares: Share[]
  /** The account's total now: what the bank has, if it's synced and up to date. */
  totalMinor: number
}

function partsModel(ctx: AppContext, a: SharedAccount): PartsModel {
  const cache = new Map<string, Held[]>()
  const held = (split: ISODate | undefined) => {
    const key = split ?? ''
    if (!cache.has(key)) cache.set(key, ctx.accountWide.held(a.id, { split }))
    return cache.get(key)!
  }
  const mine = ctx.q.all<{ paymentId: number; date: ISODate; amountMinor: number }>(
    `SELECT t.split_of AS paymentId, t.date, t.amount_minor AS amountMinor FROM transactions t
     WHERE t.ledger_id = @ledger AND t.account_id = ? AND t.split_of IS NOT NULL AND t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM transactions p WHERE p.ledger_id = t.ledger_id AND p.id = t.split_of)`,
    a.id,
  )
  const holders = new Map(ctx.accountWide.splitShares(mine.map((m) => m.paymentId)).map((s) => [s.paymentId, s.holder.ledgerId]))
  const linked = !!ctx.app.db.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.accountId, a.id)).get()
  return {
    facts: a.facts,
    today: today(ctx),
    linked,
    held,
    shares: mine.map((m) => ({ holderId: holders.get(m.paymentId)!, date: m.date, amountMinor: m.amountMinor })),
    totalMinor: partsOf(a.facts, held(a.facts.recorded?.date)).totalMinor,
  }
}

/**
 * Each ledger's part of the account once `openingId` is its opening ledger and this ledger's rows
 * have done what `rows` says, worked out without changing anything: at once (`now`), and for a
 * synced account as if a sync had then run with the bank's balance unchanged (`synced`), which is
 * when the opening ledger takes up what went. Rows that are deleted leave the total. A share of
 * another ledger's payment that's deleted goes back to that ledger. Rows that move add to the
 * ledger they go to, whose own payment's share comes back to it the same way.
 */
function partsAfter(m: PartsModel, me: string, openingId: string, rows: RowsChoice): { now: Map<string, number>; synced: Map<string, number> } {
  const heldAfter = (split: ISODate | undefined) => {
    const held = m.held(split).map((h) => ({ ...h }))
    if (rows === 'stay') return held
    const mine = held.find((h) => h.ledgerId === me)!
    const rest = held.filter((h) => h !== mine)
    if (rows === 'delete') {
      for (const s of m.shares) {
        const holder = rest.find((h) => h.ledgerId === s.holderId)
        if (!holder) continue
        holder.totalMinor += s.amountMinor
        if (split !== undefined && s.date > split) holder.afterMinor += s.amountMinor
      }
    } else {
      const to = rest.find((h) => h.ledgerId === rows.move)!
      to.totalMinor += mine.totalMinor
      to.afterMinor += mine.afterMinor
    }
    return rest
  }
  const facts = { ...m.facts, openingLedgerId: openingId }
  const held = heldAfter(facts.recorded?.date)
  const now = partsOf(facts, held)
  let synced = now
  const gap = m.totalMinor - now.totalMinor
  if (m.linked && gap) {
    // As a sync does it: the bank's balance recorded today when balances are recorded on the account, else the opening balance takes the difference.
    if (!facts.recorded) synced = partsOf({ ...facts, openingBalanceMinor: facts.openingBalanceMinor + gap }, held)
    else if (m.today >= facts.recorded.date) synced = partsOf({ ...facts, recorded: { balanceMinor: m.totalMinor } }, heldAfter(m.today))
  }
  return { now: now.parts, synced: synced.parts }
}

/**
 * What the opening balance and the recorded balances add to the part of the ledger that carries
 * them, today: what the home's part gains when this ledger, the opening ledger, hands them over.
 */
function openingBase(m: PartsModel, me: string): number {
  const held = m.held(m.facts.recorded?.date)
  return (partsOf(m.facts, held).parts.get(me) ?? 0) - (held.find((h) => h.ledgerId === me)?.totalMinor ?? 0)
}

/**
 * The note under the question about this ledger's transactions on an account: for each choice, the
 * change in each other ledger's balance on it, by its direction (what a credit card's ledger owes
 * more or less), beyond what the opening balance going to the home
 * does (its notice has that). For a synced account it's as if a sync had then run with the bank
 * unchanged, which is when the opening ledger takes the difference: what changes at once and what
 * the sync then adds are both said, when they differ. While the new home is still to
 * be chosen and would also be the opening ledger, it's named "the new home", or each choice of home
 * is spelled out when they differ by more than that.
 */
function rowsNote(a: SharedAccount, m: PartsModel, options: Array<{ label: string; rows: RowsChoice }>): string {
  const others = a.ledgers.filter((l) => l !== a.me)
  const homes = a.me.isHome ? a.takers : [a.home]
  const effect = (home: AccountLedger, rows: RowsChoice, homeName: string) => {
    const openingId = a.me.isOpening ? home.ledgerId : a.facts.openingLedgerId
    const before = partsAfter(m, a.me.ledgerId, openingId, 'stay')
    const after = partsAfter(m, a.me.ledgerId, openingId, rows)
    const changed = others.flatMap((l) => {
      const now = (after.now.get(l.ledgerId) ?? 0) - (before.now.get(l.ledgerId) ?? 0)
      const synced = (after.synced.get(l.ledgerId) ?? 0) - (before.synced.get(l.ledgerId) ?? 0)
      if (!now && !synced) return []
      const who = l === home ? homeName : l.name
      if (synced === now) return [changeWords(who, now, a.facts)]
      return [now ? `${changeWords(who, now, a.facts)} now, and ${stepWords(synced - now, a.facts)} at the next sync` : `at the next sync, ${changeWords(who, synced, a.facts)}`]
    })
    return changed.length ? list(changed) : `no other ledger’s balance on ${a.facts.name} changes`
  }
  return options
    .map(({ label, rows }) => {
      // The same whichever ledger becomes the home, or the same but for its name, or spelled out for each.
      const each = homes.map((h) => effect(h, rows, h.name))
      if (each.every((text) => text === each[0])) return `${label}: ${each[0]}.`
      const general = homes.map((h) => effect(h, rows, 'the new home'))
      if (general.every((text) => text === general[0])) return `${label}: ${general[0]}.`
      return `${label}: ${homes.map((h, i) => `${i ? 'With' : 'with'} ${h.name} as the home, ${each[i]}.`).join(' ')}`
    })
    .join(' ')
}

/** The notice that the opening balance goes to the home, with what that adds to the home's balance today. */
function openingNotice(a: SharedAccount, baseMinor: number, home: LedgerName | null, done = false): string {
  const [move, shift] = done ? ['moved', 'shifted'] : ['move', 'shift']
  const who = home ? home.name : 'The new home'
  const change = baseMinor
    ? `${changeWords(who, baseMinor, a.facts, done)}${done ? '' : ' today'}`
    : `${who}’s balance on ${a.facts.name} ${done ? 'didn’t change' : 'doesn’t change today'}`
  return `${a.facts.name}’s opening balance and recorded balances ${move} to ${home ? home.name : 'its new home'}. ${change}, and earlier balances ${shift} too.`
}

const sharedAccounts: Topic = {
  ask(ctx, action, allowed, { notes }) {
    const asked: LedgerQuestions = { questions: [], notices: [], blockers: [] }
    const me = ctx.ledger.name
    for (const a of sharedAccountsOf(ctx)) {
      const name = a.facts.name
      // Applying the answers can write in any ledger that has the account (a detached split, the opening balance).
      if (allowed && a.ledgers.some((l) => !allowed.has(l.ledgerId))) {
        asked.blockers.push(`This key can’t use every ledger that has ${name}, so it can’t ${VERB[action]} ${me}. Do it in the app.`)
      }
      if (a.me.isHome) {
        if (!a.takers.length) {
          asked.blockers.push(`${name}’s home is ${me}, and every other ledger that has it is archived. Restore one of them, or stop sharing ${name}, first.`)
        } else {
          asked.questions.push({
            id: homeQuestion(a.id),
            text: `${name}’s home is ${me}. Which ledger becomes its home?`,
            note: 'New transactions from sync and CSV go to the new home. Nothing already recorded moves.',
            options: a.takers.map((l) => ({ value: l.slug, label: l.name })),
          })
        }
      }
      const model = notes && (a.me.isOpening || (action !== 'archive' && a.live)) ? partsModel(ctx, a) : null
      if (action !== 'archive' && a.live) {
        const them = a.live === 1 ? 'it' : 'them'
        const options: Array<LedgerQuestion['options'][number] & { rows: RowsChoice }> = [
          { value: DELETE, label: `Delete ${them}`, rows: 'delete' },
          ...a.takers.map((l) => ({ value: moveTo(l.slug), label: `Move to ${l.name}`, rows: { move: l.ledgerId } })),
        ]
        asked.questions.push({
          id: rowsQuestion(a.id),
          text: `${me} has ${count(a.live, 'transaction')} on ${name}. Delete ${them} or move ${them}?`,
          note: model && (!a.me.isHome || a.takers.length) ? rowsNote(a, model, options) : null,
          options: options.map(({ value, label }) => ({ value, label })),
        })
      }
      if (a.me.isOpening && model) {
        const homes = a.me.isHome ? a.takers : [a.home]
        if (homes.length) asked.notices.push(openingNotice(a, openingBase(model, a.me.ledgerId), homes.length === 1 ? homes[0]! : null))
      }
    }
    if (allowed && action !== 'archive') {
      for (const s of splitOffAccounts(ctx)) {
        if (allowed.has(s.parent.home.ledgerId)) continue
        asked.blockers.push(
          `${me}’s ${s.name} was split off from ${s.parent.home.name}’s ${s.parent.name}, which keeps its bank ids. This key can’t use ${s.parent.home.name}, so it can’t ${VERB[action]} ${me}. Do it in the app.`,
        )
      }
    }
    return asked
  },

  apply(ctx, ctxOf, action, answers, actor) {
    const changes: string[] = []
    const categorize = new Map<string, number[]>()
    const me = { slug: ctx.ledger.slug, name: ctx.ledger.name }
    const going = action !== 'archive'
    for (const a of sharedAccountsOf(ctx)) {
      const accountId = a.id
      const name = a.facts.name
      // What the opening balance adds to the home's part, read before anything changes: a home change changes no part.
      const baseMinor = a.me.isOpening ? openingBase(partsModel(ctx, a), a.me.ledgerId) : null

      // 1. The home.
      let homeLedger = a.home
      if (a.me.isHome) {
        homeLedger = a.takers.find((l) => l.slug === answers[homeQuestion(accountId)])!
        changeHome(ctx, ctxOf, accountId, homeLedger.ledgerId, actor)
        changes.push(`${homeLedger.name} is ${name}’s home now.`)
      }
      const home = ctxOf(homeLedger.ledgerId)
      const homeId = home.ledger.id

      let moved = 0
      let deleted = 0
      let bankIds = 0
      let target: AccountLedger | null = null
      if (going) {
        // 2. Its splits. A payment it holds has its split detached. Its share of another ledger's
        // payment goes back to that ledger when the share is deleted or goes there, and is detached otherwise.
        const answer = answers[rowsQuestion(accountId)]
        target = answer !== undefined && answer !== DELETE ? a.takers.find((l) => moveTo(l.slug) === answer)! : null
        const { splits } = leaveSplits(ctx, ctxOf, accountId, { shares: (holder) => (target && holder !== target.ledgerId ? 'detach' : 'drop'), actor })
        for (const s of splits) changes.push(splitNotice(me, s))

        // 3. Its rows. The ones it has only for their bank ids are the account's: they go home as they are.
        const each = (ids: number[], send: (chunk: number[]) => number) => {
          let sent = 0
          for (let i = 0; i < ids.length; i += MOVE_LIMIT) sent += send(ids.slice(i, i + MOVE_LIMIT))
          return sent
        }
        const known = ctx.q.column<number>('SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND bank_id_only = 1 ORDER BY id', accountId)
        each(known, (ids) => sendAsDeleted(ctx, ctxOf, { ids, to: homeId }))
        // The ones a person deleted that have a bank id go home, kept for it: the bank still sends
        // them. One the bank removed goes with the ledger: sent home it would pass for one a person
        // deleted, and the posted row that replaces it would stay deleted too.
        const gone = ctx.q.column<number>(
          'SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NOT NULL AND removed_at IS NULL AND external_id IS NOT NULL AND bank_id_only = 0 ORDER BY id',
          accountId,
        )
        bankIds += each(gone, (ids) => sendAsBankIds(ctx, ctxOf, { ids, to: homeId }))
        if (target) {
          const to = target.ledgerId
          for (const ids of moveChunks(ctx, accountId)) {
            const result = moveTransactions(ctx, ctxOf, { ids, to, defer: true }, actor)
            moved += result.moved
            categorize.set(to, [...(categorize.get(to) ?? []), ...result.deferred!])
          }
          if (moved) changes.push(`${me.name}’s ${count(moved, 'transaction')} on ${name} moved to ${target.name}.`)
        } else {
          deleted = ctx.q.pluck<number>('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NULL', accountId)!
          // The ones with a bank id go home, deleted and kept for it. The rest go with the ledger.
          const synced = ctx.q.column<number>(
            'SELECT id FROM transactions WHERE ledger_id = @ledger AND account_id = ? AND deleted_at IS NULL AND external_id IS NOT NULL ORDER BY id',
            accountId,
          )
          bankIds += each(synced, (ids) => sendAsBankIds(ctx, ctxOf, { ids, to: homeId }))
          if (deleted) changes.push(`${me.name}’s ${count(deleted, 'transaction')} on ${name} ${deleted === 1 ? 'was' : 'were'} deleted.`)
        }
        if (bankIds) {
          changes.push(`${name} keeps the bank ids of ${count(bankIds, 'transaction')} ${me.name} had, deleted, so a sync doesn’t add ${bankIds === 1 ? 'it' : 'them'} again.`)
        }
      }

      // 4. The opening balance, which the home takes.
      if (baseMinor !== null) {
        const { changes: n } = home.q.run('UPDATE accounts SET opening_ledger_id = NULL WHERE ledger_id = @ledger AND id = ?', accountId)
        if (n !== 1) throw new Error(`Expected to give account ${accountId}'s opening balance to its home, changed ${n}`)
        changes.push(openingNotice(a, baseMinor, homeLedger, true))
      }

      // Activity in the home, which keeps the account, and here.
      const after = {
        ...(going ? { rows: target ? { movedTo: target.slug } : deleted ? 'deleted' : null, moved, deleted, bankIds } : {}),
        ...(baseMinor === null ? {} : { openingBaseMinor: baseMinor }),
      }
      const done = { delete: 'was deleted', erase: 'was erased', archive: 'was archived' }[action]
      if (going) {
        recordActivity(home, actor, {
          action: 'stop_sharing',
          entity: 'account',
          entityId: accountId,
          summary: `${me.name} ${done}, so ${name} isn’t shared with it any more`,
          before: { ledger: me.slug },
          after,
        })
        recordActivity(ctx, actor, {
          action: 'stop_sharing',
          entity: 'account',
          entityId: accountId,
          summary: `This ledger ${done}, so it doesn’t have ${homeLedger.name}’s ${name} any more`,
          before: { home: homeLedger.slug },
          after,
        })
      } else if (baseMinor !== null) {
        recordActivity(home, actor, {
          action: 'update',
          entity: 'account',
          entityId: accountId,
          summary: `${me.name} ${done}, so ${name}’s opening balance and recorded balances are this ledger’s now`,
          before: { opening: me.slug },
          after,
        })
        recordActivity(ctx, actor, {
          action: 'update',
          entity: 'account',
          entityId: accountId,
          summary: `This ledger ${done}, so ${name}’s opening balance and recorded balances are ${homeLedger.name}’s now`,
          before: { opening: me.slug },
          after,
        })
      }
    }

    // The accounts it kept its rows on when it stopped sharing one: the account each was split off
    // from keeps their bank ids, or its sync would add them again once they're gone.
    if (going) {
      for (const s of splitOffAccounts(ctx)) {
        const left = leaveSplitOffBankIds(ctx, ctxOf, s.id)
        if (!left) continue
        const them = left === 1 ? 'it' : 'them'
        changes.push(`${s.parent.home.name}’s ${s.parent.name} keeps the bank ids of ${count(left, 'transaction')} on ${me.name}’s ${s.name}, so a sync doesn’t add ${them} again.`)
        recordActivity(ctxOf(s.parent.home.ledgerId), actor, {
          action: 'update',
          entity: 'account',
          entityId: s.parent.id,
          summary: `${me.name}’s ${s.name}, split off from ${s.parent.name}, went with it: ${s.parent.name} keeps the bank ids of its ${count(left, 'transaction')}`,
          after: { bankIds: left },
        })
      }
    }
    return { changes, categorize }
  },
}

// The process -------------------------------------------------------------

const TOPICS: readonly Topic[] = [sharedAccounts]

function ask(ctx: AppContext, action: LedgerAction, allowed: ReadonlySet<string> | null, opts: { notes: boolean }): LedgerQuestions {
  const all = TOPICS.map((t) => t.ask(ctx, action, allowed, opts))
  return { questions: all.flatMap((a) => a.questions), notices: all.flatMap((a) => a.notices), blockers: all.flatMap((a) => a.blockers) }
}

/**
 * What must be answered before this ledger is deleted, erased or archived (`questions`, each with
 * its options and a note on what each does), what the action does without a choice (`notices`),
 * and why it can't be done at all (`blockers`). `allowed` is the ledgers the caller may use, by id,
 * or null for all of them. All three are empty for a ledger that has nothing to ask about.
 */
export function questionsFor(ctx: AppContext, action: LedgerAction, allowed: ReadonlySet<string> | null): LedgerQuestions {
  return ask(ctx, action, allowed, { notes: true })
}

/**
 * Checks the answers against what's asked now: a 409 while something blocks the action or a
 * question has no answer, a 400 for an answer that isn't one of its question's options. Answers to
 * questions that aren't asked are ignored. Run it before the action's safety copy, and again in its
 * transaction (applyAnswers does).
 */
export function requireAnswers(ctx: AppContext, action: LedgerAction, answers: LedgerAnswers, allowed: ReadonlySet<string> | null): void {
  const asked = ask(ctx, action, allowed, { notes: false })
  if (asked.blockers.length || asked.questions.some((q) => answers[q.id] === undefined)) {
    throw new HTTPException(409, { message: 'Answer the questions first' })
  }
  for (const q of asked.questions) {
    if (!q.options.some((o) => o.value === answers[q.id])) badRequest(`“${answers[q.id]}” isn’t an answer to “${q.text}”`)
  }
}

/**
 * Does what the answers say, in the caller's transaction, before the action itself: the questions
 * are asked again there and the answers checked (requireAnswers), then each topic applies them.
 * For a shared account, in this order: the home change, when this ledger is its home. Then, when
 * the ledger is deleted or erased, its splits (a payment it holds has its split detached, and its
 * share of another ledger's payment goes back to that ledger, or is detached when its rows move
 * elsewhere), and its rows: moved to the ledger chosen, or deleted, the ones with a bank id going to
 * the home as rows kept only for it, as its deleted ones with a bank id always do. Then the opening
 * balance goes to the home, when this ledger carried it. Last, the accounts it kept its rows on when
 * it stopped sharing one leave their bank ids with the account they were split off from. Activity
 * in every ledger touched. Returns what was done, in words, and what to categorize once committed
 * (categorizeMoved).
 */
export function applyAnswers(
  ctx: AppContext,
  ctxOf: CtxOf,
  action: LedgerAction,
  answers: LedgerAnswers,
  opts: { allowed: ReadonlySet<string> | null; actor: ActivityActor },
): Applied {
  return ctx.q.transaction(() => {
    requireAnswers(ctx, action, answers, opts.allowed)
    const applied: Applied = { changes: [], categorize: new Map() }
    for (const topic of TOPICS) {
      const one = topic.apply(ctx, ctxOf, action, answers, opts.actor)
      applied.changes.push(...one.changes)
      for (const [ledgerId, ids] of one.categorize) applied.categorize.set(ledgerId, [...(applied.categorize.get(ledgerId) ?? []), ...ids])
    }
    return applied
  })
}

/**
 * After the action has committed, and never in a dry run: AI categorizes, in each ledger that took
 * this one's transactions, the ones that came to it uncategorized (when AI is on).
 */
export function categorizeMoved(ctxOf: CtxOf, applied: Applied): void {
  for (const [ledgerId, ids] of applied.categorize) {
    const to = ctxOf(ledgerId)
    if (ids.length && aiEnabled(to)) void categorizeUncategorized(to, { ids: [...new Set(ids)] })
  }
}
