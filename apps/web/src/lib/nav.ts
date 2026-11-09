import type { RouteLocationRaw } from 'vue-router'
import { ArrowLeftRight, ChartColumn, History, Landmark, LayoutDashboard, Repeat, Settings, SlidersHorizontal } from '@lucide/vue'
import { currentLedger } from './ledger'

/** A link to a page in the current ledger (works from pages outside a ledger, like App settings). */
export function ledgerLink(
  name: string,
  extra: { params?: Record<string, string | number>; query?: Record<string, string | undefined> } = {},
): RouteLocationRaw {
  return { name, params: { ledger: currentLedger.value, ...extra.params }, query: extra.query }
}

export const primaryNav = [
  { name: 'overview', label: 'Overview', icon: LayoutDashboard },
  { name: 'transactions', label: 'Transactions', icon: ArrowLeftRight },
  { name: 'accounts', label: 'Accounts', icon: Landmark },
  { name: 'recurring', label: 'Recurring', icon: Repeat },
  { name: 'reports', label: 'Reports', icon: ChartColumn },
]

export const secondaryNav = [
  { name: 'activity', label: 'Activity', icon: History, ledger: true },
  { name: 'ledger-settings', label: 'Ledger settings', icon: SlidersHorizontal, ledger: true },
  { name: 'app-settings', label: 'App settings', icon: Settings, ledger: false },
]

export function navLink(item: { name: string; ledger?: boolean }): RouteLocationRaw {
  return item.ledger === false ? { name: item.name } : ledgerLink(item.name)
}
