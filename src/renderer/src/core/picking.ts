import * as THREE from 'three'
import { Emitter } from './events'
import type { Viewport } from './viewport'

/**
 * What a click in the viewport can pick (the selection filter on the bottom
 * bar). Several can be on; the most precise wins: point, then edge, then face,
 * then the whole body. Bodies are solids; surfaces are sheet (open) bodies.
 */
export interface SelectFilter {
  vertex: boolean
  edge: boolean
  face: boolean
  surface: boolean
  body: boolean
}
export const FILTER_KEYS: (keyof SelectFilter)[] = ['vertex', 'edge', 'face', 'surface', 'body']
export const EVERYTHING: SelectFilter = { vertex: true, edge: true, face: true, surface: true, body: true }
const FILTER_KEY = 'cadcam.selectFilter'

class FilterState extends Emitter<{ changed: SelectFilter }> {
  value: SelectFilter = load()
  toggle(k: keyof SelectFilter): void {
    const next = { ...this.value, [k]: !this.value[k] }
    // Keep at least one on.
    if (!Object.values(next).some(Boolean)) return
    this.set(next)
  }
  set(v: SelectFilter): void {
    this.value = { ...v }
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(this.value))
    } catch {
      /* ignore */
    }
    this.emit('changed', this.value)
  }
  isEverything(): boolean {
    return FILTER_KEYS.every((k) => this.value[k])
  }
}
function load(): SelectFilter {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as Partial<SelectFilter> | null
    if (v && FILTER_KEYS.some((k) => v[k])) return { ...EVERYTHING, ...v }
  } catch {
    /* ignore */
  }
  return { ...EVERYTHING }
}
export const selectFilter = new FilterState()

/** Is this body object a sheet (open surface) body rather than a solid? */
export const isSheet = (o: THREE.Object3D): boolean =>
  o.userData.cadKind === 'body' && o.userData.solid === false && !(o as THREE.LineSegments).isLineSegments

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
  /** For kind 'point' on CAD bodies: which snap point it is. */
  snap?: SnapKind
  /** For face picks: the surface normal where the pointer hit (world). */
  normal?: THREE.Vector3
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
export function pickAt(vp: Viewport, e: { clientX: number; clientY: number }, f: Partial<SelectFilter> = selectFilter.value): Pick | null {
  const filter: SelectFilter = { vertex: !!f.vertex, edge: !!f.edge, face: !!f.face, surface: !!f.surface, body: !!f.body }
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
      // Circle / arc centres and quadrants, line midpoints.
      const snaps = snapPoints(geo)
      let bestSnap = -1
      for (let i = 0; i < snaps.kinds.length; i++) {
        const { s, w } = screenOf(snaps.points[i * 3], snaps.points[i * 3 + 1], snaps.points[i * 3 + 2])
        const d = s.distanceTo(mouse)
        // Centres sit in the air: a hole's own wall may be in front of them.
        // A quadrant wins over a B-rep vertex at the same spot (a circle's seam).
        if (d < bestD + (bestIndex >= 0 ? 1 : 0) && (snaps.kinds[i] === 'centre' || depth(w) <= hitDepth)) {
          bestD = d
          best = w
          bestSnap = i
        }
      }
      if (best && bestSnap >= 0) return { kind: 'point', object: obj, index: -1, point: best, snap: snaps.kinds[bestSnap] }
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
      return { kind: 'face', object: obj, index: triFace[hit.faceIndex], point: hit.point.clone(), normal: hit.face ? hit.face.normal.clone().transformDirection(obj.matrixWorld) : undefined }
    // A plain mesh has no faces of its own: the face filter picks the whole mesh.
    if (!brep) return { kind: 'body', object: obj, index: -1, point: hit.point.clone() }
  }

  const sheet = isSheet(obj)
  if ((sheet ? filter.surface : filter.body) || (isWire && !geo.userData.edgeRanges && (filter.body || filter.edge)))
    return { kind: 'body', object: obj, index: -1, point: hit.point.clone() }
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
      // Geometry id too: after an edit replaces a body's shape, the same face number is a new face.
      const key = `${pickKey(pick)}:${(pick.object as THREE.Mesh).geometry?.uuid}:${color}`
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
    const p = new THREE.Points(g, dotMaterial(color, 12))
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

export type SnapKind = 'centre' | 'quadrant' | 'mid'

/**
 * Snap points of a CAD body, from its edges (cached on the geometry, in its
 * own coordinates): the centre and the 4 quadrant points of every circle and
 * arc (those on the arc), and the midpoint of every straight edge.
 */
