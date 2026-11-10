import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { UNGROUPED_COLOR } from '@st/shared'
import type {
  Account,
  AccountCreate,
  ActivityPage,
  AiJobStatus,
  ApiKey,
  ApiKeyCreate,
  ApiKeyCreated,
  AccountBankLink,
  AccountBankPreview,
  AccountBankSwitch,
  BankConnection,
  BankPayload,
  BankConnectionCreate,
  SyncResult,
  AccountUpdate,
  AiUsage,
  ChatgptModel,
  ChatgptStatus,
  BalancePoint,
  BalanceUpdate,
  BulkUpdate,
  Category,
  CategoryCreate,
  CategoryGroup,
  CategoryJoinItem,
  CategoryList,
  CategoryMergeResult,
  CategorySharing,
  CategoryAmount,
  CategorySuggestion,
  CategoryUpdate,
  ImportBatch,
  Label,
  LabelCategories,
  LabelCreate,
  LabelUpdate,
  PlaidConnect,
  PlaidLinkToken,
  PlaidLinkTokenRequest,
  ImportCommitInput,
  LinkableBankAccount,
  LinkPreview,
  ImportPreviewInput,
  ImportPreviewRow,
  ImportResult,
  Institution,
  InstitutionUpdate,
  Ledger,
  LedgerCreate,
  LedgerUpdate,
  MonthSummary,
  NetWorthReport,
  PayeeChoice,
  PayeeNamePreview,
  PayeeNamePreviewQuery,
  PayeeNameRule,
  PayeeNameRuleCreate,
  PayeeTidyPreview,
  PayeeTidyStatus,
  PayeeNameRuleUpdate,
  PayeeRename,
  PayeeWordingsName,
  PayeeChoiceUpdate,
  PayeeRule,
  PayeeTotal,
  PeriodSummary,
  RecurringCreate,
  RecurringItem,
  RecurringPaymentCandidate,
  LinkCandidate,
  LinkedTransaction,
  LinkKind,
  TransactionLinksSet,
  TransactionLinksSetTogether,
  RecurringStatus,
  RecurringUpdate,
  Settings,
  SettingsUpdate,
  SetupStatus,
  SuggestCategoryInput,
  SwitchResult,
  Tag,
  Transaction,
  TransactionCreate,
  TransactionListItem,
  TransactionPage,
  TransactionQuery,
  TransactionSpan,
  TransactionUpdate,
  TrendReport,
  CustomReport,
  CustomReportCreate,
  CustomReportUpdate,
  PayeeSearchResult,
  ReportPurchases,
  UpcomingPayment,
  WealthsimpleConnect,
  WealthsimpleConnectResult,
} from '@st/shared'
import { api } from '@/lib/api'
import { currentLedger, lapi } from '@/lib/ledger'

/** Query keys. Ledger data is keyed by the ledger's slug so caches for different ledgers never mix. */
const lk = (...parts: string[]) => ['l', currentLedger.value, ...parts]

export const keys = {
  settings: ['settings'] as const,
  ledgers: ['ledgers'] as const,
  aiUsage: ['ai-usage'] as const,
  /** Payee names: your rules and AI tidying (app-wide). */
  payeeNames: ['payee-names'] as const,
  chatgpt: ['chatgpt'] as const,
  ledger: () => lk(),
  accounts: () => lk('accounts'),
  categories: () => lk('categories'),
  /** The shared category list (App settings → Categories). */
  sharedCategories: ['shared-categories'] as const,
  tags: () => lk('tags'),
  payees: () => lk('payees'),
  transactions: () => lk('transactions'),
  summary: () => lk('summary'),
  reports: () => lk('reports'),
  /** Under reports, so whatever refreshes reports refreshes what a report says is missing. */
  customReports: () => lk('reports', 'custom'),
  recurring: () => lk('recurring'),
  aiStatus: () => lk('ai-status'),
  setup: () => lk('setup'),
  importBatches: () => lk('import-batches'),
  activity: () => lk('activity'),
  apiKeys: ['api-keys'] as const,
  bank: ['bank'] as const,
}

/** Anything that changes money moves these views. */
export function useInvalidateLedger() {
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.transactions() }),
      qc.invalidateQueries({ queryKey: keys.accounts() }),
      qc.invalidateQueries({ queryKey: keys.summary() }),
      qc.invalidateQueries({ queryKey: keys.reports() }),
      qc.invalidateQueries({ queryKey: keys.recurring() }),
      qc.invalidateQueries({ queryKey: keys.tags() }),
      qc.invalidateQueries({ queryKey: keys.payees() }),
    ])
}

// Settings ------------------------------------------------------------------

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api.get<Settings>('/settings'), staleTime: 60_000 })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SettingsUpdate) => api.patch<Settings>('/settings', input),
    onSuccess: (data, input) => {
      qc.setQueryData(keys.settings, data)
      // Dates (and so totals) move with the time zone and the week start; other settings don't touch them.
      if (input.timezone !== undefined || input.firstDayOfWeek !== undefined) {
        qc.invalidateQueries({ queryKey: keys.summary() })
        qc.invalidateQueries({ queryKey: keys.reports() })
      }
    },
  })
}

/**
 * Signing in with ChatGPT, for the provider that uses your ChatGPT plan: its status (checked every
 * 2 seconds while `waiting` for a sign-in in another tab), the models the plan offers, and signing
 * in and out.
 */
export function useChatgpt(waiting: MaybeRefOrGetter<boolean>) {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: keys.chatgpt,
    queryFn: () => api.get<ChatgptStatus>('/settings/ai/chatgpt'),
    refetchInterval: computed(() => (toValue(waiting) ? 2000 : false)),
  })
  const models = useQuery({
    queryKey: [...keys.chatgpt, 'models'],
    queryFn: () => api.get<ChatgptModel[]>('/settings/ai/chatgpt/models'),
    enabled: computed(() => !!status.data.value?.signedIn && status.data.value.planUsage),
    staleTime: 5 * 60_000,
    retry: false,
  })
  return {
    status,
    models,
    start: useMutation({ mutationFn: () => api.post<{ url: string }>('/settings/ai/chatgpt/sign-in') }),
    finish: useMutation({
      mutationFn: (url: string) => api.post<ChatgptStatus>('/settings/ai/chatgpt/finish', { url }),
      onSuccess: (s) => qc.setQueryData(keys.chatgpt, s),
    }),
    signOut: useMutation({
      mutationFn: () => api.del<{ note: string | null }>('/settings/ai/chatgpt'),
      onSuccess: () => qc.invalidateQueries({ queryKey: keys.chatgpt }),
    }),
  }
}

