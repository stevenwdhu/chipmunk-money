<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { CheckCircle2, ExternalLink, KeyRound, Loader2, LogOut, XCircle } from '@lucide/vue'
import { AI_PROVIDERS, aiProviderInfo, type AiKind, type AiProviderPublic } from '@st/shared'
import FieldLabel from '@/components/FieldLabel.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useChatgpt, useUpdateSettings } from '@/composables/queries'
import { api, errorMessage } from '@/lib/api'

/** `fallback` (on the primary's form): the fallback provider, which goes too when the primary is set to None. */
const props = defineProps<{ which: 'primary' | 'fallback'; config: AiProviderPublic | null; fallback?: AiProviderPublic | null }>()
const update = useUpdateSettings()

/** 'none': no provider. For the primary that turns AI off (and the fallback with it). */
const kind = ref<AiKind | 'none'>('anthropic')
const off = computed(() => kind.value === 'none')
const model = ref('')
const baseUrl = ref('')
const apiKey = ref('')
const replacingKey = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)

const GROUPS = [
  { key: 'hosted', label: 'Hosted' },
  { key: 'local', label: 'On your machine' },
  { key: 'custom', label: 'Your own server' },
] as const
// Only read while a provider is chosen.
const info = computed(() => aiProviderInfo(kind.value === 'none' ? 'anthropic' : kind.value))
const defaultModel = (k: AiKind | 'none') => (k === 'none' ? '' : aiProviderInfo(k).defaultModel)
const host = (url: string) => new URL(url).host

watch(
  () => props.config,
  (c) => {
    kind.value = c?.kind ?? 'none'
    model.value = c?.model ?? defaultModel(kind.value)
    baseUrl.value = c?.baseUrl ?? ''
    apiKey.value = ''
    replacingKey.value = !c?.hasApiKey
  },
  { immediate: true },
)
watch(kind, (k, old) => {
  if (!model.value || model.value === defaultModel(old)) model.value = defaultModel(k)
})
const origin = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).origin : null
  } catch {
    return url ?? null
  }
}
// A saved key belongs to the provider and server it was saved for: the server forgets it when either
// changes, so the form asks for one again.
const keyStays = computed(() => {
  const c = props.config
  if (!c?.hasApiKey || kind.value !== c.kind) return false
  return kind.value !== 'openai-compatible' || origin(baseUrl.value.trim()) === origin(c.baseUrl)
})
watch(keyStays, (stays) => {
  replacingKey.value = !stays
})

// Signing in with ChatGPT ---------------------------------------------------------------------
const isChatgpt = computed(() => kind.value === 'chatgpt')
/** A sign-in started here, waiting for you to approve it in the tab it opened. */
const waiting = ref(false)
const chat = useChatgpt(() => isChatgpt.value && waiting.value)
const signedIn = computed(() => !!chat.status.data.value?.signedIn)
const signInUrl = ref('')
const pasted = ref('')
/** The first sign-in, to say once that requests now use the ChatGPT plan. */
const firstSignIn = ref(false)
let wasRegistered = true