export function snapPoints(geo: THREE.BufferGeometry): { points: Float32Array; kinds: SnapKind[] } {
  const cached = geo.userData.snaps as { points: Float32Array; kinds: SnapKind[] } | undefined
  if (cached) return cached
  const out: number[] = []
  const kinds: SnapKind[] = []
  const segs = geo.userData.edgePositions as Float32Array | undefined
  const ranges = geo.userData.edgeRanges as Uint32Array | undefined
  if (segs && ranges) {
    const at = (i: number): THREE.Vector3 => new THREE.Vector3(segs[i], segs[i + 1], segs[i + 2])
    // Lines joining two full circles are cylinder seams, not real edges: no midpoint.
    const lines: [THREE.Vector3, THREE.Vector3][] = []
    const seamEnds: THREE.Vector3[] = []
    for (let k = 0; k < ranges.length / 2; k++) {
      const first = ranges[k * 2]
      const count = ranges[k * 2 + 1]
      if (!count) continue
      const pts: THREE.Vector3[] = [at(first * 6)]
      for (let j = 0; j < count; j++) pts.push(at((first + j) * 6 + 3))
      if (count === 1) {
        lines.push([pts[0], pts[1]])
        continue
      }
      const circle = fitCircle(pts)
      const closedLoop = pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-12 * (1 + pts[0].lengthSq())
      // Arcs and open curves: the point halfway along.
      if (!closedLoop) {
        out.push(...halfway(pts).toArray())
        kinds.push('mid')
      }
      if (!circle) continue
      const { c, n, r, closed } = circle
      if (closed) seamEnds.push(pts[0])
      out.push(c.x, c.y, c.z)
      kinds.push('centre')
      // Quadrants measured from world X (or Y when X is along the axis).
      const u = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
      u.sub(n.clone().multiplyScalar(u.dot(n))).normalize()
      const v = new THREE.Vector3().crossVectors(n, u)
      for (let q = 0; q < 4; q++) {
        const a = (q * Math.PI) / 2
        const p = c.clone().add(u.clone().multiplyScalar(r * Math.cos(a))).add(v.clone().multiplyScalar(r * Math.sin(a)))
        if (!closed && !onPolyline(p, pts, r * 0.02 + 1e-6)) continue
        out.push(p.x, p.y, p.z)
        kinds.push('quadrant')
      }
    }
    const isSeamEnd = (p: THREE.Vector3): boolean => seamEnds.some((q) => q.distanceToSquared(p) < 1e-10 * (1 + p.lengthSq()))
    for (const [a, b] of lines) {
      if (isSeamEnd(a) && isSeamEnd(b)) continue
      out.push(...a.clone().add(b).multiplyScalar(0.5).toArray())
      kinds.push('mid')
    }
  }
  const res = { points: new Float32Array(out), kinds }
  geo.userData.snaps = res
  return res
}

/** Is this polyline a circle or an arc? Centre, axis, radius, and whether it closes. */
export function fitCircle(pts: THREE.Vector3[]): { c: THREE.Vector3; n: THREE.Vector3; r: number; closed: boolean } | null {
  const last = pts[pts.length - 1]
  const len = pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]) : 0), 0)
  if (len <= 0) return null
  const closed = pts[0].distanceTo(last) < len * 1e-4
  const m = pts.length - (closed ? 1 : 0)
  if (m < 3) return null
  const a = pts[0]
  const b = pts[Math.floor(m / 3)]
  const d = closed ? pts[Math.floor((2 * m) / 3)] : last
  const ab = b.clone().sub(a)
  const ad = d.clone().sub(a)
  const n = new THREE.Vector3().crossVectors(ab, ad)
  const n2 = n.lengthSq()
  if (n2 < 1e-20) return null
  // Circumcentre of a, b, d.
  const c = a
    .clone()
    .add(
      new THREE.Vector3()
        .crossVectors(n, ab)
        .multiplyScalar(ad.lengthSq())
        .add(new THREE.Vector3().crossVectors(ad, n).multiplyScalar(ab.lengthSq()))
        .divideScalar(2 * n2)
    )
  const r = c.distanceTo(a)
  if (!isFinite(r) || r <= 0) return null
  n.normalize()
  for (const p of pts) {
    if (Math.abs(p.distanceTo(c) - r) > r * 0.01 + 1e-6) return null
    if (Math.abs(p.clone().sub(c).dot(n)) > r * 0.01 + 1e-6) return null
  }
  return { c, n, r, closed }
}

function halfway(pts: THREE.Vector3[]): THREE.Vector3 {
  const lens = pts.map((p, i) => (i ? p.distanceTo(pts[i - 1]) : 0))
  let half = lens.reduce((a, b) => a + b, 0) / 2
  for (let i = 1; i < pts.length; i++) {
    if (half <= lens[i]) return pts[i - 1].clone().lerp(pts[i], lens[i] > 0 ? half / lens[i] : 0)
    half -= lens[i]
  }
  return pts[pts.length - 1].clone()
}

let dotTexture: THREE.Texture | null = null
/** Round point markers (plain points draw as squares). */
export function dotMaterial(color: number, size: number): THREE.PointsMaterial {
  if (!dotTexture) {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    g.beginPath()
    g.arc(32, 32, 26, 0, Math.PI * 2)
    g.fillStyle = '#fff'
    g.fill()
    g.lineWidth = 6
    g.strokeStyle = 'rgba(0,0,0,0.55)'
    g.stroke()
    dotTexture = new THREE.CanvasTexture(c)
    dotTexture.colorSpace = THREE.SRGBColorSpace
  }
  return new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, map: dotTexture, transparent: true, alphaTest: 0.3 })
}

function onPolyline(p: THREE.Vector3, pts: THREE.Vector3[], tol: number): boolean {
  const line = new THREE.Line3()
  const q = new THREE.Vector3()
  for (let i = 1; i < pts.length; i++) {
    line.set(pts[i - 1], pts[i])
    if (line.closestPointToPoint(p, true, q).distanceTo(p) <= tol) return true
  }
  return false
}
