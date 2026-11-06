import type { ModuleContext } from './types'
import { el } from './toolpanel'
import { icons } from './icons'
import { onCommandChange } from './cmdbar'

/**
 * The side toolbar: always on screen down the right of the view, and its
 * buttons change with the task, so what you need is always in the same place.
 * With no command running it shows the everyday tools (Fit all, Measure,
 * Translate...). A command shows its own layout in the same spot, always in
 * the same shape: the main modes on top, options below, and a flyout to the
 * left for typed values. Nothing animates: it just switches.
 */

export interface SideButton {
  icon: string
  label: string
  /** Shortcut shown in the tooltip. */
  key?: string
  /** Extra tooltip text. */
  hint?: string
  /** Drawn pressed. */
  on?: () => boolean
  enabled?: () => boolean
  /** Not built yet: shown greyed out with this note. */
  soon?: string
  run?: () => void
}

export interface SideLayout {
  /** Small caption at the top ("Translate"). */
  title: string
  /** Rows of up to two buttons; a line between rows. */
  rows: SideButton[][]
}

export interface SideHandle {
  /** Redraw pressed / enabled states. */
  refresh(): void
  /** Show typed-value boxes beside the toolbar, or hide them with null. */
  flyout(content: HTMLElement | null): void
  dispose(): void
}

let ctxRef: ModuleContext | null = null
let host: HTMLElement | null = null
let fly: HTMLElement | null = null
const stack: { layout: SideLayout; flyout: HTMLElement | null }[] = []
let buttons: { b: HTMLButtonElement; def: SideButton }[] = []

/** The everyday layout, from the app's commands. */
function baseLayout(ctx: ModuleContext): SideLayout {
  const cmd = (id: string, icon?: string, label?: string): SideButton => {
    const c = ctx.command(id)
    return {
      icon: icon ?? c?.icon ?? icons.menu,
      label: label ?? c?.label ?? id,
      key: c?.shortcut,
      hint: c?.tooltip,
      enabled: () => !!c && (c.isEnabled?.(ctx) ?? true),
      on: () => !!c?.isActive?.(ctx),
      run: () => ctx.runCommand(id)
    }
  }
  return {
    title: 'Tools',
    rows: [
      [cmd('view.fit', icons.fit, 'Fit all'), cmd('query.measure', icons.ruler, 'Measure')],
      [cmd('edit.translate'), cmd('edit.rotate')],
      [cmd('edit.delete')],
      [
        { icon: icons.cam, label: 'CAM', soon: 'CAM: toolpaths, coming once the CAD side is solid' },
        { icon: icons.plotview, label: 'Plotview', soon: 'Plotview: 2D technical drawings from the model, coming later' }
      ]
    ]
  }
}

function render(): void {
  if (!host || !ctxRef) return
  const top = stack.at(-1)
  const layout = top?.layout ?? baseLayout(ctxRef)
  host.replaceChildren()
  host.classList.toggle('in-command', !!top)
  host.append(el('div', 'sb-title', layout.title))
  buttons = []
  layout.rows.forEach((row, i) => {
    if (i) host!.append(el('div', 'sb-rule'))
    const r = el('div', 'sb-row')
    for (const def of row) {
      const b = el('button', 'vf-btn sb-btn')
      b.innerHTML = def.icon
      const key = def.key ? ` (${def.key})` : ''
      b.title = def.soon ?? `${def.label}${key}${def.hint ? `\n${def.hint}` : ''}`
      b.setAttribute('aria-label', def.label)
      b.addEventListener('click', () => {
        if (def.soon || b.disabled) return
        def.run?.()
        refresh()
      })
      if (def.soon) b.classList.add('soon')
      buttons.push({ b, def })
      r.append(b)
    }
    host!.append(r)
  })
  showFlyout(top?.flyout ?? null)
  refresh()
}

function refresh(): void {
  for (const { b, def } of buttons) {
    b.disabled = !!def.soon || (def.enabled ? !def.enabled() : false)
    b.classList.toggle('on', !!def.on?.())
  }
}

function showFlyout(content: HTMLElement | null): void {
  if (!fly) return
  fly.replaceChildren()
  fly.hidden = !content
  if (content) fly.append(content)
}

export function startSideBar(ctx: ModuleContext): void {
  if (host) return
  ctxRef = ctx
  const vp = ctx.viewport
  const wrap = el('div', 'vp-side')
  host = el('div', 'vp-sidebar')
  fly = el('div', 'vp-flyout')
  fly.hidden = true
  wrap.append(fly, host)
  // Clicks on the toolbar never reach the model.
  wrap.addEventListener('pointerdown', (e) => e.stopPropagation())
  vp.host.append(wrap)
  ctx.doc.on('selection', refresh)
  ctx.doc.history.on('changed', refresh)
  onCommandChange(refresh)
  render()
}

/** Show a command's own layout in place of the everyday one until disposed. */
export function showSideLayout(layout: SideLayout): SideHandle {
  const entry = { layout, flyout: null as HTMLElement | null }
  stack.push(entry)
  render()
  return {
    refresh: () => stack.at(-1) === entry && refresh(),
    flyout(content) {
      entry.flyout = content
      if (stack.at(-1) === entry) showFlyout(content)
    },
    dispose() {
      const i = stack.indexOf(entry)
      if (i < 0) return
      stack.splice(i, 1)
      render()
    }
  }
}

/** Redraw the everyday buttons' states (after something outside changed them). */
export const refreshSideBar = (): void => refresh()
