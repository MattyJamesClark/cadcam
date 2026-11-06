import * as THREE from 'three'
import type { ModuleContext } from '@/core/types'
import { solidCad, type SolidMake, type Vec3 } from '@/core/occt'
import { pickAt } from '@/core/picking'
import { selection } from '@/core/selection'
import { showCmdBar } from '@/core/cmdbar'
import { el, fmt } from '@/core/toolpanel'
import { Handles, worldPerPixel, type ArrowSpec, type RingSpec } from '@/core/handles'
import { partMaterial } from '@/core/io'
import { activeEditor } from '@/sketch/editor'
import type { SketchData } from '@/sketch/model'
import { insidePoly, type P2 } from '@/sketch/geom'
import {
  centroid,
  chainFrom,
  curveNear,
  defaultAxis,
  findRegions,
  frameOf,
  kernelProfiles,
  lineNear,
  onPlane,
  regionAt,
  reverseChain,
  toWorld,
  type Chain,
  type Region,
  type SketchFrame
} from './profile'
import { extrudeStations, pathStations, regionFill, revolveStations, sweepMesh } from './preview'
import { bodyName, checkBox, geometryOf, MODE_COLOUR, MODE_LABEL, numberBox, previewMaterial, solidBodies, strSeg, transformMake, type Mode } from './common'

/**
 * Extrude, Revolve and Sweep: one command each, sharing this tool.
 *
 *  1. Profile: closed regions of a sketch (click to add / remove; the sketch
 *     being edited, or the last one, is used straight away).
 *  2. Revolve: the axis (a sketch line; a lone centreline is taken for you).
 *     Sweep: the path (a chain of curves in another sketch).
 *  3. Values typed in the strip or dragged on screen (arrow for distance, ring
 *     for angle). An instant mesh follows the drag; the exact solid from the
 *     kernel replaces it when the drag stops.
 *  4. New body, or Add to / Cut from / Intersect with a target body (picked
 *     for you where the new shape meets one; click a body to change it).
 *
 * The tick (or Enter) applies it as one undo step. No feature history: the
 * result is a plain body, and the sketch stays parametric for next time.
 */

export type FeatureKind = 'extrude' | 'revolve' | 'sweep'
const TITLE: Record<FeatureKind, string> = { extrude: 'Extrude', revolve: 'Revolve', sweep: 'Sweep' }

let active: FeatureTool | null = null
export const featureRunning = (): boolean => active !== null
const counters: Record<string, number> = {}

export function openFeature(ctx: ModuleContext, kind: FeatureKind, mode?: Mode): void {
  if (active) active.close()
  // A sketch being edited is finished and used.
  const ed = activeEditor()
  const editing = ed?.id
  if (ed) ed.finish()
  const shown = ctx.doc.sketches.filter((s) => s.visible || s.id === editing)
  // Shown sketches first; a used (hidden) sketch is picked up again if nothing else is on screen.
  let withRegions = shown.filter((s) => findRegions(s).length)
  if (!withRegions.length) withRegions = ctx.doc.sketches.filter((s) => findRegions(s).length)
  if (!withRegions.length) {
    ctx.status('Draw a closed profile in a sketch first (Sketch tab).', 'warn')
    return
  }
  const start = withRegions.find((s) => s.id === editing) ?? withRegions[withRegions.length - 1]
  active = new FeatureTool(ctx, kind, start, mode)
}

type Step = 'profile' | 'axis' | 'path' | 'target'

class FeatureTool {
  private sketch: SketchData
  private frame: SketchFrame
  private regions: Region[] = []
  private picked = new Set<number>()
  private hoverRegion = -1
  private step: Step = 'profile'
  private mode: Mode
  private target: THREE.Mesh | null = null
  private userTarget = false

  // extrude
  private distance = 20
  private both = false
  private through = false
  private draft = 0
  /** The user set the direction (typed a sign, flipped or dragged): don't aim it at the target any more. */
  private userDir = false
  // revolve
  private angle = 360
  private axis: { a: P2; b: P2 } | null = null
  private axisName = ''
  // sweep
  private path: Chain | null = null

