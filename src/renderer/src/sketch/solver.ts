import { isDim, type Constraint, type Curve, type SketchData, SketchIndex } from './model'

/**
 * The sketch constraint solver, after SolidCraft's (clean-room LM solver):
 *
 *  - Unknowns are every point's X / Y and every circle's radius.
 *  - Each constraint gives residuals in mm (zero when it holds); arcs add one
 *    of their own (both ends on the same radius).
 *  - The system is split into connected groups and each is solved with a
 *    damped, weighted minimum-norm Gauss-Newton step (Levenberg-Marquardt on
 *    J W⁻¹ Jᵀ). Minimum norm means an under-defined sketch moves as little as
 *    possible; the weights let a dragged point stay under the cursor and
 *    let points held on a curve slide along it.
 *  - At the solution the rank of the Jacobian gives the degrees of freedom
 *    left and which points / curves are fully defined (for colouring).
 *  - A solve that cannot satisfy every constraint leaves the sketch as it was.
 */

const MAX_ITERS = 200
const TOL = 1e-10
const ACCEPT = 1e-6
const RANK_TOL = 1e-7

export interface SolveResult {
  ok: boolean
  /** Degrees of freedom left (0 = fully defined). */
  dof: number
  maxResidual: number
  /** Constraint ids still not met after a failed solve. */
  failing: string[]
  pointDefined: Set<string>
  curveDefined: Set<string>
}

export interface SolveOptions {
  /** Points that should move as little as possible (being dragged). */
  hold?: Set<string>
  /** Skip the degrees-of-freedom analysis (fast, for drags). */
  quick?: boolean
}

interface Term {
  cid: string | null
  deps: number[]
  f: (x: Float64Array) => number[]
}

/** Unknowns of a sketch: which slot of x holds what. */
class Vars {
  readonly px = new Map<string, number>()
  readonly rad = new Map<string, number>()
  readonly owner: string[] = []
  x: Float64Array
  constructor(readonly ix: SketchIndex) {
    const vals: number[] = []
    for (const p of ix.s.points) {
      this.px.set(p.id, vals.length)
      vals.push(p.x, p.y)
      this.owner.push(p.id, p.id)
    }
    for (const c of ix.s.curves)
      if (c.kind === 'circle') {
        this.rad.set(c.id, vals.length)
        vals.push(c.r)
        this.owner.push(c.id)
      }
    this.x = Float64Array.from(vals)
  }
  write(): void {
    for (const p of this.ix.s.points) {
      const i = this.px.get(p.id)!
      p.x = this.x[i]
      p.y = this.x[i + 1]
    }
    for (const c of this.ix.s.curves) if (c.kind === 'circle') c.r = this.x[this.rad.get(c.id)!]
  }
}

// ---- geometry over the unknown vector -----------------------------------

type V = [number, number]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]]
const cross = (a: V, b: V): number => a[0] * b[1] - a[1] * b[0]
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1]
const len = (a: V): number => Math.hypot(a[0], a[1])

/** Builds residual terms for a sketch. */
class Builder {
  constructor(private v: Vars) {}

