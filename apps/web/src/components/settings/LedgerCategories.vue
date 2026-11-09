<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { Loader2 } from '@lucide/vue'
import { UNGROUPED_COLOR, type Category, type CategoryGroup } from '@st/shared'
import CategoryPicker from '@/components/CategoryPicker.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useCategories, useLedgerCategorySettings, useLedgers } from '@/composables/queries'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import CategorySettings from './CategorySettings.vue'
import JoinSharedCategoriesDialog from './JoinSharedCategoriesDialog.vue'

/**
 * A ledger's categories: either the shared list (App settings), turned on and off here, or the
 * ledger's own list, edited here.
 */
const q = useCategories()
const { groups, categories, labels, shared } = q
const { current } = useLedgers()
const m = useLedgerCategorySettings()
const ledgerName = computed(() => current.value?.name ?? 'This ledger')
const labelById = computed(() => new Map(labels.value.map((l) => [l.id, l])))

const sections = computed(() => {
  const list: Array<{ group: CategoryGroup | null; items: Category[] }> = groups.value.map((g) => ({
    group: g,
    items: categories.value.filter((c) => c.groupId === g.id),
  }))
  const loose = categories.value.filter((c) => c.groupId === null)
  if (loose.length) list.push({ group: null, items: loose })
  return list.filter((s) => s.items.length)
})

