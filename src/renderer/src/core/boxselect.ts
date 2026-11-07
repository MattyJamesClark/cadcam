import * as THREE from 'three'
import type { CadDocument } from './document'
import type { Viewport } from './viewport'
import { isSheet, type Pick, type SelectFilter } from './picking'
import { el } from './toolpanel'

/**
 * Box selection, shared by plain selection and by every
 * command that asks for a set of items. Drag left to right: only items wholly
 * inside the box. Drag right to left (dashed box): anything the box touches.
 * Hidden items are skipped; items behind others are still taken.
 */

export interface ScreenRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The rubber-band rectangle drawn while dragging. */
export class BoxRubber {
  private box: HTMLElement
  constructor(
    private vp: Viewport,
    readonly x: number,
    readonly y: number
  ) {
    this.box = el('div', 'sk-box')
    this.box.hidden = true
    vp.host.append(this.box)
  }
  /** Has the pointer moved far enough to count as a drag rather than a click? */
  static isDrag(dx: number, dy: number): boolean {
    return Math.hypot(dx, dy) > 4
  }
  update(clientX: number, clientY: number): void {
    const r = this.vp.host.getBoundingClientRect()
    this.box.hidden = false
    Object.assign(this.box.style, {
      left: `${Math.min(this.x, clientX) - r.left}px`,
      top: `${Math.min(this.y, clientY) - r.top}px`,
      width: `${Math.abs(clientX - this.x)}px`,
      height: `${Math.abs(clientY - this.y)}px`
    })
    this.box.classList.toggle('crossing', clientX < this.x)
  }
  /** Canvas-pixel rectangle and whether it is a crossing box. */
  rect(clientX: number, clientY: number): { rect: ScreenRect; crossing: boolean } {
    const r = this.vp.renderer.domElement.getBoundingClientRect()
    return {
      rect: {
        minX: Math.min(this.x, clientX) - r.left,
        maxX: Math.max(this.x, clientX) - r.left,
        minY: Math.min(this.y, clientY) - r.top,
        maxY: Math.max(this.y, clientY) - r.top
      },
      crossing: clientX < this.x
    }
  }
  dispose(): void {
    this.box.remove()
  }
}

/** Projects object-space points to canvas pixels quickly (one matrix, no allocations per point). */
class Projector {
  private m = new THREE.Matrix4()
  private w: number
  private h: number
  constructor(vp: Viewport, obj: THREE.Object3D) {
    const cam = vp.camera
    cam.updateMatrixWorld()
    obj.updateMatrixWorld()
    this.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(obj.matrixWorld)
    this.w = vp.renderer.domElement.clientWidth
    this.h = vp.renderer.domElement.clientHeight
  }
  /** Writes pixel x / y into out; false if the point is behind the camera. */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const e = this.m.elements
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15]
    if (cw <= 1e-9) return false
    const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw
    const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw
    out.x = ((cx + 1) / 2) * this.w
    out.y = ((1 - cy) / 2) * this.h
    return true
  }
}

const inRect = (r: ScreenRect, p: { x: number; y: number }): boolean => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY

/** Does the 2D segment a-b cross or touch the rectangle? */
function segmentHitsRect(r: ScreenRect, ax: number, ay: number, bx: number, by: number): boolean {
  // Liang-Barsky clip.
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  const edges: [number, number][] = [
    [-dx, ax - r.minX],
    [dx, r.maxX - ax],
    [-dy, ay - r.minY],
    [dy, r.maxY - ay]
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return true
}

/**
 * Are all / any of these points inside? `pts` are object-space xyz triples,
 * `ids` optionally picks which of them to test.
 */
function testPoints(pr: Projector, r: ScreenRect, pts: ArrayLike<number>, crossing: boolean, ids?: Iterable<number>): boolean {
  const s = { x: 0, y: 0 }
  const list = ids ?? range(pts.length / 3)
  let any = false
  for (const i of list) {
    const ok = pr.project(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], s) && inRect(r, s)
    if (crossing && ok) return true
    if (!crossing && !ok) return false
    any = true
  }
  return crossing ? false : any
}

function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i
}

