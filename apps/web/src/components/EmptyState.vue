<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{ icon?: Component; title: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
    <div v-if="icon" class="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
      <component :is="icon" class="size-5" />
    </div>
    <p class="font-medium">{{ title }}</p>
    <p v-if="description" class="max-w-sm text-sm text-muted-foreground">{{ description }}</p>
    <div class="mt-2 flex flex-wrap justify-center gap-2"><slot /></div>
  </div>
</template>
