import * as THREE from 'three'
import { Emitter } from './events'
import type { Viewport } from './viewport'

/** What a click in the viewport picks (Query > Select). Several can be on; the most precise wins. */
export interface SelectFilter {
  vertex: boolean
  edge: boolean
  face: boolean
  body: boolean
}

class FilterState extends Emitter<{ changed: SelectFilter }> {
  value: SelectFilter = { vertex: true, edge: true, face: true, body: false }
  toggle(k: keyof SelectFilter): void {
    this.value = { ...this.value, [k]: !this.value[k] }
    // Keep at least one on.
    if (!Object.values(this.value).some(Boolean)) this.value[k] = true
    this.emit('changed', this.value)
  }
}
export const selectFilter = new FilterState()

export type PickKind = 'body' | 'face' | 'edge' | 'vertex' | 'point'

/** A picked piece of the model: a whole body, one of its CAD faces / edges / vertices, or a point on a mesh. */
export interface Pick {
  kind: PickKind
  /** The body's object (Mesh, or LineSegments for wireframe bodies). */
  object: THREE.Object3D
  /** Face / edge / vertex index in the body's B-rep; -1 otherwise. */
  index: number
  /** World point: the vertex, or where the pointer hit. */
  point: THREE.Vector3
}

export const pickKey = (p: Pick): string => `${p.object.uuid}:${p.kind}:${p.index}:${p.kind === 'point' ? p.point.toArray().join(',') : ''}`

/** Row-major 3x4 of a matrix, as the CAD kernel takes placements. */
export function rowMajor(m: THREE.Matrix4): number[] {
  const e = m.elements
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]]
}

const VERTEX_PX = 8
const EDGE_PX = 7

/** Finds the face / edge / vertex under the pointer, honouring the select filter. */
export function pickAt(vp: Viewport, e: { clientX: number; clientY: number }, filter = selectFilter.value): Pick | null {
  const hit = vp.hitTest(vp.ndcOf(e))
  if (!hit) return null
  const obj = hit.object
  const geo = (obj as THREE.Mesh).geometry
  if (!geo) return null
  const rect = vp.renderer.domElement.getBoundingClientRect()
  const mouse = new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top)
  obj.updateMatrixWorld()
  const mw = obj.matrixWorld
  const cam = vp.camera
  const viewDir = cam.getWorldDirection(new THREE.Vector3())
  const depth = (p: THREE.Vector3): number => p.clone().sub(cam.position).dot(viewDir)
  // Things behind the surface under the pointer can't be picked.
  const hitDepth = depth(hit.point) + vp.nav.pose.dist * 0.01
  const isWire = !!(obj as THREE.LineSegments).isLineSegments
  const brep = !!geo.userData.brep

  const tmp = new THREE.Vector3()
  const screenOf = (x: number, y: number, z: number): { s: THREE.Vector2; w: THREE.Vector3 } => {
    const w = tmp.set(x, y, z).applyMatrix4(mw).clone()
    return { s: vp.toScreen(w), w }
  }

  if (filter.vertex) {
    const verts = geo.userData.vertices as Float32Array | undefined
    let best: THREE.Vector3 | null = null
    let bestIndex = -1
    let bestD = VERTEX_PX
    if (verts) {
      for (let i = 0; i < verts.length / 3; i++) {
        const { s, w } = screenOf(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2])
        const d = s.distanceTo(mouse)
        if (d < bestD && depth(w) <= hitDepth) {
          bestD = d
          best = w
          bestIndex = i
        }
      }
      if (best) return { kind: 'vertex', object: obj, index: bestIndex, point: best }
    } else if (!brep && hit.face) {
      // Plain mesh: snap to a corner of the triangle under the pointer.
      const pos = geo.getAttribute('position') as THREE.BufferAttribute
      for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
        const { s, w } = screenOf(pos.getX(i), pos.getY(i), pos.getZ(i))
        const d = s.distanceTo(mouse)
        if (d < bestD) {
          bestD = d
          best = w
        }
      }
      if (best) return { kind: 'point', object: obj, index: -1, point: best }
    }
  }

  if (filter.edge) {
    const segs = (geo.userData.edgePositions as Float32Array | undefined) ?? (isWire ? (geo.getAttribute('position').array as Float32Array) : undefined)
    const ranges = geo.userData.edgeRanges as Uint32Array | undefined
    if (segs && ranges) {
      let bestSeg = -1
      let bestD = EDGE_PX
      let bestPoint = new THREE.Vector3()
      const ab = new THREE.Vector2()
      const am = new THREE.Vector2()
      for (let i = 0; i < segs.length / 6; i++) {
        const a = screenOf(segs[i * 6], segs[i * 6 + 1], segs[i * 6 + 2])
        const b = screenOf(segs[i * 6 + 3], segs[i * 6 + 4], segs[i * 6 + 5])
        ab.subVectors(b.s, a.s)
        am.subVectors(mouse, a.s)
        const len2 = ab.lengthSq()
        const t = len2 > 0 ? Math.max(0, Math.min(1, am.dot(ab) / len2)) : 0
        const d = am.sub(ab.clone().multiplyScalar(t)).length()
        if (d >= bestD) continue
        const w = a.w.clone().lerp(b.w, t)
        if (depth(w) > hitDepth) continue
        bestD = d
        bestSeg = i
        bestPoint = w
      }
      if (bestSeg >= 0) {
        // Which CAD edge owns that segment.
        for (let k = 0; k < ranges.length / 2; k++) {
          if (bestSeg >= ranges[k * 2] && bestSeg < ranges[k * 2] + ranges[k * 2 + 1])
            return { kind: 'edge', object: obj, index: k, point: bestPoint }
        }
      }
    }
  }

  if (filter.face && !isWire) {
    const triFace = geo.userData.triFace as Int32Array | undefined
    if (triFace && hit.faceIndex != null && triFace[hit.faceIndex] >= 0)
      return { kind: 'face', object: obj, index: triFace[hit.faceIndex], point: hit.point.clone() }
    if (!brep && !filter.body) return { kind: 'body', object: obj, index: -1, point: hit.point.clone() }
  }

  if (filter.body || (isWire && !geo.userData.edgeRanges)) return { kind: 'body', object: obj, index: -1, point: hit.point.clone() }
  return null
}

