import { addConstraint, type ConstraintKind, type Constraint, type LineCurve, type SketchData } from './model'
import { tangentSide, type Snap, type SketchEditor, type Tool } from './editor'
import { d2, lineEnds, norm, roundOf, TAU, type P2 } from './geom'
import { dimAnchor, dimDraw } from './dimgeom'

/**
 * Draw tools: line (and centreline), rectangles, circles, arcs, slot,
 * polygon, point, plus Smart dimension. Each one previews under the pointer,
 * snaps (ends, midpoints, centres, crossings, model corners) and adds the
 * relations the snaps imply, like SolidCraft / SolidWorks. Typing a number
 * fills the tool's first box; Enter uses it (and adds that dimension).
 */

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: P2, s: number): P2 => [a[0] * s, a[1] * s]
const unit = (a: P2): P2 => {
  const l = Math.hypot(a[0], a[1]) || 1
  return [a[0] / l, a[1] / l]
}
const perp = (a: P2): P2 => [-a[1], a[0]]
const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0]

function circlePoly(c: P2, r: number, a0 = 0, sweep = TAU, n = 96): P2[] {
  const m = Math.max(8, Math.ceil((n * sweep) / TAU))
  return Array.from({ length: m + 1 }, (_, i) => [c[0] + r * Math.cos(a0 + (sweep * i) / m), c[1] + r * Math.sin(a0 + (sweep * i) / m)] as P2)
}

