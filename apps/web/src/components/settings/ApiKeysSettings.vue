<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { BookOpen, Check, Copy, KeyRound, Loader2, Plus, Trash2 } from '@lucide/vue'
import type { ApiKey, ApiKeyCreated, ApiScope } from '@chipmunk/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useApiKeyMutations, useApiKeys, useLedgers, useSettings } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { dateTime, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const keys = useApiKeys()
const m = useApiKeyMutations()
const ledgers = useLedgers()
const settings = useSettings()
const tz = computed(() => settings.data.value?.effectiveTimezone)

const ACCESS: Array<{ value: ApiScope; label: string; hint: string }> = [
  { value: 'read', label: 'Read only', hint: 'See everything, change nothing.' },
  { value: 'write', label: 'Read and write', hint: 'Also add and edit transactions, accounts, categories and recurring items.' },
  { value: 'admin', label: 'Full access', hint: 'Also manage ledgers, app settings, API keys, restore and erase.' },
]
const accessOf = (k: ApiKey) => ACCESS.find((a) => a.value === k.scopes[k.scopes.length - 1]) ?? ACCESS[0]!
const ledgerNames = (k: ApiKey) =>
  k.ledgers ? k.ledgers.map((id) => ledgers.all.value.find((l) => l.id === id)?.name ?? 'a deleted ledger').join(', ') : 'All ledgers'
const expired = (k: ApiKey) => !!k.expiresAt && Date.parse(k.expiresAt) <= Date.now()

// New key ------------------------------------------------------------------
const newOpen = ref(false)
const name = ref('')
const access = ref<ApiScope>('write')
const allLedgers = ref(true)
const picked = ref<string[]>([])
const expiry = ref('never')
const error = ref('')
const created = ref<ApiKeyCreated | null>(null)
const copied = ref(false)

watch(newOpen, (v) => {
  if (!v) return
  name.value = ''
  access.value = 'write'
  allLedgers.value = true
  picked.value = []
  expiry.value = 'never'
  error.value = ''
  created.value = null
  copied.value = false
})

function toggleLedger(id: string, on: boolean) {
  picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id)
}

