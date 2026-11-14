<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AiRecord, AiRetry } from '@chipmunk/shared'
import { toast } from 'vue-sonner'
import { Loader2, RotateCcw, Sparkles, X } from '@lucide/vue'
import TextTip from '@/components/TextTip.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAiRetryMutations, useAiUsage, useInvalidateAll, useSettings } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import AiProviderForm from './AiProviderForm.vue'

const settings = useSettings()
const usage = useAiUsage()
const retry = useAiRetryMutations()
const invalidateAll = useInvalidateAll()
const ai = computed(() => settings.data.value?.ai)
const tz = computed(() => settings.data.value?.effectiveTimezone)

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

/** What the request was for. One from before that was kept is a call to one provider. */
function what(c: AiRecord) {
  // “Ask AI again” on transactions that had a category: a retry asks about those ones only.
  if (c.kind === 'categorize' && c.again) return `Ask again about ${c.subject ?? 'a payee'}`
  if (c.kind === 'categorize') return `Categorize ${c.subject ?? 'a payee'}`
  if (c.kind === 'names') return `Name ${count(c.payees ?? 0, 'payee')}`
  if (c.kind === 'test') return 'Connection test'
  return c.slot === 'primary' ? 'Primary provider' : 'Fallback provider'
}

/** What an answered request came to. */
function answer(c: AiRecord) {
  if (c.kind === 'names') return count(c.named ?? 0, 'name')
  // A test asks about a sample: that it answered is what counts, not what it picked.
  if (c.kind === 'test') return 'Works'
  if (c.outcome) return `→ ${c.outcome}`
  return c.kind === 'categorize' ? '→ no category' : null
}

const STATUS = { ok: 'Answered', failed: 'Failed', unneeded: 'No longer needed' }

/** Why it failed: the last error, the primary provider's when the fallback failed after it, how often it was asked, and why it can't be retried here. */
function reason(c: AiRecord) {
  const lines = [c.error ?? 'No reason was given']
  if (c.primaryError && c.primaryError !== c.error) lines.push(`The primary provider failed first: ${c.primaryError}`)
  if (c.tries > 1 && c.firstFailedAt) lines.push(`Asked ${c.tries} times, first failed ${dateTime(c.firstFailedAt, tz.value)}`)
  if (c.noRetry) lines.push(c.noRetry)
  return lines.join('\n')
}

function unneeded(c: AiRecord) {
  const left =
    c.kind === 'names'
      ? 'the payees all have names now'
      : c.again
        ? 'the transactions it asked about are gone, were categorized or confirmed by hand since, or are ones “Ask AI again” leaves as they are now'
        : 'the payee has no uncategorized transaction left'
  return `Nothing is left to ask: ${left}\nIt failed: ${c.error ?? 'no reason was given'}`
}

/** A request that failed first and was answered later, by a retry or by the next time the same thing was asked. */
const later = (c: AiRecord) => (c.tries > 1 ? `Answered on try ${c.tries}` : 'Answered later')

/** The request whose Retry was just pressed, until the server says it started. */
const asking = ref<number | null>(null)
const busy = (c: AiRecord) => c.retrying || asking.value === c.id
const working = computed(() => !!usage.data.value?.retrying || retry.all.isPending.value)
/** Keeps a column for Retry on a computer, so the rows line up. */
const anyRetry = computed(() => !!usage.data.value?.recent.some((c) => c.canRetry || c.retrying))

// A retry categorizes transactions and names payees, in any ledger, so everything is read again when it ends.
watch(
  () => usage.data.value?.retrying ?? 0,
  (now, before) => {
    if (before && !now) void invalidateAll()
  },
)
/** The usage was read again before this: a retry that ended already never showed as running. */
function started(result: AiRetry) {
  if (result.started && !usage.data.value?.retrying) void invalidateAll()
}

async function retryOne(c: AiRecord) {
  asking.value = c.id
  try {
    started(await retry.one.mutateAsync(c))
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    asking.value = null
  }
}

