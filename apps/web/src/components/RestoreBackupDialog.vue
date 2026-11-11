<script setup lang="ts">
import { FolderArchive } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * How to restore a full backup. It's done by hand, with the server stopped: the app only shows
 * the steps (Ledger settings → Data, and the welcome page).
 */
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Restore from a backup</DialogTitle>
        <DialogDescription>
          A backup holds every ledger, so restoring one puts all of them back the way they were. It's done by hand, on the server.
        </DialogDescription>
      </DialogHeader>
      <ol class="grid list-decimal gap-2 pl-5 text-sm">
        <li>Stop Chipmunk.</li>
        <li>
          In the data folder (where <code class="text-xs">chipmunk.db</code> and <code class="text-xs">secret.key</code> are), delete
          <code class="text-xs">chipmunk.db-wal</code> and <code class="text-xs">chipmunk.db-shm</code> if they are there.
        </li>
        <li>
          Replace <code class="text-xs">chipmunk.db</code> with the one from the full backup zip, or with a copy from the
          <code class="text-xs">backups</code> folder renamed to <code class="text-xs">chipmunk.db</code>.
        </li>
        <li>Start Chipmunk.</li>
      </ol>
      <p class="text-sm text-muted-foreground">
        Every ledger goes back to that copy. Bank sign-ins and AI keys open only with the <code class="text-xs">secret.key</code> that
        was in use when it was made. To keep what's here now, download a full backup first.
      </p>
      <DialogFooter>
        <Button as-child variant="outline">
          <a href="/api/v1/backup/full" download><FolderArchive />Full backup (all ledgers)</a>
        </Button>
        <Button @click="open = false">Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
