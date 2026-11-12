import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiKeyCreated } from '@chipmunk/shared'
import { createApp } from './app'
import { DB_FILE } from './db/client'
import type { AppContext } from './services/context'
import { moveTransactions } from './services/moves'
import { setAppSetting } from './services/settings'
import { addMember } from './services/sharing'
import { openStorage, type Storage } from './storage'
import { categoryId, makeAccount, testLedger, testStorage } from './test/helpers'
import { expectNoCrossLedgerReferences, expectPartsSumToAccount, TESTER } from './test/shared-accounts'
import { ledgerRows } from './test/world'

/**
 * Deleting, erasing and archiving a ledger that has a shared account, over HTTP: what's asked
 * first, the answers, the dry runs and the safety copy. Personal is Visa's home, and Family and
 * Trip have it. Visa opens at −$1,000.00. Personal holds −$280.00 on it, Family −$420.00 (moved
 * there from Personal) and Trip −$50.00: −$1,750.00 in all.
 */

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const dirs: string[] = []
const opened: Storage[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(opts: { files?: boolean } = {}) {
  const now = new Date('2026-10-03T18:00:00Z')
  let dir: string | null = null
  let storage: Storage
  if (opts.files) {
    dir = mkdtempSync(path.join(tmpdir(), 'st-questions-'))
    dirs.push(dir)
    storage = openStorage({ dataDir: dir, now: () => now })
    opened.push(storage)
    setAppSetting(storage.app, 'timezone', 'America/Toronto')
  } else {
    storage = testStorage()
  }
  const personal = storage.registry.defaultContext()
  const family = testLedger(storage, 'Family')
  const trip = testLedger(storage, 'Trip')
  const visa = makeAccount(personal, 'Visa', 'credit', -100_000, 'TD')
  for (const c of [family, trip]) addMember(personal, storage.ctxOf, visa, c.ledger.id, TESTER)
  const spentIn = (to: AppContext, date: string, amount: number) => {
    const id = Number(
      personal.q.run(
        `INSERT INTO transactions (ledger_id, account_id, date, amount_minor, payee, payee_key, category_id, category_source)
         VALUES (@ledger, ?, ?, ?, 'Shop', 'shop', ?, 'user')`,
        visa,
        date,
        amount,
        categoryId(personal, 'Groceries'),
      ).lastInsertRowid,
    )
    if (to !== personal) moveTransactions(personal, storage.ctxOf, { ids: [id], to: to.ledger.id }, TESTER)
  }
  spentIn(personal, '2026-08-05', -20_000)
  spentIn(family, '2026-08-10', -30_000)
  spentIn(trip, '2026-08-12', -5_000)
  spentIn(family, '2026-09-15', -12_000)
  spentIn(personal, '2026-09-20', -8_000)

  const app = createApp(storage, { trustedHeader: null })
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${url}`, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as Json }
  }
  const key = async (input: { scopes: string[]; ledgers?: string[] }) => {
    const res = await call('POST', '/api-keys', { name: `${input.scopes.join('+')} ${input.ledgers?.join('+') ?? 'all'}`, ...input })
    expect(res.status).toBe(201)
    return { authorization: `Bearer ${(res.body as ApiKeyCreated).key}`, 'sec-fetch-site': 'none' }
  }
  const parts = () => {
    expectNoCrossLedgerReferences(storage)
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([])
    return expectPartsSumToAccount(storage, visa).parts
  }
  /** Every ledger's rows, the ledgers themselves, and the app's default ledger. */
  const everything = () => [[personal, family, trip].map((c) => ledgerRows(storage.sqlite, c.ledger.id)), storage.registry.list()]
  const backups = () => (dir && existsSync(path.join(dir, 'backups')) ? readdirSync(path.join(dir, 'backups')) : [])
  const answers = (a: { home?: string; rows?: string }) => Object.fromEntries(Object.entries(a).map(([k, v]) => [`${k}:${visa}`, v]))
  return { storage, personal, family, trip, visa, call, key, parts, everything, backups, answers }
}

const ASK = { error: { code: 'conflict', message: 'Answer the questions first' } }

describe('GET /ledgers/:ledger/questions', () => {
  it('says what’s asked for each action, and needs an admin key', async () => {
    const w = setup()
    const res = await w.call('GET', '/ledgers/personal/questions?action=delete')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      questions: [
        {
          id: `home:${w.visa}`,
          text: 'Visa’s home is Personal. Which ledger becomes its home?',
          note: 'New transactions from sync and CSV go to the new home. Nothing already recorded moves.',
          options: [
            { value: 'family', label: 'Family' },
            { value: 'trip', label: 'Trip' },
          ],
        },
        {
          id: `rows:${w.visa}`,
          text: 'Personal has 2 transactions on Visa. Delete them or move them?',
          note: 'Delete them: no other ledger’s balance on Visa changes. Move to Family: Family owes $280.00 more on Visa. Move to Trip: Trip owes $280.00 more on Visa.',
          options: [
            { value: 'delete', label: 'Delete them' },
            { value: 'move:family', label: 'Move to Family' },
            { value: 'move:trip', label: 'Move to Trip' },
          ],
        },
      ],
      notices: ['Visa’s opening balance and recorded balances move to its new home. The new home owes $1,000.00 more on Visa today, and earlier balances shift too.'],
      blockers: [],
    })
    expect((await w.call('GET', '/ledgers/personal/questions?action=archive')).body.questions.map((q: Json) => q.id)).toEqual([`home:${w.visa}`])
    expect((await w.call('GET', '/ledgers/family/questions?action=erase')).body.questions.map((q: Json) => q.id)).toEqual([`rows:${w.visa}`])
    expect((await w.call('GET', '/ledgers/family/questions?action=archive')).body).toEqual({ questions: [], notices: [], blockers: [] })
    expect((await w.call('GET', '/ledgers/personal/questions')).status).toBe(400)
    expect((await w.call('GET', '/ledgers/personal/questions?action=rename')).status).toBe(400)
    expect((await w.call('GET', '/ledgers/family/questions?action=delete', undefined, await w.key({ scopes: ['write'] }))).status).toBe(403)
    expect((await w.call('GET', '/ledgers/family/questions?action=delete', undefined, await w.key({ scopes: ['admin'] }))).body.blockers).toEqual([])
  })

  it('blocks a key that can’t use every ledger that has the account, which is then refused', async () => {
    const w = setup()
    const some = await w.key({ scopes: ['admin'], ledgers: ['personal', 'family'] })
    const asked = await w.call('GET', '/ledgers/family/questions?action=delete', undefined, some)
    expect(asked.body.blockers).toEqual(['This key can’t use every ledger that has Visa, so it can’t delete Family. Do it in the app.'])
    const before = w.everything()
    const rows = w.answers({ rows: 'delete' })
    expect(await w.call('DELETE', '/ledgers/family', { confirm: 'Family', answers: rows }, some)).toEqual({ status: 409, body: ASK })
    expect(await w.call('POST', '/ledgers/family/erase', { confirm: 'erase', answers: rows }, some)).toEqual({ status: 409, body: ASK })
    expect(await w.call('PATCH', '/ledgers/family', { archived: true }, some)).toEqual({ status: 409, body: ASK })
    expect((await w.call('DELETE', '/ledgers/family?dryRun=true', { confirm: 'Family', answers: rows }, some)).status).toBe(409)
    // A ledger the key can't use at all is refused before anything is asked.
    expect((await w.call('GET', '/ledgers/trip/questions?action=delete', undefined, some)).status).toBe(403)
    expect(w.everything()).toEqual(before)

    const every = await w.key({ scopes: ['admin'], ledgers: ['personal', 'family', 'trip'] })
    expect((await w.call('GET', '/ledgers/family/questions?action=delete', undefined, every)).body.blockers).toEqual([])
    const done = await w.call('DELETE', '/ledgers/family', { confirm: 'Family', answers: rows }, every)
    expect(done).toEqual({ status: 200, body: { backup: null, changes: ['Family’s 2 transactions on Visa were deleted.', 'Family and all its data were deleted.'], dryRun: false } })
    expect(w.parts()).toEqual({ personal: -128_000, trip: -5_000 })
  })
})

describe('the three actions over HTTP', () => {
  it('refuse without the answers (409) or with one that isn’t an option (400), and change nothing', async () => {
    const w = setup()
    const before = w.everything()
    const bad = (message: string) => ({ status: 400, body: { error: { code: 'bad_request', message } } })
    for (const dry of ['', '?dryRun=true']) {
      expect(await w.call('DELETE', `/ledgers/personal${dry}`, { confirm: 'Personal' })).toEqual({ status: 409, body: ASK })
      expect(await w.call('DELETE', `/ledgers/personal${dry}`, { confirm: 'Personal', answers: w.answers({ home: 'family' }) })).toEqual({ status: 409, body: ASK })
      expect(await w.call('DELETE', `/ledgers/personal${dry}`, { confirm: 'Personal', answers: w.answers({ home: 'family', rows: 'keep' }) })).toEqual(
        bad('“keep” isn’t an answer to “Personal has 2 transactions on Visa. Delete them or move them?”'),
      )
      expect(await w.call('POST', `/ledgers/family/erase${dry}`, { confirm: 'erase' })).toEqual({ status: 409, body: ASK })
      expect(await w.call('POST', `/ledgers/family/erase${dry}`, { confirm: 'erase', answers: w.answers({ rows: 'move:family' }) })).toEqual(
        bad('“move:family” isn’t an answer to “Family has 2 transactions on Visa. Delete them or move them?”'),
      )
      expect(await w.call('PATCH', `/ledgers/personal${dry}`, { archived: true })).toEqual({ status: 409, body: ASK })
      expect(await w.call('PATCH', `/ledgers/personal${dry}`, { archived: true, answers: w.answers({ home: 'personal' }) })).toEqual(
        bad('“personal” isn’t an answer to “Visa’s home is Personal. Which ledger becomes its home?”'),
      )
    }
    // The name and the word are still asked for.
    expect((await w.call('DELETE', '/ledgers/family', { confirm: 'family', answers: w.answers({ rows: 'delete' }) })).status).toBe(400)
    expect((await w.call('POST', '/ledgers/family/erase', { confirm: 'yes', answers: w.answers({ rows: 'delete' }) })).status).toBe(400)
    expect(w.everything()).toEqual(before)
  })

  it('delete the home with its answers, and say what was done', async () => {
    const w = setup()
    const res = await w.call('DELETE', '/ledgers/personal', { confirm: 'Personal', answers: w.answers({ home: 'family', rows: 'move:trip' }) })
    expect(res).toEqual({
      status: 200,
      body: {
        backup: null,
        changes: [
          'Family is Visa’s home now.',
          'Personal’s 2 transactions on Visa moved to Trip.',
          'Visa’s opening balance and recorded balances moved to Family. Family owes $1,000.00 more on Visa, and earlier balances shifted too.',
          'Personal and all its data were deleted.',
        ],
        dryRun: false,
      },
    })
    expect((await w.call('GET', '/ledgers')).body.map((l: Json) => l.slug)).toEqual(['family', 'trip'])
    // Family −420 − 1,000. Trip −50 − 280.
    expect(w.parts()).toEqual({ family: -142_000, trip: -33_000 })
    expect((await w.call('GET', `/ledgers/family/accounts/${w.visa}`)).body).toMatchObject({ balanceMinor: -142_000, sharing: { isHome: true, opening: { slug: 'family' }, totalBalanceMinor: -175_000 } })
    // Who did it is in the activity of the ledgers that are left.
    expect(w.family.q.column("SELECT actor FROM activity WHERE ledger_id = @ledger AND action IN ('change_home', 'stop_sharing')")).toEqual(['web', 'web'])
  })

  it('erase a ledger the account is shared with, with its answer', async () => {
    const w = setup()
    const res = await w.call('POST', '/ledgers/family/erase', { confirm: 'erase', answers: w.answers({ rows: 'move:personal' }) })
    expect(res).toEqual({ status: 200, body: { backup: null, changes: ['Family’s 2 transactions on Visa moved to Personal.', 'Family’s data was erased.'], dryRun: false } })
    expect(w.parts()).toEqual({ personal: -170_000, trip: -5_000 })
    expect((await w.call('GET', '/ledgers/family/accounts')).body).toEqual([])
    expect((await w.call('GET', '/ledgers/family/activity?limit=1')).body.items[0]).toMatchObject({ action: 'erase', summary: 'Erased all data' })
    // Nothing is asked of it now.
    expect((await w.call('POST', '/ledgers/family/erase', { confirm: 'erase' })).body).toEqual({ backup: null, changes: ['Family’s data was erased.'], dryRun: false })
  })

  it('archive the home with its answer, and restore it with none', async () => {
    const w = setup()
    const res = await w.call('PATCH', '/ledgers/personal', { archived: true, answers: w.answers({ home: 'trip' }) })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      slug: 'personal',
      archived: true,
      isDefault: false,
      accounts: 1,
      changes: [
        'Trip is Visa’s home now.',
        'Visa’s opening balance and recorded balances moved to Trip. Trip owes $1,000.00 more on Visa, and earlier balances shifted too.',
        'Personal was archived.',
      ],
      dryRun: false,
    })
    expect(w.parts()).toEqual({ trip: -105_000, personal: -28_000, family: -42_000 })
    // A change that archives nothing has nothing to say, and restoring asks nothing.
    expect((await w.call('PATCH', '/ledgers/family', { color: '#16a34a' })).body).toMatchObject({ color: '#16a34a', changes: [], dryRun: false })
    expect((await w.call('PATCH', '/ledgers/personal', { archived: false })).body).toMatchObject({ archived: false, changes: [] })
    expect((await w.call('PATCH', '/ledgers/family', { archived: true })).body).toMatchObject({ archived: true, changes: ['Family was archived.'] })
    expect(w.parts()).toEqual({ trip: -105_000, personal: -28_000, family: -42_000 })
  })
})

describe('dry runs and the safety copy', () => {
  it('answer 200 with what would be done, change nothing, and write no file', async () => {
    const w = setup({ files: true })
    const before = w.everything()
    const deleted = await w.call('DELETE', '/ledgers/personal?dryRun=true', { confirm: 'Personal', answers: w.answers({ home: 'family', rows: 'delete' }) })
    expect(deleted).toEqual({
      status: 200,
      body: {
        backup: null,
        changes: [
          'Family is Visa’s home now.',
          'Personal’s 2 transactions on Visa were deleted.',
          'Visa’s opening balance and recorded balances moved to Family. Family owes $1,000.00 more on Visa, and earlier balances shifted too.',
          'Personal and all its data were deleted.',
        ],
        dryRun: true,
      },
    })
    const erased = await w.call('POST', '/ledgers/family/erase?dryRun=true', { confirm: 'erase', answers: w.answers({ rows: 'move:trip' }) })
    expect(erased).toEqual({ status: 200, body: { backup: null, changes: ['Family’s 2 transactions on Visa moved to Trip.', 'Family’s data was erased.'], dryRun: true } })
    const archived = await w.call('PATCH', '/ledgers/personal?dryRun=true', { archived: true, answers: w.answers({ home: 'family' }) })
    expect(archived.status).toBe(200)
    expect(archived.body).toMatchObject({ archived: true, dryRun: true, changes: [expect.any(String), expect.any(String), 'Personal was archived.'] })

    expect(w.everything()).toEqual(before)
    expect(w.parts()).toEqual({ personal: -128_000, family: -42_000, trip: -5_000 })
    expect(w.backups()).toEqual([])
    expect(w.storage.sqlite.inTransaction).toBe(false)
  })

  it('take the copy before the real action, of the database as it was', async () => {
    const w = setup({ files: true })
    const erased = await w.call('POST', '/ledgers/family/erase', { confirm: 'erase', answers: w.answers({ rows: 'delete' }) })
    expect(erased.status).toBe(200)
    expect(erased.body.backup).toMatch(/^pre-erase-family-.*\.db$/)
    const deleted = await w.call('DELETE', '/ledgers/personal', { confirm: 'Personal', answers: w.answers({ home: 'trip', rows: 'delete' }) })
    expect(deleted.status).toBe(200)
    expect(deleted.body.backup).toMatch(/^pre-delete-personal-.*\.db$/)
    expect(w.backups().sort()).toEqual([deleted.body.backup, erased.body.backup].sort())
    // The first copy still has Family's rows on Visa, the second Personal as Visa's home.
    const copy = (name: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'st-questions-copy-'))
      dirs.push(dir)
      copyFileSync(path.join(path.dirname(w.storage.sqlite.name), 'backups', name), path.join(dir, DB_FILE))
      const storage = openStorage({ dataDir: dir })
      opened.push(storage)
      return storage
    }
    const first = copy(erased.body.backup)
    expect(first.registry.context('family').q.pluck('SELECT count(*) FROM transactions WHERE ledger_id = @ledger AND account_id = ?', w.visa)).toBe(2)
    const second = copy(deleted.body.backup)
    expect(second.registry.context('personal').accountWide.ledgers(w.visa).map((l) => [l.slug, l.isHome])).toEqual([
      ['personal', true],
      ['trip', false],
    ])
    // Archiving takes none.
    expect((await w.call('PATCH', '/ledgers/family', { archived: true })).status).toBe(200)
    expect(w.backups()).toHaveLength(2)
    expect(w.parts()).toEqual({ trip: -105_000 })
  })
})
