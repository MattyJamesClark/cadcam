import * as THREE from 'three'
import { SketchIndex, type Curve, type SketchData } from '@/sketch/model'
import { at, insidePoly, lineEnds, nearest, roundOf, type P2 } from '@/sketch/geom'
import { findRegions, type Loop, type Region } from '@/sketch/profiles'
import type { SolidProfile, SolidSeg, Vec3 } from '@/core/occt'

/**
 * Sketch geometry as Part Design uses it: closed regions to extrude / revolve
 * / sweep, open or closed chains as sweep paths, and lines as revolve axes,
 * all placed in the world by the sketch's plane.
 */

export interface SketchFrame {
  m: THREE.Matrix4
  origin: THREE.Vector3
  x: THREE.Vector3
  y: THREE.Vector3
  normal: THREE.Vector3
}

export function frameOf(s: SketchData): SketchFrame {
  const m = new THREE.Matrix4().fromArray(s.plane)
  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3()
  m.extractBasis(x, y, z)
  x.normalize()
  y.normalize()
  // The profile finder's anticlockwise loops are faces about X × Y.
  const normal = x.clone().cross(y).normalize()
  return { m, origin: new THREE.Vector3().setFromMatrixPosition(m), x, y, normal }
}

export const toWorld = (f: SketchFrame, p: P2): THREE.Vector3 => f.origin.clone().addScaledVector(f.x, p[0]).addScaledVector(f.y, p[1])
const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z]

/** Where a screen ray meets the sketch plane, in sketch coordinates. */
export function onPlane(f: SketchFrame, ray: THREE.Ray): P2 | null {
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(f.normal, f.origin)
  const hit = ray.intersectPlane(pl, new THREE.Vector3())
  if (!hit) return null
  hit.sub(f.origin)
  return [hit.dot(f.x), hit.dot(f.y)]
}

/** The region a sketch point falls in (inside the outline, not in a hole), smallest first. */
export function regionAt(regions: Region[], q: P2): number {
  let best = -1
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]
    if (!insidePoly(r.outer.poly, q) || r.holes.some((h) => insidePoly(h.poly, q))) continue
    if (best < 0 || Math.abs(r.area) < Math.abs(regions[best].area)) best = i
  }
  return best
}

export { findRegions }
export type { Region }

/** A loop as kernel segments (world), arcs as three points; ends shared exactly so the wire closes. */
function loopSegs(ix: SketchIndex, f: SketchFrame, loop: Loop): SolidSeg[] {
  const segs: SolidSeg[] = []
  for (const pc of loop.pieces) {
    const c = ix.curve(pc.curve)
    if (!c) continue
    if (c.kind === 'line') {
      segs.push({ a: v3(toWorld(f, at(ix, c, pc.t0))), b: v3(toWorld(f, at(ix, c, pc.t1))) })
      continue
    }
    // Arcs over 180° go in two halves (a three-point arc can't be a full turn).
    const span = pc.t1 - pc.t0
    const n = Math.abs(span) > Math.PI * 0.9 ? 2 : 1
    for (let k = 0; k < n; k++) {
      const t0 = pc.t0 + (span * k) / n
      const t1 = pc.t0 + (span * (k + 1)) / n
      segs.push({ a: v3(toWorld(f, at(ix, c, t0))), m: v3(toWorld(f, at(ix, c, (t0 + t1) / 2))), b: v3(toWorld(f, at(ix, c, t1))) })
    }
  }
  for (let i = 0; i < segs.length; i++) segs[i].b = segs[(i + 1) % segs.length].a
  return segs
}

export function kernelProfiles(s: SketchData, regions: Region[]): SolidProfile[] {
  const ix = new SketchIndex(s)
  const f = frameOf(s)
  return regions.map((r) => ({ outer: loopSegs(ix, f, r.outer), holes: r.holes.map((h) => loopSegs(ix, f, h)) }))
}

/** Area centroid of a region (sketch coordinates). */
export function centroid(r: Region): P2 {
  let cx = 0, cy = 0, a = 0
  for (const loop of [r.outer, ...r.holes]) {
    const p = loop.poly
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i]
      const [x1, y1] = p[(i + 1) % p.length]
      const k = x0 * y1 - x1 * y0
      a += k
      cx += (x0 + x1) * k
      cy += (y0 + y1) * k
    }
  }
  if (Math.abs(a) < 1e-12) return r.outer.poly[0]
  return [cx / (3 * a), cy / (3 * a)]
}

// ---- lines (revolve axes) -------------------------------------------------------

/** The sketch line nearest a point, within `tol` mm. */
export function lineNear(s: SketchData, q: P2, tol: number): { a: P2; b: P2; id: string } | null {
  const ix = new SketchIndex(s)
  let best: { a: P2; b: P2; id: string } | null = null
  let bestD = tol
  for (const c of s.curves) {
    if (c.kind !== 'line') continue
    const d = nearest(ix, c, q).dist
    if (d <= bestD) {
      bestD = d
      const [a, b] = lineEnds(ix, c)
      best = { a, b, id: c.id }
    }
  }
  return best
}

