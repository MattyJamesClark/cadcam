import { addConstraint, curveEnds, removeItems, type ArcCurve, type Curve, type LineCurve, type SketchData, SketchIndex } from './model'
import { tangentSide, type Snap, type SketchEditor, type Tool } from './editor'
import { at, d2, intersect, lineEnds, nearest, norm, roundOf, tEnd, TAU, type P2 } from './geom'
import { solveSketch } from './solver'

/**
 * Modify tools: trim, extend, fillet, chamfer, offset, mirror. They work on
 * the live sketch, keep the relations that still make sense, tie new ends to
 * the curves that cut them, and are one undo step each.
 */

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: P2, s: number): P2 => [a[0] * s, a[1] * s]
const unit = (a: P2): P2 => {
  const l = Math.hypot(a[0], a[1]) || 1
  return [a[0] / l, a[1] / l]
}
const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0]
const dotp = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1]

function newPoint(sk: SketchData, p: P2): string {
  const id = `p${sk.seq++}`
  sk.points.push({ id, x: p[0], y: p[1] })
  return id
}
function newCurve(sk: SketchData, c: Omit<LineCurve, 'id'> | Omit<ArcCurve, 'id'>, like?: Curve): string {
  const id = `c${sk.seq++}`
  sk.curves.push({ ...c, id, construction: like?.construction } as Curve)
  return id
}

/** Relations on a curve that stop being true once its length changes. */
const SIZE_KINDS = new Set(['length', 'equal', 'midpoint'])
function dropSizeRelations(sk: SketchData, curveId: string): void {
  sk.constraints = sk.constraints.filter((k) => !(SIZE_KINDS.has(k.kind) && k.refs.includes(curveId)))
}

/** Where other curves cut this one (positions along it, sorted, within its extent). */
function cutsOn(ix: SketchIndex, c: Curve): { t: number; by: string }[] {
  const out: { t: number; by: string }[] = []
  for (const o of ix.s.curves) {
    if (o.id === c.id) continue
    for (const h of intersect(ix, c, o, 1e-6)) if (h.within) out.push({ t: h.t1, by: o.id })
  }
  return out.sort((a, b) => a.t - b.t)
}

// ---- trim ------------------------------------------------------------------------------

