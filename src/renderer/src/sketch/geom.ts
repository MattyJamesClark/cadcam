import type { ArcCurve, CircleCurve, Curve, LineCurve, SketchIndex } from './model'

/** Plain 2D geometry on sketch curves: sampling, nearest points, intersections. */

export type P2 = [number, number]
export const TAU = Math.PI * 2

export const d2 = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1])
export const norm = (a: number): number => ((a % TAU) + TAU) % TAU

/** Line ends, or centre / radius / start angle / sweep of a circle or arc. */
export function lineEnds(ix: SketchIndex, c: LineCurve): [P2, P2] {
  const a = ix.p(c.a)
  const b = ix.p(c.b)
  return [
    [a.x, a.y],
    [b.x, b.y]
  ]
}
export interface Round {
  c: P2
  r: number
  /** Start angle (radians). */
  a0: number
  /** Anticlockwise sweep (2π for a circle). */
  sweep: number
  full: boolean
}
export function roundOf(ix: SketchIndex, c: CircleCurve | ArcCurve): Round {
  const o = ix.p(c.c)
  if (c.kind === 'circle') return { c: [o.x, o.y], r: c.r, a0: 0, sweep: TAU, full: true }
  const a = ix.p(c.a)
  const b = ix.p(c.b)
  const a0 = Math.atan2(a.y - o.y, a.x - o.x)
  const a1 = Math.atan2(b.y - o.y, b.x - o.x)
  let sweep = norm(a1 - a0)
  if (sweep < 1e-9) sweep = TAU
  return { c: [o.x, o.y], r: Math.hypot(a.x - o.x, a.y - o.y), a0, sweep, full: false }
}
export const onRound = (r: Round, ang: number): P2 => [r.c[0] + r.r * Math.cos(ang), r.c[1] + r.r * Math.sin(ang)]

/** Points along a curve (for drawing). `px` is roughly the size of one screen pixel in mm. */
export function sample(ix: SketchIndex, c: Curve, px = 0.05): P2[] {
  if (c.kind === 'line') return lineEnds(ix, c)
  const r = roundOf(ix, c)
  // Chord error under about a quarter pixel.
  const step = Math.min(0.25, 2 * Math.acos(Math.max(-1, 1 - Math.min(1, (px * 0.25) / Math.max(r.r, 1e-9)))))
  const n = Math.max(8, Math.min(720, Math.ceil(r.sweep / Math.max(step, 1e-3))))
  const out: P2[] = []
  for (let i = 0; i <= n; i++) out.push(onRound(r, r.a0 + (r.sweep * i) / n))
  return out
}

/**
 * A position along a curve: for a line 0..1 from a to b; for an arc the angle
 * from its start (0..sweep); for a circle the angle from +X.
 */
export interface OnCurve {
  t: number
  p: P2
  dist: number
}

export function nearest(ix: SketchIndex, c: Curve, q: P2): OnCurve {
  if (c.kind === 'line') {
    const [a, b] = lineEnds(ix, c)
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const L = dx * dx + dy * dy
    const t = L > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0
    const p: P2 = [a[0] + dx * t, a[1] + dy * t]
    return { t, p, dist: d2(p, q) }
  }
  const r = roundOf(ix, c)
  let ang = norm(Math.atan2(q[1] - r.c[1], q[0] - r.c[0]) - r.a0)
  if (!r.full && ang > r.sweep) ang = ang - r.sweep < TAU - ang ? r.sweep : 0
  const p = onRound(r, r.a0 + ang)
  return { t: ang, p, dist: d2(p, q) }
}

