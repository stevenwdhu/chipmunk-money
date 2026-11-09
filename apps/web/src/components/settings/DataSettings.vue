<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArchiveRestore, FileArchive, FileInput, FileOutput, Loader2, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLedgers, useSetupMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { ledgerApiHref } from '@/lib/ledger'

const router = useRouter()
const m = useSetupMutations()
const { current } = useLedgers()

const restoreOpen = ref(false)
const restoreFile = ref<File | null>(null)
const restoreError = ref('')
watch(restoreOpen, (v) => {
  if (v) {
    restoreFile.value = null
    restoreError.value = ''
  }
})
function pick(e: Event) {
  restoreFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
  restoreError.value = ''
}
async function restore() {
  if (!restoreFile.value) return
  try {
    const { accounts, transactions } = await m.restore.mutateAsync(restoreFile.value)
    restoreOpen.value = false
    toast.success(`Restored ${accounts} account${accounts === 1 ? '' : 's'} and ${transactions} transaction${transactions === 1 ? '' : 's'}`)
    router.push({ name: 'overview' })
  } catch (err) {
    restoreError.value = errorMessage(err)
  }
}

const eraseOpen = ref(false)
const eraseWord = ref('')
watch(eraseOpen, (v) => v && (eraseWord.value = ''))
async function erase() {
  try {
    const { backup } = await m.erase.mutateAsync()
    eraseOpen.value = false
    toast.success(backup ? `All data erased. A copy was saved as data/backups/${backup}.` : 'All data erased.')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Export</CardTitle>
        <CardDescription>All of {{ current?.name ?? 'this ledger' }}'s transactions as a spreadsheet-friendly CSV: date, account, payee, amount, category, tags and notes.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button as-child variant="outline"><a :href="ledgerApiHref('/export/transactions.csv')" download><FileOutput />Export transactions (CSV)</a></Button>
      </CardContent>
    </Card>

    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Backup and restore</CardTitle>
        <CardDescription>
          A backup is a complete copy of {{ current?.name ?? 'this ledger' }} in a single file. Keep it somewhere safe. The server also
          saves a copy in <code class="text-xs">data/backups</code> before every database upgrade, restore or erase. To back up every
          ledger at once, use App settings → Ledgers → Full backup.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Button as-child variant="outline"><a :href="ledgerApiHref('/backup')" download><FileArchive />Download backup</a></Button>
        <Button variant="outline" @click="restoreOpen = true"><ArchiveRestore />Restore from backup</Button>
      </CardContent>
    </Card>

    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Import</CardTitle>
        <CardDescription>Bring in CSV exports from your bank. Duplicates are skipped and every import can be undone.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button as-child variant="outline"><RouterLink :to="{ name: 'import' }"><FileInput />Import CSV</RouterLink></Button>
      </CardContent>
    </Card>

    <Card class="gap-4 border-destructive/40">
      <CardHeader>
        <CardTitle>Erase this ledger's data</CardTitle>
        <CardDescription>
          Deletes every account, transaction, recurring item and tag in {{ current?.name ?? 'this ledger' }}, and resets its categories
          to the defaults. Other ledgers and app settings aren't touched. Use this to clear demo data before you start for real.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" class="text-destructive hover:text-destructive" @click="eraseOpen = true"><Trash2 />Erase this ledger's data…</Button>
      </CardContent>
    </Card>

    <Dialog v-model:open="restoreOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restore from a backup</DialogTitle>
          <DialogDescription>
            Everything in {{ current?.name ?? 'this ledger' }} is replaced by the backup. Other ledgers aren't touched. A copy of your current data is saved in
            <code class="text-xs">data/backups</code> first.
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-1.5">
          <Label for="restore-file">Backup file</Label>
          <Input id="restore-file" type="file" accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3" @change="pick" />
        </div>
        <p v-if="restoreError" class="text-sm text-destructive">{{ restoreError }}</p>
        <DialogFooter>
          <Button variant="outline" @click="restoreOpen = false">Cancel</Button>
          <Button :disabled="!restoreFile || m.restore.isPending.value" @click="restore">
            <Loader2 v-if="m.restore.isPending.value" class="animate-spin" />Replace my data
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="eraseOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Erase {{ current?.name ?? 'this ledger' }}'s data?</DialogTitle>
          <DialogDescription>
            This deletes all of this ledger's accounts, transactions, recurring items and tags. A copy is saved in
            <code class="text-xs">data/backups</code> first. Afterwards you'll see the welcome screen again.
          </DialogDescription>
        </DialogHeader>
        <form class="grid gap-1.5" @submit.prevent="eraseWord === 'erase' && erase()">
          <Label for="erase-confirm">Type <span class="font-mono">erase</span> to confirm</Label>
          <Input id="erase-confirm" v-model="eraseWord" autocomplete="off" autocapitalize="off" />
        </form>
        <DialogFooter>
          <Button variant="outline" @click="eraseOpen = false">Cancel</Button>
          <Button variant="destructive" :disabled="eraseWord !== 'erase' || m.erase.isPending.value" @click="erase">
            <Loader2 v-if="m.erase.isPending.value" class="animate-spin" />Erase everything
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
