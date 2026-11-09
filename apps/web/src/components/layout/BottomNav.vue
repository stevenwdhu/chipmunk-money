<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { ledgerLink, primaryNav } from '@/lib/nav'

const route = useRoute()
const isActive = (name: string) => route.name === name || route.meta.parent === name
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-background/95 pb-safe backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden"
    aria-label="Main"
  >
    <RouterLink
      v-for="item in primaryNav"
      :key="item.name"
      :to="ledgerLink(item.name)"
      class="flex flex-col items-center gap-1 pt-2 pb-1.5 text-[11px] leading-none"
      :class="isActive(item.name) ? 'font-medium text-foreground' : 'text-muted-foreground'"
      :aria-current="isActive(item.name) ? 'page' : undefined"
    >
      <component :is="item.icon" class="size-5" :stroke-width="isActive(item.name) ? 2.25 : 1.75" />
      {{ item.label }}
    </RouterLink>
  </nav>
</template>
