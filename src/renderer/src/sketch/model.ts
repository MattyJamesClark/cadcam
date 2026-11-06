/**
 * Sketch data: points and curves on a plane, geometric constraints and driving
 * dimensions. Everything is in the sketch plane's own 2D coordinates (mm); the
 * plane matrix places it in the world.
 *
 * Modelled on SolidCraft's sketch crate (github.com/tangency-labs/solidcraft,
 * MIT / Apache-2.0): points are shared by the curves that end on them, a circle
 * owns its radius, an arc is a centre with a start and an end point (the solver
 * keeps both ends the same distance from the centre), and every constraint or
 * dimension refers to points and curves by id.
 */

export interface SPoint {
  id: string
  x: number
  y: number
}

interface CurveBase {
  id: string
  /** Construction (reference) geometry: drawn dashed, never part of a profile. */
  construction?: boolean
}
export interface LineCurve extends CurveBase {
  kind: 'line'
  a: string
  b: string
}
export interface CircleCurve extends CurveBase {
  kind: 'circle'
  c: string
  r: number
}
/** Anticlockwise from a to b about c. */
export interface ArcCurve extends CurveBase {
  kind: 'arc'
  c: string
  a: string
  b: string
}
export type Curve = LineCurve | CircleCurve | ArcCurve

/** Geometric constraints (no value). */
export type GeoKind =
  | 'coincident' // [p, q]
  | 'onCurve' // [p, curve]
  | 'horizontal' // [line]
  | 'vertical' // [line]
  | 'hPoints' // [p, q] same Y
  | 'vPoints' // [p, q] same X
  | 'parallel' // [line, line]
  | 'perpendicular' // [line, line]
  | 'collinear' // [line, line]
  | 'tangent' // [curve, curve]; flag: line/circle side (+1/-1), circle/circle +1 outside, -1 inside
  | 'equal' // [curve, curve] same length / radius
  | 'concentric' // [circle|arc, circle|arc]
  | 'midpoint' // [p, line]
  | 'symmetric' // [p, q, line]
  | 'fix' // [p], at
  | 'sameOffset' // [p, line, dim?] or [arc, arc, dim?]: offset copy kept at the master dimension's distance (flag = side)
/** Dimensions (value in mm or degrees). */
export type DimKind =
  | 'distance' // [p, q] true distance
  | 'distanceX' // [p, q] along sketch X; flag = sign
  | 'distanceY' // [p, q] along sketch Y; flag = sign
  | 'pointLine' // [p, line] perpendicular distance; flag = side
  | 'length' // [line]
  | 'radius' // [circle|arc]
  | 'diameter' // [circle|arc]
  | 'angle' // [line, line]; flag: bit0 flips the first, bit1 the second
export type ConstraintKind = GeoKind | DimKind

export interface Constraint {
  id: string
  kind: ConstraintKind
  refs: string[]
  /** Dimensions: the value (mm, or degrees for angles). */
  value?: number
  /** Dimensions: reference only (shows the measured value, drives nothing). */
  driven?: boolean
  flag?: number
  /** fix: where the point is held. */
  at?: [number, number]
  /** Dimensions: where the text sits (sketch coordinates). */
  label?: [number, number]
}

export interface SketchData {
  id: string
  name: string
  /** Column-major 4x4: sketch X, Y, normal and origin in the world. */
  plane: number[]
  /** Name of the work plane it was drawn on (for display). */
  planeName?: string
  points: SPoint[]
  curves: Curve[]
  constraints: Constraint[]
  visible: boolean
  /** Next id number. */
  seq: number
}

export const DIM_KINDS: ReadonlySet<ConstraintKind> = new Set<ConstraintKind>(['distance', 'distanceX', 'distanceY', 'pointLine', 'length', 'radius', 'diameter', 'angle'])
export const isDim = (c: Constraint): boolean => DIM_KINDS.has(c.kind)

export function emptySketch(id: string, name: string, plane: number[], planeName?: string): SketchData {
  return { id, name, plane: [...plane], planeName, points: [], curves: [], constraints: [], visible: true, seq: 1 }
}

export const cloneSketch = (s: SketchData): SketchData => structuredClone(s)

/** Fast lookups over one sketch (rebuild after structural edits). */
export class SketchIndex {
  readonly pts = new Map<string, SPoint>()
  readonly curves = new Map<string, Curve>()
  readonly cons = new Map<string, Constraint>()
  constructor(readonly s: SketchData) {
    for (const p of s.points) this.pts.set(p.id, p)
    for (const c of s.curves) this.curves.set(c.id, c)
    for (const c of s.constraints) this.cons.set(c.id, c)
  }
  p(id: string): SPoint {
    const p = this.pts.get(id)
    if (!p) throw new Error(`sketch point ${id} missing`)
    return p
  }
  curve(id: string): Curve | undefined {
    return this.curves.get(id)
  }
  /** Radius of a circle or arc. */
  radius(c: CircleCurve | ArcCurve): number {
    if (c.kind === 'circle') return c.r
    const o = this.p(c.c)
    const a = this.p(c.a)
    return Math.hypot(a.x - o.x, a.y - o.y)
  }
  /** Curves that use a point. */
  curvesAt(pid: string): Curve[] {
    return this.s.curves.filter((c) => curvePoints(c).includes(pid))
  }
}

