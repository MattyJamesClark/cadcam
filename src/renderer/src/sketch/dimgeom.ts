import { type Constraint, type SketchData, SketchIndex } from './model'
import { measureDim } from './solver'
import { d2, lineEnds, roundOf, type P2 } from './geom'
import { fmt } from '@/core/toolpanel'

/**
 * Where a dimension draws: its witness / dimension lines and arrow heads (in
 * sketch coordinates) and where the text goes. The text position is stored as
 * an offset from the dimension's anchor, so it follows the geometry.
 */

export interface DimDraw {
  /** Pairs of points: line segments. */
  segs: P2[]
  /** Triangles (3 points each) for arrow heads. */
  tris: P2[]
  text: P2
  label: string
  anchor: P2
}

const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]]
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]]
const mul = (a: P2, s: number): P2 => [a[0] * s, a[1] * s]
const unit = (a: P2): P2 => {
  const l = Math.hypot(a[0], a[1]) || 1
  return [a[0] / l, a[1] / l]
}
const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1]

export function dimText(k: Constraint, value: number): string {
  const v = fmt(value)
  const t = k.kind === 'diameter' ? `Ø${v}` : k.kind === 'radius' ? `R${v}` : k.kind === 'angle' ? `${v}°` : v
  return k.driven ? `(${t})` : t
}

/** The anchor a dimension's text offset is measured from. */
export function dimAnchor(ix: SketchIndex, k: Constraint): P2 {
  const P = (id: string): P2 => {
    const p = ix.p(id)
    return [p.x, p.y]
  }
  switch (k.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY': {
      const a = P(k.refs[0])
      const b = P(k.refs[1])
      return mul(add(a, b), 0.5)
    }
    case 'length': {
      const c = ix.curve(k.refs[0])
      if (c?.kind !== 'line') return [0, 0]
      const [a, b] = lineEnds(ix, c)
      return mul(add(a, b), 0.5)
    }
    case 'pointLine': {
      const p = P(k.refs[0])
      const c = ix.curve(k.refs[1])
      if (c?.kind !== 'line') return p
      return mul(add(p, foot(ix, k.refs[1], p)), 0.5)
    }
    case 'radius':
    case 'diameter': {
      const c = ix.curve(k.refs[0])
      if (!c || c.kind === 'line') return [0, 0]
      return roundOf(ix, c).c
    }
    case 'angle':
      return angleVertex(ix, k)
    default:
      return [0, 0]
  }
}

function foot(ix: SketchIndex, lineId: string, p: P2): P2 {
  const c = ix.curve(lineId)
  if (c?.kind !== 'line') return p
  const [a, b] = lineEnds(ix, c)
  const d = unit(sub(b, a))
  return add(a, mul(d, dot(sub(p, a), d)))
}

function angleVertex(ix: SketchIndex, k: Constraint): P2 {
  const c1 = ix.curve(k.refs[0])
  const c2 = ix.curve(k.refs[1])
  if (c1?.kind !== 'line' || c2?.kind !== 'line') return [0, 0]
  const [a, b] = lineEnds(ix, c1)
  const [c, d] = lineEnds(ix, c2)
  const r = sub(b, a)
  const q = sub(d, c)
  const den = r[0] * q[1] - r[1] * q[0]
  if (Math.abs(den) < 1e-12) return mul(add(a, c), 0.5)
  const w = sub(c, a)
  const s = (w[0] * q[1] - w[1] * q[0]) / den
  return add(a, mul(r, s))
}