/** Segments (xyz xyz) crossing the box, between first and first+count. */
function segmentsCross(pr: Projector, r: ScreenRect, segs: ArrayLike<number>, first = 0, count = segs.length / 6): boolean {
  const a = { x: 0, y: 0 }
  const b = { x: 0, y: 0 }
  for (let i = first; i < first + count; i++) {
    const k = i * 6
    if (!pr.project(segs[k], segs[k + 1], segs[k + 2], a) || !pr.project(segs[k + 3], segs[k + 4], segs[k + 5], b)) continue
    if (segmentHitsRect(r, a.x, a.y, b.x, b.y)) return true
  }
  return false
}

/** Screen rectangle of the object's bounding box, or null if it is (partly) behind the camera. */
function screenBounds(vp: Viewport, obj: THREE.Object3D, geo: THREE.BufferGeometry): ScreenRect | null {
  if (!geo.boundingBox) geo.computeBoundingBox()
  const b = geo.boundingBox!
  const pr = new Projector(vp, obj)
  const out: ScreenRect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const s = { x: 0, y: 0 }
  for (let i = 0; i < 8; i++) {
    if (!pr.project(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z, s)) return null
    out.minX = Math.min(out.minX, s.x)
    out.maxX = Math.max(out.maxX, s.x)
    out.minY = Math.min(out.minY, s.y)
    out.maxY = Math.max(out.maxY, s.y)
  }
  return out
}

const contains = (outer: ScreenRect, inner: ScreenRect): boolean =>
  inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY
const overlaps = (a: ScreenRect, b: ScreenRect): boolean => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

