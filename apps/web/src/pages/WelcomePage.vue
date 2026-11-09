<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArchiveRestore, FlaskConical, Loader2, Plus, Wallet } from '@lucide/vue'
import FieldLabel from '@/components/FieldLabel.vue'
import LedgerMark from '@/components/ledger/LedgerMark.vue'
import LedgerSwitcher from '@/components/ledger/LedgerSwitcher.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useLedgerMutations, useLedgers, useSetupMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { setCurrentLedger } from '@/lib/ledger'
import { cn } from '@/lib/utils'

const router = useRouter()
const m = useSetupMutations()
const ledgers = useLedgers()
const lm = useLedgerMutations()
const current = computed(() => ledgers.current.value)
/** First run: this is the only ledger, so let the user name it here. */
const firstRun = computed(() => ledgers.all.value.length <= 1)
const ledgerName = ref('')
watch(current, (l) => (ledgerName.value ||= l?.name ?? 'Personal'), { immediate: true })

/** Applies a changed name first (which can change the URL), and returns the ledger's slug. */
async function applyName(): Promise<string> {
  const ledger = current.value
  if (!ledger) throw new Error('Ledger not found')
  const name = ledgerName.value.trim()
  if (!firstRun.value || !name || name === ledger.name) return ledger.slug
  const updated = await lm.update.mutateAsync({ id: ledger.id, name })
  setCurrentLedger(updated.slug)
  return updated.slug
}
const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
const restoreError = ref('')
const busy = computed(() => m.start.isPending.value || m.demo.isPending.value || m.restore.isPending.value)

async function startFresh() {
  try {
    const slug = await applyName()
    await m.start.mutateAsync()
    router.replace({ name: 'accounts', params: { ledger: slug }, query: { new: '1' } })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

async function loadDemo() {
  try {
    const slug = await applyName()
    const { transactions } = await m.demo.mutateAsync()
    router.replace({ name: 'overview', params: { ledger: slug } })
    toast.success(`Loaded ${transactions} sample transactions. Erase them any time in Ledger settings → Data.`)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

async function restore(file: File | undefined) {
  if (!file || busy.value) return
  restoreError.value = ''
  try {
    const slug = await applyName()
    const { accounts, transactions } = await m.restore.mutateAsync(file)
    router.replace({ name: 'overview', params: { ledger: slug } })
    toast.success(`Restored ${accounts} account${accounts === 1 ? '' : 's'} and ${transactions} transaction${transactions === 1 ? '' : 's'}`)
  } catch (err) {
    restoreError.value = errorMessage(err)
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  restore(input.files?.[0])
  input.value = ''
}
function onDrop(e: DragEvent) {
  dragOver.value = false
  restore(e.dataTransfer?.files?.[0])
}
</script>

<template>
  <main class="flex min-h-svh flex-col items-center justify-center bg-muted/40 px-4 pt-safe pb-safe">
    <div class="flex w-full max-w-4xl flex-col gap-8 py-10">
      <header v-if="firstRun" class="flex flex-col items-center gap-3 text-center">
        <span class="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Wallet class="size-6" />
        </span>
        <h1 class="text-2xl font-semibold text-balance md:text-3xl">Welcome to Spending Tracker</h1>
        <p class="max-w-lg text-balance text-muted-foreground">
          Your spending lives in ledgers: separate sets of books, like “Personal” and “Family”. Name your first one, then
          choose how to start. Your data stays on this server.
        </p>
        <div class="mt-2 grid w-full max-w-xs gap-1.5 text-left">
          <FieldLabel html-for="welcome-ledger" hint="You can rename it, or add more ledgers, any time from the ledger menu."
            >Ledger name</FieldLabel
          >
          <Input id="welcome-ledger" v-model="ledgerName" autocomplete="off" />
        </div>
      </header>
      <header v-else class="flex flex-col items-center gap-3 text-center">
        <LedgerMark :ledger="current" />
        <h1 class="text-2xl font-semibold text-balance md:text-3xl">Set up {{ current?.name }}</h1>
        <p class="max-w-lg text-balance text-muted-foreground">This ledger is empty. How would you like to start?</p>
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          Or switch to another ledger: <LedgerSwitcher variant="compact" />
        </div>
      </header>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card class="gap-4">
          <CardHeader>
            <span class="mb-2 grid size-10 place-items-center rounded-lg bg-muted"><Plus class="size-5" /></span>
            <CardTitle>Start from scratch</CardTitle>
            <CardDescription>
              Begin with an empty ledger. You'll add your first account next, then enter transactions or import a CSV from your bank.
            </CardDescription>
          </CardHeader>
          <CardFooter class="mt-auto">
            <Button class="w-full" :disabled="busy" @click="startFresh">
              <Loader2 v-if="m.start.isPending.value" class="animate-spin" />Start fresh
            </Button>
          </CardFooter>
        </Card>

        <Card
          :class="cn('gap-4 transition-colors', dragOver && 'border-primary bg-muted')"
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <CardHeader>
            <span class="mb-2 grid size-10 place-items-center rounded-lg bg-muted"><ArchiveRestore class="size-5" /></span>
            <CardTitle>Restore a backup</CardTitle>
            <CardDescription>
              Upload a <code class="text-xs">.db</code> backup you downloaded from Ledger settings → Data, or drop the file here.
            </CardDescription>
          </CardHeader>
          <CardContent v-if="restoreError" class="text-sm text-destructive">{{ restoreError }}</CardContent>
          <CardFooter class="mt-auto">
            <Button class="w-full" variant="outline" :disabled="busy" @click="fileInput?.click()">
              <Loader2 v-if="m.restore.isPending.value" class="animate-spin" />Choose backup file
            </Button>
            <input ref="fileInput" type="file" accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3" class="sr-only" @change="onPick" />
          </CardFooter>
        </Card>

        <Card class="gap-4">
          <CardHeader>
            <span class="mb-2 grid size-10 place-items-center rounded-lg bg-muted"><FlaskConical class="size-5" /></span>
            <CardTitle>Explore the demo</CardTitle>
            <CardDescription>
              Load 13 months of sample Canadian spending to try every feature. Erase it whenever you're ready to start for real.
            </CardDescription>
          </CardHeader>
          <CardFooter class="mt-auto">
            <Button class="w-full" variant="outline" :disabled="busy" @click="loadDemo">
              <Loader2 v-if="m.demo.isPending.value" class="animate-spin" />Load demo data
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  </main>
</template>