  pt(id: string): { deps: number[]; get: (x: Float64Array) => V } {
    const i = this.v.px.get(id)
    if (i === undefined) throw new Error(`point ${id}`)
    return { deps: [i, i + 1], get: (x) => [x[i], x[i + 1]] }
  }
  curve(id: string): Curve {
    const c = this.v.ix.curve(id)
    if (!c) throw new Error(`curve ${id}`)
    return c
  }
  line(id: string): { deps: number[]; a: (x: Float64Array) => V; b: (x: Float64Array) => V } {
    const c = this.curve(id)
    if (c.kind !== 'line') throw new Error('not a line')
    const a = this.pt(c.a)
    const b = this.pt(c.b)
    return { deps: [...a.deps, ...b.deps], a: a.get, b: b.get }
  }
  /** Centre and radius of a circle or arc. */
  round(id: string): { deps: number[]; c: (x: Float64Array) => V; r: (x: Float64Array) => number } {
    const cv = this.curve(id)
    if (cv.kind === 'line') throw new Error('not round')
    const c = this.pt(cv.c)
    if (cv.kind === 'circle') {
      const ri = this.v.rad.get(cv.id)!
      return { deps: [...c.deps, ri], c: c.get, r: (x) => x[ri] }
    }
    const a = this.pt(cv.a)
    return { deps: [...c.deps, ...a.deps], c: c.get, r: (x) => len(sub(a.get(x), c.get(x))) }
  }
  /** Signed distance from a point to the infinite line through a curve, or to a circle. */
  distTo(pid: string, cid: string): { deps: number[]; f: (x: Float64Array) => number } {
    const p = this.pt(pid)
    const cv = this.curve(cid)
    if (cv.kind === 'line') {
      const l = this.line(cid)
      return {
        deps: [...p.deps, ...l.deps],
        f: (x) => {
          const a = l.a(x)
          const d = sub(l.b(x), a)
          return cross(d, sub(p.get(x), a)) / Math.max(len(d), 1e-9)
        }
      }
    }
    const r = this.round(cid)
    return { deps: [...p.deps, ...r.deps], f: (x) => len(sub(p.get(x), r.c(x))) - r.r(x) }
  }
  dir(id: string, x: Float64Array, flip = false): V {
    const l = this.line(id)
    const d = sub(l.b(x), l.a(x))
    return flip ? [-d[0], -d[1]] : d
  }

