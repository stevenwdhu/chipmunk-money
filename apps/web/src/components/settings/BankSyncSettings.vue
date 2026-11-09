<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Ellipsis, ExternalLink, Loader2, LogIn, Plus, Trash2 } from '@lucide/vue'
import { BANK_PROVIDER_LABELS, SYNC_INTERVALS, syncIntervalLabel, type BankAccount, type BankConnection, type BankProviderKind, type SyncResult } from '@st/shared'
import AccountFormDialog from '@/components/AccountFormDialog.vue'
import FieldLabel from '@/components/FieldLabel.vue'
import BankConnectionSection from '@/components/settings/BankConnectionSection.vue'
import LinkBankAccountDialog from '@/components/settings/LinkBankAccountDialog.vue'
import PlaidSetup from '@/components/settings/PlaidSetup.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useBankConnections, useBankMutations, useSettings, useUpdateSettings } from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { errorMessage } from '@/lib/api'
import { openPlaidLink, PlaidLinkFailure } from '@/lib/plaid'

/**
 * App settings → Bank sync: a card to add a service, then a card for each service you've added, with
 * everything about it (its keys or setup, how often it syncs, and every bank connected through it).
 * Services work side by side; each account syncs from one of them.
 */
const connections = useBankConnections()
const isDesktop = useIsDesktop()
const m = useBankMutations()
const settings = useSettings()
const tz = computed(() => settings.data.value?.effectiveTimezone)

/** The services, in the order their cards are listed. */
const SERVICES: BankProviderKind[] = ['simplefin', 'plaid', 'wealthsimple']
/** What each service is: when you pick it to add, and at the top of its card. */
const ABOUT: Record<BankProviderKind, string> = {
  simplefin:
    'SimpleFIN Bridge reaches most Canadian banks through MX, for US$15 a year. You connect your banks on its site, and this app reads them all through one connection.',
  plaid:
    'Plaid connects to each bank in its own window, one bank login at a time, with your own Plaid keys (free for up to 10 bank logins). The first sync brings up to two years of history.',
  wealthsimple:
    'Your Wealthsimple chequing, credit card and investment accounts, straight from Wealthsimple: each transaction’s exact time, all of its history, and new ones sooner than through Plaid. Free; you sign in with your Wealthsimple login.',
}

const connectionsOf = (provider: BankProviderKind) => (connections.data.value ?? []).filter((c) => c.provider === provider)

// Adding a service ------------------------------------------------------------------
/** Ones added here that aren't set up yet (no connection or keys): their cards show until you leave. */
const pending = ref<BankProviderKind[]>([])
/** Services you use: with a connection, or (Plaid) its keys saved, or just added. */
const added = computed(() =>
  SERVICES.filter((s) => connectionsOf(s).length || (s === 'plaid' && settings.data.value?.bank.plaid.source) || pending.value.includes(s)),
)
const addable = computed(() => SERVICES.filter((s) => !added.value.includes(s)))
const choice = ref<BankProviderKind | null>(null)
watch(
  addable,
  (list) => {
    if (!choice.value || !list.includes(choice.value)) choice.value = list[0] ?? null
  },
  { immediate: true },
)
function addService() {
  if (choice.value) pending.value = [...pending.value, choice.value]
}

