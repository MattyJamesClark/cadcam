import type { Viewport } from './viewport'
import { el, fmt } from './toolpanel'

/**
 * Grid spacing and grid snap, set from a small control in the status bar:
 * click it for snap on / off and the spacing (Auto follows the zoom, or a
 * fixed size, finer or coarser). Sketch tools snap free clicks to the grid.
 */

const KEY = 'cadcam.grid'
const PRESETS = [0.01, 0.1, 0.5, 1, 2, 5, 10, 25, 50, 100]

interface GridState {
  snap: boolean
  step: number | null
}

function load(): GridState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<GridState>
    return { snap: v.snap ?? true, step: typeof v.step === 'number' && v.step > 0 ? v.step : null }
  } catch {
    return { snap: true, step: null }
  }
}

const state = load()
const save = (): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* no storage */
  }
}

/** Grid snap on? */
export const gridSnapOn = (): boolean => state.snap

const ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4v16M10 4v16M16 4v16M4 4h16M4 10h16M4 16h16" opacity=".75"/><circle cx="16" cy="16" r="2.6" fill="currentColor" stroke="none"/></svg>'

let vpRef: Viewport | null = null
let btn: HTMLButtonElement | null = null

export function setGridSnap(on: boolean): void {
  state.snap = on
  save()
  sync()
}

export function setGridStep(step: number | null): void {
  state.step = step && step > 0 ? step : null
  save()
  vpRef?.setGridStep(state.step)
  sync()
}

function sync(): void {
  if (!btn || !vpRef) return
  const size = state.step ?? vpRef.gridSpacing
  btn.querySelector('.sb-grid-text')!.textContent = `${fmt(size)} mm`
  btn.classList.toggle('on', state.snap)
  btn.classList.toggle('auto', !state.step)
  btn.title = `Grid ${fmt(size)} mm${state.step ? '' : ' (automatic)'} · snap ${state.snap ? 'on' : 'off'}`
  panel?.refresh()
}

let panel: { el: HTMLElement; refresh(): void } | null = null

export function startGridControl(vp: Viewport): void {
  vpRef = vp
  vp.setGridStep(state.step)
  const sb = document.querySelector('.statusbar')
  if (!sb) return
  let tray = sb.querySelector('.status-icons') as HTMLElement | null
  if (!tray) {
    tray = el('span', 'status-icons')
    sb.insertBefore(tray, sb.querySelector('.status-units'))
  }
  btn = el('button', 'sb-grid')
  btn.innerHTML = `${ICON}<span class="sb-grid-text"></span><span class="sb-grid-dot"></span>`
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (panel) closePanel()
    else openPanel(btn!)
  })
  tray.prepend(btn)
  // Auto spacing changes with the zoom: keep the label current.
  let last = 0
  vp.afterRender.add(() => {
    if (vp.gridSpacing !== last) {
      last = vp.gridSpacing
      sync()
    }
  })
  sync()
}

function closePanel(): void {
  panel?.el.remove()
  panel = null
  window.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('keydown', onEsc, true)
}
const outside = (e: Event): void => {
  const t = e.target as Node
  if (panel && !panel.el.contains(t) && !btn?.contains(t)) closePanel()
}
const onEsc = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && panel) {
    e.stopPropagation()
    closePanel()
  }
}

/** A labelled on / off switch row. */
function switchRow(title: string, sub: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; refresh(): void } {
  const row = el('button', 'gp-row')
  const text = el('span', 'gp-row-text')
  const t = el('span', 'gp-row-title', title)
  const d = el('span', 'gp-row-sub', sub)
  text.append(t, d)
  const sw = el('span', 'gp-switch')
  row.append(text, sw)
  row.addEventListener('click', () => set(!get()))
  return { row, refresh: () => row.classList.toggle('on', get()) }
}

function openPanel(anchor: HTMLElement): void {
  const p = el('div', 'grid-panel')
  p.addEventListener('pointerdown', (e) => e.stopPropagation())
  const head = el('div', 'gp-head')
  head.append(el('span', 'gp-title', 'Grid'))
  const x = el('button', 'gp-close', '×')
  x.title = 'Close'
  x.addEventListener('click', closePanel)
  head.append(x)

  const snap = switchRow('Snap to grid', 'Sketch clicks land on grid points (hold Shift to place freely)', () => state.snap, (v) => setGridSnap(v))
  const auto = switchRow('Automatic spacing', '', () => !state.step, (v) => setGridStep(v ? null : vpRef?.gridSpacing ?? 10))
  const autoSub = auto.row.querySelector('.gp-row-sub') as HTMLElement

  const sec = el('div', 'gp-section')
  sec.append(el('div', 'gp-label', 'Spacing'))
  const chips = el('div', 'gp-chips')
  const chipEls = new Map<number, HTMLButtonElement>()
  for (const v of PRESETS) {
    const c = el('button', 'gp-chip', fmt(v))
    c.addEventListener('click', () => setGridStep(v))
    chips.append(c)
    chipEls.set(v, c)
  }
  sec.append(chips)

  const custom = el('div', 'gp-custom')
  const field = el('label', 'gp-field')
  const input = el('input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.placeholder = 'Custom'
  field.append(input, el('span', 'gp-unit', 'mm'))
  const apply = el('button', 'gp-apply', 'Set')
  const use = (): void => {
    const v = Number(input.value.replace(',', '.'))
    if (Number.isFinite(v) && v > 0) {
      setGridStep(v)
      input.blur()
    } else input.classList.add('bad')
  }
  apply.addEventListener('click', use)
  input.addEventListener('input', () => input.classList.remove('bad'))
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') use()
    else if (e.key === 'Escape') closePanel()
  })
  custom.append(field, apply)
  sec.append(custom)

  p.append(head, snap.row, auto.row, sec)
  const refresh = (): void => {
    snap.refresh()
    auto.refresh()
    autoSub.textContent = state.step ? `Fixed at ${fmt(state.step)} mm whatever the zoom` : `Follows the zoom (now ${fmt(vpRef?.gridSpacing ?? 10)} mm)`
    for (const [v, c] of chipEls) c.classList.toggle('on', state.step === v)
    if (document.activeElement !== input) input.value = state.step && !PRESETS.includes(state.step) ? fmt(state.step) : ''
  }
  panel = { el: p, refresh }
  refresh()
  document.body.append(p)
  const r = anchor.getBoundingClientRect()
  const w = p.offsetWidth
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`
  p.style.bottom = `${window.innerHeight - r.top + 6}px`
  window.addEventListener('pointerdown', outside, true)
  window.addEventListener('keydown', onEsc, true)
}
