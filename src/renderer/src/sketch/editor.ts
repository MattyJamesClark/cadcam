import * as THREE from 'three'
import type { ModuleContext } from '@/core/types'
import { showCmdBar } from '@/core/cmdbar'
import { el, fmt } from '@/core/toolpanel'
import { pickAt } from '@/core/picking'
import { Handles, worldPerPixel } from '@/core/handles'
import { gridSnapOn } from '@/core/gridsnap'
import {
  addConstraint,
  cloneSketch,
  curveEnds,
  curvePoints,
  describeConstraint,
  isDim,
  removeItems,
  type Constraint,
  type ArcCurve,
  type CircleCurve,
  type ConstraintKind,
  type Curve,
  type LineCurve,
  type SketchData,
  SketchIndex
} from './model'
import { checkNewConstraint, measureDim, solveSketch, solveValueEdit, type SolveResult } from './solver'
import { at, d2, intersect, lineEnds, nearest, roundOf, type P2 } from './geom'
import { disposeDrawing, drawSketch } from './render'
import { dimAnchor, dimDraw } from './dimgeom'
import { looseEnds } from './profiles'

/**
 * Sketch editing session: one sketch at a time, drawn over the model on its
 * plane. Without a tool running you select (click, Shift+click, drag a box),
 * drag geometry (the solver keeps every constraint), double-click a dimension
 * to change it, and add relations from the strip that appears for the
 * selection. Draw / modify tools plug in through the Tool interface.
 */

export type SnapKind = 'point' | 'mid' | 'centre' | 'quad' | 'cross' | 'curve' | 'model' | 'grid' | 'free'

export interface Snap {
  p: P2
  kind: SnapKind
  point?: string
  curve?: string
  curve2?: string
  /** Lined up horizontally / vertically with this point. */
  alignH?: string
  alignV?: string
  /** The segment from `from` snapped level / upright. */
  level?: 'h' | 'v'
}

export interface Field {
  key: string
  label: string
  value?: number
  /** Whole numbers (e.g. polygon sides). */
  int?: boolean
}

export interface Tool {
  readonly name: string
  prompt(): string
  /** Pointer moved (with the snapped position). */
  move(s: Snap, e: PointerEvent): void
  click(s: Snap, e: PointerEvent): void
  /** Where the line being drawn starts (for level / upright snapping). */
  from?(): P2 | null
  /** Right-click / Enter: finish the current chain. Return false to end the tool. */
  finish?(): boolean
  back?(): boolean
  /** A typed value was entered (Enter in a box). */
  typed?(): void
  /** Points the snap must ignore (being placed). */
  exclude?(): Set<string>
  dispose?(): void
}

/** Single-key shortcuts that only work while a sketch is open (L = line, ...). */
export const editorKeys = new Map<string, (ed: SketchEditor) => void>()

/** Show every relation's glyph, not only those on the hovered / selected geometry. */
let showAllRelations = false
export const allRelationsShown = (): boolean => showAllRelations
export function setAllRelationsShown(v: boolean): void {
  showAllRelations = v
  current?.redraw()
  notify()
}

let current: SketchEditor | null = null
export const activeEditor = (): SketchEditor | null => current
const watchers = new Set<() => void>()
export function onEditorChange(fn: () => void): () => void {
  watchers.add(fn)
  return () => watchers.delete(fn)
}
const notify = (): void => watchers.forEach((f) => f())

export function openEditor(ctx: ModuleContext, id: string, isNew = false, focus?: THREE.Vector3): SketchEditor | null {
  if (current?.id === id) return current
  current?.finish()
  const sk = ctx.doc.sketches.find((s) => s.id === id)
  if (!sk) return null
  current = new SketchEditor(ctx, sk, isNew, focus)
  notify()
  return current
}

const GLYPH: Partial<Record<ConstraintKind, string>> = {
  horizontal: 'H',
  vertical: 'V',
  hPoints: 'H',
  vPoints: 'V',
  parallel: '∥',
  perpendicular: '⊥',
  collinear: '⫽',
  tangent: 'T',
  equal: '=',
  concentric: '◎',
  midpoint: 'M',
  symmetric: '⇔',
  fix: '⚓'
}

export class SketchEditor {
  readonly id: string
  /** The live sketch being edited (the document's copy changes on commit). */
  sk: SketchData
  private base: SketchData
  private startState: SketchData
  readonly plane = new THREE.Matrix4()
  readonly inv = new THREE.Matrix4()
  private plane3 = new THREE.Plane()
  private drawing: THREE.Group | null = null
  readonly preview = new THREE.Group()
  private snapMark = new THREE.Group()
  readonly selected = new Set<string>()
  hover: string | null = null
  tool: Tool | null = null
  result: SolveResult
  private off: (() => void)[] = []
  private prompt = el('div', 'vp-prompt')
  private status = el('div', 'sk-status')
  private strip: HTMLElement | null = null
  private fieldBoxes = new Map<string, HTMLInputElement>()
  private labels = new Map<string, HTMLElement>()
  private glyphs: { el: HTMLElement; k: Constraint; at: () => P2 | null }[] = []
  private applying = false
  private down: { x: number; y: number; snap: Snap; e: PointerEvent } | null = null
  private drag: { ids: Set<string>; from: P2; start: SketchData; moved: boolean; radius?: string } | null = null
  private box: { el: HTMLElement; x: number; y: number } | null = null
  private lastMove: PointerEvent | null = null
  readonly handles: Handles
  private construction = false
  private valueEdit: { close(apply: boolean): void } | null = null

