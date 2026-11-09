<script setup lang="ts">
import { watch } from 'vue'
import { useOnline } from '@vueuse/core'
import { useRegisterSW } from 'virtual:pwa-register/vue'
import { toast } from 'vue-sonner'
import { WifiOff } from '@lucide/vue'

const online = useOnline()

// Service worker updates: offer a reload instead of swapping versions underneath the user.
const { needRefresh, updateServiceWorker } = useRegisterSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    // Check for a new version every hour while the app stays open.
    if (registration) setInterval(() => registration.update(), 60 * 60 * 1000)
  },
})
watch(needRefresh, (v) => {
  if (!v) return
  toast('A new version of Spending Tracker is ready', {
    duration: Infinity,
    action: { label: 'Reload', onClick: () => updateServiceWorker(true) },
  })
})
</script>

<template>
  <div
    v-if="!online"
    class="sticky top-0 z-40 flex items-center justify-center gap-2 bg-warning px-4 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-xs font-medium text-black"
    role="status"
  >
    <WifiOff class="size-3.5" />You're offline. You can look around, but changes can't be saved until you reconnect.
  </div>
</template>
