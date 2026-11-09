<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopOnly from '@/components/DesktopOnly.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import AiSettings from '@/components/settings/AiSettings.vue'
import ApiKeysSettings from '@/components/settings/ApiKeysSettings.vue'
import BankSyncSettings from '@/components/settings/BankSyncSettings.vue'
import SharedCategorySettings from '@/components/settings/SharedCategorySettings.vue'
import GeneralSettings from '@/components/settings/GeneralSettings.vue'
import LedgersSettings from '@/components/settings/LedgersSettings.vue'
import PayeeNameRules from '@/components/settings/PayeeNameRules.vue'
import PayeeTidySettings from '@/components/settings/PayeeTidySettings.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIsDesktop } from '@/composables/useBreakpoint'

const route = useRoute()
const router = useRouter()
const isDesktop = useIsDesktop()
/** Setup and reorganizing (`desktop`) are left out of the tabs on a phone; opened anyway, they say so. */
const tabs = [
  { value: 'general', label: 'General' },
  { value: 'ledgers', label: 'Ledgers', desktop: true },
  { value: 'categories', label: 'Categories', desktop: true },
  { value: 'payees', label: 'Payees', desktop: true },
  { value: 'bank', label: 'Bank sync' },
  { value: 'ai', label: 'AI', desktop: true },
  { value: 'api', label: 'API keys', desktop: true },
]
const shown = computed(() => tabs.filter((t) => isDesktop.value || !t.desktop))
const tab = computed({
  get: () => (tabs.some((t) => t.value === route.query.tab) ? (route.query.tab as string) : 'general'),
  set: (v) => router.replace({ query: { tab: v === 'general' ? undefined : v } }),
})
</script>

<template>
  <PageHeader title="App settings" subtitle="Shared by all ledgers" :ledger="false" />
  <main class="p-4 md:p-6">
    <Tabs v-model="tab" class="mx-auto max-w-3xl">
      <TabsList class="w-full justify-start overflow-x-auto sm:w-auto">
        <TabsTrigger v-for="t in shown" :key="t.value" :value="t.value">{{ t.label }}</TabsTrigger>
      </TabsList>
      <TabsContent value="general" class="mt-2"><GeneralSettings /></TabsContent>
      <TabsContent value="ledgers" class="mt-2"><DesktopOnly what="Add and manage ledgers"><LedgersSettings /></DesktopOnly></TabsContent>
      <TabsContent value="categories" class="mt-2"><DesktopOnly what="Manage categories"><SharedCategorySettings /></DesktopOnly></TabsContent>
      <TabsContent value="payees" class="mt-2">
        <DesktopOnly what="Manage payee names">
          <div class="grid grid-cols-1 gap-4"><PayeeTidySettings /><PayeeNameRules /></div>
        </DesktopOnly>
      </TabsContent>
      <TabsContent value="bank" class="mt-2"><BankSyncSettings /></TabsContent>
      <TabsContent value="ai" class="mt-2"><DesktopOnly what="Set up AI"><AiSettings /></DesktopOnly></TabsContent>
      <TabsContent value="api" class="mt-2"><DesktopOnly what="Manage API keys"><ApiKeysSettings /></DesktopOnly></TabsContent>
    </Tabs>
  </main>
</template>