/** Every point a curve is defined by (ends and centre). */
export function curvePoints(c: Curve): string[] {
  return c.kind === 'line' ? [c.a, c.b] : c.kind === 'circle' ? [c.c] : [c.c, c.a, c.b]
}
/** End points only. */
export function curveEnds(c: Curve): string[] {
  return c.kind === 'line' || c.kind === 'arc' ? [c.a, c.b] : []
}

export function nextId(s: SketchData, prefix: 'p' | 'c' | 'k'): string {
  return `${prefix}${s.seq++}`
}

export function addPoint(s: SketchData, x: number, y: number): SPoint {
  const p = { id: nextId(s, 'p'), x, y }
  s.points.push(p)
  return p
}

export function addConstraint(s: SketchData, c: Omit<Constraint, 'id'>): Constraint {
  const k = { ...c, id: nextId(s, 'k') } as Constraint
  s.constraints.push(k)
  return k
}

/**
 * Remove curves, points and constraints; anything left pointing at a removed
 * item goes too, and points no curve uses any more are dropped (unless kept).
 */
export function removeItems(s: SketchData, ids: Set<string>, keepLoosePoints = false): void {
  const before = new Set(s.curves.flatMap(curvePoints))
  s.curves = s.curves.filter((c) => !ids.has(c.id) && !curvePoints(c).some((p) => ids.has(p)))
  const used = new Set(s.curves.flatMap(curvePoints))
  s.points = s.points.filter((p) => {
    if (ids.has(p.id)) return false
    // A point that only belonged to removed curves goes with them.
    if (!keepLoosePoints && before.has(p.id) && !used.has(p.id)) return false
    return true
  })
  const alive = new Set([...s.points.map((p) => p.id), ...s.curves.map((c) => c.id)])
  s.constraints = s.constraints.filter((k) => !ids.has(k.id) && k.refs.every((r) => alive.has(r) || (k.kind === 'sameOffset' && /^k/.test(r))))
  // An offset that follows a dimension that's gone keeps its current distance.
  const kept = new Set(s.constraints.map((k) => k.id))
  for (const k of s.constraints) if (k.kind === 'sameOffset' && k.refs[2] && !kept.has(k.refs[2])) k.refs = k.refs.slice(0, 2)
}

/** Merge point `from` into `to` (every reference moves to `to`). */
export function mergePoint(s: SketchData, from: string, to: string): void {
  if (from === to) return
  for (const c of s.curves) {
    if (c.kind === 'line') {
      if (c.a === from) c.a = to
      if (c.b === from) c.b = to
    } else if (c.kind === 'circle') {
      if (c.c === from) c.c = to
    } else {
      if (c.c === from) c.c = to
      if (c.a === from) c.a = to
      if (c.b === from) c.b = to
    }
  }
  for (const k of s.constraints) k.refs = k.refs.map((r) => (r === from ? to : r))
  s.points = s.points.filter((p) => p.id !== from)
  // Constraints that now tie a point to itself mean nothing.
  s.constraints = s.constraints.filter((k) => !((k.kind === 'coincident' || k.kind === 'hPoints' || k.kind === 'vPoints' || k.kind === 'distance') && k.refs[0] === k.refs[1]))
}

export function describeConstraint(k: ConstraintKind): string {
  return (
    {
      coincident: 'Coincident',
      onCurve: 'Point on curve',
      horizontal: 'Horizontal',
      vertical: 'Vertical',
      hPoints: 'Horizontal (points)',
      vPoints: 'Vertical (points)',
      parallel: 'Parallel',
      perpendicular: 'Perpendicular',
      collinear: 'Collinear',
      tangent: 'Tangent',
      equal: 'Equal',
      concentric: 'Concentric',
      midpoint: 'Midpoint',
      symmetric: 'Symmetric',
      fix: 'Fix',
      sameOffset: 'Offset',
      distance: 'Distance',
      distanceX: 'Horizontal distance',
      distanceY: 'Vertical distance',
      pointLine: 'Distance to line',
      length: 'Length',
      radius: 'Radius',
      diameter: 'Diameter',
      angle: 'Angle'
    } as Record<ConstraintKind, string>
  )[k]
}
