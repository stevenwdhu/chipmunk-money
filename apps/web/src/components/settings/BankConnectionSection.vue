<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { AlertTriangle, Ellipsis, ExternalLink, History, Landmark, Link2, Loader2, LogIn, Pencil, RefreshCw, Trash2 } from '@lucide/vue'
import { formatMoney, type BankAccount, type BankConnection } from '@chipmunk/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { dateTime, timeAgo } from '@/lib/format'

/**
 * One connection in its service's card: a Plaid bank login, or a SimpleFIN Bridge connection (all the
 * banks you added there). Its status, when it syncs, what went wrong, and each account it brings with
 * the ledger account it feeds or a way to add one.
 */
/** `manage`: its ⋯ menu, signing in again and Link (setup is for a computer; a phone gets status and Sync now). */
const props = defineProps<{ connection: BankConnection; tz?: string; syncing: boolean; signingIn: boolean; manage: boolean }>()
/** `link`: a ledger account to sync from this bank account (a new one, or one you have). */
const emit = defineEmits<{ sync: []; fetchAll: []; rename: []; remove: []; signIn: []; link: [BankAccount] }>()

/** Only a problem gets a badge: "Synced 1 h ago" already says it's fine. */
const STATUS: Record<'attention' | 'error', { label: string; variant: 'outline' | 'destructive' }> = {
  attention: { label: 'Needs attention', variant: 'outline' },
  error: { label: 'Not syncing', variant: 'destructive' },
}

function untilText(iso: string | null) {
  if (!iso) return null
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 60_000) return 'soon'
  const h = Math.floor(ms / 3_600_000)
  const min = Math.round((ms % 3_600_000) / 60_000)
  return h ? `in ${h} h ${min} min` : `in ${min} min`
}
/** Every connection with accounts syncs, linked or not: its transactions are kept for linking later. */
const hasAccounts = () => props.connection.accounts.length > 0

/**
 * Its accounts under the institution the service reports (not yours), in the order it lists them.
 * Named only when there's more than one (SimpleFIN); a Plaid login is one bank already.
 */
function byInstitution() {
  const groups = new Map<string, { key: string; name: string; accounts: BankAccount[] }>()
  for (const a of props.connection.accounts) {
    const key = a.remoteInstitutionId ?? a.institution ?? ''
    const group = groups.get(key) ?? { key, name: a.institution ?? 'Other accounts', accounts: [] }
    group.accounts.push(a)
    groups.set(key, group)
  }
  return [...groups.values()]
}
</script>

