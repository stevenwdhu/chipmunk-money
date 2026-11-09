import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Encrypts secrets kept in meta.db (bank access) with AES-256-GCM. The key lives in its own file,
 * `data/secret.key`, which backups leave out, so a copied database or full-backup zip can't be used
 * to reach your bank data on its own.
 */
export class SecretBox {
  constructor(
    private key: Buffer,
    /** True when the key file didn't exist and was made just now. */
    readonly created = false,
  ) {
    if (key.length !== 32) throw new Error('The secret key must be 32 bytes')
  }

  /** The key in `<dataDir>/secret.key`, created on first use; an in-memory key without a data directory. */
  static forDataDir(dataDir: string | null): SecretBox {
    if (!dataDir) return new SecretBox(randomBytes(32))
    const file = path.join(dataDir, 'secret.key')
    const created = !existsSync(file)
    if (created) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' })
    }
    try {
      chmodSync(file, 0o600)
    } catch {
      // Not every filesystem supports modes.
    }
    return new SecretBox(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'), created)
  }

  seal(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(':')
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognized secret format')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
  }
}

/** How many of these stored values are sealed with another key, so this one can't open them. */
export function countUnreadable(box: SecretBox, values: Array<string | null | undefined>): number {
  let unreadable = 0
  for (const value of values) {
    for (const sealed of value?.match(/v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g) ?? []) {
      try {
        box.open(sealed)
      } catch {
        unreadable++
      }
    }
  }
  return unreadable
}