  private vp
  private prompt = el('div', 'vp-prompt above-strip')
  private strip = el('div', 'vp-strip part-strip')
  private overlay = new THREE.Group()
  private fills = new THREE.Group()
  private preview: THREE.Mesh | null = null
  private result: { geo: THREE.BufferGeometry; key: string } | null = null
  private hiddenTarget: THREE.Mesh | null = null
  private runId = 0
  private timer = 0
  private busy = false
  private error = ''
  private off: (() => void)[] = []
  private handles: Handles
  private arrow: ArrowSpec | null = null
  private ring: RingSpec | null = null
  private boxes: { dist?: HTMLInputElement; angle?: HTMLInputElement } = {}
  private modeSeg!: { el: HTMLElement; set(v: Mode): void }
  private targetText = el('span', 'vs-label part-target')
  private profileText = el('span', 'vs-label')
  private pathText = el('span', 'vs-label')
  private axisText = el('span', 'vs-label')
  private throughBox: { label: HTMLLabelElement; box: HTMLInputElement } | null = null

  constructor(
    private ctx: ModuleContext,
    private kind: FeatureKind,
    sketch: SketchData,
    mode?: Mode
  ) {
    this.vp = ctx.viewport
    const vp = this.vp
    this.sketch = sketch
    this.frame = frameOf(sketch)
    this.mode = mode ?? (solidBodies(ctx).length ? 'fuse' : 'new')
    if (this.mode === 'cut') this.through = kind === 'extrude'
    this.overlay.name = '__part-overlay'
    this.overlay.renderOrder = 6
    this.overlay.add(this.fills)
    vp.scene.add(this.overlay)
    this.off.push(() => {
      vp.scene.remove(this.overlay)
      this.disposeGroup(this.overlay)
    })
    vp.host.append(this.prompt, this.strip)
    vp.blockPick = () => true
    this.handles = new Handles(vp)
    this.off.push(() => this.handles.dispose())
    const bar = showCmdBar(vp.host, { ok: () => void this.ok(), cancel: () => this.close(), back: () => this.back() })
    this.off.push(() => bar.dispose())
    this.useSketch(sketch, true)
    if (kind === 'revolve') {
      const ax = defaultAxis(sketch)
      if (ax) this.setAxis(ax, 'centreline')
    }
    this.buildStrip()
    this.listen()
    this.advance()
    this.refresh()
  }

  // ---- input ----------------------------------------------------------------

