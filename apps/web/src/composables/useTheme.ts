import { useColorMode } from '@vueuse/core'

/** light / dark / auto, persisted in localStorage (read early in index.html to avoid a flash). */
export function useTheme() {
  return useColorMode({ storageKey: 'st-theme', emitAuto: true, initialValue: 'auto' })
}
