<script setup lang="ts">
import { computed } from 'vue'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useUiStore } from '@/stores/ui'
import TransactionForm from './TransactionForm.vue'

const ui = useUiStore()
const isDesktop = useIsDesktop()
const title = computed(() => (ui.editing ? 'Edit transaction' : 'Add transaction'))
const description = computed(() => {
  if (!ui.editing?.transferPairId) return 'Amounts are in CAD.'
  return ui.editing.transferMatched ? 'One side of a transfer the app matched. The other side keeps its own details.' : 'Changes apply to both sides of the transfer.'
})
const open = computed({ get: () => ui.editorOpen, set: (v) => (ui.editorOpen = v) })
</script>

<template>
  <!-- On a computer it's a panel beside the page instead (TransactionPanel, in the app shell). -->
  <Drawer v-if="!isDesktop" v-model:open="open">
    <DrawerContent class="max-h-[92svh]">
      <DrawerHeader class="pb-1 text-left">
        <DrawerTitle>{{ title }}</DrawerTitle>
        <DrawerDescription>{{ description }}</DrawerDescription>
      </DrawerHeader>
      <div class="overflow-x-hidden overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <TransactionForm :transaction="ui.editing" :defaults="ui.defaults" @done="ui.close()" />
      </div>
    </DrawerContent>
  </Drawer>
</template>
