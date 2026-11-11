<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Archive, ArchiveRestore, Ellipsis, GripVertical, ListChecks, Merge, Minus, Pencil, Plus, Tag, Trash2 } from '@lucide/vue'
import { VueDraggable } from 'vue-draggable-plus'
import { UNGROUPED_COLOR, unusedColor, type Category, type CategoryGroup, type Label } from '@chipmunk/shared'
import CategoryPicker from '@/components/CategoryPicker.vue'
import ColorPicker from '@/components/ColorPicker.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useCategories, useCategoryMutations, useLabelMutations, type CategoryScope } from '@/composables/queries'
import { useReportsUsing } from '@/composables/useReportsUsing'
import { useCustomColors } from '@/composables/useCustomColors'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import CategoryDialog from './CategoryDialog.vue'
import LabelDialog from './LabelDialog.vue'

/** Edits the shared list (App settings) or, for a ledger with its own, the ledger's list. */
const props = withDefaults(defineProps<{ scope?: CategoryScope }>(), { scope: 'ledger' })
const shared = props.scope === 'shared'
/** Where a change to the shared list lands. */
const everywhere = shared ? ' in every ledger that uses the shared list' : ''
/** How many transactions use some categories: in this ledger, or across the ledgers that share the list. */
function usage(cats: Category[]) {
  const n = cats.reduce((sum, c) => sum + (c.transactionCount ?? 0), 0)
  const where = shared ? ' across your ledgers' : ''
  return { n, text: n ? `${n} transaction${n === 1 ? '' : 's'}${where}` : `no transactions${where}` }
}
const deletingUsage = computed(() => usage(deleting.value ? [deleting.value] : []))
const deletingReports = useReportsUsing('category', () => deleting.value?.id)

const { groups, categories, labels } = useCategories(props.scope)
const m = useCategoryMutations(props.scope)
const lm = useLabelMutations(props.scope)
const labelById = computed(() => new Map(labels.value.map((l) => [l.id, l])))
const labelsOf = (c: Category) => c.labelIds.map((id) => labelById.value.get(id)).filter((l): l is Label => !!l)


/**
 * The groups, each with its categories, as lists you rearrange by their handles: drag a group's
 * card to reorder the groups, a category within its group to reorder it, or into another group to
 * move it there. They follow the saved order, and are saved when you drop.
 */
type Section = { key: string; group: CategoryGroup | null }
const keyOf = (groupId: number | null) => (groupId === null ? 'none' : String(groupId))
const sections = ref<Section[]>([])
const lists = ref<Record<string, Category[]>>({})
watch(
  [groups, categories],
  () => {
    const loose = categories.value.filter((c) => c.groupId === null)
    sections.value = [...groups.value.map((g) => ({ key: keyOf(g.id), group: g })), ...(loose.length ? [{ key: 'none', group: null }] : [])]
    lists.value = Object.fromEntries([...groups.value.map((g) => [keyOf(g.id), categories.value.filter((c) => c.groupId === g.id)]), ['none', loose]])
  },
  { immediate: true },
)
const groupOf = (key: string) => (key === 'none' ? null : Number(key))