export class TrimTool implements Tool {
  readonly name = 'Trim'
  constructor(private ed: SketchEditor) {
    ed.fields([])
  }
  prompt(): string {
    return 'click the part of a curve to cut away (between crossings)'
  }
  private piece(q: P2): { c: Curve; t0: number; t1: number; by0?: string; by1?: string; wrap: boolean } | null {
    const ed = this.ed
    const ix = ed.ix()
    const id = ed.itemAt(q)
    const c = id ? ix.curve(id) : undefined
    if (!c) return null
    const t = nearest(ix, c, q).t
    const end = tEnd(ix, c)
    const cuts = cutsOn(ix, c).filter((x) => (c.kind === 'circle' ? true : x.t > 1e-7 && x.t < end - 1e-7))
    if (c.kind === 'circle') {
      if (!cuts.length) return { c, t0: 0, t1: TAU, wrap: false }
      const ts = cuts.map((x) => norm(x.t))
      let i = ts.findIndex((v) => v > t)
      if (i < 0) i = 0
      const j = (i - 1 + ts.length) % ts.length
      return { c, t0: ts[j], t1: ts[i], by0: cuts[j].by, by1: cuts[i].by, wrap: ts[j] >= ts[i] }
    }
    let lo = 0
    let hi = end
    let by0: string | undefined
    let by1: string | undefined
    for (const x of cuts) {
      if (x.t < t && x.t > lo) {
        lo = x.t
        by0 = x.by
      }
      if (x.t > t && x.t < hi) {
        hi = x.t
        by1 = x.by
      }
    }
    return { c, t0: lo, t1: hi, by0, by1, wrap: false }
  }
  move(s: Snap): void {
    const ed = this.ed
    ed.clearPreview()
    const p = this.piece(s.p)
    if (!p) return
    const ix = ed.ix()
    const n = 48
    const span = p.wrap ? p.t1 + TAU - p.t0 : p.t1 - p.t0
    const pts = Array.from({ length: n + 1 }, (_, i) => at(ix, p.c, p.t0 + (span * i) / n))
    ed.previewLines([pts], 0xff5a5a)
  }
  click(s: Snap): void {
    const p = this.piece(s.p)
    if (!p) return
    const ed = this.ed
    const sk = ed.sk
    const ix = ed.ix()
    const c = p.c
    const end = tEnd(ix, c)
    const tie = (pid: string, by?: string): void => {
      if (by) addConstraint(sk, { kind: 'onCurve', refs: [pid, by] })
    }
    if (c.kind === 'circle') {
      if (p.by0 === undefined) {
        removeItems(sk, new Set([c.id]))
      } else {
        // What's left runs anticlockwise from the far cut back round to the near one.
        const a = newPoint(sk, at(ix, c, p.t1))
        const b = newPoint(sk, at(ix, c, p.t0))
        const arc = c as unknown as ArcCurve
        const centre = c.c
        Object.assign(arc, { kind: 'arc', c: centre, a, b })
        delete (arc as { r?: number }).r
        tie(a, p.by1)
        tie(b, p.by0)
      }
    } else if (p.t0 <= 1e-9 && p.t1 >= end - 1e-9) {
      removeItems(sk, new Set([c.id]))
    } else if (p.t0 <= 1e-9 || p.t1 >= end - 1e-9) {
      // Cut one end back to the crossing.
      const atStart = p.t0 <= 1e-9
      const q = newPoint(sk, at(ix, c, atStart ? p.t1 : p.t0))
      const old = atStart ? c.a : c.b
      if (atStart) c.a = q
      else c.b = q
      tie(q, atStart ? p.by1 : p.by0)
      dropSizeRelations(sk, c.id)
      if (!sk.curves.some((x) => curveEnds(x).includes(old) || (x.kind !== 'line' && x.c === old))) removeItems(sk, new Set([old]))
    } else {
      // Cut out the middle: the curve keeps the first part, a new one takes the rest.
      const q0 = newPoint(sk, at(ix, c, p.t0))
      const q1 = newPoint(sk, at(ix, c, p.t1))
      const oldB = c.b
      c.b = q0
      const rest = c.kind === 'line' ? newCurve(sk, { kind: 'line', a: q1, b: oldB }, c) : newCurve(sk, { kind: 'arc', c: c.c, a: q1, b: oldB }, c)
      if (c.kind === 'line') addConstraint(sk, { kind: 'collinear', refs: [c.id, rest] })
      tie(q0, p.by0)
      tie(q1, p.by1)
      dropSizeRelations(sk, c.id)
      // Relations on the old far end now belong to the new piece's end; lines keep their direction.
      for (const k of sk.constraints) if ((k.kind === 'horizontal' || k.kind === 'vertical') && k.refs[0] === c.id) addConstraint(sk, { kind: k.kind, refs: [rest] })
    }
    if (!solveSketch(structuredClone(sk), { quick: true }).ok) {
      ed.revert()
      ed.ctx.status("Can't trim there: the relations left over would conflict", 'warn')
      return
    }
    ed.commit('Trim')
    ed.clearPreview()
  }
}

// ---- extend ------------------------------------------------------------------------------

export class ExtendTool implements Tool {
  readonly name = 'Extend'
  constructor(private ed: SketchEditor) {
    ed.fields([])
  }
  prompt(): string {
    return 'click near the end of a line or arc to extend it to the next curve'
  }
  private target(q: P2): { c: LineCurve | ArcCurve; end: 'a' | 'b'; p: P2; by: string } | null {
    const ed = this.ed
    const ix = ed.ix()
    const id = ed.itemAt(q)
    const c = id ? ix.curve(id) : undefined
    if (!c || c.kind === 'circle') return null
    const t = nearest(ix, c, q).t
    const end = tEnd(ix, c)
    const atEnd: 'a' | 'b' = t > end / 2 ? 'b' : 'a'
    let best: { t: number; p: P2; by: string } | null = null
    for (const o of ix.s.curves) {
      if (o.id === c.id) continue
      for (const h of intersect(ix, c, o, 1e-6)) {
        // The other curve must really be hit; this one can run on past its end.
        const onOther = intersect(ix, o, c, 1e-6).some((g) => g.within && d2(g.p, h.p) < 1e-6)
        if (!onOther) continue
        let tt = h.t1
        if (c.kind === 'arc') tt = norm(Math.atan2(h.p[1] - roundOf(ix, c).c[1], h.p[0] - roundOf(ix, c).c[0]) - roundOf(ix, c).a0)
        const beyond = atEnd === 'b' ? tt - end : c.kind === 'arc' ? TAU - tt : -tt
        if (beyond <= 1e-7) continue
        if (!best || beyond < best.t) best = { t: beyond, p: h.p, by: o.id }
      }
    }
    return best ? { c, end: atEnd, p: best.p, by: best.by } : null
  }
  move(s: Snap): void {
    const ed = this.ed
    ed.clearPreview()
    const t = this.target(s.p)
    if (!t) return
    const ix = ed.ix()
    const from = ix.p(t.end === 'a' ? t.c.a : t.c.b)
    ed.previewLines([[[from.x, from.y], t.p]], 0x7ee787, true)
  }
  click(s: Snap): void {
    const t = this.target(s.p)
    if (!t) return this.ed.ctx.status('Nothing to extend to in that direction', 'warn')
    const ed = this.ed
    const sk = ed.sk
    const ix = ed.ix()
    const old = t.end === 'a' ? t.c.a : t.c.b
    const shared = ix.curvesAt(old).length > 1
    if (shared) {
      const q = newPoint(sk, t.p)
      if (t.end === 'a') t.c.a = q
      else t.c.b = q
      addConstraint(sk, { kind: 'onCurve', refs: [q, t.by] })
    } else {
      const p = sk.points.find((x) => x.id === old)!
      p.x = t.p[0]
      p.y = t.p[1]
      addConstraint(sk, { kind: 'onCurve', refs: [old, t.by] })
    }
    dropSizeRelations(sk, t.c.id)
    if (!solveSketch(structuredClone(sk), { quick: true }).ok) {
      ed.revert()
      return ed.ctx.status("Can't extend: it would break the sketch's relations", 'warn')
    }
    ed.commit('Extend')
    ed.clearPreview()
  }
}

