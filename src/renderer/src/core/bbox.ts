import * as THREE from 'three'
import type { ModuleContext } from './types'
import { datums } from './datums'
import { boundsCad } from './occt'
import { rowMajor } from './picking'
import { el, fmt, resultRows, segmented, toolPanel } from './toolpanel'

/**
 * Bounding box of the selection (or everything shown), in a datum's frame:
 * rectangular (X/Y/Z sizes) or cylindrical about the datum's Z axis (stock
 * diameter and length). Updates as the selection changes.
 */

type Shape = 'rect' | 'cyl'
let active: BoundingBoxTool | null = null

export function openBoundingBox(ctx: ModuleContext): void {
  if (active) return
  active = new BoundingBoxTool(ctx)
}
export const isBoundingBoxOpen = (): boolean => !!active

interface Result {
  min: THREE.Vector3
  max: THREE.Vector3
  exact: boolean
  /** Cylindrical: centre (datum X, Y) and radius about datum Z. */
  circle?: { x: number; y: number; r: number }
}

class BoundingBoxTool {
  private shape: Shape = 'rect'
  private datumId = 'world'
  private panel: HTMLElement
  private sub: HTMLElement
  private resultBox = el('div')
  private outline = new THREE.Group()
  private off: (() => void)[] = []
  private run = 0
  private last: Result | null = null