async function create() {
  if (!name.value.trim()) return (error.value = 'Name the key after what uses it, like “Budget agent”')
  if (!allLedgers.value && !picked.value.length) return (error.value = 'Pick at least one ledger')
  error.value = ''
  try {
    created.value = await m.create.mutateAsync({
      name: name.value.trim(),
      scopes: [access.value],
      ledgers: allLedgers.value ? null : picked.value,
      expiresInDays: expiry.value === 'never' ? null : Number(expiry.value),
    })
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function copyKey() {
  if (!created.value) return
  try {
    await navigator.clipboard.writeText(created.value.key)
  } catch {
    // The clipboard API needs HTTPS; fall back to selecting the text for the older copy command.
    ;(document.getElementById('new-api-key') as HTMLInputElement | null)?.select()
    document.execCommand('copy')
  }
  copied.value = true
  toast.success('Key copied')
}
const example = computed(() => `curl -H "Authorization: Bearer ${created.value?.key ?? 'cm_…'}" ${location.origin}/api/v1/me`)

// Revoke -------------------------------------------------------------------
const revoking = ref<ApiKey | null>(null)
const revokeOpen = ref(false)
function askRevoke(k: ApiKey) {
  revoking.value = k
  revokeOpen.value = true
}
async function revoke() {
  if (!revoking.value) return
  try {
    await m.revoke.mutateAsync(revoking.value.id)
    toast.success(`Revoked ${revoking.value.name}`)
    revokeOpen.value = false
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <div class="flex flex-wrap gap-2">
      <Button @click="newOpen = true"><Plus />New API key</Button>
      <Button as-child variant="outline">
        <a href="/api/docs" target="_blank" rel="noopener"><BookOpen />API docs</a>
      </Button>
    </div>

    <Card class="gap-0 py-0">
      <CardHeader class="px-4 py-3 md:px-6">
        <CardTitle class="text-sm">API keys</CardTitle>
        <CardDescription>
          Scripts and AI agents use a key to work with your data through the API. Each key gets only the access you choose, and
          everything it changes shows up in Activity under its name.
        </CardDescription>
      </CardHeader>
      <div v-if="keys.isPending.value" class="border-t px-4 py-6 text-sm text-muted-foreground md:px-6">Loading…</div>
      <div v-else-if="!keys.data.value?.length" class="flex flex-col items-center gap-2 border-t px-4 py-10 text-center md:px-6">
        <KeyRound class="size-6 text-muted-foreground" />
        <p class="text-sm font-medium">No API keys yet</p>
        <p class="max-w-sm text-sm text-muted-foreground">Create one for each script or agent, so you can see what each did and revoke it on its own.</p>
      </div>
      <ul v-else class="divide-y border-t">
        <li v-for="k in keys.data.value" :key="k.id" class="flex items-center gap-3 px-4 py-3 md:px-6" :class="expired(k) && 'opacity-60'">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="truncate font-medium">{{ k.name }}</span>
              <Badge :variant="k.scopes.includes('admin') ? 'default' : 'secondary'">{{ accessOf(k).label }}</Badge>
              <Badge v-if="expired(k)" variant="outline">Expired</Badge>
            </div>
            <div class="truncate text-xs text-muted-foreground">
              <span class="font-mono">{{ k.prefix }}…</span> · {{ ledgerNames(k) }} ·
              {{ k.lastUsedAt ? `Used ${timeAgo(k.lastUsedAt, tz)}` : 'Never used' }}
              <template v-if="k.expiresAt && !expired(k)"> · Expires {{ dateTime(k.expiresAt, tz) }}</template>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" :aria-label="`Revoke ${k.name}`" @click="askRevoke(k)"><Trash2 /></Button>
        </li>
      </ul>
    </Card>

    <Dialog v-model:open="newOpen">
      <DialogContent class="sm:max-w-md">
        <template v-if="!created">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>You’ll see the key once, right after you create it.</DialogDescription>
          </DialogHeader>
          <form class="grid gap-4" @submit.prevent="create">
            <div class="grid gap-1.5">
              <FieldLabel html-for="key-name" hint="Name it after what will use it. Changes it makes appear in Activity under this name.">Name</FieldLabel>
              <Input id="key-name" v-model="name" placeholder="Budget agent" autocomplete="off" />
            </div>
            <div class="grid gap-1.5">
              <FieldLabel>Access</FieldLabel>
              <div class="grid gap-2" role="radiogroup" aria-label="Access">
                <button
                  v-for="a in ACCESS"
                  :key="a.value"
                  type="button"
                  role="radio"
                  :aria-checked="access === a.value"
                  :class="
                    cn(
                      'flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                      access === a.value ? 'border-primary bg-muted' : 'hover:bg-muted/50',
                    )
                  "
                  @click="access = a.value"
                >
                  <span class="font-medium">{{ a.label }}</span>
                  <span class="text-xs text-muted-foreground">{{ a.hint }}</span>
                </button>
              </div>
            </div>
            <div class="grid gap-1.5">
              <FieldLabel hint="A key limited to one ledger uses it by default, so agents don't need to name it.">Ledgers</FieldLabel>
              <div class="grid gap-2">
                <label class="flex items-center gap-2 text-sm">
                  <Checkbox :model-value="allLedgers" @update:model-value="allLedgers = $event === true" />
                  All ledgers, including ones you add later
                </label>
                <template v-if="!allLedgers">
                  <label v-for="l in ledgers.active.value" :key="l.id" class="flex items-center gap-2 pl-6 text-sm">
                    <Checkbox :model-value="picked.includes(l.id)" @update:model-value="toggleLedger(l.id, $event === true)" />
                    <span class="size-2.5 rounded-full" :style="{ background: l.color }" />{{ l.name }}
                  </label>
                </template>
              </div>
            </div>
            <div class="grid gap-1.5">
              <FieldLabel html-for="key-expiry">Expires</FieldLabel>
              <Select v-model="expiry">
                <SelectTrigger id="key-expiry" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never</SelectItem>
                  <SelectItem value="30">In 30 days</SelectItem>
                  <SelectItem value="90">In 90 days</SelectItem>
                  <SelectItem value="365">In a year</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
            <DialogFooter>
              <Button type="button" variant="outline" @click="newOpen = false">Cancel</Button>
              <Button type="submit" :disabled="m.create.isPending.value">
                <Loader2 v-if="m.create.isPending.value" class="animate-spin" />Create key
              </Button>
            </DialogFooter>
          </form>
        </template>

        <template v-else>
          <DialogHeader>
            <DialogTitle>Copy your new key</DialogTitle>
            <DialogDescription>
              This is the only time it’s shown. Store it where your script or agent can read it. If you lose it, revoke it and create a
              new one.
            </DialogDescription>
          </DialogHeader>
          <div class="grid gap-3">
            <div class="flex gap-2">
              <Input id="new-api-key" :model-value="created.key" readonly class="font-mono text-xs" @focus="($event.target as HTMLInputElement).select()" />
              <Button variant="outline" @click="copyKey"><Check v-if="copied" /><Copy v-else />{{ copied ? 'Copied' : 'Copy' }}</Button>
            </div>
            <div class="grid gap-1.5">
              <p class="text-xs text-muted-foreground">Try it:</p>
              <pre class="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs"><code>{{ example }}</code></pre>
            </div>
          </div>
          <DialogFooter>
            <Button @click="newOpen = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="revokeOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {{ revoking?.name }}?</DialogTitle>
          <DialogDescription>Anything using this key stops working right away. Its past changes stay in Activity.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="revokeOpen = false">Cancel</Button>
          <Button variant="destructive" :disabled="m.revoke.isPending.value" @click="revoke">
            <Loader2 v-if="m.revoke.isPending.value" class="animate-spin" />Revoke key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