export function useAiUsage() {
  return useQuery({ queryKey: keys.aiUsage, queryFn: () => api.get<AiUsage>('/ai/usage') })
}

// Accounts ------------------------------------------------------------------

export function useAccounts() {
  const q = useQuery({ queryKey: computed(() => keys.accounts()), queryFn: () => lapi.get<Account[]>('/accounts') })
  const byId = computed(() => new Map((q.data.value ?? []).map((a) => [a.id, a])))
  const active = computed(() => (q.data.value ?? []).filter((a) => !a.archived))
  return { ...q, byId, active }
}

export function useAccountMutations() {
  const invalidate = useInvalidateLedger()
  return {
    create: useMutation({ mutationFn: (input: AccountCreate) => lapi.post<Account>('/accounts', input), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...input }: AccountUpdate & { id: number }) => lapi.patch<Account>(`/accounts/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: number) => lapi.del(`/accounts/${id}`), onSuccess: invalidate }),
    setBalance: useMutation({
      mutationFn: ({ id, ...input }: BalanceUpdate & { id: number }) => lapi.post<Account>(`/accounts/${id}/balance`, input),
      onSuccess: invalidate,
    }),
    deleteSnapshot: useMutation({
      mutationFn: ({ id, snapshotId }: { id: number; snapshotId: number }) => lapi.del(`/accounts/${id}/snapshots/${snapshotId}`),
      onSuccess: invalidate,
    }),
  }
}

/** Institutions sit under the accounts key: adding or moving an account can create one or change its count. */
export function useInstitutions() {
  const q = useQuery({ queryKey: computed(() => [...keys.accounts(), 'institutions']), queryFn: () => lapi.get<Institution[]>('/institutions') })
  const byId = computed(() => new Map((q.data.value ?? []).map((i) => [i.id, i])))
  return { ...q, byId }
}

/** Accounts under their institutions, in the institutions' order. */
export function useGroupedAccounts(accounts: MaybeRefOrGetter<Account[]>) {
  const { data } = useInstitutions()
  return computed(() => {
    const order = new Map((data.value ?? []).map((i, n) => [i.id, n]))
    const groups = new Map<number, { id: number; name: string; accounts: Account[] }>()
    for (const a of toValue(accounts)) {
      const g = groups.get(a.institutionId) ?? { id: a.institutionId, name: a.institution, accounts: [] }
      g.accounts.push(a)
      groups.set(a.institutionId, g)
    }
    const rank = (id: number) => order.get(id) ?? Number.MAX_SAFE_INTEGER
    return [...groups.values()].sort((x, y) => rank(x.id) - rank(y.id))
  })
}

export function useInstitutionMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.accounts() })
  return {
    update: useMutation({
      mutationFn: ({ id, ...input }: InstitutionUpdate & { id: number }) => lapi.patch<Institution>(`/institutions/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: ({ id, moveTo }: { id: number; moveTo?: number }) => lapi.del(`/institutions/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`),
      onSuccess: invalidate,
    }),
    reorder: useMutation({ mutationFn: (ids: number[]) => lapi.post<Institution[]>('/institutions/reorder', { ids }), onSuccess: invalidate }),
  }
}

export function useSnapshots(accountId: MaybeRefOrGetter<number>) {
  return useQuery({
    queryKey: computed(() => [...keys.accounts(), toValue(accountId), 'snapshots']),
    queryFn: () =>
      lapi.get<Array<{ id: number; date: string; balanceMinor: number; source: string }>>(
        `/accounts/${toValue(accountId)}/snapshots`,
      ),
  })
}

// Categories & tags -----------------------------------------------------------

/** `ledger`: this ledger's categories (as it uses them). `shared`: the shared list in App settings. */
export type CategoryScope = 'ledger' | 'shared'

export function useCategories(scope: CategoryScope = 'ledger') {
  const q = useQuery({
    queryKey: computed(() => (scope === 'shared' ? [...keys.sharedCategories] : keys.categories())),
    queryFn: () => (scope === 'shared' ? api.get<CategoryList>('/categories') : lapi.get<CategoryList>('/categories')),
    staleTime: 5 * 60_000,
  })
  const categories = computed(() => q.data.value?.categories ?? [])
  const groups = computed(() => q.data.value?.groups ?? [])
  const byId = computed(() => new Map(categories.value.map((c) => [c.id, c])))
  /** Active categories grouped for pickers, in display order. */
  const grouped = computed(() => {
    const active = categories.value.filter((c) => !c.archived)
    const out = groups.value
      .map((g) => ({ group: g as CategoryGroup | null, categories: active.filter((c) => c.groupId === g.id) }))
      .filter((g) => g.categories.length)
    const loose = active.filter((c) => c.groupId === null)
    if (loose.length) out.push({ group: null, categories: loose })
    return out
  })
  /** Your category labels, in their order. */
  const labels = computed(() => q.data.value?.labels ?? [])
  /** A category's colour: its group's (categories have none of their own), or neutral without a group. */
  const groupColors = computed(() => new Map(groups.value.map((g) => [g.id, g.color])))
  const colorOf = (c: { groupId: number | null } | undefined | null) => (c ? (c.groupId !== null && groupColors.value.get(c.groupId)) || UNGROUPED_COLOR : undefined)
  /** This ledger uses the shared list (its categories are only turned on and off here). */
  const shared = computed(() => q.data.value?.shared ?? false)
  return { ...q, categories, groups, byId, grouped, labels, colorOf, shared }
}

/**
 * Changes to categories: this ledger's own list (`ledger`), or the shared list (`shared`), which
 * every ledger that uses it follows, so everything refreshes after.
 */
