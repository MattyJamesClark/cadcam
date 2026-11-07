import { el } from './toolpanel'

/**
 * Command bar: a small floating strip at the top centre of the
 * view while a command runs, with OK (green tick), Cancel (red cross) and
 * Back / Next arrows. Each command passes the actions it supports; the rest
 * are shown greyed out. Only one bar shows at a time (the newest wins).
 */
export interface CmdBarActions {
  ok?: () => void
  cancel?: () => void
  back?: () => void
  next?: () => void
}

const ICON = {
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m7 12.5 3.2 3.2L17 9"/></svg>',
  cancel: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m8.5 8.5 7 7m0-7-7 7"/></svg>',
  back: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m13.5 8-4 4 4 4"/></svg>',
  next: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m10.5 8 4 4-4 4"/></svg>'
}
const TITLE = { ok: 'OK (Enter)', cancel: 'Cancel (Esc)', back: 'Back a step', next: 'Next step' }

const stack: { bar: HTMLElement; host: HTMLElement }[] = []
const watchers = new Set<(running: boolean) => void>()

/** Is a command running (its tick bar showing)? */
export const commandRunning = (): boolean => stack.length > 0
/** Called whenever a command starts or ends. */
export function onCommandChange(fn: (running: boolean) => void): void {
  watchers.add(fn)
}
const notify = (): void => watchers.forEach((f) => f(stack.length > 0))

export function showCmdBar(host: HTMLElement, actions: CmdBarActions): { update(a: CmdBarActions): void; dispose(): void } {
  const bar = el('div', 'vp-cmdbar')
  const buttons = new Map<keyof CmdBarActions, HTMLButtonElement>()
  let current = actions
  for (const k of ['ok', 'cancel', 'back', 'next'] as const) {
    const b = el('button', `cb-btn cb-${k}`)
    b.innerHTML = ICON[k]
    b.title = TITLE[k]
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      current[k]?.()
    })
    buttons.set(k, b)
    bar.append(b)
  }
  const sync = (): void => buttons.forEach((b, k) => (b.disabled = !current[k]))
  sync()
  stack.at(-1)?.bar.classList.add('hidden')
  stack.push({ bar, host })
  host.append(bar)
  notify()
  return {
    update(a) {
      current = { ...current, ...a }
      sync()
    },
    dispose() {
      const i = stack.findIndex((s) => s.bar === bar)
      if (i < 0) return
      stack.splice(i, 1)
      bar.remove()
      stack.at(-1)?.bar.classList.remove('hidden')
      notify()
    }
  }
}