/** A sensible default revolve axis: the sketch's only centreline, if it has one. */
export function defaultAxis(s: SketchData): { a: P2; b: P2; id: string } | null {
  const ix = new SketchIndex(s)
  const lines = s.curves.filter((c) => c.kind === 'line' && c.construction)
  if (lines.length !== 1) return null
  const [a, b] = lineEnds(ix, lines[0] as Extract<Curve, { kind: 'line' }>)
  return { a, b, id: lines[0].id }
}

// ---- chains (sweep paths) -------------------------------------------------------

export interface Chain {
  sketch: SketchData
  curves: string[]
  /** World polyline along the chain, in order. */
  poly: THREE.Vector3[]
  segs: SolidSeg[]
  closed: boolean
}

/** The curve of a sketch nearest a point, within `tol` mm. */
export function curveNear(s: SketchData, q: P2, tol: number): string | null {
  const ix = new SketchIndex(s)
  let best: string | null = null
  let bestD = tol
  for (const c of s.curves) {
    if (c.construction) continue
    const d = nearest(ix, c, q).dist
    if (d <= bestD) {
      bestD = d
      best = c.id
    }
  }
  return best
}

/** Every curve joined end to end with `start`, in order, oriented, as a path. */
export function chainFrom(s: SketchData, start: string): Chain | null {
  const ix = new SketchIndex(s)
  const first = ix.curve(start)
  if (!first || first.construction) return null
  const f = frameOf(s)
  if (first.kind === 'circle') {
    const r = roundOf(ix, first)
    const pts: P2[] = [0, 0.5, 1, 1.5].map((k) => [r.c[0] + r.r * Math.cos(k * Math.PI), r.c[1] + r.r * Math.sin(k * Math.PI)])
    const w = pts.map((p) => v3(toWorld(f, p)))
    const segs: SolidSeg[] = [
      { a: w[0], m: w[1], b: w[2] },
      { a: w[2], m: w[3], b: w[0] }
    ]
    const poly: THREE.Vector3[] = []
    for (let i = 0; i <= 96; i++) poly.push(toWorld(f, at(ix, first, (i / 96) * Math.PI * 2)))
    return { sketch: s, curves: [start], poly, segs, closed: true }
  }
  type Step = { c: Curve; rev: boolean }
  const ends = (c: Curve): [string, string] => [(c as { a: string }).a, (c as { b: string }).b]
  const open = s.curves.filter((c) => !c.construction && c.kind !== 'circle')
  const used = new Set([first.id])
  const next = (pid: string): Step | null => {
    const hits = open.filter((c) => !used.has(c.id) && ends(c).includes(pid))
    if (hits.length !== 1) return null
    const c = hits[0]
    used.add(c.id)
    return { c, rev: ends(c)[1] === pid }
  }
  const steps: Step[] = [{ c: first, rev: false }]
  // Forward from the end, then backward from the start.
  for (let pid = ends(first)[1], st = next(pid); st; st = next(pid)) {
    steps.push(st)
    pid = ends(st.c)[st.rev ? 0 : 1]
  }
  for (let pid = ends(first)[0], st = next(pid); st; st = next(pid)) {
    // Walking backwards: flip the sense.
    steps.unshift({ c: st.c, rev: !st.rev })
    pid = ends(st.c)[st.rev ? 0 : 1]
  }
  const startPid = ends(steps[0].c)[steps[0].rev ? 1 : 0]
  const last = steps[steps.length - 1]
  const endPid = ends(last.c)[last.rev ? 0 : 1]
  const closed = steps.length > 1 && startPid === endPid
  const segs: SolidSeg[] = []
  const poly: THREE.Vector3[] = []
  for (const { c, rev } of steps) {
    if (c.kind === 'line') {
      const [a, b] = lineEnds(ix, c)
      const [p, q] = rev ? [b, a] : [a, b]
      segs.push({ a: v3(toWorld(f, p)), b: v3(toWorld(f, q)) })
      if (!poly.length) poly.push(toWorld(f, p))
      poly.push(toWorld(f, q))
    } else {
      const r = roundOf(ix, c)
      const n = Math.max(4, Math.ceil(r.sweep / 0.08))
      const tAt = (k: number): number => (rev ? r.sweep * (1 - k / n) : (r.sweep * k) / n)
      const halves = r.sweep > Math.PI * 0.9 ? 2 : 1
      for (let h = 0; h < halves; h++) {
        const k0 = (n * h) / halves, k1 = (n * (h + 1)) / halves
        segs.push({ a: v3(toWorld(f, at(ix, c, tAt(k0)))), m: v3(toWorld(f, at(ix, c, tAt((k0 + k1) / 2)))), b: v3(toWorld(f, at(ix, c, tAt(k1)))) })
      }
      for (let k = poly.length ? 1 : 0; k <= n; k++) poly.push(toWorld(f, at(ix, c, tAt(k))))
    }
  }
  for (let i = 0; i + 1 < segs.length; i++) segs[i].b = segs[i + 1].a
  if (closed) segs[segs.length - 1].b = segs[0].a
  return { sketch: s, curves: steps.map((x) => x.c.id), poly, segs, closed }
}

/** Run a chain the other way round. */
export function reverseChain(ch: Chain): Chain {
  return {
    ...ch,
    curves: [...ch.curves].reverse(),
    poly: [...ch.poly].reverse(),
    segs: [...ch.segs].reverse().map((s) => ({ a: s.b, b: s.a, m: s.m })),
    closed: ch.closed
  }
}