export function useCategoryMutations(scope: CategoryScope = 'ledger') {
  const qc = useQueryClient()
  const client = scope === 'shared' ? api : lapi
  const invalidate = () => {
    if (scope === 'shared') return void qc.invalidateQueries()
    qc.invalidateQueries({ queryKey: keys.categories() })
    qc.invalidateQueries({ queryKey: keys.summary() })
    qc.invalidateQueries({ queryKey: keys.reports() })
  }
  /** Transactions and recurring payments lose (or change) their category too. */
  const invalidateUses = () => {
    invalidate()
    qc.invalidateQueries({ queryKey: keys.transactions() })
    qc.invalidateQueries({ queryKey: keys.recurring() })
  }
  return {
    create: useMutation({ mutationFn: (input: CategoryCreate) => client.post<Category>('/categories', input), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...input }: CategoryUpdate & { id: number; archived?: boolean }) => client.patch<Category>(`/categories/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: number) => client.del(`/categories/${id}`), onSuccess: invalidateUses }),
    /** Moves a category's transactions and recurring payments to another, then deletes it. */
    merge: useMutation({
      mutationFn: ({ id, into }: { id: number; into: number }) => client.post<CategoryMergeResult>(`/categories/${id}/merge`, { into }),
      onSuccess: invalidateUses,
    }),
    createGroup: useMutation({
      mutationFn: (input: { name: string; color?: string }) => client.post<CategoryGroup>('/category-groups', input),
      onSuccess: invalidate,
    }),
    updateGroup: useMutation({
      mutationFn: ({ id, ...input }: { id: number; name?: string; color?: string; sort?: number }) =>
        client.patch<CategoryGroup>(`/category-groups/${id}`, input),
      // Its categories' colours change with it, everywhere they show.
      onSuccess: () => {
        invalidate()
        qc.invalidateQueries({ queryKey: keys.transactions() })
      },
    }),
    /** Deletes the group and its categories. */
    removeGroup: useMutation({ mutationFn: (id: number) => client.del(`/category-groups/${id}`), onSuccess: invalidateUses }),
    /** Category ids in their new order (every group's, one after another). */
    reorder: useMutation({ mutationFn: (ids: number[]) => client.post<CategoryList>('/categories/reorder', { ids }), onSuccess: invalidate }),
    reorderGroups: useMutation({ mutationFn: (ids: number[]) => client.post<CategoryList>('/category-groups/reorder', { ids }), onSuccess: invalidate }),
  }
}

/** A ledger that uses the shared list turns its categories on and off, or switches to its own list. */
export function useLedgerCategorySettings() {
  const qc = useQueryClient()
  const invalidateLedger = useInvalidateLedger()
  return {
    /** Turning off one that's used moves its transactions to `moveTo`, or leaves them uncategorized (null). */
    setEnabled: useMutation({
      mutationFn: ({ id, enabled, moveTo }: { id: number; enabled: boolean; moveTo?: number | null }) =>
        lapi.patch<Category>(`/categories/${id}`, { enabled, moveTo }),
      onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.categories() }), invalidateLedger()]),
    }),
    /** Joining the shared list can add categories to it, which every ledger that shares sees. */
    setSharing: useMutation({
      mutationFn: (input: CategorySharing) => lapi.put<CategoryList>('/categories/sharing', input),
      onSuccess: () => qc.invalidateQueries(),
    }),
  }
}

// Payees ---------------------------------------------------------------------

/** Payees you chose to always set to one category, or to always review yourself. */
export function usePayeeRules() {
  return useQuery({ queryKey: computed(() => keys.payees()), queryFn: () => lapi.get<PayeeRule[]>('/payees') })
}

/** What you chose for a payee, and how many of its transactions "always" (this category) would set. */
export function usePayeeChoice(payeeKey: MaybeRefOrGetter<string | null>, categoryId: MaybeRefOrGetter<number | null>) {
  return useQuery({
    queryKey: computed(() => [...keys.payees(), 'choice', toValue(payeeKey), toValue(categoryId)]),
    queryFn: () => lapi.get<PayeeChoice>('/payees/choice', { payeeKey: toValue(payeeKey), categoryId: toValue(categoryId) }),
    enabled: computed(() => !!toValue(payeeKey) && !!toValue(categoryId)),
  })
}

/** Choosing "always" also sets the category on the payee's transactions waiting for it. */
export function useSetPayeeChoice() {
  const qc = useQueryClient()
  const invalidateLedger = useInvalidateLedger()
  return useMutation({
    mutationFn: (input: PayeeChoiceUpdate) => lapi.put<PayeeChoice & { updated: number }>('/payees/choice', input),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.payees() }), invalidateLedger()]),
  })
}

/** Your payee name rules (app-wide), in the order they apply. */
export function usePayeeNameRules() {
  return useQuery({ queryKey: keys.payeeNames, queryFn: () => api.get<PayeeNameRule[]>('/payees/name-rules') })
}

/** What a change to the payee name rules would make, before it's saved. */
export function previewPayeeNames(input: PayeeNamePreviewQuery) {
  return api.post<PayeeNamePreview>('/payees/name-rules/preview', input)
}

/** AI tidying of payee names: on or off, its background run, and every payee it named. Checked often while it runs. */
export function usePayeeTidy() {
  return useQuery({
    queryKey: [...keys.payeeNames, 'tidy'],
    queryFn: () => api.get<PayeeTidyStatus>('/payees/tidy'),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  })
}

/** AI names a batch of 20 payees (from 0, the messiest first), to see what it does before it names the rest. */
export function previewPayeeTidy(page = 0) {
  return api.post<PayeeTidyPreview>('/payees/tidy/preview', { page })
}

/**
 * Changing what payees are called: renaming one, your rules, or AI tidying. Every transaction's payee
 * name can change with them, in every ledger, so they refresh.
 */
export function usePayeeNameMutations() {
  const qc = useQueryClient()
  const onSuccess = () => qc.invalidateQueries()
  type Changed = { changed: number }
  return {
    rename: useMutation({ mutationFn: (input: PayeeRename) => lapi.post<{ rule: PayeeNameRule | null } & Changed>('/payees/rename', input), onSuccess }),
    /** Payees as sent, from the tidied payees: one name for them all, by one rule. */
    nameWordings: useMutation({ mutationFn: (input: PayeeWordingsName) => api.post<{ rule: PayeeNameRule | null } & Changed>('/payees/wordings/name', input), onSuccess }),
    create: useMutation({ mutationFn: (input: PayeeNameRuleCreate) => api.post<{ rule: PayeeNameRule } & Changed>('/payees/name-rules', input), onSuccess }),
    update: useMutation({
      mutationFn: ({ id, ...input }: PayeeNameRuleUpdate & { id: number }) => api.patch<{ rule: PayeeNameRule } & Changed>(`/payees/name-rules/${id}`, input),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: number) => api.del<Changed>(`/payees/name-rules/${id}`), onSuccess }),
    order: useMutation({ mutationFn: (ids: number[]) => api.put<Changed>('/payees/name-rules/order', { ids }), onSuccess }),
    tidy: useMutation({ mutationFn: (enabled: boolean) => api.put<PayeeTidyStatus>('/payees/tidy', { enabled }), onSuccess }),
    tidyAgain: useMutation({ mutationFn: (originals: string[]) => api.post<PayeeTidyStatus>('/payees/tidy/again', { originals }), onSuccess }),
  }
}

/** Before a ledger with its own list joins the shared one: its categories the shared list doesn't have by name. */
export function useCategorySharingPreview(enabled: MaybeRefOrGetter<boolean>) {
  return useQuery({
    queryKey: computed(() => [...keys.categories(), 'sharing']),
    queryFn: () => lapi.get<{ shared: boolean; differing: CategoryJoinItem[] }>('/categories/sharing'),
    enabled: computed(() => toValue(enabled)),
  })
}

/** Category labels. Lists filtered by a label change with them, so those refresh too. */
export function useLabelMutations(scope: CategoryScope = 'ledger') {
  const qc = useQueryClient()
  const client = scope === 'shared' ? api : lapi
  const invalidate = () => {
    if (scope === 'shared') return void qc.invalidateQueries()
    qc.invalidateQueries({ queryKey: keys.categories() })
    qc.invalidateQueries({ queryKey: keys.summary() })
    qc.invalidateQueries({ queryKey: keys.reports() })
    qc.invalidateQueries({ queryKey: keys.transactions() })
  }
  return {
    create: useMutation({ mutationFn: (input: LabelCreate) => client.post<Label>('/labels', input), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...input }: LabelUpdate & { id: number }) => client.patch<Label>(`/labels/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: number) => client.del(`/labels/${id}`), onSuccess: invalidate }),
    apply: useMutation({
      mutationFn: ({ id, ...input }: LabelCategories & { id: number }) => client.post<Label>(`/labels/${id}/categories`, input),
      onSuccess: invalidate,
    }),
  }
}