  constructor(private ctx: ModuleContext) {
    const p = toolPanel('Bounding box', () => this.close())
    this.panel = p.panel
    this.panel.classList.add('wide')
    this.sub = p.sub
    p.body.append(
      field('Shape', segmented<Shape>([['rect', 'Rectangular'], ['cyl', 'Cylindrical']], this.shape, (v) => ((this.shape = v), void this.update()))),
      field('Relative to', this.datumSelect()),
      this.resultBox
    )
    const copy = el('button', 'btn', 'Copy sizes')
    copy.title = 'Copy the sizes to the clipboard'
    copy.addEventListener('click', () => void this.copySizes())
    const buttons = el('div', 'tool-buttons')
    buttons.append(copy)
    p.body.append(buttons)
    ctx.viewport.host.appendChild(this.panel)
    this.outline.name = '__bbox'
    ctx.viewport.scene.add(this.outline)

    this.off.push(ctx.doc.on('selection', () => void this.update()))
    this.off.push(ctx.doc.history.on('changed', () => void this.update()))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      this.close()
    }
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => window.removeEventListener('keydown', onKey, true))
    ctx.refreshRibbon()
    void this.update()
  }

  private datumSelect(): HTMLSelectElement {
    const select = el('select')
    for (const d of datums.list()) {
      const o = el('option', '', d.name)
      o.value = d.id
      select.append(o)
    }
    select.value = this.datumId
    select.addEventListener('change', () => {
      this.datumId = select.value
      void this.update()
    })
    return select
  }

  /** Visible bodies of the selection, or of everything if nothing is selected. */
  private bodies(): THREE.Object3D[] {
    const doc = this.ctx.doc
    const sel = doc.selectedTopNodes()
    const roots = sel.length ? sel.map((n) => n.object) : doc.roots.filter((n) => doc.isShown(n)).map((n) => n.object)
    this.sub.textContent = sel.length ? (sel.length === 1 ? sel[0].name : `${sel.length} items`) : 'Everything shown'
    const out: THREE.Object3D[] = []
    const visit = (o: THREE.Object3D): void => {
      if (!o.visible || o.name === '__edges') return
      const g = (o as THREE.Mesh).geometry
      if (g && ((o as THREE.Mesh).isMesh || (o as THREE.LineSegments).isLineSegments || (o as THREE.Points).isPoints)) out.push(o)
      o.children.forEach(visit)
    }
    roots.forEach(visit)
    return out
  }

  private async update(): Promise<void> {
    const run = ++this.run
    const bodies = this.bodies()
    if (!bodies.length) {
      this.last = null
      this.resultBox.replaceChildren(el('div', 'tool-empty', 'Nothing to measure.'))
      this.drawOutline(null)
      return
    }
    this.ctx.doc.root.updateMatrixWorld(true)
    const inv = datums.inverse(this.datumId)
    const toDatum = (o: THREE.Object3D): THREE.Matrix4 => inv.clone().multiply(o.matrixWorld)

    // Points of every body in the datum frame (mesh vertices + sampled CAD edges).
    const pts: number[] = []
    const v = new THREE.Vector3()
    for (const o of bodies) {
      const m = toDatum(o)
      const g = (o as THREE.Mesh).geometry
      for (const arr of [g.getAttribute('position')?.array, g.userData.edgePositions] as (ArrayLike<number> | undefined)[]) {
        if (!arr) continue
        for (let i = 0; i + 2 < arr.length; i += 3) {
          v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(m)
          pts.push(v.x, v.y, v.z)
        }
      }
    }
    const min = new THREE.Vector3(Infinity, Infinity, Infinity)
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    for (let i = 0; i < pts.length; i += 3) {
      v.set(pts[i], pts[i + 1], pts[i + 2])
      min.min(v)
      max.max(v)
    }
    let res: Result = { min, max, exact: false }
    // Exact box from the CAD kernel when every body has its B-rep.
    if (bodies.every((o) => (o as THREE.Mesh).geometry.userData.brep)) {
      try {
        const b = await boundsCad(bodies.map((o) => ({ brep: (o as THREE.Mesh).geometry.userData.brep as Uint8Array, matrix: rowMajor(toDatum(o)) })))
        res = { min: new THREE.Vector3(...b.min), max: new THREE.Vector3(...b.max), exact: true }
      } catch {
        /* keep the mesh-based box */
      }
    }
    if (run !== this.run) return
    if (this.shape === 'cyl') res.circle = enclosingCircle(pts)
    this.last = res
    this.show(res)
    this.drawOutline(res)
  }

  private show(r: Result): void {
    const size = r.max.clone().sub(r.min)
    const c = r.min.clone().add(r.max).multiplyScalar(0.5)
    const rows: [string, string | null][] = []
    if (this.shape === 'rect') {
      rows.push(['Size', null], ['X', fmt(size.x)], ['Y', fmt(size.y)], ['Z', fmt(size.z)])
      rows.push(['Position', null], ['Min X, Y, Z', `${fmt(r.min.x)}, ${fmt(r.min.y)}, ${fmt(r.min.z)}`], ['Max X, Y, Z', `${fmt(r.max.x)}, ${fmt(r.max.y)}, ${fmt(r.max.z)}`], ['Centre', `${fmt(c.x)}, ${fmt(c.y)}, ${fmt(c.z)}`])
    } else if (r.circle) {
      rows.push(['Size (axis along Z)', null], ['Diameter', fmt(r.circle.r * 2)], ['Length', fmt(size.z)])
      rows.push(['Position', null], ['Axis at X, Y', `${fmt(r.circle.x)}, ${fmt(r.circle.y)}`], ['Z from / to', `${fmt(r.min.z)} / ${fmt(r.max.z)}`])
    }
    const note = el('div', 'tool-hint', r.exact || this.shape === 'cyl' ? (this.shape === 'cyl' ? 'Diameter from the display mesh (within the import quality).' : 'Exact, from the CAD geometry.') : 'From the display mesh (no exact geometry for some items).')
    this.resultBox.replaceChildren(resultRows(rows), note)
  }

  private drawOutline(r: Result | null): void {
    this.outline.children.forEach((c) => (c as THREE.LineSegments).geometry.dispose())
    this.outline.clear()
    if (r) {
      const p: number[] = []
      const seg = (a: number[], b: number[]): void => void p.push(...a, ...b)
      if (this.shape === 'rect') {
        const [x0, y0, z0] = r.min.toArray()
        const [x1, y1, z1] = r.max.toArray()
        const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        for (let i = 0; i < 4; i++) {
          const [ax, ay] = c[i]
          const [bx, by] = c[(i + 1) % 4]
          seg([ax, ay, z0], [bx, by, z0])
          seg([ax, ay, z1], [bx, by, z1])
          seg([ax, ay, z0], [ax, ay, z1])
        }
      } else if (r.circle) {
        const { x, y, r: rad } = r.circle
        const n = 96
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2
          const b = ((i + 1) / n) * Math.PI * 2
          for (const z of [r.min.z, r.max.z]) seg([x + rad * Math.cos(a), y + rad * Math.sin(a), z], [x + rad * Math.cos(b), y + rad * Math.sin(b), z])
        }
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2
          seg([x + rad * Math.cos(a), y + rad * Math.sin(a), r.min.z], [x + rad * Math.cos(a), y + rad * Math.sin(a), r.max.z])
        }
        seg([x, y, r.min.z], [x, y, r.max.z])
      }
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85, depthTest: false }))
      lines.renderOrder = 9
      // Drawn in the datum's frame.
      lines.matrixAutoUpdate = false
      lines.matrix.copy(datums.get(this.datumId).matrix)
      this.outline.add(lines)
    }
    this.ctx.viewport.requestRender()
  }

  private async copySizes(): Promise<void> {
    const r = this.last
    if (!r) return
    const s = r.max.clone().sub(r.min)
    const text = this.shape === 'cyl' && r.circle ? `Ø${fmt(r.circle.r * 2)} × ${fmt(s.z)}` : `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}`
    try {
      await navigator.clipboard.writeText(text)
      this.ctx.status(`Copied ${text}`, 'success')
    } catch {
      this.ctx.status(text)
    }
  }

  close(): void {
    if (active !== this) return
    active = null
    this.off.forEach((f) => f())
    this.drawOutline(null)
    this.ctx.viewport.scene.remove(this.outline)
    this.panel.remove()
    this.ctx.refreshRibbon()
  }
}