/** The visible body objects of the document, with their geometry. */
function shownBodies(doc: CadDocument): { id: string; obj: THREE.Object3D; geo: THREE.BufferGeometry }[] {
  const out: { id: string; obj: THREE.Object3D; geo: THREE.BufferGeometry }[] = []
  for (const n of doc.bodies()) {
    if (!doc.isShown(n)) continue
    const geo = (n.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (!geo?.getAttribute('position')) continue
    out.push({ id: n.id, obj: n.object, geo })
  }
  return out
}

/** Is the whole body inside (window) / touched by (crossing) the box? */
function bodyInBox(vp: Viewport, obj: THREE.Object3D, geo: THREE.BufferGeometry, r: ScreenRect, crossing: boolean): boolean {
  const sb = screenBounds(vp, obj, geo)
  if (sb && contains(r, sb)) return true
  if (sb && !overlaps(r, sb)) return false
  const pr = new Projector(vp, obj)
  const pos = geo.getAttribute('position').array as ArrayLike<number>
  if (!crossing) return testPoints(pr, r, pos, false)
  if (testPoints(pr, r, pos, true)) return true
  const segs = (geo.userData.edgePositions as Float32Array | undefined) ?? ((obj as THREE.LineSegments).isLineSegments ? pos : undefined)
  if (segs && segmentsCross(pr, r, segs)) return true
  // A face bigger than the box, with no corner or edge in it: is the box over the body?
  if ((obj as THREE.Mesh).isMesh) {
    const ndc = new THREE.Vector2()
    const el = vp.renderer.domElement
    ndc.set((((r.minX + r.maxX) / 2) / el.clientWidth) * 2 - 1, -(((r.minY + r.maxY) / 2) / el.clientHeight) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, vp.camera)
    if (ray.intersectObject(obj, false).length) return true
  }
  return false
}

/**
 * What the box takes, honouring the selection filter: whole bodies / surfaces
 * when those are on, otherwise the points, edges or faces inside it.
 */
export function boxSelect(vp: Viewport, doc: CadDocument, r: ScreenRect, crossing: boolean, f: SelectFilter): { bodies: string[]; subs: Pick[] } {
  const bodies: string[] = []
  const subs: Pick[] = []
  for (const { id, obj, geo } of shownBodies(doc)) {
    const sheet = isSheet(obj)
    const wire = !!(obj as THREE.LineSegments).isLineSegments
    const brep = !!geo.userData.brep
    if (sheet ? f.surface : f.body) {
      if (bodyInBox(vp, obj, geo, r, crossing)) bodies.push(id)
      continue
    }
    const sb = screenBounds(vp, obj, geo)
    if (sb && !overlaps(r, sb)) continue
    // A plain mesh (STL...) or a loose wireframe has no faces / edges of its own: take it whole.
    if ((!brep && !wire && (f.face || f.edge)) || (wire && !geo.userData.edgeRanges && (f.edge || f.body))) {
      if (bodyInBox(vp, obj, geo, r, crossing)) bodies.push(id)
      continue
    }
    const pr = new Projector(vp, obj)
    const s = { x: 0, y: 0 }
    const world = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).applyMatrix4(obj.matrixWorld)
    if (f.vertex) {
      const v = geo.userData.vertices as Float32Array | undefined
      if (v)
        for (let i = 0; i < v.length / 3; i++)
          if (pr.project(v[i * 3], v[i * 3 + 1], v[i * 3 + 2], s) && inRect(r, s))
            subs.push({ kind: 'vertex', object: obj, index: i, point: world(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]) })
    }
    if (f.edge) {
      const segs = (geo.userData.edgePositions as Float32Array | undefined) ?? (wire ? (geo.getAttribute('position').array as Float32Array) : undefined)
      const ranges = geo.userData.edgeRanges as Uint32Array | undefined
      if (segs && ranges)
        for (let k = 0; k < ranges.length / 2; k++) {
          const first = ranges[k * 2]
          const count = ranges[k * 2 + 1]
          if (!count) continue
          // Window: both ends of every segment inside. Crossing: any segment touching.
          const hit = crossing
            ? segmentsCross(pr, r, segs, first, count)
            : testPoints(pr, r, segs, false, edgePointIds(first, count))
          if (hit) {
            const m = (first + Math.floor(count / 2)) * 6
            subs.push({ kind: 'edge', object: obj, index: k, point: world(segs[m], segs[m + 1], segs[m + 2]) })
          }
        }
    }
    if (f.face && !wire) {
      const triFace = geo.userData.triFace as Int32Array | undefined
      const index = geo.index
      if (triFace && index) {
        const pos = geo.getAttribute('position').array as ArrayLike<number>
        const faces = new Map<number, number[]>()
        for (let t = 0; t < triFace.length; t++) {
          const fi = triFace[t]
          if (fi < 0) continue
          let list = faces.get(fi)
          if (!list) faces.set(fi, (list = []))
          list.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2))
        }
        // Faces turned away from the view are the far side of the body: not taken.
        const view = vp.camera.getWorldDirection(new THREE.Vector3()).transformDirection(new THREE.Matrix4().copy(obj.matrixWorld).invert())
        const va = new THREE.Vector3()
        const vb = new THREE.Vector3()
        const vc = new THREE.Vector3()
        const facing = (ids: number[]): boolean => {
          for (let j = 0; j < ids.length; j += 3) {
            va.fromArray(pos as number[], ids[j] * 3)
            vb.fromArray(pos as number[], ids[j + 1] * 3).sub(va)
            vc.fromArray(pos as number[], ids[j + 2] * 3).sub(va)
            if (vb.cross(vc).dot(view) < 0) return true
          }
          return false
        }
        for (const [fi, ids] of faces) {
          if (!facing(ids)) continue
          let hit = testPoints(pr, r, pos, crossing, ids)
          // Crossing a big face with no corner inside: any of its triangle edges through the box.
          if (!hit && crossing) {
            const a = { x: 0, y: 0 }
            const b = { x: 0, y: 0 }
            for (let j = 0; j < ids.length && !hit; j += 3)
              for (let e = 0; e < 3 && !hit; e++) {
                const p = ids[j + e]
                const q = ids[j + ((e + 1) % 3)]
                if (pr.project(pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2], a) && pr.project(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2], b))
                  hit = segmentHitsRect(r, a.x, a.y, b.x, b.y)
              }
          }
          if (hit) {
            const p = ids[0]
            subs.push({ kind: 'face', object: obj, index: fi, point: world(pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2]) })
          }
        }
      }
    }
  }
  return { bodies, subs }
}

/** Point ids (in a segment list) of the segments first..first+count. */
function edgePointIds(first: number, count: number): number[] {
  const ids: number[] = []
  for (let i = first; i < first + count; i++) ids.push(i * 2, i * 2 + 1)
  return ids
}