export function useTags() {
  return useQuery({ queryKey: computed(() => keys.tags()), queryFn: () => lapi.get<Array<Tag & { count: number }>>('/tags') })
}

export function useTagMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: keys.tags() })
    qc.invalidateQueries({ queryKey: keys.transactions() })
    qc.invalidateQueries({ queryKey: keys.reports() })
  }
  return {
    update: useMutation({
      mutationFn: ({ id, ...input }: { id: number; name?: string; color?: string | null }) => lapi.patch<Tag>(`/tags/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: number) => lapi.del(`/tags/${id}`), onSuccess: invalidate }),
  }
}

// Transactions ----------------------------------------------------------------

export type TransactionFilters = Omit<TransactionQuery, 'cursor' | 'limit'>

/**
 * Transactions matching the filters, a page at a time: `rows`. With `keep`, one you change that stops
 * matching (a category set while filtered by another, say) stays where it was, as it is now, until the
 * filters change: so you can see what you did, and undo it. `kept`: those rows' ids.
 */
export function useTransactions(filters: MaybeRefOrGetter<TransactionFilters>, pageSize = 100, opts: { keep?: boolean } = {}) {
  const q = useInfiniteQuery({
    queryKey: computed(() => [...keys.transactions(), 'list', toValue(filters), pageSize]),
    queryFn: ({ pageParam }) =>
      lapi.get<TransactionPage>('/transactions', {
        ...(toValue(filters) as Record<string, string | number | boolean | undefined>),
        limit: pageSize,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  })
  const fresh = () => q.data.value?.pages.flatMap((p) => p.items) ?? []
  if (!opts.keep) return { ...q, rows: computed(fresh), kept: computed(() => new Set<number>()) }

  const rows = shallowRef<TransactionListItem[]>([])
  const kept = shallowRef(new Map<number, TransactionListItem>())
  let key: string | null = null
  // The rows are this filter's own, not the last one's kept on screen while it loads.
  let settled = false
  watch(
    [() => q.data.value, () => JSON.stringify(toValue(filters)), () => q.isPlaceholderData.value],
    ([, k, placeholder]) => {
      const now = fresh()
      if (k !== key || !settled) {
        key = k
        settled = !placeholder
        kept.value = new Map()
        rows.value = now
        return
      }
      const ids = new Set(now.map((t) => t.id))
      const next = new Map([...kept.value].filter(([id]) => !ids.has(id)))
      const gone = rows.value.filter((t) => !ids.has(t.id) && !next.has(t.id))
      for (const t of gone) next.set(t.id, t)
      kept.value = next
      rows.value = withKept(rows.value, now, next)
      // Each one as it is now; one that was deleted goes.
      for (const t of gone) {
        lapi
          .get<Transaction>(`/transactions/${t.id}`)
          .then((got) => {
            if (key !== k || !kept.value.has(t.id)) return
            // Its running balance, as it was: what changed (a category, a note) doesn't move it.
            const latest = { ...got, balanceAfterMinor: t.balanceAfterMinor }
            kept.value = new Map(kept.value).set(t.id, latest)
            rows.value = rows.value.map((r) => (r.id === t.id ? latest : r))
          })
          .catch(() => {
            if (key !== k) return
            const rest = new Map(kept.value)
            rest.delete(t.id)
            kept.value = rest
            rows.value = rows.value.filter((r) => r.id !== t.id)
          })
      }
    },
    { immediate: true },
  )
  return { ...q, rows, kept: computed(() => new Set(kept.value.keys())) }
}

/** The fresh rows, with each kept one after the row it followed before (first, when none of those is left). */
function withKept(before: TransactionListItem[], now: TransactionListItem[], kept: Map<number, TransactionListItem>): TransactionListItem[] {
  const ids = new Set(now.map((t) => t.id))
  const after = new Map<number | null, TransactionListItem[]>()
  let anchor: number | null = null
  for (const t of before) {
    if (ids.has(t.id)) anchor = t.id
    else if (kept.has(t.id)) after.set(anchor, [...(after.get(anchor) ?? []), kept.get(t.id)!])
  }
  return [...(after.get(null) ?? []), ...now.flatMap((t) => [t, ...(after.get(t.id) ?? [])])]
}

/** What its current sync service last sent for a transaction, as it sent it (id null: don't fetch). */
export function useBankData(id: MaybeRefOrGetter<number | null>) {
  return useQuery({
    queryKey: computed(() => [...keys.transactions(), 'bank-data', toValue(id)]),
    queryFn: () => lapi.get<BankPayload | null>(`/transactions/${toValue(id)}/bank-data`),
    enabled: computed(() => toValue(id) !== null),
  })
}

/** One transaction (such as the purchase a refund is for); nothing while `id` is null. */
export function useTransaction(id: MaybeRefOrGetter<number | null>) {
  return useQuery({
    queryKey: computed(() => [...keys.transactions(), 'one', toValue(id)]),
    queryFn: () => lapi.get<Transaction>(`/transactions/${toValue(id)}`),
    enabled: computed(() => toValue(id) !== null),
    retry: false,
  })
}

/**
 * What a transaction could be linked to, likely ones first: for money in, purchases (a refund) or bills
 * (a payback); for a bill, money in that paid it back. Around its date, or, searched with `q` or in some
 * `categories`, at any date (nothing while `id` is null).
 */
export function useLinkCandidates(
  id: MaybeRefOrGetter<number | null>,
  kind: MaybeRefOrGetter<LinkKind>,
  q: MaybeRefOrGetter<string>,
  categories: MaybeRefOrGetter<Array<number | 'none'>> = [],
) {
  const categoryId = () => toValue(categories).join(',') || undefined
  return useQuery({
    queryKey: computed(() => [...keys.transactions(), 'link-candidates', toValue(id), toValue(kind), toValue(q), categoryId()]),
    queryFn: () => lapi.get<LinkCandidate[]>(`/transactions/${toValue(id)}/link-candidates`, { kind: toValue(kind), q: toValue(q) || undefined, categoryId: categoryId() }),
    enabled: computed(() => toValue(id) !== null),
    placeholderData: keepPreviousData,
  })
}

/** A transaction's refunds and paybacks, each with the transaction on its other side (nothing while `id` is null). */
export function useLinkedTransactions(id: MaybeRefOrGetter<number | null>) {
  return useQuery({
    queryKey: computed(() => [...keys.transactions(), 'links', toValue(id)]),
    queryFn: () => lapi.get<LinkedTransaction[]>(`/transactions/${toValue(id)}/links`),
    enabled: computed(() => toValue(id) !== null),
  })
}

/** Several transactions' refunds and paybacks, in one list (the same as one's, for one). */
export function useLinkedTransactionsOf(ids: MaybeRefOrGetter<number[]>) {
  return useQuery({
    queryKey: computed(() => [...keys.transactions(), 'links', ...toValue(ids)]),
    queryFn: () => Promise.all(toValue(ids).map((id) => lapi.get<LinkedTransaction[]>(`/transactions/${id}/links`))).then((lists) => lists.flat()),
    enabled: computed(() => toValue(ids).length > 0),
  })
}

/** The earliest and latest transaction dates (refreshed whenever transactions change). */
export function useTransactionSpan() {
  return useQuery({
    queryKey: computed(() => [...keys.transactions(), 'span']),
    queryFn: () => lapi.get<TransactionSpan>('/transactions/span'),
    staleTime: 60_000,
  })
}

export function useTransactionMutations() {
  const invalidate = useInvalidateLedger()
  const qc = useQueryClient()
  return {
    create: useMutation({
      mutationFn: (input: TransactionCreate) => lapi.post<Transaction>('/transactions', input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, ...input }: TransactionUpdate & { id: number }) => lapi.patch<Transaction>(`/transactions/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: number) => lapi.del(`/transactions/${id}`), onSuccess: invalidate }),
    restore: useMutation({
      mutationFn: (id: number) => lapi.post<Transaction>(`/transactions/${id}/restore`),
      onSuccess: invalidate,
    }),
    accept: useMutation({
      mutationFn: (id: number) => lapi.post<Transaction>(`/transactions/${id}/accept-suggestion`),
      onSuccess: invalidate,
    }),
    bulk: useMutation({
      mutationFn: (input: BulkUpdate) => lapi.post<{ updated: number }>('/transactions/bulk', input),
      onSuccess: invalidate,
    }),
    /** AI looks at these transactions' categories again, in the background (see useAiJobStatus). */
    askAiAgain: useMutation({
      mutationFn: (ids: number[]) => lapi.post<AiJobStatus>('/categorize/again', { ids }),
      onSuccess: (status) => {
        qc.setQueryData(keys.aiStatus(), status)
        return invalidate()
      },
    }),
    /** Replaces what a transaction pays back (or what paid it back). Reports change with it, so the ledger refreshes. */
    setLinks: useMutation({
      mutationFn: ({ id, links }: { id: number } & TransactionLinksSet) => lapi.put<Transaction>(`/transactions/${id}/links`, { links }),
      onSuccess: invalidate,
    }),
    /** Sets what several money in pays back, all at once (a few people paying back the same bills). */
    setLinksTogether: useMutation({
      mutationFn: (input: TransactionLinksSetTogether) => lapi.put<Transaction[]>('/transactions/links', input),
      onSuccess: invalidate,
    }),
  }
}

