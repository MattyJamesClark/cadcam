import * as THREE from 'three'
import type { ModuleContext } from './types'
import { dotMaterial, Highlights, pickAt, pickKey, type Pick } from './picking'
import { showCmdBar } from './cmdbar'
import { el, fmt } from './toolpanel'

/**
 * Query thickness: click a point on a face and get the wall
 * thickness there, measured straight through the body along the face normal
 * to the far wall. Keeps going (one result per click) until Esc / tick.
 */

let active: ThicknessTool | null = null

export const isThicknessOpen = (): boolean => active !== null
export const closeThickness = (): void => active?.close()

export function openThickness(ctx: ModuleContext): void {
  if (active) return
  active = new ThicknessTool(ctx)
}

const COLOR = 0x22d3ee

class ThicknessTool {
  private prompt = el('div', 'vp-prompt')
  private hl: Highlights
  private hover: Pick | null = null
  private group = new THREE.Group()
  private label: HTMLElement | null = null
  private labelAt = new THREE.Vector3()
  private off: (() => void)[] = []

  constructor(private ctx: ModuleContext) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    vp.scene.add(this.group)
    vp.host.append(this.prompt)
    vp.blockPick = () => true
    this.say()
    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    let queued: PointerEvent | null = null
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const p = pickAt(vp, e, { face: true })
      if (p?.kind === 'face') this.measure(p)
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = queued!
        queued = null
        const h = ev.buttons ? null : pickAt(vp, ev, { face: true })
        if ((h && pickKey(h)) !== (this.hover && pickKey(this.hover))) {
          this.hover = h
          this.hl.set(h ? [{ pick: h, color: 0xfff1a8 }] : [])
        }
      })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.preventDefault()
      e.stopPropagation()
      this.close()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey, true)
    const place = (): void => {
      if (!this.label) return
      const q = vp.toScreen(this.labelAt)
      this.label.style.left = `${q.x}px`
      this.label.style.top = `${q.y}px`
    }
    vp.afterRender.add(place)
    const bar = showCmdBar(vp.host, { ok: () => this.close(), cancel: () => this.close() })
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey, true)
      vp.afterRender.delete(place)
      bar.dispose()
    })
  }

  private say(note?: string): void {
    const main = el('span')
    main.append(el('b', '', 'Query thickness'), document.createTextNode(': click a point on a face'))
    this.prompt.replaceChildren(main)
    if (note) this.prompt.append(el('span', 'vp-prompt-note', note))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Esc to finish'))
  }

  private measure(p: Pick): void {
    const mesh = p.object as THREE.Mesh
    if (!p.normal) return this.say('No surface direction there, try another spot.')
    // Into the material: against the outward normal.
    const dir = p.normal.clone().normalize().negate()
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).length()
    const eps = Math.max(1e-4, size * 1e-6)
    const ray = new THREE.Raycaster(p.point.clone().addScaledVector(dir, eps), dir, 0, size * 2)
    // Hit the far wall from inside: count back faces too.
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[]
    const sides = mats.map((m) => m.side)
    mats.forEach((m) => (m.side = THREE.DoubleSide))
    const hit = ray.intersectObject(mesh, false)[0]
    mats.forEach((m, i) => (m.side = sides[i]))
    this.clearResult()
    if (!hit) return this.say('Nothing behind that face (open surface?).')
    const a = p.point.clone()
    const b = hit.point.clone()
    const t = a.distanceTo(b)
    const g = new THREE.BufferGeometry().setFromPoints([a, b])
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLOR, depthTest: false }))
    line.renderOrder = 13
    const dots = new THREE.Points(g, dotMaterial(COLOR, 9))
    dots.renderOrder = 13
    this.group.add(line, dots)
    this.label = el('div', 'dim-label', `Thickness ${fmt(t)}`)
    this.ctx.viewport.host.append(this.label)
    this.labelAt.copy(a).add(b).multiplyScalar(0.5)
    this.say(`Thickness ${fmt(t)} mm. Click another point, or Esc.`)
    this.ctx.status(`Thickness ${fmt(t)} mm`)
    this.ctx.viewport.requestRender()
  }

  private clearResult(): void {
    for (const o of [...this.group.children]) {
      this.group.remove(o)
      ;(o as THREE.Line).geometry?.dispose()
    }
    this.label?.remove()
    this.label = null
  }

  close(): void {
    if (active !== this) return
    active = null
    this.off.forEach((f) => f())
    this.clearResult()
    this.ctx.viewport.scene.remove(this.group)
    this.hl.dispose()
    this.prompt.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.refreshRibbon()
    this.ctx.viewport.requestRender()
  }
}