  private listen(): void {
    const vp = this.vp
    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    let queued: PointerEvent | null = null
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || this.handles.dragging || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      this.click(e)
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = queued!
        queued = null
        if (ev.buttons) return
        this.hover(ev)
      })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.close()
      else if (e.key === 'Enter') void this.ok()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey, true)
    const offDoc = this.ctx.doc.on('sketches', () => this.sketchesChanged())
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey, true)
      if (typeof offDoc === 'function') offDoc()
    })
  }

  private sketchesChanged(): void {
    if (!active) return
    const s = this.ctx.doc.sketches.find((x) => x.id === this.sketch.id)
    if (!s) return this.close()
    if (s !== this.sketch) this.useSketch(s, false)
  }

  private ray(e: { clientX: number; clientY: number }): THREE.Ray {
    const rc = new THREE.Raycaster()
    rc.setFromCamera(this.vp.ndcOf(e), this.vp.camera)
    return rc.ray
  }

  /** Tolerance in sketch mm for picking a curve under the pointer. */
  private tol(at: THREE.Vector3): number {
    return worldPerPixel(this.vp, this.vp.camera, at) * 8
  }

  /** The region of any visible sketch under the pointer. */
  private regionUnder(e: PointerEvent): { s: SketchData; i: number } | null {
    const ray = this.ray(e)
    let best: { s: SketchData; i: number; d: number } | null = null
    for (const s of this.ctx.doc.sketches) {
      if (!s.visible && s.id !== this.sketch.id) continue
      const f = s.id === this.sketch.id ? this.frame : frameOf(s)
      const q = onPlane(f, ray)
      if (!q) continue
      const regions = s.id === this.sketch.id ? this.regions : findRegions(s)
      const i = regionAt(regions, q)
      if (i < 0) continue
      const d = toWorld(f, q).distanceTo(ray.origin)
      if (!best || d < best.d) best = { s, i, d }
    }
    return best
  }

  private hover(e: PointerEvent): void {
    let h = -1
    if (this.step === 'profile') {
      const r = this.regionUnder(e)
      if (r && r.s.id === this.sketch.id) h = r.i
    }
    if (h !== this.hoverRegion) {
      this.hoverRegion = h
      this.drawFills()
    }
  }

  private click(e: PointerEvent): void {
    const ray = this.ray(e)
    if (this.step === 'axis') {
      const q = onPlane(this.frame, ray)
      const line = q && lineNear(this.sketch, q, this.tol(toWorld(this.frame, q)))
      if (!line) return this.say('Click a line of the sketch to turn about.')
      this.setAxis(line, 'sketch line')
      this.advance()
      return this.refresh()
    }
    if (this.step === 'path') {
      for (const s of this.ctx.doc.sketches) {
        if (!s.visible || s.id === this.sketch.id) continue
        const f = frameOf(s)
        const q = onPlane(f, ray)
        if (!q) continue
        const c = curveNear(s, q, this.tol(toWorld(f, q)))
        if (!c) continue
        this.setPath(chainFrom(s, c))
        this.advance()
        return this.refresh()
      }
      return this.say('Click a curve of the path sketch (it must be in another sketch, crossing the profile).')
    }
    const r = this.regionUnder(e)
    if (r) {
      if (r.s.id !== this.sketch.id) {
        this.useSketch(r.s, false)
        this.picked = new Set([r.i])
      } else if (this.picked.has(r.i)) this.picked.delete(r.i)
      else this.picked.add(r.i)
      this.advance()
      return this.refresh()
    }
    // Otherwise a body: the target.
    const p = pickAt(this.vp, e, { body: true, face: true })
    const m = p?.object as THREE.Mesh | undefined
    if (m?.isMesh && m.geometry.userData.brep) {
      this.target = m
      this.userTarget = true
      if (this.mode === 'new') this.setMode('fuse')
      this.refresh()
    }
  }

  // ---- state -----------------------------------------------------------------

  private useSketch(s: SketchData, initial: boolean): void {
    const same = s.id === this.sketch.id
    this.sketch = s
    this.frame = frameOf(s)
    const old = this.regions
    this.regions = findRegions(s)
    if (!same || initial || old.length !== this.regions.length) {
      // Start with the outermost regions (a plate with its holes, not the hole fillings).
      this.picked = new Set(this.regions.map((_, i) => i).filter((i) => !this.regions.some((o, j) => j !== i && o.holes.some((h) => h.poly.length && insidePoly(h.poly, centroid(this.regions[i]))))))
      if (!same && this.kind === 'revolve') {
        const ax = defaultAxis(s)
        this.axis = null
        if (ax) this.setAxis(ax, 'centreline')
      }
    }
  }

  private setAxis(ax: { a: P2; b: P2 } | 'x' | 'y', name: string): void {
    this.axis = ax === 'x' ? { a: [0, 0], b: [1, 0] } : ax === 'y' ? { a: [0, 0], b: [0, 1] } : { a: ax.a, b: ax.b }
    this.axisName = name
  }

  private setPath(ch: Chain | null): void {
    if (!ch) return
    // Run the path away from the profile.
    const c = this.picked.size ? toWorld(this.frame, centroid(this.regions[[...this.picked][0]])) : this.frame.origin
    this.path = ch.poly[0].distanceTo(c) <= ch.poly[ch.poly.length - 1].distanceTo(c) ? ch : reverseChain(ch)
  }

  private setMode(m: Mode): void {
    this.mode = m
    this.modeSeg?.set(m)
    if (this.throughBox) {
      this.throughBox.label.classList.toggle('hidden', m === 'new')
      if (m === 'new') this.through = false
      this.throughBox.box.checked = this.through
    }
  }

  /** Move to the next thing that needs picking. */
  private advance(): void {
    if (!this.picked.size) this.step = 'profile'
    else if (this.kind === 'revolve' && !this.axis) this.step = 'axis'
    else if (this.kind === 'sweep' && !this.path) this.step = 'path'
    else this.step = 'profile'
  }

  private back(): void {
    if (this.kind === 'sweep' && this.path) this.path = null
    else if (this.kind === 'revolve' && this.axis) this.axis = null
    else this.picked.clear()
    this.advance()
    this.refresh()
  }

  private ready(): boolean {
    if (!this.picked.size) return false
    if (this.kind === 'revolve' && !this.axis) return false
    if (this.kind === 'sweep' && !this.path) return false
    if (this.kind === 'extrude' && !this.through && Math.abs(this.distance) < 1e-6) return false
    if (this.kind === 'revolve' && Math.abs(this.angle) < 1e-6) return false
    if (this.mode !== 'new' && !this.target) return false
    return true
  }

  private selectedRegions(): Region[] {
    return [...this.picked].sort((a, b) => a - b).map((i) => this.regions[i]).filter(Boolean)
  }

  // ---- strip -------------------------------------------------------------------

  private buildStrip(): void {
    const s = this.strip
    s.addEventListener('pointerdown', (e) => e.stopPropagation())
    s.append(el('b', 'vs-title', TITLE[this.kind]))
    const sep = (): HTMLElement => el('span', 'vs-sep')
    const prof = el('div', 'vs-group')
    prof.append(el('span', 'vs-label', 'Profile'), this.profileText)
    s.append(prof, sep())

    if (this.kind === 'extrude') {
      const d = numberBox('Distance', 'mm', this.distance, 'How far to extrude (negative goes the other way). Or drag the arrow.', (v) => {
        if (Math.sign(v) !== Math.sign(this.distance)) this.userDir = true
        this.distance = v
        this.changed()
      })
      this.boxes.dist = d.box
      const flip = el('button', 'btn vs-text', 'Flip')
      flip.title = 'Extrude the other way'
      flip.addEventListener('click', () => {
        this.distance = -this.distance
        this.userDir = true
        d.box.value = fmt(this.distance)
        this.changed()
      })
      d.group.append(flip)
      const both = checkBox('Both sides', 'Symmetric: half the distance each side of the sketch', this.both, (v) => {
        this.both = v
        this.changed()
      })
      this.throughBox = checkBox('Through all', 'Right through the target body', this.through, (v) => {
        this.through = v
        this.changed()
      })
      const draft = numberBox('Draft', '°', this.draft, 'Taper on the side walls in degrees: positive narrows away from the sketch, negative widens', (v) => {
        this.draft = v
        this.changed()
      })
      d.group.append(both.label, this.throughBox.label)
      s.append(d.group, draft.group, sep())
    } else if (this.kind === 'revolve') {
      const a = numberBox('Angle', '°', this.angle, 'Degrees round the axis (negative turns the other way). Or drag the ring.', (v) => {
        this.angle = v
        this.changed()
      })
      this.boxes.angle = a.box
      for (const v of [360, 180, 90]) {
        const b = el('button', 'btn vs-text', `${v}°`)
        b.addEventListener('click', () => {
          this.angle = Math.sign(this.angle || 1) * v
          a.box.value = fmt(this.angle)
          this.changed()
        })
        a.group.append(b)
      }
      const flip = el('button', 'btn vs-text', 'Flip')
      flip.title = 'Turn the other way'
      flip.addEventListener('click', () => {
        this.angle = -this.angle
        a.box.value = fmt(this.angle)
        this.changed()
      })
      a.group.append(flip)
      const ax = el('div', 'vs-group')
      ax.append(el('span', 'vs-label', 'Axis'), this.axisText)
      const pick = el('button', 'btn vs-text', 'Pick line')
      pick.title = 'Click a line of the sketch to turn about'
      pick.addEventListener('click', () => {
        this.step = 'axis'
        this.refresh()
      })
      const sx = el('button', 'btn vs-text', 'Sketch X')
      sx.addEventListener('click', () => {
        this.setAxis('x', 'sketch X')
        this.advance()
        this.changed()
      })
      const sy = el('button', 'btn vs-text', 'Sketch Y')
      sy.addEventListener('click', () => {
        this.setAxis('y', 'sketch Y')
        this.advance()
        this.changed()
      })
      ax.append(pick, sx, sy)
      s.append(a.group, sep(), ax, sep())
    } else {
      const p = el('div', 'vs-group')
      const pick = el('button', 'btn vs-text', 'Pick path')
      pick.title = 'Click a curve in another sketch; everything joined to it end to end is the path'
      pick.addEventListener('click', () => {
        this.step = 'path'
        this.refresh()
      })
      p.append(el('span', 'vs-label', 'Path'), this.pathText, pick)
      s.append(p, sep())
    }

    const m = el('div', 'vs-group')
    this.modeSeg = strSeg<Mode>(
      (['new', 'fuse', 'cut', 'common'] as Mode[]).map((k) => [k, MODE_LABEL[k], k === 'new' ? 'Make a separate body' : `${MODE_LABEL[k]}: combine with the target body`]),
      this.mode,
      (v) => {
        this.setMode(v)
        this.changed()
      }
    )
    m.append(this.modeSeg.el)
    const t = el('div', 'vs-group')
    t.append(el('span', 'vs-label', 'Target'), this.targetText)
    t.title = 'The body to add to / cut from. Click a body in the view to change it.'
    s.append(m, t)
    this.setMode(this.mode)
  }

  private say(note?: string): void {
    const main = el('span')
    const n = this.picked.size
    const what =
      this.step === 'axis' ? 'click the line to turn about'
      : this.step === 'path' ? 'click the path (a curve in another sketch)'
      : !n ? 'click inside a closed profile'
      : this.mode !== 'new' && !this.target ? 'click the body to ' + (this.mode === 'fuse' ? 'add to' : this.mode === 'cut' ? 'cut from' : 'intersect with')
      : `${n} profile${n === 1 ? '' : 's'}; click profiles to add / remove, a body to change the target`
    main.append(el('b', '', TITLE[this.kind]), document.createTextNode(`: ${what}`))
    this.prompt.replaceChildren(main)
    const msg = note ?? (this.error || (this.busy ? 'Working…' : ''))
    if (msg) this.prompt.append(el('span', 'vp-prompt-note', msg))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Enter / tick to apply, Esc to cancel'))
    // Sit just above the strip, however many rows it takes.
    requestAnimationFrame(() => (this.prompt.style.bottom = `${this.strip.offsetHeight + 64}px`))
  }

  // ---- drawing ---------------------------------------------------------------------

  private disposeGroup(g: THREE.Object3D): void {
    g.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
  }

  private drawFills(): void {
    for (const c of [...this.fills.children]) {
      this.fills.remove(c)
      ;(c as THREE.Mesh).geometry?.dispose()
    }
    const add = (geo: THREE.BufferGeometry, color: number, opacity: number): void => {
      const m = new THREE.Mesh(geo, previewMaterial(color, opacity))
      m.renderOrder = 7
      m.raycast = () => {}
      this.fills.add(m)
    }
    const sel = this.selectedRegions()
    if (sel.length) add(regionFill(this.frame, sel), 0xff9f1c, 0.35)
    if (this.hoverRegion >= 0 && !this.picked.has(this.hoverRegion)) add(regionFill(this.frame, [this.regions[this.hoverRegion]]), 0xfff1a8, 0.35)
    // Revolve axis / sweep path.
    const line = (pts: THREE.Vector3[], color: number, dashed: boolean): void => {
      const g = new THREE.BufferGeometry().setFromPoints(pts)
      const mat = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 4, gapSize: 3, depthTest: false }) : new THREE.LineBasicMaterial({ color, depthTest: false })
      const l = new THREE.Line(g, mat)
      if (dashed) l.computeLineDistances()
      l.renderOrder = 9
      this.fills.add(l)
    }
    if (this.kind === 'revolve' && this.axis) {
      const { o, d } = this.axisWorld()!
      const size = this.profileSize() * 1.3 + 10
      line([o.clone().addScaledVector(d, -size), o.clone().addScaledVector(d, size)], 0xff9f1c, true)
    }
    if (this.kind === 'sweep' && this.path) line(this.path.poly, 0xff9f1c, false)
    this.vp.requestRender()
  }

  private profileSize(): number {
    let r = 0
    for (const reg of this.selectedRegions()) for (const p of reg.outer.poly) r = Math.max(r, Math.hypot(p[0], p[1]))
    return r
  }

  /** Revolve axis in the world: a point on it near the profile, and its direction. */
  private axisWorld(): { o: THREE.Vector3; d: THREE.Vector3 } | null {
    if (!this.axis) return null
    const a = toWorld(this.frame, this.axis.a)
    const d = toWorld(this.frame, this.axis.b).sub(a).normalize()
    const sel = this.selectedRegions()
    const c = sel.length ? toWorld(this.frame, centroid(sel[0])) : a
    const o = a.clone().addScaledVector(d, c.clone().sub(a).dot(d))
    return { o, d }
  }

  /** Extrude extent along the normal: [from, to]. */
  private extent(): [number, number] {
    let d = this.distance
    if (this.through && this.target) {
      // Far enough to clear the target's box in the chosen direction.
      const sign = Math.sign(d) || 1
      const box = new THREE.Box3().setFromObject(this.target)
      let far = 0
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        far = Math.max(far, new THREE.Vector3(x, y, z).sub(this.frame.origin).dot(this.frame.normal) * sign)
      }
      d = sign * (far + 1)
      if (this.both) {
        let back = 0
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          back = Math.max(back, -new THREE.Vector3(x, y, z).sub(this.frame.origin).dot(this.frame.normal) * sign)
        }
        return sign > 0 ? [-(back + 1), d] : [d, back + 1]
      }
      return sign > 0 ? [0, d] : [d, 0]
    }
    if (this.both) return [-Math.abs(d) / 2, Math.abs(d) / 2]
    return d >= 0 ? [0, d] : [d, 0]
  }

  private fastGeometry(): THREE.BufferGeometry | null {
    const sel = this.selectedRegions()
    if (!sel.length) return null
    try {
      if (this.kind === 'extrude') {
        const [from, to] = this.extent()
        if (Math.abs(to - from) < 1e-6) return null
        return sweepMesh(this.frame, sel, extrudeStations(this.frame, from, to, this.draft))
      }
      if (this.kind === 'revolve') {
        const ax = this.axisWorld()
        if (!ax || Math.abs(this.angle) < 1e-6) return null
        const full = Math.abs(Math.abs(this.angle) - 360) < 1e-6
        return sweepMesh(this.frame, sel, revolveStations(ax.o, ax.d, this.angle), { capStart: !full, capEnd: !full })
      }
      if (!this.path) return null
      return sweepMesh(this.frame, sel, pathStations(this.path.poly), { capStart: !this.path.closed, capEnd: !this.path.closed })
    } catch {
      return null
    }
  }

  private showMesh(geo: THREE.BufferGeometry | null, color: number, opacity: number, exact: boolean): void {
    if (this.preview) {
      this.overlay.remove(this.preview)
      if (!this.preview.userData.keep) this.preview.geometry.dispose()
      ;(this.preview.material as THREE.Material).dispose()
      this.preview = null
    }
    this.showTarget(true)
    if (geo) {
      this.preview = new THREE.Mesh(geo, previewMaterial(color, opacity))
      this.preview.raycast = () => {}
      this.preview.renderOrder = 5
      this.overlay.add(this.preview)
      // The exact result stands in for the target body.
      if (exact && this.mode !== 'new') this.showTarget(false)
    }
    this.vp.requestRender()
  }

  private showTarget(v: boolean): void {
    if (v && this.hiddenTarget) {
      this.hiddenTarget.visible = true
      this.hiddenTarget = null
    } else if (!v && this.target && !this.hiddenTarget) {
      this.hiddenTarget = this.target
      this.target.visible = false
    }
  }

  // ---- handles -----------------------------------------------------------------

  private placeHandles(): void {
    const sel = this.selectedRegions()
    const showArrow = this.kind === 'extrude' && sel.length > 0 && !this.through
    if (!showArrow && this.arrow) {
      this.handles.remove(this.arrow)
      this.arrow = null
    }
    if (showArrow) {
      const c = toWorld(this.frame, centroid(sel[0]))
      const value = this.both ? Math.abs(this.distance) / 2 : this.distance
      if (!this.arrow)
        this.arrow = this.handles.arrow({
          origin: c,
          dir: this.frame.normal.clone(),
          value,
          tip: 'Drag to set the distance (Shift: no snap)',
          onDrag: (v) => {
            this.userDir = true
            this.distance = this.both ? Math.abs(v) * 2 * (Math.sign(this.distance) || 1) : v
            this.boxes.dist!.value = fmt(this.distance)
            this.changed()
          },
          onEnd: () => this.changed()
        })
      this.arrow.origin.copy(c)
      this.arrow.dir.copy(this.frame.normal)
      this.arrow.value = value
    }
    const ax = this.kind === 'revolve' && sel.length ? this.axisWorld() : null
    if (!ax && this.ring) {
      this.handles.remove(this.ring)
      this.ring = null
    }
    if (ax) {
      if (!this.ring)
        this.ring = this.handles.ring({
          centre: ax.o.clone(),
          axis: ax.d.clone(),
          value: this.angle,
          tip: 'Drag round to set the angle (snaps to 5°, Shift: free)',
          onDrag: (v) => {
            this.angle = v
            this.boxes.angle!.value = fmt(v)
            this.changed()
          },
          onEnd: () => this.changed()
        })
      this.ring.centre.copy(ax.o)
      this.ring.axis.copy(ax.d)
      this.ring.value = this.angle
    }
    this.handles.update()
  }

  // ---- preview and apply -----------------------------------------------------------

  /** Whole refresh after a pick. */
  private refresh(): void {
    const n = this.picked.size
    this.profileText.textContent = n ? `${n} region${n === 1 ? '' : 's'} in ${this.sketch.name}` : 'none'
    this.axisText.textContent = this.axis ? this.axisName : 'none'
    this.pathText.textContent = this.path ? `${this.path.curves.length} curve${this.path.curves.length === 1 ? '' : 's'} in ${this.path.sketch.name}` : 'none'
    this.drawFills()
    this.changed()
  }

  /** A value changed: instant preview now, exact solid shortly (not while dragging). */
  private changed(): void {
    window.clearTimeout(this.timer)
    this.runId++
    this.result = null
    this.busy = false
    this.error = ''
    if (!this.userTarget) this.autoTarget()
    this.aim()
    const fast = this.fastGeometry()
    this.targetText.textContent = this.mode === 'new' ? '(new body)' : bodyName(this.ctx, this.target)
    this.showMesh(fast, MODE_COLOUR[this.mode], 0.45, false)
    this.placeHandles()
    this.say()
    if (!this.handles.dragging && this.ready()) this.timer = window.setTimeout(() => void this.compute(), 150)
  }

  /**
   * Extrude direction: cuts go into the target, bosses away from it (until the
   * user sets the direction themselves).
   */
  private aim(): void {
    if (this.kind !== 'extrude' || this.userDir || !this.target || this.mode === 'new') return
    const c = new THREE.Box3().setFromObject(this.target).getCenter(new THREE.Vector3())
    const side = Math.sign(c.sub(this.frame.origin).dot(this.frame.normal)) || -1
    const want = this.mode === 'fuse' ? -side : side
    if (Math.sign(this.distance) !== want) {
      this.distance = -this.distance
      if (this.boxes.dist) this.boxes.dist.value = fmt(this.distance)
    }
  }

  /** The body the new shape meets (closest one), unless the user picked one. */
  private autoTarget(): void {
    // Where the shape would be if it went either way (cuts then aim into the body found).
    const sel = this.selectedRegions()
    const d = Math.max(Math.abs(this.distance), 1)
    const geo = this.kind === 'extrude' ? (sel.length ? sweepMesh(this.frame, sel, extrudeStations(this.frame, -d, d, 0)) : null) : this.fastGeometry()
    if (!geo) return
    const box = geo.boundingBox!.clone().expandByScalar(0.01)
    geo.dispose()
    let best: THREE.Mesh | null = null
    let bestV = 0
    for (const m of solidBodies(this.ctx)) {
      const b = new THREE.Box3().setFromObject(m)
      if (!b.intersectsBox(box)) continue
      const v = b.intersect(box.clone()).getSize(new THREE.Vector3())
      const vol = v.x * v.y * v.z
      if (!best || vol > bestV) {
        best = m
        bestV = vol
      }
    }
    if (best !== this.target) {
      this.showTarget(true)
      this.target = best ?? (this.mode !== 'new' ? this.target : null)
    }
  }

  private spec(): SolidMake | null {
    const sel = this.selectedRegions()
    if (!sel.length) return null
    const f = this.frame
    const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z]
    const mk: SolidMake = { kind: this.kind, profiles: kernelProfiles(this.sketch, sel), origin: v3(f.origin), normal: v3(f.normal) }
    if (this.kind === 'extrude') {
      const [from, to] = this.extent()
      mk.from = from
      mk.to = to
      if (this.draft) mk.draft = this.draft
    } else if (this.kind === 'revolve') {
      const ax = this.axisWorld()
      if (!ax) return null
      mk.axisOrigin = v3(ax.o)
      mk.axis = v3(ax.d)
      mk.angle = this.angle
    } else {
      if (!this.path) return null
      mk.path = this.path.segs
    }
    return mk
  }

  private async compute(): Promise<THREE.BufferGeometry | null> {
    const id = ++this.runId
    if (!this.ready()) return null
    const mk = this.spec()
    if (!mk) return null
    this.busy = true
    this.say()
    try {
      let res
      if (this.mode === 'new') res = await solidCad([], { make: mk, op: 'new' })
      else {
        const t = this.target!
        t.updateMatrixWorld()
        const inv = t.matrixWorld.clone().invert()
        res = await solidCad([{ brep: t.geometry.userData.brep as Uint8Array }], { make: transformMake(mk, inv), op: this.mode, target: 0 })
      }
      const geo = await geometryOf(res.brep)
      if (id !== this.runId) return null
      if (this.mode !== 'new') geo.applyMatrix4(this.target!.matrixWorld)
      this.result = { geo, key: String(id) }
      this.busy = false
      this.showMesh(geo, 0xff9f1c, 0.75, true)
      this.say(`${res.solids > 1 ? `${res.solids} solids, ` : ''}volume ${fmt(res.volume, 1)} mm³`)
      return geo
    } catch (e) {
      if (id === this.runId) {
        this.busy = false
        this.error = (e as Error).message
        this.say()
      }
      return null
    }
  }

  private async ok(): Promise<void> {
    if (!this.ready()) {
      this.say(this.picked.size ? 'Finish the picks first.' : 'Pick a closed profile first.')
      return
    }
    window.clearTimeout(this.timer)
    let geo = this.result?.geo ?? null
    if (!geo) {
      if (this.busy) {
        // Wait for the run in flight.
        this.say('Working…')
        const id = this.runId
        while (this.busy && id === this.runId) await new Promise((r) => setTimeout(r, 50))
        geo = this.result?.geo ?? null
      }
      geo ??= await this.compute()
    }
    if (!geo) return
    const doc = this.ctx.doc
    const kind = TITLE[this.kind]
    const mode = this.mode
    const target = this.target
    const used = [this.sketch.id, ...(this.kind === 'sweep' && this.path ? [this.path.sketch.id] : [])]
    // The result is used as is (no copy), so the preview mustn't dispose it.
    this.result = null
    if (this.preview) this.preview.userData.keep = true
    this.close()
    selection.clear()
    doc.history.batch(`${kind} ${MODE_LABEL[mode].toLowerCase()}`, () => {
      if (mode === 'new') {
        const g = geo!
        const mesh = new THREE.Mesh(g, partMaterial())
        doc.addBody(mesh, `${kind} ${(counters[kind] = (counters[kind] ?? 0) + 1)}`, kind)
      } else {
        // Back into the target's own frame.
        const g = geo!
        g.applyMatrix4(target!.matrixWorld.clone().invert())
        g.computeBoundingBox()
        delete g.userData.prim
        doc.replaceGeometry(target!.userData.docId as string, g, `${kind} ${mode === 'fuse' ? 'onto' : mode === 'cut' ? 'cut from' : 'intersect'}`)
      }
      // The sketches are used up: hide them (they stay in the tree, parametric, for next time).
      for (const id of used) {
        const s = doc.sketches.find((x) => x.id === id)
        if (s?.visible) doc.updateSketch(s.id, structuredClone(s), { ...structuredClone(s), visible: false }, `Hide ${s.name}`)
      }
    })
    this.ctx.status(`${kind}: ${MODE_LABEL[mode].toLowerCase()} done`, 'success')
  }

  close(): void {
    if (active !== this) return
    active = null
    window.clearTimeout(this.timer)
    this.runId++
    this.showMesh(null, 0, 0, false)
    this.off.forEach((f) => f())
    this.prompt.remove()
    this.strip.remove()
    this.vp.blockPick = null
    this.vp.requestRender()
    this.ctx.refreshRibbon()
  }
}
