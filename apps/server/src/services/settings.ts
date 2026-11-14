import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import {
  AI_KINDS,
  DEFAULT_SYNC_HOURS,
  aiProviderInfo,
  isValidTimeZone,
  normalizeColumns,
  PLAID_ENVIRONMENTS,
  RECURRING_DETECTION,
  SIDEBAR_WIDTH,
  SYNC_INTERVALS,
  TRANSACTION_COLUMNS,
  todayInTz,
  type AiKind,
  type AiProviderPublic,
  type BankProviderKind,
  type PlaidEnvironment,
  type PlaidPublic,
  type Settings,
  type SettingsUpdate,
} from '@chipmunk/shared'
import { appSettings as metaSettings, bankConnections } from '../db/schema'
import type { AppContext, MetaStore } from './context'

export interface StoredAiConfig {
  kind: AiKind
  model: string
  baseUrl: string | null
  /** The key itself here; in app_settings it's encrypted (see openStored). */
  apiKey: string | null
}

export type AiSlot = 'primary' | 'fallback'

/** Settings that belong to the whole app (in app_settings), not to one ledger. */
export const APP_SETTING_KEYS = ['timezone', 'firstDayOfWeek', 'ai.primary', 'ai.fallback'] as const

export function systemTimezone(): string {
  const tz = process.env.TZ
  if (tz && isValidTimeZone(tz)) return tz
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

// App-wide settings (app_settings) ---------------------------------------------

export function getAppSetting<T>(meta: MetaStore, key: string, fallback: T): T {
  const row = meta.db.select().from(metaSettings).where(eq(metaSettings.key, key)).get()
  return row ? (row.value as T) : fallback
}

export function setAppSetting(meta: MetaStore, key: string, value: unknown) {
  if (value === null || value === undefined) {
    meta.db.delete(metaSettings).where(eq(metaSettings.key, key)).run()
    return
  }
  meta.db
    .insert(metaSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: metaSettings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run()
}

// Per-ledger settings (ledger_settings) ----------------------------------------------

export function getLedgerSetting<T>(ctx: AppContext, key: string, fallback: T): T {
  const value = ctx.q.pluck<string>('SELECT value FROM ledger_settings WHERE ledger_id = @ledger AND key = @key', { key })
  return value === undefined ? fallback : (JSON.parse(value) as T)
}

export function setLedgerSetting(ctx: AppContext, key: string, value: unknown) {
  if (value === null || value === undefined) {
    ctx.q.run('DELETE FROM ledger_settings WHERE ledger_id = @ledger AND key = @key', { key })
    return
  }
  ctx.q.run(
    `INSERT INTO ledger_settings (ledger_id, key, value) VALUES (@ledger, @key, @value)
     ON CONFLICT (ledger_id, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    { key, value: JSON.stringify(value) },
  )
}

// Secrets at rest ---------------------------------------------------------------
// API keys and Plaid's secret are encrypted in app_settings with data/secret.key, like bank access, so a
// copied database or backup zip doesn't give them away.

const isSealed = (value: string) => /^v1:[^:]+:[^:]+:[^:]+$/.test(value)
const seal = (meta: MetaStore, plain: string | null) => (plain ? meta.secrets.seal(plain) : null)

/**
 * A stored secret, decrypted. One saved before secrets were encrypted is read as it is; one that
 * can't be decrypted (the database copied without its secret.key) reads as missing, so you're asked again.
 */
function openStored(meta: MetaStore, stored: string | null | undefined): string | null {
  if (!stored) return null
  if (!isSealed(stored)) return stored
  try {
    return meta.secrets.open(stored)
  } catch {
    return null
  }
}

/** Encrypts AI keys saved before keys were encrypted. Runs at startup. */
export function sealStoredSecrets(meta: MetaStore) {
  for (const slot of ['primary', 'fallback'] as const) {
    const cfg = getAppSetting<StoredAiConfig | null>(meta, `ai.${slot}`, null)
    if (cfg?.apiKey && !isSealed(cfg.apiKey)) setAppSetting(meta, `ai.${slot}`, { ...cfg, apiKey: seal(meta, cfg.apiKey) })
  }
}

// Derived values --------------------------------------------------------------

export function effectiveTimezone(meta: MetaStore): string {
  const tz = getAppSetting<string | null>(meta, 'timezone', null)
  return tz && isValidTimeZone(tz) ? tz : systemTimezone()
}

export function today(ctx: Pick<AppContext, 'meta' | 'now'>): string {
  return todayInTz(effectiveTimezone(ctx.meta), ctx.now())
}

/**
 * What's wrong with the AI_* and PLAID_ENV environment variables, said at startup: otherwise a typo
 * there just leaves the provider out (or uses Plaid's sandbox) without a word.
 */
export function envSettingsWarnings(): string[] {
  const warnings: string[] = []
  for (const prefix of ['AI_PRIMARY_', 'AI_FALLBACK_']) {
    const kind = process.env[`${prefix}KIND`]
    const model = process.env[`${prefix}MODEL`]
    if (kind && !AI_KINDS.includes(kind as AiKind)) {
      warnings.push(`${prefix}KIND is "${kind}", which isn't a provider this app knows, so it's ignored. Use one of ${AI_KINDS.join(', ')}.`)
    } else if (kind && !model) {
      warnings.push(`${prefix}KIND is set but ${prefix}MODEL isn't, so it's ignored. Set the model too.`)
    } else if (!kind && model) {
      warnings.push(`${prefix}MODEL is set but ${prefix}KIND isn't, so it's ignored. Set the provider too.`)
    }
  }
  const plaidEnv = process.env.PLAID_ENV
  // PLAID_ENV only goes with PLAID_CLIENT_ID and PLAID_SECRET: keys saved in App settings have their own environment.
  if (plaidEnv && process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && !PLAID_ENVIRONMENTS.includes(plaidEnv as PlaidEnvironment)) {
    warnings.push(`PLAID_ENV is "${plaidEnv}", which isn't one of ${PLAID_ENVIRONMENTS.join(', ')}, so Plaid's sandbox is used.`)
  }
  return warnings
}

function envAiConfig(slot: AiSlot): StoredAiConfig | null {
  const prefix = slot === 'primary' ? 'AI_PRIMARY_' : 'AI_FALLBACK_'
  const kind = process.env[`${prefix}KIND`] as AiKind | undefined
  const model = process.env[`${prefix}MODEL`]
  if (!kind || !model || !AI_KINDS.includes(kind)) return null
  return {
    kind,
    model,
    baseUrl: process.env[`${prefix}BASE_URL`] || null,
    apiKey: process.env[`${prefix}API_KEY`] || null,
  }
}

export function aiConfig(meta: MetaStore, slot: AiSlot): (StoredAiConfig & { source: 'env' | 'settings' }) | null {
  const fromEnv = envAiConfig(slot)
  if (fromEnv) return { ...fromEnv, source: 'env' }
  const stored = getAppSetting<StoredAiConfig | null>(meta, `ai.${slot}`, null)
  return stored ? { ...stored, apiKey: openStored(meta, stored.apiKey), source: 'settings' } : null
}

// Bank sync -------------------------------------------------------------------

type StoredSyncHours = Partial<Record<BankProviderKind, number>>

/** How often bank sync runs for a service, in hours (each service has its own setting). */
export function bankSyncHours(meta: MetaStore, provider: BankProviderKind): number {
  const hours = getAppSetting<StoredSyncHours>(meta, 'bank.syncHours', {})[provider]
  return hours && SYNC_INTERVALS[provider].includes(hours) ? hours : DEFAULT_SYNC_HOURS[provider]
}

interface StoredPlaid {
  clientId: string
  /** Encrypted. */
  secret: string | null
  environment: PlaidEnvironment
}
export interface PlaidCredentials {
  clientId: string
  secret: string
  environment: PlaidEnvironment
}

function envPlaid(): PlaidCredentials | null {
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  if (!clientId || !secret) return null
  const env = process.env.PLAID_ENV as PlaidEnvironment | undefined
  return { clientId, secret, environment: env && PLAID_ENVIRONMENTS.includes(env) ? env : 'sandbox' }
}

/** Plaid's client id and secret: from the PLAID_* environment variables if set, otherwise App settings. */
export function plaidCredentials(meta: MetaStore): (PlaidCredentials & { source: 'env' | 'settings' }) | null {
  const fromEnv = envPlaid()
  if (fromEnv) return { ...fromEnv, source: 'env' }
  const stored = getAppSetting<StoredPlaid | null>(meta, 'plaid', null)
  const secret = openStored(meta, stored?.secret)
  return stored && secret ? { clientId: stored.clientId, secret, environment: stored.environment, source: 'settings' } : null
}

function plaidPublic(meta: MetaStore): PlaidPublic {
  const fromEnv = envPlaid()
  const stored = getAppSetting<StoredPlaid | null>(meta, 'plaid', null)
  const cfg = fromEnv ?? (stored ? { ...stored, secret: openStored(meta, stored.secret) } : null)
  return {
    clientId: cfg?.clientId ?? null,
    hasSecret: !!cfg?.secret,
    secretHint: cfg?.secret ? `••••${cfg.secret.slice(-4)}` : null,
    environment: cfg?.environment ?? 'sandbox',
    source: fromEnv ? 'env' : stored ? 'settings' : null,
    configured: !!(cfg?.clientId && cfg.secret),
  }
}

function toPublic(cfg: ReturnType<typeof aiConfig>): AiProviderPublic | null {
  if (!cfg) return null
  return {
    kind: cfg.kind,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    hasApiKey: !!cfg.apiKey,
    apiKeyHint: cfg.apiKey ? `••••${cfg.apiKey.slice(-4)}` : null,
    source: cfg.source,
  }
}

/** How much a payment may vary and still count toward a recurring pattern. */
export function recurringDetection(meta: MetaStore): Settings['recurringDetection'] {
  const saved = getAppSetting<Partial<Settings['recurringDetection']>>(meta, 'recurring.detection', {})
  return {
    priceVariationPct: saved.priceVariationPct ?? RECURRING_DETECTION.priceVariationPct.default,
    dateVariationDays: saved.dateVariationDays ?? RECURRING_DETECTION.dateVariationDays.default,
  }
}

export function publicSettings(meta: MetaStore, now: () => Date): Settings {
  const primary = aiConfig(meta, 'primary')
  const fallback = aiConfig(meta, 'fallback')
  return {
    timezone: getAppSetting<string | null>(meta, 'timezone', null),
    systemTimezone: systemTimezone(),
    effectiveTimezone: effectiveTimezone(meta),
    today: today({ meta, now }),
    baseCurrency: 'CAD',
    firstDayOfWeek: getAppSetting<0 | 1>(meta, 'firstDayOfWeek', 0),
    transactionColumns: normalizeColumns(getAppSetting<string[] | null>(meta, 'transactionColumns', null)),
    // Columns that are gone (Name) drop out.
    transactionColumnWidths: Object.fromEntries(
      Object.entries(getAppSetting<Settings['transactionColumnWidths']>(meta, 'transactionColumnWidths', {})).filter(([c]) =>
        (TRANSACTION_COLUMNS as readonly string[]).includes(c),
      ),
    ),
    sidebarWidth: getAppSetting<number>(meta, 'sidebarWidth', SIDEBAR_WIDTH.default),
    customColors: getAppSetting<string[]>(meta, 'customColors', []),
    ai: { primary: toPublic(primary), fallback: toPublic(fallback), enabled: !!(primary || fallback) },
    bank: {
      plaid: plaidPublic(meta),
      syncHours: { simplefin: bankSyncHours(meta, 'simplefin'), plaid: bankSyncHours(meta, 'plaid'), wealthsimple: bankSyncHours(meta, 'wealthsimple') },
    },
    recurringDetection: recurringDetection(meta),
  }
}

/** Where a URL points (scheme, host and port), for telling whether two are the same server. */
function originOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * The fallback provider becomes the primary one and the primary the fallback, each with its saved key.
 * Not for a provider set by the server's environment variables, which this can't change.
 */
export function swapAiProviders(meta: MetaStore) {
  if (envAiConfig('primary') || envAiConfig('fallback')) {
    throw new HTTPException(409, { message: 'A provider set by the server’s AI_PRIMARY_* or AI_FALLBACK_* environment variables can’t change places here. Change them in .env and restart the server.' })
  }
  const primary = getAppSetting<StoredAiConfig | null>(meta, 'ai.primary', null)
  const fallback = getAppSetting<StoredAiConfig | null>(meta, 'ai.fallback', null)
  if (!fallback) throw new HTTPException(409, { message: 'There’s no fallback provider to make primary.' })
  setAppSetting(meta, 'ai.primary', fallback)
  setAppSetting(meta, 'ai.fallback', primary)
}

export function updateSettings(meta: MetaStore, input: SettingsUpdate) {
  if (input.timezone !== undefined) setAppSetting(meta, 'timezone', input.timezone)
  if (input.firstDayOfWeek !== undefined) setAppSetting(meta, 'firstDayOfWeek', input.firstDayOfWeek)
  // Saved in full (columns left out at the end), so a column added later can find its place.
  if (input.transactionColumns !== undefined) {
    setAppSetting(meta, 'transactionColumns', input.transactionColumns && [...new Set([...input.transactionColumns, ...TRANSACTION_COLUMNS])])
  }
  if (input.transactionColumnWidths !== undefined) setAppSetting(meta, 'transactionColumnWidths', input.transactionColumnWidths)
  if (input.sidebarWidth !== undefined) setAppSetting(meta, 'sidebarWidth', input.sidebarWidth)
  if (input.customColors !== undefined) {
    // Lowercase and once each, newest first.
    const colors = input.customColors && [...new Set(input.customColors.map((c) => c.toLowerCase()))]
    setAppSetting(meta, 'customColors', colors?.length ? colors : null)
  }
  if (input.ai) {
    for (const slot of ['primary', 'fallback'] as const) {
      const next = input.ai[slot]
      if (next === undefined) continue
      if (next === null) {
        setAppSetting(meta, `ai.${slot}`, null)
        continue
      }
      const prev = getAppSetting<StoredAiConfig | null>(meta, `ai.${slot}`, null)
      // Only "OpenAI-compatible" and a local server have a URL of your own.
      const baseUrl = next.kind === 'openai-compatible' || next.kind === 'local' ? next.baseUrl || null : null
      // Left out: keep the saved key (still encrypted), but only for the provider and server it was
      // saved for. Another provider or another server's address forgets it, so it's never sent elsewhere.
      const sameProvider = !!prev && prev.kind === next.kind && originOf(prev.baseUrl) === originOf(baseUrl)
      const apiKey = next.apiKey === undefined ? (sameProvider ? prev.apiKey : null) : seal(meta, next.apiKey || null)
      const info = aiProviderInfo(next.kind)
      setAppSetting(meta, `ai.${slot}`, {
        kind: next.kind,
        model: next.model,
        baseUrl,
        // A local model needs no key.
        apiKey: info.apiKey === 'none' ? null : apiKey,
      } satisfies StoredAiConfig)
    }
  }
  if (input.recurringDetection) {
    setAppSetting(meta, 'recurring.detection', { ...getAppSetting<object>(meta, 'recurring.detection', {}), ...input.recurringDetection })
  }
  if (input.bankSyncHours) {
    setAppSetting(meta, 'bank.syncHours', { ...getAppSetting<StoredSyncHours>(meta, 'bank.syncHours', {}), ...input.bankSyncHours })
  }
  if (input.plaid !== undefined) {
    if (input.plaid === null) setAppSetting(meta, 'plaid', null)
    else {
      const prev = getAppSetting<StoredPlaid | null>(meta, 'plaid', null)
      setAppSetting(meta, 'plaid', {
        clientId: input.plaid.clientId,
        secret: input.plaid.secret === undefined ? (prev?.secret ?? null) : seal(meta, input.plaid.secret),
        environment: input.plaid.environment,
      } satisfies StoredPlaid)
    }
  }
}