/** Point at a position along a curve. */
export function at(ix: SketchIndex, c: Curve, t: number): P2 {
  if (c.kind === 'line') {
    const [a, b] = lineEnds(ix, c)
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  const r = roundOf(ix, c)
  return onRound(r, r.a0 + t)
}

/** Unit direction of travel at a position (increasing t). */
export function tangentAt(ix: SketchIndex, c: Curve, t: number): P2 {
  if (c.kind === 'line') {
    const [a, b] = lineEnds(ix, c)
    const L = d2(a, b) || 1
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  }
  const r = roundOf(ix, c)
  const ang = r.a0 + t
  return [-Math.sin(ang), Math.cos(ang)]
}

/** Length of the stretch between two positions. */
export function spanLength(ix: SketchIndex, c: Curve, t0: number, t1: number): number {
  if (c.kind === 'line') {
    const [a, b] = lineEnds(ix, c)
    return Math.abs(t1 - t0) * d2(a, b)
  }
  return Math.abs(t1 - t0) * roundOf(ix, c).r
}

export function curveLength(ix: SketchIndex, c: Curve): number {
  if (c.kind === 'line') return spanLength(ix, c, 0, 1)
  const r = roundOf(ix, c)
  return r.r * r.sweep
}

/** Where a parameter range ends for a curve (lines 1, arcs their sweep, circles 2π). */
export const tEnd = (ix: SketchIndex, c: Curve): number => (c.kind === 'line' ? 1 : roundOf(ix, c).sweep)

export interface Hit {
  p: P2
  /** Positions along each curve. For lines t can run outside 0..1 (unbounded). */
  t1: number
  t2: number
  /** Within both curves' extents. */
  within: boolean
}

const EPS = 1e-9

function lineLine(a: P2, b: P2, c: P2, d: P2): { s: number; u: number } | null {
  const r: P2 = [b[0] - a[0], b[1] - a[1]]
  const q: P2 = [d[0] - c[0], d[1] - c[1]]
  const den = r[0] * q[1] - r[1] * q[0]
  if (Math.abs(den) < EPS * Math.hypot(...r) * Math.hypot(...q)) return null
  const w: P2 = [c[0] - a[0], c[1] - a[1]]
  return { s: (w[0] * q[1] - w[1] * q[0]) / den, u: (w[0] * r[1] - w[1] * r[0]) / den }
}

function lineCircle(a: P2, b: P2, o: P2, rad: number): number[] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const fx = a[0] - o[0]
  const fy = a[1] - o[1]
  const A = dx * dx + dy * dy
  const B = 2 * (fx * dx + fy * dy)
  const C = fx * fx + fy * fy - rad * rad
  let disc = B * B - 4 * A * C
  if (A < EPS) return []
  if (disc < 0) {
    // Tangent within rounding: count it once.
    if (disc > -1e-9 * B * B - 1e-12) disc = 0
    else return []
  }
  const s = Math.sqrt(disc)
  return s === 0 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)]
}

function circleCircle(o1: P2, r1: number, o2: P2, r2: number): P2[] {
  const d = d2(o1, o2)
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return []
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a))
  const mx = o1[0] + (a * (o2[0] - o1[0])) / d
  const my = o1[1] + (a * (o2[1] - o1[1])) / d
  const ox = (h * (o2[1] - o1[1])) / d
  const oy = (h * (o2[0] - o1[0])) / d
  return h < 1e-12 ? [[mx, my]] : [
    [mx + ox, my - oy],
    [mx - ox, my + oy]
  ]
}

const angOn = (r: Round, p: P2): number => norm(Math.atan2(p[1] - r.c[1], p[0] - r.c[0]) - r.a0)
const inSweep = (r: Round, t: number, tol: number): boolean => r.full || t <= r.sweep + tol || t >= TAU - tol

/** Crossings of two curves (lines treated as unbounded; `within` says if both are hit). */
export function intersect(ix: SketchIndex, c1: Curve, c2: Curve, tol = 1e-7): Hit[] {
  if (c1.kind === 'line' && c2.kind === 'line') {
    const [a, b] = lineEnds(ix, c1)
    const [c, d] = lineEnds(ix, c2)
    const h = lineLine(a, b, c, d)
    if (!h) return []
    const p: P2 = [a[0] + (b[0] - a[0]) * h.s, a[1] + (b[1] - a[1]) * h.s]
    const tl = tol / Math.max(d2(a, b), EPS)
    const tl2 = tol / Math.max(d2(c, d), EPS)
    return [{ p, t1: h.s, t2: h.u, within: h.s >= -tl && h.s <= 1 + tl && h.u >= -tl2 && h.u <= 1 + tl2 }]
  }
  if (c1.kind !== 'line' && c2.kind === 'line') return intersect(ix, c2, c1, tol).map((h) => ({ ...h, t1: h.t2, t2: h.t1 }))
  if (c1.kind === 'line') {
    const [a, b] = lineEnds(ix, c1)
    const r = roundOf(ix, c2 as CircleCurve | ArcCurve)
    const tl = tol / Math.max(d2(a, b), EPS)
    return lineCircle(a, b, r.c, r.r).map((s) => {
      const p: P2 = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]
      let t2 = angOn(r, p)
      const ok = inSweep(r, t2, tol / Math.max(r.r, EPS))
      if (!r.full && t2 > r.sweep) t2 = t2 - TAU
      return { p, t1: s, t2: Math.max(0, t2), within: ok && s >= -tl && s <= 1 + tl }
    })
  }
  const r1 = roundOf(ix, c1)
  const r2 = roundOf(ix, c2 as CircleCurve | ArcCurve)
  return circleCircle(r1.c, r1.r, r2.c, r2.r).map((p) => {
    let t1 = angOn(r1, p)
    let t2 = angOn(r2, p)
    const ok = inSweep(r1, t1, tol / r1.r) && inSweep(r2, t2, tol / r2.r)
    if (!r1.full && t1 > r1.sweep) t1 = 0
    if (!r2.full && t2 > r2.sweep) t2 = 0
    return { p, t1, t2, within: ok }
  })
}

/** Shoelace area of a closed polyline (positive = anticlockwise). */
export function area(poly: P2[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

export function insidePoly(poly: P2[], q: P2): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