// Turning a category on, or off (asking where its transactions go if it has any).
const turningOff = ref<Category | null>(null)
const moveTo = ref<number | null>(null)
const leaveUncategorized = ref(false)
async function setEnabled(c: Category, enabled: boolean) {
  if (!enabled && c.transactionCount) {
    turningOff.value = c
    moveTo.value = null
    leaveUncategorized.value = false
    return
  }
  try {
    await m.setEnabled.mutateAsync({ id: c.id, enabled })
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
async function confirmOff() {
  const c = turningOff.value
  if (!c) return
  if (!leaveUncategorized.value && !moveTo.value) return void toast.error('Choose a category for its transactions')
  try {
    await m.setEnabled.mutateAsync({ id: c.id, enabled: false, moveTo: leaveUncategorized.value ? null : moveTo.value })
    toast.success(`Turned off ${c.name}`)
    turningOff.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

// Switching between the shared list and the ledger's own.
const leaving = ref(false)
const joining = ref(false)
async function useOwnList() {
  try {
    await m.setSharing.mutateAsync({ shared: false })
    toast.success(`${ledgerName.value} has its own categories now`)
    leaving.value = false
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
</script>

<template>
  <div v-if="q.isLoading.value" class="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 class="size-4 animate-spin" />Loading…</div>

  <div v-else-if="shared" class="grid grid-cols-1 gap-4">
    <Card class="gap-4">
      <CardHeader>
        <CardTitle>Shared categories</CardTitle>
        <CardDescription>
          {{ ledgerName }} uses the categories in App settings, shared with other ledgers. Turn off the ones it doesn’t need: they’re not
          offered when you categorize here.
        </CardDescription>
      </CardHeader>
      <div class="flex flex-wrap gap-2 px-6">
        <Button as-child variant="outline" size="sm"><RouterLink :to="{ name: 'app-settings', query: { tab: 'categories' } }">Edit the shared list</RouterLink></Button>
        <Button variant="outline" size="sm" @click="leaving = true">Use its own categories</Button>
      </div>
    </Card>

    <Card v-for="s in sections" :key="s.group?.id ?? 'none'" class="gap-0 py-0">
      <CardHeader class="gap-y-0 px-4 py-3 md:px-6">
        <CardTitle class="flex min-w-0 items-center gap-3 text-sm">
          <span class="size-3.5 shrink-0 rounded-full" :style="{ background: s.group?.color ?? UNGROUPED_COLOR }" />
          <span class="truncate">{{ s.group?.name ?? 'No group' }}</span>
          <span class="shrink-0 font-normal text-muted-foreground tabular">{{ s.items.filter((c) => !c.archived).length }} of {{ s.items.length }} on</span>
        </CardTitle>
      </CardHeader>
      <ul class="divide-y border-t">
        <li v-for="c in s.items" :key="c.id" class="flex items-center gap-3 px-4 py-2.5 md:px-6">
          <div :class="cn('flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1', c.archived && 'opacity-50')">
            <span class="min-w-0 truncate text-sm">{{ c.name }}</span>
            <span
              v-for="l in c.labelIds.map((id) => labelById.get(id)).filter((x) => !!x)"
              :key="l!.id"
              class="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] text-muted-foreground"
            >
              <span class="size-1.5 rounded-full" :style="{ background: l!.color }" />{{ l!.name }}
            </span>
          </div>
          <span v-if="c.transactionCount" class="shrink-0 text-xs text-muted-foreground tabular">{{ c.transactionCount }}</span>
          <Switch
            :model-value="!c.archived"
            :aria-label="`${c.name} in ${ledgerName}`"
            :disabled="m.setEnabled.isPending.value"
            @update:model-value="(v) => setEnabled(c, v)"
          />
        </li>
      </ul>
    </Card>
  </div>

  <div v-else class="grid grid-cols-1 gap-4">
    <Card class="gap-4">
      <CardHeader>
        <CardTitle>{{ ledgerName }}’s own categories</CardTitle>
        <CardDescription>Changes here are only for {{ ledgerName }}. Other ledgers use the shared list in App settings.</CardDescription>
      </CardHeader>
      <div class="flex flex-wrap gap-2 px-6">
        <Button variant="outline" size="sm" @click="joining = true">Use the shared categories</Button>
      </div>
    </Card>
    <CategorySettings scope="ledger" />
  </div>

  <JoinSharedCategoriesDialog v-model:open="joining" :ledger-name="ledgerName" />

  <Dialog :open="!!turningOff" @update:open="(v) => !v && (turningOff = null)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Turn off {{ turningOff?.name }}?</DialogTitle>
        <DialogDescription>
          {{ turningOff?.transactionCount }} transaction{{ turningOff?.transactionCount === 1 ? '' : 's' }} in {{ ledgerName }}
          {{ turningOff?.transactionCount === 1 ? 'uses' : 'use' }} it. Where should {{ turningOff?.transactionCount === 1 ? 'it' : 'they' }} go?
        </DialogDescription>
      </DialogHeader>
      <div class="grid gap-2" role="radiogroup" aria-label="Where its transactions go">
        <button
          type="button"
          role="radio"
          :aria-checked="!leaveUncategorized"
          :class="cn('rounded-lg border px-3 py-2 text-left text-sm transition-colors', !leaveUncategorized ? 'border-primary bg-muted' : 'hover:bg-muted/50')"
          @click="leaveUncategorized = false"
        >
          <span class="font-medium">Move them to another category</span>
        </button>
        <CategoryPicker
          v-if="!leaveUncategorized"
          v-model="moveTo"
          :allow-none="false"
          :exclude="turningOff ? [turningOff.id] : []"
          placeholder="Choose a category"
          class="w-full"
        />
        <button
          type="button"
          role="radio"
          :aria-checked="leaveUncategorized"
          :class="cn('rounded-lg border px-3 py-2 text-left text-sm transition-colors', leaveUncategorized ? 'border-primary bg-muted' : 'hover:bg-muted/50')"
          @click="leaveUncategorized = true"
        >
          <span class="font-medium">Leave them uncategorized</span>
        </button>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="turningOff = null">Cancel</Button>
        <Button :disabled="m.setEnabled.isPending.value" @click="confirmOff">Turn off</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="leaving">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Give {{ ledgerName }} its own categories?</DialogTitle>
        <DialogDescription>
          It keeps a copy of the shared list, including which ones are off, to edit here. Changes to the shared list won’t reach it any
          more.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="leaving = false">Cancel</Button>
        <Button :disabled="m.setSharing.isPending.value" @click="useOwnList">Use its own categories</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
