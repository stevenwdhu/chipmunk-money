import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { COLOR_PALETTE, CUSTOM_COLORS_MAX, isHexColor } from '@chipmunk/shared'
import { useSettings, useUpdateSettings } from '@/composables/queries'
import { errorMessage } from '@/lib/api'

/**
 * Colours you've used that aren't in the palette, newest first. They're an app setting, so every
 * colour picker on every device offers them again.
 */
export function useCustomColors() {
  const settings = useSettings()
  const update = useUpdateSettings()
  const colors = computed(() => settings.data.value?.customColors ?? [])
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  function save(next: string[]) {
    update.mutateAsync({ customColors: next.length ? next : null }).catch((err) => toast.error(`Couldn’t save your colours. ${errorMessage(err)}`))
  }
  /** Call when a colour is saved (not on every drag), so only colours you kept are remembered. */
  function remember(color: string) {
    if (!isHexColor(color) || COLOR_PALETTE.some((p) => same(p, color))) return
    const next = [color.toLowerCase(), ...colors.value.filter((c) => !same(c, color))].slice(0, CUSTOM_COLORS_MAX)
    if (next.join() !== colors.value.join()) save(next)
  }
  function clear() {
    save([])
  }
  return { colors, remember, clear }
}
