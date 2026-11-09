<script setup lang="ts">
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { formatMoney, parseMoney, statementBalance, type Account } from '@st/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAccountMutations } from '@/composables/queries'
import { useToday } from '@/composables/useToday'
import { errorMessage } from '@/lib/api'

const props = defineProps<{ account: Account }>()
const open = defineModel<boolean>('open', { default: false })
const today = useToday()
const m = useAccountMutations()
const amount = ref('')
const date = ref('')
const error = ref('')

watch(open, (v) => {
  if (!v) return
  // As the bank shows it: what's owed on a debt (negative when it's in credit).
  amount.value = (statementBalance(props.account.balanceMinor, props.account.type) / 100).toFixed(2)
  date.value = today.value
  error.value = ''
})

async function submit() {
  const v = parseMoney(amount.value)
  if (v === null) {
    error.value = 'Enter the balance as a number'
    return
  }
  const balanceMinor = statementBalance(v, props.account.type)
  try {
    await m.setBalance.mutateAsync({ id: props.account.id, date: date.value, balanceMinor })
    toast.success(`${props.account.name} is now ${formatMoney(v)}${props.account.isLiability ? ' owed' : ''}`)
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Update balance</DialogTitle>
        <DialogDescription>
          Record what {{ account.name }} shows on {{ account.institution ? `your ${account.institution} statement` : 'your statement' }}.
          Transactions dated after this are added on top.
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label for="bal-amount">{{ account.isLiability ? 'Amount owed' : 'Balance' }}</Label>
            <Input id="bal-amount" v-model="amount" inputmode="decimal" class="tabular" />
          </div>
          <div class="grid gap-1.5">
            <Label for="bal-date">As of</Label>
            <Input id="bal-date" v-model="date" type="date" :max="today" />
          </div>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="m.setBalance.isPending.value">Save balance</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
