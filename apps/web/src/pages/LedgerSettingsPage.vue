<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopOnly from '@/components/DesktopOnly.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import LedgerCategories from '@/components/settings/LedgerCategories.vue'
import DataSettings from '@/components/settings/DataSettings.vue'
import LedgerGeneralSettings from '@/components/settings/LedgerGeneralSettings.vue'
import PayeeSettings from '@/components/settings/PayeeSettings.vue'
import TagSettings from '@/components/settings/TagSettings.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useLedgers } from '@/composables/queries'
import { useIsDesktop } from '@/composables/useBreakpoint'

const route = useRoute()
const router = useRouter()
const { current } = useLedgers()
const isDesktop = useIsDesktop()
/** Setup and reorganizing (`desktop`) are left out of the tabs on a phone; opened anyway, they say so. */
const tabs = [
  { value: 'general', label: 'General' },
  { value: 'categories', label: 'Categories', desktop: true },
  { value: 'payees', label: 'Payees', desktop: true },
  { value: 'tags', label: 'Tags' },
  { value: 'data', label: 'Data', desktop: true },
]
const shown = computed(() => tabs.filter((t) => isDesktop.value || !t.desktop))
const tab = computed({
  get: () => (tabs.some((t) => t.value === route.query.tab) ? (route.query.tab as string) : 'general'),
  set: (v) => router.replace({ query: { tab: v === 'general' ? undefined : v } }),
})
</script>

<template>
  <PageHeader title="Ledger settings" :subtitle="current?.name" />
  <main class="p-4 md:p-6">
    <Tabs v-model="tab" class="mx-auto max-w-3xl">
      <TabsList class="w-full justify-start overflow-x-auto sm:w-auto">
        <TabsTrigger v-for="t in shown" :key="t.value" :value="t.value">{{ t.label }}</TabsTrigger>
      </TabsList>
      <TabsContent value="general" class="mt-2"><LedgerGeneralSettings /></TabsContent>
      <TabsContent value="categories" class="mt-2"><DesktopOnly what="Manage categories"><LedgerCategories /></DesktopOnly></TabsContent>
      <TabsContent value="payees" class="mt-2"><DesktopOnly what="Manage payees"><PayeeSettings /></DesktopOnly></TabsContent>
      <TabsContent value="tags" class="mt-2"><TagSettings /></TabsContent>
      <TabsContent value="data" class="mt-2"><DesktopOnly what="Import, export and back up data"><DataSettings /></DesktopOnly></TabsContent>
    </Tabs>
  </main>
</template>
