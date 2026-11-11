<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArchiveRestore, FileInput, FileOutput, FolderArchive, Loader2, Trash2 } from '@lucide/vue'
import RestoreBackupDialog from '@/components/RestoreBackupDialog.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLedgers, useSetupMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { ledgerApiHref } from '@/lib/ledger'

const m = useSetupMutations()
const { current } = useLedgers()

const restoreOpen = ref(false)

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
          A backup covers the whole app: every ledger and the app settings in one zip. Keep it somewhere safe, with a copy of
          <code class="text-xs">secret.key</code>, which isn't in it. The server also saves a copy of the whole database in
          <code class="text-xs">data/backups</code> before every upgrade, erase or ledger deletion.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Button as-child variant="outline"><a href="/api/v1/backup/full" download><FolderArchive />Full backup (all ledgers)</a></Button>
        <Button variant="outline" @click="restoreOpen = true"><ArchiveRestore />Restore from backup</Button>
      </CardContent>
    </Card>

    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Import</CardTitle>
        <CardDescription>Bring in CSV exports from your bank. Duplicates are skipped.</CardDescription>
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

    <RestoreBackupDialog v-model:open="restoreOpen" />

    <Dialog v-model:open="eraseOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Erase {{ current?.name ?? 'this ledger' }}'s data?</DialogTitle>
          <DialogDescription>
            This deletes all of this ledger's accounts, transactions, recurring items and tags. A copy of the whole database is saved in
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
