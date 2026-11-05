import * as THREE from 'three'
import type { ModuleContext } from './types'
import { Highlights, pickAt, pickKey, type Pick } from './picking'
import { el } from './toolpanel'

/**
 * Ask for a few points in the view, one prompt per point (bottom of the
 * viewport). Points snap to vertices, centres, quadrants and midpoints; a
 * click on an edge or face uses the spot clicked. Esc gives null.
 */

let busy = false
export const isPickingPoints = (): boolean => busy

export function pickPoints(ctx: ModuleContext, title: string, steps: string[]): Promise<THREE.Vector3[] | null> {
  if (busy) return Promise.resolve(null)
  busy = true
  const vp = ctx.viewport
  const filter = { vertex: true, edge: true, face: true }
  const hl = new Highlights(vp)
  const prompt = el('div', 'vp-prompt')
  vp.host.append(prompt)
  const prevBlock = vp.blockPick
  vp.blockPick = () => true
  const canvas = vp.renderer.domElement
  const got: Pick[] = []
  let hover: Pick | null = null
  let queued: PointerEvent | null = null
  let down: { x: number; y: number } | null = null

  const say = (): void => {
    const main = el('span')
    main.append(el('b', '', title), document.createTextNode(`: ${steps[got.length]}`))
    prompt.replaceChildren(main, el('span', 'vp-prompt-esc', 'Esc to cancel'))
  }
  const draw = (): void => {
    const list = got.map((pick) => ({ pick, color: 0xff9f1c }))
    if (hover) list.push({ pick: hover, color: 0xfff1a8 })
    hl.set(list)
  }
  say()

  return new Promise((resolve) => {
    const finish = (res: THREE.Vector3[] | null): void => {
      canvas.removeEventListener('pointerdown', onDown, true)
      canvas.removeEventListener('pointerup', onUp, true)
      canvas.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey, true)
      hl.dispose()
      prompt.remove()
      vp.blockPick = prevBlock
      busy = false
      vp.requestRender()
      resolve(res)
    }
    // Capture phase, so on-screen handles (move arrows) don't take the click.
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      down = { x: e.clientX, y: e.clientY }
      e.stopImmediatePropagation()
    }
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      e.stopImmediatePropagation()
      if (moved > 4) return
      const p = pickAt(vp, e, filter)
      if (!p) return
      got.push(p)
      draw()
      if (got.length === steps.length) finish(got.map((g) => g.point.clone()))
      else say()
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = queued!
        queued = null
        const h = ev.buttons ? null : pickAt(vp, ev, filter)
        if ((h && pickKey(h)) !== (hover && pickKey(hover))) {
          hover = h
          draw()
        }
      })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      finish(null)
    }
    canvas.addEventListener('pointerdown', onDown, true)
    canvas.addEventListener('pointerup', onUp, true)
    canvas.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey, true)
  })
}

/** "Point to point" and "To midpoint" buttons for a move panel; `apply` gets the distance to move. */
export function pointMoveButtons(ctx: ModuleContext, before: () => void, apply: (delta: THREE.Vector3) => void): HTMLElement {
  const row = el('div', 'tool-pick-row')
  const b1 = el('button', 'btn', 'Point to point')
  b1.title = 'Click the point to move from, then the point to move to'
  b1.addEventListener('click', async () => {
    before()
    const p = await pickPoints(ctx, 'Point to point', ['select the point to move from', 'select the point to move to'])
    if (p) apply(p[1].sub(p[0]))
  })
  const b2 = el('button', 'btn', 'To midpoint')
  b2.title = 'Click the point to move from, then two points: it moves to halfway between them'
  b2.addEventListener('click', async () => {
    before()
    const p = await pickPoints(ctx, 'To midpoint', ['select the point to move from', 'select the first point', 'select the second point'])
    if (p) apply(p[1].add(p[2]).multiplyScalar(0.5).sub(p[0]))
  })
  row.append(b1, b2)
  return row
}