  terms(k: Constraint): Term {
    const R = k.refs
    const uniq = (d: number[]): number[] => [...new Set(d)]
    const t = (deps: number[], f: (x: Float64Array) => number[]): Term => ({ cid: k.id, deps: uniq(deps), f })
    switch (k.kind) {
      case 'coincident': {
        const p = this.pt(R[0])
        const q = this.pt(R[1])
        return t([...p.deps, ...q.deps], (x) => sub(p.get(x), q.get(x)))
      }
      case 'onCurve': {
        const d = this.distTo(R[0], R[1])
        return t(d.deps, (x) => [d.f(x)])
      }
      case 'horizontal': {
        const l = this.line(R[0])
        return t(l.deps, (x) => [l.b(x)[1] - l.a(x)[1]])
      }
      case 'vertical': {
        const l = this.line(R[0])
        return t(l.deps, (x) => [l.b(x)[0] - l.a(x)[0]])
      }
      case 'hPoints': {
        const p = this.pt(R[0])
        const q = this.pt(R[1])
        return t([...p.deps, ...q.deps], (x) => [q.get(x)[1] - p.get(x)[1]])
      }
      case 'vPoints': {
        const p = this.pt(R[0])
        const q = this.pt(R[1])
        return t([...p.deps, ...q.deps], (x) => [q.get(x)[0] - p.get(x)[0]])
      }
      case 'parallel':
      case 'perpendicular': {
        const l1 = this.line(R[0])
        const l2 = this.line(R[1])
        const par = k.kind === 'parallel'
        return t([...l1.deps, ...l2.deps], (x) => {
          const u = this.dir(R[0], x)
          const w = this.dir(R[1], x)
          // Scaled by the second line's length so the residual is in mm.
          const s = len(u) || 1e-9
          return [(par ? cross(u, w) : dot(u, w)) / s]
        })
      }
      case 'collinear': {
        const l2 = this.line(R[1])
        const c2 = this.curve(R[1]) as { a: string; b: string }
        const da = this.distTo(c2.a, R[0])
        const db = this.distTo(c2.b, R[0])
        return t([...da.deps, ...db.deps, ...l2.deps], (x) => [da.f(x), db.f(x)])
      }
      case 'tangent': {
        const a = this.curve(R[0])
        const b = this.curve(R[1])
        const s = k.flag ?? 1
        if (a.kind === 'line' || b.kind === 'line') {
          const [ln, rd] = a.kind === 'line' ? [R[0], R[1]] : [R[1], R[0]]
          const r = this.round(rd)
          const cv = this.curve(rd) as { c: string }
          const d = this.distTo(cv.c, ln)
          return t([...d.deps, ...r.deps], (x) => [d.f(x) - s * r.r(x)])
        }
        const r1 = this.round(R[0])
        const r2 = this.round(R[1])
        return t([...r1.deps, ...r2.deps], (x) => {
          const dc = len(sub(r1.c(x), r2.c(x)))
          return [s > 0 ? dc - (r1.r(x) + r2.r(x)) : dc - Math.abs(r1.r(x) - r2.r(x))]
        })
      }
      case 'equal': {
        const a = this.curve(R[0])
        const b = this.curve(R[1])
        const size = (id: string, cv: Curve): { deps: number[]; f: (x: Float64Array) => number } => {
          if (cv.kind === 'line') {
            const l = this.line(id)
            return { deps: l.deps, f: (x) => len(sub(l.b(x), l.a(x))) }
          }
          const r = this.round(id)
          return { deps: r.deps, f: r.r }
        }
        const sa = size(R[0], a)
        const sb = size(R[1], b)
        return t([...sa.deps, ...sb.deps], (x) => [sa.f(x) - sb.f(x)])
      }
      case 'concentric': {
        const a = this.round(R[0])
        const b = this.round(R[1])
        return t([...a.deps, ...b.deps], (x) => sub(a.c(x), b.c(x)))
      }
      case 'midpoint': {
        const p = this.pt(R[0])
        const l = this.line(R[1])
        return t([...p.deps, ...l.deps], (x) => {
          const a = l.a(x)
          const b = l.b(x)
          const q = p.get(x)
          return [q[0] - (a[0] + b[0]) / 2, q[1] - (a[1] + b[1]) / 2]
        })
      }
      case 'symmetric': {
        const p = this.pt(R[0])
        const q = this.pt(R[1])
        const l = this.line(R[2])
        return t([...p.deps, ...q.deps, ...l.deps], (x) => {
          const a = l.a(x)
          const d = sub(l.b(x), a)
          const n = len(d) || 1e-9
          const P = p.get(x)
          const Q = q.get(x)
          const m: V = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2]
          return [cross(d, sub(m, a)) / n, dot(d, sub(Q, P)) / n]
        })
      }
      case 'fix': {
        const p = this.pt(R[0])
        const at = k.at ?? [0, 0]
        return t(p.deps, (x) => sub(p.get(x), at))
      }
      case 'sameOffset': {
        const master = R[2] ? this.v.ix.cons.get(R[2]) : undefined
        const val = (): number => (master ? (master.value ?? 0) : (k.value ?? 0)) * (k.flag ?? 1)
        const first = this.curve(R[1])
        if (first.kind === 'line') {
          const d = this.distTo(R[0], R[1])
          return t(d.deps, (x) => [d.f(x) - val()])
        }
        const a = this.round(R[0])
        const b = this.round(R[1])
        return t([...a.deps, ...b.deps], (x) => [a.r(x) - b.r(x) - val()])
      }
      case 'distance': {
        const p = this.pt(R[0])
        const q = this.pt(R[1])
        const v = k.value ?? 0
        return t([...p.deps, ...q.deps], (x) => [len(sub(q.get(x), p.get(x))) - v])
      }
      case 'distanceX':
      case 'distanceY': {
        const p = this.pt(R[0])
        const q = this.pt(R[1])
        const v = (k.value ?? 0) * (k.flag ?? 1)
        const i = k.kind === 'distanceX' ? 0 : 1
        return t([...p.deps, ...q.deps], (x) => [q.get(x)[i] - p.get(x)[i] - v])
      }
      case 'pointLine': {
        const d = this.distTo(R[0], R[1])
        const v = (k.value ?? 0) * (k.flag ?? 1)
        return t(d.deps, (x) => [d.f(x) - v])
      }
      case 'length': {
        const l = this.line(R[0])
        const v = k.value ?? 0
        return t(l.deps, (x) => [len(sub(l.b(x), l.a(x))) - v])
      }
      case 'radius':
      case 'diameter': {
        const r = this.round(R[0])
        const v = (k.value ?? 0) / (k.kind === 'diameter' ? 2 : 1)
        return t(r.deps, (x) => [r.r(x) - v])
      }
      case 'angle': {
        const l1 = this.line(R[0])
        const l2 = this.line(R[1])
        const f = k.flag ?? 0
        const v = ((k.value ?? 0) * Math.PI) / 180
        return t([...l1.deps, ...l2.deps], (x) => {
          const u = this.dir(R[0], x, (f & 1) !== 0)
          const w = this.dir(R[1], x, (f & 2) !== 0)
          let d = Math.atan2(cross(u, w), dot(u, w)) - v
          d = Math.atan2(Math.sin(d), Math.cos(d))
          // Radians times a nominal 10 mm lever, so it weighs like a length.
          return [d * 10]
        })
      }
    }
  }

  /** Arc: both ends on one radius. */
  arcTerm(cv: Curve): Term | null {
    if (cv.kind !== 'arc') return null
    const c = this.pt(cv.c)
    const a = this.pt(cv.a)
    const b = this.pt(cv.b)
    return {
      cid: null,
      deps: [...new Set([...c.deps, ...a.deps, ...b.deps])],
      f: (x) => [len(sub(b.get(x), c.get(x))) - len(sub(a.get(x), c.get(x)))]
    }
  }
}

