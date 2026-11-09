<script setup lang="ts">
import { useCommand } from '@/components/ui/command'

/** Hands the surrounding Command's search text to its slot (e.g. for an "Add …" option). */
const { filterState } = useCommand()
</script>

<template>
  <slot :search="filterState.search" />
</template>