<template>
  <!-- A shaded header with the bank's name, and its accounts indented under it (lined up with the name). -->
  <section class="border-t" :aria-label="connection.name">
    <header class="flex items-center gap-3 bg-muted/50 px-4 py-2.5 md:px-6">
      <span class="grid size-8 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground"><Landmark class="size-4" /></span>
      <div class="min-w-0 flex-1">
        <h3 class="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span class="truncate">{{ connection.name }}</span>
          <Badge v-if="connection.status !== 'ok'" :variant="STATUS[connection.status].variant">{{ STATUS[connection.status].label }}</Badge>
        </h3>
        <p class="text-xs text-muted-foreground">
          <template v-if="connection.lastSyncedAt">Synced {{ timeAgo(connection.lastSyncedAt, tz) }}</template>
          <template v-else>Not synced yet</template>
          <template v-if="connection.nextSyncAt"> · next {{ untilText(connection.nextSyncAt) }}</template>
          <template v-if="connection.provider === 'simplefin'"> · {{ connection.requestsLast24h }} of about 24 updates used today</template>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="sm" :disabled="syncing || !hasAccounts()" @click="emit('sync')">
          <Loader2 v-if="syncing" class="animate-spin" /><RefreshCw v-else /><span class="max-sm:sr-only">Sync now</span>
        </Button>
        <DropdownMenu v-if="manage">
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${connection.name}`"><Ellipsis /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuItem @select="emit('rename')"><Pencil />Rename</DropdownMenuItem>
            <DropdownMenuItem v-if="connection.provider !== 'simplefin'" :disabled="signingIn" @select="emit('signIn')"><LogIn />Sign in again</DropdownMenuItem>
            <DropdownMenuItem v-else as-child>
              <a href="https://bridge.simplefin.org/" target="_blank" rel="noopener"><ExternalLink />Open SimpleFIN Bridge</a>
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="syncing || !hasAccounts()" @select="emit('fetchAll')"><History />Fetch all history…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" @select="emit('remove')"><Trash2 />Remove…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>

    <div v-if="connection.errors.length || connection.notice || connection.needsSignIn" class="grid gap-1 border-t bg-amber-500/5 px-4 py-3 text-sm md:px-6">
      <p v-for="(e, i) in connection.errors.filter((e) => !e.remoteAccountId)" :key="i" class="flex items-start gap-2">
        <AlertTriangle class="mt-0.5 size-4 shrink-0 text-amber-600" />
        <span>
          {{ e.message }}<template v-if="connection.provider === 'simplefin' && e.code.startsWith('con.auth')"> Sign in to that bank again in SimpleFIN Bridge.</template>
        </span>
      </p>
      <div v-if="connection.needsSignIn && manage">
        <Button size="sm" class="mt-1" :disabled="signingIn" @click="emit('signIn')">
          <Loader2 v-if="signingIn" class="animate-spin" /><LogIn v-else />{{ connection.provider === 'wealthsimple' ? 'Sign in again' : 'Reconnect' }}
        </Button>
      </div>
      <p v-else-if="connection.needsSignIn" class="text-muted-foreground">Sign in again from a computer.</p>
      <p v-if="connection.notice" class="text-muted-foreground">{{ connection.notice }}</p>
    </div>

    <div v-for="g in byInstitution()" :key="g.key" class="border-t">
      <h4 v-if="byInstitution().length > 1" class="flex items-center gap-1.5 pt-3 pr-4 pb-1 pl-15 text-xs font-medium text-muted-foreground md:pr-6 md:pl-17">
        <span class="truncate">{{ g.name }}</span>
        <span class="shrink-0 font-normal">({{ g.accounts.length }})</span>
      </h4>
      <ul class="divide-y">
        <!-- On a phone the link controls wrap below the name and balance. -->
        <li v-for="a in g.accounts" :key="a.id" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2.5 pr-4 pl-15 md:pr-6 md:pl-17">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm" :title="a.name">{{ a.name }}</div>
            <div v-if="a.error" class="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle class="size-3 shrink-0" />{{ a.error }}</div>
          </div>
          <div
            class="tabular w-28 shrink-0 text-right text-sm"
            :class="(a.balanceMinor ?? 0) < 0 && 'text-negative'"
            :title="a.balanceDate ? `Balance on ${dateTime(a.balanceDate, tz)}` : undefined"
          >
            {{ a.balanceMinor === null ? '—' : formatMoney(a.balanceMinor, a.currency) }}
          </div>
          <div class="flex w-full min-w-0 items-center justify-end gap-1 sm:w-64">
            <RouterLink
              v-if="a.link"
              :to="{ name: 'account', params: { ledger: a.link.ledgerSlug, id: a.link.accountId } }"
              class="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent"
            >
              <span class="truncate">{{ a.link.accountName }}</span>
              <span class="shrink-0 text-xs text-muted-foreground">· {{ a.link.ledgerName }}</span>
            </RouterLink>
            <Button v-else-if="manage" variant="outline" size="sm" @click="emit('link', a)"><Link2 />Link</Button>
          </div>
        </li>
      </ul>
    </div>
    <p v-if="!connection.accounts.length" class="border-t px-4 py-6 text-sm text-muted-foreground md:px-6">
      <template v-if="connection.provider === 'plaid'">Plaid didn’t list any accounts for this bank.</template>
      <template v-else-if="connection.provider === 'wealthsimple'">Wealthsimple didn’t list any open accounts.</template>
      <template v-else>SimpleFIN didn’t list any accounts yet. Connect a bank in SimpleFIN Bridge, then sync.</template>
    </p>
  </section>
</template>