async function retryAll() {
  try {
    const result = await retry.all.mutateAsync()
    const left = result.working
      ? `${count(result.working, 'request')} left for now, because AI is already working in ${result.working === 1 ? 'its' : 'their'} ledger. Try again when it's done.`
      : undefined
    if (result.started) toast(`Asking AI again about ${count(result.started, 'request')}…`, { description: left })
    else toast(left ?? 'Nothing is left to ask again')
    started(result)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <Card class="gap-2">
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><Sparkles class="size-4 text-ai" />How categorization works</CardTitle>
        <CardDescription class="grid gap-1">
          <span>1. Your history comes first: once you've confirmed a payee's category twice, it's applied automatically.</span>
          <span>2. New payees go to the primary provider, then the fallback. AI picks are always marked for your review.</span>
          <span>3. Only the payee, amount, date, account type, notes and your category names are sent, never account names or numbers.</span>
          <span>Set the primary provider to None to use history only. The providers are shared by all ledgers; what each ledger learns stays in that ledger.</span>
        </CardDescription>
      </CardHeader>
    </Card>

    <AiProviderForm which="primary" :config="ai?.primary ?? null" :fallback="ai?.fallback ?? null" />
    <AiProviderForm which="fallback" :config="ai?.fallback ?? null" :primary="ai?.primary ?? null" />

    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>
          <template v-if="usage.data.value">
            {{ count(usage.data.value.requests, 'request') }} · {{ usage.data.value.failed.toLocaleString() }} failed ·
            <template v-if="usage.data.value.failed">{{ usage.data.value.retryable.toLocaleString() }} can be retried · </template>
            {{ usage.data.value.inputTokens.toLocaleString() }} input / {{ usage.data.value.outputTokens.toLocaleString() }} output tokens
            <span v-if="usage.data.value.retrying" class="mt-1 flex items-center gap-1.5">
              <Loader2 class="size-3.5 shrink-0 animate-spin" />Asking AI again about {{ count(usage.data.value.retrying, 'request') }}…
            </span>
          </template>
        </CardDescription>
        <!-- Under the counts on a phone, beside them on a computer. -->
        <CardAction
          v-if="usage.data.value?.retryable"
          class="col-start-1 row-span-1 row-start-3 mt-1 justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:justify-self-end"
        >
          <Button variant="outline" size="sm" :disabled="working" @click="retryAll">
            <Loader2 v-if="working" class="animate-spin" /><RotateCcw v-else />Retry all failed ({{ usage.data.value.retryable.toLocaleString() }})
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent class="flex min-w-0 flex-col gap-4">
        <ul v-if="usage.data.value?.recent.length" class="min-w-0 divide-y text-sm">
          <li v-for="c in usage.data.value.recent" :key="c.id" class="flex items-start gap-3 py-2">
            <!-- Answered is a dot, failed a cross, no longer needed a ring: told apart by shape, not only colour. -->
            <span class="mt-1 flex size-3 shrink-0 items-center justify-center" role="img" :aria-label="STATUS[c.status]" :title="STATUS[c.status]">
              <span v-if="c.status === 'ok'" class="size-2 rounded-full bg-positive" />
              <X v-else-if="c.status === 'failed'" class="size-3 text-destructive" :stroke-width="3.5" />
              <span v-else class="size-2 rounded-full border border-muted-foreground" />
            </span>
            <!-- On a phone what it was for has lines of its own, with the time and ledger under the rest. -->
            <div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
              <div class="order-last flex min-w-0 gap-2 text-xs text-muted-foreground sm:order-none sm:shrink-0 sm:gap-3">
                <time :datetime="c.createdAt" class="shrink-0 whitespace-nowrap tabular sm:w-40">{{ dateTime(c.createdAt, tz, { seconds: true }) }}</time>
                <span class="min-w-0 truncate sm:w-24" :title="c.ledger">{{ c.ledger }}</span>
              </div>
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <!-- Never cut, also on a phone: payees that start the same are told apart by their end. -->
                <span class="[overflow-wrap:anywhere]" :class="{ 'text-muted-foreground': c.kind === null }">{{ what(c) }}</span>
                <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                  <span v-if="c.model" class="min-w-0 truncate">{{ c.model }}</span>
                  <span v-if="busy(c)" class="flex items-center gap-1"><Loader2 class="size-3 shrink-0 animate-spin" />Asking again…</span>
                  <template v-else-if="c.status === 'ok'">
                    <span v-if="answer(c)" class="text-foreground">{{ answer(c) }}</span>
                    <template v-if="c.slot === 'fallback' && c.primaryError">
                      <span>·</span>
                      <TextTip label="Fallback answered" :text="`The primary provider failed: ${c.primaryError}`" />
                    </template>
                    <template v-if="c.firstFailedAt">
                      <span>·</span>
                      <TextTip :label="later(c)" :text="`First failed ${dateTime(c.firstFailedAt ?? c.createdAt, tz)}`" />
                    </template>
                  </template>
                  <template v-else>
                    <span v-if="c.model">·</span>
                    <TextTip v-if="c.status === 'failed'" label="Error" :text="reason(c)" class="text-destructive" />
                    <TextTip v-else label="No longer needed" :text="unneeded(c)" />
                  </template>
                  <span class="ml-auto shrink-0 tabular">{{ (c.latencyMs / 1000).toFixed(1) }}s</span>
                </div>
              </div>
            </div>
            <span v-if="anyRetry" class="shrink-0 justify-end sm:flex sm:w-20" :class="c.canRetry || busy(c) ? 'flex' : 'hidden'">
              <Button v-if="c.canRetry || busy(c)" variant="outline" size="sm" :disabled="busy(c) || working" @click="retryOne(c)">
                <Loader2 v-if="busy(c)" class="animate-spin" /><RotateCcw v-else />Retry
              </Button>
            </span>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">No AI requests yet.</p>
      </CardContent>
    </Card>
  </div>
</template>
