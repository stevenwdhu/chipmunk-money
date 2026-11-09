<script setup lang="ts">
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { EyeOff } from '@lucide/vue'
import { pick, withSide, type CustomReport, type FilterSide, type Transaction } from '@st/shared'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useCategories, useCustomReportMutations, useCustomReports } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

/**
 * Filters transactions out of one of your custom reports, one at a time (picked), from the editor or
 * a selection. Money out goes on the report's spending side, and so does money in that's in a
 * spending category (a refund). Other money in goes on its income side.
 */
const props = withDefaults(defineProps<{ transactions: Transaction[]; variant?: 'link' | 'button' }>(), { variant: 'link' })
const emit = defineEmits<{ done: [] }>()
const reports = useCustomReports()
const { update } = useCustomReportMutations()
const { byId: categories } = useCategories()
const list = computed(() => reports.data.value ?? [])

const sideOf = (t: Transaction): FilterSide => {
  const c = t.categoryId === null ? undefined : categories.value.get(t.categoryId)
  return t.amountMinor < 0 || (c && !c.isIncome) ? 'spending' : 'income'
}

async function filterOut(r: CustomReport) {
  const before = r.spec
  let filter = r.spec.filter
  for (const t of props.transactions) filter = withSide(filter, sideOf(t), (s) => pick(s, t.id))
  try {
    await update.mutateAsync({ id: r.id, spec: { ...r.spec, filter } })
    const n = props.transactions.length
    toast(`Filtered ${n === 1 ? 'it' : `${n} transactions`} out of ${r.name}`, {
      action: { label: 'Undo', onClick: () => update.mutate({ id: r.id, spec: before }, { onError: (err) => toast.error(errorMessage(err)) }) },
    })
    emit('done')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <DropdownMenu v-if="list.length && transactions.length">
    <DropdownMenuTrigger as-child>
      <button v-if="variant === 'link'" type="button" class="self-start text-sm text-muted-foreground underline-offset-4 hover:underline">
        Filter out of a report
      </button>
      <Button v-else size="sm" variant="outline"><EyeOff />Filter out of a report</Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-56">
      <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Filter out of</DropdownMenuLabel>
      <DropdownMenuItem v-for="r in list" :key="r.id" :disabled="update.isPending.value" @select="filterOut(r)">{{ r.name }}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