/** The current value a dimension measures (mm / degrees, always positive). */
export function measureDim(s: SketchData, k: Constraint, ix = new SketchIndex(s)): number {
  const v = new Vars(ix)
  const b = new Builder(v)
  const probe = { ...k, value: 0 } as Constraint
  if (k.kind === 'angle') {
    const f = k.flag ?? 0
    const u = b.dir(k.refs[0], v.x, (f & 1) !== 0)
    const w = b.dir(k.refs[1], v.x, (f & 2) !== 0)
    return Math.abs((Math.atan2(cross(u, w), dot(u, w)) * 180) / Math.PI)
  }
  const r = b.terms({ ...probe, flag: 1 }).f(v.x)[0]
  return k.kind === 'diameter' ? Math.abs(r) * 2 : Math.abs(r)
}

function buildTerms(ix: SketchIndex, v: Vars, skip?: Set<string>): Term[] {
  const b = new Builder(v)
  const out: Term[] = []
  for (const cv of ix.s.curves) {
    const t = b.arcTerm(cv)
    if (t) out.push(t)
  }
  for (const k of ix.s.constraints) {
    if (k.driven || skip?.has(k.id)) continue
    try {
      out.push(b.terms(k))
    } catch {
      // A constraint on missing / wrong geometry is ignored (removeItems drops them).
    }
  }
  return out
}

/** Split terms into groups that share no unknowns. */
function components(n: number, terms: Term[]): { vars: number[]; terms: Term[] }[] {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (const t of terms) for (let i = 1; i < t.deps.length; i++) parent[find(t.deps[i])] = find(t.deps[0])
  const groups = new Map<number, { vars: number[]; terms: Term[] }>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, { vars: [], terms: [] })
    groups.get(r)!.vars.push(i)
  }
  for (const t of terms) if (t.deps.length) groups.get(find(t.deps[0]))!.terms.push(t)
  return [...groups.values()]
}

function residuals(terms: Term[], x: Float64Array): number[] {
  const r: number[] = []
  for (const t of terms) for (const v of t.f(x)) r.push(Number.isFinite(v) ? v : 1e6)
  return r
}

/** Jacobian rows (dense over the component's vars), by central differences per term. */
function jacobian(terms: Term[], x: Float64Array, col: Map<number, number>, n: number): Float64Array[] {
  const rows: Float64Array[] = []
  for (const t of terms) {
    const k = t.f(x).length
    const block = Array.from({ length: k }, () => new Float64Array(n))
    for (const d of t.deps) {
      const j = col.get(d)
      if (j === undefined) continue
      const x0 = x[d]
      const h = 1e-7 * Math.max(1, Math.abs(x0))
      x[d] = x0 + h
      const fp = t.f(x)
      x[d] = x0 - h
      const fm = t.f(x)
      x[d] = x0
      for (let r = 0; r < k; r++) block[r][j] = (fp[r] - fm[r]) / (2 * h)
    }
    rows.push(...block)
  }
  return rows
}

/** Solve A y = b in place (Gaussian elimination, partial pivoting). */
function linSolve(A: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    if (Math.abs(A[p][c]) < 1e-300) return null
    if (p !== c) {
      ;[A[p], A[c]] = [A[c], A[p]]
      ;[b[p], b[c]] = [b[c], b[p]]
    }
    const d = A[c][c]
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d
      if (!f) continue
      const Ar = A[r]
      const Ac = A[c]
      for (let k = c; k < n; k++) Ar[k] -= f * Ac[k]
      b[r] -= f * b[c]
    }
  }
  const y = new Float64Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let k = r + 1; k < n; k++) s -= A[r][k] * y[k]
    y[r] = s / A[r][r]
  }
  return y
}