  constructor(readonly ctx: ModuleContext, sk: SketchData, private isNew: boolean, private focus?: THREE.Vector3) {
    this.id = sk.id
    this.sk = cloneSketch(sk)
    this.base = cloneSketch(sk)
    this.startState = cloneSketch(sk)
    this.result = solveSketch(this.sk)
    const vp = ctx.viewport
    this.setPlane(sk.plane)
    this.preview.name = '__sketch-preview'
    this.snapMark.name = '__sketch-snap'
    vp.scene.add(this.preview, this.snapMark)
    this.handles = new Handles(vp)
    vp.host.append(this.prompt, this.status)
    const prevBlock = vp.blockPick
    vp.blockPick = () => true
    this.off.push(() => (vp.blockPick = prevBlock))
    this.lookAtPlane()
    // The grid lies on the sketch plane while editing (grid snap uses it).
    vp.setGridFrame(this.plane)
    this.off.push(() => vp.setGridFrame(null))

    const bar = showCmdBar(vp.host, { ok: () => this.finish(), cancel: () => this.discard(), back: () => this.back() })
    this.off.push(() => bar.dispose())

    const canvas = vp.renderer.domElement
    const down = (e: PointerEvent): void => this.onDown(e)
    const move = (e: PointerEvent): void => this.onMove(e)
    const up = (e: PointerEvent): void => this.onUp(e)
    const dbl = (e: MouseEvent): void => this.onDouble(e)
    const key = (e: KeyboardEvent): void => this.onKey(e)
    canvas.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    canvas.addEventListener('dblclick', dbl)
    window.addEventListener('keydown', key, true)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      canvas.removeEventListener('dblclick', dbl)
      window.removeEventListener('keydown', key, true)
    })
    // Undo / redo (or anything else) changing this sketch: pick up the document's copy.
    this.off.push(
      ctx.doc.on('sketches', () => {
        if (this.applying) return
        const now = ctx.doc.sketches.find((s) => s.id === this.id)
        if (!now) return void this.close()
        this.cancelTool()
        this.sk = cloneSketch(now)
        this.base = cloneSketch(now)
        this.setPlane(now.plane)
        this.selected.clear()
        this.resolve()
      })
    )
    const render = (cam: THREE.Camera): void => this.beforeRender(cam)
    vp.beforeRender.add(render)
    this.off.push(() => vp.beforeRender.delete(render))
    const place = (): void => this.placeLabels()
    vp.afterRender.add(place)
    this.off.push(() => vp.afterRender.delete(place))
    this.redraw()
    this.say()
  }

  // ---- plane & coordinates ---------------------------------------------------

  private setPlane(m: number[]): void {
    this.plane.fromArray(m)
    this.inv.copy(this.plane).invert()
    const n = new THREE.Vector3(0, 0, 1).transformDirection(this.plane)
    this.plane3.setFromNormalAndCoplanarPoint(n, new THREE.Vector3().setFromMatrixPosition(this.plane))
  }

  lookAtPlane(): void {
    const vp = this.ctx.viewport
    const z = new THREE.Vector3(0, 0, 1).transformDirection(this.plane)
    const y = new THREE.Vector3(0, 1, 0).transformDirection(this.plane)
    const pose = vp.nav.poseLookingFrom(z, y)
    const box = new THREE.Box3()
    for (const p of this.sk.points) box.expandByPoint(this.world([p.x, p.y]))
    if (!box.isEmpty()) pose.target.copy(box.getCenter(new THREE.Vector3()))
    else if (this.focus) pose.target.copy(this.plane3.projectPoint(this.focus, new THREE.Vector3()))
    else pose.target.copy(new THREE.Vector3().setFromMatrixPosition(this.plane))
    vp.nav.goTo(pose, true)
  }

  world(p: P2): THREE.Vector3 {
    return new THREE.Vector3(p[0], p[1], 0).applyMatrix4(this.plane)
  }

  /** Pointer to sketch coordinates (null when looking along the plane). */
  local(e: { clientX: number; clientY: number }): P2 | null {
    const vp = this.ctx.viewport
    vp.nav.applyTo(vp.camera)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(vp.ndcOf(e), vp.camera)
    const hit = ray.ray.intersectPlane(this.plane3, new THREE.Vector3())
    if (!hit) return null
    hit.applyMatrix4(this.inv)
    return [hit.x, hit.y]
  }

  /** Mm per screen pixel on the sketch. */
  get px(): number {
    const vp = this.ctx.viewport
    const o = new THREE.Vector3().setFromMatrixPosition(this.plane)
    return worldPerPixel(vp, vp.camera, o)
  }

  ix(): SketchIndex {
    return new SketchIndex(this.sk)
  }

  // ---- drawing -------------------------------------------------------------

  private lastPx = 0
  private beforeRender(cam: THREE.Camera): void {
    const px = worldPerPixel(this.ctx.viewport, cam, new THREE.Vector3().setFromMatrixPosition(this.plane))
    // Arrow heads and dashes are sized in pixels: redraw when the zoom changes a lot.
    if (this.lastPx && Math.abs(px / this.lastPx - 1) > 0.15) this.redraw(px)
  }

  redraw(px = this.px): void {
    this.lastPx = px
    if (this.drawing) {
      this.ctx.viewport.scene.remove(this.drawing)
      disposeDrawing(this.drawing)
    }
    this.drawing = drawSketch(this.sk, {
      editing: true,
      px,
      defined: { points: this.result.pointDefined, curves: this.result.curveDefined },
      selected: this.selected,
      hover: this.hover,
      loose: new Set(looseEnds(this.sk)),
      failing: new Set(this.result.ok ? [] : this.result.failing.flatMap((k) => this.sk.constraints.find((c) => c.id === k)?.refs ?? []))
    })
    this.ctx.viewport.scene.add(this.drawing)
    this.preview.matrixAutoUpdate = false
    this.preview.matrix.copy(this.plane)
    this.preview.updateMatrixWorld(true)
    this.snapMark.matrixAutoUpdate = false
    this.snapMark.matrix.copy(this.plane)
    this.snapMark.updateMatrixWorld(true)
    this.syncLabels(px)
    this.updateStatus()
    this.ctx.viewport.requestRender()
  }

  private updateStatus(): void {
    const loose = looseEnds(this.sk).length
    const parts = [this.sk.name]
    if (!this.result.ok) parts.push('constraints conflict')
    else if (!this.sk.curves.length && !this.sk.points.length) parts.push('empty')
    else parts.push(this.result.dof === 0 ? 'fully defined' : `${this.result.dof} free ${this.result.dof === 1 ? 'move' : 'moves'} left`)
    if (loose) parts.push(`${loose} open ${loose === 1 ? 'end' : 'ends'}`)
    this.status.textContent = parts.join(' · ')
    this.status.classList.toggle('defined', this.result.ok && this.result.dof === 0 && this.sk.curves.length > 0)
    this.status.classList.toggle('bad', !this.result.ok)
  }

  /** Dimension text and constraint glyphs (HTML over the view). */
  private syncLabels(px: number): void {
    const keep = new Set<string>()
    const ix = this.ix()
    for (const k of this.sk.constraints) {
      if (!isDim(k)) continue
      keep.add(k.id)
      let lab = this.labels.get(k.id)
      if (!lab) {
        lab = el('div', 'sk-dim')
        this.bindDimLabel(lab, k.id)
        this.ctx.viewport.host.append(lab)
        this.labels.set(k.id, lab)
      }
      const d = dimDraw(this.sk, k, px, ix)
      if (!lab.classList.contains('editing')) lab.textContent = d?.label ?? '?'
      lab.dataset.x = String(d?.text[0] ?? 0)
      lab.dataset.y = String(d?.text[1] ?? 0)
      lab.classList.toggle('selected', this.selected.has(k.id))
      lab.classList.toggle('driven', !!k.driven)
      lab.title = `${describeConstraint(k.kind)}${k.driven ? ' (reference)' : ''}: double-click to change, drag to move`
    }
    for (const [id, lab] of this.labels)
      if (!keep.has(id)) {
        lab.remove()
        this.labels.delete(id)
      }
    // Glyphs: rebuilt each time (cheap), stacked per curve / point.
    for (const g of this.glyphs) g.el.remove()
    this.glyphs = []
    const stack = new Map<string, number>()
    const slot = (id: string): number => {
      const n = stack.get(id) ?? 0
      stack.set(id, n + 1)
      return n
    }
    const focus = new Set<string>(this.selected)
    if (this.hover) focus.add(this.hover)
    for (const k of this.sk.constraints) {
      const sym = GLYPH[k.kind]
      if (!sym || isDim(k)) continue
      // All relations, or just those on what's hovered / selected (keeps busy sketches readable).
      if (!showAllRelations && !focus.has(k.id) && !k.refs.some((r) => focus.has(r))) continue
      const targets = k.kind === 'midpoint' || k.kind === 'onCurve' || k.kind === 'fix' || k.kind === 'hPoints' || k.kind === 'vPoints' || k.kind === 'symmetric' ? [k.refs[0]] : k.refs
      for (const t of targets) {
        const n = slot(t)
        const g = el('div', 'sk-glyph', sym)
        g.title = describeConstraint(k.kind) + ' (click to select, Delete removes it)'
        g.addEventListener('pointerdown', (e) => e.stopPropagation())
        g.addEventListener('click', (e) => {
          e.stopPropagation()
          this.select([k.id], e.shiftKey || e.ctrlKey)
        })
        g.addEventListener('pointerenter', () => this.setHover(k.id))
        g.addEventListener('pointerleave', () => this.setHover(null))
        g.classList.toggle('selected', this.selected.has(k.id))
        this.ctx.viewport.host.append(g)
        this.glyphs.push({ el: g, k, at: () => this.glyphAt(t, n) })
      }
    }
    this.placeLabels()
  }

  private glyphAt(id: string, n: number): P2 | null {
    const ix = this.ix()
    const px = this.lastPx || this.px
    const pt = ix.pts.get(id)
    if (pt) return [pt.x + (12 + 13 * n) * px, pt.y + 12 * px]
    const c = ix.curve(id)
    if (!c) return null
    if (c.kind === 'line') {
      const [a, b] = lineEnds(ix, c)
      const L = d2(a, b) || 1
      const u: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
      const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const s = (n - 0) * 14 * px
      return [m[0] + u[0] * s - u[1] * 12 * px, m[1] + u[1] * s + u[0] * 12 * px]
    }
    const r = roundOf(ix, c)
    const ang = r.a0 + (r.full ? Math.PI / 4 : r.sweep / 2) + (n * 14 * px) / Math.max(r.r, 1e-9)
    const rr = r.r + 12 * px
    return [r.c[0] + rr * Math.cos(ang), r.c[1] + rr * Math.sin(ang)]
  }

  private placeLabels(): void {
    const vp = this.ctx.viewport
    for (const lab of this.labels.values()) {
      const q = vp.toScreen(this.world([Number(lab.dataset.x), Number(lab.dataset.y)]))
      lab.style.left = `${q.x}px`
      lab.style.top = `${q.y}px`
    }
    for (const g of this.glyphs) {
      const p = g.at()
      if (!p) continue
      const q = vp.toScreen(this.world(p))
      g.el.style.left = `${q.x}px`
      g.el.style.top = `${q.y}px`
    }
  }

  // ---- solving & committing --------------------------------------------------

  /** Full solve (with the defined / free analysis) and redraw. */
  resolve(): void {
    this.result = solveSketch(this.sk)
    this.redraw()
    this.refreshStrip()
    notify()
  }

  /** Record the current sketch as one undo step. */
  commit(label: string): void {
    this.result = solveSketch(this.sk)
    this.applying = true
    try {
      this.ctx.doc.updateSketch(this.id, this.base, this.sk, label)
    } finally {
      this.applying = false
    }
    this.base = cloneSketch(this.sk)
    this.redraw()
    this.refreshStrip()
    notify()
  }

  /** Throw away uncommitted changes (a tool's preview edits). */
  revert(): void {
    this.sk = cloneSketch(this.base)
    this.result = solveSketch(this.sk)
    this.redraw()
  }

  /**
   * Add a constraint after checking it: refuses ones that conflict or that the
   * sketch already implies. Returns true when added (and committed).
   */
  constrain(c: Omit<Constraint, 'id'>, label?: string, quiet = false): boolean {
    const trial = cloneSketch(this.sk)
    const k = addConstraint(trial, c)
    const check = checkNewConstraint(trial, k.id)
    if (check.verdict !== 'ok' || !check.solved) {
      if (!quiet)
        this.ctx.status(
          check.verdict === 'conflict' ? `${describeConstraint(c.kind)} conflicts with the existing constraints` : `${describeConstraint(c.kind)} is already defined by other constraints`,
          'warn'
        )
      return false
    }
    this.sk = check.solved
    this.commit(label ?? `Add ${describeConstraint(c.kind).toLowerCase()}`)
    return true
  }

  /**
   * Add a dimension at its current value. If it would over-define the sketch it
   * goes in as a reference (driven) dimension instead.
   */
  addDimension(c: Omit<Constraint, 'id' | 'value'>): Constraint {
    const value = measureDim(this.sk, { ...c, id: '?' } as Constraint)
    const trial = cloneSketch(this.sk)
    const k = addConstraint(trial, { ...c, value })
    const check = checkNewConstraint(trial, k.id)
    if (check.verdict === 'ok' && check.solved) {
      this.sk = check.solved
    } else {
      k.driven = true
      this.sk = trial
      this.ctx.status('That would over-define the sketch, so it was added as a reference dimension', 'warn')
    }
    this.commit(`Add ${describeConstraint(c.kind).toLowerCase()} dimension`)
    return this.sk.constraints.find((x) => x.id === k.id)!
  }

  /** Set a dimension's value (steps there so the sketch keeps its shape). */
  setDimValue(kid: string, value: number): boolean {
    const k = this.sk.constraints.find((c) => c.id === kid)
    if (!k || !(value > 0 || k.kind === 'angle' || k.kind === 'distanceX' || k.kind === 'distanceY' || k.kind === 'pointLine')) return false
    if (k.driven) return false
    // The first size on a sketch scales all of it, so the shape you drew keeps its proportions (as Creo does).
    const others = this.sk.constraints.filter((c) => isDim(c) && !c.driven && c.id !== kid && c.kind !== 'angle')
    const fixed = this.sk.constraints.some((c) => c.kind === 'fix')
    if (!others.length && !fixed && k.kind !== 'angle' && (k.value ?? 0) > 0 && value > 0) {
      const f = value / (k.value ?? 1)
      const o = this.sk.points[0]
      const ox = o?.x ?? 0
      const oy = o?.y ?? 0
      const trial = cloneSketch(this.sk)
      for (const p of trial.points) {
        p.x = ox + (p.x - ox) * f
        p.y = oy + (p.y - oy) * f
      }
      for (const c of trial.curves) if (c.kind === 'circle') c.r *= f
      for (const c of trial.constraints) {
        if (c.label) c.label = [c.label[0] * f, c.label[1] * f]
        if (c.kind === 'fix' && c.at) c.at = [ox + (c.at[0] - ox) * f, oy + (c.at[1] - oy) * f]
      }
      trial.constraints.find((c) => c.id === kid)!.value = value
      if (solveSketch(trial, { quick: true }).ok) {
        this.sk = trial
        this.commit(`Scale sketch: ${describeConstraint(k.kind).toLowerCase()} ${fmt(value)}`)
        return true
      }
    }
    if (!solveValueEdit(this.sk, kid, value)) {
      this.ctx.status(`Can't make it ${fmt(value)}: the sketch can't reach that shape`, 'warn')
      return false
    }
    this.commit(`Change ${describeConstraint(k.kind).toLowerCase()} to ${fmt(value)}`)
    return true
  }

  // ---- selection --------------------------------------------------------------

  select(ids: string[], additive = false): void {
    if (!additive) this.selected.clear()
    for (const id of ids) {
      if (additive && this.selected.has(id)) this.selected.delete(id)
      else this.selected.add(id)
    }
    this.redraw()
    this.refreshStrip()
    notify()
  }

  setHover(id: string | null): void {
    if (id === this.hover) return
    this.hover = id
    this.redraw(this.lastPx || this.px)
  }

  /** What's under the pointer: a point, else a curve (within a few pixels). */
  itemAt(q: P2, px = this.px, exclude?: Set<string>): string | null {
    const ix = this.ix()
    let best: string | null = null
    let bd = 7 * px
    for (const p of this.sk.points) {
      if (exclude?.has(p.id)) continue
      const d = Math.hypot(p.x - q[0], p.y - q[1])
      if (d < bd) {
        bd = d
        best = p.id
      }
    }
    if (best) return best
    bd = 6 * px
    for (const c of this.sk.curves) {
      const n = nearest(ix, c, q)
      if (n.dist < bd) {
        bd = n.dist
        best = c.id
      }
    }
    return best
  }

  /** Selected items sorted by type. */
  selection(): { points: string[]; lines: string[]; rounds: string[]; cons: string[] } {
    const ix = this.ix()
    const out = { points: [] as string[], lines: [] as string[], rounds: [] as string[], cons: [] as string[] }
    for (const id of this.selected) {
      if (ix.pts.has(id)) out.points.push(id)
      else if (ix.cons.has(id)) out.cons.push(id)
      else {
        const c = ix.curve(id)
        if (c?.kind === 'line') out.lines.push(id)
        else if (c) out.rounds.push(id)
      }
    }
    return out
  }

  deleteSelected(): void {
    if (!this.selected.size) return
    const ids = new Set(this.selected)
    removeItems(this.sk, ids, true)
    this.selected.clear()
    this.commit(ids.size === 1 ? 'Delete sketch item' : `Delete ${ids.size} sketch items`)
  }

  toggleConstruction(): void {
    const s = this.selection()
    const ids = [...s.lines, ...s.rounds]
    if (!ids.length) {
      this.construction = !this.construction
      this.ctx.status(this.construction ? 'New geometry is construction (X to switch back)' : 'New geometry is normal', 'info')
      notify()
      return
    }
    const ix = this.ix()
    const on = !ids.every((id) => ix.curve(id)?.construction)
    for (const id of ids) {
      const c = ix.curve(id)!
      c.construction = on || undefined
    }
    this.commit(on ? 'Make construction' : 'Make normal geometry')
  }

  /** New curves drawn now are construction geometry. */
  get constructionMode(): boolean {
    return this.construction
  }
  set constructionMode(v: boolean) {
    this.construction = v
    notify()
  }

  // ---- snapping ---------------------------------------------------------------

  snap(e: { clientX: number; clientY: number; shiftKey?: boolean }, exclude = new Set<string>(), from: P2 | null = null): Snap | null {
    const q = this.local(e)
    if (!q) return null
    // Shift held: no snapping at all (as in Creo).
    if (e.shiftKey && this.tool) return { p: q, kind: 'free' }
    const px = this.px
    const ix = this.ix()
    const R = 9 * px
    let best: Snap | null = null
    let bd = R
    const offer = (p: P2, s: Omit<Snap, 'p'>, bonus = 0): void => {
      const d = d2(p, q) - bonus
      if (d < bd) {
        bd = d
        best = { p, ...s }
      }
    }
    for (const p of this.sk.points) if (!exclude.has(p.id)) offer([p.x, p.y], { kind: 'point', point: p.id }, 2 * px)
    const live = this.sk.curves.filter((c) => !curvePoints(c).some((p) => exclude.has(p)))
    for (const c of live) {
      if (c.kind === 'line') {
        const [a, b] = lineEnds(ix, c)
        offer([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { kind: 'mid', curve: c.id })
      } else {
        const r = roundOf(ix, c)
        for (let i = 0; i < 4; i++) {
          const ang = (i * Math.PI) / 2
          const t = (((ang - r.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
          if (r.full || t <= r.sweep) offer([r.c[0] + r.r * Math.cos(ang), r.c[1] + r.r * Math.sin(ang)], { kind: 'quad', curve: c.id })
        }
      }
    }
    if (!best) {
      // Crossings of two curves near the pointer.
      const near = live.filter((c) => nearest(ix, c, q).dist < R)
      for (let i = 0; i < near.length; i++)
        for (let j = i + 1; j < near.length; j++)
          for (const h of intersect(ix, near[i], near[j])) if (h.within) offer(h.p, { kind: 'cross', curve: near[i].id, curve2: near[j].id })
    }
    if (!best) {
      // Model corners, centres and edges, flattened onto the sketch plane.
      const hit = pickAt(this.ctx.viewport, e, { vertex: true })
      if (hit && (hit.kind === 'vertex' || hit.kind === 'point')) {
        const l = hit.point.clone().applyMatrix4(this.inv)
        offer([l.x, l.y], { kind: 'model' }, R)
      }
    }
    if (!best) {
      let cd = 6 * px
      for (const c of live) {
        const n = nearest(ix, c, q)
        if (n.dist < cd) {
          cd = n.dist
          best = { p: n.p, kind: 'curve', curve: c.id }
        }
      }
    }
    const s: Snap = best ?? { p: q, kind: 'free' }
    if (s.kind === 'free' && gridSnapOn()) {
      const g = this.ctx.viewport.gridSnapStep
      const p: P2 = [Math.round(q[0] / g) * g, Math.round(q[1] / g) * g]
      s.p = p
      s.kind = 'grid'
    }
    if (s.kind === 'free' || s.kind === 'curve' || s.kind === 'grid') this.infer(s, exclude, from, px)
    return s
  }

  /** Line up with other points, and level / upright segments from `from`. */
  private infer(s: Snap, exclude: Set<string>, from: P2 | null, px: number): void {
    const tol = 7 * px
    const free = s.kind === 'free' || s.kind === 'grid'
    if (from && free) {
      if (Math.abs(s.p[1] - from[1]) < tol && Math.abs(s.p[0] - from[0]) > tol) {
        s.p = [s.p[0], from[1]]
        s.level = 'h'
      } else if (Math.abs(s.p[0] - from[0]) < tol && Math.abs(s.p[1] - from[1]) > tol) {
        s.p = [from[0], s.p[1]]
        s.level = 'v'
      }
    }
    if (!free) return
    let bx = tol
    let by = tol
    for (const p of this.sk.points) {
      if (exclude.has(p.id)) continue
      if (from && Math.hypot(p.x - from[0], p.y - from[1]) < 1e-9) continue
      if (s.level !== 'h' && Math.abs(p.y - s.p[1]) < by) {
        by = Math.abs(p.y - s.p[1])
        s.alignH = p.id
      }
      if (s.level !== 'v' && Math.abs(p.x - s.p[0]) < bx) {
        bx = Math.abs(p.x - s.p[0])
        s.alignV = p.id
      }
    }
    const ix = this.ix()
    if (s.alignH) s.p = [s.p[0], ix.p(s.alignH).y]
    if (s.alignV) s.p = [ix.p(s.alignV).x, s.p[1]]
  }

  /** Draw the snap marker and guide lines. */
  showSnap(s: Snap | null): void {
    for (const c of [...this.snapMark.children]) {
      this.snapMark.remove(c)
      disposeDrawing(c)
    }
    if (!s) return void this.ctx.viewport.requestRender()
    const px = this.px
    const col = s.kind === 'free' ? 0x9ca3af : s.kind === 'grid' ? 0x7dd3fc : 0xffd166
    const r = 5 * px
    const pts: THREE.Vector3[] = []
    const P = (x: number, y: number): THREE.Vector3 => new THREE.Vector3(x, y, 0)
    const [x, y] = s.p
    if (s.kind === 'point' || s.kind === 'model') for (let i = 0; i < 16; i++) pts.push(P(x + r * Math.cos((i * Math.PI) / 8), y + r * Math.sin((i * Math.PI) / 8)), P(x + r * Math.cos(((i + 1) * Math.PI) / 8), y + r * Math.sin(((i + 1) * Math.PI) / 8)))
    else if (s.kind === 'mid') pts.push(P(x - r, y - r), P(x + r, y - r), P(x + r, y - r), P(x, y + r), P(x, y + r), P(x - r, y - r))
    else if (s.kind === 'cross') pts.push(P(x - r, y - r), P(x + r, y + r), P(x - r, y + r), P(x + r, y - r))
    else if (s.kind === 'quad') pts.push(P(x, y - r), P(x + r, y), P(x + r, y), P(x, y + r), P(x, y + r), P(x - r, y), P(x - r, y), P(x, y - r))
    else if (s.kind === 'curve') pts.push(P(x - r, y), P(x + r, y), P(x, y - r), P(x, y + r))
    else if (s.kind === 'grid') pts.push(P(x - r * 0.6, y), P(x + r * 0.6, y), P(x, y - r * 0.6), P(x, y + r * 0.6))
    const guides: THREE.Vector3[] = []
    const ix = this.ix()
    if (s.alignH && ix.pts.has(s.alignH)) guides.push(P(ix.p(s.alignH).x, ix.p(s.alignH).y), P(x, y))
    if (s.alignV && ix.pts.has(s.alignV)) guides.push(P(ix.p(s.alignV).x, ix.p(s.alignV).y), P(x, y))
    const mk = (list: THREE.Vector3[], color: number, dashed: boolean): void => {
      if (!list.length) return
      const g = new THREE.BufferGeometry().setFromPoints(list)
      const m = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 4 * px, gapSize: 3 * px, depthTest: false, transparent: true, opacity: 0.8 })
        : new THREE.LineBasicMaterial({ color, depthTest: false })
      const ls = new THREE.LineSegments(g, m)
      if (dashed) ls.computeLineDistances()
      ls.renderOrder = 40
      this.snapMark.add(ls)
    }
    mk(pts, col, false)
    mk(guides, 0x7dd3fc, true)
    this.ctx.viewport.requestRender()
  }

  // ---- making geometry with the snaps' relations ---------------------------------

  /**
   * A point at a snap: reuses a sketch point it snapped to, otherwise makes one
   * and adds the relation the snap implies (on a curve, at a midpoint, lined up...).
   */
  pointAt(s: Snap): string {
    if (s.kind === 'point' && s.point && this.sk.points.some((p) => p.id === s.point)) return s.point
    const id = `p${this.sk.seq++}`
    this.sk.points.push({ id, x: s.p[0], y: s.p[1] })
    this.autoRelations(id, s)
    return id
  }

  autoRelations(pid: string, s: Snap): void {
    const add = (kind: ConstraintKind, refs: string[], flag?: number): void => void addConstraint(this.sk, { kind, refs, flag })
    if (s.kind === 'mid' && s.curve) add('midpoint', [pid, s.curve])
    else if (s.kind === 'curve' && s.curve) add('onCurve', [pid, s.curve])
    else if (s.kind === 'cross' && s.curve && s.curve2) {
      add('onCurve', [pid, s.curve])
      add('onCurve', [pid, s.curve2])
    } else if (s.kind === 'quad' && s.curve) {
      add('onCurve', [pid, s.curve])
      const c = this.ix().curve(s.curve)
      if (c && c.kind !== 'line') {
        const o = this.ix().p(c.c)
        add(Math.abs(o.y - s.p[1]) < Math.abs(o.x - s.p[0]) ? 'hPoints' : 'vPoints', [c.c, pid])
      }
    }
    if (s.alignH) add('hPoints', [s.alignH, pid])
    if (s.alignV) add('vPoints', [s.alignV, pid])
  }

  /** Add a curve (construction when that mode is on). */
  addCurve(c: (Omit<LineCurve, 'id'> | Omit<CircleCurve, 'id'> | Omit<ArcCurve, 'id'>) & { id?: string }): string {
    const id = c.id ?? `c${this.sk.seq++}`
    const curve = { ...c, id } as Curve
    if (this.construction) curve.construction = true
    this.sk.curves.push(curve)
    return id
  }

  // ---- prompt, typed boxes --------------------------------------------------------

  say(): void {
    const main = el('span')
    if (this.tool) main.append(el('b', '', this.tool.name), document.createTextNode(`: ${this.tool.prompt()}`))
    else
      main.append(
        el('b', '', 'Sketch'),
        document.createTextNode(this.selected.size ? ': pick a relation below, or drag to move' : ': pick a tool, or click / drag to select and move geometry')
      )
    const tips = this.tool ? 'Esc ends the tool' : 'Enter or ✓ finishes the sketch'
    this.prompt.replaceChildren(main, el('span', 'vp-prompt-esc', tips))
    this.prompt.classList.toggle('above-strip', !!this.strip)
  }

  /** Show typed value boxes for the running tool (empty = none). */
  fields(list: Field[]): void {
    this.fieldBoxes.clear()
    this.strip?.remove()
    this.strip = null
    if (!list.length) return this.refreshStrip()
    const strip = el('div', 'vp-strip sk-strip')
    strip.addEventListener('pointerdown', (e) => e.stopPropagation())
    strip.append(el('b', 'vs-title', this.tool?.name ?? ''))
    for (const f of list) {
      const box = el('label', 'vs-field')
      box.append(el('span', '', f.label))
      const input = el('input')
      input.type = 'text'
      input.inputMode = 'decimal'
      input.placeholder = f.int ? '' : 'type'
      if (f.value !== undefined) input.value = String(f.value)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          this.tool?.typed?.()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (input.value && !f.int) input.value = ''
          else input.blur()
          this.tool?.typed && this.lastMove && this.onMove(this.lastMove)
        }
      })
      input.addEventListener('input', () => this.lastMove && this.onMove(this.lastMove))
      box.append(input)
      strip.append(box)
      this.fieldBoxes.set(f.key, input)
    }
    this.ctx.viewport.host.append(strip)
    this.strip = strip
    this.say()
  }

  /** A typed value, or null when the box is empty / not a number. */
  typedValue(key: string): number | null {
    const v = this.fieldBoxes.get(key)?.value.trim()
    if (!v) return null
    const n = Number(v.replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  setTyped(key: string, v: number | null): void {
    const b = this.fieldBoxes.get(key)
    if (b) b.value = v === null ? '' : fmt(v)
  }
  clearTyped(): void {
    for (const b of this.fieldBoxes.values()) if (b.placeholder) b.value = ''
  }

  /** With no tool running: the relations strip for the selection. */
  private refreshStrip(): void {
    if (this.tool) return
    this.strip?.remove()
    this.strip = null
    const s = this.selection()
    const n = s.points.length + s.lines.length + s.rounds.length
    if (!this.selected.size) return this.say()
    const strip = el('div', 'vp-strip sk-strip')
    strip.addEventListener('pointerdown', (e) => e.stopPropagation())
    strip.append(el('b', 'vs-title', n ? `${n} selected` : `${s.cons.length} relation${s.cons.length === 1 ? '' : 's'}`))
    for (const r of applicableRelations(this)) {
      const b = el('button', 'btn vs-text', r.label)
      b.title = r.tip
      b.addEventListener('click', () => r.run())
      strip.append(b)
    }
    if (s.lines.length + s.rounds.length) {
      const b = el('button', 'btn vs-text', 'Construction')
      b.title = 'Switch between construction and normal geometry (X)'
      b.addEventListener('click', () => this.toggleConstruction())
      strip.append(b)
    }
    const del = el('button', 'btn vs-text', 'Delete')
    del.title = 'Delete the selection (Del)'
    del.addEventListener('click', () => this.deleteSelected())
    strip.append(del)
    this.ctx.viewport.host.append(strip)
    this.strip = strip
    this.say()
  }

  // ---- tools ---------------------------------------------------------------------------

  setTool(t: Tool | null): void {
    this.cancelTool()
    this.tool = t
    this.selected.clear()
    if (!t) this.fields([])
    this.redraw()
    this.say()
    notify()
    if (t && this.lastMove) this.onMove(this.lastMove)
  }

  cancelTool(): void {
    if (!this.tool) return
    const t = this.tool
    this.tool = null
    t.dispose?.()
    this.clearPreview()
    this.showSnap(null)
    this.fields([])
    this.revert()
    this.say()
    notify()
  }

  /** The tool finished its job (but stays running for the next one). */
  toolDone(): void {
    this.clearPreview()
    this.say()
  }

  clearPreview(): void {
    for (const c of [...this.preview.children]) {
      this.preview.remove(c)
      disposeDrawing(c)
    }
    this.ctx.viewport.requestRender()
  }

  /** Draw temporary geometry for a tool (sketch coordinates). */
  previewLines(polys: P2[][], color = 0xffd166, dashed = false): void {
    const px = this.px
    for (const poly of polys) {
      if (poly.length < 2) continue
      const g = new THREE.BufferGeometry().setFromPoints(poly.map((p) => new THREE.Vector3(p[0], p[1], 0)))
      const m = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 5 * px, gapSize: 3 * px, depthTest: false, transparent: true })
        : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })
      const l = new THREE.Line(g, m)
      if (dashed) l.computeLineDistances()
      l.renderOrder = 35
      this.preview.add(l)
    }
    this.ctx.viewport.requestRender()
  }

  // ---- pointer --------------------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (e.button === 2) this.rightDown = { x: e.clientX, y: e.clientY }
    if (e.button !== 0 || this.handles.dragging) return
    this.valueEdit?.close(true)
    const s = this.snap(e, this.tool?.exclude?.() ?? new Set(), this.tool?.from?.() ?? null)
    if (!s) return
    e.stopImmediatePropagation()
    this.down = { x: e.clientX, y: e.clientY, snap: s, e }
    if (this.tool) return
    const q = this.local(e)!
    const hit = this.itemAt(q)
    if (hit) {
      // Dragging what's under the pointer (selecting it if it wasn't).
      const ix = this.ix()
      let ids: Set<string>
      let radius: string | undefined
      const c = ix.curve(hit)
      if (ix.pts.has(hit)) ids = new Set([hit])
      else if (c?.kind === 'circle' && !e.altKey) {
        ids = new Set()
        radius = c.id
      } else ids = new Set(c ? curvePoints(c) : [])
      if (this.selected.has(hit) && this.selected.size > 1) {
        ids = new Set()
        for (const id of this.selected) {
          if (ix.pts.has(id)) ids.add(id)
          const cc = ix.curve(id)
          if (cc) curvePoints(cc).forEach((p) => ids.add(p))
        }
        radius = undefined
      }
      this.drag = { ids, from: q, start: cloneSketch(this.sk), moved: false, radius }
    } else {
      const box = el('div', 'sk-box')
      this.ctx.viewport.host.append(box)
      this.box = { el: box, x: e.clientX, y: e.clientY }
    }
  }

  private queued = false
  private onMove(e: PointerEvent): void {
    if (e.target !== this.ctx.viewport.renderer.domElement && !this.drag && !this.box) return
    this.lastMove = e
    if (this.box) return this.dragBox(e)
    if (this.drag) {
      e.stopImmediatePropagation()
      return this.dragTo(e)
    }
    if (e.buttons & 6) return
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      const ev = this.lastMove!
      if (this.tool) {
        const s = this.snap(ev, this.tool.exclude?.() ?? new Set(), this.tool.from?.() ?? null)
        this.showSnap(s)
        if (s) this.tool.move(s, ev)
      } else {
        const q = this.local(ev)
        this.setHover(q ? this.itemAt(q) : null)
      }
    })
  }

  private dragTo(e: PointerEvent): void {
    const d = this.drag!
    const q = this.local(e)
    if (!q) return
    if (!d.moved && Math.hypot(e.clientX - this.down!.x, e.clientY - this.down!.y) < 4) return
    d.moved = true
    const trial = cloneSketch(d.start)
    const hold = new Set<string>(d.ids)
    if (d.radius) {
      const c = trial.curves.find((x) => x.id === d.radius)
      if (c?.kind === 'circle') {
        const o = trial.points.find((p) => p.id === c.c)!
        c.r = Math.max(1e-3, Math.hypot(q[0] - o.x, q[1] - o.y))
        hold.add(c.id)
      }
    } else {
      // A single point follows the snaps; a group moves by the pointer's travel.
      let dx = q[0] - d.from[0]
      let dy = q[1] - d.from[1]
      if (d.ids.size === 1) {
        const pid = [...d.ids][0]
        const s = this.snap(e, d.ids)
        const p0 = d.start.points.find((p) => p.id === pid)!
        if (s && s.kind !== 'free' && s.kind !== 'curve') {
          dx = s.p[0] - p0.x
          dy = s.p[1] - p0.y
        } else {
          dx = q[0] - p0.x
          dy = q[1] - p0.y
        }
        this.showSnap(s && s.kind !== 'free' ? s : null)
      }
      for (const p of trial.points)
        if (d.ids.has(p.id)) {
          p.x += dx
          p.y += dy
        }
    }
    const r = solveSketch(trial, { hold, quick: true })
    if (r.ok) {
      this.sk = trial
      this.redraw(this.lastPx || this.px)
    }
  }

  private dragBox(e: PointerEvent): void {
    const b = this.box!
    const r = this.ctx.viewport.host.getBoundingClientRect()
    const x0 = Math.min(b.x, e.clientX) - r.left
    const y0 = Math.min(b.y, e.clientY) - r.top
    Object.assign(b.el.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(e.clientX - b.x)}px`, height: `${Math.abs(e.clientY - b.y)}px` })
    // Left to right: whole items inside. Right to left: anything it touches (common CAD convention).
    b.el.classList.toggle('crossing', e.clientX < b.x)
  }

  private onUp(e: PointerEvent): void {
    if (e.button === 2) return this.onRightUp(e)
    if (e.button !== 0 || !this.down) return
    const down = this.down
    this.down = null
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
    if (this.box) {
      const b = this.box
      this.box = null
      b.el.remove()
      if (moved) this.boxSelect(b.x, b.y, e.clientX, e.clientY, e.shiftKey || e.ctrlKey)
      else if (!e.shiftKey && !e.ctrlKey) this.select([])
      return
    }
    if (this.drag) {
      const d = this.drag
      this.drag = null
      this.showSnap(null)
      if (d.moved) {
        // A dragged lone point that lands on another point / curve joins it.
        if (d.ids.size === 1 && !d.radius) {
          const pid = [...d.ids][0]
          const s = this.snap(e, d.ids)
          if (s && s.kind === 'point' && s.point) this.joinPoints(pid, s.point)
          else if (s && (s.kind === 'curve' || s.kind === 'mid' || s.kind === 'cross') && !this.ix().curvesAt(pid).some((c) => c.id === s.curve)) {
            this.autoRelations(pid, { ...s, alignH: undefined, alignV: undefined })
            if (!solveSketch(this.sk, { quick: true }).ok) this.sk = d.start
          }
        }
        this.commit('Drag sketch')
        return
      }
      const q = this.local(e)
      const hit = q ? this.itemAt(q) : null
      if (hit) this.select([hit], e.shiftKey || e.ctrlKey)
      return
    }
    if (this.tool && !moved) {
      const s = this.snap(e, this.tool.exclude?.() ?? new Set(), this.tool.from?.() ?? null)
      if (s) {
        this.tool.click(s, e)
        this.say()
        this.showSnap(null)
      }
    }
  }

  /** Merge two points (dragging one onto another). */
  private joinPoints(from: string, to: string): void {
    const trial = cloneSketch(this.sk)
    addConstraint(trial, { kind: 'coincident', refs: [to, from] })
    if (solveSketch(trial, { quick: true }).ok) this.sk = trial
  }

  private rightDown: { x: number; y: number } | null = null
  private onRightUp(e: PointerEvent): void {
    // Right click (no drag): end the line chain / tool step.
    const d = this.rightDown
    this.rightDown = null
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !this.tool) return
    if (this.tool.finish && this.tool.finish()) {
      this.say()
      return
    }
    this.setTool(null)
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const vp = this.ctx.viewport
    const r = vp.renderer.domElement.getBoundingClientRect()
    const minX = Math.min(x0, x1) - r.left
    const maxX = Math.max(x0, x1) - r.left
    const minY = Math.min(y0, y1) - r.top
    const maxY = Math.max(y0, y1) - r.top
    const crossing = x1 < x0
    const inside = (p: P2): boolean => {
      const s = vp.toScreen(this.world(p))
      return s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY
    }
    const ix = this.ix()
    const ids: string[] = []
    for (const c of this.sk.curves) {
      const pts = c.kind === 'line' ? lineEnds(ix, c) : Array.from({ length: 17 }, (_, i) => at(ix, c, (roundOf(ix, c).sweep * i) / 16))
      if (crossing ? pts.some(inside) : pts.every(inside)) ids.push(c.id)
    }
    for (const p of this.sk.points) if (inside([p.x, p.y]) && !ix.curvesAt(p.id).length) ids.push(p.id)
    this.select(ids, additive)
  }

  private onDouble(e: MouseEvent): void {
    if (this.tool) {
      // Double-click ends a chain (lines, splines).
      if (this.tool.finish && !this.tool.finish()) this.setTool(null)
      return
    }
    const q = this.local(e)
    if (!q) return
    void e
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
    if (document.querySelector('.modal-backdrop')) return
    if (e.key === 'Escape') {
      if (typing) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (this.valueEdit) return this.valueEdit.close(false)
      if (this.tool) {
        if (this.tool.back?.()) return this.say()
        return this.setTool(null)
      }
      if (this.selected.size) return this.select([])
      return
    }
    if (typing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (this.tool) {
        if (this.tool.finish && this.tool.finish()) return this.say()
        return this.setTool(null)
      }
      return this.finish()
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size && !this.tool) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return this.deleteSelected()
    }
    const run = !e.ctrlKey && !e.altKey && !e.metaKey ? editorKeys.get(e.key.toLowerCase()) : undefined
    if (run) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return run(this)
    }
    // Typing a number while a tool runs goes into its first box.
    if (this.tool && /^[0-9.\-]$/.test(e.key) && !e.ctrlKey && !e.altKey && this.fieldBoxes.size) {
      const first = [...this.fieldBoxes.values()].find((b) => b.placeholder) ?? [...this.fieldBoxes.values()][0]
      first.focus()
      first.select()
      return
    }
  }

  // ---- dimension labels --------------------------------------------------------------------

  private bindDimLabel(lab: HTMLElement, kid: string): void {
    let start: { x: number; y: number; off: [number, number]; moved: boolean; at: P2 } | null = null
    lab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      const k = this.sk.constraints.find((c) => c.id === kid)
      const q = this.local(e)
      if (!k || !q) return
      lab.setPointerCapture(e.pointerId)
      start = { x: e.clientX, y: e.clientY, off: k.label ?? [0, 14 * this.px], moved: false, at: q }
    })
    lab.addEventListener('pointermove', (e) => {
      if (!start) return
      if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 3) return
      start.moved = true
      const q = this.local(e)
      const k = this.sk.constraints.find((c) => c.id === kid)
      if (!q || !k) return
      k.label = [start.off[0] + q[0] - start.at[0], start.off[1] + q[1] - start.at[1]]
      this.redraw(this.lastPx || this.px)
    })
    lab.addEventListener('pointerup', (e) => {
      if (!start) return
      const s = start
      start = null
      lab.releasePointerCapture(e.pointerId)
      if (s.moved) this.commit('Move dimension')
      else this.select([kid], e.shiftKey || e.ctrlKey)
    })
    lab.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.editValue(kid)
    })
  }

  /**
   * Type a new value for a dimension, or drag its arrow handle; the sketch
   * follows live and Enter / clicking away keeps it.
   */
  editValue(kid: string): void {
    this.valueEdit?.close(true)
    const k = this.sk.constraints.find((c) => c.id === kid)
    const lab = this.labels.get(kid)
    if (!k || !lab) return
    if (k.driven) {
      this.ctx.status('A reference dimension only shows the size. Make it driving from the strip to change it.', 'info')
      return
    }
    const startSk = cloneSketch(this.sk)
    const startVal = k.value ?? 0
    const input = el('input', 'sk-dim-input')
    input.value = fmt(startVal)
    lab.textContent = ''
    lab.append(input)
    lab.classList.add('editing')
    input.focus()
    input.select()
    let live = startVal
    const tryValue = (v: number): void => {
      const trial = cloneSketch(startSk)
      if (solveValueEdit(trial, kid, v)) {
        this.sk = trial
        live = v
        this.redraw(this.lastPx || this.px)
      }
    }
    // Drag handle: an arrow along the direction the value grows.
    const handle = this.dimHandle(k, startVal, (v) => {
      input.value = fmt(v)
      tryValue(v)
    })
    const close = (apply: boolean): void => {
      this.valueEdit = null
      if (handle) this.handles.remove(handle)
      lab.classList.remove('editing')
      input.remove()
      const v = Number(input.value.replace(',', '.'))
      this.sk = startSk
      if (apply && Number.isFinite(v) && Math.abs(v - startVal) > 1e-12) this.setDimValue(kid, v)
      else if (apply && Math.abs(live - startVal) > 1e-12) this.setDimValue(kid, live)
      else this.redraw()
    }
    this.valueEdit = { close }
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') close(true)
      else if (e.key === 'Escape') close(false)
    })
    input.addEventListener('input', () => {
      const v = Number(input.value.replace(',', '.'))
      if (Number.isFinite(v) && v !== 0) tryValue(v)
    })
    input.addEventListener('blur', () => setTimeout(() => this.valueEdit?.close === close && !this.handles.dragging && close(true), 150))
  }

  private dimHandle(k: Constraint, value: number, onDrag: (v: number) => void): ReturnType<Handles['arrow']> | null {
    const ix = this.ix()
    const anchor = dimAnchor(ix, k)
    let origin: P2 = anchor
    let dir: P2 | null = null
    let scale = 1
    let base = 0
    if (k.kind === 'length' || k.kind === 'distance') {
      const [a, b] = k.kind === 'length' ? curveEnds(ix.curve(k.refs[0])!).map((p) => ix.p(p)) : k.refs.map((p) => ix.p(p))
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
      dir = [(b.x - a.x) / L, (b.y - a.y) / L]
      origin = [a.x, a.y]
    } else if (k.kind === 'distanceX' || k.kind === 'distanceY') {
      const a = ix.p(k.refs[0])
      const s = k.flag ?? 1
      dir = k.kind === 'distanceX' ? [s, 0] : [0, s]
      origin = [a.x, a.y]
    } else if (k.kind === 'radius' || k.kind === 'diameter') {
      const c = ix.curve(k.refs[0])
      if (!c || c.kind === 'line') return null
      const r = roundOf(ix, c)
      const lab = k.label ?? [1, 0]
      const L = Math.hypot(lab[0], lab[1]) || 1
      dir = [lab[0] / L, lab[1] / L]
      origin = r.c
      scale = k.kind === 'diameter' ? 0.5 : 1
    } else if (k.kind === 'pointLine') {
      const p = ix.p(k.refs[0])
      const c = ix.curve(k.refs[1])
      if (c?.kind !== 'line') return null
      const [a, b] = lineEnds(ix, c)
      const L = d2(a, b) || 1
      const s = k.flag ?? 1
      // Away from the line, on the point's side.
      dir = [(-(b[1] - a[1]) / L) * s, ((b[0] - a[0]) / L) * s]
      origin = [p.x - dir[0] * value, p.y - dir[1] * value]
    } else return null
    void base
    const o3 = this.world(origin)
    const d3 = this.world([origin[0] + dir[0], origin[1] + dir[1]]).sub(o3)
    return this.handles.arrow({
      origin: o3,
      dir: d3,
      value: value * scale,
      tip: 'Drag to change the value (Shift: free)',
      onDrag: (v) => onDrag(Math.max(1e-3, v / scale))
    })
  }

  // ---- finishing ---------------------------------------------------------------------

  private back(): void {
    if (this.tool?.back?.()) return this.say()
    if (this.tool) return this.setTool(null)
    this.ctx.doc.history.undo()
  }

  /** Finish editing: an empty new sketch is dropped. */
  finish(): void {
    this.valueEdit?.close(true)
    this.cancelTool()
    const empty = !this.sk.curves.length && !this.sk.points.length
    const id = this.id
    this.close()
    if (empty && this.isNew) this.ctx.doc.removeSketch(id)
    else this.ctx.status(`${this.sk.name} finished`, 'success')
  }

  /** Cancel: throw away everything changed since the sketch was opened. */
  discard(): void {
    this.valueEdit?.close(false)
    this.cancelTool()
    const id = this.id
    const changed = JSON.stringify(this.startState) !== JSON.stringify(this.sk)
    this.close()
    if (this.isNew) this.ctx.doc.removeSketch(id)
    else if (changed) this.ctx.doc.updateSketch(id, cloneSketch(this.sk), this.startState, 'Cancel sketch edits')
  }

  close(): void {
    if (current !== this) return
    current = null
    this.tool?.dispose?.()
    this.tool = null
    this.off.forEach((f) => f())
    this.handles.dispose()
    for (const lab of this.labels.values()) lab.remove()
    for (const g of this.glyphs) g.el.remove()
    this.prompt.remove()
    this.status.remove()
    this.strip?.remove()
    this.box?.el.remove()
    const vp = this.ctx.viewport
    if (this.drawing) {
      vp.scene.remove(this.drawing)
      disposeDrawing(this.drawing)
    }
    this.clearPreview()
    this.showSnap(null)
    vp.scene.remove(this.preview, this.snapMark)
    vp.requestRender()
    notify()
  }
}

// ---- relations for the current selection --------------------------------------------------

interface RelationAction {
  label: string
  tip: string
  run(): void
}

/** The relations that make sense for what is selected (like SolidWorks' Add Relations). */
export function applicableRelations(ed: SketchEditor): RelationAction[] {
  const s = ed.selection()
  const P = s.points
  const L = s.lines
  const C = s.rounds
  const only = (p: number, l: number, c: number): boolean => P.length === p && L.length === l && C.length === c
  const out: RelationAction[] = []
  const ix = ed.ix()
  const rel = (label: string, tip: string, list: Omit<Constraint, 'id'>[]): void => {
    out.push({
      label,
      tip,
      run: () => {
        let added = 0
        for (const c of list) if (ed.constrain(c, undefined, list.length > 1)) added++
        if (list.length > 1 && added < list.length) ed.ctx.status(`${added} of ${list.length} added; the rest were already defined`, 'info')
        ed.select([])
      }
    })
  }
  if (only(2, 0, 0)) {
    rel('Coincident', 'Join the two points', [{ kind: 'coincident', refs: [P[0], P[1]] }])
    rel('Horizontal', 'Line the points up level', [{ kind: 'hPoints', refs: [P[0], P[1]] }])
    rel('Vertical', 'Line the points up upright', [{ kind: 'vPoints', refs: [P[0], P[1]] }])
  }
  if (P.length && !L.length && !C.length) rel('Fix', 'Hold the point(s) where they are', P.map((p) => ({ kind: 'fix' as const, refs: [p], at: [ix.p(p).x, ix.p(p).y] as [number, number] })))
  if (only(1, 1, 0)) {
    rel('On line', 'Put the point on the line', [{ kind: 'onCurve', refs: [P[0], L[0]] }])
    rel('Midpoint', 'Put the point at the middle of the line', [{ kind: 'midpoint', refs: [P[0], L[0]] }])
  }
  if (only(1, 0, 1)) {
    rel('On curve', 'Put the point on the circle / arc', [{ kind: 'onCurve', refs: [P[0], C[0]] }])
    rel('At centre', 'Put the point at the centre', [{ kind: 'coincident', refs: [P[0], (ix.curve(C[0]) as { c: string }).c] }])
  }
  if (only(2, 1, 0)) rel('Symmetric', 'Mirror the two points about the line', [{ kind: 'symmetric', refs: [P[0], P[1], L[0]] }])
  if (L.length && !P.length && !C.length) {
    rel('Horizontal', 'Make the line(s) level', L.map((l) => ({ kind: 'horizontal' as const, refs: [l] })))
    rel('Vertical', 'Make the line(s) upright', L.map((l) => ({ kind: 'vertical' as const, refs: [l] })))
  }
  if (L.length >= 2 && !P.length && !C.length) {
    rel('Parallel', 'Make the lines parallel', L.slice(1).map((l) => ({ kind: 'parallel' as const, refs: [L[0], l] })))
    rel('Equal', 'Make the lines the same length', L.slice(1).map((l) => ({ kind: 'equal' as const, refs: [L[0], l] })))
  }
  if (only(0, 2, 0)) {
    rel('Perpendicular', 'Put the lines at right angles', [{ kind: 'perpendicular', refs: [L[0], L[1]] }])
    rel('Collinear', 'Put the lines on one line', [{ kind: 'collinear', refs: [L[0], L[1]] }])
  }
  if (only(0, 1, 1) || only(0, 0, 2)) {
    const [a, b] = only(0, 1, 1) ? [L[0], C[0]] : [C[0], C[1]]
    rel('Tangent', 'Make them touch smoothly', [{ kind: 'tangent', refs: [a, b], flag: tangentSide(ed, a, b) }])
  }
  if (C.length >= 2 && !P.length && !L.length) {
    rel('Equal', 'Make the radii the same', C.slice(1).map((c) => ({ kind: 'equal' as const, refs: [C[0], c] })))
    rel('Concentric', 'Give them one centre', C.slice(1).map((c) => ({ kind: 'concentric' as const, refs: [C[0], c] })))
  }
  if (s.cons.length) {
    const ks = s.cons.map((id) => ix.cons.get(id)!).filter(Boolean)
    if (ks.some((k) => isDim(k))) {
      out.push({
        label: ks.every((k) => k.driven) ? 'Make driving' : 'Make reference',
        tip: 'Switch between a driving dimension and a reference one that only shows the size',
        run: () => {
          const toDriving = ks.every((k) => k.driven)
          for (const k of ks) {
            if (!isDim(k)) continue
            const kk = ed.sk.constraints.find((c) => c.id === k.id)!
            if (toDriving) {
              kk.driven = undefined
              kk.value = measureDim(ed.sk, kk)
            } else kk.driven = true
          }
          if (toDriving && !solveSketch(cloneSketch(ed.sk)).ok) {
            ed.revert()
            ed.ctx.status('Making it driving would over-define the sketch', 'warn')
            return
          }
          ed.commit(toDriving ? 'Make dimension driving' : 'Make dimension reference')
        }
      })
    }
    if (ks.some((k) => k.kind === 'radius' || k.kind === 'diameter'))
      out.push({
        label: 'Ø / R',
        tip: 'Show diameter or radius',
        run: () => {
          for (const k of ks) {
            const kk = ed.sk.constraints.find((c) => c.id === k.id)!
            if (kk.kind === 'radius') {
              kk.kind = 'diameter'
              kk.value = (kk.value ?? 0) * 2
            } else if (kk.kind === 'diameter') {
              kk.kind = 'radius'
              kk.value = (kk.value ?? 0) / 2
            }
          }
          ed.commit('Switch radius / diameter')
        }
      })
  }
  return out
}

/** Which side / sense a tangency has now (so adding it doesn't flip anything). */
export function tangentSide(ed: SketchEditor, a: string, b: string): number {
  const ix = ed.ix()
  const ca = ix.curve(a)!
  const cb = ix.curve(b)!
  if (ca.kind === 'line' || cb.kind === 'line') {
    const [ln, rd] = ca.kind === 'line' ? [ca, cb] : [cb, ca]
    if (ln.kind !== 'line' || rd.kind === 'line') return 1
    const [p, q] = lineEnds(ix, ln)
    const o = ix.p(rd.c)
    const d: P2 = [q[0] - p[0], q[1] - p[1]]
    return d[0] * (o.y - p[1]) - d[1] * (o.x - p[0]) >= 0 ? 1 : -1
  }
  const r1 = roundOf(ix, ca)
  const r2 = roundOf(ix, cb)
  const dc = d2(r1.c, r2.c)
  return Math.abs(dc - (r1.r + r2.r)) <= Math.abs(dc - Math.abs(r1.r - r2.r)) ? 1 : -1
}
