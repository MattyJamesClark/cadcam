import type { ModuleContext } from './types'
import { measureCad } from './occt'
import { Highlights, pickAt, pickKey, rowMajor, type Pick } from './picking'
import { el, fmt } from './toolpanel'
import type * as THREE from 'three'

/**
 * Dynamic selection: with no tool running, the face / edge / point under the
 * pointer lights up with a small label (radius, diameter, length...). A click
 * pins the label so it stays while you look around.
 */

const KEY = 'cadcam.hoverInfo'
let enabled = localStorage.getItem(KEY) !== '0'
let instance: HoverInfo | null = null

export const hoverInfoEnabled = (): boolean => enabled
export function setHoverInfo(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (!on) instance?.clear(true)
}

export function startHoverInfo(ctx: ModuleContext): void {
  instance ??= new HoverInfo(ctx)
}

const FILTER = { vertex: true, edge: true, face: true, body: false }
const HOVER = 0xfff1a8
const PINNED = 0xff9f1c

class HoverInfo {
  private hl: Highlights
  private hover: Pick | null = null
  private pinned: Pick | null = null
  private label = el('div', 'hover-label')
  private pinLabel = el('div', 'dim-label pin-label')
  private cache = new Map<string, string>()
  private queued: PointerEvent | null = null
  private lastXY = { x: 0, y: 0 }

  constructor(private ctx: ModuleContext) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    this.label.hidden = this.pinLabel.hidden = true
    vp.host.append(this.label, this.pinLabel)
    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY }
    })
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > 4 || !this.active()) return
      this.pinned = this.hover
      void this.refresh()
    })
    canvas.addEventListener('pointermove', (e) => {
      const first = !this.queued
      this.queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = this.queued!
        this.queued = null
        this.move(ev)
      })
    })
    canvas.addEventListener('pointerleave', () => {
      this.hover = null
      void this.refresh()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pinned && this.active()) {
        this.pinned = null
        void this.refresh()
      }
    })
    // The model changed: labels may be stale.
    ctx.doc.history.on('changed', () => {
      this.cache.clear()
      this.clear(true)
    })
    vp.afterRender.add(() => this.placePin())
  }

  /** Off while a tool (Measure, Translate...) owns the mouse. */
  private active(): boolean {
    return enabled && !this.ctx.viewport.blockPick
  }

  private move(e: PointerEvent): void {
    this.lastXY = { x: e.clientX, y: e.clientY }
    if (!this.active() || e.buttons) {
      if (this.hover || this.pinned) this.clear(!this.active())
      return
    }
    const h = pickAt(this.ctx.viewport, e, FILTER)
    const changed = (h && pickKey(h)) !== (this.hover && pickKey(this.hover))
    this.hover = h
    if (changed) void this.refresh()
    else this.placeHover()
  }

  clear(all: boolean): void {
    this.hover = null
    if (all) this.pinned = null
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    const list: { pick: Pick; color: number }[] = []
    if (this.pinned) list.push({ pick: this.pinned, color: PINNED })
    if (this.hover && (!this.pinned || pickKey(this.hover) !== pickKey(this.pinned))) list.push({ pick: this.hover, color: HOVER })
    this.hl.set(list)

    const hover = this.hover
    this.label.hidden = true
    if (hover && (!this.pinned || pickKey(hover) !== pickKey(this.pinned))) {
      const text = await this.textOf(hover)
      if (hover === this.hover && text) {
        this.label.textContent = text
        this.label.hidden = false
        this.placeHover()
      }
    }
    const pin = this.pinned
    if (!pin) this.pinLabel.hidden = true
    else {
      const text = await this.textOf(pin)
      if (pin === this.pinned && text) {
        this.pinLabel.textContent = text
        this.pinLabel.hidden = false
        this.placePin()
      }
    }
  }

  private placeHover(): void {
    const r = this.ctx.viewport.host.getBoundingClientRect()
    this.label.style.left = `${this.lastXY.x - r.left + 14}px`
    this.label.style.top = `${this.lastXY.y - r.top + 16}px`
  }

  private placePin(): void {
    if (!this.pinned || this.pinLabel.hidden) return
    const s = this.ctx.viewport.toScreen(this.pinned.point)
    this.pinLabel.style.left = `${s.x}px`
    this.pinLabel.style.top = `${s.y}px`
  }

  private async textOf(p: Pick): Promise<string> {
    const key = pickKey(p)
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    let text = ''
    const geo = (p.object as THREE.Mesh).geometry
    if (p.kind === 'point') text = `Point  ${fmt(p.point.x)}, ${fmt(p.point.y)}, ${fmt(p.point.z)}`
    else if (geo?.userData.brep && p.kind !== 'body') {
      try {
        p.object.updateMatrixWorld()
        const res = await measureCad([{ brep: geo.userData.brep as Uint8Array, kind: p.kind, index: p.index, matrix: rowMajor(p.object.matrixWorld) }])
        text = describe(res.items[0])
      } catch {
        text = ''
      }
    }
    this.cache.set(key, text)
    return text
  }
}

function describe(d: Record<string, unknown>): string {
  const n = (k: string): number => d[k] as number
  if (d.kind === 'vertex') {
    const [x, y, z] = d.point as number[]
    return `Point  ${fmt(x)}, ${fmt(y)}, ${fmt(z)}`
  }
  if (d.kind === 'edge') {
    switch (d.curve) {
      case 'Circle':
        return `Circle  Ø${fmt(n('radius') * 2)}  R${fmt(n('radius'))}`
      case 'Arc':
        return `Arc  R${fmt(n('radius'))}  ${fmt(n('sweep'), 2)}°  L${fmt(n('length'))}`
      case 'Line':
        return `Line  L${fmt(n('length'))}`
      case 'Ellipse':
        return `Ellipse  ${fmt(n('major'))} × ${fmt(n('minor'))}`
      default:
        return `Curve  L${fmt(n('length'))}`
    }
  }
  switch (d.surface) {
    case 'Cylinder':
      return `Cylinder  Ø${fmt(n('radius') * 2)}  R${fmt(n('radius'))}`
    case 'Sphere':
      return `Sphere  SR${fmt(n('radius'))}`
    case 'Cone':
      return `Cone  ${fmt(n('halfAngle') * 2, 2)}° incl.`
    case 'Torus':
      return `Torus  R${fmt(n('minor'))} on R${fmt(n('major'))}`
    case 'Plane':
      return `Plane  ${fmt(n('area'), 1)} mm²`
    default:
      return `Surface  ${fmt(n('area'), 1)} mm²`
  }
}
