import type { ModuleContext } from './types'
import { icons } from './icons'
import { EVERYTHING, FILTER_KEYS, selectFilter, type SelectFilter } from './picking'
import { selection } from './selection'
import { el } from './toolpanel'

/**
 * Small icon-only toolbar along the bottom of the viewport: the selection
 * filter, Multi-select, Previous selection, Clear selection and what is selected.
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

  // Selection filter: the button shows what's on; the pop-up toggles each type.
  const filterBtn = el('button', 'vb-btn vb-filter')
  const pop = el('div', 'vb-pop')
  pop.hidden = true
  const rows = new Map<string, HTMLButtonElement>()
  const row = (id: string, icon: string, label: string, key: string, onClick: () => void): void => {
    const r = el('button', 'vb-row')
    r.innerHTML = icon
    r.append(el('span', 'vb-row-label', label), el('span', 'vb-row-key', key))
    r.addEventListener('click', onClick)
    rows.set(id, r)
    pop.append(r)
  }
  row('all', icons.pickAll, 'Everything', '0', () => selectFilter.set(EVERYTHING))
  pop.append(el('div', 'vb-sep-h'))
  for (const k of FILTER_KEYS) row(k, TYPES[k].icon, TYPES[k].label, TYPES[k].key, () => selectFilter.toggle(k))

  const showFilter = (): void => {
    const on = FILTER_KEYS.filter((k) => selectFilter.value[k])
    const all = selectFilter.isEverything()
    filterBtn.innerHTML = all ? icons.pickAll : on.length === 1 ? TYPES[on[0]].icon : icons.filter
    filterBtn.title = `Selection filter: ${all ? 'Everything' : on.map((k) => TYPES[k].label).join(', ')}`
    filterBtn.classList.toggle('narrowed', !all)
    rows.get('all')!.classList.toggle('on', all)
    for (const k of FILTER_KEYS) rows.get(k)!.classList.toggle('on', selectFilter.value[k])
  }
  const close = (): void => {
    pop.hidden = true
    filterBtn.classList.remove('open')
  }
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    pop.hidden = !pop.hidden
    filterBtn.classList.toggle('open', !pop.hidden)
  })
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && e.target !== filterBtn && !filterBtn.contains(e.target as Node)) close()
  })
  selectFilter.on('changed', showFilter)
  showFilter()

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

  const wrap = el('div', 'vb-filter-wrap')
  wrap.append(filterBtn, pop)
  bar.append(wrap, multi, prev, clear, el('span', 'vb-sep'), el('span', 'vb-extra'), count)
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

  // 1-5 toggle a type, 0 = everything (not while typing).
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const t = e.target as HTMLElement
    if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('.modal-backdrop')) return
    if (e.key === 'Escape' && !pop.hidden) return close()
    if (e.key === '0') return selectFilter.set(EVERYTHING)
    const k = FILTER_KEYS.find((x) => TYPES[x].key === e.key)
    if (k) selectFilter.toggle(k)
  })
}
