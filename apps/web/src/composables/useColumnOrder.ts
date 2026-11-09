import { ref, toValue, watch, type CSSProperties, type MaybeRefOrGetter, type Ref } from 'vue'
import { unrefElement, type MaybeElementRef } from '@vueuse/core'

type Side = 'before' | 'after'
type Box = { left: number; width: number }

/** How long columns take to slide aside, and the dropped column to settle. */
const SLIDE_MS = 180

/**
 * A table's column order that you change by dragging its headers (or Alt + ←/→ on a focused
 * header). While you drag, the whole column lifts and follows the pointer, and the others slide
 * aside to show where it will land.
 *
 * The order follows `saved` (e.g. from the app settings) and every change goes to `save` (null
 * means back to the default); a failed save puts the saved order back. Put `headerProps(col)` and
 * `cellStyle(col)` on each header cell (which needs `data-col`), `cellStyle(col)` on each body cell,
 * and `table` (a positioned element) around them all. Moving cells are driven by CSS variables on
 * `table`, so dragging never re-renders the rows.
 */
export function useColumnOrder<T extends string>(
  defaults: readonly T[],
  opts: {
    saved: MaybeRefOrGetter<readonly T[] | undefined>
    save: (next: T[] | null) => Promise<unknown>
    table: MaybeElementRef
    /** The columns on screen, when some are hidden; Alt + ←/→ moves past these only. */
    visible?: MaybeRefOrGetter<readonly T[]>
  },
) {
  const order = ref([...defaults]) as Ref<T[]>
  watch(
    () => toValue(opts.saved),
    (saved) => {
      if (saved) order.value = [...saved]
    },
    { immediate: true },
  )
  const sameAsDefault = (cols: readonly T[]) => cols.every((c, i) => c === defaults[i])

  function save(next: T[]) {
    order.value = next
    opts.save(sameAsDefault(next) ? null : next).catch(() => {
      order.value = [...(toValue(opts.saved) ?? defaults)]
    })
  }
  function moveTo(col: T, target: T, side: Side) {
    if (col === target) return
    const next = order.value.filter((c) => c !== col)
    next.splice(next.indexOf(target) + (side === 'after' ? 1 : 0), 0, col)
    save(next)
  }
  function step(col: T, dir: -1 | 1) {
    const shown = toValue(opts.visible) ?? order.value
    const neighbour = shown[shown.indexOf(col) + dir]
    if (neighbour) moveTo(col, neighbour, dir < 0 ? 'before' : 'after')
  }

  // Every cell of a column reads its offset and look from the table's CSS variables.
  const styles = Object.fromEntries(
    defaults.map((col) => [
      col,
      {
        position: 'relative',
        // `translate` (not `transform`) so cells at rest don't each form a layer that covers the
        // neighbouring header's resize grip.
        translate: `var(--shift-${col}, none)`,
        transition: `var(--slide-${col}, translate ${SLIDE_MS}ms ease)`,
        // The table's row lines sit under the cells, so a lifted column draws its own.
        boxShadow: `var(--line-${col}, none)`,
        zIndex: `var(--z-${col}, auto)`,
        backgroundColor: `var(--bg-${col}, transparent)`,
      } satisfies CSSProperties,
    ]),
  ) as Record<T, CSSProperties>
  const cellStyle = (col: T) => styles[col]

  const tableEl = () => unrefElement(opts.table) as HTMLElement | null | undefined
  const setVar = (name: string, value: string) => tableEl()?.style.setProperty(name, value)
  const clearVars = (names: readonly string[]) => {
    for (const col of defaults) for (const v of names) tableEl()?.style.removeProperty(`--${v}-${col}`)
  }

  /**
   * A card behind the dragged column that carries its shadow, so the column reads as one piece
   * lifted above the table (shadows on each cell would stripe between the rows).
   */
  let lift: HTMLElement | null = null
  function showLift(col: T, th: Box) {
    const host = tableEl()
    const table = host?.querySelector('table')
    if (!host || !table) return
    const hostBox = host.getBoundingClientRect()
    const tableBox = table.getBoundingClientRect()
    const pad = 3
    lift = document.createElement('div')
    lift.setAttribute('aria-hidden', 'true')
    Object.assign(lift.style, {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '19',
      left: `${th.left - hostBox.left - pad}px`,
      top: `${tableBox.top - hostBox.top}px`,
      width: `${th.width + pad * 2}px`,
      height: `${tableBox.height}px`,
      borderRadius: '8px',
      background: 'var(--card)',
      outline: '1px solid var(--border)',
      boxShadow: '0 18px 40px -12px rgb(0 0 0 / 0.35), 0 6px 14px -6px rgb(0 0 0 / 0.2)',
      translate: `var(--shift-${col}, none)`,
      transition: `var(--slide-${col}, translate ${SLIDE_MS}ms ease)`,
    } satisfies Partial<CSSStyleDeclaration>)
    host.append(lift)
  }

  /** The column being dragged (for the cursor). */
  const dragging = ref<T | null>(null) as Ref<T | null>
  let drag: {
    col: T
    pointerId: number
    startX: number
    started: boolean
    boxes: Map<T, Box>
    /** The other visible columns, in their current order. */
    others: T[]
    from: number
    to: number
    /** Where the dragged column's slot is, relative to where it started. */
    slot: number
    minDx: number
    maxDx: number
  } | null = null
  /** Set while a dropped column settles, so a new drag can't start mid-animation. */
  let settling = false

  function begin(d: NonNullable<typeof drag>) {
    // Hidden columns (e.g. ones only shown on wide screens) have no width and stay put.
    for (const th of tableEl()?.querySelectorAll<HTMLElement>('th[data-col]') ?? []) {
      const r = th.getBoundingClientRect()
      if (r.width > 0) d.boxes.set(th.dataset.col as T, { left: r.left, width: r.width })
    }
    const visible = order.value.filter((c) => d.boxes.has(c))
    const me = d.boxes.get(d.col)
    if (!me || visible.length < 2) return false
    const first = d.boxes.get(visible[0]!)!
    const last = d.boxes.get(visible[visible.length - 1]!)!
    d.others = visible.filter((c) => c !== d.col)
    d.from = d.to = visible.indexOf(d.col)
    d.minDx = first.left - me.left
    d.maxDx = last.left + last.width - (me.left + me.width)
    d.started = true

    setVar(`--slide-${d.col}`, 'none')
    setVar(`--z-${d.col}`, '20')
    setVar(`--bg-${d.col}`, 'var(--card)')
    setVar(`--line-${d.col}`, 'inset 0 -1px 0 var(--border)')
    showLift(d.col, me)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    dragging.value = d.col
    return true
  }

  /** Slides the other columns so there's a gap where the dragged one would land. */
  function layout(d: NonNullable<typeof drag>) {
    const next = [...d.others]
    next.splice(d.to, 0, d.col)
    let x = d.boxes.get(next[0]!)!.left
    for (const c of next) {
      const box = d.boxes.get(c)!
      if (c === d.col) d.slot = x - box.left
      else setVar(`--shift-${c}`, `${x - box.left}px`)
      x += box.width
    }
  }

  function move(d: NonNullable<typeof drag>, clientX: number) {
    const dx = Math.min(Math.max(clientX - d.startX, d.minDx), d.maxDx)
    setVar(`--shift-${d.col}`, `${dx}px`)
    const me = d.boxes.get(d.col)!
    // A column is passed once the dragged one's leading edge crosses its middle, so even a wide
    // column can reach either end.
    const left = me.left + dx
    const right = left + me.width
    const to = d.others.filter((c) => {
      const b = d.boxes.get(c)!
      const middle = b.left + b.width / 2
      return b.left < me.left ? middle <= left : middle < right
    }).length
    if (to !== d.to) {
      d.to = to
      layout(d)
    }
  }

  /** Eases the dragged column into its slot, then puts the cells in their new order for real. */
  function drop(d: NonNullable<typeof drag>, keep: boolean) {
    settling = true
    if (!keep) {
      d.to = d.from
      layout(d)
    }
    setVar(`--slide-${d.col}`, `translate ${SLIDE_MS}ms ease`)
    setVar(`--shift-${d.col}`, `${d.slot}px`)
    setTimeout(() => {
      // Snap without animating: the new order takes the place of the offsets.
      for (const c of defaults) setVar(`--slide-${c}`, 'none')
      clearVars(['shift', 'z', 'bg', 'line'])
      lift?.remove()
      lift = null
      if (keep && d.to !== d.from) {
        const target = d.others[Math.min(d.to, d.others.length - 1)]!
        moveTo(d.col, target, d.to < d.others.length ? 'before' : 'after')
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      dragging.value = null
      // Let the reordered cells render before transitions come back.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearVars(['slide'])
          settling = false
        }),
      )
    }, SLIDE_MS)
  }

  const headerProps = (col: T) => ({
    tabindex: 0,
    onPointerdown: (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === 'touch' || drag || settling) return
      e.preventDefault() // No text selection while dragging.
      try {
        // Keeps the drag going when the pointer leaves the header.
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        // A pointer the browser no longer tracks: the drag still works over the header row.
      }
      drag = { col, pointerId: e.pointerId, startX: e.clientX, started: false, boxes: new Map(), others: [], from: 0, to: 0, slot: 0, minDx: 0, maxDx: 0 }
    },
    onPointermove: (e: PointerEvent) => {
      if (!drag || drag.pointerId !== e.pointerId) return
      // A few pixels of movement before it counts as a drag rather than a click.
      if (!drag.started && (Math.abs(e.clientX - drag.startX) < 4 || !begin(drag))) return
      move(drag, e.clientX)
    },
    onPointerup: (e: PointerEvent) => {
      if (!drag || drag.pointerId !== e.pointerId) return
      const d = drag
      drag = null
      if (d.started) drop(d, true)
    },
    onPointercancel: (e: PointerEvent) => {
      if (!drag || drag.pointerId !== e.pointerId) return
      const d = drag
      drag = null
      if (d.started) drop(d, false)
    },
    onKeydown: (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      e.preventDefault()
      step(col, e.key === 'ArrowLeft' ? -1 : 1)
    },
  })

  return { order, dragging, headerProps, cellStyle }
}
