import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../services/context'
import { eraseAll } from '../services/setup'
import { fullBackup, openStorage, type Storage } from '../storage'
import { categoryId, testLedger, testStorage } from '../test/helpers'
import { fillLedger, ledgerRowCounts, ledgerRows } from '../test/world'
import { DB_FILE } from './client'
import { safetyCopy } from './maintenance'

const dirs: string[] = []
const opened: Storage[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-maintenance-'))
  dirs.push(dir)
  return dir
}
function fileStorage(dir = tempDir()) {
  const storage = openStorage({ dataDir: dir })
  opened.push(storage)
  return storage
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** One of everything in a ledger (world.ts's fillLedger), written through its handle. */
function fullLedger(ctx: AppContext) {
  return fillLedger((sql, params = {}) => Number(ctx.q.run(sql, params).lastInsertRowid), {
    category: categoryId(ctx, 'Groceries'),
    offCategory: categoryId(ctx, 'Gifts'),
  })
}

/** A safety copy put back by hand, opened as the app opens it. */
function openCopy(dir: string, name: string) {
  const restored = tempDir()
  writeFileSync(path.join(restored, DB_FILE), readFileSync(path.join(dir, 'backups', name)))
  return fileStorage(restored)
}

describe('the safety copy', () => {
  it('is the whole database', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(b)
    const name = path.basename(safetyCopy(storage.sqlite, 'pre-erase-personal')!)
    expect(name).toMatch(/^pre-erase-personal-.*\.db$/)
    const copy = openCopy(dir, name)
    for (const id of [a.ledger.id, b.ledger.id]) expect(ledgerRows(copy.sqlite, id)).toEqual(ledgerRows(storage.sqlite, id))
  })

  it('is skipped inside a transaction, where a dry run runs, without throwing', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const copy = storage.sqlite.transaction(() => safetyCopy(storage.sqlite, 'pre-erase-personal'))()
    expect(copy).toBeNull()
    expect(existsSync(path.join(dir, 'backups'))).toBe(false)
  })

  it('is skipped for an in-memory database', () => {
    expect(safetyCopy(testStorage().sqlite, 'pre-erase-personal')).toBeNull()
  })
})

describe('erasing a ledger', () => {
  it('keeps its activity and ledger settings, and nothing of another ledger changes', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(b)
    a.q.run("INSERT INTO ledger_settings (ledger_id, key, value) VALUES (@ledger, 'reports.range', '\"6m\"')")
    const activity = ledgerRows(storage.sqlite, a.ledger.id).activity
    const before = ledgerRows(storage.sqlite, a.ledger.id)
    const bBefore = ledgerRows(storage.sqlite, b.ledger.id)

    const { backup } = eraseAll(storage, a)
    expect(backup).toMatch(/^pre-erase-personal-.*\.db$/)
    const after = ledgerRows(storage.sqlite, a.ledger.id)
    expect(after.activity).toEqual(activity)
    expect(after.ledger_settings).toEqual([expect.objectContaining({ key: 'reports.range', value: '"6m"' })])
    for (const [t, rs] of Object.entries(after)) if (t !== 'activity' && t !== 'ledger_settings') expect([t, rs.length]).toEqual([t, 0])
    expect(ledgerRows(storage.sqlite, b.ledger.id)).toEqual(bBefore)

    // Its copy is the whole database as it was.
    const copy = openCopy(dir, backup!)
    expect(ledgerRows(copy.sqlite, a.ledger.id)).toEqual(before)
    expect(ledgerRows(copy.sqlite, b.ledger.id)).toEqual(bBefore)
  })

  it('in a transaction (a dry run) takes no copy and doesn’t throw', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const a = storage.registry.defaultContext()
    fullLedger(a)
    const counts = ledgerRowCounts(storage.sqlite, a.ledger.id)
    const rolledBack = new Error('rolled back')
    expect(() =>
      storage.sqlite.transaction(() => {
        expect(eraseAll(storage, a)).toMatchObject({ backup: null })
        throw rolledBack
      })(),
    ).toThrow(rolledBack)
    expect(ledgerRowCounts(storage.sqlite, a.ledger.id)).toEqual(counts)
    expect(existsSync(path.join(dir, 'backups'))).toBe(false)
  })
})

describe('deleting a ledger', () => {
  it('leaves none of its rows, and its copy is the whole database as it was', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const a = storage.registry.defaultContext()
    const f = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(f)
    const fBefore = ledgerRows(storage.sqlite, f.ledger.id)
    const aBefore = ledgerRows(storage.sqlite, a.ledger.id)

    const { backup } = storage.registry.remove(f.ledger.id)
    expect(backup).toMatch(/^pre-delete-family-.*\.db$/)
    expect(readdirSync(path.join(dir, 'backups'))).toEqual([backup])
    expect(Object.entries(ledgerRowCounts(storage.sqlite, f.ledger.id)).filter(([, n]) => n > 0)).toEqual([])
    expect(storage.sqlite.prepare('SELECT count(*) FROM activity WHERE ledger_id = ?').pluck().get(f.ledger.id)).toBe(0)
    expect(ledgerRows(storage.sqlite, a.ledger.id)).toEqual(aBefore)

    const copy = openCopy(dir, backup!)
    expect(copy.registry.find(f.ledger.id)).toBeDefined()
    expect(ledgerRows(copy.sqlite, f.ledger.id)).toEqual(fBefore)
    expect(ledgerRows(copy.sqlite, a.ledger.id)).toEqual(aBefore)
  })

  it('in a transaction (a dry run) takes no copy and doesn’t throw', () => {
    const dir = tempDir()
    const storage = fileStorage(dir)
    const f = testLedger(storage, 'Family')
    fullLedger(f)
    const rolledBack = new Error('rolled back')
    expect(() =>
      storage.sqlite.transaction(() => {
        expect(storage.registry.remove(f.ledger.id)).toMatchObject({ backup: null })
        throw rolledBack
      })(),
    ).toThrow(rolledBack)
    expect(storage.registry.find(f.ledger.id)).toBeDefined()
    expect(existsSync(path.join(dir, 'backups'))).toBe(false)
  })
})

describe('the full backup', () => {
  it('is the whole database, and opens as it was', () => {
    const storage = testStorage()
    const a = storage.registry.defaultContext()
    const b = testLedger(storage, 'Family')
    fullLedger(a)
    fullLedger(b)
    const { bytes } = fullBackup(storage)
    const files = unzipSync(bytes)
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
    expect(manifest).toMatchObject({ format: 2, secretKey: expect.stringMatching(/secret\.key/) })
    expect(manifest.restore).toMatch(/-wal/)

    const dir = tempDir()
    writeFileSync(path.join(dir, DB_FILE), files[DB_FILE]!)
    const copy = fileStorage(dir)
    expect(copy.registry.list().map((l) => [l.id, l.name, l.accounts, l.transactions])).toEqual(storage.registry.list().map((l) => [l.id, l.name, l.accounts, l.transactions]))
    for (const id of [a.ledger.id, b.ledger.id]) expect(ledgerRows(copy.sqlite, id)).toEqual(ledgerRows(storage.sqlite, id))
  })
})
