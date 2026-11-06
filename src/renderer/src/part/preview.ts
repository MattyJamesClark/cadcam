import * as THREE from 'three'
import type { Region } from '@/sketch/profiles'
import type { P2 } from '@/sketch/geom'
import { toWorld, type SketchFrame } from './profile'

/**
 * Instant mesh previews for extrude / revolve / sweep, built in JS so they
 * follow a drag with no lag: every loop of the profile is carried through a
 * list of placements (straight out, round an axis, along a path) and joined
 * with bands, and the profile is capped at both ends. The exact kernel solid
 * replaces it once the drag stops.
 */

export interface Station {
  /** World placement of the profile here. */
  m: THREE.Matrix4
  /** Grow the profile outwards by this much (mm, negative shrinks): drafts. */
  grow?: number
}

/** Outward (out of the material) mitre direction at each point of a loop. */
function mitres(poly: P2[]): P2[] {
  const n = poly.length
  const out: P2[] = []
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n]
    const e1 = norm2([p1[0] - p0[0], p1[1] - p0[1]])
    const e2 = norm2([p2[0] - p1[0], p2[1] - p1[1]])
    // Right of the direction of travel is outside for anticlockwise outlines and clockwise holes.
    const n1: P2 = [e1[1], -e1[0]]
    const n2: P2 = [e2[1], -e2[0]]
    const s = 1 + n1[0] * n2[0] + n1[1] * n2[1]
    out.push(s < 0.05 ? n2 : [(n1[0] + n2[0]) / s, (n1[1] + n2[1]) / s])
  }
  return out
}
function norm2(v: P2): P2 {
  const l = Math.hypot(v[0], v[1]) || 1
  return [v[0] / l, v[1] / l]
}

/** Drop repeated points (the closing point and zero-length steps). */
function clean(poly: P2[]): P2[] {
  const out: P2[] = []
  for (const p of poly) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) out.push(p)
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-7) out.pop()
  return out
}

export function sweepMesh(frame: SketchFrame, regions: Region[], stations: Station[], opts: { capStart?: boolean; capEnd?: boolean } = {}): THREE.BufferGeometry {
  const pos: number[] = []
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => void pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  // Profile point i of a loop at a station, in the world.
  const place = (p: P2, mit: P2, st: Station): THREE.Vector3 => {
    const g = st.grow ?? 0
    return toWorld(frame, [p[0] + mit[0] * g, p[1] + mit[1] * g]).applyMatrix4(st.m)
  }
  for (const r of regions) {
    const loops = [r.outer, ...r.holes].map((l) => clean(l.poly))
    const mits = loops.map(mitres)
    // Bands.
    for (let L = 0; L < loops.length; L++) {
      const poly = loops[L], mit = mits[L]
      let prev = poly.map((p, i) => place(p, mit[i], stations[0]))
      for (let s = 1; s < stations.length; s++) {
        const cur = poly.map((p, i) => place(p, mit[i], stations[s]))
        for (let i = 0; i < poly.length; i++) {
          const j = (i + 1) % poly.length
          tri(prev[i], prev[j], cur[j])
          tri(prev[i], cur[j], cur[i])
        }
        prev = cur
      }
    }
    // Caps.
    const outer = loops[0]
    const holes = loops.slice(1)
    const faces = THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p[0], p[1])),
      holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])))
    )
    const flat = loops.flat()
    const flatMit = mits.flat()
    const cap = (st: Station, flip: boolean): void => {
      const w = flat.map((p, i) => place(p, flatMit[i], st))
      for (const [a, b, c] of faces) flip ? tri(w[a], w[c], w[b]) : tri(w[a], w[b], w[c])
    }
    if (opts.capStart !== false) cap(stations[0], true)
    if (opts.capEnd !== false) cap(stations[stations.length - 1], false)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.computeVertexNormals()
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

/** Stations for a straight extrude from `from` to `to` along the normal, with a draft (degrees, + narrows). */
export function extrudeStations(frame: SketchFrame, from: number, to: number, draft: number): Station[] {
  const t = Math.tan(THREE.MathUtils.degToRad(draft))
  const hs = from < 0 && to > 0 ? [from, 0, to] : [from, to]
  return hs.map((h) => ({ m: new THREE.Matrix4().makeTranslation(frame.normal.clone().multiplyScalar(h)), grow: -Math.abs(h) * t }))
}

/** Stations round an axis. */
export function revolveStations(origin: THREE.Vector3, axis: THREE.Vector3, angleDeg: number): Station[] {
  const n = Math.max(2, Math.min(120, Math.ceil(Math.abs(angleDeg) / 4)))
  const out: Station[] = []
  for (let i = 0; i <= n; i++) {
    const r = new THREE.Matrix4().makeRotationAxis(axis.clone().normalize(), THREE.MathUtils.degToRad((angleDeg * i) / n))
    out.push({ m: new THREE.Matrix4().makeTranslation(origin).multiply(r).multiply(new THREE.Matrix4().makeTranslation(origin.clone().negate())) })
  }
  return out
}

/**
 * Stations along a path: the profile keeps its place relative to the path,
 * carried with rotation-minimising frames (no twist), like the kernel's sweep.
 */
export function pathStations(poly: THREE.Vector3[]): Station[] {
  const pts = poly.filter((p, i) => i === 0 || p.distanceTo(poly[i - 1]) > 1e-7)
  if (pts.length < 2) return [{ m: new THREE.Matrix4() }]
  const tangent = (i: number): THREE.Vector3 => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    return b.clone().sub(a).normalize()
  }
  let t0 = tangent(0)
  let q = new THREE.Quaternion()
  const out: Station[] = [{ m: new THREE.Matrix4() }]
  for (let i = 1; i < pts.length; i++) {
    const t1 = tangent(i)
    q = new THREE.Quaternion().setFromUnitVectors(t0, t1).multiply(q)
    t0 = t1
    const m = new THREE.Matrix4()
      .makeTranslation(pts[i])
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
      .multiply(new THREE.Matrix4().makeTranslation(pts[0].clone().negate()))
    out.push({ m })
  }
  return out
}

/** A flat fill of regions on the sketch plane (to show what is picked). */
export function regionFill(frame: SketchFrame, regions: Region[]): THREE.BufferGeometry {
  return sweepMesh(frame, regions, [{ m: new THREE.Matrix4() }], { capStart: false })
}