export function suggestCategory(input: SuggestCategoryInput) {
  return lapi.post<CategorySuggestion>('/categorize/suggest', input)
}

export function useAiJobStatus(enabled: MaybeRefOrGetter<boolean>) {
  return useQuery({
    queryKey: computed(() => keys.aiStatus()),
    queryFn: () => lapi.get<AiJobStatus>('/categorize/status'),
    enabled: computed(() => toValue(enabled)),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  })
}

// Reports ---------------------------------------------------------------------

export function useSummary(month: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => [...keys.summary(), toValue(month)]),
    queryFn: () => lapi.get<MonthSummary>('/reports/summary', { month: toValue(month) }),
    placeholderData: keepPreviousData,
  })
}

/** A report's filter (ReportFilter as JSON), left out for everything. */
type Filtered = { filter?: string }

export function useTrend(
  params: MaybeRefOrGetter<{ end: string; months: number; groupBy: 'category' | 'group' } & Filtered>,
  opts: { enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'trend', toValue(params)]),
    queryFn: () => lapi.get<TrendReport>('/reports/trend', toValue(params)),
    placeholderData: keepPreviousData,
    enabled: computed(() => toValue(opts.enabled) ?? true),
  })
}

export function useIncomeVsExpense(params: MaybeRefOrGetter<{ end: string; months: number }>) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'income-vs-expense', toValue(params)]),
    queryFn: () =>
      lapi.get<Array<{ month: string; incomeMinor: number; spentMinor: number; netMinor: number }>>(
        '/reports/income-vs-expense',
        toValue(params),
      ),
    placeholderData: keepPreviousData,
  })
}

