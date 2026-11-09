import { ref } from 'vue'
import { api } from './api'

const LAST_LEDGER_KEY = 'st-ledger'

function readLast(): string {
  try {
    return localStorage.getItem(LAST_LEDGER_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * The ledger the app is showing (its slug). Set by the router from `/l/:ledger/...` before any
 * page loads, and remembered on this device so `/` reopens it.
 */
export const currentLedger = ref<string>(readLast())

export function setCurrentLedger(slug: string) {
  currentLedger.value = slug
  try {
    localStorage.setItem(LAST_LEDGER_KEY, slug)
  } catch {
    // Private mode etc.: the ledger is still in the URL.
  }
}

export function lastUsedLedger(): string {
  return readLast()
}

export function ledgerPath(path: string, slug = currentLedger.value): string {
  return `/ledgers/${encodeURIComponent(slug)}${path}`
}

/** URL for links and downloads that hit the API directly (e.g. CSV export). */
export function ledgerApiHref(path: string, slug = currentLedger.value): string {
  return `/api/v1${ledgerPath(path, slug)}`
}

/** The API client for the current ledger's data: every path is prefixed with /ledgers/<slug>. */
export const lapi = {
  get: <T>(path: string, query?: Parameters<typeof api.get>[1]) => api.get<T>(ledgerPath(path), query),
  post: <T>(path: string, body?: unknown) => api.post<T>(ledgerPath(path), body),
  patch: <T>(path: string, body: unknown) => api.patch<T>(ledgerPath(path), body),
  put: <T>(path: string, body: unknown) => api.put<T>(ledgerPath(path), body),
  del: <T = void>(path: string, body?: unknown) => api.del<T>(ledgerPath(path), body),
  upload: <T>(path: string, file: Blob) => api.upload<T>(ledgerPath(path), file),
}

/** Query keys that hold one ledger's ids: a custom report's filter, and the report it came from. Another ledger's page opens without them. */
export const FROM_ANOTHER_LEDGER = ['filter', 'filteredOut', 'report']
