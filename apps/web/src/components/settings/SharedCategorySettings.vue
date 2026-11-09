<script setup lang="ts">
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import CategorySettings from './CategorySettings.vue'

/** App settings → Categories: the shared list that ledgers use (each turns categories on or off). */
</script>

<template>
  <div class="grid grid-cols-1 gap-4">
    <Card class="gap-2">
      <CardHeader>
        <CardTitle>Shared categories</CardTitle>
        <CardDescription>
          Ledgers that share use these categories, and each turns off the ones it doesn’t need (Ledger settings → Categories). A ledger can
          also keep its own list instead.
        </CardDescription>
      </CardHeader>
    </Card>
    <CategorySettings scope="shared" />
  </div>
</template>