export function useByCategory(
  params: MaybeRefOrGetter<{ from: string; to: string; kind?: 'expense' | 'income' } & Filtered>,
  opts: { enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'by-category', toValue(params)]),
    queryFn: () => lapi.get<CategoryAmount[]>('/reports/by-category', toValue(params)),
    placeholderData: keepPreviousData,
    enabled: computed(() => toValue(opts.enabled) ?? true),
  })
}

/** Income, spending by group and category, and transfers for a period; no dates means all time. */
export function usePeriodSummary(range: MaybeRefOrGetter<{ from?: string; to?: string } & Filtered>, opts: { enabled?: MaybeRefOrGetter<boolean> } = {}) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'period', toValue(range)]),
    queryFn: () => lapi.get<PeriodSummary>('/reports/period', toValue(range)),
    placeholderData: keepPreviousData,
    enabled: computed(() => toValue(opts.enabled) ?? true),
  })
}

export function usePayees(params: MaybeRefOrGetter<{ from: string; to: string; limit?: number } & Filtered>, opts: { enabled?: MaybeRefOrGetter<boolean> } = {}) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'payees', toValue(params)]),
    queryFn: () => lapi.get<PayeeTotal[]>('/reports/payees', toValue(params)),
    placeholderData: keepPreviousData,
    enabled: computed(() => toValue(opts.enabled) ?? true),
  })
}

export function useTagTotals(params: MaybeRefOrGetter<{ from: string; to: string } & Filtered>, opts: { enabled?: MaybeRefOrGetter<boolean> } = {}) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'tags', toValue(params)]),
    queryFn: () =>
      lapi.get<Array<{ tagId: number; name: string; color: string | null; spentMinor: number; incomeMinor: number; count: number }>>(
        '/reports/tags',
        toValue(params),
      ),
    placeholderData: keepPreviousData,
    enabled: computed(() => toValue(opts.enabled) ?? true),
  })
}

/** The biggest purchases a filter counts (by your share), or what it filters out. */
export function useReportPurchases(
  params: MaybeRefOrGetter<{ from: string; to: string; side?: 'spending' | 'income'; set?: 'counted' | 'filtered-out'; limit?: number } & Filtered>,
  opts: { enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'purchases', toValue(params)]),
    queryFn: () => lapi.get<ReportPurchases>('/reports/purchases', toValue(params)),
    placeholderData: keepPreviousData,
    enabled: computed(() => toValue(opts.enabled) ?? true),
  })
}

/** Payees by name (`q`), or just these keys (to name the ones a filter has), most used first. */
export function usePayeeSearch(params: MaybeRefOrGetter<{ q?: string; keys?: string[]; limit?: number }>, opts: { enabled?: MaybeRefOrGetter<boolean> } = {}) {
  return useQuery({
    queryKey: computed(() => [...keys.payees(), 'search', toValue(params)]),
    queryFn: () => {
      const p = toValue(params)
      return lapi.get<PayeeSearchResult[]>('/payees/search', { q: p.q, keys: p.keys && JSON.stringify(p.keys), limit: p.limit })
    },
    placeholderData: keepPreviousData,
    enabled: computed(() => toValue(opts.enabled) ?? true),
    staleTime: 60_000,
  })
}

// Custom reports ----------------------------------------------------------------

export function useCustomReports() {
  return useQuery({ queryKey: computed(() => [...keys.customReports(), 'list']), queryFn: () => lapi.get<CustomReport[]>('/custom-reports') })
}

/** One report (none for null). A 404 isn't retried: the page goes back to Everything. */
export function useCustomReport(id: MaybeRefOrGetter<number | null>) {
  return useQuery({
    queryKey: computed(() => [...keys.customReports(), 'one', toValue(id)]),
    queryFn: () => lapi.get<CustomReport>(`/custom-reports/${toValue(id)}`),
    enabled: computed(() => toValue(id) !== null),
    retry: (count, err) => (err as { status?: number }).status !== 404 && count < 2,
  })
}

export function useCustomReportMutations() {
  const qc = useQueryClient()
  const settle = (r?: CustomReport) => {
    if (r) qc.setQueryData([...keys.customReports(), 'one', r.id], r)
    return qc.invalidateQueries({ queryKey: [...keys.customReports(), 'list'] })
  }
  return {
    create: useMutation({ mutationFn: (input: CustomReportCreate) => lapi.post<CustomReport>('/custom-reports', input), onSuccess: settle }),
    update: useMutation({
      mutationFn: ({ id, ...input }: CustomReportUpdate & { id: number }) => lapi.patch<CustomReport>(`/custom-reports/${id}`, input),
      onSuccess: settle,
    }),
    reorder: useMutation({
      mutationFn: (ids: number[]) => lapi.put<CustomReport[]>('/custom-reports/order', { ids }),
      onSuccess: (list) => qc.setQueryData([...keys.customReports(), 'list'], list),
    }),
    remove: useMutation({
      mutationFn: (id: number) => lapi.del(`/custom-reports/${id}`),
      onSuccess: (_d, id) => {
        qc.removeQueries({ queryKey: [...keys.customReports(), 'one', id] })
        return settle()
      },
    }),
  }
}