export function dimDraw(s: SketchData, k: Constraint, px: number, ix = new SketchIndex(s)): DimDraw | null {
  const value = k.driven ? measureDim(s, k, ix) : (k.value ?? 0)
  const label = dimText(k, value)
  const anchor = dimAnchor(ix, k)
  const off: P2 = k.label ? [k.label[0], k.label[1]] : [0, 14 * px]
  const text = add(anchor, off)
  const segs: P2[] = []
  const tris: P2[] = []
  const arrow = (tip: P2, dir: P2): void => {
    const d = unit(dir)
    const n: P2 = [-d[1], d[0]]
    const L = 9 * px
    const W = 3 * px
    const base = sub(tip, mul(d, L))
    tris.push(tip, add(base, mul(n, W)), sub(base, mul(n, W)))
  }
  const gap = 3 * px
  const over = 4 * px
  /** Linear dimension between a and b measured along unit u. */
  const linear = (a: P2, b: P2, u: P2): void => {
    const n: P2 = [-u[1], u[0]]
    const h = dot(sub(text, a), n)
    const hb = dot(sub(text, b), n)
    const A = add(a, mul(n, h))
    // Dimension line ends: a and b projected on the line through the text.
    const B = add(A, mul(u, dot(sub(b, a), u)))
    const sgn = (x: number): number => (x >= 0 ? 1 : -1)
    segs.push(add(a, mul(n, sgn(h) * gap)), add(A, mul(n, sgn(h) * over)))
    segs.push(add(b, mul(n, sgn(hb) * gap)), add(B, mul(n, sgn(hb) * over)))
    segs.push(A, B)
    // Text past the ends: extend the line to it.
    const t = dot(sub(text, A), u)
    const Lab = dot(sub(B, A), u)
    if (t < 0) segs.push(A, add(A, mul(u, t)))
    else if (t > Lab) segs.push(B, add(A, mul(u, t)))
    if (Math.abs(Lab) > 1e-9) {
      arrow(A, mul(u, -sgn(Lab)))
      arrow(B, mul(u, sgn(Lab)))
    }
  }
  const P = (id: string): P2 => {
    const p = ix.p(id)
    return [p.x, p.y]
  }
  try {
    switch (k.kind) {
      case 'distance': {
        const a = P(k.refs[0])
        const b = P(k.refs[1])
        if (d2(a, b) < 1e-9) return { segs, tris, text, label, anchor }
        linear(a, b, unit(sub(b, a)))
        break
      }
      case 'length': {
        const c = ix.curve(k.refs[0])
        if (c?.kind !== 'line') return null
        const [a, b] = lineEnds(ix, c)
        linear(a, b, unit(sub(b, a)))
        break
      }
      case 'distanceX':
        linear(P(k.refs[0]), P(k.refs[1]), [1, 0])
        break
      case 'distanceY':
        linear(P(k.refs[0]), P(k.refs[1]), [0, 1])
        break
      case 'pointLine': {
        const p = P(k.refs[0])
        const f = foot(ix, k.refs[1], p)
        if (d2(p, f) < 1e-9) break
        linear(p, f, unit(sub(f, p)))
        // Witness along the line to the foot, so it is clear where it is measured.
        const c = ix.curve(k.refs[1])
        if (c?.kind === 'line') {
          const [a, b] = lineEnds(ix, c)
          const near = d2(a, f) < d2(b, f) ? a : b
          segs.push(near, f)
        }
        break
      }
      case 'radius':
      case 'diameter': {
        const c = ix.curve(k.refs[0])
        if (!c || c.kind === 'line') return null
        const r = roundOf(ix, c)
        const dir = unit(sub(text, r.c))
        const rim = add(r.c, mul(dir, r.r))
        if (k.kind === 'diameter') {
          const far = sub(r.c, mul(dir, r.r))
          segs.push(far, text)
          arrow(rim, dir)
          arrow(far, mul(dir, -1))
        } else {
          segs.push(r.c, text)
          arrow(rim, dir)
        }
        break
      }
      case 'angle': {
        const c1 = ix.curve(k.refs[0])
        const c2 = ix.curve(k.refs[1])
        if (c1?.kind !== 'line' || c2?.kind !== 'line') return null
        const v = anchor
        const f = k.flag ?? 0
        const [a, b] = lineEnds(ix, c1)
        const [c, d] = lineEnds(ix, c2)
        const u1 = unit((f & 1) !== 0 ? sub(a, b) : sub(b, a))
        const u2 = unit((f & 2) !== 0 ? sub(c, d) : sub(d, c))
        const rad = Math.max(d2(text, v), 6 * px)
        const a0 = Math.atan2(u1[1], u1[0])
        let sw = Math.atan2(u2[1], u2[0]) - a0
        sw = Math.atan2(Math.sin(sw), Math.cos(sw))
        const n = 32
        let prev: P2 | null = null
        for (let i = 0; i <= n; i++) {
          const t = a0 + (sw * i) / n
          const p: P2 = [v[0] + rad * Math.cos(t), v[1] + rad * Math.sin(t)]
          if (prev) segs.push(prev, p)
          prev = p
        }
        // Witness lines from the nearer end of each line out to the arc.
        for (const [u, ends] of [
          [u1, [a, b]],
          [u2, [c, d]]
        ] as [P2, P2[]][]) {
          const tip = add(v, mul(u, rad))
          const reach = Math.max(...ends.map((e) => dot(sub(e, v), u)))
          if (reach < rad) segs.push(add(v, mul(u, Math.max(reach, 0) + gap)), add(tip, mul(u, over)))
        }
        const s = Math.sign(sw) || 1
        arrow(add(v, mul(u1, rad)), [s * u1[1], -s * u1[0]])
        arrow(add(v, mul(u2, rad)), [-s * u2[1], s * u2[0]])
        break
      }
      default:
        return null
    }
  } catch {
    return null
  }
  return { segs, tris, text, label, anchor }
}
