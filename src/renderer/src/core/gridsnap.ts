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
  const label = state.step ? fmt(state.step) : `Auto ${fmt(vpRef.gridSpacing)}`
  btn.querySelector('.sb-grid-text')!.textContent = label
  btn.classList.toggle('narrowed', state.snap)
  btn.title = `Grid ${state.step ? fmt(state.step) + ' mm' : 'spacing follows the zoom'}; snap ${state.snap ? 'on' : 'off'}. Click to change.`
}

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
  btn = el('button', 'sb-icon sb-grid')
  btn.innerHTML = `${ICON}<span class="sb-grid-text"></span>`
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    openMenu(btn!)
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

function openMenu(anchor: HTMLElement): void {
  document.querySelector('.grid-menu')?.remove()
  const m = el('div', 'menu grid-menu')
  const snap = el('label', 'grid-row')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = state.snap
  box.addEventListener('change', () => setGridSnap(box.checked))
  snap.append(box, el('span', '', 'Snap to grid (sketching)'))
  m.append(snap, el('div', 'grid-head', 'Spacing (mm)'))
  const list = el('div', 'grid-presets')
  const opt = (label: string, step: number | null): void => {
    const b = el('button', 'btn vs-text', label)
    b.classList.toggle('on', state.step === step)
    b.addEventListener('click', () => {
      setGridStep(step)
      close()
    })
    list.append(b)
  }
  opt('Auto', null)
  for (const p of PRESETS) opt(fmt(p), p)
  m.append(list)
  const custom = el('label', 'grid-row')
  const input = el('input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.placeholder = 'other'
  if (state.step && !PRESETS.includes(state.step)) input.value = fmt(state.step)
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      const v = Number(input.value.replace(',', '.'))
      if (Number.isFinite(v) && v > 0) setGridStep(v)
      close()
    } else if (e.key === 'Escape') close()
  })
  custom.append(el('span', '', 'Other:'), input)
  m.append(custom)
  const r = anchor.getBoundingClientRect()
  m.style.right = `${Math.max(4, window.innerWidth - r.right)}px`
  m.style.bottom = `${window.innerHeight - r.top + 4}px`
  document.body.append(m)
  const close = (): void => {
    m.remove()
    window.removeEventListener('pointerdown', outside, true)
  }
  const outside = (e: Event): void => {
    if (!m.contains(e.target as Node) && e.target !== anchor) close()
  }
  window.addEventListener('pointerdown', outside, true)
}
