import { z } from 'zod'
import {
  aiTestResultSchema,
  aiTestSchema,
  chatgptFinishSchema,
  chatgptModelSchema,
  chatgptStatusSchema,
  aiRetrySchema,
  aiUsageSchema,
  apiKeyCreatedSchema,
  apiKeyCreateSchema,
  apiKeySchema,
  bankConnectionCreateSchema,
  bankConnectionSchema,
  bankConnectionUpdateSchema,
  categoryCreateSchema,
  categoryGroupSchema,
  categoryListSchema,
  categoryMergeResultSchema,
  categoryMergeSchema,
  categorySchema,
  categoryUpdateSchema,
  groupCreateSchema,
  groupUpdateSchema,
  labelCategoriesSchema,
  labelCreateSchema,
  labelSchema,
  labelUpdateSchema,
  ledgerCreateSchema,
  ledgerActionResultSchema,
  ledgerDeleteSchema,
  ledgerSchema,
  ledgerUpdateResultSchema,
  ledgerUpdateSchema,
  settingsSchema,
  settingsUpdateSchema,
  plaidConnectSchema,
  wealthsimpleConnectResultSchema,
  wealthsimpleConnectSchema,
  reorderSchema,
  plaidLinkTokenRequestSchema,
  plaidLinkTokenSchema,
  syncResultSchema,
  type BankConnection,
  payeeNamePreviewQuerySchema,
  payeeNamePreviewSchema,
  payeeNameRuleCreateSchema,
  payeeNameRuleOrderSchema,
  payeeNameRuleSchema,
  payeeWordingsNameSchema,
  payeeNameRuleUpdateSchema,
  payeeTidyAgainSchema,
  payeeTidyPreviewQuerySchema,
  payeeTidyPreviewSchema,
  payeeTidyStatusSchema,
  payeeTidyUpdateSchema,
} from '@chipmunk/shared'
import { recorded } from '../ai/records'
import { runSlot } from '../ai/runner'
import { actorName, canUseLedger, createApiKey, listApiKeys, requireLedger, revokeApiKey } from '../api/auth'
import { ApiRouter, type BaseEnv } from '../api/router'
import { HTTPException } from 'hono/http-exception'
import { badRequest } from '../lib/http'
import type { BankService } from '../services/bank/service'
import { diff, recordActivity } from '../services/activity'
import { aiUsage, retryAll } from '../services/ai-requests'
import * as catalog from '../services/catalog-edit'
import * as cats from '../services/categories'
import * as names from '../services/payee-names'
import * as tidy from '../services/payee-tidy'
import { chatgptModels, chatgptStatus, finishChatgptSignIn, signOutChatgpt, startChatgptSignIn } from '../services/chatgpt'
import { publicSettings, today, updateSettings } from '../services/settings'
import { env } from '../env'
import * as setup from '../services/setup'
import { fullBackup, type Storage } from '../storage'
import { AI_USAGE, aiCaller } from './ledger'

const ledgerParam = z.object({ ledger: z.string().min(1) })