// ---- fillet & chamfer ----------------------------------------------------------------------

/** The corner (shared point of two lines) nearest the pointer. */
function cornerAt(ed: SketchEditor, q: P2): { v: string; l1: LineCurve; l2: LineCurve } | null {
  const ix = ed.ix()
  const px = ed.px
  let best: { v: string; l1: LineCurve; l2: LineCurve } | null = null
  let bd = 14 * px
  for (const p of ed.sk.points) {
    const lines = ix.curvesAt(p.id).filter((c): c is LineCurve => c.kind === 'line' && !c.construction)
    if (lines.length !== 2) continue
    const d = Math.hypot(p.x - q[0], p.y - q[1])
    if (d < bd) {
      bd = d
      best = { v: p.id, l1: lines[0], l2: lines[1] }
    }
  }
  if (best) return best
  // Or a line near the pointer: its nearer corner.
  const id = ed.itemAt(q)
  const c = id ? ix.curve(id) : undefined
  if (c?.kind !== 'line') return null
  for (const v of [c.a, c.b].sort((x, y) => d2([ix.p(x).x, ix.p(x).y], q) - d2([ix.p(y).x, ix.p(y).y], q))) {
    const lines = ix.curvesAt(v).filter((o): o is LineCurve => o.kind === 'line' && !o.construction)
    if (lines.length === 2) return { v, l1: lines[0], l2: lines[1] }
  }
  return null
}

interface CornerGeom {
  V: P2
  u1: P2
  u2: P2
  far1: number
  far2: number
}
function cornerGeom(ix: SketchIndex, c: { v: string; l1: LineCurve; l2: LineCurve }): CornerGeom {
  const P = (id: string): P2 => [ix.p(id).x, ix.p(id).y]
  const V = P(c.v)
  const o1 = P(c.l1.a === c.v ? c.l1.b : c.l1.a)
  const o2 = P(c.l2.a === c.v ? c.l2.b : c.l2.a)
  return { V, u1: unit(sub(o1, V)), u2: unit(sub(o2, V)), far1: d2(o1, V), far2: d2(o2, V) }
}

/**
 * Cut a corner: each line's end at the corner moves to its new end point; the
 * old corner stays as a construction "virtual sharp" (on both lines) when
 * dimensions use it, and lengths on the two lines become distances to it.
 */
function cutCorner(ed: SketchEditor, c: { v: string; l1: LineCurve; l2: LineCurve }, t1: P2, t2: P2): { p1: string; p2: string } {
  const sk = ed.sk
  const p1 = newPoint(sk, t1)
  const p2 = newPoint(sk, t2)
  const far = (l: LineCurve): string => (l.a === c.v ? l.b : l.a)
  const l1 = sk.curves.find((x) => x.id === c.l1.id) as LineCurve
  const l2 = sk.curves.find((x) => x.id === c.l2.id) as LineCurve
  // Lengths become distances from the far end to the sharp, so the size you set is kept.
  let keepSharp = sk.constraints.some((k) => k.refs.includes(c.v) && k.kind !== 'coincident')
  for (const k of sk.constraints) {
    if (k.kind === 'length' && (k.refs[0] === l1.id || k.refs[0] === l2.id)) {
      const l = k.refs[0] === l1.id ? l1 : l2
      k.kind = 'distance'
      k.refs = [far(l), c.v]
      keepSharp = true
    }
  }
  dropSizeRelations(sk, l1.id)
  dropSizeRelations(sk, l2.id)
  if (l1.a === c.v) l1.a = p1
  else l1.b = p1
  if (l2.a === c.v) l2.a = p2
  else l2.b = p2
  if (keepSharp) {
    addConstraint(sk, { kind: 'onCurve', refs: [c.v, l1.id] })
    addConstraint(sk, { kind: 'onCurve', refs: [c.v, l2.id] })
  } else if (!ed.ix().curvesAt(c.v).length) removeItems(sk, new Set([c.v]))
  return { p1, p2 }
}