// How often each service syncs -----------------------------------------------------------
const updateSettings = useUpdateSettings()
const syncHours = (provider: BankProviderKind) => settings.data.value?.bank.syncHours[provider]
const INTERVAL_HINTS: Record<BankProviderKind, string> = {
  simplefin: 'How often the app asks SimpleFIN for new transactions. SimpleFIN allows about 24 updates a day, so the shortest is every 2 hours, which leaves room for Sync now.',
  plaid: 'How often the app asks Plaid for new transactions. Plaid itself checks your bank 1 to 4 times a day, so new transactions can take a few hours to show up either way.',
  wealthsimple: 'How often the app asks Wealthsimple for new transactions. New ones show up there within minutes.',
}
const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1)
async function setSyncHours(provider: BankProviderKind, value: unknown) {
  const hours = Number(value)
  if (!hours || hours === syncHours(provider)) return
  try {
    await updateSettings.mutateAsync({ bankSyncHours: { [provider]: hours } })
    // The next sync time moves with it.
    await connections.refetch()
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

// Connect: SimpleFIN ----------------------------------------------------------------
const connectOpen = ref(false)
const setupToken = ref('')
const connectName = ref('')
const connectError = ref('')
watch(connectOpen, (v) => {
  if (!v) return
  setupToken.value = ''
  connectName.value = ''
  connectError.value = ''
})
async function connect() {
  connectError.value = ''
  try {
    const c = await m.connect.mutateAsync({ setupToken: setupToken.value.trim(), name: connectName.value.trim() || undefined })
    connectOpen.value = false
    toast.success(`Connected. Found ${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}; choose which to sync.`)
  } catch (err) {
    connectError.value = errorMessage(err)
  }
}

// Connect: Plaid (in Plaid Link, Plaid's own window) ----------------------------------
/** 'new' while adding a bank, or the connection being signed in to again. */
const linking = ref<string | null>(null)
/** Plaid's own error code, bank and Link session, when Link closed on an error. */
function linkError(err: unknown) {
  toast.error(errorMessage(err), err instanceof PlaidLinkFailure ? { description: err.details, duration: 20_000 } : undefined)
}
async function connectPlaid() {
  linking.value = 'new'
  try {
    const { linkToken } = await m.plaidLinkToken.mutateAsync({})
    const done = await openPlaidLink(linkToken)
    if (!done) return
    const c = await m.plaidConnect.mutateAsync({ publicToken: done.publicToken })
    toast.success(`Connected ${c.name}. Found ${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}; choose which to sync.`)
  } catch (err) {
    linkError(err)
  } finally {
    linking.value = null
  }
}
/** "Sign in again": in Plaid Link, or Wealthsimple's sign-in. */
function signIn(c: BankConnection) {
  if (c.provider === 'wealthsimple') openWealthsimple(c)
  else void reconnect(c)
}
async function reconnect(c: BankConnection) {
  linking.value = c.id
  try {
    const { linkToken } = await m.plaidLinkToken.mutateAsync({ connectionId: c.id })
    const done = await openPlaidLink(linkToken)
    if (!done) return
  } catch (err) {
    return void linkError(err)
  } finally {
    linking.value = null
  }
  // Signed in again: catch up straight away.
  await sync(c.id)
}

// Connect: Wealthsimple (its email, password and 2FA code, used once: only the session is kept) --------
const wsOpen = ref(false)
/** The connection being signed in to again, if that's what this is. */
const wsFor = ref<BankConnection | null>(null)
const wsEmail = ref('')
const wsPassword = ref('')
const wsOtp = ref('')
/** Wealthsimple asked for a 2FA code: the same sign-in again, with it. */
const wsNeedsOtp = ref(false)
const wsError = ref('')
function openWealthsimple(c: BankConnection | null = null) {
  wsFor.value = c
  wsNeedsOtp.value = false
  wsOtp.value = ''
  wsError.value = ''
  wsOpen.value = true
}
// The password goes as soon as the dialog does.
watch(wsOpen, (v) => {
  if (!v) wsPassword.value = wsOtp.value = ''
})
async function signInWealthsimple() {
  wsError.value = ''
  try {
    const r = await m.wealthsimpleConnect.mutateAsync({
      email: wsEmail.value.trim(),
      password: wsPassword.value,
      otp: wsNeedsOtp.value ? wsOtp.value.trim() : undefined,
      connectionId: wsFor.value?.id,
    })
    if (r.otpRequired) {
      wsNeedsOtp.value = true
      return
    }
    wsOpen.value = false
    const c = r.connection!
    if (wsFor.value) toast.success(`Signed in to ${c.name} again.`)
    else toast.success(`Connected Wealthsimple. Found ${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}; choose which to sync.`)
  } catch (err) {
    wsError.value = errorMessage(err)
  }
}

// Link a bank account: to an account you have, or a new one (the Add account form, right here) ---------
const linkOpen = ref(false)
const linkingBank = ref<{ account: BankAccount; connection: BankConnection } | null>(null)
function link(account: BankAccount, connection: BankConnection) {
  linkingBank.value = { account, connection }
  linkOpen.value = true
}
const addingOpen = ref(false)
const addingBank = ref<string | null>(null)
function addAccount(bankAccountId: string) {
  addingBank.value = bankAccountId
  addingOpen.value = true
}

// Sync ---------------------------------------------------------------------------
const syncing = ref<string | null>(null)
/** `full`: all the history the provider gives, not just what's new. */
async function sync(id: string, full = false) {
  syncing.value = id
  try {
    const r: SyncResult = await (full ? m.fetchHistory : m.sync).mutateAsync(id)
    if (!r.ok) return toast.error(r.error ?? 'The sync failed')
    const added = r.accounts.reduce((s, a) => s + a.added, 0)
    const changed = r.accounts.reduce((s, a) => s + a.updated + a.adopted + a.removed, 0)
    const problems = r.accounts.filter((a) => a.error)
    const done = full ? 'Fetched all history' : 'Synced'
    toast.success(
      added || changed
        ? `${done}: ${added} new transaction${added === 1 ? '' : 's'}${changed ? `, ${changed} updated` : ''}.`
        : full
          ? `${done}.`
          : `${done}. Nothing new.`,
      problems.length ? { description: problems.map((p) => `${p.name}: ${p.error}`).join(' ') } : undefined,
    )
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    syncing.value = null
  }
}

// Fetching all history again, after you confirm.
const fetchingAll = ref<BankConnection | null>(null)
function fetchAll() {
  const c = fetchingAll.value
  if (!c) return
  fetchingAll.value = null
  void sync(c.id, true)
}

// Rename and remove a connection --------------------------------------------------------
const renaming = ref<BankConnection | null>(null)
const renameValue = ref('')
function openRename(c: BankConnection) {
  renaming.value = c
  renameValue.value = c.name
}
async function rename() {
  if (!renaming.value || !renameValue.value.trim()) return
  try {
    await m.rename.mutateAsync({ id: renaming.value.id, name: renameValue.value.trim() })
    renaming.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
const removing = ref<BankConnection | null>(null)
async function remove() {
  if (!removing.value) return
  try {
    await m.remove.mutateAsync(removing.value.id)
    toast.success(`Removed ${removing.value.name}. Synced transactions stay.`)
    removing.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

// Remove a service: all its connections, and Plaid's keys ---------------------------------
const removingService = ref<BankProviderKind | null>(null)
/** Plaid's keys from the server's environment stay (and so does its card). */
const keysFromEnv = computed(() => settings.data.value?.bank.plaid.source === 'env')
function askRemoveService(s: BankProviderKind) {
  // Nothing set up yet: just take its card away.
  if (!connectionsOf(s).length && !(s === 'plaid' && settings.data.value?.bank.plaid.source === 'settings')) {
    pending.value = pending.value.filter((p) => p !== s)
    return
  }
  removingService.value = s
}
const removingServiceBusy = ref(false)
async function removeService() {
  const s = removingService.value
  if (!s) return
  removingServiceBusy.value = true
  try {
    for (const c of connectionsOf(s)) await m.remove.mutateAsync(c.id)
    if (s === 'plaid' && !keysFromEnv.value) await updateSettings.mutateAsync({ plaid: null })
    pending.value = pending.value.filter((p) => p !== s)
    toast.success(`Removed ${BANK_PROVIDER_LABELS[s]}. Synced transactions stay.`)
    removingService.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    removingServiceBusy.value = false
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Bank sync</CardTitle>
        <CardDescription>
          Synced accounts get their transactions and balances from your bank automatically, and new transactions get categories from your
          history like an import. Add the services you use: they work side by side, and each account syncs from one of them.
          <template v-if="!isDesktop">Add services and link accounts from a computer.</template>
        </CardDescription>
      </CardHeader>
      <CardContent v-if="choice && isDesktop" class="grid gap-2">
        <div class="flex flex-wrap gap-2">
          <Select v-model="choice">
            <SelectTrigger class="w-full sm:w-64" aria-label="Service to add"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in addable" :key="s" :value="s">{{ BANK_PROVIDER_LABELS[s] }}</SelectItem>
            </SelectContent>
          </Select>
          <Button @click="addService"><Plus />Add</Button>
        </div>
        <p class="text-sm text-muted-foreground">{{ ABOUT[choice] }}</p>
      </CardContent>
    </Card>

    <!-- A card per service: its setup and how often it syncs, then every bank connected through it. -->
    <Card v-for="service in added" :key="service" class="gap-0 overflow-hidden py-0">
      <CardHeader class="px-4 pt-5 pb-4 md:px-6">
        <CardTitle>{{ BANK_PROVIDER_LABELS[service] }}</CardTitle>
        <CardDescription>{{ ABOUT[service] }}</CardDescription>
        <CardAction v-if="isDesktop">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${BANK_PROVIDER_LABELS[service]}`"><Ellipsis /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <DropdownMenuItem variant="destructive" @select="askRemoveService(service)"><Trash2 />Remove {{ BANK_PROVIDER_LABELS[service] }}…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      <!-- Setting it up is for a computer: on a phone, its banks' status and Sync now. -->
      <CardContent v-if="isDesktop" class="px-4 pb-5 md:px-6">
        <PlaidSetup v-if="service === 'plaid'" :connecting="linking === 'new'" :has-connections="!!connectionsOf('plaid').length" @connect="connectPlaid">
          <div v-if="connectionsOf('plaid').length" class="grid gap-1.5 sm:max-w-xs">
            <FieldLabel html-for="bank-interval-plaid" :hint="INTERVAL_HINTS.plaid">Sync</FieldLabel>
            <Select :model-value="syncHours('plaid') ? String(syncHours('plaid')) : undefined" :disabled="updateSettings.isPending.value" @update:model-value="(v) => setSyncHours('plaid', v)">
              <SelectTrigger id="bank-interval-plaid" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="h in SYNC_INTERVALS.plaid" :key="h" :value="String(h)">{{ capitalize(syncIntervalLabel(h)) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </PlaidSetup>

        <div v-else-if="service === 'wealthsimple'" class="grid gap-3 text-sm">
          <ul v-if="!connectionsOf('wealthsimple').length" class="grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>Sign in with your Wealthsimple email, password and 2FA code. The password is used once and never stored: only the session is kept, encrypted on your server.</li>
            <li>Read-only: the app sees your accounts and activity, and can’t move money.</li>
            <li>
              Unofficial: it uses the private API Wealthsimple’s own web app uses, so Wealthsimple can change or block it at any time. Signing in
              again usually fixes it.
            </li>
          </ul>
          <div class="flex flex-wrap items-end gap-3">
            <div v-if="connectionsOf('wealthsimple').length" class="grid w-full gap-1.5 sm:max-w-xs">
              <FieldLabel html-for="bank-interval-wealthsimple" :hint="INTERVAL_HINTS.wealthsimple">Sync</FieldLabel>
              <Select
                :model-value="syncHours('wealthsimple') ? String(syncHours('wealthsimple')) : undefined"
                :disabled="updateSettings.isPending.value"
                @update:model-value="(v) => setSyncHours('wealthsimple', v)"
              >
                <SelectTrigger id="bank-interval-wealthsimple" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="h in SYNC_INTERVALS.wealthsimple" :key="h" :value="String(h)">{{ capitalize(syncIntervalLabel(h)) }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button :variant="connectionsOf('wealthsimple').length ? 'outline' : 'default'" class="sm:ml-auto" @click="openWealthsimple()">
              <LogIn />{{ connectionsOf('wealthsimple').length ? 'Add another login' : 'Sign in to Wealthsimple' }}
            </Button>
          </div>
        </div>

        <div v-else class="grid gap-3 text-sm">
          <!-- How to connect it, until it is. -->
          <template v-if="!connectionsOf('simplefin').length">
            <ol class="grid list-decimal gap-1 pl-5 text-muted-foreground">
              <li>
                Sign up at SimpleFIN Bridge and connect your banks there.
                <a href="https://bridge.simplefin.org/search-institutions" target="_blank" rel="noopener" class="underline underline-offset-2">Check if your bank is supported</a>.
              </li>
              <li>
                Create a setup token for this app.
                <a href="https://bridge.simplefin.org/simplefin/create" target="_blank" rel="noopener" class="inline-flex items-center gap-0.5 underline underline-offset-2">
                  Create a token<ExternalLink class="size-3" />
                </a>
              </li>
              <li>
                Paste it here. Then, in each account’s settings, set <span class="font-medium text-foreground">Updates</span> to
                <span class="font-medium text-foreground">Synced</span>, or add new accounts from the list below.
              </li>
            </ol>
            <p class="text-xs text-muted-foreground">
              SimpleFIN signs in to your bank on your behalf. Some banks only guarantee fraud losses if you never share your password, so check
              your bank’s online banking agreement. The access it gives this app is stored encrypted on your server.
            </p>
          </template>
          <div class="flex flex-wrap items-end gap-3">
            <div v-if="connectionsOf('simplefin').length" class="grid w-full gap-1.5 sm:max-w-xs">
              <FieldLabel html-for="bank-interval-simplefin" :hint="INTERVAL_HINTS.simplefin">Sync</FieldLabel>
              <Select
                :model-value="syncHours('simplefin') ? String(syncHours('simplefin')) : undefined"
                :disabled="updateSettings.isPending.value"
                @update:model-value="(v) => setSyncHours('simplefin', v)"
              >
                <SelectTrigger id="bank-interval-simplefin" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="h in SYNC_INTERVALS.simplefin" :key="h" :value="String(h)">{{ capitalize(syncIntervalLabel(h)) }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button :variant="connectionsOf('simplefin').length ? 'outline' : 'default'" class="sm:ml-auto" @click="connectOpen = true">
              <Plus />{{ connectionsOf('simplefin').length ? 'Connect another' : 'Paste a setup token' }}
            </Button>
          </div>
        </div>
      </CardContent>

      <BankConnectionSection
        :manage="isDesktop"
        v-for="c in connectionsOf(service)"
        :key="c.id"
        :connection="c"
        :tz="tz"
        :syncing="syncing === c.id"
        :signing-in="!!linking"
        @sync="sync(c.id)"
        @fetch-all="fetchingAll = c"
        @rename="openRename(c)"
        @remove="removing = c"
        @sign-in="signIn(c)"
        @link="(a) => link(a, c)"
      />
    </Card>

    <Dialog v-model:open="connectOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect SimpleFIN</DialogTitle>
          <DialogDescription>Paste the setup token from SimpleFIN Bridge. A token works once.</DialogDescription>
        </DialogHeader>
        <form class="grid gap-4" @submit.prevent="connect">
          <div class="grid gap-1.5">
            <FieldLabel html-for="sf-token" hint="In SimpleFIN Bridge, choose “New app connection” (or open the Create a token link) and copy the token it shows.">Setup token</FieldLabel>
            <Textarea id="sf-token" v-model="setupToken" rows="4" class="font-mono text-xs break-all" placeholder="aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9zaW1wbGVmaW4vY2xhaW0v…" />
          </div>
          <div class="grid gap-1.5">
            <FieldLabel html-for="sf-name" optional>Name</FieldLabel>
            <Input id="sf-name" v-model="connectName" placeholder="SimpleFIN Bridge" autocomplete="off" />
          </div>
          <p v-if="connectError" class="text-sm text-destructive">{{ connectError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" @click="connectOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!setupToken.trim() || m.connect.isPending.value">
              <Loader2 v-if="m.connect.isPending.value" class="animate-spin" />Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <LinkBankAccountDialog
      v-model:open="linkOpen"
      :bank-account="linkingBank?.account ?? null"
      :connection="linkingBank?.connection ?? null"
      @add-new="addAccount"
      @linked="connections.refetch()"
    />
    <AccountFormDialog v-model:open="addingOpen" :bank-account-id="addingBank" show-ledger @saved="connections.refetch()" />

    <Dialog v-model:open="wsOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ wsFor ? `Sign in to ${wsFor.name} again` : 'Sign in to Wealthsimple' }}</DialogTitle>
          <DialogDescription>Read-only. Your password is used once to sign in and never stored.</DialogDescription>
        </DialogHeader>
        <form class="grid gap-4" @submit.prevent="signInWealthsimple">
          <div class="grid gap-1.5">
            <Label for="ws-email">Email</Label>
            <Input id="ws-email" v-model="wsEmail" type="email" autocomplete="username" :disabled="wsNeedsOtp" />
          </div>
          <div class="grid gap-1.5">
            <Label for="ws-password">Password</Label>
            <Input id="ws-password" v-model="wsPassword" type="password" autocomplete="current-password" :disabled="wsNeedsOtp" />
          </div>
          <div v-if="wsNeedsOtp" class="grid gap-1.5">
            <FieldLabel html-for="ws-otp" hint="Wealthsimple just sent it by text or email, or it’s in your authenticator app.">2FA code</FieldLabel>
            <Input id="ws-otp" v-model="wsOtp" inputmode="numeric" autocomplete="one-time-code" autofocus class="tabular" />
          </div>
          <p v-if="wsError" class="text-sm text-destructive">{{ wsError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" @click="wsOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!wsEmail.trim() || !wsPassword || (wsNeedsOtp && !wsOtp.trim()) || m.wealthsimpleConnect.isPending.value">
              <Loader2 v-if="m.wealthsimpleConnect.isPending.value" class="animate-spin" />{{ wsNeedsOtp ? 'Sign in' : 'Continue' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!renaming" @update:open="(v) => !v && (renaming = null)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename connection</DialogTitle></DialogHeader>
        <form class="grid gap-4" @submit.prevent="rename">
          <Input v-model="renameValue" aria-label="Name" />
          <DialogFooter>
            <Button type="button" variant="outline" @click="renaming = null">Cancel</Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!fetchingAll" @update:open="(v) => !v && (fetchingAll = null)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle class="pr-6">Fetch all history from {{ fetchingAll?.name }}?</DialogTitle>
          <DialogDescription v-if="fetchingAll?.provider === 'plaid'">
            Plaid sends every transaction it has for this bank again, up to 2 years, instead of only what’s new.
          </DialogDescription>
          <DialogDescription v-else-if="fetchingAll?.provider === 'wealthsimple'">
            Wealthsimple sends every transaction it has again, instead of only what’s new.
          </DialogDescription>
          <DialogDescription v-else>
            SimpleFIN sends the last 90 days again (the most it gives at once). It uses one of today’s updates.
          </DialogDescription>
        </DialogHeader>
        <ul class="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
          <li>Nothing is added twice: transactions you have are matched by the bank’s id.</li>
          <li>Where the bank’s date, amount or pending status differs from yours, the bank’s is used. Your payees, categories, notes and tags stay.</li>
          <li>Synced accounts take them from their sync-from date on.</li>
          <li>What the bank sends is kept for all its accounts. You see it on each transaction, and an account you link later takes it in.</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" @click="fetchingAll = null">Cancel</Button>
          <Button @click="fetchAll">Fetch all history</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!removing" @update:open="(v) => !v && (removing = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {{ removing?.name }}?</DialogTitle>
          <DialogDescription v-if="removing?.provider === 'plaid'">
            Its accounts stop syncing and Plaid’s access to the bank ends. Transactions already synced stay.
          </DialogDescription>
          <DialogDescription v-else-if="removing?.provider === 'wealthsimple'">
            Its accounts stop syncing and the stored session is deleted. Transactions already synced stay.
          </DialogDescription>
          <DialogDescription v-else>
            Its accounts stop syncing and the stored access is deleted. Transactions already synced stay. To cut off the access completely,
            also disable this app in SimpleFIN Bridge.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="removing = null">Cancel</Button>
          <Button variant="destructive" :disabled="m.remove.isPending.value" @click="remove">Remove</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!removingService" @update:open="(v) => !v && (removingService = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {{ removingService && BANK_PROVIDER_LABELS[removingService] }}?</DialogTitle>
          <DialogDescription>
            <template v-if="removingService && connectionsOf(removingService).length">
              {{ connectionsOf(removingService).length === 1 ? 'Its connection is' : `Its ${connectionsOf(removingService).length} connections are` }} removed,
              so their accounts stop syncing<template v-if="removingService === 'plaid'"> and Plaid’s access to your banks ends</template>. Transactions
              already synced stay.
            </template>
            <template v-if="removingService === 'plaid'">
              {{ keysFromEnv ? 'Its keys come from the server’s environment, so they stay.' : 'Your Plaid keys are deleted too.' }}
            </template>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="removingService = null">Cancel</Button>
          <Button variant="destructive" :disabled="removingServiceBusy" @click="removeService">
            <Loader2 v-if="removingServiceBusy" class="animate-spin" />Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
