<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useEventListener } from '@vueuse/core'
import 'vue-sonner/style.css'
import AppShell from '@/components/layout/AppShell.vue'
import AppStatus from '@/components/layout/AppStatus.vue'
import PayeeChoicePrompt from '@/components/PayeeChoicePrompt.vue'
import TransactionEditor from '@/components/TransactionEditor.vue'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSetupStatus } from '@/composables/queries'
import { useTheme } from '@/composables/useTheme'
import { ShieldAlert } from '@lucide/vue'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { accessRefused } from '@/lib/api'
import WelcomePage from '@/pages/WelcomePage.vue'

// Top-level refs are unwrapped in templates, so expose the resolved theme directly.
const resolvedTheme = useTheme().state

// A ledger that is still empty and not set up shows the welcome screen instead of its pages.
const route = useRoute()
const inLedger = computed(() => typeof route.params.ledger === 'string')
const setup = useSetupStatus(inLedger)
const showWelcome = computed(() => inLedger.value && setup.data.value?.needsSetup === true)
// If the server can't be reached, show the app anyway; its pages report the error.
const ready = computed(() => !inLedger.value || setup.isSuccess.value || setup.isError.value)

const reload = () => window.location.reload()

// A toast goes when you click it (its own close button, hidden, does it). Its buttons, like Undo, still do theirs.
useEventListener(document, 'click', (event) => {
  const target = event.target as Element | null
  if (target?.closest('[data-sonner-toast] button')) return
  target?.closest('[data-sonner-toast]')?.querySelector<HTMLElement>('[data-close-button]')?.click()
})
</script>

<template>
  <TooltipProvider :delay-duration="150">
    <AppStatus />
    <main v-if="accessRefused" class="grid min-h-dvh place-items-center">
      <EmptyState :icon="ShieldAlert" title="Spending Tracker won’t open here" :description="accessRefused">
        <Button variant="outline" @click="reload">Try again</Button>
      </EmptyState>
    </main>
    <WelcomePage v-else-if="showWelcome" />
    <template v-else-if="ready">
      <AppShell>
        <RouterView />
      </AppShell>
      <TransactionEditor />
      <PayeeChoicePrompt />
    </template>
  </TooltipProvider>
  <Toaster
    position="top-center"
    :theme="resolvedTheme === 'dark' ? 'dark' : 'light'"
    rich-colors
    close-button
    :toast-options="{ duration: 5000, classes: { toast: 'cursor-pointer', closeButton: '!hidden' } }"
  />
</template>