export class FilletTool implements Tool {
  readonly name = 'Fillet'
  constructor(private ed: SketchEditor) {
    ed.fields([{ key: 'r', label: 'Radius', value: 5 }])
  }
  prompt(): string {
    return 'click a corner where two lines meet'
  }
  private geom(q: P2): { corner: { v: string; l1: LineCurve; l2: LineCurve }; t1: P2; t2: P2; c: P2; r: number } | null {
    const corner = cornerAt(this.ed, q)
    if (!corner) return null
    const g = cornerGeom(this.ed.ix(), corner)
    const r = Math.max(1e-3, this.ed.typedValue('r') ?? 5)
    const th = Math.acos(Math.max(-1, Math.min(1, dotp(g.u1, g.u2))))
    if (th < 1e-3 || th > Math.PI - 1e-3) return null
    const d = r / Math.tan(th / 2)
    if (d >= g.far1 || d >= g.far2) return null
    const bis = unit(add(g.u1, g.u2))
    return { corner, t1: add(g.V, mul(g.u1, d)), t2: add(g.V, mul(g.u2, d)), c: add(g.V, mul(bis, r / Math.sin(th / 2))), r }
  }
  move(s: Snap): void {
    const ed = this.ed
    ed.clearPreview()
    const g = this.geom(s.p)
    if (!g) return
    const a1 = Math.atan2(g.t1[1] - g.c[1], g.t1[0] - g.c[0])
    const a2 = Math.atan2(g.t2[1] - g.c[1], g.t2[0] - g.c[0])
    let sw = norm(a2 - a1)
    let a0 = a1
    if (sw > Math.PI) {
      a0 = a2
      sw = TAU - sw
    }
    ed.previewLines([Array.from({ length: 25 }, (_, i) => [g.c[0] + g.r * Math.cos(a0 + (sw * i) / 24), g.c[1] + g.r * Math.sin(a0 + (sw * i) / 24)] as P2)])
  }
  click(s: Snap): void {
    const g = this.geom(s.p)
    if (!g) return this.ed.ctx.status('Pick a corner of two lines with room for that radius', 'warn')
    const ed = this.ed
    const sk = ed.sk
    const { p1, p2 } = cutCorner(ed, g.corner, g.t1, g.t2)
    const c = newPoint(sk, g.c)
    const a1 = Math.atan2(g.t1[1] - g.c[1], g.t1[0] - g.c[0])
    const a2 = Math.atan2(g.t2[1] - g.c[1], g.t2[0] - g.c[0])
    const ccw = norm(a2 - a1) < Math.PI
    const arc = newCurve(sk, { kind: 'arc', c, a: ccw ? p1 : p2, b: ccw ? p2 : p1 })
    addConstraint(sk, { kind: 'tangent', refs: [g.corner.l1.id, arc], flag: tangentSide(ed, g.corner.l1.id, arc) })
    addConstraint(sk, { kind: 'tangent', refs: [g.corner.l2.id, arc], flag: tangentSide(ed, g.corner.l2.id, arc) })
    const mid = norm(a1 + (ccw ? norm(a2 - a1) : -norm(a1 - a2)) / 2)
    const k = addConstraint(sk, { kind: 'radius', refs: [arc], value: g.r, label: [Math.cos(mid) * g.r * 1.8, Math.sin(mid) * g.r * 1.8] })
    if (!solveSketch(structuredClone(sk), { quick: true }).ok) {
      ed.revert()
      return ed.ctx.status("Can't fillet that corner: its relations would conflict", 'warn')
    }
    ed.commit('Fillet')
    ed.clearPreview()
    void k
  }
}