export function closeBoundingBox(): void {
  active?.close()
}

function field(label: string, control: HTMLElement): HTMLElement {
  const f = el('label', 'tool-field')
  f.append(el('span', '', label), control)
  return f
}

/** Smallest circle around the points' X, Y (Welzl-style, expected linear time). */
function enclosingCircle(pts: number[]): { x: number; y: number; r: number } {
  const n = pts.length / 3
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  // Drop duplicates cheaply by rounding, then shuffle.
  const seen = new Set<string>()
  let m = 0
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pts[i * 3] * 1e4)},${Math.round(pts[i * 3 + 1] * 1e4)}`
    if (seen.has(k)) continue
    seen.add(k)
    xs[m] = pts[i * 3]
    ys[m] = pts[i * 3 + 1]
    m++
  }
  for (let i = m - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[xs[i], xs[j]] = [xs[j], xs[i]]
    ;[ys[i], ys[j]] = [ys[j], ys[i]]
  }
  const inside = (c: { x: number; y: number; r: number }, i: number): boolean => Math.hypot(xs[i] - c.x, ys[i] - c.y) <= c.r * (1 + 1e-12) + 1e-9
  const two = (i: number, j: number) => ({ x: (xs[i] + xs[j]) / 2, y: (ys[i] + ys[j]) / 2, r: Math.hypot(xs[i] - xs[j], ys[i] - ys[j]) / 2 })
  const three = (i: number, j: number, k: number) => {
    const ax = xs[i], ay = ys[i], bx = xs[j], by = ys[j], cx = xs[k], cy = ys[k]
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if (Math.abs(d) < 1e-12) {
      // Collinear: the widest pair.
      const c = [two(i, j), two(j, k), two(i, k)]
      return c.reduce((a, b) => (b.r > a.r ? b : a))
    }
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) }
  }
  if (m === 0) return { x: 0, y: 0, r: 0 }
  let c = { x: xs[0], y: ys[0], r: 0 }
  for (let i = 1; i < m; i++) {
    if (inside(c, i)) continue
    c = { x: xs[i], y: ys[i], r: 0 }
    for (let j = 0; j < i; j++) {
      if (inside(c, j)) continue
      c = two(i, j)
      for (let k = 0; k < j; k++) if (!inside(c, k)) c = three(i, j, k)
    }
  }
  return c
}
