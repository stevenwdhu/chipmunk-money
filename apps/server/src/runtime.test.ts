import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshotDb } from './db/client'
import { startBankSync, startJobs } from './jobs'
import { countUnreadable, SecretBox, WrongSecretKeyError } from './lib/secrets'
import { createPlaid } from './services/bank/plaid'
import type { BankService } from './services/bank/service'
import { createSimpleFin } from './services/bank/simplefin'
import { createWealthsimple } from './services/bank/wealthsimple'
import { chatgptModels } from './services/chatgpt'
import { setAppSetting } from './services/settings'
import { openStorage, type Storage } from './storage'
import { testStorage } from './test/helpers'

const dirs: string[] = []
const opened: Storage[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-runtime-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const mode = (file: string) => statSync(file).mode & 0o777

describe.skipIf(process.platform === 'win32')('file permissions', () => {
  it('keeps the data directory, the database, backups and snapshots to their owner', () => {
    const dataDir = path.join(tempDir(), 'data')
    const storage = openStorage({ dataDir })
    opened.push(storage)
    const snapshot = snapshotDb(storage.sqlite, 'test')!

    expect(mode(dataDir)).toBe(0o700)
    expect(mode(path.join(dataDir, 'backups'))).toBe(0o700)
    expect(mode(path.join(dataDir, 'chipmunk.db'))).toBe(0o600)
    expect(mode(path.join(dataDir, 'secret.key'))).toBe(0o600)
    expect(mode(snapshot)).toBe(0o600)
    // A real copy, not just the empty placeholder.
    expect(statSync(snapshot).size).toBeGreaterThan(0)
  })
})

describe('secret key', () => {
  it('says when the key file was made just now', () => {
    const dir = tempDir()
    expect(SecretBox.forDataDir(dir).created).toBe(true)
    expect(SecretBox.forDataDir(dir).created).toBe(false)
  })

  it('counts stored secrets that the current key cannot open', () => {
    const old = new SecretBox(Buffer.alloc(32, 1))
    const current = new SecretBox(Buffer.alloc(32, 2))
    const stored = [
      old.seal('bank access'),
      JSON.stringify({ provider: 'openai', apiKey: old.seal('sk-test') }),
      JSON.stringify(current.seal('still readable')),
      '"just a setting"',
      null,
    ]
    expect(countUnreadable(current, stored)).toBe(2)
    expect(countUnreadable(old, stored)).toBe(1)
  })

  it('says a secret sealed with another key was saved with a different secret.key', () => {
    const sealed = new SecretBox(Buffer.alloc(32, 1)).seal('bank access')
    expect(() => new SecretBox(Buffer.alloc(32, 2)).open(sealed)).toThrow(WrongSecretKeyError)
    expect(() => new SecretBox(Buffer.alloc(32, 2)).open(sealed)).toThrow(/different secret\.key/)
  })
})

describe('background jobs', () => {
  it('logs a failing daily run instead of throwing', () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = testStorage()
    opened.push(storage)
    vi.spyOn(storage.registry, 'list').mockImplementation(() => {
      throw new Error('disk gone')
    })
    const stop = startJobs(storage)
    expect(() => vi.advanceTimersByTime(3_000)).not.toThrow()
    expect(error).toHaveBeenCalledWith('[jobs] daily maintenance failed', expect.any(Error))
    // Tried again on the next tick, not only tomorrow.
    vi.advanceTimersByTime(10 * 60_000)
    expect(error).toHaveBeenCalledTimes(2)
    stop()
  })

  it('logs a failing bank sync check instead of rejecting', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bank = {
      due: () => {
        throw new Error('meta.db is locked')
      },
    } as unknown as BankService
    const stop = startBankSync(bank)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(error).toHaveBeenCalledWith('[bank] sync check failed', expect.any(Error))
    stop()
  })
})

describe('request timeouts', () => {
  /** A fetch that records its signal and then gives up the way AbortSignal.timeout does. */
  function timingOut() {
    const signals: Array<AbortSignal | null | undefined> = []
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal)
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as typeof globalThis.fetch
    return { fetch, signals }
  }
  const base = { timeZone: () => 'America/Toronto', now: () => new Date('2026-10-03T18:00:00Z') }

  it('gives up on Plaid with a clear error', async () => {
    const { fetch, signals } = timingOut()
    const plaid = createPlaid({ ...base, fetch, credentials: () => ({ clientId: 'id', secret: 'secret', environment: 'sandbox' }) })
    await expect(plaid.fetchAccounts('access-sandbox-1')).rejects.toThrow("Plaid didn't answer within 30 seconds")
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('gives up on SimpleFIN with a clear error', async () => {
    const { fetch, signals } = timingOut()
    const simplefin = createSimpleFin({ ...base, fetch })
    await expect(simplefin.fetchAccounts('https://user:pass@bridge.example/simplefin', {})).rejects.toThrow("SimpleFIN didn't answer within 30 seconds")
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('gives up on Wealthsimple with a clear error', async () => {
    const { fetch, signals } = timingOut()
    const ws = createWealthsimple({ ...base, fetch })
    const session = { refreshToken: 'r', clientId: 'c' } as Parameters<typeof ws.refresh>[0]
    await expect(ws.refresh(session)).rejects.toThrow("Wealthsimple didn’t answer within 30 seconds")
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('gives up on OpenAI with a clear error', async () => {
    const { fetch, signals } = timingOut()
    const storage = testStorage({ fetch })
    opened.push(storage)
    const session = {
      hostId: 'h',
      clientId: 'c',
      idToken: null,
      email: null,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['chatgpt.tokens.use.direct'],
    }
    setAppSetting(storage.app, 'chatgpt.session', storage.secrets.seal(JSON.stringify(session)))
    await expect(chatgptModels(storage.app)).rejects.toThrow('OpenAI didn’t answer within 30 seconds')
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })
})