export class ChamferTool implements Tool {
  readonly name = 'Chamfer'
  constructor(private ed: SketchEditor) {
    ed.fields([
      { key: 'd1', label: 'Distance', value: 2 },
      { key: 'd2', label: 'Distance 2' }
    ])
  }
  prompt(): string {
    return 'click a corner where two lines meet (Distance 2 empty = equal sides)'
  }
  private geom(q: P2): { corner: { v: string; l1: LineCurve; l2: LineCurve }; t1: P2; t2: P2; d1: number; d2: number } | null {
    const corner = cornerAt(this.ed, q)
    if (!corner) return null
    const g = cornerGeom(this.ed.ix(), corner)
    const d1 = Math.max(1e-3, this.ed.typedValue('d1') ?? 2)
    const dd2 = this.ed.typedValue('d2')
    const d2v = dd2 !== null && dd2 > 0 ? dd2 : d1
    if (d1 >= g.far1 || d2v >= g.far2) return null
    return { corner, t1: add(g.V, mul(g.u1, d1)), t2: add(g.V, mul(g.u2, d2v)), d1, d2: d2v }
  }
  move(s: Snap): void {
    this.ed.clearPreview()
    const g = this.geom(s.p)
    if (g) this.ed.previewLines([[g.t1, g.t2]])
  }
  click(s: Snap): void {
    const g = this.geom(s.p)
    if (!g) return this.ed.ctx.status('Pick a corner of two lines long enough for that chamfer', 'warn')
    const ed = this.ed
    const sk = ed.sk
    const v = g.corner.v
    const { p1, p2 } = cutCorner(ed, g.corner, g.t1, g.t2)
    newCurve(sk, { kind: 'line', a: p1, b: p2 })
    // The sharp stays (on both lines) so the two distances can be dimensioned from it.
    if (!sk.points.some((p) => p.id === v)) return ed.revert()
    if (!sk.constraints.some((k) => k.kind === 'onCurve' && k.refs[0] === v)) {
      addConstraint(sk, { kind: 'onCurve', refs: [v, g.corner.l1.id] })
      addConstraint(sk, { kind: 'onCurve', refs: [v, g.corner.l2.id] })
    }
    addConstraint(sk, { kind: 'distance', refs: [v, p1], value: g.d1 })
    addConstraint(sk, { kind: 'distance', refs: [v, p2], value: g.d2 })
    if (!solveSketch(structuredClone(sk), { quick: true }).ok) {
      ed.revert()
      return ed.ctx.status("Can't chamfer that corner: its relations would conflict", 'warn')
    }
    ed.commit('Chamfer')
    ed.clearPreview()
  }
}

// ---- offset ------------------------------------------------------------------------------------

interface ChainItem {
  c: Curve
  /** Walked from b to a. */
  rev: boolean
}

/** Curves joined end to end through points used by exactly two curves. */
function chainFrom(ix: SketchIndex, start: Curve): { items: ChainItem[]; closed: boolean } {
  if (start.kind === 'circle') return { items: [{ c: start, rev: false }], closed: true }
  const items: ChainItem[] = [{ c: start, rev: false }]
  const used = new Set([start.id])
  const ends = (it: ChainItem): [string, string] => {
    const [a, b] = curveEnds(it.c)
    return it.rev ? [b, a] : [a, b]
  }
  const next = (pid: string): Curve | null => {
    const at = ix.curvesAt(pid).filter((c) => c.kind !== 'circle' && !c.construction && curveEnds(c).includes(pid))
    if (at.length !== 2) return null
    return at.find((c) => !used.has(c.id)) ?? null
  }
  // Forwards.
  for (;;) {
    const tail = ends(items[items.length - 1])[1]
    const n = next(tail)
    if (!n) break
    used.add(n.id)
    items.push({ c: n, rev: curveEnds(n)[1] === tail })
  }
  const closed = ends(items[items.length - 1])[1] === ends(items[0])[0]
  if (!closed)
    for (;;) {
      const head = ends(items[0])[0]
      const n = next(head)
      if (!n) break
      used.add(n.id)
      items.unshift({ c: n, rev: curveEnds(n)[0] === head })
    }
  return { items, closed }
}

interface OffPiece {
  kind: 'line' | 'arc'
  a: P2
  b: P2
  c?: P2
  r?: number
  src: Curve
  rev: boolean
}

