import { curveEnds, type Curve, type SketchData, SketchIndex } from './model'
import { area, at, insidePoly, intersect, roundOf, tangentAt, tEnd, type P2 } from './geom'

/**
 * Closed profiles (regions) of a sketch, like SolidCraft's profile finder:
 * every non-construction curve is split where other curves cross or touch it,
 * the pieces form a planar graph, and each bounded face of that graph is a
 * region (with the loops of anything inside it as holes). Loose ends are
 * trimmed off first so a stray line doesn't spoil a profile.
 */

export interface Piece {
  curve: string
  t0: number
  t1: number
}

export interface Loop {
  poly: P2[]
  pieces: Piece[]
  area: number
}

export interface Region {
  outer: Loop
  holes: Loop[]
  /** Net area (outer minus holes), mm². */
  area: number
}

const TOL = 1e-4

interface Half {
  piece: Piece
  rev: boolean
  from: number
  to: number
  ang: number
  used: boolean
  poly: P2[]
}

export function findRegions(s: SketchData): Region[] {
  const ix = new SketchIndex(s)
  const curves = s.curves.filter((c) => !c.construction)
  if (!curves.length) return []

  // 1. Split positions along each curve.
  const cuts = new Map<string, number[]>()
  for (const c of curves) cuts.set(c.id, c.kind === 'circle' ? [] : [0, tEnd(ix, c)])
  for (let i = 0; i < curves.length; i++)
    for (let j = i + 1; j < curves.length; j++) {
      for (const h of intersect(ix, curves[i], curves[j], TOL)) {
        if (!h.within) continue
        cuts.get(curves[i].id)!.push(clampT(ix, curves[i], h.t1))
        cuts.get(curves[j].id)!.push(clampT(ix, curves[j], h.t2))
      }
    }

  // 2. Pieces between neighbouring cuts.
  const nodes: P2[] = []
  const node = (p: P2): number => {
    for (let i = 0; i < nodes.length; i++) if (Math.abs(nodes[i][0] - p[0]) < TOL && Math.abs(nodes[i][1] - p[1]) < TOL) return i
    nodes.push(p)
    return nodes.length - 1
  }
  const pieces: { piece: Piece; a: number; b: number }[] = []
  for (const c of curves) {
    const end = tEnd(ix, c)
    let ts = [...new Set(cuts.get(c.id)!.map((t) => Math.round(t / 1e-9) * 1e-9))].sort((x, y) => x - y)
    if (c.kind === 'circle') {
      ts = ts.filter((t) => t < end - 1e-9)
      if (!ts.length) ts = [0]
      ts.push(ts[0] + end)
    }
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k]
      const t1 = ts[k + 1]
      if (t1 - t0 < 1e-9) continue
      const a = node(at(ix, c, t0))
      const b = node(at(ix, c, t1))
      if (a === b && c.kind === 'line') continue
      pieces.push({ piece: { curve: c.id, t0, t1 }, a, b })
    }
  }

  // 3. Drop loose ends (nodes with one piece), repeatedly.
  let alive = pieces.slice()
  for (;;) {
    const deg = new Map<number, number>()
    for (const p of alive) {
      deg.set(p.a, (deg.get(p.a) ?? 0) + 1)
      deg.set(p.b, (deg.get(p.b) ?? 0) + 1)
    }
    const next = alive.filter((p) => (deg.get(p.a) ?? 0) > 1 && (deg.get(p.b) ?? 0) > 1)
    if (next.length === alive.length) break
    alive = next
  }
  if (!alive.length) return []

  // 4. Half edges, sorted by direction round each node.
  const byId = new Map(curves.map((c) => [c.id, c]))
  const halves: Half[] = []
  const out = new Map<number, Half[]>()
  for (const { piece, a, b } of alive) {
    const c = byId.get(piece.curve)!
    const poly = piecePoly(ix, c, piece)
    const curv = c.kind === 'line' ? 0 : 1 / Math.max(roundOf(ix, c).r, 1e-9)
    const t0 = tangentAt(ix, c, piece.t0)
    const t1 = tangentAt(ix, c, piece.t1)
    const fwd: Half = { piece, rev: false, from: a, to: b, ang: Math.atan2(t0[1], t0[0]) + 1e-7 * curv, used: false, poly }
    const back: Half = { piece, rev: true, from: b, to: a, ang: Math.atan2(-t1[1], -t1[0]) - 1e-7 * curv, used: false, poly: [...poly].reverse() }
    halves.push(fwd, back)
    for (const h of [fwd, back]) {
      if (!out.has(h.from)) out.set(h.from, [])
      out.get(h.from)!.push(h)
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.ang - y.ang)
  const twin = (h: Half): Half => halves[halves.indexOf(h) ^ 1]

  // 5. Walk faces: after arriving at a node, take the next edge clockwise from where we came in.
  const loops: Loop[] = []
  for (const start of halves) {
    if (start.used) continue
    const poly: P2[] = []
    const ps: Piece[] = []
    let h = start
    let guard = 0
    while (!h.used && guard++ < 10000) {
      h.used = true
      poly.push(...h.poly.slice(0, -1))
      ps.push(h.rev ? { curve: h.piece.curve, t0: h.piece.t1, t1: h.piece.t0 } : h.piece)
      const list = out.get(h.to)!
      const i = list.indexOf(twin(h))
      h = list[(i - 1 + list.length) % list.length]
    }
    if (poly.length < 3) continue
    loops.push({ poly, pieces: ps, area: area(poly) })
  }

  // 6. Faces are the anticlockwise loops; clockwise ones are outlines of islands (holes).
  const faces = loops.filter((l) => l.area > 1e-9).sort((a, b) => a.area - b.area)
  const regions: Region[] = faces.map((f) => ({ outer: f, holes: [], area: f.area }))
  for (const hole of loops.filter((l) => l.area < -1e-9)) {
    const probe = hole.poly[0]
    const holder = regions.find((r) => Math.abs(r.outer.area) > Math.abs(hole.area) + 1e-9 && insidePoly(r.outer.poly, probe) && !sharesNode(r.outer, hole))
    if (holder) {
      holder.holes.push(hole)
      holder.area += hole.area
    }
  }
  return regions
}

