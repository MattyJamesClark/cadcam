import * as THREE from 'three'
import type { ModuleContext } from './types'
import type { Dimension } from './document'
import { datums } from './datums'
import { dotMaterial } from './picking'
import { el } from './toolpanel'

/**
 * Draws the document's dimensions: lines in the 3D view, values as labels
 * that can be dragged, clicked to select, and deleted with Delete.
 */

const COLOR = 0x7dd3fc
const SELECTED = 0xff9f1c
const KEY = 'cadcam.showDims'
let shown = localStorage.getItem(KEY) !== '0'
let layer: DimensionLayer | null = null

export const dimsShown = (): boolean => shown
export function setDimsShown(on: boolean): void {
  shown = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  layer?.redraw()
}
export function startDimensions(ctx: ModuleContext): void {
  layer ??= new DimensionLayer(ctx)
}

const v = (p: [number, number, number]): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2])

class DimensionLayer {
  private group = new THREE.Group()
  private labels = new Map<string, { el: HTMLElement; dim: Dimension }>()
  private selected: string | null = null
  private drag: { id: string; from: [number, number, number]; plane: THREE.Plane; moved: boolean; x: number; y: number } | null = null

  constructor(private ctx: ModuleContext) {
    const vp = ctx.viewport
    this.group.name = '__dims'
    this.group.renderOrder = 8
    vp.scene.add(this.group)
    ctx.doc.on('dims', () => this.redraw())
    ctx.doc.on('changed', () => this.redraw())
    vp.afterRender.add(() => this.place())
    vp.renderer.domElement.addEventListener('pointerdown', () => this.select(null))
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.selected || (e.key !== 'Delete' && e.key !== 'Backspace')) return
        const t = e.target as HTMLElement
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
        e.preventDefault()
        e.stopPropagation()
        const id = this.selected
        this.selected = null
        ctx.doc.removeDims([id])
      },
      true
    )
    window.addEventListener('pointermove', (e) => this.onDrag(e))
    window.addEventListener('pointerup', () => this.endDrag())
    this.redraw()
  }

  private visible(d: Dimension): boolean {
    if (!shown) return false
    // Hidden with the body it was taken from (ids from older sessions are ignored).
    return d.nodeIds.every((id) => {
      const n = this.ctx.doc.get(id)
      return !n || this.ctx.doc.isShown(n)
    })
  }

  redraw(): void {
    this.group.children.forEach((c) => {
      ;(c as THREE.LineSegments).geometry.dispose()
      ;((c as THREE.LineSegments).material as THREE.Material).dispose()
    })
    this.group.clear()
    const keep = new Set<string>()
    for (const d of this.ctx.doc.dims) {
      if (!this.visible(d)) continue
      keep.add(d.id)
      const color = d.id === this.selected ? SELECTED : COLOR
      const segs = geometryOf(d)
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(segs.lines, 3))
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }))
      lines.renderOrder = 8
      this.group.add(lines)
      if (segs.points.length) {
        const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(segs.points, 3))
        const pts = new THREE.Points(pg, dotMaterial(color, 8))
        pts.renderOrder = 8
        this.group.add(pts as unknown as THREE.LineSegments)
      }
      let lab = this.labels.get(d.id)
      if (!lab) {
        const e = el('div', 'dim-tag')
        e.addEventListener('pointerdown', (ev) => this.startDrag(ev, d.id))
        this.ctx.viewport.host.append(e)
        lab = { el: e, dim: d }
        this.labels.set(d.id, lab)
      }
      lab.dim = d
      lab.el.textContent = d.text
      lab.el.classList.toggle('selected', d.id === this.selected)
    }
    for (const [id, lab] of this.labels)
      if (!keep.has(id)) {
        lab.el.remove()
        this.labels.delete(id)
      }
    this.ctx.viewport.requestRender()
  }

  private place(): void {
    for (const { el: e, dim } of this.labels.values()) {
      const s = this.ctx.viewport.toScreen(v(dim.label))
      e.style.left = `${s.x}px`
      e.style.top = `${s.y}px`
    }
  }

  private select(id: string | null): void {
    if (this.selected === id) return
    this.selected = id
    this.redraw()
  }

  private startDrag(e: PointerEvent, id: string): void {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const d = this.ctx.doc.dims.find((x) => x.id === id)
    if (!d) return
    const cam = this.ctx.viewport.camera
    const normal = cam.getWorldDirection(new THREE.Vector3())
    this.drag = { id, from: [...d.label], plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, v(d.label)), moved: false, x: e.clientX, y: e.clientY }
    this.select(id)
  }

  private onDrag(e: PointerEvent): void {
    const dr = this.drag
    if (!dr) return
    if (!dr.moved && Math.hypot(e.clientX - dr.x, e.clientY - dr.y) < 3) return
    dr.moved = true
    const vp = this.ctx.viewport
    const ray = new THREE.Raycaster()
    ray.setFromCamera(vp.ndcOf(e), vp.camera)
    const p = new THREE.Vector3()
    if (!ray.ray.intersectPlane(dr.plane, p)) return
    const d = this.ctx.doc.dims.find((x) => x.id === dr.id)
    if (!d) return
    d.label = [p.x, p.y, p.z]
    this.redraw()
  }

  private endDrag(): void {
    const dr = this.drag
    this.drag = null
    if (!dr?.moved) return
    const d = this.ctx.doc.dims.find((x) => x.id === dr.id)
    if (d) this.ctx.doc.moveDimLabel(d.id, dr.from, [...d.label])
  }
}

