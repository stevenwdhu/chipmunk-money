<script setup lang="ts">
import { computed } from 'vue'
import { statementBalance, type Account, type AccountSharing, type AccountSharingSet, type SharingChange } from '@chipmunk/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { useAccountSharingPreview } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { money } from '@/lib/format'
import { cn } from '@/lib/utils'

type Part = AccountSharing['home']

/**
 * What happens to the transactions of a ledger that stops having a shared account: they move to
 * the account's home, or stay in that ledger on a new manual account. Each choice shows the
 * balances it gives, as the server works them out in a dry run of the whole change (`inputs`).
 */
const props = defineProps<{
  account: Account
  /** The ledger that leaves, with what it holds. */
  leaving: Part
  /** The home once the change is made. */
  homeName: string
  /** The change as it stands, with this ledger's transactions going home, and kept. */
  inputs: { home: AccountSharingSet; keep: AccountSharingSet }
}>()
const choice = defineModel<'home' | 'keep' | null>({ default: null })

const previews = {
  home: useAccountSharingPreview(() => props.account.id, () => props.inputs.home),
  keep: useAccountSharingPreview(() => props.account.id, () => props.inputs.keep),
}
const n = computed(() => props.leaving.transactionCount ?? 0)
const options = computed(
  () =>
    [
      { value: 'home', label: `Move ${props.leaving.name}’s ${n.value} transaction${n.value === 1 ? '' : 's'} to ${props.homeName}` },
      { value: 'keep', label: `Keep ${n.value === 1 ? 'it' : 'them'} in ${props.leaving.name}, in a new manual account` },
    ] as const,
)

/** As the bank's statement shows it: for a credit card, what's owed. */
const shown = (minor: number) => money(statementBalance(minor, props.account.type))

/** Each ledger's balance on the account before and after, then the new account's when the transactions stay. */
function balances(r: SharingChange) {
  const lines = [r.sharing.home, ...r.sharing.members]
    .filter((l) => r.parts.after[l.slug] !== undefined)
    .map((l) => {
      const before = r.parts.before[l.slug]
      const after = r.parts.after[l.slug]!
      return { name: l.name, before: before === undefined || before === after ? null : shown(before), after: shown(after) }
    })
  const kept = r.removed.find((l) => l.ledger.slug === props.leaving.slug)?.account
  if (kept) lines.push({ name: `${props.leaving.name}’s new account`, before: null, after: shown(kept.balanceMinor) })
  return lines
}
</script>

<template>
  <div class="grid gap-2" role="radiogroup" :aria-label="`${leaving.name}’s transactions on ${account.name}`">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="choice === opt.value"
      :class="cn('grid gap-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors', choice === opt.value ? 'border-primary bg-muted' : 'hover:bg-muted/50')"
      @click="choice = opt.value"
    >
      <span class="font-medium">{{ opt.label }}</span>
      <span v-if="previews[opt.value].error.value" class="text-xs text-destructive">{{ errorMessage(previews[opt.value].error.value) }}</span>
      <span v-else-if="previews[opt.value].data.value" class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span v-for="b in balances(previews[opt.value].data.value!)" :key="b.name">
          {{ b.name }} <span class="tabular"><template v-if="b.before">{{ b.before }} → </template><span class="text-foreground">{{ b.after }}</span></span>
        </span>
      </span>
      <Skeleton v-else class="h-4 w-48" />
    </button>
  </div>
</template>
