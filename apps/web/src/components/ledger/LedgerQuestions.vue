<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { Ledger, LedgerAction, LedgerAnswers, LedgerQuestion } from '@chipmunk/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { previewLedgerAction, useLedgerQuestions } from '@/composables/queries'
import { ApiError, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * What a ledger asks before it's deleted, erased or archived, inside that action's dialog: each
 * question with its choices and what they do, what happens without a choice, and why it can't be
 * done at all. Once everything is answered it lists what the action will do, from the server's dry
 * run with those answers. Nothing shows for a ledger with nothing to ask or say.
 *
 * The dialog sends `answers` with the action, once `ready`. When the server then says the questions
 * changed (`refused`), they're asked again.
 */
const props = defineProps<{
  ledger: Pick<Ledger, 'id' | 'slug' | 'name'> | null
  action: LedgerAction
  /** The dialog is open: the questions are asked again each time. */
  active: boolean
}>()
const answers = defineModel<LedgerAnswers>('answers', { default: () => ({}) })
/** The action can be confirmed: nothing stops it, every question has an answer, and what it will do is listed. */
const ready = defineModel<boolean>('ready', { default: false })

const asked = useLedgerQuestions(
  () => props.ledger?.slug ?? null,
  () => props.action,
  () => props.active,
)
/** Asked and answered by the server, for this opening of the dialog. */
const data = computed(() => (props.active && !asked.isFetching.value ? asked.data.value : undefined))
/** The questions changed after the dialog asked them. */
const changed = ref(false)

watch(
  () => props.active,
  (v) => {
    if (!v) return
    answers.value = {}
    changed.value = false
  },
  { immediate: true },
)
// An answer stays while its choice is still offered. A question with one choice has it picked.
watch(data, (d) => {
  if (!d) return
  const next: LedgerAnswers = {}
  for (const q of d.questions) {
    const had = answers.value[q.id]
    if (had !== undefined && q.options.some((o) => o.value === had)) next[q.id] = had
    else if (q.options.length === 1) next[q.id] = q.options[0]!.value
  }
  answers.value = next
})

const something = computed(() => !!data.value && data.value.questions.length + data.value.notices.length + data.value.blockers.length > 0)
const blocked = computed(() => !!data.value?.blockers.length)
const answered = computed(() => !!data.value && data.value.questions.every((q) => answers.value[q.id] !== undefined))

/** What the action will do with these answers, in every ledger it touches. */
const preview = useQuery({
  queryKey: computed(() => ['l', props.ledger?.slug, 'questions', props.action, 'changes', answers.value]),
  queryFn: () => previewLedgerAction(props.ledger!, props.action, answers.value),
  enabled: computed(() => !!props.ledger && something.value && !blocked.value && answered.value),
  staleTime: 0,
  gcTime: 0,
  retry: false,
})
const changes = computed(() => (something.value && !blocked.value && answered.value && !preview.isFetching.value ? preview.data.value?.changes : undefined))

/** The server's answer when the questions aren't the ones that were answered: what the ledgers hold changed meanwhile. */
const isStale = (err: unknown) => err instanceof ApiError && err.status === 409 && err.message.startsWith('Answer the questions first')
function askAgain() {
  changed.value = true
  void asked.refetch()
}
watch(
  () => preview.error.value,
  (err) => isStale(err) && askAgain(),
)
/** For the dialog, when the action fails: true when it was refused because the questions changed, and they're asked again here. */
function refused(err: unknown): boolean {
  if (!isStale(err)) return false
  askAgain()
  return true
}
defineExpose({ refused })

watch(
  () => !!data.value && !blocked.value && answered.value && (!something.value || !!changes.value),
  (v) => (ready.value = v),
  { immediate: true },
)

const pick = (q: LedgerQuestion, value: string) => (answers.value = { ...answers.value, [q.id]: value })
</script>

<template>
  <template v-if="active">
    <p v-if="asked.error.value && !asked.isFetching.value" class="text-sm text-destructive">{{ errorMessage(asked.error.value) }}</p>
    <Skeleton v-else-if="!data" class="h-9" />
    <div v-else-if="something" class="grid min-w-0 gap-4">
      <p v-if="changed" class="text-sm text-amber-700 dark:text-amber-400">Something changed since you opened this. Check the answers again.</p>

      <ul v-if="blocked" class="grid gap-1.5 rounded-lg border border-destructive/40 px-3 py-2 text-sm">
        <li v-for="(reason, i) in data.blockers" :key="i">{{ reason }}</li>
      </ul>

      <template v-else>
        <div v-for="q in data.questions" :key="q.id" class="grid gap-1.5">
          <p class="text-sm font-medium">{{ q.text }}</p>
          <div class="grid gap-2" role="radiogroup" :aria-label="q.text">
            <button
              v-for="opt in q.options"
              :key="opt.value"
              type="button"
              role="radio"
              :aria-checked="answers[q.id] === opt.value"
              :class="cn('rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors', answers[q.id] === opt.value ? 'border-primary bg-muted' : 'hover:bg-muted/50')"
              @click="pick(q, opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
          <p v-if="q.note" class="text-xs text-muted-foreground">{{ q.note }}</p>
        </div>

        <ul v-if="data.notices.length" class="grid gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <li v-for="(notice, i) in data.notices" :key="i">{{ notice }}</li>
        </ul>

        <template v-if="answered">
          <p v-if="preview.error.value && !preview.isFetching.value && !isStale(preview.error.value)" class="text-sm text-destructive">
            {{ errorMessage(preview.error.value) }}
          </p>
          <div v-else-if="changes?.length" class="grid gap-1.5">
            <p class="text-sm font-medium">What this does</p>
            <ul class="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
              <li v-for="(change, i) in changes" :key="i">{{ change }}</li>
            </ul>
          </div>
          <Skeleton v-else-if="!changes" class="h-9" />
        </template>
      </template>
    </div>
  </template>
</template>
