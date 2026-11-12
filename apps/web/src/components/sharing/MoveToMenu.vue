<script setup lang="ts">
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import type { Ledger, MoveResult } from '@chipmunk/shared'
import LedgerMark from '@/components/ledger/LedgerMark.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { previewMove, useLedgers, useMoveTransactions } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { currentLedger } from '@/lib/ledger'
import { dropsAnything, moveDrops, moveSummary } from '@/lib/sharing'
import { useUiStore } from '@/stores/ui'

/**
 * "Move to…": a menu of the other ledgers that have the transactions' account, around the button in
 * its slot. Picking one asks the server what the move would let go of (a dry run). When it's
 * something, that's said first, to confirm. Otherwise they move right away. Nothing shows when there
 * is no ledger to move them to. When they can't move for another reason (`blocked`), that's said in
 * place of the button. Once they've moved, an editor open on one of them closes: it's another
 * ledger's now.
 */
const props = withDefaults(
  defineProps<{
    ids: number[]
    /** Every ledger that has their account. */
    ledgers: Array<{ slug: string; name: string }>
    /** The ledger that holds them, by slug: this one unless said. */
    from?: string
    align?: 'start' | 'center' | 'end'
    /** Why they can't move as they are, in a sentence. */
    blocked?: string | null
  }>(),
  { align: 'start', blocked: null },
)
const emit = defineEmits<{ moved: [MoveResult] }>()

const ui = useUiStore()
const all = useLedgers()
const m = useMoveTransactions()
const from = computed(() => props.from ?? currentLedger.value)
const nameOf = (slug: string) => all.all.value.find((l) => l.slug === slug)?.name ?? slug
/** An archived ledger takes no transactions. */
const targets = computed(() => all.all.value.filter((l) => !l.archived && l.slug !== from.value && props.ledgers.some((x) => x.slug === l.slug)))

/** Asking the server what a move would do. */
const asking = ref(false)
/** A move that lets go of something, waiting to be confirmed. */
const pending = ref<{ ids: number[]; to: Ledger; drops: string[] } | null>(null)
const confirming = computed({ get: () => !!pending.value, set: (v) => !v && (pending.value = null) })
const busy = computed(() => asking.value || m.isPending.value)

async function pick(to: Ledger) {
  const ids = [...props.ids]
  if (!ids.length || busy.value) return
  asking.value = true
  try {
    const would = await previewMove({ ids, to: to.slug, from: from.value })
    if (dropsAnything(would)) pending.value = { ids, to, drops: moveDrops(would, nameOf(from.value), nameOf) }
    else await move(ids, to)
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    asking.value = false
  }
}

async function move(ids: number[], to: Ledger) {
  try {
    const r = await m.mutateAsync({ ids, to: to.slug, from: from.value })
    pending.value = null
    if (ui.editorOpen && ui.editing && ids.includes(ui.editing.id)) ui.close()
    toast.success(`Moved ${r.moved} to ${to.name}`, { description: moveSummary(r, to.name) })
    emit('moved', r)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <span v-if="targets.length && blocked" class="text-sm text-muted-foreground">{{ blocked }}</span>
  <template v-else-if="targets.length">
    <DropdownMenu>
      <DropdownMenuTrigger as-child :disabled="busy"><slot :busy="busy" /></DropdownMenuTrigger>
      <DropdownMenuContent :align="align" class="w-56">
        <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Move to</DropdownMenuLabel>
        <DropdownMenuItem v-for="l in targets" :key="l.id" @select="pick(l)">
          <LedgerMark :ledger="l" size="sm" />
          <span class="min-w-0 flex-1 truncate">{{ l.name }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <Dialog v-model:open="confirming">
      <DialogContent v-if="pending" class="max-h-[90svh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {{ pending.ids.length === 1 ? 'it' : `${pending.ids.length} transactions` }} to {{ pending.to.name }}?</DialogTitle>
          <DialogDescription>What ties {{ pending.ids.length === 1 ? 'it' : 'them' }} to {{ nameOf(from) }} doesn’t go along.</DialogDescription>
        </DialogHeader>
        <ul class="grid gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <li v-for="d in pending.drops" :key="d">{{ d }}</li>
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" @click="pending = null">Cancel</Button>
          <Button type="button" :disabled="m.isPending.value" @click="move(pending.ids, pending.to)">
            <Loader2 v-if="m.isPending.value" class="animate-spin" />Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </template>
</template>
