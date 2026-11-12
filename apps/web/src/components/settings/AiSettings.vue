<script setup lang="ts">
import { computed, ref } from 'vue'
import { Sparkles } from '@lucide/vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAiUsage, useSettings } from '@/composables/queries'
import { dateTime } from '@/lib/format'
import AiProviderForm from './AiProviderForm.vue'

const settings = useSettings()
const usage = useAiUsage()
const ai = computed(() => settings.data.value?.ai)
const tz = computed(() => settings.data.value?.effectiveTimezone)

/** The request whose error is showing: on hover or keyboard focus, and on tap for touch screens. */
const shown = ref<number | null>(null)
function show(id: number, open: boolean) {
  if (open) shown.value = id
  else if (shown.value === id) shown.value = null
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
    <AiProviderForm which="fallback" :config="ai?.fallback ?? null" />

    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>
          <template v-if="usage.data.value">
            {{ usage.data.value.requests }} requests · {{ usage.data.value.failed }} failed ·
            {{ usage.data.value.inputTokens.toLocaleString() }} input / {{ usage.data.value.outputTokens.toLocaleString() }} output tokens
          </template>
        </CardDescription>
      </CardHeader>
      <CardContent class="flex min-w-0 flex-col gap-4">
        <ul v-if="usage.data.value?.recent.length" class="min-w-0 divide-y text-sm">
          <li v-for="c in usage.data.value.recent" :key="c.id" class="flex items-center gap-3 py-2">
            <span class="size-2 shrink-0 rounded-full" :class="c.ok ? 'bg-positive' : 'bg-destructive'" />
            <time :datetime="c.createdAt" class="w-40 shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular">{{ dateTime(c.createdAt, tz, { seconds: true }) }}</time>
            <span class="w-16 shrink-0 text-xs text-muted-foreground">{{ c.slot }}</span>
            <span v-if="c.ledger" class="hidden w-24 shrink-0 truncate text-xs text-muted-foreground sm:block">{{ c.ledger }}</span>
            <span class="flex min-w-0 flex-1 items-center gap-1.5">
              <span class="min-w-0 truncate">{{ c.model }}</span>
              <template v-if="c.error">
                <span class="text-muted-foreground">·</span>
                <Tooltip :open="shown === c.id" :delay-duration="150" disable-closing-trigger @update:open="show(c.id, $event)">
                  <TooltipTrigger as-child>
                    <button
                      type="button"
                      class="shrink-0 rounded-sm text-destructive underline decoration-dotted underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      :aria-label="`Error: ${c.error}`"
                      @click.prevent="show(c.id, shown !== c.id)"
                    >
                      Error
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" class="max-w-72">{{ c.error }}</TooltipContent>
                </Tooltip>
              </template>
            </span>
            <span class="text-xs text-muted-foreground tabular">{{ (c.latencyMs / 1000).toFixed(1) }}s</span>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">No AI requests yet.</p>
      </CardContent>
    </Card>
  </div>
</template>