/** Circle through three points (null if they're in a line). */
function circumcircle(a: P2, b: P2, c: P2): { c: P2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-12) return null
  const A = a[0] ** 2 + a[1] ** 2
  const B = b[0] ** 2 + b[1] ** 2
  const C = c[0] ** 2 + c[1] ** 2
  const ux = (A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d
  const uy = (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d
  return { c: [ux, uy], r: d2([ux, uy], a) }
}

/** A dimension with a value already met by the geometry (no check needed). */
function dim(sk: SketchData, kind: ConstraintKind, refs: string[], value: number, label?: [number, number], flag?: number): Constraint {
  return addConstraint(sk, { kind, refs, value, label, flag })
}

const pos = (v: number | null): number | null => (v !== null && v > 0 ? v : null)

// ---- line ---------------------------------------------------------------------------

export class LineTool implements Tool {
  readonly name: string
  private start: { snap: Snap; pid: string | null } | null = null
  private first: string | null = null
  constructor(private ed: SketchEditor, private centreline = false) {
    this.name = centreline ? 'Centreline' : 'Line'
    ed.fields([
      { key: 'len', label: 'Length' },
      { key: 'ang', label: 'Angle' }
    ])
  }
  prompt(): string {
    return this.start ? 'click the end (right-click or Enter ends the chain)' : 'click where the line starts'
  }
  from(): P2 | null {
    return this.start?.snap.p ?? null
  }
  private end(s: Snap): P2 {
    if (!this.start) return s.p
    const a = this.start.snap.p
    const L = pos(this.ed.typedValue('len'))
    const A = this.ed.typedValue('ang')
    let dir = unit(sub(s.p, a))
    if (A !== null) {
      const r = (A * Math.PI) / 180
      dir = [Math.cos(r), Math.sin(r)]
      if (L === null) return add(a, mul(dir, Math.max(0, (s.p[0] - a[0]) * dir[0] + (s.p[1] - a[1]) * dir[1])))
    }
    return L !== null ? add(a, mul(dir, L)) : s.p
  }
  move(s: Snap): void {
    this.ed.clearPreview()
    if (!this.start) return
    const e = this.end(s)
    this.ed.previewLines([[this.start.snap.p, e]], 0xffd166, this.centreline || this.ed.constructionMode)
  }
  click(s: Snap): void {
    if (!this.start) {
      this.start = { snap: s, pid: null }
      return
    }
    const typed = this.ed.typedValue('len') !== null || this.ed.typedValue('ang') !== null
    const endP = this.end(s)
    if (d2(endP, this.start.snap.p) < 1e-6) return
    const sk = this.ed.sk
    const a = this.start.pid ?? this.ed.pointAt(this.start.snap)
    const endSnap: Snap = typed ? { p: endP, kind: 'free' } : s
    if (typed) {
      const dx = endP[0] - this.start.snap.p[0]
      const dy = endP[1] - this.start.snap.p[1]
      if (Math.abs(dy) < 1e-9) endSnap.level = 'h'
      else if (Math.abs(dx) < 1e-9) endSnap.level = 'v'
    }
    const b = this.ed.pointAt(endSnap)
    if (a === b) return
    const id = this.ed.addCurve({ kind: 'line', a, b })
    const line = sk.curves.find((c) => c.id === id)!
    if (this.centreline) line.construction = true
    if (endSnap.level === 'h') addConstraint(sk, { kind: 'horizontal', refs: [id] })
    if (endSnap.level === 'v') addConstraint(sk, { kind: 'vertical', refs: [id] })
    const L = pos(this.ed.typedValue('len'))
    if (L !== null) dim(sk, 'length', [id], L)
    this.first ??= a
    this.ed.commit(this.name)
    this.ed.clearTyped()
    const closed = b === this.first
    this.start = closed ? null : { snap: { p: endP, kind: 'point', point: b }, pid: b }
    if (closed) this.first = null
  }
  typed(): void {
    if (this.start && this.ed.typedValue('len') !== null) this.click({ p: this.end({ p: this.start.snap.p, kind: 'free' }), kind: 'free' })
  }
  finish(): boolean {
    if (!this.start) return false
    this.start = null
    this.first = null
    this.ed.clearPreview()
    return true
  }
  back(): boolean {
    return this.finish()
  }
}

// ---- rectangle ------------------------------------------------------------------------

export type RectMode = 'corner' | 'centre' | '3pt'

export class RectTool implements Tool {
  readonly name: string
  private pts: Snap[] = []
  constructor(private ed: SketchEditor, private mode: RectMode) {
    this.name = mode === 'corner' ? 'Rectangle' : mode === 'centre' ? 'Centre rectangle' : '3-point rectangle'
    ed.fields(
      mode === '3pt'
        ? [{ key: 'h', label: 'Height' }]
        : [
            { key: 'w', label: 'Width' },
            { key: 'h', label: 'Height' }
          ]
    )
  }
  prompt(): string {
    if (this.mode === 'centre') return this.pts.length ? 'click a corner' : 'click the centre'
    if (this.mode === '3pt') return ['click the first corner', 'click the end of the first side', 'click to set the height'][this.pts.length]
    return this.pts.length ? 'click the opposite corner' : 'click the first corner'
  }
  /** Corners anticlockwise from the first. */
  private corners(s: P2): P2[] | null {
    if (this.mode === '3pt') {
      if (this.pts.length < 2) return null
      const a = this.pts[0].p
      const b = this.pts[1].p
      const u = unit(sub(b, a))
      const n = perp(u)
      let h = cross(u, sub(s, a))
      const H = pos(this.ed.typedValue('h'))
      if (H !== null) h = Math.sign(h || 1) * H
      return [a, b, add(b, mul(n, h)), add(a, mul(n, h))]
    }
    if (!this.pts.length) return null
    const p0 = this.pts[0].p
    let dx = s[0] - p0[0]
    let dy = s[1] - p0[1]
    const W = pos(this.ed.typedValue('w'))
    const H = pos(this.ed.typedValue('h'))
    const k = this.mode === 'centre' ? 0.5 : 1
    if (W !== null) dx = Math.sign(dx || 1) * W * k
    if (H !== null) dy = Math.sign(dy || 1) * H * k
    const c = this.mode === 'centre' ? sub(p0, [dx, dy]) : p0
    const o = this.mode === 'centre' ? add(p0, [dx, dy]) : add(p0, [dx, dy])
    return [c, [o[0], c[1]], o, [c[0], o[1]]]
  }
  move(s: Snap): void {
    this.ed.clearPreview()
    if (this.mode === '3pt' && this.pts.length === 1) return this.ed.previewLines([[this.pts[0].p, s.p]])
    const c = this.corners(s.p)
    if (!c) return
    this.ed.previewLines([[...c, c[0]]], 0xffd166, this.ed.constructionMode)
    if (this.mode === 'centre') this.ed.previewLines([[c[0], c[2]], [c[1], c[3]]], 0xd9a35f, true)
  }
  click(s: Snap): void {
    const need = this.mode === '3pt' ? 2 : 1
    if (this.pts.length < need) {
      this.pts.push(s)
      return
    }
    const c = this.corners(s.p)
    if (!c || Math.abs(cross(sub(c[1], c[0]), sub(c[3], c[0]))) < 1e-9) return
    const typed = this.ed.typedValue('w') !== null || this.ed.typedValue('h') !== null
    this.build(c, typed ? null : s)
    this.pts = []
    this.ed.clearTyped()
    this.ed.toolDone()
  }
  private build(c: P2[], last: Snap | null): void {
    const ed = this.ed
    const sk = ed.sk
    const ids: string[] = []
    if (this.mode === 'corner') {
      ids[0] = ed.pointAt(this.pts[0])
      ids[2] = last ? ed.pointAt(last) : ed.pointAt({ p: c[2], kind: 'free' })
      ids[1] = ed.pointAt({ p: c[1], kind: 'free' })
      ids[3] = ed.pointAt({ p: c[3], kind: 'free' })
    } else if (this.mode === '3pt') {
      ids[0] = ed.pointAt(this.pts[0])
      ids[1] = ed.pointAt(this.pts[1])
      ids[2] = ed.pointAt({ p: c[2], kind: 'free' })
      ids[3] = ed.pointAt({ p: c[3], kind: 'free' })
    } else {
      for (let i = 0; i < 4; i++) ids[i] = ed.pointAt(i === 2 && last ? last : { p: c[i], kind: 'free' })
    }
    const lines = ids.map((a, i) => ed.addCurve({ kind: 'line', a, b: ids[(i + 1) % 4] }))
    if (this.mode === '3pt') {
      addConstraint(sk, { kind: 'perpendicular', refs: [lines[0], lines[1]] })
      addConstraint(sk, { kind: 'parallel', refs: [lines[0], lines[2]] })
      addConstraint(sk, { kind: 'parallel', refs: [lines[1], lines[3]] })
      const H = pos(ed.typedValue('h'))
      if (H !== null) dim(sk, 'length', [lines[1]], H)
    } else {
      addConstraint(sk, { kind: 'horizontal', refs: [lines[0]] })
      addConstraint(sk, { kind: 'horizontal', refs: [lines[2]] })
      addConstraint(sk, { kind: 'vertical', refs: [lines[1]] })
      addConstraint(sk, { kind: 'vertical', refs: [lines[3]] })
      const W = pos(ed.typedValue('w'))
      const H = pos(ed.typedValue('h'))
      const px = ed.px
      if (W !== null) dim(sk, 'length', [lines[0]], W, [0, -18 * px * Math.sign(c[3][1] - c[0][1] || 1)])
      if (H !== null) dim(sk, 'length', [lines[3]], H, [-24 * px * Math.sign(c[1][0] - c[0][0] || 1), 0])
    }
    if (this.mode === 'centre') {
      const d1 = ed.addCurve({ kind: 'line', a: ids[0], b: ids[2] })
      const d2_ = ed.addCurve({ kind: 'line', a: ids[1], b: ids[3] })
      for (const d of [d1, d2_]) sk.curves.find((x) => x.id === d)!.construction = true
      const centre = ed.pointAt(this.pts[0])
      addConstraint(sk, { kind: 'midpoint', refs: [centre, d1] })
      addConstraint(sk, { kind: 'midpoint', refs: [centre, d2_] })
    }
    ed.commit(this.name)
  }
  typed(): void {
    if (this.pts.length && (this.mode !== '3pt' || this.pts.length === 2)) {
      const c = this.corners(this.pts[0].p)
      if (c) this.click({ p: c[2], kind: 'free' })
    }
  }
  back(): boolean {
    if (!this.pts.length) return false
    this.pts.pop()
    this.ed.clearPreview()
    return true
  }
}

// ---- circle -------------------------------------------------------------------------------

export type CircleMode = 'centre' | '3pt' | '2pt'

export class CircleTool implements Tool {
  readonly name: string
  private pts: Snap[] = []
  constructor(private ed: SketchEditor, private mode: CircleMode) {
    this.name = mode === 'centre' ? 'Circle' : mode === '3pt' ? '3-point circle' : '2-point circle'
    ed.fields([{ key: 'd', label: 'Ø' }])
  }
  prompt(): string {
    if (this.mode === 'centre') return this.pts.length ? 'click a point on the circle (or type the diameter)' : 'click the centre'
    return `click point ${this.pts.length + 1} on the circle`
  }
  private circle(s: P2): { c: P2; r: number } | null {
    const D = pos(this.ed.typedValue('d'))
    if (this.mode === 'centre') {
      if (!this.pts.length) return null
      return { c: this.pts[0].p, r: D !== null ? D / 2 : d2(s, this.pts[0].p) }
    }
    if (this.mode === '2pt') {
      if (!this.pts.length) return null
      const a = this.pts[0].p
      const u = unit(sub(s, a))
      const r = D !== null ? D / 2 : d2(a, s) / 2
      return { c: add(a, mul(u, r)), r }
    }
    if (this.pts.length < 2) return null
    return circumcircle(this.pts[0].p, this.pts[1].p, s)
  }
  move(s: Snap): void {
    this.ed.clearPreview()
    if (this.mode === '3pt' && this.pts.length === 1) return this.ed.previewLines([[this.pts[0].p, s.p]], 0xffd166, true)
    const c = this.circle(s.p)
    if (c) this.ed.previewLines([circlePoly(c.c, c.r)], 0xffd166, this.ed.constructionMode)
  }
  click(s: Snap): void {
    const need = this.mode === '3pt' ? 2 : 1
    if (this.pts.length < need) {
      this.pts.push(s)
      return
    }
    const c = this.circle(s.p)
    if (!c || c.r < 1e-6) return
    const ed = this.ed
    const sk = ed.sk
    const centre = this.mode === 'centre' ? ed.pointAt(this.pts[0]) : ed.pointAt({ p: c.c, kind: 'free' })
    const id = ed.addCurve({ kind: 'circle', c: centre, r: c.r })
    const D = pos(ed.typedValue('d'))
    // Points it was drawn through stay on it.
    const through = this.mode === 'centre' ? (D === null ? [s] : []) : D === null ? [...this.pts, s] : this.pts
    for (const t of through) if (t.kind === 'point' && t.point) addConstraint(sk, { kind: 'onCurve', refs: [t.point, id] })
    if (D !== null) dim(sk, 'diameter', [id], D, [c.r * 0.7 + 10 * ed.px, c.r * 0.7 + 10 * ed.px])
    ed.commit(this.name)
    this.pts = []
    ed.clearTyped()
    ed.toolDone()
  }
  typed(): void {
    if (this.mode === 'centre' && this.pts.length && this.ed.typedValue('d') !== null) this.click({ p: this.pts[0].p, kind: 'free' })
  }
  back(): boolean {
    if (!this.pts.length) return false
    this.pts.pop()
    this.ed.clearPreview()
    return true
  }
}

// ---- arc ---------------------------------------------------------------------------------

export type ArcMode = 'centre' | '3pt' | 'tangent'

export class ArcTool implements Tool {
  readonly name: string
  private pts: Snap[] = []
  /** Centre-point arcs: which way round the pointer has gone (+ anticlockwise). */
  private turn = 0
  private lastAng = 0
  private tan: { pid: string; dir: P2; curve: string } | null = null
  constructor(private ed: SketchEditor, private mode: ArcMode) {
    this.name = mode === 'centre' ? 'Centre-point arc' : mode === '3pt' ? '3-point arc' : 'Tangent arc'
    ed.fields([{ key: 'r', label: 'Radius' }])
  }
  prompt(): string {
    if (this.mode === 'centre') return ['click the centre', 'click the start (sets the radius)', 'click the end'][this.pts.length]
    if (this.mode === '3pt') return ['click the start', 'click the end', 'click a point the arc passes through'][this.pts.length]
    return this.pts.length ? 'click the end of the arc' : 'click the end of a line or arc to continue from'
  }
  /** Arc as centre / radius / start angle / sweep (anticlockwise). */
  private arc(s: P2): { c: P2; r: number; a0: number; sweep: number; rev: boolean } | null {
    const R = pos(this.ed.typedValue('r'))
    if (this.mode === 'centre') {
      if (this.pts.length < 2) return null
      const c = this.pts[0].p
      const r = R ?? d2(c, this.pts[1].p)
      const a0 = Math.atan2(this.pts[1].p[1] - c[1], this.pts[1].p[0] - c[0])
      const a1 = Math.atan2(s[1] - c[1], s[0] - c[0])
      const ccw = norm(a1 - a0)
      if (this.turn >= 0) return { c, r, a0, sweep: ccw || TAU, rev: false }
      return { c, r, a0: a1, sweep: TAU - ccw || TAU, rev: true }
    }
    if (this.mode === '3pt') {
      if (this.pts.length < 2) return null
      const a = this.pts[0].p
      const b = this.pts[1].p
      let cc = circumcircle(a, b, s)
      if (R !== null) {
        // Fixed radius: centre on the side of the chord the pointer is on.
        const m = mul(add(a, b), 0.5)
        const half = d2(a, b) / 2
        if (R < half) return null
        const n = perp(unit(sub(b, a)))
        const h = Math.sqrt(R * R - half * half)
        const side = cross(sub(b, a), sub(s, a)) > 0 ? -1 : 1
        cc = { c: add(m, mul(n, h * side)), r: R }
      }
      if (!cc) return null
      const aa = Math.atan2(a[1] - cc.c[1], a[0] - cc.c[0])
      const ab = Math.atan2(b[1] - cc.c[1], b[0] - cc.c[0])
      const am = Math.atan2(s[1] - cc.c[1], s[0] - cc.c[0])
      // Anticlockwise from a to b passes through the pointer? Otherwise go the other way.
      if (norm(am - aa) <= norm(ab - aa)) return { c: cc.c, r: cc.r, a0: aa, sweep: norm(ab - aa), rev: false }
      return { c: cc.c, r: cc.r, a0: ab, sweep: norm(aa - ab), rev: true }
    }
    if (!this.tan || !this.pts.length) return null
    const p = this.pts[0].p
    const t = this.tan.dir
    const n = perp(t)
    const e = sub(s, p)
    const dn = e[0] * n[0] + e[1] * n[1]
    if (Math.abs(dn) < 1e-9) return null
    const r = (e[0] * e[0] + e[1] * e[1]) / (2 * dn)
    const c = add(p, mul(n, r))
    const a0 = Math.atan2(p[1] - c[1], p[0] - c[0])
    const a1 = Math.atan2(s[1] - c[1], s[0] - c[0])
    if (r > 0) return { c, r, a0, sweep: norm(a1 - a0), rev: false }
    return { c, r: -r, a0: a1, sweep: norm(a0 - a1), rev: true }
  }
  move(s: Snap): void {
    this.ed.clearPreview()
    if (this.mode === 'centre' && this.pts.length === 2) {
      const c = this.pts[0].p
      const ang = Math.atan2(s.p[1] - c[1], s.p[0] - c[0])
      let d = ang - this.lastAng
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.turn += d
      this.lastAng = ang
    }
    if (this.mode === 'centre' && this.pts.length === 1) return this.ed.previewLines([[this.pts[0].p, s.p]], 0xffd166, true)
    if (this.mode === '3pt' && this.pts.length === 1) return this.ed.previewLines([[this.pts[0].p, s.p]], 0xffd166, true)
    const a = this.arc(s.p)
    if (a && a.sweep > 1e-6) this.ed.previewLines([circlePoly(a.c, a.r, a.a0, a.sweep)], 0xffd166, this.ed.constructionMode)
  }
  click(s: Snap): void {
    const ed = this.ed
    if (this.mode === 'tangent' && !this.pts.length) {
      const t = this.tangentFrom(s)
      if (!t) return ed.ctx.status('Click the end of a line or arc', 'warn')
      this.tan = t
      this.pts.push(s)
      return
    }
    const need = this.mode === 'tangent' ? 1 : 2
    if (this.pts.length < need) {
      this.pts.push(s)
      if (this.mode === 'centre' && this.pts.length === 2) {
        const c = this.pts[0].p
        this.lastAng = Math.atan2(s.p[1] - c[1], s.p[0] - c[0])
        this.turn = 0
      }
      return
    }
    const a = this.arc(s.p)
    if (!a || a.sweep < 1e-6 || a.r < 1e-6) return
    const sk = ed.sk
    const pStart: P2 = [a.c[0] + a.r * Math.cos(a.a0), a.c[1] + a.r * Math.sin(a.a0)]
    const pEnd: P2 = [a.c[0] + a.r * Math.cos(a.a0 + a.sweep), a.c[1] + a.r * Math.sin(a.a0 + a.sweep)]
    const R = pos(ed.typedValue('r'))
    let first: string
    let last: string
    let centre: string
    if (this.mode === 'centre') {
      centre = ed.pointAt(this.pts[0])
      const st = ed.pointAt(R !== null ? { p: a.rev ? pEnd : pStart, kind: 'free' } : this.pts[1])
      const en = ed.pointAt(s.kind === 'point' ? s : { p: a.rev ? pStart : pEnd, kind: 'free' })
      ;[first, last] = a.rev ? [en, st] : [st, en]
    } else if (this.mode === '3pt') {
      centre = ed.pointAt({ p: a.c, kind: 'free' })
      const st = ed.pointAt(this.pts[0])
      const en = ed.pointAt(this.pts[1])
      ;[first, last] = a.rev ? [en, st] : [st, en]
    } else {
      centre = ed.pointAt({ p: a.c, kind: 'free' })
      const st = this.tan!.pid
      const en = ed.pointAt(s)
      ;[first, last] = a.rev ? [en, st] : [st, en]
    }
    const id = ed.addCurve({ kind: 'arc', c: centre, a: first, b: last })
    if (this.mode === 'tangent') {
      addConstraint(sk, { kind: 'tangent', refs: [this.tan!.curve, id], flag: tangentSide(ed, this.tan!.curve, id) })
    }
    if (R !== null) dim(sk, 'radius', [id], R, [a.r * Math.cos(a.a0 + a.sweep / 2) * 0.6, a.r * Math.sin(a.a0 + a.sweep / 2) * 0.6])
    ed.commit(this.name)
    ed.clearTyped()
    if (this.mode === 'tangent') {
      // Keep going from the new end, tangent to this arc.
      const endPid = a.rev ? first : last
      const t = this.tangentFrom({ p: a.rev ? pStart : pEnd, kind: 'point', point: endPid })
      this.pts = t ? [{ p: a.rev ? pStart : pEnd, kind: 'point', point: endPid }] : []
      this.tan = t
    } else this.pts = []
    ed.toolDone()
  }
  /** Direction to leave a line / arc end in, so the new arc carries on smoothly. */
  private tangentFrom(s: Snap): { pid: string; dir: P2; curve: string } | null {
    if (s.kind !== 'point' || !s.point) return null
    const ix = this.ed.ix()
    for (const c of ix.curvesAt(s.point)) {
      if (c.kind === 'line') {
        const [a, b] = lineEnds(ix, c)
        return { pid: s.point, dir: unit(c.b === s.point ? sub(b, a) : sub(a, b)), curve: c.id }
      }
      if (c.kind === 'arc') {
        const r = roundOf(ix, c)
        const atEnd = c.b === s.point
        const ang = atEnd ? r.a0 + r.sweep : r.a0
        const t: P2 = [-Math.sin(ang), Math.cos(ang)]
        return { pid: s.point, dir: atEnd ? t : mul(t, -1), curve: c.id }
      }
    }
    return null
  }
  finish(): boolean {
    if (!this.pts.length) return false
    this.pts = []
    this.tan = null
    this.ed.clearPreview()
    return true
  }
  back(): boolean {
    if (!this.pts.length) return false
    this.pts.pop()
    if (!this.pts.length) this.tan = null
    this.ed.clearPreview()
    return true
  }
}

// ---- point ---------------------------------------------------------------------------------

export class PointTool implements Tool {
  readonly name = 'Point'
  constructor(private ed: SketchEditor) {
    ed.fields([])
  }
  prompt(): string {
    return 'click to place points'
  }
  move(): void {}
  click(s: Snap): void {
    if (s.kind === 'point') return
    this.ed.pointAt(s)
    this.ed.commit('Point')
  }
}

// ---- slot --------------------------------------------------------------------------------

export class SlotTool implements Tool {
  readonly name = 'Slot'
  private pts: Snap[] = []
  constructor(private ed: SketchEditor) {
    ed.fields([{ key: 'w', label: 'Width' }])
  }
  prompt(): string {
    return ['click the first centre', 'click the second centre', 'click to set the width'][this.pts.length]
  }
  private shape(s: P2): { c1: P2; c2: P2; r: number; u: P2; n: P2 } | null {
    if (this.pts.length < 2) return null
    const c1 = this.pts[0].p
    const c2 = this.pts[1].p
    const u = unit(sub(c2, c1))
    const n = perp(u)
    const W = pos(this.ed.typedValue('w'))
    const r = W !== null ? W / 2 : Math.abs(cross(u, sub(s, c1)))
    return r > 1e-6 ? { c1, c2, r, u, n } : null
  }
  private outline(g: { c1: P2; c2: P2; r: number; u: P2; n: P2 }): P2[] {
    const ang = Math.atan2(g.u[1], g.u[0])
    return [...circlePoly(g.c2, g.r, ang - Math.PI / 2, Math.PI, 48), ...circlePoly(g.c1, g.r, ang + Math.PI / 2, Math.PI, 48), add(g.c2, mul(g.n, -g.r))]
  }
  move(s: Snap): void {
    this.ed.clearPreview()
    if (this.pts.length === 1) return this.ed.previewLines([[this.pts[0].p, s.p]], 0xd9a35f, true)
    const g = this.shape(s.p)
    if (g) this.ed.previewLines([this.outline(g)])
  }
  click(s: Snap): void {
    if (this.pts.length < 2) {
      if (this.pts.length === 1 && d2(this.pts[0].p, s.p) < 1e-6) return
      this.pts.push(s)
      return
    }
    const g = this.shape(s.p)
    if (!g) return
    const ed = this.ed
    const sk = ed.sk
    const c1 = ed.pointAt(this.pts[0])
    const c2 = ed.pointAt(this.pts[1])
    const P = (p: P2): string => ed.pointAt({ p, kind: 'free' })
    const A1 = P(add(g.c1, mul(g.n, g.r)))
    const B1 = P(add(g.c2, mul(g.n, g.r)))
    const A2 = P(add(g.c1, mul(g.n, -g.r)))
    const B2 = P(add(g.c2, mul(g.n, -g.r)))
    const axis = ed.addCurve({ kind: 'line', a: c1, b: c2 })
    sk.curves.find((c) => c.id === axis)!.construction = true
    const l1 = ed.addCurve({ kind: 'line', a: A1, b: B1 })
    const l2 = ed.addCurve({ kind: 'line', a: B2, b: A2 })
    const arc2 = ed.addCurve({ kind: 'arc', c: c2, a: B2, b: B1 })
    const arc1 = ed.addCurve({ kind: 'arc', c: c1, a: A1, b: A2 })
    for (const l of [l1, l2]) for (const a of [arc1, arc2]) addConstraint(sk, { kind: 'tangent', refs: [l, a], flag: tangentSide(ed, l, a) })
    addConstraint(sk, { kind: 'equal', refs: [arc1, arc2] })
    const lev = this.pts[1].level ?? (Math.abs(g.u[1]) < 1e-9 ? 'h' : Math.abs(g.u[0]) < 1e-9 ? 'v' : undefined)
    if (lev === 'h') addConstraint(sk, { kind: 'horizontal', refs: [axis] })
    if (lev === 'v') addConstraint(sk, { kind: 'vertical', refs: [axis] })
    const W = pos(ed.typedValue('w'))
    if (W !== null) dim(sk, 'diameter', [arc2], W, mul(add(g.u, g.n), g.r * 1.3))
    ed.commit('Slot')
    this.pts = []
    ed.clearTyped()
    ed.toolDone()
  }
  typed(): void {
    if (this.pts.length === 2) this.click({ p: this.pts[1].p, kind: 'free' })
  }
  back(): boolean {
    if (!this.pts.length) return false
    this.pts.pop()
    this.ed.clearPreview()
    return true
  }
}

// ---- polygon ---------------------------------------------------------------------------------

export class PolygonTool implements Tool {
  readonly name: string
  private centre: Snap | null = null
  constructor(private ed: SketchEditor, private inscribed: boolean) {
    this.name = inscribed ? 'Polygon (inscribed)' : 'Polygon (circumscribed)'
    ed.fields([
      { key: 'n', label: 'Sides', value: 6, int: true },
      { key: 'd', label: inscribed ? 'Ø corners' : 'Ø flats' }
    ])
  }
  prompt(): string {
    return this.centre ? (this.inscribed ? 'click a corner' : 'click the middle of a side') : 'click the centre'
  }
  private sides(): number {
    const n = Math.round(this.ed.typedValue('n') ?? 6)
    return Math.max(3, Math.min(64, n))
  }
  private corners(s: P2): { pts: P2[]; r: number; R: number } | null {
    if (!this.centre) return null
    const c = this.centre.p
    const n = this.sides()
    const D = pos(this.ed.typedValue('d'))
    let ang = Math.atan2(s[1] - c[1], s[0] - c[0])
    let r = D !== null ? D / 2 : d2(c, s)
    if (r < 1e-6) return null
    // Circumscribed: the pointer marks a side's middle, so corners sit half a step round.
    let R = r
    if (!this.inscribed) {
      R = r / Math.cos(Math.PI / n)
      ang += Math.PI / n
    } else r = R * Math.cos(Math.PI / n)
    const pts = Array.from({ length: n }, (_, i) => [c[0] + R * Math.cos(ang + (TAU * i) / n), c[1] + R * Math.sin(ang + (TAU * i) / n)] as P2)
    return { pts, r, R }
  }
  move(s: Snap): void {
    this.ed.clearPreview()
    const g = this.corners(s.p)
    if (!g || !this.centre) return
    this.ed.previewLines([[...g.pts, g.pts[0]]], 0xffd166, this.ed.constructionMode)
    this.ed.previewLines([circlePoly(this.centre.p, this.inscribed ? g.R : g.r)], 0xd9a35f, true)
  }
  click(s: Snap): void {
    if (!this.centre) {
      this.centre = s
      return
    }
    const g = this.corners(s.p)
    if (!g) return
    const ed = this.ed
    const sk = ed.sk
    const c = ed.pointAt(this.centre)
    const ids = g.pts.map((p) => ed.pointAt({ p, kind: 'free' }))
    const lines = ids.map((a, i) => ed.addCurve({ kind: 'line', a, b: ids[(i + 1) % ids.length] }))
    const outer = ed.addCurve({ kind: 'circle', c, r: g.R })
    sk.curves.find((x) => x.id === outer)!.construction = true
    for (const p of ids) addConstraint(sk, { kind: 'onCurve', refs: [p, outer] })
    for (let i = 1; i < lines.length; i++) addConstraint(sk, { kind: 'equal', refs: [lines[0], lines[i]] })
    const D = pos(ed.typedValue('d'))
    let sized = outer
    if (!this.inscribed) {
      const inner = ed.addCurve({ kind: 'circle', c, r: g.r })
      sk.curves.find((x) => x.id === inner)!.construction = true
      addConstraint(sk, { kind: 'tangent', refs: [lines[0], inner], flag: tangentSide(ed, lines[0], inner) })
      sized = inner
    }
    if (D !== null) dim(sk, 'diameter', [sized], D, [g.R * 0.8, g.R * 0.8])
    ed.commit(this.name)
    this.centre = null
    ed.toolDone()
  }
  typed(): void {
    if (this.centre && this.ed.typedValue('d') !== null) this.click({ p: add(this.centre.p, [1, 0]), kind: 'free' })
  }
  back(): boolean {
    if (!this.centre) return false
    this.centre = null
    this.ed.clearPreview()
    return true
  }
}

// ---- smart dimension -------------------------------------------------------------------------

/**
 * Smart dimension (D): click one item (line = length, circle = Ø, arc = R) or
 * two (point / line / circle pairs: distance, angle between lines), then click
 * where the text goes. Moving the text above / beside two points picks a
 * horizontal / vertical distance instead of the straight one. The value box
 * opens straight away, with a drag handle.
 */
export class DimensionTool implements Tool {
  readonly name = 'Smart dimension'
  private picks: string[] = []
  private last: P2 | null = null
  private showing = ''
  constructor(private ed: SketchEditor) {
    ed.fields([])
  }
  prompt(): string {
    if (!this.picks.length) return 'click a line, circle, arc or point'
    if (this.picks.length === 1) return this.single() ? `click where the dimension goes${this.showing ? ` (${this.showing})` : ''}, or a second item` : 'click a second item'
    return `click where the dimension goes${this.showing ? ` (${this.showing})` : ''}`
  }
  private single(): boolean {
    return !!this.picks.length && !!this.ed.ix().curve(this.picks[0])
  }
  /** The dimension the picks + text position make (without value). */
  private spec(q: P2): Omit<Constraint, 'id' | 'value'> | null {
    const ix = this.ed.ix()
    const kindOf = (id: string): 'point' | 'line' | 'round' => (ix.pts.has(id) ? 'point' : ix.curve(id)?.kind === 'line' ? 'line' : 'round')
    const centreOf = (id: string): string => (ix.curve(id) as { c: string }).c
    const pointPair = (a: string, b: string): Omit<Constraint, 'id' | 'value'> => {
      const A = ix.p(a)
      const B = ix.p(b)
      const minX = Math.min(A.x, B.x)
      const maxX = Math.max(A.x, B.x)
      const minY = Math.min(A.y, B.y)
      const maxY = Math.max(A.y, B.y)
      const withinX = q[0] >= minX && q[0] <= maxX
      const withinY = q[1] >= minY && q[1] <= maxY
      if (withinX && !withinY && maxX - minX > 1e-9) return { kind: 'distanceX', refs: [a, b], flag: Math.sign(B.x - A.x) || 1 }
      if (withinY && !withinX && maxY - minY > 1e-9) return { kind: 'distanceY', refs: [a, b], flag: Math.sign(B.y - A.y) || 1 }
      return { kind: 'distance', refs: [a, b] }
    }
    const [a, b] = this.picks
    if (this.picks.length === 1) {
      const k = kindOf(a)
      if (k === 'point') return null
      if (k === 'line') {
        const c = ix.curve(a) as { a: string; b: string }
        const s = pointPair(c.a, c.b)
        return s.kind === 'distance' ? { kind: 'length', refs: [a] } : s
      }
      return { kind: ix.curve(a)!.kind === 'circle' ? 'diameter' : 'radius', refs: [a] }
    }
    const ka = kindOf(a)
    const kb = kindOf(b)
    const side = (p: string, l: string): number => {
      const c = ix.curve(l)
      if (c?.kind !== 'line') return 1
      const [s, e] = lineEnds(ix, c)
      const P = ix.p(p)
      return Math.sign(cross(sub(e, s), sub([P.x, P.y], s))) || 1
    }
    if (ka === 'point' && kb === 'point') return pointPair(a, b)
    if (ka === 'point' && kb === 'line') return { kind: 'pointLine', refs: [a, b], flag: side(a, b) }
    if (ka === 'line' && kb === 'point') return { kind: 'pointLine', refs: [b, a], flag: side(b, a) }
    if (ka === 'round' && kb === 'round') return pointPair(centreOf(a), centreOf(b))
    if (ka === 'round' && kb === 'point') return pointPair(centreOf(a), b)
    if (ka === 'point' && kb === 'round') return pointPair(a, centreOf(b))
    if (ka === 'round' && kb === 'line') return { kind: 'pointLine', refs: [centreOf(a), b], flag: side(centreOf(a), b) }
    if (ka === 'line' && kb === 'round') return { kind: 'pointLine', refs: [centreOf(b), a], flag: side(centreOf(b), a) }
    // Two lines: parallel ones get the gap between them, others the angle on the pointer's side.
    const l1 = ix.curve(a) as LineCurve
    const l2 = ix.curve(b) as LineCurve
    const [p, q1] = lineEnds(ix, l1)
    const [r, s2] = lineEnds(ix, l2)
    const u1 = unit(sub(q1, p))
    const u2 = unit(sub(s2, r))
    if (Math.abs(cross(u1, u2)) < 1e-6) return { kind: 'pointLine', refs: [l2.a, a], flag: side(l2.a, a) }
    const v = dimAnchor(ix, { id: '?', kind: 'angle', refs: [a, b] })
    const w = sub(q, v)
    let flag = 0
    if (w[0] * u1[0] + w[1] * u1[1] < 0) flag |= 1
    if (w[0] * u2[0] + w[1] * u2[1] < 0) flag |= 2
    return { kind: 'angle', refs: [a, b], flag }
  }
  move(s: Snap, e: PointerEvent): void {
    const ed = this.ed
    const q = ed.local(e)
    if (!q) return
    this.last = q
    ed.clearPreview()
    const ready = this.picks.length === 2 || this.single()
    const hit = this.picks.length < 2 ? ed.itemAt(q) : null
    ed.setHover(hit && !this.picks.includes(hit) ? hit : null)
    if (!ready || (hit && !this.picks.includes(hit) && this.picks.length < 2)) return
    const spec = this.spec(q)
    if (!spec) return
    const trial = structuredClone(ed.sk)
    const k: Constraint = { ...spec, id: '__preview', driven: true, value: 0 }
    const anchor = dimAnchor(ed.ix(), k)
    k.label = [q[0] - anchor[0], q[1] - anchor[1]]
    trial.constraints.push(k)
    const d = dimDraw(trial, k, ed.px)
    if (!d) return
    const segs: P2[][] = []
    for (let i = 0; i + 1 < d.segs.length; i += 2) segs.push([d.segs[i], d.segs[i + 1]])
    ed.previewLines(segs, 0xffd166)
    this.showing = d.label.replace(/[()]/g, '')
    ed.say()
    void s
  }
  click(_s: Snap, e: PointerEvent): void {
    const ed = this.ed
    const q = ed.local(e)
    if (!q) return
    const hit = ed.itemAt(q)
    if (hit && this.picks.length < 2 && !this.picks.includes(hit)) {
      this.picks.push(hit)
      ed.select(this.picks)
      return
    }
    const ready = this.picks.length === 2 || this.single()
    if (!ready) return
    const spec = this.spec(q)
    if (!spec) return
    const anchor = dimAnchor(ed.ix(), { ...spec, id: '?' } as Constraint)
    const k = ed.addDimension({ ...spec, label: [q[0] - anchor[0], q[1] - anchor[1]] })
    this.picks = []
    this.showing = ''
    ed.select([])
    ed.clearPreview()
    if (!k.driven) ed.editValue(k.id)
  }
  back(): boolean {
    if (!this.picks.length) return false
    this.picks.pop()
    this.ed.select(this.picks)
    this.ed.clearPreview()
    return true
  }
  finish(): boolean {
    return this.back()
  }
  dispose(): void {
    this.ed.setHover(null)
  }
}

