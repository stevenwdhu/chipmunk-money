import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { ApiError } from './lib/api'
import { installLedgerGuard, router } from './router'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
})

installLedgerGuard(queryClient)

const app = createApp(App).use(createPinia()).use(router).use(VueQueryPlugin, { queryClient })
// Wait for the first navigation so the current ledger is known before any page asks for data.
router.isReady().then(() => app.mount('#app'))
