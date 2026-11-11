<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import { SIDEBAR_WIDTH, statementBalance } from '@chipmunk/shared'
import { VueDraggable } from 'vue-draggable-plus'
import LedgerSwitcher from '@/components/ledger/LedgerSwitcher.vue'
import { useAccounts, useCustomReportMutations, useCustomReports, useGroupedAccounts, useSettings, useUpdateSettings } from '@/composables/queries'
import { useColumnWidths } from '@/composables/useColumnWidths'
import { errorMessage } from '@/lib/api'
import { money } from '@/lib/format'
import { ledgerLink, navLink, primaryNav, secondaryNav } from '@/lib/nav'
import { cn } from '@/lib/utils'

const route = useRoute()
const { active: accounts } = useAccounts()
const groups = useGroupedAccounts(accounts)

const isActive = (name: string) => route.name === name || route.meta.parent === name

// Your custom reports under Reports, in your order: drag one to move it.
const reports = useCustomReports()
const { reorder } = useCustomReportMutations()
const reportList = ref<Array<{ id: number; name: string }>>([])
watch(
  () => reports.data.value,
  (list) => (reportList.value = (list ?? []).map((r) => ({ id: r.id, name: r.name }))),
  { immediate: true },
)
const reportOpen = (id: number) => route.name === 'reports' && route.params.reportId === String(id)
function saveReportOrder() {
  reorder.mutate(
    reportList.value.map((r) => r.id),
    { onError: (err) => toast.error(`Couldn’t move the report. ${errorMessage(err)}`) },
  )
}
const netWorth = computed(() => accounts.value.reduce((n, a) => n + a.balanceMinor, 0))

// Drag the right edge to resize; the width is an app setting, so it's the same on every device.
const aside = useTemplateRef<HTMLElement>('aside')
const settings = useSettings()
const updateSettings = useUpdateSettings()
const sizing = useColumnWidths(
  { sidebar: SIDEBAR_WIDTH.default },
  {
    table: aside,
    saved: () => (settings.data.value ? { sidebar: settings.data.value.sidebarWidth } : undefined),
    save: (next) =>
      updateSettings.mutateAsync({ sidebarWidth: next?.sidebar ?? null }).catch((err) => {
        toast.error(`Couldn’t save the sidebar width. ${errorMessage(err)}`)
        throw err
      }),
    min: SIDEBAR_WIDTH.min,
    max: SIDEBAR_WIDTH.max,
  },
)
</script>

<template>
  <aside
    ref="aside"
    :style="sizing.widthStyle('sidebar', false)"
    class="sticky top-0 hidden h-svh shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex"
  >
    <div
      v-bind="sizing.handleProps('sidebar', 'sidebar')"
      class="absolute inset-y-0 -right-1.5 z-30 w-3 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors hover:after:bg-primary/60 focus-visible:outline-none focus-visible:after:bg-primary"
    />
    <div class="flex h-14 items-center px-2">
      <LedgerSwitcher />
    </div>

    <nav class="flex flex-col gap-0.5 px-2 py-1" aria-label="Main">
      <RouterLink
        v-for="item in primaryNav"
        :key="item.name"
        :to="ledgerLink(item.name)"
        :class="
          cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            isActive(item.name)
              ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          )
        "
      >
        <component :is="item.icon" class="size-4" />{{ item.label }}
      </RouterLink>
      <VueDraggable
        v-if="reportList.length"
        v-model="reportList"
        tag="ul"
        :animation="150"
        ghost-class="opacity-40"
        class="flex flex-col gap-0.5"
        aria-label="Custom reports"
        @end="saveReportOrder"
      >
        <li v-for="r in reportList" :key="r.id">
          <RouterLink
            :to="ledgerLink('reports', { params: { reportId: String(r.id) } })"
            :title="`${r.name}: drag to move it`"
            :class="
              cn(
                'flex rounded-md py-1 pr-2 pl-8 text-sm transition-colors',
                reportOpen(r.id) ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )
            "
          >
            <span class="truncate">{{ r.name }}</span>
          </RouterLink>
        </li>
      </VueDraggable>
    </nav>

    <div class="mt-5 flex items-center justify-between px-4 text-xs font-medium text-muted-foreground">
      <span>Accounts</span>
      <span class="tabular">{{ money(netWorth) }}</span>
    </div>
    <div class="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-2 py-1.5">
      <section v-for="g in groups" :key="g.id" class="flex flex-col gap-0.5" :aria-labelledby="`sidebar-inst-${g.id}`">
        <h3 :id="`sidebar-inst-${g.id}`" class="truncate px-2 pt-1 text-[11px] font-medium tracking-wide text-muted-foreground/75 uppercase">{{ g.name }}</h3>
        <RouterLink
          v-for="a in g.accounts"
          :key="a.id"
          :to="ledgerLink('account', { params: { id: a.id } })"
          class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
          :class="route.name === 'account' && route.params.id === String(a.id) && 'bg-sidebar-accent'"
        >
          <span class="truncate">{{ a.name }}</span>
          <!-- As the bank shows it: a card's balance is what you owe. Red only for an overdrawn account. -->
          <span class="tabular shrink-0" :class="!a.isLiability && a.balanceMinor < 0 ? 'text-negative' : 'text-muted-foreground'">
            {{ money(statementBalance(a.balanceMinor, a.type)) }}
          </span>
        </RouterLink>
      </section>
      <RouterLink v-if="!accounts.length" :to="ledgerLink('accounts', { query: { new: '1' } })" class="px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground">
        Add your first account
      </RouterLink>
    </div>

    <div class="mt-auto flex flex-col gap-0.5 border-t px-2 py-2">
      <RouterLink
        v-for="item in secondaryNav"
        :key="item.name"
        :to="navLink(item)"
        :class="
          cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            isActive(item.name)
              ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          )
        "
      >
        <component :is="item.icon" class="size-4" />{{ item.label }}
      </RouterLink>
    </div>
  </aside>
</template>