/** Offset a chain sideways by d (positive = to the left of the walking direction). */
function offsetChain(ix: SketchIndex, chain: { items: ChainItem[]; closed: boolean }, d: number): OffPiece[] | null {
  const pieces: OffPiece[] = []
  for (const it of chain.items) {
    const c = it.c
    if (c.kind === 'line') {
      let [a, b] = lineEnds(ix, c)
      if (it.rev) [a, b] = [b, a]
      const n: P2 = [-(b[1] - a[1]), b[0] - a[0]]
      const u = unit(n)
      pieces.push({ kind: 'line', a: add(a, mul(u, d)), b: add(b, mul(u, d)), src: c, rev: it.rev })
    } else {
      const r = roundOf(ix, c)
      // Walking anticlockwise the centre is on the left.
      const rr = it.rev ? r.r + d : r.r - d
      if (rr <= 1e-6) return null
      const a0 = it.rev ? r.a0 + r.sweep : r.a0
      const a1 = it.rev ? r.a0 : r.a0 + r.sweep
      if (c.kind === 'circle') {
        pieces.push({ kind: 'arc', a: [r.c[0] + rr, r.c[1]], b: [r.c[0] + rr, r.c[1]], c: r.c, r: rr, src: c, rev: false })
        continue
      }
      pieces.push({ kind: 'arc', a: [r.c[0] + rr * Math.cos(a0), r.c[1] + rr * Math.sin(a0)], b: [r.c[0] + rr * Math.cos(a1), r.c[1] + rr * Math.sin(a1)], c: r.c, r: rr, src: c, rev: it.rev })
    }
  }
  // Join neighbours where the offset pieces meet (lines: their crossing).
  const n = pieces.length
  for (let i = 0; i < (chain.closed ? n : n - 1); i++) {
    const A = pieces[i]
    const B = pieces[(i + 1) % n]
    if (A.kind === 'line' && B.kind === 'line') {
      const r = sub(A.b, A.a)
      const q = sub(B.b, B.a)
      const den = cross(r, q)
      if (Math.abs(den) < 1e-12) continue
      const s = cross(sub(B.a, A.a), q) / den
      const p = add(A.a, mul(r, s))
      A.b = p
      B.a = p
    } else if (d2(A.b, B.a) > 1e-6) {
      // Line meeting an arc (tangent joints stay tangent): use the nearer crossing.
      const m = mul(add(A.b, B.a), 0.5)
      const hits = crossings(A, B)
      if (hits.length) {
        const p = hits.sort((x, y) => d2(x, m) - d2(y, m))[0]
        A.b = p
        B.a = p
      }
    }
  }
  return pieces
}

function crossings(A: OffPiece, B: OffPiece): P2[] {
  const lc = (l: OffPiece, c: OffPiece): P2[] => {
    const d = sub(l.b, l.a)
    const f = sub(l.a, c.c!)
    const a = dotp(d, d)
    const b = 2 * dotp(f, d)
    const cc = dotp(f, f) - c.r! * c.r!
    const disc = b * b - 4 * a * cc
    if (disc < 0 || a < 1e-12) return []
    const s = Math.sqrt(disc)
    return [(-b - s) / (2 * a), (-b + s) / (2 * a)].map((t) => add(l.a, mul(d, t)))
  }
  if (A.kind === 'line' && B.kind === 'arc') return lc(A, B)
  if (A.kind === 'arc' && B.kind === 'line') return lc(B, A)
  if (A.kind === 'arc' && B.kind === 'arc') {
    const D = d2(A.c!, B.c!)
    const r1 = A.r!
    const r2 = B.r!
    if (D < 1e-12 || D > r1 + r2 || D < Math.abs(r1 - r2)) return []
    const a = (r1 * r1 - r2 * r2 + D * D) / (2 * D)
    const h = Math.sqrt(Math.max(0, r1 * r1 - a * a))
    const u = unit(sub(B.c!, A.c!))
    const m = add(A.c!, mul(u, a))
    return [add(m, mul([-u[1], u[0]], h)), add(m, mul([u[1], -u[0]], h))]
  }
  return []
}