const sumSq = (r: number[]): number => r.reduce((s, v) => s + v * v, 0)
const maxAbs = (r: number[]): number => r.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

/** LM on one component; x is updated in place. Returns the largest residual left. */
function solveComponent(terms: Term[], vars: number[], x: Float64Array, weight: (i: number) => number): number {
  if (!terms.length) return 0
  const n = vars.length
  const col = new Map(vars.map((v, j) => [v, j]))
  const winv = vars.map((v) => 1 / weight(v))
  let r = residuals(terms, x)
  let cost = sumSq(r)
  let lambda = 1e-6
  for (let it = 0; it < MAX_ITERS && maxAbs(r) > TOL; it++) {
    const J = jacobian(terms, x, col, n)
    const m = J.length
    // A = J W⁻¹ Jᵀ (m×m)
    const JW = J.map((row) => row.map((v, j) => v * winv[j]))
    const A0: Float64Array[] = []
    let diag = 0
    for (let i = 0; i < m; i++) {
      const row = new Float64Array(m)
      for (let k = 0; k <= i; k++) {
        let s = 0
        const a = JW[i]
        const b = J[k]
        for (let j = 0; j < n; j++) s += a[j] * b[j]
        row[k] = s
      }
      A0.push(row)
      diag = Math.max(diag, row[i])
    }
    for (let i = 0; i < m; i++) for (let k = i + 1; k < m; k++) A0[i][k] = A0[k][i]
    let improved = false
    for (let tries = 0; tries < 12; tries++) {
      const A = A0.map((row, i) => {
        const c = Float64Array.from(row)
        c[i] += lambda * (1 + diag)
        return c
      })
      const y = linSolve(A, Float64Array.from(r))
      if (!y) {
        lambda *= 10
        continue
      }
      const old = vars.map((v) => x[v])
      for (let j = 0; j < n; j++) {
        let s = 0
        for (let i = 0; i < m; i++) s += JW[i][j] * y[i]
        x[vars[j]] -= s
      }
      const r2 = residuals(terms, x)
      const c2 = sumSq(r2)
      if (c2 < cost) {
        r = r2
        cost = c2
        lambda = Math.max(lambda / 4, 1e-12)
        improved = true
        break
      }
      vars.forEach((v, j) => (x[v] = old[j]))
      lambda *= 6
    }
    if (!improved) break
  }
  return maxAbs(r)
}

/**
 * Reduced row echelon analysis of J: which unknowns are pinned down
 * (e_i lies in J's row space) and the rank.
 */
function analyse(terms: Term[], vars: number[], x: Float64Array): { rank: number; determined: Set<number> } {
  const n = vars.length
  const col = new Map(vars.map((v, j) => [v, j]))
  const rows = jacobian(terms, x, col, n).map((r) => {
    const s = Math.hypot(...r)
    return s > 1e-12 ? r.map((v) => v / s) : r
  })
  const pivots: number[] = []
  let row = 0
  for (let c = 0; c < n && row < rows.length; c++) {
    let p = row
    for (let r = row + 1; r < rows.length; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[p][c])) p = r
    if (Math.abs(rows[p][c]) < RANK_TOL) continue
    ;[rows[p], rows[row]] = [rows[row], rows[p]]
    const d = rows[row][c]
    for (let k = 0; k < n; k++) rows[row][k] /= d
    for (let r = 0; r < rows.length; r++) {
      if (r === row) continue
      const f = rows[r][c]
      if (!f) continue
      for (let k = 0; k < n; k++) rows[r][k] -= f * rows[row][k]
    }
    pivots.push(c)
    row++
  }
  const isPivot = new Set(pivots)
  const free = [...Array(n).keys()].filter((c) => !isPivot.has(c))
  const determined = new Set<number>()
  pivots.forEach((c, r) => {
    if (free.every((f) => Math.abs(rows[r][f]) < 1e-6)) determined.add(vars[c])
  })
  return { rank: pivots.length, determined }
}