/** Coloured overlays showing picked / hovered items. */
export class Highlights {
  readonly group = new THREE.Group()
  private cache = new Map<string, THREE.Object3D>()

  constructor(private vp: Viewport) {
    this.group.name = '__overlay'
    this.group.renderOrder = 10
    vp.scene.add(this.group)
  }

  set(picks: { pick: Pick; color: number }[]): void {
    this.group.clear()
    for (const { pick, color } of picks) {
      const key = `${pickKey(pick)}:${color}`
      let o = this.cache.get(key)
      if (!o) {
        o = build(pick, color)
        this.cache.set(key, o)
      }
      if (pick.kind !== 'vertex' && pick.kind !== 'point') {
        pick.object.updateMatrixWorld()
        o.matrixAutoUpdate = false
        o.matrix.copy(pick.object.matrixWorld)
        o.matrixWorldNeedsUpdate = true
      }
      this.group.add(o)
    }
    this.vp.requestRender()
  }

  dispose(): void {
    this.vp.scene.remove(this.group)
    for (const o of this.cache.values())
      o.traverse((c) => {
        const m = c as THREE.Mesh
        if (m.geometry && !m.userData.shared) m.geometry.dispose()
        ;(m.material as THREE.Material | undefined)?.dispose?.()
      })
    this.cache.clear()
    this.vp.requestRender()
  }
}

function build(pick: Pick, color: number): THREE.Object3D {
  const geo = (pick.object as THREE.Mesh).geometry
  if (pick.kind === 'vertex' || pick.kind === 'point') {
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pick.point.toArray(), 3))
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 11, sizeAttenuation: false, depthTest: false }))
    p.renderOrder = 12
    return p
  }
  if (pick.kind === 'edge') {
    const segs = (geo.userData.edgePositions as Float32Array | undefined) ?? (geo.getAttribute('position').array as Float32Array)
    const ranges = geo.userData.edgeRanges as Uint32Array
    const first = ranges[pick.index * 2]
    const count = ranges[pick.index * 2 + 1]
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(segs.slice(first * 6, (first + count) * 6), 3))
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }))
    l.renderOrder = 11
    return l
  }
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false })
  if (pick.kind === 'face') {
    const triFace = geo.userData.triFace as Int32Array
    const index = geo.index!
    const ids: number[] = []
    for (let t = 0; t < triFace.length; t++) if (triFace[t] === pick.index) ids.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2))
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', geo.getAttribute('position'))
    g.setIndex(ids)
    const m = new THREE.Mesh(g, mat)
    m.renderOrder = 10
    return m
  }
  if ((pick.object as THREE.LineSegments).isLineSegments) {
    const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false }))
    l.userData.shared = true
    return l
  }
  const m = new THREE.Mesh(geo, mat)
  m.userData.shared = true
  return m
}