export class OffsetTool implements Tool {
  readonly name = 'Offset'
  private chain: { items: ChainItem[]; closed: boolean } | null = null
  private side = 1
  private handle: ReturnType<SketchEditor['handles']['arrow']> | null = null
  constructor(private ed: SketchEditor) {
    ed.fields([{ key: 'd', label: 'Distance', value: 5 }])
  }
  prompt(): string {
    return this.chain ? 'move to the side to offset to, drag the arrow or type the distance, then click (or Enter)' : 'click a curve: its whole connected chain is offset'
  }
  private dist(): number {
    return Math.max(1e-3, this.ed.typedValue('d') ?? 5)
  }
  private pieces(): OffPiece[] | null {
    if (!this.chain) return null
    return offsetChain(this.ed.ix(), this.chain, this.dist() * this.side)
  }
  private draw(): void {
    const ed = this.ed
    ed.clearPreview()
    const p = this.pieces()
    if (!p) return
    ed.previewLines(p.map((x) => polyOf(x)))
    // Arrow handle at the first piece, pointing to the offset side.
    const first = p[0]
    const src = this.chain!.items[0]
    const ix = ed.ix()
    const mid = first.kind === 'line' ? mul(add(first.a, first.b), 0.5) : first.a
    const base = nearest(ix, src.c, mid).p
    const dir = unit(sub(mid, base))
    const o = ed.world(base)
    const d3 = ed.world(add(base, dir)).sub(o)
    if (this.handle) ed.handles.remove(this.handle)
    this.handle = ed.handles.arrow({
      origin: o,
      dir: d3,
      value: this.dist(),
      tip: 'Drag to set the offset distance',
      onDrag: (v) => {
        ed.setTyped('d', Math.max(1e-3, Math.abs(v)))
        if (v < 0) this.side = -this.side
        this.draw()
      }
    })
  }
  move(s: Snap): void {
    if (!this.chain) {
      const id = this.ed.itemAt(s.p)
      const c = id ? this.ed.ix().curve(id) : undefined
      this.ed.setHover(c ? c.id : null)
      return
    }
    // Which side of the chain's nearest piece is the pointer on?
    const ix = this.ed.ix()
    let best: { d: number; side: number } | null = null
    for (const it of this.chain.items) {
      const n = nearest(ix, it.c, s.p)
      const t = it.c.kind === 'line' ? sub(...(lineEnds(ix, it.c).reverse() as [P2, P2])) : null
      let side: number
      if (t) side = Math.sign(cross(mul(t, -1), sub(s.p, n.p))) * (it.rev ? -1 : 1)
      else {
        const r = roundOf(ix, it.c as ArcCurve)
        side = (d2(s.p, r.c) < r.r ? 1 : -1) * (it.rev ? -1 : 1)
      }
      if (!best || n.dist < best.d) best = { d: n.dist, side: side || 1 }
    }
    if (best && best.side !== this.side) {
      this.side = best.side
      this.draw()
    }
  }
  click(s: Snap): void {
    if (!this.chain) {
      const id = this.ed.itemAt(s.p)
      const c = id ? this.ed.ix().curve(id) : undefined
      if (!c) return
      this.chain = chainFrom(this.ed.ix(), c)
      this.ed.setHover(null)
      this.ed.select(this.chain.items.map((x) => x.c.id))
      this.draw()
      return
    }
    this.apply()
  }
  typed(): void {
    if (this.chain) this.apply()
  }
  private apply(): void {
    const ed = this.ed
    const pieces = this.pieces()
    if (!pieces || !this.chain) return
    const sk = ed.sk
    const ix = ed.ix()
    const ids: string[] = []
    let firstPoint: string | null = null
    let prevEnd: string | null = null
    pieces.forEach((p, i) => {
      const joinPrev = i > 0 && prevEnd && d2(p.a, [sk.points.find((x) => x.id === prevEnd)!.x, sk.points.find((x) => x.id === prevEnd)!.y]) < 1e-6
      const a = joinPrev ? prevEnd! : newPoint(sk, p.a)
      if (i === 0) firstPoint = a
      const closing = this.chain!.closed && i === pieces.length - 1 && firstPoint && d2(p.b, pieces[0].a) < 1e-6
      const b = p.src.kind === 'circle' ? a : closing ? firstPoint! : newPoint(sk, p.b)
      let id: string
      if (p.kind === 'line') {
        id = newCurve(sk, { kind: 'line', a, b }, p.src)
        addConstraint(sk, { kind: 'parallel', refs: [p.src.id, id] })
      } else if (p.src.kind === 'circle') {
        id = `c${sk.seq++}`
        sk.curves.push({ id, kind: 'circle', c: p.src.c, r: p.r!, construction: p.src.construction })
        sk.points = sk.points.filter((x) => x.id !== a)
      } else {
        const src = p.src as ArcCurve
        // Same centre; keep anticlockwise order.
        id = p.rev ? newCurve(sk, { kind: 'arc', c: src.c, a: b, b: a }, src) : newCurve(sk, { kind: 'arc', c: src.c, a, b }, src)
      }
      ids.push(id)
      prevEnd = b
    })
    void ix
    // One distance dimension on the first line drives the whole offset; every other piece keeps that distance.
    const d = this.dist()
    let master: string | undefined
    pieces.forEach((p, i) => {
      const c = sk.curves.find((x) => x.id === ids[i])!
      const sideOf = (pp: OffPiece): number => this.side * (pp.rev ? -1 : 1)
      if (p.kind === 'line' && c.kind === 'line') {
        if (!master) {
          master = addConstraint(sk, { kind: 'pointLine', refs: [c.a, p.src.id], value: d, flag: sideOf(p) }).id
          for (const q of [c.b]) addConstraint(sk, { kind: 'sameOffset', refs: [q, p.src.id, master], flag: sideOf(p) })
        } else for (const q of [c.a, c.b]) addConstraint(sk, { kind: 'sameOffset', refs: [q, p.src.id, master], flag: sideOf(p) })
      }
    })
    pieces.forEach((p, i) => {
      const c = sk.curves.find((x) => x.id === ids[i])!
      if (p.kind !== 'arc' || c.kind === 'line') return
      const rs = roundOf(new SketchIndex(sk), p.src as ArcCurve).r
      const sign = Math.sign(p.r! - rs) || 1
      addConstraint(sk, { kind: 'sameOffset', refs: master ? [c.id, p.src.id, master] : [c.id, p.src.id], flag: sign, value: master ? undefined : d })
    })
    if (!solveSketch(structuredClone(sk), { quick: true }).ok) {
      ed.revert()
      return ed.ctx.status("Can't offset that chain by that distance", 'warn')
    }
    ed.commit('Offset')
    this.reset()
  }
  private reset(): void {
    this.chain = null
    if (this.handle) this.ed.handles.remove(this.handle)
    this.handle = null
    this.ed.clearPreview()
    this.ed.select([])
  }
  back(): boolean {
    if (!this.chain) return false
    this.reset()
    return true
  }
  dispose(): void {
    if (this.handle) this.ed.handles.remove(this.handle)
    this.handle = null
  }
}

