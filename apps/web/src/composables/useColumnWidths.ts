import { toValue, type MaybeRefOrGetter } from 'vue'
import { unrefElement, type MaybeElementRef } from '@vueuse/core'

type Widths<T extends string> = Partial<Record<T, number>>

/**
 * Widths of table columns (or panels, like the sidebar) you change by dragging the grip on the
 * right edge (double-click resets it; ←/→ on the focused grip nudges it). Widths follow `saved` (e.g. from the app settings) and
 * each change goes to `save` with every width you've set (null once none are left).
 *
 * While you drag, the width lives in a CSS variable on `table`, so the rows don't re-render.
 */
export function useColumnWidths<T extends string>(
  defaults: Record<T, number>,
  opts: {
    saved: MaybeRefOrGetter<Widths<T> | undefined>
    save: (next: Widths<T> | null) => Promise<unknown>
    table: MaybeElementRef
    min: number
    max: number
  },
) {
  const saved = (): Widths<T> => toValue(opts.saved) ?? {}
  const width = (col: T) => saved()[col] ?? defaults[col]
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, opts.min), opts.max))
  const tableEl = () => unrefElement(opts.table) as HTMLElement | null | undefined
  const preview = (col: T, w: number | null) =>
    w === null ? tableEl()?.style.removeProperty(`--w-${col}`) : tableEl()?.style.setProperty(`--w-${col}`, `${w}px`)

  function commit(col: T, w: number | null) {
    const next: Widths<T> = { ...saved() }
    if (w === null || w === defaults[col]) delete next[col]
    else next[col] = w
    // Keep showing the new width until the saved one arrives (or the old one comes back on failure).
    opts.save(Object.keys(next).length ? next : null).finally(() => preview(col, null))
  }

  /** The header's width; the column that fills the rest of the row has none (its width is its minimum). */
  const widthStyle = (col: T, fills: boolean) => (fills ? { minWidth: `${width(col)}px` } : { width: `var(--w-${col}, ${width(col)}px)` })

  /** The grip being dragged (kept here, not per render, so a re-render mid-drag can't lose it). */
  let start: { col: T; x: number; width: number } | null = null
  const handleProps = (col: T, label: string) => {
    return {
      role: 'separator',
      'aria-orientation': 'vertical' as const,
      'aria-label': `Resize ${label}`,
      'aria-valuenow': width(col),
      'aria-valuemin': opts.min,
      'aria-valuemax': opts.max,
      tabindex: 0,
      title: 'Drag to resize (double-click to reset)',
      onPointerdown: (e: PointerEvent) => {
        if (e.button !== 0) return
        // Resizing, not moving the column.
        e.stopPropagation()
        e.preventDefault()
        const th = (e.currentTarget as HTMLElement).closest('th')
        start = { col, x: e.clientX, width: th?.getBoundingClientRect().width ?? width(col) }
        try {
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        } catch {
          // The resize still follows the pointer over the grip.
        }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      },
      onPointermove: (e: PointerEvent) => {
        if (start?.col === col) preview(col, clamp(start.width + e.clientX - start.x))
      },
      onPointerup: (e: PointerEvent) => {
        if (start?.col !== col) return
        const w = clamp(start.width + e.clientX - start.x)
        const moved = Math.abs(e.clientX - start.x) > 1
        start = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (moved) commit(col, w)
        else preview(col, null)
      },
      onClick: (e: MouseEvent) => e.stopPropagation(),
      onDblclick: (e: MouseEvent) => {
        e.stopPropagation()
        preview(col, null)
        commit(col, null)
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
        e.preventDefault()
        e.stopPropagation()
        const w = clamp(width(col) + (e.key === 'ArrowLeft' ? -16 : 16))
        preview(col, w)
        commit(col, w)
      },
    }
  }

  return { width, widthStyle, handleProps }
}
