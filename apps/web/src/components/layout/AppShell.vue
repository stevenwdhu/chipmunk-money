<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus } from '@lucide/vue'
import TransactionPanel from '@/components/TransactionPanel.vue'
import { Button } from '@/components/ui/button'
import { useIsDesktop } from '@/composables/useBreakpoint'
import { useUiStore } from '@/stores/ui'
import AppSidebar from './AppSidebar.vue'
import BottomNav from './BottomNav.vue'

const ui = useUiStore()
const isDesktop = useIsDesktop()
const route = useRoute()
const router = useRouter()

// /add (PWA shortcut) lands here with ?add=1
watch(
  () => route.query.add,
  (v) => {
    if (v === '1') {
      ui.openAdd()
      router.replace({ query: { ...route.query, add: undefined } })
    }
  },
  { immediate: true },
)

// "n" opens quick add on desktop, unless typing in a field.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey || ui.editorOpen) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
  e.preventDefault()
  ui.openAdd()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="flex min-h-svh">
    <AppSidebar />
    <div class="flex min-w-0 flex-1 flex-col">
      <slot />
      <!-- Room for the bottom nav on phones -->
      <div class="h-24 md:hidden" aria-hidden="true" />
    </div>
    <!-- On a computer the editor is a panel over the page's right side; on a phone it's a drawer (TransactionEditor). -->
    <TransactionPanel v-if="isDesktop" />
    <!-- Not on Reports, whose bar for saving a report sits there. -->
    <Button
      v-if="route.name !== 'reports'"
      class="fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 size-14 rounded-full shadow-lg md:hidden"
      aria-label="Add transaction"
      @click="ui.openAdd()"
    >
      <Plus class="size-6" />
    </Button>
    <BottomNav />
  </div>
</template>