export function useNetWorth(months: MaybeRefOrGetter<number>) {
  return useQuery({
    queryKey: computed(() => [...keys.reports(), 'net-worth', toValue(months)]),
    queryFn: () => lapi.get<NetWorthReport>('/reports/net-worth', { months: toValue(months) }),
    placeholderData: keepPreviousData,
  })
}

// Recurring -------------------------------------------------------------------

export function useRecurring(status?: MaybeRefOrGetter<RecurringStatus | undefined>) {
  return useQuery({
    queryKey: computed(() => [...keys.recurring(), 'list', toValue(status) ?? 'all']),
    queryFn: () => lapi.get<RecurringItem[]>('/recurring', { status: toValue(status) }),
  })
}

export function useUpcoming(days: MaybeRefOrGetter<number>) {
  return useQuery({
    queryKey: computed(() => [...keys.recurring(), 'upcoming', toValue(days)]),
    queryFn: () => lapi.get<UpcomingPayment[]>('/recurring/upcoming', { days: toValue(days) }),
  })
}

/** A recurring item's payments, newest first: the linked ones, or for a suggestion, the ones the scan found. */
export function useRecurringPayments(id: MaybeRefOrGetter<number>) {
  return useQuery({
    queryKey: computed(() => [...keys.recurring(), 'payments', toValue(id)]),
    queryFn: () => lapi.get<Transaction[]>(`/recurring/${toValue(id)}/transactions`),
  })
}

/**
 * Payments to add to a recurring item at their own amount, like a plan's down payment: from around its
 * dates, or with `q`, any that match (nothing while `id` is null).
 */
export function useRecurringPaymentCandidates(id: MaybeRefOrGetter<number | null>, q: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => [...keys.recurring(), 'payment-candidates', toValue(id), toValue(q)]),
    queryFn: () => lapi.get<RecurringPaymentCandidate[]>(`/recurring/${toValue(id)}/payment-candidates`, { q: toValue(q) || undefined }),
    enabled: computed(() => toValue(id) !== null),
  })
}

export function useRecurringMutations() {
  const invalidate = useInvalidateLedger()
  return {
    create: useMutation({ mutationFn: (input: RecurringCreate) => lapi.post<RecurringItem>('/recurring', input), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...input }: RecurringUpdate & { id: number }) => lapi.patch<RecurringItem>(`/recurring/${id}`, input),
      onSuccess: invalidate,
    }),
    confirm: useMutation({ mutationFn: (id: number) => lapi.post<RecurringItem>(`/recurring/${id}/confirm`), onSuccess: invalidate }),
    dismiss: useMutation({ mutationFn: (id: number) => lapi.post<RecurringItem>(`/recurring/${id}/dismiss`), onSuccess: invalidate }),
    /** A payment from another payee is the item's: its payee is added to the item. */
    linkPayment: useMutation({
      mutationFn: ({ id, transactionId }: { id: number; transactionId: number }) => lapi.post<RecurringItem>(`/recurring/${id}/link-payment`, { transactionId }),
      onSuccess: invalidate,
    }),
    /** A payment at its own amount (a plan's down payment, say): the item's amount stays. */
    addPayment: useMutation({
      mutationFn: ({ id, transactionId }: { id: number; transactionId: number }) => lapi.post<RecurringItem>(`/recurring/${id}/add-payment`, { transactionId }),
      onSuccess: invalidate,
    }),
    notPayment: useMutation({
      mutationFn: ({ id, transactionId }: { id: number; transactionId: number }) => lapi.post<RecurringItem>(`/recurring/${id}/not-payment`, { transactionId }),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: number) => lapi.del(`/recurring/${id}`), onSuccess: invalidate }),
    detect: useMutation({ mutationFn: () => lapi.post<{ created: number }>('/recurring/detect'), onSuccess: invalidate }),
  }
}

export function useAccountHistory(accountId: MaybeRefOrGetter<number>, months: MaybeRefOrGetter<number>) {
  return useQuery({
    queryKey: computed(() => [...keys.accounts(), toValue(accountId), 'history', toValue(months)]),
    queryFn: () =>
      lapi.get<BalancePoint[]>(`/accounts/${toValue(accountId)}/history`, {
        months: toValue(months),
      }),
    placeholderData: keepPreviousData,
  })
}

export function useImportBatches() {
  return useQuery({ queryKey: computed(() => keys.importBatches()), queryFn: () => lapi.get<ImportBatch[]>('/import/batches') })
}

export function useImportMutations() {
  const qc = useQueryClient()
  const invalidate = useInvalidateLedger()
  return {
    preview: useMutation({
      mutationFn: (input: ImportPreviewInput) => lapi.post<ImportPreviewRow[]>('/import/preview', input),
    }),
    commit: useMutation({
      mutationFn: (input: ImportCommitInput) => lapi.post<ImportResult & { batchId: number }>('/import/commit', input),
      onSuccess: () => {
        invalidate()
        qc.invalidateQueries({ queryKey: keys.importBatches() })
        qc.invalidateQueries({ queryKey: keys.aiStatus() })
      },
    }),
    undo: useMutation({
      mutationFn: (batchId: number) => lapi.del(`/import/batches/${batchId}`),
      onSuccess: () => {
        invalidate()
        qc.invalidateQueries({ queryKey: keys.importBatches() })
      },
    }),
  }
}

// Setup (welcome screen) ---------------------------------------------------------

export function useSetupStatus(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: computed(() => keys.setup()),
    queryFn: () => lapi.get<SetupStatus>('/setup'),
    staleTime: Infinity,
    enabled: computed(() => toValue(enabled)),
  })
}

export function useSetupMutations() {
  const qc = useQueryClient()
  // Everything changes after any of these, so refetch all data.
  const refreshAll = () => qc.invalidateQueries()
  return {
    start: useMutation({ mutationFn: () => lapi.post<SetupStatus>('/setup/start'), onSuccess: refreshAll }),
    demo: useMutation({
      mutationFn: () => lapi.post<{ transactions: number; recurringSuggestions: number }>('/setup/demo'),
      onSuccess: refreshAll,
    }),
    restore: useMutation({
      mutationFn: (file: File) => lapi.upload<{ accounts: number; transactions: number }>('/restore', file),
      onSuccess: refreshAll,
    }),
    erase: useMutation({
      mutationFn: () => lapi.post<{ backup: string | null }>('/erase', { confirm: 'erase' }),
      onSuccess: refreshAll,
    }),
  }
}