/**
 * Solve a sketch in place. On failure the geometry is left as it was and
 * `ok` is false (with the constraints that would not hold).
 */
export function solveSketch(s: SketchData, opts: SolveOptions = {}): SolveResult {
  const ix = new SketchIndex(s)
  const v = new Vars(ix)
  const terms = buildTerms(ix, v)
  const n = v.x.length
  const groups = components(n, terms)
  // Points held on a curve slide along it cheaply; held (dragged) points barely move.
  const onCurve = new Set(s.constraints.filter((k) => k.kind === 'onCurve' && !k.driven).map((k) => k.refs[0]))
  const weight = (i: number): number => {
    const o = v.owner[i]
    if (opts.hold?.has(o)) return 1e4
    if (onCurve.has(o)) return 0.05
    return 1
  }
  const start = Float64Array.from(v.x)
  let worst = 0
  const failing: string[] = []
  for (const g of groups) {
    const res = solveComponent(g.terms, g.vars, v.x, weight)
    worst = Math.max(worst, res)
    if (res > ACCEPT) for (const t of g.terms) if (t.cid && maxAbs(t.f(v.x)) > ACCEPT) failing.push(t.cid)
  }
  const ok = worst <= ACCEPT
  if (!ok) v.x.set(start)
  else v.write()
  const result: SolveResult = { ok, dof: 0, maxResidual: worst, failing, pointDefined: new Set(), curveDefined: new Set() }
  if (opts.quick) return result
  const det = new Set<number>()
  let dof = 0
  for (const g of groups) {
    const a = analyse(g.terms, g.vars, v.x)
    dof += g.vars.length - a.rank
    for (const d of a.determined) det.add(d)
  }
  result.dof = dof
  for (const p of s.points) {
    const i = v.px.get(p.id)!
    if (det.has(i) && det.has(i + 1)) result.pointDefined.add(p.id)
  }
  for (const c of s.curves) {
    const pts = c.kind === 'line' ? [c.a, c.b] : c.kind === 'circle' ? [c.c] : [c.c, c.a, c.b]
    const radOk = c.kind !== 'circle' || det.has(v.rad.get(c.id)!)
    if (radOk && pts.every((p) => result.pointDefined.has(p))) result.curveDefined.add(c.id)
  }
  return result
}

/** Degrees of freedom of the sketch as it stands (no solve). */
export function sketchDof(s: SketchData, skip?: Set<string>): number {
  const ix = new SketchIndex(s)
  const v = new Vars(ix)
  const terms = buildTerms(ix, v, skip)
  let dof = 0
  for (const g of components(v.x.length, terms)) dof += g.vars.length - analyse(g.terms, g.vars, v.x).rank
  return dof
}

export type AddCheck = 'ok' | 'redundant' | 'conflict'

/**
 * Would adding constraint `id` (already in the sketch) take away a degree of
 * freedom? Solves a copy; the caller keeps or drops it.
 */
export function checkNewConstraint(s: SketchData, id: string): { verdict: AddCheck; solved: SketchData | null } {
  const before = sketchDof(s, new Set([id]))
  const copy = structuredClone(s)
  const res = solveSketch(copy)
  if (!res.ok) return { verdict: 'conflict', solved: null }
  return { verdict: res.dof < before ? 'ok' : 'redundant', solved: copy }
}

/**
 * Change a dimension's value and solve, stepping there in stages when the
 * change is large so the sketch doesn't fold over into a mirror solution.
 */
export function solveValueEdit(s: SketchData, kid: string, value: number): boolean {
  const k = s.constraints.find((c) => c.id === kid)
  if (!k || k.value === undefined) return false
  const copy = structuredClone(s)
  const kc = copy.constraints.find((c) => c.id === kid)!
  const from = k.driven ? measureDim(s, k) : k.value
  const ratio = Math.abs(value - from) / Math.max(Math.abs(from), 1e-6)
  const steps = Math.min(24, Math.max(1, Math.ceil(ratio / 0.2)))
  for (let i = 1; i <= steps; i++) {
    kc.value = from + ((value - from) * i) / steps
    if (!solveSketch(copy, { quick: true }).ok) return false
  }
  Object.assign(s, copy)
  return true
}

export { isDim }
