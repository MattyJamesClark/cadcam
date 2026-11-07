import type { ModuleContext } from './types'
import { icons } from './icons'
import { EVERYTHING, FILTER_KEYS, selectFilter, type SelectFilter } from './picking'
import { selection } from './selection'
import { el } from './toolpanel'
import { commandRunning, onCommandChange } from './cmdbar'

/**
 * Small icon-only toolbar along the bottom of the viewport (Multi-select,
 * Previous selection, Clear selection and what is selected), plus the
 * selection-filter palette down the left of the view.
 * Modules can add their own buttons later with addBottomButton().
 */

const TYPES: Record<keyof SelectFilter, { label: string; icon: string; key: string }> = {
  vertex: { label: 'Points', icon: icons.pickPoint, key: '1' },
  edge: { label: 'Edges', icon: icons.pickEdge, key: '2' },
  face: { label: 'Faces', icon: icons.pickFace, key: '3' },
  surface: { label: 'Surfaces', icon: icons.pickSurface, key: '4' },
  body: { label: 'Bodies', icon: icons.pickBody, key: '5' }
}

let bar: HTMLElement | null = null
const LETTER_OF: Record<string, string> = { all: 'C', body: 'E', vertex: 'P', face: 'F', edge: 'D', surface: 'S' }

export function addBottomButton(icon: string, title: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = el('button', 'vb-btn')
  b.innerHTML = icon
  b.title = title
  b.addEventListener('click', () => onClick(b))
  bar?.querySelector('.vb-extra')?.append(b)
  return b
}

export function startBottomBar(ctx: ModuleContext): void {
  if (bar) return
  const vp = ctx.viewport
  bar = el('div', 'vp-bar')
  bar.addEventListener('pointerdown', (e) => e.stopPropagation())

  // Selection filter: a palette of big icons down the left of
  // the view. A click picks just that type; Ctrl+click adds / removes one.
  const palette = el('div', 'vp-filterbar')
  palette.addEventListener('pointerdown', (e) => e.stopPropagation())
  const cells = new Map<string, HTMLButtonElement>()
  const cell = (id: string, icon: string, label: string, key: string, onClick: (e: MouseEvent) => void): void => {
    const c = el('button', 'vf-btn')
    c.innerHTML = icon
    c.title = `${label} (${key}${LETTER_OF[id] ? ` or ${LETTER_OF[id]} during a command` : ''})${id === 'all' ? '' : ' · Ctrl+click to combine'}`
    c.addEventListener('click', onClick)
    cells.set(id, c)
    palette.append(c)
  }
  const only = (k: keyof SelectFilter): SelectFilter => ({ vertex: false, edge: false, face: false, surface: false, body: false, [k]: true })
  cell('all', icons.pickAll, 'Everything', '0', () => selectFilter.set(EVERYTHING))
  for (const k of FILTER_KEYS)
    cell(k, TYPES[k].icon, TYPES[k].label, TYPES[k].key, (e) => (e.ctrlKey ? selectFilter.toggle(k) : selectFilter.set(only(k))))
  const showFilter = (): void => {
    const all = selectFilter.isEverything()
    cells.get('all')!.classList.toggle('on', all)
    for (const k of FILTER_KEYS) cells.get(k)!.classList.toggle('on', !all && selectFilter.value[k])
  }
  selectFilter.on('changed', showFilter)
  showFilter()
  vp.host.append(palette)
  // Hidden unless a command is running, or the user pins it open from the bottom bar.
  const PIN_KEY = 'cadcam.filterPinned'
  let pinned = false
  try {
    pinned = localStorage.getItem(PIN_KEY) === '1'
  } catch {
    /* no storage */
  }
  const filterBtn = el('button', 'sb-icon')
  filterBtn.innerHTML = icons.filter
  const showPalette = (): void => {
    palette.hidden = !(pinned || commandRunning())
    filterBtn.classList.toggle('narrowed', pinned)
    filterBtn.title = pinned ? 'Selection filter: always shown (click to show only during commands)' : 'Selection filter: shown during commands (click to keep it on screen)'
  }
  filterBtn.addEventListener('click', () => {
    pinned = !pinned
    try {
      localStorage.setItem(PIN_KEY, pinned ? '1' : '0')
    } catch {
      /* no storage */
    }
    showPalette()
  })
  onCommandChange(showPalette)
  // Tiny toggle in the window's status bar (bottom edge).
  const sb = document.querySelector('.statusbar')
  let tray = sb?.querySelector('.status-icons') as HTMLElement | null
  if (sb && !tray) {
    tray = el('span', 'status-icons')
    sb.insertBefore(tray, sb.querySelector('.status-units'))
  }
  tray?.append(filterBtn)
  showPalette()

  const multi = el('button', 'vb-btn')
  multi.innerHTML = icons.selMulti
  const showMulti = (): void => {
    multi.classList.toggle('narrowed', selection.multi)
    multi.title = `Multi-select: ${selection.multi ? 'on, clicks add items' : 'off, one item at a time'} (or hold Shift)`
  }
  multi.addEventListener('click', () => {
    selection.multi = !selection.multi
    showMulti()
  })
  showMulti()
  const prev = el('button', 'vb-btn')
  prev.innerHTML = icons.selPrev
  prev.title = 'Previous selection: bring back the selection before the last change'
  prev.addEventListener('click', () => selection.restorePrevious())
  const clear = el('button', 'vb-btn')
  clear.innerHTML = icons.selClear
  clear.title = 'Clear selection (Esc)'
  clear.addEventListener('click', () => selection.clear())
  const count = el('span', 'vb-count')

  bar.append(multi, prev, clear, el('span', 'vb-sep'), el('span', 'vb-extra'), count)
  vp.host.append(bar)

  const showSel = (): void => {
    const s = selection.summary()
    count.textContent = s || 'Nothing selected'
    count.classList.toggle('empty', !s)
    clear.disabled = !s
    prev.disabled = !selection.hasPrevious
  }
  selection.on('changed', showSel)
  showSel()

  // 1-5 pick just that type, 0 = everything (not while typing).
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const t = e.target as HTMLElement
    if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('.modal-backdrop')) return
    if (e.key === '0') return selectFilter.set(EVERYTHING)
    const k = FILTER_KEYS.find((x) => TYPES[x].key === e.key)
    if (k) selectFilter.set(only(k))
  })
  // During a command: C combined / everything, E elements (bodies),
  // P points, F faces, D edges, S surfaces. Caught first so they don't run
  // the ribbon shortcuts that share those letters.
  const LETTERS: Record<string, keyof SelectFilter | 'all'> = { c: 'all', e: 'body', p: 'vertex', f: 'face', d: 'edge', s: 'surface' }
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !commandRunning()) return
      const t = e.target as HTMLElement
      // Letters mean nothing in a number box, so they still switch the filter there.
      const numberBox = t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'number'
      if (!numberBox && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      const k = LETTERS[e.key.toLowerCase()]
      if (!k) return
      e.preventDefault()
      e.stopPropagation()
      selectFilter.set(k === 'all' ? EVERYTHING : only(k))
    },
    true
  )
}