/** Line segments (pairs of points) and marker points for a dimension. */
export function geometryOf(d: Dimension): { lines: number[]; points: number[] } {
  const lines: number[] = []
  const points: number[] = []
  const seg = (a: THREE.Vector3, b: THREE.Vector3): void => void lines.push(a.x, a.y, a.z, b.x, b.y, b.z)
  const pt = (a: THREE.Vector3): void => void points.push(a.x, a.y, a.z)
  const L = v(d.label)
  const P = d.points.map(v)
  if (d.type === 'distance') {
    const [a, b] = P
    if (!d.axis || d.axis === 'true') {
      const ab = b.clone().sub(a)
      const dir = ab.lengthSq() > 0 ? ab.clone().normalize() : new THREE.Vector3(1, 0, 0)
      const mid = a.clone().add(b).multiplyScalar(0.5)
      const off = L.clone().sub(mid)
      off.sub(dir.clone().multiplyScalar(off.dot(dir)))
      const a2 = a.clone().add(off)
      const b2 = b.clone().add(off)
      seg(a, a2)
      seg(b, b2)
      seg(a2, b2)
      // Extend to the label if it was dragged past an end.
      const t = L.clone().sub(a2).dot(dir)
      if (t < 0) seg(a2, a2.clone().add(dir.clone().multiplyScalar(t)))
      if (t > ab.length()) seg(b2, a2.clone().add(dir.clone().multiplyScalar(t)))
      pt(a2)
      pt(b2)
    } else {
      const m = datums.get(d.datumId ?? 'world').matrix
      const u = new THREE.Vector3(d.axis === 'x' ? 1 : 0, d.axis === 'y' ? 1 : 0, d.axis === 'z' ? 1 : 0).transformDirection(m)
      const t = b.clone().sub(a).dot(u)
      const w = L.clone().sub(a)
      w.sub(u.clone().multiplyScalar(w.dot(u)))
      const a2 = a.clone().add(w)
      const b2 = a2.clone().add(u.clone().multiplyScalar(t))
      // Extension from b runs parallel to the offset, to meet the dimension line.
      seg(a, a2)
      seg(b, b2)
      seg(a2, b2)
      pt(a2)
      pt(b2)
    }
  } else if (d.type === 'diameter' || d.type === 'radius') {
    const [c, r] = P
    pt(c)
    if (d.type === 'diameter') {
      const r2 = c.clone().multiplyScalar(2).sub(r)
      seg(r, r2)
      pt(r)
      pt(r2)
      seg(L.distanceTo(r) < L.distanceTo(r2) ? r : r2, L)
    } else {
      seg(c, r)
      pt(r)
      seg(r, L)
    }
  } else if (d.type === 'angle') {
    const [o, e1, e2] = P
    seg(o, e1)
    seg(o, e2)
    const d1 = e1.clone().sub(o).normalize()
    const d2 = e2.clone().sub(o).normalize()
    const rad = Math.max(1e-6, L.distanceTo(o))
    const ang = d1.angleTo(d2)
    const axis = new THREE.Vector3().crossVectors(d1, d2)
    if (axis.lengthSq() > 1e-12) {
      axis.normalize()
      const n = 32
      let prev = o.clone().add(d1.clone().multiplyScalar(rad))
      for (let i = 1; i <= n; i++) {
        const p = o.clone().add(d1.clone().applyAxisAngle(axis, (ang * i) / n).multiplyScalar(rad))
        seg(prev, p)
        prev = p
      }
    }
  } else {
    const [p] = P
    pt(p)
    seg(p, L)
  }
  return { lines, points }
}
