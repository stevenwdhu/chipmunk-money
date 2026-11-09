import { useMediaQuery } from '@vueuse/core'

export function useIsDesktop() {
  return useMediaQuery('(min-width: 768px)')
}