// Ledgers -------------------------------------------------------------------------

export function useLedgers() {
  const q = useQuery({ queryKey: keys.ledgers, queryFn: () => api.get<Ledger[]>('/ledgers'), staleTime: 30_000 })
  const all = computed(() => q.data.value ?? [])
  const active = computed(() => all.value.filter((l) => !l.archived))
  /** The ledger the app is showing. */
  const current = computed(() => all.value.find((l) => l.slug === currentLedger.value))
  return { ...q, all, active, current }
}

export function useLedgerMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: keys.ledgers })
  return {
    create: useMutation({ mutationFn: (input: LedgerCreate) => api.post<Ledger>('/ledgers', input), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, ...input }: LedgerUpdate & { id: string }) => api.patch<Ledger>(`/ledgers/${id}`, input),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: ({ id, confirm }: { id: string; confirm: string }) =>
        api.del<{ backup: string | null }>(`/ledgers/${id}`, { confirm }),
      onSuccess: refresh,
    }),
    /** Fills a ledger (usually just created) from an uploaded backup file. */
    restoreInto: useMutation({
      mutationFn: ({ slug, file }: { slug: string; file: File }) =>
        api.upload<{ accounts: number; transactions: number }>(`/ledgers/${encodeURIComponent(slug)}/restore`, file),
      onSuccess: refresh,
    }),
  }
}

// API keys ------------------------------------------------------------------------

export function useApiKeys() {
  return useQuery({ queryKey: keys.apiKeys, queryFn: () => api.get<ApiKey[]>('/api-keys') })
}

export function useApiKeyMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: keys.apiKeys })
  return {
    create: useMutation({ mutationFn: (input: ApiKeyCreate) => api.post<ApiKeyCreated>('/api-keys', input), onSuccess: refresh }),
    revoke: useMutation({ mutationFn: (id: string) => api.del(`/api-keys/${id}`), onSuccess: refresh }),
  }
}

// Activity ------------------------------------------------------------------------

export function useActivity(filters: MaybeRefOrGetter<{ actor?: string; entity?: string }>) {
  return useInfiniteQuery({
    queryKey: computed(() => [...keys.activity(), toValue(filters)]),
    queryFn: ({ pageParam }) => lapi.get<ActivityPage>('/activity', { ...toValue(filters), cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
}

export function useActivityActors() {
  return useQuery({ queryKey: computed(() => [...keys.activity(), 'actors']), queryFn: () => lapi.get<string[]>('/activity/actors') })
}

// Bank sync -----------------------------------------------------------------------

export function useBankConnections(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: keys.bank,
    queryFn: () => api.get<BankConnection[]>('/bank/connections'),
    enabled: computed(() => toValue(enabled)),
  })
}

export function useBankMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: keys.bank })
  // A sync can touch any ledger's accounts, transactions and reports.
  const refreshAll = () => qc.invalidateQueries()
  return {
    connect: useMutation({ mutationFn: (input: Omit<BankConnectionCreate, 'provider'>) => api.post<BankConnection>('/bank/connections', input), onSuccess: refresh }),
    /** Plaid Link's token, to add a bank or (with a connection) sign in to it again. */
    plaidLinkToken: useMutation({ mutationFn: (input: PlaidLinkTokenRequest) => api.post<PlaidLinkToken>('/bank/plaid/link-token', input) }),
    plaidConnect: useMutation({ mutationFn: (input: PlaidConnect) => api.post<BankConnection>('/bank/plaid/connections', input), onSuccess: refresh }),
    /** Signing in again catches up its accounts, which can touch any ledger. */
    wealthsimpleConnect: useMutation({
      mutationFn: (input: WealthsimpleConnect) => api.post<WealthsimpleConnectResult>('/bank/wealthsimple/connections', input),
      onSuccess: refreshAll,
    }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<BankConnection>(`/bank/connections/${id}`, { name }), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/bank/connections/${id}`), onSuccess: refreshAll }),
    sync: useMutation({ mutationFn: (id: string) => api.post<SyncResult>(`/bank/connections/${id}/sync`), onSettled: refreshAll }),
    /** A sync of all the history the provider gives, not just what's new. */
    fetchHistory: useMutation({ mutationFn: (id: string) => api.post<SyncResult>(`/bank/connections/${id}/fetch-history`), onSettled: refreshAll }),
  }
}

/** Bank accounts this ledger can sync from (for switching an account to synced). */
export function useLinkableBankAccounts(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: computed(() => [...keys.accounts(), 'bank']),
    queryFn: () => lapi.get<LinkableBankAccount[]>('/bank-accounts'),
    enabled: computed(() => toValue(enabled)),
  })
}

/** Switching an account between synced and manual. */
export function useAccountBankMutations() {
  const qc = useQueryClient()
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: keys.accounts() }), qc.invalidateQueries({ queryKey: keys.bank })])
  return {
    /** It takes the bank account's kept transactions straight away, so everything refreshes. */
    link: useMutation({
      mutationFn: ({ id, ...input }: AccountBankLink & { id: number }) => lapi.put<Account>(`/accounts/${id}/bank`, input),
      onSuccess: () => qc.invalidateQueries(),
    }),
    unlink: useMutation({ mutationFn: (id: number) => lapi.del<Account>(`/accounts/${id}/bank`), onSuccess: refresh }),
    /**
     * The account's transactions next to the bank account's kept ones, to review before switching.
     * Nothing changes, and their connections don't sync on their own until `endReview`.
     */
    preview: useMutation({
      mutationFn: ({ id, ...input }: AccountBankPreview & { id: number }) => lapi.post<LinkPreview>(`/accounts/${id}/bank/preview`, input),
    }),
    endReview: useMutation({ mutationFn: (id: number) => lapi.del(`/accounts/${id}/bank/preview`) }),
    /** Switching as reviewed changes transactions, so everything refreshes. */
    switchTo: useMutation({
      mutationFn: ({ id, ...input }: AccountBankSwitch & { id: number }) =>
        lapi.post<{ account: Account; result: SwitchResult }>(`/accounts/${id}/bank/switch`, input),
      onSuccess: () => qc.invalidateQueries(),
    }),
  }
}
