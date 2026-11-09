<script setup lang="ts">
import { computed, onBeforeUnmount, useTemplateRef, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useUiStore } from '@/stores/ui'
import { titleOf } from '@/lib/payee'
import TransactionForm from './TransactionForm.vue'

/**
 * The transaction editor on a computer: a panel over the right side of the page, not a dialog. The
 * page stays where it is under a faint veil, and clicking it closes the panel. What the editor opens
 * (a payback, what the bank sent) is then the only dialog on screen. With unsaved changes, closing
 * asks first. While it's open only the panel scrolls: the page is held still.
 */
const ui = useUiStore()
const form = useTemplateRef<InstanceType<typeof TransactionForm>>('form')
const title = computed(() => (ui.editing ? 'Edit transaction' : 'Add transaction'))
const description = computed(() => {
  if (!ui.editing?.transferPairId) return 'Amounts are in CAD.'
  return ui.editing.transferMatched ? 'One side of a transfer the app matched. The other side keeps its own details.' : 'Changes apply to both sides of the transfer.'
})

// The page is held still on the root element: dialogs lock the body (and turn its pointer events off,
// which this panel can't have), so neither undoes the other. The scrollbar's room stays, so nothing shifts.
function holdPage(hold: boolean) {
  const root = document.documentElement.style
  root.overflow = hold ? 'hidden' : ''
  root.scrollbarGutter = hold ? 'stable' : ''
}
watch(() => ui.editorOpen, holdPage, { immediate: true })
onBeforeUnmount(() => holdPage(false))

// Escape closes it, unless a dialog, popover or menu over it takes the key (looked at before they
// handle it and close, hence the capture).
useEventListener(
  document,
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !ui.editorOpen || document.querySelector('[role="dialog"][data-state="open"], [role="menu"], [role="listbox"]')) return
    ui.requestClose()
  },
  { capture: true },
)

const asking = computed({ get: () => !!ui.pending, set: (v) => !v && (ui.pending = null) })
/** Saves, then goes on to what was waiting (another transaction, a new one, or closing). */
async function saveAndGo() {
  const p = ui.pending
  ui.pending = null
  if (!(await form.value?.save())) return
  if (p?.kind === 'edit') ui.openEdit(p.tx)
  else if (p?.kind === 'add') ui.openAdd(p.defaults)
}
</script>

<template>
  <!-- A faint veil over the rest: clicking it closes the panel. -->
  <div
    aria-hidden="true"
    :class="[
      'fixed inset-0 z-35 bg-background/40 transition-opacity duration-200 ease-out',
      ui.editorOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
    ]"
    @click="ui.requestClose()"
  />
  <aside
    :aria-label="title"
    :inert="!ui.editorOpen"
    :class="[
      'fixed inset-y-0 right-0 z-36 flex w-[26rem] flex-col border-l bg-background shadow-xl transition-transform duration-200 ease-out',
      ui.editorOpen ? 'translate-x-0' : 'translate-x-full',
    ]"
  >
    <header class="flex items-start gap-3 border-b px-5 py-4">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg leading-none font-semibold">{{ title }}</h2>
        <p class="mt-1.5 text-sm text-muted-foreground">{{ description }}</p>
      </div>
      <Button variant="ghost" size="icon-sm" class="-mt-1 -mr-2" aria-label="Close" @click="ui.requestClose()"><X /></Button>
    </header>
    <!-- Scrolling stops at its ends instead of going on to the page. -->
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
      <TransactionForm v-if="ui.editorOpen" ref="form" :transaction="ui.editing" :defaults="ui.defaults" @done="ui.close()" />
    </div>
  </aside>

  <Dialog v-model:open="asking">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Save your changes?</DialogTitle>
        <DialogDescription>
          {{ ui.editing ? `You changed ${titleOf(ui.editing)} and haven’t saved it.` : 'You started a transaction and haven’t saved it.' }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="ghost" @click="ui.pending = null">Keep editing</Button>
        <Button type="button" variant="outline" @click="ui.discard()">Discard</Button>
        <Button type="button" @click="saveAndGo">Save</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
