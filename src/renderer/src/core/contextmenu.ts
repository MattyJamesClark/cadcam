import type * as THREE from 'three'
import type { ModuleContext } from './types'
import { icons } from './icons'
import { pickAt, pickKey, type Pick } from './picking'
import { selection } from './selection'
import { commandRunning } from './cmdbar'
import { openEditFaces } from './editfaces'

/**
 * Right-click menu in the view. A right click (without dragging, which turns
 * the view) on a face / edge / body picks it if it isn't already selected,
 * then offers what can be done with it: Edit faces, Translate, Rotate, Hide,
 * Delete, measuring... Esc or a click elsewhere closes it.
 */

let menu: HTMLElement | null = null

export function startContextMenu(ctx: ModuleContext): void {
  const vp = ctx.viewport
  const canvas = vp.renderer.domElement
  let down: { x: number; y: number } | null = null
  canvas.addEventListener('pointerdown', (e) => {
    close()
    down = e.button === 2 ? { x: e.clientX, y: e.clientY } : null
  })
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 2 || !down) return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    if (moved > 4 || commandRunning() || vp.blockPick?.()) return
    open(ctx, e)
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu) {
      e.stopPropagation()
      close()
    }
  }, true)
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target as Node)) close()
  }, true)
}

function close(): void {
  menu?.remove()
  menu = null
}

function open(ctx: ModuleContext, e: PointerEvent): void {
  const hit = pickAt(ctx.viewport, e)
  // Right-clicking something that isn't selected selects it (like Windows).
  if (hit && !isSelected(hit)) selection.pick(hit, false)
  const faces = selection.items.filter((p) => p.kind === 'face' && (p.object as THREE.Mesh).geometry?.userData.brep)
  const hasSel = !selection.isEmpty
  const m = document.createElement('div')
  m.className = 'menu ctx-menu'
  const item = (icon: string, label: string, run: () => void, enabled = true, key = ''): void => {
    const b = document.createElement('button')
    b.className = 'menu-item'
    b.innerHTML = `<span class="mi-icon">${icon}</span><span class="mi-label">${label}</span><span class="mi-key">${key}</span>`
    b.disabled = !enabled
    b.addEventListener('click', () => {
      close()
      run()
    })
    m.append(b)
  }
  const sep = (): void => {
    if (m.lastElementChild && !m.lastElementChild.classList.contains('menu-sep')) m.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }))
  }
  const cmd = (id: string): void => {
    const c = ctx.command(id)
    if (!c) return
    if (c.isEnabled?.(ctx) ?? true) item(c.icon, c.label, () => ctx.runCommand(id), true, c.shortcut ?? '')
  }

  if (faces.length) {
    item(icons.editFaces, `Edit face${faces.length === 1 ? '' : 's'}…`, () => openEditFaces(ctx, faces))
    item(icons.thickness, 'Query thickness', () => ctx.runCommand('query.thickness'))
    sep()
  }
  if (hasSel) {
    cmd('edit.translate')
    cmd('edit.rotate')
    sep()
    cmd('edit.hide')
    cmd('edit.delete')
    sep()
    cmd('view.fit-selection')
    item(icons.selClear, 'Clear selection', () => selection.clear(), true, 'Esc')
  } else {
    cmd('query.measure')
    cmd('edit.show-all')
    cmd('view.fit')
  }
  if (selection.hasPrevious) item(icons.selPrev, 'Previous selection', () => selection.restorePrevious())
  while (m.lastElementChild?.classList.contains('menu-sep')) m.lastElementChild.remove()
  document.body.append(m)
  const r = m.getBoundingClientRect()
  m.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 6)}px`
  m.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 6)}px`
  menu = m
}

function isSelected(p: Pick): boolean {
  if (p.kind === 'body') return selection.nodes.includes(p.object.userData.docId as string)
  return selection.items.some((x) => pickKey(x) === pickKey(p))
}
