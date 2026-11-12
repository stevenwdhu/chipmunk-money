<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Ellipsis, FolderArchive, Pencil, Plus, Star, Trash2 } from '@lucide/vue'
import type { Ledger } from '@chipmunk/shared'
import ArchiveLedgerDialog from '@/components/ledger/ArchiveLedgerDialog.vue'
import DeleteLedgerDialog from '@/components/ledger/DeleteLedgerDialog.vue'
import LedgerEditDialog from '@/components/ledger/LedgerEditDialog.vue'
import LedgerMark from '@/components/ledger/LedgerMark.vue'
import NewLedgerDialog from '@/components/ledger/NewLedgerDialog.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLedgerMutations, useLedgers } from '@/composables/queries'
import { useArchiveLedger } from '@/composables/useArchiveLedger'
import { errorMessage } from '@/lib/api'
import { currentLedger } from '@/lib/ledger'
import { alsoDone } from '@/lib/sharing'

const ledgers = useLedgers()
const m = useLedgerMutations()
const newOpen = ref(false)
const editing = ref<Ledger | null>(null)
const editOpen = ref(false)
const deleting = ref<Ledger | null>(null)
const deleteOpen = ref(false)

function edit(l: Ledger) {
  editing.value = l
  editOpen.value = true
}
function askDelete(l: Ledger) {
  deleting.value = l
  deleteOpen.value = true
}
const archived = (l: Ledger, changes: string[]) => toast.success(`Archived ${l.name}`, { description: alsoDone(changes) })
const archiving = useArchiveLedger(archived)
async function run(p: Promise<unknown>, message: string) {
  try {
    await p
    toast.success(message)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
/** Swaps the ledger with its neighbour in the menu order. */
function move(l: Ledger, dir: -1 | 1) {
  const list = ledgers.all.value
  const i = list.findIndex((x) => x.id === l.id)
  const other = list[i + dir]
  if (!other) return
  // Rewrite every position so ties from older data can't block the swap.
  list.forEach((x, idx) => {
    const sort = x.id === l.id ? idx + dir : x.id === other.id ? idx - dir : idx
    if (sort !== x.sort) m.update.mutate({ id: x.id, sort })
  })
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <div class="flex flex-wrap gap-2">
      <Button @click="newOpen = true"><Plus />New ledger</Button>
      <Button as-child variant="outline">
        <a href="/api/v1/backup/full" download><FolderArchive />Full backup (all ledgers)</a>
      </Button>
    </div>

    <Card class="gap-0 py-0">
      <CardHeader class="px-4 py-3 md:px-6">
        <CardTitle class="text-sm">Ledgers</CardTitle>
        <CardDescription>Each ledger is a separate set of books. The order here is the order in the ledger menu.</CardDescription>
      </CardHeader>
      <ul class="divide-y border-t">
        <li v-for="(l, i) in ledgers.all.value" :key="l.id" class="flex items-center gap-3 px-4 py-3 md:px-6" :class="l.archived && 'opacity-60'">
          <LedgerMark :ledger="l" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <RouterLink
                v-if="!l.archived"
                :to="{ name: 'overview', params: { ledger: l.slug } }"
                class="truncate font-medium hover:underline"
                >{{ l.name }}</RouterLink
              >
              <span v-else class="truncate font-medium">{{ l.name }}</span>
              <Badge v-if="l.isDefault" variant="secondary">Default</Badge>
              <Badge v-if="l.slug === currentLedger" variant="outline">Open</Badge>
              <Badge v-if="l.archived" variant="outline">Archived</Badge>
            </div>
            <div class="truncate text-xs text-muted-foreground">
              {{ l.accounts }} account{{ l.accounts === 1 ? '' : 's' }} · {{ l.transactions }} transactions · /l/{{ l.slug }}
            </div>
          </div>
          <div class="hidden gap-0.5 sm:flex">
            <Button variant="ghost" size="icon-sm" :disabled="i === 0" aria-label="Move up" @click="move(l, -1)"><ArrowUp /></Button>
            <Button variant="ghost" size="icon-sm" :disabled="i === ledgers.all.value.length - 1" aria-label="Move down" @click="move(l, 1)"><ArrowDown /></Button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${l.name}`"><Ellipsis /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <DropdownMenuItem @select="edit(l)"><Pencil />Edit</DropdownMenuItem>
              <DropdownMenuItem v-if="!l.isDefault && !l.archived" @select="run(m.update.mutateAsync({ id: l.id, isDefault: true }), `${l.name} now opens by default`)">
                <Star />Open by default
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="!l.archived"
                :disabled="ledgers.active.value.length < 2"
                @select="archiving.archive(l)"
              >
                <Archive />Archive
              </DropdownMenuItem>
              <DropdownMenuItem v-else @select="run(m.update.mutateAsync({ id: l.id, archived: false }), `Restored ${l.name}`)">
                <ArchiveRestore />Restore
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" :disabled="ledgers.all.value.length < 2" @select="askDelete(l)">
                <Trash2 />Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ul>
    </Card>

    <NewLedgerDialog v-model:open="newOpen" />
    <LedgerEditDialog v-model:open="editOpen" :ledger="editing" />
    <DeleteLedgerDialog v-model:open="deleteOpen" :ledger="deleting" />
    <ArchiveLedgerDialog v-model:open="archiving.open.value" :ledger="archiving.ledger.value" @archived="archived" />
  </div>
</template>
