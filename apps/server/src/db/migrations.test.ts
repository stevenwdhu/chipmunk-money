import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { APPLICATION_ID, openDatabase, shippedMigrations } from './client'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function tempFile(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-migrations-'))
  dirs.push(dir)
  return path.join(dir, name)
}

describe('openDatabase', () => {
  it('makes a new file with incremental auto-vacuum, its application id and WAL, and no snapshot', () => {
    const file = tempFile('chipmunk.db')
    const { sqlite } = openDatabase(file)
    expect(sqlite.pragma('auto_vacuum', { simple: true })).toBe(2)
    expect(sqlite.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    sqlite.close()
    expect(existsSync(path.join(path.dirname(file), 'backups'))).toBe(false)

    // Opening it again runs nothing new.
    const again = openDatabase(file).sqlite
    expect(again.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(1)
    again.close()
  })

  it("refuses a file that isn't a Chipmunk database", () => {
    const file = tempFile('chipmunk.db')
    const other = new Database(file)
    other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)')
    other.close()
    expect(() => openDatabase(file)).toThrow("isn't a Chipmunk database")
  })

  it('refuses a database from before the baseline', () => {
    const file = tempFile('chipmunk.db')
    openDatabase(file).sqlite.close()
    const old = new Database(file)
    old.prepare('UPDATE __drizzle_migrations SET created_at = ?').run(shippedMigrations().first - 1000)
    old.close()
    expect(() => openDatabase(file)).toThrow("is from an older version of Chipmunk that this one can't upgrade")
  })

  it('opens an empty file as a new database', () => {
    const file = tempFile('chipmunk.db')
    writeFileSync(file, '')
    const { sqlite } = openDatabase(file)
    expect(sqlite.pragma('auto_vacuum', { simple: true })).toBe(2)
    sqlite.close()
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith('.db'))).toEqual(['chipmunk.db'])
  })
})