function polyOf(p: OffPiece): P2[] {
  if (p.kind === 'line') return [p.a, p.b]
  const a0 = Math.atan2(p.a[1] - p.c![1], p.a[0] - p.c![0])
  const a1 = Math.atan2(p.b[1] - p.c![1], p.b[0] - p.c![0])
  let sw = p.rev ? -norm(a0 - a1) : norm(a1 - a0)
  if (Math.abs(sw) < 1e-9) sw = TAU
  return Array.from({ length: 49 }, (_, i) => [p.c![0] + p.r! * Math.cos(a0 + (sw * i) / 48), p.c![1] + p.r! * Math.sin(a0 + (sw * i) / 48)] as P2)
}

// ---- mirror ---------------------------------------------------------------------------------------

export class MirrorTool implements Tool {
  readonly name = 'Mirror'
  private items: string[]
  constructor(private ed: SketchEditor, selected: string[]) {
    this.items = selected
    ed.fields([])
  }
  prompt(): string {
    return 'click the line to mirror about'
  }
  private axis(q: P2): LineCurve | null {
    const id = this.ed.itemAt(q)
    const c = id ? this.ed.ix().curve(id) : undefined
    return c?.kind === 'line' ? c : null
  }
  private mirror(ix: SketchIndex, l: LineCurve): (p: P2) => P2 {
    const [a, b] = lineEnds(ix, l)
    const u = unit(sub(b, a))
    return (p) => {
      const w = sub(p, a)
      const along = mul(u, dotp(w, u))
      return sub(mul(add(a, along), 2), p)
    }
  }
  move(s: Snap): void {
    const ed = this.ed
    ed.clearPreview()
    const l = this.axis(s.p)
    if (!l) return
    const ix = ed.ix()
    const m = this.mirror(ix, l)
    const polys: P2[][] = []
    for (const id of this.items) {
      const c = ix.curve(id)
      if (!c || c.id === l.id) continue
      const n = 32
      polys.push(Array.from({ length: c.kind === 'line' ? 2 : n + 1 }, (_, i) => m(at(ix, c, (tEnd(ix, c) * i) / (c.kind === 'line' ? 1 : n)))))
    }
    ed.previewLines(polys)
  }
  click(s: Snap): void {
    const l = this.axis(s.p)
    if (!l) return
    const ed = this.ed
    const sk = ed.sk
    const ix = ed.ix()
    const m = this.mirror(ix, l)
    const [la, lb] = lineEnds(ix, l)
    const onAxis = (p: P2): boolean => Math.abs(cross(unit(sub(lb, la)), sub(p, la))) < 1e-6
    const map = new Map<string, string>()
    const twin = (pid: string): string => {
      const got = map.get(pid)
      if (got) return got
      const p = ix.p(pid)
      const P: P2 = [p.x, p.y]
      // Points on the mirror line are shared, not copied.
      if (onAxis(P)) {
        map.set(pid, pid)
        return pid
      }
      const id = newPoint(sk, m(P))
      addConstraint(sk, { kind: 'symmetric', refs: [pid, id, l.id] })
      map.set(pid, id)
      return id
    }
    let n = 0
    for (const id of this.items) {
      if (id === l.id) continue
      const c = ix.curve(id)
      if (c?.kind === 'line') newCurve(sk, { kind: 'line', a: twin(c.a), b: twin(c.b) }, c)
      else if (c?.kind === 'arc') newCurve(sk, { kind: 'arc', c: twin(c.c), a: twin(c.b), b: twin(c.a) }, c)
      else if (c?.kind === 'circle') {
        const nid = `c${sk.seq++}`
        sk.curves.push({ id: nid, kind: 'circle', c: twin(c.c), r: c.r, construction: c.construction })
        addConstraint(sk, { kind: 'equal', refs: [c.id, nid] })
      } else if (ix.pts.has(id)) twin(id)
      else continue
      n++
    }
    if (!n) return ed.ctx.status('Nothing to mirror: select geometry first', 'warn')
    ed.commit('Mirror')
    ed.setTool(null)
  }
}
