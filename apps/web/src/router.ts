import type { QueryClient } from '@tanstack/vue-query'
import { createRouter, createWebHistory, type RouteLocationRaw, type RouteRecordRaw } from 'vue-router'
import type { Ledger } from '@st/shared'
import { keys } from './composables/queries'
import { accessRefused, api, ApiError } from './lib/api'
import { currentLedger, FROM_ANOTHER_LEDGER, lastUsedLedger, setCurrentLedger } from './lib/ledger'

/** Pages for one ledger, under /l/:ledger. */
const ledgerPages: RouteRecordRaw[] = [
  { path: '', name: 'overview', component: () => import('./pages/OverviewPage.vue'), meta: { title: 'Overview' } },
  {
    path: 'transactions',
    name: 'transactions',
    component: () => import('./pages/TransactionsPage.vue'),
    meta: { title: 'Transactions' },
  },
  { path: 'accounts', name: 'accounts', component: () => import('./pages/AccountsPage.vue'), meta: { title: 'Accounts' } },
  {
    path: 'accounts/:id',
    name: 'account',
    component: () => import('./pages/AccountDetailPage.vue'),
    meta: { title: 'Account', parent: 'accounts' },
  },
  { path: 'recurring', name: 'recurring', component: () => import('./pages/RecurringPage.vue'), meta: { title: 'Recurring' } },
  // A custom report by its id, or none for Everything.
  { path: 'reports/:reportId(\\d+)?', name: 'reports', component: () => import('./pages/ReportsPage.vue'), meta: { title: 'Reports' } },
  {
    path: 'import',
    name: 'import',
    component: () => import('./pages/ImportPage.vue'),
    meta: { title: 'Import', parent: 'ledger-settings' },
  },
  { path: 'activity', name: 'activity', component: () => import('./pages/ActivityPage.vue'), meta: { title: 'Activity' } },
  {
    path: 'settings',
    name: 'ledger-settings',
    component: () => import('./pages/LedgerSettingsPage.vue'),
    meta: { title: 'Ledger settings' },
  },
]

const routes: RouteRecordRaw[] = [
  { path: '/l/:ledger', children: ledgerPages },
  {
    path: '/settings',
    name: 'app-settings',
    component: () => import('./pages/AppSettingsPage.vue'),
    meta: { title: 'App settings' },
  },
  // `/`, `/add` (PWA shortcut) and links from before ledgers existed: the guard sends these to a ledger.
  { path: '/:pathMatch(.*)*', name: 'to-ledger', component: { render: () => null } },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  // Going to a transaction (?jump=, see TransactionTable) scrolls to it there, so neither that nor
  // dropping it from the URL after scrolls to the top. Nor does changing the report you're looking at
  // (its filter, range or comparison are in the URL), so a row you filter out stays where it was.
  scrollBehavior: (to, from, saved) =>
    to.query.jump || (from.query.jump && to.path === from.path) || (to.name === 'reports' && to.path === from.path) ? false : (saved ?? { top: 0 }),
})

function pickLedger(ledgers: Ledger[], wanted?: string): Ledger | undefined {
  const usable = ledgers.filter((l) => !l.archived)
  const bySlug = (slug: string) => ledgers.find((l) => l.slug === slug || l.id === slug)
  const last = bySlug(lastUsedLedger())
  return (
    (wanted ? bySlug(wanted) : undefined) ??
    (last && !last.archived ? last : undefined) ??
    usable.find((l) => l.isDefault) ??
    usable[0] ??
    ledgers[0]
  )
}

/**
 * Resolves the ledger for every navigation. A known `:ledger` becomes the current ledger; anything
 * else (including a renamed or deleted ledger's old URL) is redirected to the last-used ledger, keeping
 * the page when possible.
 */
export function installLedgerGuard(queryClient: QueryClient) {
  router.beforeEach(async (to) => {
    let ledgers: Ledger[]
    try {
      ledgers = await queryClient.fetchQuery({
        queryKey: keys.ledgers,
        queryFn: () => api.get<Ledger[]>('/ledgers'),
        staleTime: 30_000,
      })
    } catch (err) {
      // Refused (not unreachable): the app says why instead of its pages.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) accessRefused.value = err.message
      return true // Server unreachable: let the page load and show its own error.
    }

    const param = typeof to.params.ledger === 'string' ? to.params.ledger : undefined
    const found = param ? ledgers.find((l) => l.slug === param || l.id === param) : undefined
    if (found) {
      setCurrentLedger(found.slug)
      // A ledger id in the URL is swapped for its readable slug.
      return found.slug === param ? true : { ...to, params: { ...to.params, ledger: found.slug }, replace: true }
    }

    if (to.name === 'app-settings') {
      if (!ledgers.some((l) => l.slug === currentLedger.value)) {
        const fallback = pickLedger(ledgers)
        if (fallback) setCurrentLedger(fallback.slug)
      }
      return true
    }

    const target = pickLedger(ledgers)
    if (!target) return true
    setCurrentLedger(target.slug)

    let sub = (param ? to.path.replace(/^\/l\/[^/]+/, '') : to.path).replace(/^\/+|\/+$/g, '')
    const isAdd = sub === 'add'
    // Reports and filters belong to the ledger they came from: another ledger opens without them.
    const query = { ...to.query }
    if (param) {
      sub = sub.replace(/^reports\/\d+$/, 'reports')
      for (const k of FROM_ANOTHER_LEDGER) delete query[k]
    }
    let location: RouteLocationRaw = {
      path: `/l/${target.slug}${isAdd || !sub ? '' : `/${sub}`}`,
      query: isAdd ? { ...query, add: '1' } : query,
      hash: to.hash,
      replace: true,
    }
    // Unknown pages go to the ledger's overview instead of looping back here.
    if (router.resolve(location).name === 'to-ledger') location = { path: `/l/${target.slug}`, replace: true }
    return location
  })

  router.afterEach((to) => {
    const title = to.meta.title as string | undefined
    const ledgers = queryClient.getQueryData<Ledger[]>(keys.ledgers)
    const ledger = ledgers?.find((l) => l.slug === currentLedger.value)
    const parts = [title, to.params.ledger && ledgers && ledgers.length > 1 ? ledger?.name : undefined, 'Spending Tracker']
    document.title = parts.filter(Boolean).join(' · ')
  })
}
