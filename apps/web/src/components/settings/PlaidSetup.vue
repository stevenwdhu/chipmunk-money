<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { ExternalLink, KeyRound, Loader2, Plus } from '@lucide/vue'
import type { PlaidEnvironment } from '@chipmunk/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSettings, useUpdateSettings } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

/**
 * Inside the Plaid card: Plaid's API keys (stored encrypted on your server), and the button that adds
 * a bank in Plaid Link. The default slot comes last (how often Plaid syncs, once there's a bank).
 */
defineProps<{ connecting: boolean; hasConnections: boolean }>()
const emit = defineEmits<{ connect: [] }>()

const settings = useSettings()
const update = useUpdateSettings()
const plaid = computed(() => settings.data.value?.bank.plaid)
const fromEnv = computed(() => plaid.value?.source === 'env')

const clientId = ref('')
const secret = ref('')
const environment = ref<PlaidEnvironment>('sandbox')
const replacingSecret = ref(true)
watch(
  plaid,
  (p) => {
    clientId.value = p?.clientId ?? ''
    environment.value = p?.environment ?? 'sandbox'
    secret.value = ''
    replacingSecret.value = !p?.hasSecret
  },
  { immediate: true },
)

/** Removes the saved secret; the client ID and environment stay. Banks can't sync until a secret is saved again. */
async function deleteSecret() {
  const p = plaid.value
  if (!p?.clientId) return
  try {
    await update.mutateAsync({ plaid: { clientId: p.clientId, environment: p.environment, secret: null } })
    toast.success('Plaid secret deleted')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

async function save() {
  if (!clientId.value.trim()) return void toast.error('Enter your Plaid client ID')
  if (replacingSecret.value && !secret.value.trim()) return void toast.error('Enter your Plaid secret')
  try {
    await update.mutateAsync({
      plaid: { clientId: clientId.value.trim(), environment: environment.value, ...(replacingSecret.value ? { secret: secret.value.trim() } : {}) },
    })
    toast.success('Plaid keys saved')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div class="grid gap-4 text-sm">
    <!-- How to set it up, until a bank is connected. -->
    <ol v-if="!hasConnections" class="grid list-decimal gap-1 pl-5 text-muted-foreground">
      <li>
        Sign up at Plaid. Its free Trial plan covers up to 10 bank logins.
        <a href="https://dashboard.plaid.com/signup" target="_blank" rel="noopener" class="inline-flex items-center gap-0.5 underline underline-offset-2">
          Sign up<ExternalLink class="size-3" />
        </a>
      </li>
      <li>
        In Plaid’s dashboard, open Developers → Keys and copy your client ID and a secret: Sandbox to try it with test banks, or Production for
        your real ones.
      </li>
      <li>Save them here, then connect your banks and choose which accounts to sync.</li>
    </ol>

    <p v-if="fromEnv" class="rounded-md bg-muted px-3 py-2">
      Set by the server’s <code class="text-xs">PLAID_*</code> environment variables ({{ plaid?.environment === 'production' ? 'Production' : 'Sandbox' }},
      secret {{ plaid?.secretHint }}). Change them in <code class="text-xs">.env</code> and restart the server.
    </p>
    <form v-else class="grid gap-4" @submit.prevent="save">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="grid min-w-0 content-start gap-1.5">
          <FieldLabel html-for="plaid-client" hint="Plaid dashboard → Developers → Keys.">Client ID</FieldLabel>
          <Input id="plaid-client" v-model="clientId" autocomplete="off" spellcheck="false" class="font-mono text-xs" />
        </div>
        <div class="grid min-w-0 content-start gap-1.5">
          <FieldLabel
            html-for="plaid-env"
            hint="Sandbox has Plaid’s test banks (sign in with user_good / pass_good). Production has your real banks. Use the matching secret."
          >
            Environment
          </FieldLabel>
          <Select v-model="environment">
            <SelectTrigger id="plaid-env" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sandbox">Sandbox</SelectItem>
              <SelectItem value="production">Production</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div class="grid content-start gap-1.5">
        <FieldLabel html-for="plaid-secret" hint="Stored encrypted on your server and never sent back to the browser.">Secret</FieldLabel>
        <div v-if="plaid?.hasSecret && !replacingSecret" class="flex items-center gap-2">
          <KeyRound class="size-4 text-muted-foreground" />Saved secret {{ plaid.secretHint }}
          <Button type="button" variant="link" size="sm" class="px-1" @click="replacingSecret = true">Change</Button>
          <Button type="button" variant="link" size="sm" class="px-1 text-destructive" :disabled="update.isPending.value" @click="deleteSecret">Delete</Button>
        </div>
        <Input v-else id="plaid-secret" v-model="secret" type="password" autocomplete="off" spellcheck="false" class="font-mono text-xs" />
      </div>
      <!-- Saving matches the AI keys form; adding a bank sits apart, on the right. -->
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" :disabled="update.isPending.value">Save</Button>
        <Button type="button" variant="outline" class="ml-auto" :disabled="!plaid?.configured || connecting" @click="emit('connect')">
          <Loader2 v-if="connecting" class="animate-spin" /><Plus v-else />{{ hasConnections ? 'Connect another bank' : 'Connect a bank' }}
        </Button>
      </div>
    </form>
    <div v-if="fromEnv" class="flex justify-end">
      <Button type="button" variant="outline" :disabled="!plaid?.configured || connecting" @click="emit('connect')">
        <Loader2 v-if="connecting" class="animate-spin" /><Plus v-else />{{ hasConnections ? 'Connect another bank' : 'Connect a bank' }}
      </Button>
    </div>
    <slot />
  </div>
</template>
