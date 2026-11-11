<script setup lang="ts">
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { ExternalLink, Monitor, Moon, Sun } from '@lucide/vue'
import { formatDateLong, type Settings } from '@st/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSettings, useUpdateSettings } from '@/composables/queries'
import { useTheme } from '@/composables/useTheme'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import TimezonePicker from './TimezonePicker.vue'

const settings = useSettings()
const update = useUpdateSettings()
const theme = useTheme()
// theme is a ref (auto-unwrapped in templates), so expose its stored mode separately.
const themeMode = theme.store
const s = computed(() => settings.data.value)

const timezone = computed({
  get: () => s.value?.timezone ?? null,
  set: async (tz) => {
    try {
      const next = await update.mutateAsync({ timezone: tz })
      toast.success(`Time zone set to ${next.effectiveTimezone.replace(/_/g, ' ')}`)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  },
})
// Finding recurring payments: how much each payment may differ from the latest one.
const PRICE_VARIATIONS = [0, 1, 2, 5, 10, 15, 20, 30, 50]
const DATE_VARIATIONS = [0, 1, 2, 3, 5, 7]
const detection = computed(() => s.value?.recurringDetection)
async function setDetection(patch: Partial<Settings['recurringDetection']>) {
  try {
    await update.mutateAsync({ recurringDetection: patch })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

// This copy's version. Run with `pnpm dev`, it's the code since that release, not the release itself.
const version = __APP_VERSION__
const dev = import.meta.env.DEV
const releaseUrl = `https://github.com/stevenwdhu/spending-tracker/releases/tag/v${version}`

const themes = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'auto', label: 'System', icon: Monitor },
] as const
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Time zone</CardTitle>
        <CardDescription>Decides what “today” is and where each month starts and ends in your reports.</CardDescription>
      </CardHeader>
      <CardContent v-if="s" class="grid gap-2">
        <Label for="set-tz" class="sr-only">Time zone</Label>
        <TimezonePicker id="set-tz" v-model="timezone" :system-zone="s.systemTimezone" />
        <p class="text-sm text-muted-foreground">
          It's {{ formatDateLong(s.today) }} in {{ s.effectiveTimezone.replace(/_/g, ' ') }}.
          <template v-if="!s.timezone">The default comes from the server's <code class="rounded bg-muted px-1 text-xs">TZ</code> setting.</template>
        </p>
      </CardContent>
    </Card>

    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Saved on this device.</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="inline-grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Theme">
          <button
            v-for="t in themes"
            :key="t.value"
            type="button"
            role="radio"
            :aria-checked="themeMode === t.value"
            :class="cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', themeMode === t.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')"
            @click="theme = t.value"
          >
            <component :is="t.icon" class="size-4" />{{ t.label }}
          </button>
        </div>
      </CardContent>
    </Card>

    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Recurring payments</CardTitle>
        <CardDescription>
          Bills and subscriptions are found when three payments in a row arrive on schedule (weekly, bi-weekly, monthly, quarterly or
          yearly), each about the same as the latest. Changes apply to the next scan; suggestions already found stay as they are.
        </CardDescription>
      </CardHeader>
      <CardContent v-if="detection" class="grid gap-4 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <FieldLabel html-for="rec-price" hint="How much a payment’s amount may differ from the latest one and still count. Raise it to find bills that vary, like hydro.">
            Price variation
          </FieldLabel>
          <Select
            :model-value="String(detection.priceVariationPct)"
            :disabled="update.isPending.value"
            @update:model-value="(v) => setDetection({ priceVariationPct: Number(v) })"
          >
            <SelectTrigger id="rec-price" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="p in PRICE_VARIATIONS" :key="p" :value="String(p)">{{ p ? `Up to ${p}%` : 'Same amount' }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-1.5">
          <FieldLabel
            html-for="rec-date"
            hint="How many days a payment may be before or after it’s due. Weekends are added: one due on a Saturday is looked for from Friday to Monday."
          >
            Date variation
          </FieldLabel>
          <Select
            :model-value="String(detection.dateVariationDays)"
            :disabled="update.isPending.value"
            @update:model-value="(v) => setDetection({ dateVariationDays: Number(v) })"
          >
            <SelectTrigger id="rec-date" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="d in DATE_VARIATIONS" :key="d" :value="String(d)">{{ d ? `± ${d} day${d === 1 ? '' : 's'}, plus weekends` : 'Same day, plus weekends' }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>

    <Card class="gap-2">
      <CardHeader>
        <CardTitle>Currency</CardTitle>
        <CardDescription>All amounts are in Canadian dollars (CAD). Support for other currencies is planned.</CardDescription>
      </CardHeader>
    </Card>

    <Card class="gap-2">
      <CardHeader>
        <CardTitle>About</CardTitle>
        <CardDescription>
          Spending Tracker <span class="tabular font-medium text-foreground">v{{ version }}</span><template v-if="dev">, in development</template>
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Button as-child variant="outline" size="sm">
          <a :href="releaseUrl" target="_blank" rel="noopener"><ExternalLink />What’s new in v{{ version }}</a>
        </Button>
        <Button as-child variant="outline" size="sm">
          <a href="https://github.com/stevenwdhu/spending-tracker/releases" target="_blank" rel="noopener"><ExternalLink />All releases</a>
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
