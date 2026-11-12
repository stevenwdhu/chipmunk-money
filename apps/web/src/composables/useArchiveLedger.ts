import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { Ledger } from '@chipmunk/shared'
import { askLedger, useLedgerMutations } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

/**
 * Archiving a ledger: at once, unless it has something to ask or say first (it has a shared
 * account). Then `open` shows ArchiveLedgerDialog for `ledger`, which archives it with the answers.
 * `done` runs once it's archived, either way, with what that did in words.
 */
export function useArchiveLedger(done: (ledger: Ledger, changes: string[]) => void) {
  const m = useLedgerMutations()
  const ledger = ref<Ledger | null>(null)
  const open = ref(false)
  async function archive(l: Ledger) {
    try {
      const asked = await askLedger(l.slug, 'archive')
      if (asked.questions.length + asked.notices.length + asked.blockers.length) {
        ledger.value = l
        open.value = true
        return
      }
      const { changes } = await m.update.mutateAsync({ id: l.id, archived: true })
      done(l, changes)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  return { ledger, open, archive }
}
