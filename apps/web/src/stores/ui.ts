import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Transaction } from '@st/shared'

export interface QuickAddDefaults {
  accountId?: number
  categoryId?: number | null
  date?: string
  payee?: string
  amountMinor?: number
}

/** A transaction whose category you just set, to ask what happens to its payee from now on. */
export interface PayeePrompt {
  payeeKey: string
  payee: string
  categoryId: number
  /** Accepted with its ✓: asked in a small popover by it (see PayeeChoicePopover). */
  txId?: number
}

/** Waiting for you to say what happens to unsaved changes: another transaction, a new one, or closing. */
export type EditorPending = { kind: 'edit'; tx: Transaction } | { kind: 'add'; defaults: QuickAddDefaults } | { kind: 'close' }

export const useUiStore = defineStore('ui', () => {
  const editorOpen = ref(false)
  const editing = ref<Transaction | null>(null)
  const defaults = ref<QuickAddDefaults>({})
  /** The editor has changes you haven't saved (set by the form). */
  const editorDirty = ref(false)
  const pending = ref<EditorPending | null>(null)

  /**
   * On a computer the editor is a panel beside the page, so another transaction can be opened while
   * it's open: with unsaved changes, it asks first (`pending`).
   */
  function openAdd(d: QuickAddDefaults = {}) {
    if (editorOpen.value && editorDirty.value) return void (pending.value = { kind: 'add', defaults: d })
    editing.value = null
    defaults.value = d
    editorOpen.value = true
  }

  function openEdit(tx: Transaction) {
    // The one that's open: a newer copy of it, and what you've typed stays.
    if (editorOpen.value && editing.value?.id === tx.id) return void (editing.value = tx)
    if (editorOpen.value && editorDirty.value) return void (pending.value = { kind: 'edit', tx })
    editing.value = tx
    defaults.value = {}
    editorOpen.value = true
  }

  /** Closing it yourself (✕, Escape): asks first when there are unsaved changes. */
  function requestClose() {
    if (editorDirty.value) pending.value = { kind: 'close' }
    else close()
  }

  /** Closes it as it is: after saving, or once you discard. */
  function close() {
    editorOpen.value = false
    editorDirty.value = false
    pending.value = null
  }

  /** Unsaved changes discarded: what was waiting goes ahead. */
  function discard() {
    const p = pending.value
    editorDirty.value = false
    pending.value = null
    if (!p || p.kind === 'close') close()
    else if (p.kind === 'edit') openEdit(p.tx)
    else openAdd(p.defaults)
  }

  const payeePrompt = ref<PayeePrompt | null>(null)
  /** The small popover by a ✓ is up (otherwise the panel at the bottom asks). */
  const payeePopoverShown = ref(false)
  /**
   * After you set or accept a transaction's category: not for transfers, refunds or none. `byCheck`:
   * accepted with its ✓, so asked right there.
   */
  function askAboutPayee(tx: Transaction, categoryId = tx.categoryId, byCheck = false) {
    if (!categoryId || tx.transferPairId || tx.categorySource === 'linked' || !tx.payeeKey) return
    payeePrompt.value = { payeeKey: tx.payeeKey, payee: tx.payeeName, categoryId, ...(byCheck ? { txId: tx.id } : {}) }
  }

  return { editorOpen, editing, defaults, editorDirty, pending, openAdd, openEdit, requestClose, close, discard, payeePrompt, payeePopoverShown, askAboutPayee }
})
