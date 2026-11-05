/** Small DOM helpers for floating tool panels in the viewport (Translate, Measure, Bounding box). */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export const fmt = (v: number, digits = 3): string => {
  const r = Math.round(v * 10 ** digits) / 10 ** digits
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-GB', { maximumFractionDigits: digits })
}

/** A panel shell: title, subtitle, body and a close button. Clicks don't reach the viewport. */
export function toolPanel(title: string, onClose: () => void): { panel: HTMLElement; sub: HTMLElement; body: HTMLElement } {
  const panel = el('div', 'tool-panel')
  const head = el('div', 'tool-head')
  const sub = el('span', 'tool-sub')
  const close = el('button', 'tool-close', '×')
  close.title = 'Close (Esc)'
  close.addEventListener('click', onClose)
  head.append(el('span', 'tool-name', title), sub, close)
  const body = el('div', 'tool-body')
  panel.append(head, body)
  panel.addEventListener('pointerdown', (e) => e.stopPropagation())
  return { panel, sub, body }
}

/** Label / value rows. A row with value null is a section heading. */
export function resultRows(rows: [string, string | null][]): HTMLElement {
  const list = el('div', 'tool-results')
  for (const [k, v] of rows) {
    if (v === null) list.append(el('div', 'tool-section', k))
    else list.append(el('span', 'tool-key', k), el('span', 'tool-val', v))
  }
  return list
}

/** Segmented control. */
export function segmented<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  const seg = el('div', 'seg tool-seg')
  seg.setAttribute('role', 'radiogroup')
  const buttons = options.map(([v, label]) => {
    const b = el('button', '', label)
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(v === value))
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-checked', String(x === b)))
      onChange(v)
    })
    seg.append(b)
    return b
  })
  return seg
}