function sharesNode(a: Loop, b: Loop): boolean {
  const key = (p: P2): string => `${Math.round(p[0] / TOL)},${Math.round(p[1] / TOL)}`
  const s = new Set(a.poly.map(key))
  return b.poly.some((p) => s.has(key(p)))
}

function clampT(ix: SketchIndex, c: Curve, t: number): number {
  const e = tEnd(ix, c)
  if (c.kind === 'circle') return ((t % e) + e) % e
  return Math.max(0, Math.min(e, t))
}

function piecePoly(ix: SketchIndex, c: Curve, p: Piece): P2[] {
  if (c.kind === 'line') return [at(ix, c, p.t0), at(ix, c, p.t1)]
  const n = Math.max(2, Math.ceil((p.t1 - p.t0) / 0.04))
  const pts: P2[] = []
  for (let i = 0; i <= n; i++) pts.push(at(ix, c, p.t0 + ((p.t1 - p.t0) * i) / n))
  return pts
}

/** End points used by only one curve (and not sitting on another): where a profile is open. */
export function looseEnds(s: SketchData): string[] {
  const ix = new SketchIndex(s)
  const count = new Map<string, number>()
  for (const c of s.curves) if (!c.construction) for (const p of curveEnds(c)) count.set(p, (count.get(p) ?? 0) + 1)
  const onSomething = new Set(s.constraints.filter((k) => k.kind === 'onCurve' || k.kind === 'midpoint').map((k) => k.refs[0]))
  return [...count].filter(([p, n]) => n === 1 && !onSomething.has(p) && ix.pts.has(p)).map(([p]) => p)
}