/** App-wide routes: who's calling, ledgers, app settings, API keys and the full backup. */
export function appRoutes(storage: Storage, bank: BankService) {
  const r = new ApiRouter<BaseEnv>({ mount: '', tag: 'Ledgers', sqlite: storage.sqlite })
  const { registry, app: meta } = storage
  const logTo = (ledgerId: string, actor: BaseEnv['Variables']['actor'], summary: string, extra: { before?: unknown; after?: unknown } = {}) =>
    recordActivity(registry.context(ledgerId), { name: actorName(actor), apiKeyId: actor.kind === 'key' ? actor.key.id : null }, {
      action: 'update',
      entity: 'ledger',
      entityId: ledgerId,
      summary,
      ...extra,
    })

  /** Who is acting, and the ledgers they may use, for what's asked before a ledger is deleted or archived. */
  const acting = (actor: BaseEnv['Variables']['actor']) => ({
    actor: { name: actorName(actor), apiKeyId: actor.kind === 'key' ? actor.key.id : null },
    allowed: actor.kind === 'key' && actor.key.ledgers ? new Set(actor.key.ledgers) : null,
  })

  /**
   * What belongs to the whole app (API keys, the full backup, app settings, payee names, bank
   * connections, new ledgers) is for keys that can use every ledger: a key limited to some can't
   * reach past them, say by making itself an unlimited key.
   */
  const requireAllLedgers = (
    actor: BaseEnv['Variables']['actor'],
    message = 'That’s for the whole app, so a key limited to some ledgers can’t use it.',
  ) => {
    if (actor.kind === 'key' && actor.key.ledgers) throw new HTTPException(403, { message })
  }

  /** The ledgers this caller can use, each as its context. */
  const usable = (actor: BaseEnv['Variables']['actor']) =>
    registry
      .list()
      .filter((l) => canUseLedger(actor, l.id))
      .map((l) => registry.context(l.id))

  const DEFAULT_LEDGER = 'Which ledger the app opens, and the ledgers’ order, are for the whole app, so a key limited to some ledgers can’t change them.'

  // Me -------------------------------------------------------------------
  r.get(
    '/me',
    {
      tag: 'Me',
      scope: 'read',
      summary: 'Get the current caller',
      description: 'The API key’s name, scopes and ledgers (or the web app), and the ledger to use when none is given.',
      response: z
        .object({
          actor: z.string(),
          kind: z.enum(['web', 'key']),
          scopes: z.array(z.enum(['read', 'write', 'admin'])),
          ledgers: z.array(z.string()).nullable().describe('Ledger ids this caller can use. Null means every ledger.'),
          defaultLedger: z.string().nullable().describe('Slug of the ledger to use when none is given.'),
        })
        .meta({ id: 'Me' }),
    },
    (c) => {
      const actor = c.var.actor
      const usable = registry.list().filter((l) => !l.archived && canUseLedger(actor, l.id))
      const preferred = usable.find((l) => l.id === registry.defaultLedger().id) ?? usable[0]
      return {
        actor: actorName(actor),
        kind: actor.kind,
        scopes: actor.kind === 'web' ? (['read', 'write', 'admin'] as const) : actor.key.scopes,
        ledgers: actor.kind === 'web' ? null : actor.key.ledgers,
        defaultLedger: preferred?.slug ?? null,
      }
    },
  )

  // Ledgers --------------------------------------------------------------
  r.get('/ledgers', { scope: 'read', summary: 'List ledgers', description: 'Archived ledgers included.', response: z.array(ledgerSchema) }, (c) =>
    registry.list().filter((l) => canUseLedger(c.var.actor, l.id)),
  )
  r.post(
    '/ledgers',
    {
      scope: 'admin',
      summary: 'Create a ledger',
      description: '`start: "empty"` marks it as set up; `"demo"` loads sample data; leave it out to show the welcome screen in the app.',
      body: ledgerCreateSchema,
      response: ledgerSchema,
      status: 201,
    },
    (c, { body }) => {
      requireAllLedgers(c.var.actor)
      const row = registry.create(body)
      const ctx = registry.context(row.id)
      if (body.start === 'demo') setup.startDemo(ctx)
      else if (body.start === 'empty') setup.startEmpty(ctx)
      logTo(row.id, c.var.actor, `Created the ledger ${row.name}`)
      return registry.toDTO(registry.get(row.id))
    },
  )
  r.get('/ledgers/:ledger', { scope: 'read', summary: 'Get a ledger', params: ledgerParam, response: ledgerSchema }, (c, { params }) => {
    const row = registry.get(params.ledger)
    requireLedger(c.var.actor, row.id)
    return registry.toDTO(row)
  })
  r.patch(
    '/ledgers/:ledger',
    {
      scope: 'admin',
      summary: 'Update a ledger',
      description:
        'Rename (the slug follows the name), recolour, reorder, archive, or make it the default (not with a key limited to some ledgers). Archiving a ledger that has a shared account asks first (GET /ledgers/{ledger}/questions?action=archive): send the answers as `answers`, or it’s refused with a 409. The ledger keeps the accounts shared with it and its transactions on them, and a sync still updates those. `changes` says what archiving did. Try it with `dryRun=true` first.',
      params: ledgerParam,
      body: ledgerUpdateSchema,
      response: ledgerUpdateResultSchema,
      dryRun: true,
    },
    (c, { params, body, dryRun }) => {
      const before = registry.toDTO(registry.get(params.ledger), false)
      requireLedger(c.var.actor, before.id)
      // Which ledger the app opens, and the ledgers' order (the first one opens when none is chosen), are the whole app's.
      const isDefault = registry.defaultLedger().id === before.id
      if (body.isDefault || body.sort !== undefined || (body.archived && isDefault)) requireAllLedgers(c.var.actor, DEFAULT_LEDGER)
      const { row, changes } = registry.change(before.id, body, acting(c.var.actor))
      const after = registry.toDTO(row, false)
      const d = diff(before, after)
      if (d) logTo(after.id, c.var.actor, `Edited the ledger ${before.name}`, d)
      return { ...registry.toDTO(registry.get(after.id)), changes, dryRun }
    },
  )
  r.delete(
    '/ledgers/:ledger',
    {
      scope: 'admin',
      summary: 'Delete a ledger',
      description:
        'Deletes the ledger and all its data, after saving a copy of the whole database in data/backups (`pre-delete-<slug>-<time>.db`). Send its name as `confirm`. A ledger that has a shared account asks first (GET /ledgers/{ledger}/questions?action=delete): send the answers as `answers`, or it’s refused with a 409. `changes` says what was done, in every ledger it touched. With `dryRun=true` it says what would be done, changes nothing and saves no copy.',
      params: ledgerParam,
      body: ledgerDeleteSchema,
      response: ledgerActionResultSchema,
      dryRun: true,
    },
    (c, { params, body, dryRun }) => {
      const row = registry.get(params.ledger)
      requireLedger(c.var.actor, row.id)
      if (registry.defaultLedger().id === row.id) requireAllLedgers(c.var.actor, DEFAULT_LEDGER)
      if (body.confirm !== row.name) badRequest(`Type the ledger's name, “${row.name}”, to delete it`)
      return { ...registry.remove(row.id, { answers: body.answers, ...acting(c.var.actor) }), dryRun }
    },
  )
  r.get(
    '/backup/full',
    {
      tag: 'Data',
      scope: 'admin',
      summary: 'Download a full backup',
      description: 'A zip of the whole database (every ledger and the app settings) and a manifest saying how to restore it, for moving to another machine. secret.key isn’t in it, so copy that file over separately.',
      file: { contentType: 'application/zip', description: 'chipmunk.db and manifest.json' },
    },
    (c) => {
      requireAllLedgers(c.var.actor)
      const { bytes, fileName } = fullBackup(storage)
      c.header('Content-Type', 'application/zip')
      c.header('Content-Disposition', `attachment; filename="${fileName}"`)
      return c.body(new Uint8Array(bytes))
    },
  )

  // Settings -------------------------------------------------------------
  const set = { tag: 'Settings' } as const
  r.get('/settings', { ...set, scope: 'read', summary: 'Get app settings', description: 'API keys of AI providers are never returned, only a hint.', response: settingsSchema }, () =>
    publicSettings(meta, storage.now),
  )
  r.patch(
    '/settings',
    {
      ...set,
      scope: 'admin',
      summary: 'Update app settings',
      description: 'For an AI provider, leave out `apiKey` to keep the stored key, or send null to remove it.',
      body: settingsUpdateSchema,
      response: settingsSchema,
    },
    (c, { body }) => {
      requireAllLedgers(c.var.actor)
      updateSettings(meta, body)
      return publicSettings(meta, storage.now)
    },
  )
  // Payee names: your rules and AI tidying, for every ledger ----------------------------------
  const pay = { tag: 'Payees' } as const
  // Payee names are made across every ledger, and what's listed comes from all of them.
  const world = (actor: BaseEnv['Variables']['actor']) => {
    requireAllLedgers(actor)
    return names.worldOf(storage)
  }
  const changed = z.object({ changed: z.number().int().describe('Transactions that became another payee, in every ledger.') })
  r.get(
    '/payees/name-rules',
    {
      ...pay,
      scope: 'read',
      summary: 'List the payee name rules',
      description:
        'Your rules for what payees are called, in every ledger, in the order they apply: names that are one payee, or a regex on the payee as sent. They come before AI tidying. A transaction’s `payeeName` is what they make of its payee, and `payeeKey` which payee it is.',
      response: z.array(payeeNameRuleSchema),
    },
    (c) => names.listNameRules(world(c.var.actor)),
  )
  r.post(
    '/payees/name-rules',
    {
      ...pay,
      scope: 'admin',
      summary: 'Add a payee name rule',
      description: 'It applies after your others. Transactions it makes into another payee carry over what was set for the old one (learned categories, choices for it, recurring items).',
      body: payeeNameRuleCreateSchema,
      response: changed.extend({ rule: payeeNameRuleSchema }),
      status: 201,
    },
    (c, { body }) => names.createNameRule(world(c.var.actor), body),
  )
  r.patch(
    '/payees/name-rules/:id',
    { ...pay, scope: 'admin', summary: 'Change a payee name rule', description: 'Only the fields you send change (`enabled` turns it off or on).', body: payeeNameRuleUpdateSchema, response: changed.extend({ rule: payeeNameRuleSchema }) },
    (c, { params, body }) => names.updateNameRule(world(c.var.actor), params.id, body),
  )
  r.delete('/payees/name-rules/:id', { ...pay, scope: 'admin', summary: 'Remove a payee name rule', response: changed }, (c, { params }) => names.deleteNameRule(world(c.var.actor), params.id))
  r.post(
    '/payees/wordings/name',
    {
      ...pay,
      scope: 'admin',
      summary: 'Name payees as sent',
      description:
        'Payees as the bank or file sent them are called `name`, in every ledger, by one rule: one with that name already, or a new one. They come off your rules that named them by their wording before. Null: off your rules, they go by what AI tidying called them.',
      body: payeeWordingsNameSchema,
      response: changed.extend({ rule: payeeNameRuleSchema.nullable() }),
    },
    (c, { body }) => names.nameWordings(world(c.var.actor), body),
  )
  r.put(
    '/payees/name-rules/order',
    { ...pay, scope: 'admin', summary: 'Order the payee name rules', description: 'The first rule that names a payee wins.', body: payeeNameRuleOrderSchema, response: changed },
    (c, { body }) => names.orderNameRules(world(c.var.actor), body.ids),
  )
  r.post(
    '/payees/name-rules/preview',
    {
      ...pay,
      scope: 'read',
      summary: 'Preview a change to the payee name rules',
      description: 'What payee names a rule (new or changed) or removing one would make, in every ledger, before it’s saved.',
      body: payeeNamePreviewQuerySchema,
      response: payeeNamePreviewSchema,
    },
    (c, { body }) => names.previewNameRules(world(c.var.actor), body),
  )
  r.get(
    '/payees/tidy',
    {
      ...pay,
      scope: 'read',
      summary: 'Get AI tidying of payee names',
      description: 'Whether AI names payees, how far the background run is, and every payee it named (as sent → its name).',
      response: payeeTidyStatusSchema,
    },
    (c) => tidy.tidyStatus(world(c.var.actor)),
  )
  r.post(
    '/payees/tidy/preview',
    {
      ...pay,
      scope: 'admin',
      summary: 'Preview AI tidying',
      description: 'AI names a batch of 20 payees (the messiest and most used first), to see what it does before turning it on. What it says is kept, so they aren’t asked again.',
      body: payeeTidyPreviewQuerySchema,
      response: payeeTidyPreviewSchema,
    },
    (c, { body }) => tidy.previewTidy(world(c.var.actor), body.page),
  )
  r.put(
    '/payees/tidy',
    {
      ...pay,
      scope: 'admin',
      summary: 'Turn AI tidying on or off',
      description: 'On: every payee not named yet is, in the background, in batches, and new ones as they come. Off: payees are called what the bank sent again (what AI said is kept for later).',
      body: payeeTidyUpdateSchema,
      response: payeeTidyStatusSchema,
    },
    (c, { body }) => tidy.setAiTidy(world(c.var.actor), body.enabled),
  )
  r.post(
    '/payees/tidy/again',
    { ...pay, scope: 'admin', summary: 'Ask AI to name payees again', description: 'They’re asked together, so AI sees them side by side.', body: payeeTidyAgainSchema, response: payeeTidyStatusSchema },
    (c, { body }) => tidy.tidyAgain(world(c.var.actor), body.originals),
  )

  r.post(
    '/settings/ai/test',
    {
      ...set,
      scope: 'admin',
      summary: 'Test an AI provider',
      description: 'Asks the provider to categorize a sample transaction using the default ledger’s categories. It’s recorded in that ledger’s AI usage as a connection test.',
      body: aiTestSchema,
      response: aiTestResultSchema,
    },
    async (c, { body }) => {
      requireAllLedgers(c.var.actor)
      const ctx = registry.defaultContext()
      const started = Date.now()
      const { categories } = cats.listCategories(ctx)
      try {
        // Recorded with the default ledger's AI usage, as a test: nothing asks it again.
        const res = await recorded(
          ctx,
          { kind: 'test', subject: null, key: null },
          (log) =>
            runSlot(
              ctx,
              body.slot,
              {
                payee: 'TIM HORTONS #4410 TORONTO ON',
                amountMinor: -485,
                date: today(ctx),
                accountType: 'credit',
                notes: null,
                categories: categories
                  .filter((x) => !x.archived && !x.excludeFromTotals)
                  .map((x) => ({ name: x.name, group: null, isIncome: x.isIncome })),
                examples: [],
              },
              log,
            ),
          (res) => ({ outcome: res.category }),
        )
        return { ok: true, category: res.category, confidence: res.confidence, model: res.model, latencyMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started }
      }
    },
  )
  r.get(
    '/settings/ai/chatgpt',
    {
      ...set,
      scope: 'admin',
      summary: 'Get the ChatGPT sign-in',
      description: 'Whether this app is signed in with ChatGPT, for the “OpenAI (sign in with ChatGPT)” AI provider, which uses your ChatGPT plan instead of an API key.',
      response: chatgptStatusSchema,
    },
    (c) => {
      requireAllLedgers(c.var.actor)
      return chatgptStatus(meta)
    },
  )
  r.post(
    '/settings/ai/chatgpt/sign-in',
    {
      ...set,
      scope: 'admin',
      summary: 'Start signing in with ChatGPT',
      description:
        'Returns the address to open in a browser to sign in to ChatGPT and allow this app to use your plan. OpenAI then sends the browser to http://127.0.0.1:<this server’s port>/auth/callback, which finishes it when the browser runs on the same machine as this server. Otherwise POST the address it ended on to /settings/ai/chatgpt/finish. It expires in 15 minutes.',
      response: z.object({ url: z.string() }),
    },
    (c) => {
      requireAllLedgers(c.var.actor)
      return startChatgptSignIn(meta, env.port)
    },
  )
  r.post(
    '/settings/ai/chatgpt/finish',
    {
      ...set,
      scope: 'admin',
      summary: 'Finish signing in with ChatGPT',
      description: 'With the address the browser ended on after you approved, when it couldn’t reach this server on its own.',
      body: chatgptFinishSchema,
      response: chatgptStatusSchema,
    },
    async (c, { body }) => {
      requireAllLedgers(c.var.actor)
      let url: URL
      try {
        url = new URL(body.url)
      } catch {
        badRequest('That isn’t an address. Copy the whole address of the page it ended on.')
      }
      return finishChatgptSignIn(meta, Object.fromEntries(url.searchParams))
    },
  )
  r.delete(
    '/settings/ai/chatgpt',
    {
      ...set,
      scope: 'admin',
      summary: 'Sign out of ChatGPT',
      description: 'OpenAI is told to end the session and the tokens are forgotten. `note` says when OpenAI couldn’t confirm it.',
      response: z.object({ note: z.string().nullable() }),
    },
    (c) => {
      requireAllLedgers(c.var.actor)
      return signOutChatgpt(meta)
    },
  )
  r.get(
    '/settings/ai/chatgpt/models',
    {
      ...set,
      scope: 'admin',
      summary: 'List the models your ChatGPT plan offers',
      description: 'As OpenAI lists them for the signed-in account. None until you sign in (with ChatGPT plan usage enabled).',
      response: z.array(chatgptModelSchema),
    },
    async (c) => {
      requireAllLedgers(c.var.actor)
      const status = chatgptStatus(meta)
      if (!status.signedIn || !status.planUsage) return []
      try {
        return await chatgptModels(meta)
      } catch (err) {
        badRequest(err instanceof Error ? err.message : String(err))
      }
    },
  )
  r.get(
    '/ai/usage',
    {
      ...set,
      scope: 'read',
      summary: 'Get AI usage',
      description: `Across every ledger you can use. ${AI_USAGE}`,
      response: aiUsageSchema,
    },
    (c) => aiUsage(usable(c.var.actor), aiCaller(c.var.actor, names.worldOf(storage))),
  )
  r.post(
    '/ai/usage/retry',
    {
      ...set,
      scope: 'write',
      summary: 'Ask AI again about every failed request',
      description:
        'Every failed record that can be retried (`retryable`), in each ledger you can use, not only the ones GET /ai/usage lists: as POST /ledgers/{ledger}/ai/usage/{id}/retry does for one, in the background. A ledger where AI is already working is left for now (`working`). A key limited to some ledgers asks about those only, and never for payee names, which are made across every ledger.',
      response: aiRetrySchema,
      status: 202,
    },
    (c) => {
      const actor = c.var.actor
      const by = { name: actorName(actor), apiKeyId: actor.kind === 'key' ? actor.key.id : null }
      return retryAll(usable(actor), aiCaller(actor, names.worldOf(storage)), (ctx, count) =>
        recordActivity(ctx, by, { action: 'categorize', entity: 'transaction', summary: `Asked AI again about ${count} failed request${count === 1 ? '' : 's'}` }),
      )
    },
  )

  // The shared category list ----------------------------------------------
  // Every ledger uses these categories, turning each on or off for itself (PATCH /ledgers/{ledger}/categories/{id}).
  const cat = { tag: 'Categories' } as const
  const SHARED_LIST = 'The category list is shared by every ledger, so a key limited to some ledgers can’t change it.'
  const numId = z.object({ id: z.coerce.number().int().positive() })
  /** Changes to the list are in every ledger's activity. */
  const logAll = (actor: BaseEnv['Variables']['actor'], entry: Omit<Parameters<typeof recordActivity>[2], 'action'> & { action?: string }) => {
    for (const l of registry.list()) {
      recordActivity(registry.context(l.id), { name: actorName(actor), apiKeyId: actor.kind === 'key' ? actor.key.id : null }, { action: 'update', ...entry })
    }
  }
  const changes = (before: object, after: object) => {
    const d = diff(before, after)
    return d ? { before: d.before, after: d.after } : null
  }

  r.get(
    '/categories',
    {
      ...cat,
      scope: 'read',
      summary: 'List the shared categories',
      description:
        'Every group, category and label, shared by all ledgers, with how many transactions use each category across the ledgers that share them (for a key limited to some ledgers, across those). Each ledger’s own list (GET /ledgers/{ledger}/categories) also says which are on there.',
      response: categoryListSchema,
    },
    // Counted only in the ledgers the caller can use.
    (c) => catalog.listCatalog(storage, catalog.catalogUsage(storage, (id) => canUseLedger(c.var.actor, id))),
  )
  r.post(
    '/categories',
    { ...cat, scope: 'write', summary: 'Add a shared category', description: 'It’s added to every ledger, turned on.', body: categoryCreateSchema, response: categorySchema, status: 201 },
    (c, { body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const x = catalog.createCatalogCategory(storage, body)
      logAll(c.var.actor, { action: 'create', entity: 'category', entityId: x.id, summary: `Added the category ${x.name}`, after: x })
      return x
    },
  )
  r.post(
    '/categories/reorder',
    { ...cat, scope: 'write', summary: 'Reorder shared categories', description: 'Send category ids in the new order.', body: reorderSchema, response: categoryListSchema },
    (c, { body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      catalog.reorderCatalog(storage, 'categories', body.ids)
      return catalog.listCatalog(storage, catalog.catalogUsage(storage))
    },
  )
  r.patch(
    '/categories/:id',
    { ...cat, scope: 'write', summary: 'Update a shared category', description: 'Name, group, labels and how it counts, in every ledger.', params: numId, body: categoryUpdateSchema, response: categorySchema },
    (c, { params, body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const before = catalog.getCatalogCategory(storage, params.id)
      const after = catalog.updateCatalogCategory(storage, params.id, body)
      const d = changes(before, after)
      if (d) logAll(c.var.actor, { entity: 'category', entityId: after.id, summary: `Edited the category ${before.name}`, ...d })
      return after
    },
  )
  r.delete(
    '/categories/:id',
    {
      ...cat,
      scope: 'write',
      summary: 'Delete a shared category',
      description: 'From every ledger: its transactions there become uncategorized. To keep them categorized, merge it into another instead.',
      params: numId,
      status: 204,
    },
    (c, { params }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const before = catalog.deleteCatalogCategory(storage, params.id)
      logAll(c.var.actor, { action: 'delete', entity: 'category', entityId: before.id, summary: `Deleted the category ${before.name}`, before })
    },
  )
  r.post(
    '/categories/:id/merge',
    {
      ...cat,
      scope: 'write',
      summary: 'Merge a shared category into another',
      description:
        'In every ledger, moves its transactions, recurring payments and learned payees to `into`, then deletes it. `into` keeps its own name, group and labels.',
      params: numId,
      body: categoryMergeSchema,
      response: categoryMergeResultSchema,
    },
    (c, { params, body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const { from, reports, ...result } = catalog.mergeCatalogCategory(storage, params.id, body.into)
      logAll(c.var.actor, {
        action: 'delete',
        entity: 'category',
        entityId: from.id,
        summary: `Merged the category ${from.name} into ${result.into.name}${reports ? `, with the ${reports} custom report${reports === 1 ? '' : 's'} that used it` : ''}`,
        before: from,
        after: { into: result.into.id },
      })
      return result
    },
  )

  r.post(
    '/category-groups',
    { ...cat, scope: 'write', summary: 'Add a shared category group', body: groupCreateSchema, response: categoryGroupSchema, status: 201 },
    (c, { body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const g = catalog.createCatalogGroup(storage, body)
      logAll(c.var.actor, { action: 'create', entity: 'category_group', entityId: g.id, summary: `Added the group ${g.name}`, after: g })
      return g
    },
  )
  r.post(
    '/category-groups/reorder',
    { ...cat, scope: 'write', summary: 'Reorder shared category groups', body: reorderSchema, response: categoryListSchema },
    (c, { body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      catalog.reorderCatalog(storage, 'category_groups', body.ids)
      return catalog.listCatalog(storage, catalog.catalogUsage(storage))
    },
  )
  r.patch(
    '/category-groups/:id',
    { ...cat, scope: 'write', summary: 'Update a shared category group', params: numId, body: groupUpdateSchema, response: categoryGroupSchema },
    (c, { params, body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const before = catalog.getCatalogGroup(storage, params.id)
      const after = catalog.updateCatalogGroup(storage, params.id, body)
      const d = changes(before, after)
      if (d) logAll(c.var.actor, { entity: 'category_group', entityId: after.id, summary: `Edited the group ${before.name}`, ...d })
      return after
    },
  )
  r.delete(
    '/category-groups/:id',
    {
      ...cat,
      scope: 'write',
      summary: 'Delete a shared category group',
      description: 'Also deletes its categories; in every ledger, their transactions become uncategorized. To keep a category, move it to another group first.',
      params: numId,
      status: 204,
    },
    (c, { params }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const before = catalog.getCatalogGroup(storage, params.id)
      const removed = catalog.deleteCatalogGroup(storage, params.id)
      const what = removed.length ? ` and its categories (${removed.map((x) => x.name).join(', ')})` : ''
      logAll(c.var.actor, { action: 'delete', entity: 'category_group', entityId: before.id, summary: `Deleted the group ${before.name}${what}`, before })
    },
  )

  // Labels: another way to sort categories, across the groups (say, needs and wants).
  r.post(
    '/labels',
    { ...cat, scope: 'write', summary: 'Add a shared label', description: 'Names are unique, whatever their case.', body: labelCreateSchema, response: labelSchema, status: 201 },
    (c, { body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const l = catalog.createCatalogLabel(storage, body)
      logAll(c.var.actor, { action: 'create', entity: 'label', entityId: l.id, summary: `Added the label ${l.name}`, after: l })
      return l
    },
  )
  r.patch(
    '/labels/:id',
    { ...cat, scope: 'write', summary: 'Update a shared label', params: numId, body: labelUpdateSchema, response: labelSchema },
    (c, { params, body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const before = catalog.getCatalogLabel(storage, params.id)
      const after = catalog.updateCatalogLabel(storage, params.id, body)
      const d = changes(before, after)
      if (d) logAll(c.var.actor, { entity: 'label', entityId: after.id, summary: `Edited the label ${before.name}`, ...d })
      return after
    },
  )
  r.delete(
    '/labels/:id',
    { ...cat, scope: 'write', summary: 'Delete a shared label', description: 'Its categories just lose the label.', params: numId, status: 204 },
    (c, { params }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const before = catalog.deleteCatalogLabel(storage, params.id)
      logAll(c.var.actor, { action: 'delete', entity: 'label', entityId: before.id, summary: `Deleted the label ${before.name}`, before })
    },
  )
  r.post(
    '/labels/:id/categories',
    {
      ...cat,
      scope: 'write',
      summary: 'Put a shared label on categories',
      description: 'Puts the label on the categories in `add` and takes it off those in `remove`; others keep theirs.',
      params: numId,
      body: labelCategoriesSchema,
      response: labelSchema,
    },
    (c, { params, body }) => {
      requireAllLedgers(c.var.actor, SHARED_LIST)
      const l = catalog.applyCatalogLabel(storage, params.id, body)
      const names = (ids: number[]) => ids.map((id) => catalog.getCatalogCategory(storage, id).name).join(', ')
      const parts = [body.add.length && `put it on ${names(body.add)}`, body.remove.length && `took it off ${names(body.remove)}`].filter(Boolean)
      if (parts.length) logAll(c.var.actor, { entity: 'label', entityId: l.id, summary: `Label ${l.name}: ${parts.join('; ')}`, after: body })
      return l
    },
  )

  // API keys -------------------------------------------------------------
  const keys = { tag: 'API keys' } as const
  r.get('/api-keys', { ...keys, scope: 'admin', summary: 'List API keys', response: z.array(apiKeySchema) }, (c) => {
    requireAllLedgers(c.var.actor)
    return listApiKeys(meta)
  })
  r.post(
    '/api-keys',
    {
      ...keys,
      scope: 'admin',
      summary: 'Create an API key',
      description: 'The response has the full key. It is only shown once, so store it right away.',
      body: apiKeyCreateSchema,
      response: apiKeyCreatedSchema,
      status: 201,
    },
    (c, { body }) => {
      requireAllLedgers(c.var.actor)
      return createApiKey(meta, registry, body, storage.now())
    },
  )
  r.delete(
    '/api-keys/:id',
    { ...keys, scope: 'admin', summary: 'Revoke an API key', description: 'Requests with the key stop working at once.', params: z.object({ id: z.string().min(1) }), status: 204 },
    (c, { params }) => {
      requireAllLedgers(c.var.actor)
      revokeApiKey(meta, params.id)
    },
  )

  // Bank sync ------------------------------------------------------------
  const banks = { tag: 'Bank sync' } as const
  const idParam = z.object({ id: z.string().min(1) })
  /** A key limited to some ledgers can only sync connections that feed just those ledgers. */
  const requireConnectionLedgers = (actor: BaseEnv['Variables']['actor'], conn: BankConnection) => {
    if (conn.accounts.some((a) => a.link && !canUseLedger(actor, a.link.ledgerId))) {
      throw new HTTPException(403, { message: 'This connection syncs into ledgers this API key can’t use.' })
    }
  }
  r.get(
    '/bank/connections',
    { ...banks, scope: 'admin', summary: 'List bank connections', description: 'Each connection with its accounts, how they’re linked, and the last sync.', response: z.array(bankConnectionSchema) },
    (c) => {
      requireAllLedgers(c.var.actor)
      return bank.list()
    },
  )
  r.post(
    '/bank/connections',
    {
      ...banks,
      scope: 'admin',
      summary: 'Connect SimpleFIN',
      description:
        'Claims a setup token from SimpleFIN Bridge (https://bridge.simplefin.org/simplefin/create) and lists the accounts it can see. A setup token works once. The access it returns is stored encrypted. Then switch accounts to synced with PUT /ledgers/{ledger}/accounts/{id}/bank, or create synced accounts. Only while bank sync uses SimpleFIN (see POST /bank/provider); with Plaid, use POST /bank/plaid/connections.',
      body: bankConnectionCreateSchema,
      response: bankConnectionSchema,
      status: 201,
    },
    (c, { body }) => {
      requireAllLedgers(c.var.actor)
      return bank.connect(body)
    },
  )
  r.patch(
    '/bank/connections/:id',
    { ...banks, scope: 'admin', summary: 'Rename a bank connection', params: idParam, body: bankConnectionUpdateSchema, response: bankConnectionSchema },
    (c, { params, body }) => {
      requireAllLedgers(c.var.actor)
      return bank.rename(params.id, body.name)
    },
  )
  r.delete(
    '/bank/connections/:id',
    {
      ...banks,
      scope: 'admin',
      summary: 'Remove a bank connection',
      description:
        'Stops syncing and forgets the stored access. Synced transactions stay. For Plaid, also ends Plaid’s access to the bank; for SimpleFIN, disable the app in SimpleFIN Bridge too.',
      params: idParam,
      status: 204,
    },
    async (c, { params }) => {
      requireAllLedgers(c.var.actor)
      const { note } = await bank.remove(params.id)
      if (note) console.warn(`[bank] ${note}`)
    },
  )
  r.post(
    '/bank/connections/:id/sync',
    {
      ...banks,
      scope: 'write',
      summary: 'Sync a bank connection',
      description: 'Fetches new transactions and balances now. SimpleFIN allows about 24 requests a day, so this is refused once the day’s budget is used. Plaid has no such limit. An account shared between ledgers syncs into its home: a key limited to some ledgers needs that ledger only, and what the bank changed reaches each transaction in the ledger that holds it.',
      params: idParam,
      response: syncResultSchema,
    },
    (c, { params }) => {
      requireConnectionLedgers(c.var.actor, bank.get(params.id))
      return bank.sync(params.id)
    },
  )
  r.post(
    '/bank/connections/:id/fetch-history',
    {
      ...banks,
      scope: 'write',
      summary: 'Fetch a bank connection’s history again',
      description:
        'Like a sync, but for all the history the provider gives instead of what’s new: Plaid sends every transaction it has for the bank login again (up to 2 years), SimpleFIN the last 90 days (or since each account’s “sync from” date), using one of the day’s requests. Nothing is added twice. Where the bank’s date, amount or pending status differs, the bank’s is used, and what it sent is kept for each transaction. As for a sync, a key limited to some ledgers needs the home of each account it syncs into, not the other ledgers a shared account is in.',
      params: idParam,
      response: syncResultSchema,
    },
    (c, { params }) => {
      requireConnectionLedgers(c.var.actor, bank.get(params.id))
      return bank.sync(params.id, { full: true })
    },
  )
  r.post(
    '/bank/plaid/link-token',
    {
      ...banks,
      scope: 'admin',
      summary: 'Start Plaid Link',
      description:
        'A token for Plaid Link in the browser (Plaid.create({ token })), to add a bank, or with `connectionId` to sign in to a connected bank again. Needs Plaid’s API keys in App settings.',
      body: plaidLinkTokenRequestSchema,
      response: plaidLinkTokenSchema,
    },
    (c, { body }) => {
      requireAllLedgers(c.var.actor)
      return bank.plaidLinkToken(body.connectionId)
    },
  )
  r.post(
    '/bank/plaid/connections',
    {
      ...banks,
      scope: 'admin',
      summary: 'Connect a bank through Plaid',
      description:
        'Exchanges the public token from Plaid Link’s onSuccess for access to that bank (stored encrypted) and lists its accounts. Then switch accounts to synced, as with SimpleFIN.',
      body: plaidConnectSchema,
      response: bankConnectionSchema,
      status: 201,
    },
    (c, { body }) => {
      requireAllLedgers(c.var.actor)
      return bank.connectPlaid(body)
    },
  )
  r.post(
    '/bank/wealthsimple/connections',
    {
      ...banks,
      scope: 'admin',
      summary: 'Connect Wealthsimple',
      description:
        'Signs in to Wealthsimple (read-only) through the private API its own web app uses; there’s no official one. The password is used once and never stored: only the session is kept, encrypted. Leave `otp` out at first: when Wealthsimple wants a 2FA code, `otpRequired` is true (and nothing is kept), and the same request with `otp` signs in. Adds a connection that lists your accounts, or with `connectionId` signs that connection in again and syncs it.',
      body: wealthsimpleConnectSchema,
      response: wealthsimpleConnectResultSchema,
    },
    (c, { body }) => {
      requireAllLedgers(c.var.actor)
      return bank.connectWealthsimple(body)
    },
  )
  r.post(
    '/bank/sync',
    { ...banks, scope: 'write', summary: 'Sync all bank connections', description: 'Runs a sync for every connection with linked accounts. A key limited to some ledgers syncs only the connections that feed nothing but its ledgers.', response: z.array(syncResultSchema) },
    async (c) => {
      // A key limited to some ledgers syncs the connections that only feed its ledgers.
      const usable = (conn: BankConnection) => !conn.accounts.some((a) => a.link && !canUseLedger(c.var.actor, a.link.ledgerId))
      const results = []
      for (const conn of bank.list().filter((x) => x.accounts.some((a) => a.link) && usable(x))) results.push(await bank.sync(conn.id))
      return results
    },
  )

  return r
}