async function saveGroupOrder() {
  const ids = sections.value.flatMap((s) => (s.group ? [s.group.id] : []))
  if (ids.every((id, i) => id === groups.value[i]?.id)) return
  await m.reorderGroups.mutateAsync(ids).catch((err) => toast.error(errorMessage(err)))
}
/** After a drop: a category dragged into another group moves there, then the new order is saved. */
async function saveCategoryOrder() {
  await nextTick()
  try {
    for (const s of sections.value) {
      for (const c of lists.value[s.key] ?? []) {
        if (c.groupId !== groupOf(s.key)) await m.update.mutateAsync({ id: c.id, groupId: groupOf(s.key) })
      }
    }
    const ids = sections.value.flatMap((s) => (lists.value[s.key] ?? []).map((c) => c.id))
    const before = [...groups.value.map((g) => g.id), null].flatMap((g) => categories.value.filter((c) => c.groupId === g).map((c) => c.id))
    if (ids.some((id, i) => id !== before[i])) await m.reorder.mutateAsync(ids)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
/** The keyboard way: ↑/↓ on a handle moves it one place. */
async function nudgeGroup(index: number, dir: -1 | 1) {
  const list = sections.value
  const to = index + dir
  if (to < 0 || to >= list.length || !list[to]!.group || !list[index]!.group) return
  ;[list[index], list[to]] = [list[to]!, list[index]!]
  await saveGroupOrder()
}
async function nudgeCategory(key: string, index: number, dir: -1 | 1) {
  const list = lists.value[key]!
  const to = index + dir
  if (to < 0 || to >= list.length) return
  ;[list[index], list[to]] = [list[to]!, list[index]!]
  await saveCategoryOrder()
}

const dialogOpen = ref(false)
const editing = ref<Category | null>(null)
const forGroup = ref<number | null>(null)
function add(groupId: number | null) {
  editing.value = null
  forGroup.value = groupId
  dialogOpen.value = true
}
function edit(c: Category) {
  editing.value = c
  dialogOpen.value = true
}

// Groups: their name and colour.
const groupDialog = ref(false)
const groupName = ref('')
const groupColor = ref('')
const renaming = ref<CategoryGroup | null>(null)
const customColors = useCustomColors()
function openGroup(g: CategoryGroup | null) {
  renaming.value = g
  groupName.value = g?.name ?? ''
  groupColor.value = g?.color ?? unusedColor(groups.value.map((x) => x.color))
  groupDialog.value = true
}
async function saveGroup() {
  if (!groupName.value.trim()) return
  try {
    const input = { name: groupName.value.trim(), color: groupColor.value }
    if (renaming.value) await m.updateGroup.mutateAsync({ id: renaming.value.id, ...input })
    else await m.createGroup.mutateAsync(input)
    customColors.remember(groupColor.value)
    groupDialog.value = false
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

const deleting = ref<Category | null>(null)
async function confirmDelete() {
  if (!deleting.value) return
  try {
    await m.remove.mutateAsync(deleting.value.id)
    toast.success(`Deleted ${deleting.value.name}`)
    deleting.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
// A group goes with its categories.
const deletingGroup = ref<CategoryGroup | null>(null)
const groupCount = computed(() => categories.value.filter((c) => c.groupId === deletingGroup.value?.id).length)
const groupUsage = computed(() => usage(categories.value.filter((c) => c.groupId === deletingGroup.value?.id)))
const deletingGroupReports = useReportsUsing('group', () => deletingGroup.value?.id)
async function confirmDeleteGroup() {
  const g = deletingGroup.value
  if (!g) return
  try {
    await m.removeGroup.mutateAsync(g.id)
    toast.success(`Deleted ${g.name}`)
    deletingGroup.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
// Merging: one category's transactions move to another, and it's deleted.
const merging = ref<Category | null>(null)
const mergingUsage = computed(() => usage(merging.value ? [merging.value] : []))
const mergeInto = ref<number | null>(null)
function openMerge(c: Category) {
  merging.value = c
  mergeInto.value = null
}
const mergeTarget = computed(() => (mergeInto.value ? categories.value.find((c) => c.id === mergeInto.value) : undefined))
/** Merging into a different kind of category changes how its transactions count. */
const mergeNote = computed(() => {
  const from = merging.value
  const to = mergeTarget.value
  if (!from || !to) return null
  if (to.excludeFromTotals && !from.excludeFromTotals) return `${to.name} is left out of totals, so these transactions will stop counting as spending or income.`
  if (to.isIncome !== from.isIncome) return `${to.name} is ${to.isIncome ? 'an income' : 'a spending'} category, so these transactions will count as ${to.isIncome ? 'income' : 'spending'}.`
  return null
})
async function confirmMerge() {
  if (!merging.value || !mergeInto.value) return
  try {
    const r = await m.merge.mutateAsync({ id: merging.value.id, into: mergeInto.value })
    toast.success(`Merged ${merging.value.name} into ${r.into.name}`, {
      description: `${r.transactions} transaction${r.transactions === 1 ? '' : 's'}${r.recurring ? ` and ${r.recurring} recurring payment${r.recurring === 1 ? '' : 's'}` : ''} moved.`,
    })
    merging.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
async function run(p: Promise<unknown>) {
  await p.catch((err) => toast.error(errorMessage(err)))
}

// Labels: add, edit, and put on (or take off) the selected categories.
const labelOpen = ref(false)
const labelEditing = ref<Label | null>(null)
/** A label made from the selection bar goes straight onto the selection. */
const labelForSelection = ref(false)
function openLabel(l: Label | null, forSelection = false) {
  labelEditing.value = l
  labelForSelection.value = forSelection
  labelOpen.value = true
}
/** Checkboxes show only while you're selecting categories to label. */
const selecting = ref(false)
const selected = ref(new Set<number>())
function stopSelecting() {
  selecting.value = false
  selected.value = new Set()
}
function toggle(ids: number[], on: boolean) {
  const next = new Set(selected.value)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  selected.value = next
}
const groupState = (items: Category[]) => {
  const n = items.filter((c) => selected.value.has(c.id)).length
  return n === 0 ? false : n === items.length ? true : 'indeterminate'
}
/** Labels some of the selected categories have, which can be taken off. */
const selectedLabels = computed(() => {
  const ids = new Set(categories.value.filter((c) => selected.value.has(c.id)).flatMap((c) => c.labelIds))
  return labels.value.filter((l) => ids.has(l.id))
})
async function applyToSelection(label: Label, on: boolean) {
  const ids = [...selected.value]
  try {
    await lm.apply.mutateAsync({ id: label.id, add: on ? ids : [], remove: on ? [] : ids })
    toast.success(`${on ? 'Added' : 'Removed'} ${label.name} ${on ? 'to' : 'from'} ${ids.length} categor${ids.length === 1 ? 'y' : 'ies'}`)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
function labelSaved(l: Label) {
  if (labelForSelection.value && selected.value.size) applyToSelection(l, true)
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <!-- One toolbar: adding things, or (while selecting) labelling the selected categories. -->
    <div
      class="flex flex-wrap items-center gap-2"
      :class="selecting && 'sticky top-16 z-10 rounded-lg border bg-background p-2 shadow-sm'"
    >
      <template v-if="!selecting">
        <Button @click="add(null)"><Plus />Add category</Button>
        <Button variant="outline" @click="openGroup(null)"><Plus />Add group</Button>
        <Button variant="outline" @click="openLabel(null)"><Tag />New label</Button>
        <Button variant="outline" class="ml-auto" :disabled="!categories.length" @click="selecting = true"><ListChecks />Select</Button>
      </template>
      <template v-else>
        <span class="px-2 text-sm font-medium">{{ selected.size ? `${selected.size} selected` : 'Select categories' }}</span>
        <DropdownMenu>
          <DropdownMenuTrigger as-child><Button size="sm" variant="outline" :disabled="!selected.size"><Tag />Add label</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-48">
            <DropdownMenuItem v-for="l in labels" :key="l.id" @select="applyToSelection(l, true)">
              <span class="size-2 rounded-full" :style="{ background: l.color }" />{{ l.name }}
            </DropdownMenuItem>
            <DropdownMenuSeparator v-if="labels.length" />
            <DropdownMenuItem @select="openLabel(null, true)"><Plus />New label…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu v-if="selectedLabels.length">
          <DropdownMenuTrigger as-child><Button size="sm" variant="outline"><Minus />Remove label</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-48">
            <DropdownMenuItem v-for="l in selectedLabels" :key="l.id" @select="applyToSelection(l, false)">
              <span class="size-2 rounded-full" :style="{ background: l.color }" />{{ l.name }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="ghost" class="ml-auto" @click="stopSelecting">Done</Button>
      </template>
    </div>

    <!-- Your labels: choose one to rename, recolour or delete it. -->
    <div v-if="labels.length" class="flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium text-muted-foreground">Labels</span>
      <button
        v-for="l in labels"
        :key="l.id"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm transition-colors hover:bg-muted"
        :aria-label="`Edit the label ${l.name}`"
        @click="openLabel(l)"
      >
        <span class="size-2 rounded-full" :style="{ background: l.color }" />{{ l.name }}
        <span class="text-xs text-muted-foreground tabular">{{ l.categoryCount }}</span>
      </button>
    </div>

    <VueDraggable
      v-model="sections"
      handle=".group-handle"
      draggable=".group-card"
      :animation="150"
      :disabled="selecting"
      ghost-class="opacity-40"
      class="grid grid-cols-1 gap-4"
      @end="saveGroupOrder"
    >
    <Card v-for="(s, si) in sections" :key="s.key" :class="cn('gap-0 py-0', s.group && 'group-card')">
      <CardHeader class="gap-y-0 px-4 py-3 md:px-6">
        <!-- One line: handle, colour, name and how many categories it has. -->
        <CardTitle class="flex min-h-8 min-w-0 items-center gap-3 text-sm">
          <button
            v-if="s.group && !selecting"
            type="button"
            class="group-handle -ml-1.5 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
            :aria-label="`Move ${s.group.name}: drag, or press ↑ or ↓`"
            @keydown.up.prevent="nudgeGroup(si, -1)"
            @keydown.down.prevent="nudgeGroup(si, 1)"
          >
            <GripVertical class="size-4" />
          </button>
          <Checkbox
            v-if="selecting && lists[s.key]?.length"
            :model-value="groupState(lists[s.key]!)"
            :aria-label="`Select every category in ${s.group?.name ?? 'no group'}`"
            @update:model-value="(v) => toggle(lists[s.key]!.map((c) => c.id), v === true)"
          />
          <button
            v-if="s.group"
            type="button"
            class="size-3.5 shrink-0 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            :style="{ background: s.group.color }"
            :aria-label="`Change the colour of ${s.group.name}`"
            @click="openGroup(s.group)"
          />
          <span v-else class="size-3.5 shrink-0 rounded-full" :style="{ background: UNGROUPED_COLOR }" />
          <span class="truncate">{{ s.group?.name ?? 'No group' }}</span>
          <span class="shrink-0 font-normal text-muted-foreground tabular" :title="`${lists[s.key]?.length ?? 0} categories`">{{ lists[s.key]?.length ?? 0 }}</span>
        </CardTitle>
        <CardAction class="flex gap-1">
          <Button variant="ghost" size="icon-sm" :aria-label="`Add category to ${s.group?.name ?? 'no group'}`" @click="add(s.group?.id ?? null)"><Plus /></Button>
          <DropdownMenu v-if="s.group">
            <DropdownMenuTrigger as-child><Button variant="ghost" size="icon-sm" aria-label="Group actions"><Ellipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @select="openGroup(s.group)"><Pencil />Edit group</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" @select="deletingGroup = s.group"><Trash2 />Delete group</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <!-- Categories: reorder by their handles, or drag one into another group. An empty group still takes a drop. -->
      <VueDraggable
        v-model="lists[s.key]!"
        tag="ul"
        group="categories"
        handle=".category-handle"
        :animation="150"
        :disabled="selecting"
        ghost-class="opacity-40"
        :class="cn('relative divide-y border-t', !lists[s.key]?.length && 'min-h-11')"
        @end="saveCategoryOrder"
      >
        <li v-for="(c, ci) in lists[s.key]" :key="c.id" class="flex items-center gap-3 bg-card px-4 py-2.5 md:px-6" :class="c.archived && 'opacity-50'">
          <button
            v-if="!selecting"
            type="button"
            class="category-handle -ml-1.5 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
            :aria-label="`Move ${c.name}: drag, or press ↑ or ↓`"
            @keydown.up.prevent="nudgeCategory(s.key, ci, -1)"
            @keydown.down.prevent="nudgeCategory(s.key, ci, 1)"
          >
            <GripVertical class="size-4" />
          </button>
          <Checkbox v-if="selecting" :model-value="selected.has(c.id)" :aria-label="`Select ${c.name}`" @update:model-value="(v) => toggle([c.id], v === true)" />
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <!-- While selecting, the name selects too. -->
            <button
              type="button"
              class="min-w-0 truncate text-left text-sm hover:underline"
              @click="selecting ? toggle([c.id], !selected.has(c.id)) : edit(c)"
            >
              {{ c.name }}
            </button>
            <span v-for="l in labelsOf(c)" :key="l.id" class="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] text-muted-foreground">
              <span class="size-1.5 rounded-full" :style="{ background: l.color }" />{{ l.name }}
            </span>
          </div>
          <Badge v-if="c.isIncome" variant="secondary">Income</Badge>
          <Badge v-if="c.excludeFromTotals" variant="outline">Not in totals</Badge>
          <Badge v-if="!shared && c.archived" variant="outline">Archived</Badge>
          <DropdownMenu>
            <DropdownMenuTrigger as-child><Button variant="ghost" size="icon-xs" :aria-label="`Actions for ${c.name}`"><Ellipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @select="edit(c)"><Pencil />Edit</DropdownMenuItem>
              <DropdownMenuItem @select="openMerge(c)"><Merge />Merge into…</DropdownMenuItem>
              <!-- Ledgers that share turn categories off for themselves instead. -->
              <DropdownMenuItem v-if="!shared" @select="run(m.update.mutateAsync({ id: c.id, archived: !c.archived }))">
                <component :is="c.archived ? ArchiveRestore : Archive" />{{ c.archived ? 'Restore' : 'Archive' }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="deleting = c"><Trash2 />Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </VueDraggable>
      <p v-if="!lists[s.key]?.length" class="pointer-events-none -mt-11 px-4 py-3 text-sm text-muted-foreground md:px-6">No categories in this group.</p>
    </Card>
    </VueDraggable>

    <CategoryDialog v-model:open="dialogOpen" :category="editing" :group-id="forGroup" :scope="scope" />
    <LabelDialog v-model:open="labelOpen" :label="labelEditing" :scope="scope" @saved="labelSaved" />

    <Dialog v-model:open="groupDialog">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ renaming ? 'Edit group' : 'Add group' }}</DialogTitle>
          <DialogDescription>Groups roll up categories in reports, like “Food” for groceries and dining out. Its categories show in its colour.</DialogDescription>
        </DialogHeader>
        <form class="grid gap-4" @submit.prevent="saveGroup">
          <Input v-model="groupName" placeholder="Group name" aria-label="Group name" />
          <ColorPicker v-model="groupColor" />
          <DialogFooter>
            <Button type="button" variant="outline" @click="groupDialog = false">Cancel</Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleting" @update:open="(v) => !v && (deleting = null)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {{ deleting?.name }}?</DialogTitle>
          <DialogDescription v-if="deletingUsage.n">
            {{ deletingUsage.text }} {{ deletingUsage.n === 1 ? 'uses' : 'use' }} it, and {{ deletingUsage.n === 1 ? 'it becomes' : 'they become' }} uncategorized.
          </DialogDescription>
          <DialogDescription v-else>No transactions{{ shared ? ' in your ledgers' : '' }} use it.</DialogDescription>
          <DialogDescription v-if="deletingReports">{{ deletingReports }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleting = null">Cancel</Button>
          <Button variant="destructive" @click="confirmDelete">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deletingGroup" @update:open="(v) => !v && (deletingGroup = null)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {{ deletingGroup?.name }}?</DialogTitle>
          <DialogDescription v-if="groupCount">
            Its {{ groupCount === 1 ? 'category is' : `${groupCount} categories are` }} deleted too.
            <template v-if="groupUsage.n">{{ groupUsage.text }} use {{ groupCount === 1 ? 'it' : 'them' }}, and become uncategorized.</template>
            <template v-else>No transactions{{ shared ? ' in your ledgers' : '' }} use {{ groupCount === 1 ? 'it' : 'them' }}.</template>
          </DialogDescription>
          <DialogDescription v-else>It has no categories.</DialogDescription>
          <DialogDescription v-if="deletingGroupReports">{{ deletingGroupReports }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deletingGroup = null">Cancel</Button>
          <Button variant="destructive" :disabled="m.removeGroup.isPending.value" @click="confirmDeleteGroup">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!merging" @update:open="(v) => !v && (merging = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge {{ merging?.name }} into…</DialogTitle>
          <DialogDescription>
            {{ mergingUsage.n ? `${mergingUsage.text} ${mergingUsage.n === 1 ? 'uses' : 'use'} it.` : `No transactions${shared ? ' in your ledgers' : ''} use it.` }}
            Its transactions and recurring payments{{ everywhere }} move to the category you choose, and {{ merging?.name }} is deleted. That category
            keeps its own name, group and labels.
          </DialogDescription>
        </DialogHeader>
        <form class="grid gap-3" @submit.prevent="confirmMerge">
          <CategoryPicker v-model="mergeInto" :scope="scope" :allow-none="false" :exclude="merging ? [merging.id] : []" placeholder="Choose a category" class="w-full" />
          <p v-if="mergeNote" class="rounded-md bg-amber-500/10 px-3 py-2 text-sm">{{ mergeNote }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" @click="merging = null">Cancel</Button>
            <Button type="submit" :disabled="!mergeInto || m.merge.isPending.value">Merge</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