async function signInWithChatgpt() {
  wasRegistered = !!chat.status.data.value?.registered
  // Opened right away, while the click still allows it, and sent to the sign-in page once it's known.
  const tab = window.open('', '_blank')
  if (tab) tab.opener = null
  try {
    const { url } = await chat.start.mutateAsync()
    signInUrl.value = url
    pasted.value = ''
    waiting.value = true
    if (tab) tab.location.href = url
  } catch (err) {
    tab?.close()
    toast.error(errorMessage(err))
  }
}
watch(signedIn, (now) => {
  if (!now || !waiting.value) return
  waiting.value = false
  if (!wasRegistered) firstSignIn.value = true
  else toast.success('Signed in with ChatGPT')
})
async function finishPasted() {
  try {
    await chat.finish.mutateAsync(pasted.value.trim())
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
async function signOutOfChatgpt() {
  try {
    const { note } = await chat.signOut.mutateAsync()
    waiting.value = false
    if (note) toast.info(note)
    else toast.success('Signed out of ChatGPT')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
// A model the plan offers, picked for you once they're known.
watch(
  () => chat.models.data.value,
  (list) => {
    if (isChatgpt.value && list?.length && !list.some((m) => m.slug === model.value)) model.value = list[0]!.slug
  },
)

const providerHint = computed(() => {
  if (off.value)
    return props.which === 'primary'
      ? 'Pick a provider to ask about payees your history hasn’t seen, or None to use your history only.'
      : 'Pick a provider to ask when the primary one fails, or None.'
  if (kind.value === 'openai-compatible')
    return 'Any server that speaks the OpenAI chat API, at the URL you give: LM Studio, vLLM, a gateway, or Ollama on another machine.'
  if (kind.value === 'local')
    return 'Ollama on the same machine as this app, at localhost:11434. If Ollama runs elsewhere (or this app runs in Docker), choose OpenAI-compatible and give its URL.'
  if (isChatgpt.value) return 'Sign in with your ChatGPT account instead of an API key. Requests count toward your ChatGPT plan’s usage.'
  return info.value.baseUrl ? `Connects to ${host(info.value.baseUrl)}.` : 'Claude models through the Anthropic API.'
})
const modelHint = computed(() =>
  kind.value === 'anthropic'
    ? 'For example claude-opus-5-5, or claude-haiku-4-5 for lower cost.'
    : kind.value === 'openrouter'
      ? 'The provider and model, as OpenRouter lists it, e.g. openai/gpt-5-mini.'
      : kind.value === 'local'
        ? 'A model you’ve pulled with Ollama, e.g. llama3.2.'
        : isChatgpt.value
          ? 'One your ChatGPT plan offers. They’re listed once you’ve signed in.'
          : `The model name, e.g. ${info.value.modelExample}.`,
)

const fromEnv = computed(() => props.config?.source === 'env')
const title = computed(() => (props.which === 'primary' ? 'Primary provider' : 'Fallback provider'))
const description = computed(() =>
  props.which === 'primary'
    ? 'Asked first about payees your history hasn’t seen.'
    : 'Used when the primary provider fails or times out.',
)
const offText = computed(() =>
  props.which === 'primary'
    ? 'None: AI is off, so payees your history hasn’t seen stay uncategorized for you to pick.'
    : 'None: when the primary provider fails, new payees stay uncategorized for you to pick.',
)

/** Setting the primary to None while there's a fallback: asks first, since the fallback goes too. */
const confirmOff = ref(false)
const clearsFallback = computed(() => props.which === 'primary' && !!props.fallback && props.fallback.source !== 'env')

async function save() {
  if (off.value) {
    if (clearsFallback.value) confirmOff.value = true
    else if (props.config) await clear()
    return
  }
  if (!model.value.trim()) return void toast.error('Enter a model name')
  if (kind.value === 'openai-compatible' && !baseUrl.value.trim()) return void toast.error('Enter the server’s URL')
  if (info.value.apiKey === 'required' && replacingKey.value && !apiKey.value.trim()) return void toast.error(`Enter your ${info.value.label} API key`)
  if (isChatgpt.value && !signedIn.value) return void toast.error('Sign in with ChatGPT first')
  try {
    await update.mutateAsync({
      ai: {
        [props.which]: {
          kind: kind.value as AiKind,
          model: model.value.trim(),
          baseUrl: kind.value === 'openai-compatible' ? baseUrl.value.trim() : null,
          ...(info.value.apiKey === 'none' ? { apiKey: null } : replacingKey.value ? { apiKey: apiKey.value.trim() || null } : {}),
        },
      },
    })
    toast.success(`${title.value} saved`)
    testResult.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

/** Removes the saved key; the provider and model stay as saved. */
async function deleteKey() {
  const c = props.config
  if (!c) return
  try {
    await update.mutateAsync({ ai: { [props.which]: { kind: c.kind, model: c.model, baseUrl: c.baseUrl, apiKey: null } } })
    toast.success('API key deleted')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

async function clear() {
  try {
    await update.mutateAsync({ ai: props.which === 'primary' && clearsFallback.value ? { primary: null, fallback: null } : { [props.which]: null } })
    toast.success(props.which === 'fallback' ? 'Fallback provider turned off' : 'AI turned off')
    confirmOff.value = false
    testResult.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

async function test() {
  testing.value = true
  testResult.value = null
  try {
    const r = await api.post<{ ok: boolean; category?: string; confidence?: number; model?: string; latencyMs: number; error?: string }>(
      '/settings/ai/test',
      { slot: props.which },
    )
    testResult.value = r.ok
      ? { ok: true, text: `Works. ${r.model} put “Tim Hortons” in ${r.category} in ${(r.latencyMs / 1000).toFixed(1)}s.` }
      : { ok: false, text: r.error ?? 'The provider returned an error.' }
  } catch (err) {
    testResult.value = { ok: false, text: errorMessage(err) }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <Card class="gap-4">
    <CardHeader>
      <CardTitle>{{ title }}</CardTitle>
      <CardDescription>{{ description }}</CardDescription>
    </CardHeader>
    <CardContent>
      <p v-if="fromEnv" class="rounded-md bg-muted px-3 py-2 text-sm">
        Set by the server's <code class="text-xs">AI_{{ which.toUpperCase() }}_*</code> environment variables:
        {{ config && aiProviderInfo(config.kind).label }} · {{ config?.model }}<template v-if="config?.hasApiKey"> · key {{ config.apiKeyHint }}</template>.
        Change them in <code class="text-xs">.env</code> and restart the server.
      </p>
      <form v-else class="grid gap-4" @submit.prevent="save">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="grid min-w-0 content-start gap-1.5">
            <FieldLabel :html-for="`ai-${which}-kind`" :hint="providerHint">Provider</FieldLabel>
            <Select v-model="kind">
              <SelectTrigger :id="`ai-${which}-kind`" class="w-full min-w-0"><SelectValue class="block! min-w-0 truncate" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="none">None</SelectItem>
                </SelectGroup>
                <SelectGroup v-for="g in GROUPS" :key="g.key">
                  <SelectLabel>{{ g.label }}</SelectLabel>
                  <SelectItem v-for="p in AI_PROVIDERS.filter((x) => x.group === g.key)" :key="p.kind" :value="p.kind">{{ p.label }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div v-if="!off" class="grid min-w-0 content-start gap-1.5">
            <FieldLabel :html-for="`ai-${which}-model`" :hint="modelHint">Model</FieldLabel>
            <Select v-if="isChatgpt && chat.models.data.value?.length" v-model="model">
              <SelectTrigger :id="`ai-${which}-model`" class="w-full min-w-0"><SelectValue class="block! min-w-0 truncate" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="m in chat.models.data.value" :key="m.slug" :value="m.slug">{{ m.displayName }}</SelectItem>
              </SelectContent>
            </Select>
            <Input v-else :id="`ai-${which}-model`" v-model="model" :placeholder="info.modelExample" :disabled="isChatgpt && !signedIn" autocomplete="off" />
          </div>
        </div>
        <p v-if="off" class="text-sm text-muted-foreground">{{ offText }}</p>
        <!-- Your ChatGPT plan instead of an API key: signed in in another tab. -->
        <div v-if="isChatgpt" class="grid gap-2 rounded-md border px-3 py-3 text-sm">
          <template v-if="signedIn">
            <p>
              Signed in as <span class="font-medium">{{ chat.status.data.value?.email ?? 'your ChatGPT account' }}</span>. Requests use your ChatGPT plan.
            </p>
            <p v-if="!chat.status.data.value?.planUsage" class="text-amber-700 dark:text-amber-400">
              ChatGPT plan usage isn’t enabled for this sign-in. Sign in again to enable it, or use another provider with your own API key.
            </p>
            <p v-else-if="chat.models.isError.value" class="text-destructive">{{ errorMessage(chat.models.error.value) }}</p>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
              <a :href="chat.status.data.value?.usageUrl" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                Manage usage<ExternalLink class="size-3.5" />
              </a>
              <Button v-if="!chat.status.data.value?.planUsage" type="button" variant="link" size="sm" class="h-auto px-0" @click="signInWithChatgpt">Sign in again</Button>
              <Button type="button" variant="link" size="sm" class="h-auto px-0 text-muted-foreground" :disabled="chat.signOut.isPending.value" @click="signOutOfChatgpt">
                <LogOut />Sign out
              </Button>
            </div>
          </template>
          <template v-else>
            <p class="text-muted-foreground">Sign in with the ChatGPT account whose plan pays for the requests. No API key needed.</p>
            <Button type="button" class="justify-self-start" :disabled="chat.start.isPending.value" @click="signInWithChatgpt">
              <Loader2 v-if="chat.start.isPending.value" class="animate-spin" />Continue with ChatGPT
            </Button>
            <template v-if="waiting">
              <p class="text-muted-foreground">
                Approve it in the tab that opened<template v-if="signInUrl"> (or <a :href="signInUrl" target="_blank" rel="noopener" class="text-primary underline-offset-4 hover:underline">open it again</a>)</template>.
                This updates on its own when this server is on the same computer as your browser. Otherwise copy the address of the page you end on, which starts with http://127.0.0.1, and paste it here.
              </p>
              <div class="flex gap-2">
                <Input v-model="pasted" placeholder="http://127.0.0.1:8787/auth/callback?code=…" autocomplete="off" class="min-w-0 flex-1" />
                <Button type="button" variant="outline" :disabled="!pasted.trim() || chat.finish.isPending.value" @click="finishPasted">
                  <Loader2 v-if="chat.finish.isPending.value" class="animate-spin" />Finish
                </Button>
              </div>
            </template>
          </template>
        </div>
        <div v-if="kind === 'openai-compatible'" class="grid content-start gap-1.5">
          <FieldLabel :html-for="`ai-${which}-url`" hint="Where the server's OpenAI-style API is, usually ending in /v1.">Server URL</FieldLabel>
          <Input :id="`ai-${which}-url`" v-model="baseUrl" placeholder="http://192.168.1.20:11434/v1" autocomplete="off" />
        </div>
        <div v-if="!off && info.apiKey !== 'none'" class="grid content-start gap-1.5">
          <FieldLabel
            :html-for="`ai-${which}-key`"
            :optional="info.apiKey === 'optional'"
            hint="Stored on your server and never sent back to the browser."
            >API key</FieldLabel
          >
          <div v-if="config?.hasApiKey && !replacingKey" class="flex items-center gap-2 text-sm">
            <KeyRound class="size-4 text-muted-foreground" />Saved key {{ config.apiKeyHint }}
            <Button type="button" variant="link" size="sm" class="px-1" @click="replacingKey = true">Change</Button>
            <Button type="button" variant="link" size="sm" class="px-1 text-destructive" :disabled="update.isPending.value" @click="deleteKey">Delete</Button>
          </div>
          <Input
            v-else
            :id="`ai-${which}-key`"
            v-model="apiKey"
            type="password"
            autocomplete="off"
            :placeholder="kind === 'anthropic' ? 'sk-ant-…' : info.apiKey === 'optional' ? 'If your server needs one' : `Your ${info.label} API key`"
          />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" :disabled="update.isPending.value || (off && !config && !clearsFallback)">Save</Button>
          <Button v-if="config && !off" type="button" variant="outline" :disabled="testing" @click="test">
            <Loader2 v-if="testing" class="animate-spin" />Test connection
          </Button>
        </div>
      </form>
      <div v-if="fromEnv" class="mt-3">
        <Button type="button" variant="outline" size="sm" :disabled="testing" @click="test"><Loader2 v-if="testing" class="animate-spin" />Test connection</Button>
      </div>
      <p v-if="testResult" class="mt-3 flex items-start gap-2 text-sm" :class="testResult.ok ? 'text-positive' : 'text-destructive'">
        <component :is="testResult.ok ? CheckCircle2 : XCircle" class="mt-0.5 size-4 shrink-0" />{{ testResult.text }}
      </p>
    </CardContent>

    <!-- Once, after the first sign-in. -->
    <Dialog v-model:open="firstSignIn">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>You’re using your ChatGPT plan</DialogTitle>
          <DialogDescription>
            Categorizing new payees now counts toward your ChatGPT plan’s usage. You can see it, and limit what this app uses, in ChatGPT’s usage settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button as-child variant="outline">
            <a :href="chat.status.data.value?.usageUrl" target="_blank" rel="noopener">Manage usage</a>
          </Button>
          <Button @click="firstSignIn = false">Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="confirmOff">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Turn off AI?</DialogTitle>
          <DialogDescription>
            With no primary provider, the fallback ({{ fallback && aiProviderInfo(fallback.kind).label }} · {{ fallback?.model }}) is set to None as well.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmOff = false">Cancel</Button>
          <Button :disabled="update.isPending.value" @click="clear">Turn off</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>
</template>
