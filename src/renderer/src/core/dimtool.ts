import * as THREE from 'three'
import type { ModuleContext } from './types'
import type { Dimension } from './document'
import { datums } from './datums'
import { measureCad } from './occt'
import { Highlights, pickAt, pickKey, rowMajor, type Pick } from './picking'
import { el, fmt } from './toolpanel'

/**
 * Dimension tool: pick model items and leave a dimension in the document
 * (point to point, diameter / radius, angle, ordinate). Stays open for the
 * next one; Esc clears the picks, then closes.
 */

export type DimKind = 'distance' | 'size' | 'angle' | 'ordinate'
type V3 = [number, number, number]
type Info = Record<string, unknown>

const COLORS = [0xff9f1c, 0x22d3ee]
const HOVER = 0xfff1a8
const NEEDS: Record<DimKind, number> = { distance: 2, size: 1, angle: 2, ordinate: 1 }
const TITLES: Record<DimKind, string> = { distance: 'Point to point', size: 'Diameter / radius', angle: 'Angle', ordinate: 'Ordinate' }
const HELP: Record<DimKind, string> = {
  distance: 'Pick two points, edges or faces. Holes and arcs measure from their centre.',
  size: 'Pick a circular edge, a hole / boss face, a sphere or a fillet.',
  angle: 'Pick two straight edges or two flat faces.',
  ordinate: 'Pick a point, or a hole / arc for its centre. Values are from the datum.'
}

let active: DimensionTool | null = null
export const dimToolKind = (): DimKind | null => active?.kind ?? null
export function openDimensionTool(ctx: ModuleContext, kind: DimKind): void {
  if (active) active.setKind(kind)
  else active = new DimensionTool(ctx, kind)
  ctx.refreshRibbon()
}
export function closeDimensionTool(): void {
  active?.close()
}

const tv = (p: V3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2])
const arr = (p: THREE.Vector3): V3 => [p.x, p.y, p.z]

class DimensionTool {
  private picks: Pick[] = []
  private hover: Pick | null = null
  private hl: Highlights
  private prompt = el('div', 'vp-prompt')
  private flash: string | null = null
  private off: (() => void)[] = []
  private busy = false
  private axis: 'true' | 'x' | 'y' | 'z' = 'true'
  private size: 'auto' | 'diameter' | 'radius' = 'auto'
  private ord: 'all' | 'x' | 'y' | 'z' = 'all'
  private datumId = 'world'
  private moveQueued: PointerEvent | null = null

  constructor(
    private ctx: ModuleContext,
    public kind: DimKind
  ) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    vp.host.appendChild(this.prompt)
    vp.blockPick = () => true
    this.showPrompt()

    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent): void => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved <= 4) void this.click(pickAt(vp, e, this.filter()))
    }
    const onMove = (e: PointerEvent): void => {
      const queued = !!this.moveQueued
      this.moveQueued = e
      if (queued) return
      requestAnimationFrame(() => {
        const ev = this.moveQueued!
        this.moveQueued = null
        if (ev.buttons) return
        const h = pickAt(vp, ev, this.filter())
        if ((h && pickKey(h)) !== (this.hover && pickKey(this.hover))) {
          this.hover = h
          this.showHighlights()
        }
      })
    }
    const onLeave = (): void => {
      this.hover = null
      this.showHighlights()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (this.picks.length) this.setPicks([])
      else this.close()
    }
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => window.removeEventListener('keydown', onKey, true))
  }

  /** What a click can pick, for this kind of dimension. */
  private filter(): { vertex: boolean; edge: boolean; face: boolean } {
    if (this.kind === 'size') return { vertex: false, edge: true, face: true }
    if (this.kind === 'angle') return { vertex: false, edge: true, face: true }
    return { vertex: true, edge: true, face: true }
  }

  setKind(kind: DimKind): void {
    this.kind = kind
    this.flash = null
    this.setPicks([])
  }

  /** The instruction at the bottom of the viewport: what to click next. */
  private showPrompt(): void {
    const step =
      this.kind === 'size'
        ? 'select a hole, arc, boss or fillet'
        : this.picks.length === 0
          ? `select the first ${this.kind === 'angle' ? 'straight edge or flat face' : 'item'}`
          : `select the second ${this.kind === 'angle' ? 'straight edge or flat face' : 'item'}`
    const main = el('span')
    main.append(el('b', '', TITLES[this.kind]), document.createTextNode(`: ${step}`))
    this.prompt.replaceChildren(main)
    if (this.flash) this.prompt.append(el('span', 'vp-prompt-note', this.flash))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Esc to finish'))
  }

  private async click(p: Pick | null): Promise<void> {
    if (this.busy) return
    if (!p) return
    const k = pickKey(p)
    if (this.picks.some((x) => pickKey(x) === k)) return this.setPicks(this.picks.filter((x) => pickKey(x) !== k))
    this.flash = null
    this.setPicks([...this.picks, p])
    if (this.picks.length < NEEDS[this.kind]) return
    this.busy = true
    try {
      const d = await this.make(this.picks)
      if (typeof d === 'string') this.flash = d
      else {
        this.ctx.doc.addDim(d)
        this.flash = `Added ${d.text}. Next one, or Esc.`
      }
    } catch (e) {
      this.flash = `Couldn't measure: ${(e as Error).message}`
    } finally {
      this.busy = false
      this.setPicks([])
    }
  }

  private setPicks(p: Pick[]): void {
    this.picks = p
    this.showHighlights()
    this.showPrompt()
  }

  private showHighlights(): void {
    const list = this.picks.map((pick, i) => ({ pick, color: COLORS[i] }))
    if (this.hover && !this.picks.some((p) => pickKey(p) === pickKey(this.hover!))) list.push({ pick: this.hover, color: HOVER })
    this.hl.set(list)
  }

  /** World units per screen pixel around a point. */
  private perPx(at: THREE.Vector3): number {
    const vp = this.ctx.viewport
    const right = new THREE.Vector3().setFromMatrixColumn(vp.camera.matrixWorld, 0)
    const a = vp.toScreen(at)
    const b = vp.toScreen(at.clone().add(right))
    const px = Math.hypot(b.x - a.x, b.y - a.y)
    return px > 1e-9 ? 1 / px : 1
  }

  /** A point `px` pixels from `at`, along `dir` as seen on screen. */
  private beside(at: THREE.Vector3, dir: THREE.Vector3, px: number): THREE.Vector3 {
    const cam = this.ctx.viewport.camera
    const view = cam.getWorldDirection(new THREE.Vector3())
    const d = dir.clone().sub(view.clone().multiplyScalar(dir.dot(view)))
    if (d.lengthSq() < 1e-6 * Math.max(dir.lengthSq(), 1e-12)) {
      d.setFromMatrixColumn(cam.matrixWorld, 0).add(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1))
    }
    return at.clone().add(d.normalize().multiplyScalar(px * this.perPx(at)))
  }

  /** World box of the bodies picked. */
  private boxOf(picks: Pick[]): THREE.Box3 {
    const box = new THREE.Box3()
    for (const p of picks) box.union(new THREE.Box3().setFromObject(p.object))
    return box
  }

  /** How far from `at` along `dir` the box reaches (0 if it doesn't). */
  private reach(box: THREE.Box3, at: THREE.Vector3, dir: THREE.Vector3): number {
    if (box.isEmpty()) return 0
    let m = 0
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      m = Math.max(m, c.sub(at).dot(dir))
    }
    return m
  }

  private async describe(picks: Pick[]): Promise<{ items: (Info | null)[]; pair?: Info }> {
    const exact = picks.every((p) => p.kind !== 'point' && (p.object as THREE.Mesh).geometry?.userData.brep)
    if (!exact) return { items: picks.map(() => null) }
    const res = await measureCad(
      picks.map((p) => {
        p.object.updateMatrixWorld()
        return {
          brep: (p.object as THREE.Mesh).geometry.userData.brep as Uint8Array,
          kind: p.kind as 'face' | 'edge' | 'vertex',
          index: p.index,
          matrix: rowMajor(p.object.matrixWorld)
        }
      })
    )
    return { items: res.items, pair: res.pair as Info | undefined }
  }

  private async make(picks: Pick[]): Promise<Omit<Dimension, 'id'> | string> {
    const { items, pair } = await this.describe(picks)
    const nodeIds = [...new Set(picks.map((p) => p.object.userData.docId as string | undefined).filter((x): x is string => !!x))]
    const cam = this.ctx.viewport.camera
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1)
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
    const centreOf = (d: Info | null): THREE.Vector3 | null => {
      if (!d) return null
      if (d.kind === 'vertex') return tv(d.point as V3)
      if ((d.curve === 'Circle' || d.curve === 'Arc' || d.curve === 'Ellipse' || d.surface === 'Sphere') && d.center) return tv(d.center as V3)
      return null
    }

    if (this.kind === 'distance') {
      let a = centreOf(items[0])
      let b = centreOf(items[1])
      if (!a || !b) {
        if (pair?.p1 && pair.p2) {
          // A centre against anything else: measure from the centre.
          a ??= tv(pair.p1 as V3)
          b ??= tv(pair.p2 as V3)
        } else {
          a ??= picks[0].point.clone()
          b ??= picks[1].point.clone()
        }
      }
      const inv = datums.inverse(this.datumId)
      const delta = b.clone().applyMatrix4(inv).sub(a.clone().applyMatrix4(inv))
      const value = this.axis === 'true' ? delta.length() : Math.abs(delta[this.axis])
      if (value < 1e-9) return 'Those two are at the same place: pick something else.'
      const text = this.axis === 'true' ? fmt(value) : `${this.axis.toUpperCase()} ${fmt(value)}`
      // Label beside the middle, off the line in the view plane.
      const mid = a.clone().add(b).multiplyScalar(0.5)
      let dir = b.clone().sub(a)
      if (this.axis !== 'true') {
        const u = new THREE.Vector3(this.axis === 'x' ? 1 : 0, this.axis === 'y' ? 1 : 0, this.axis === 'z' ? 1 : 0).transformDirection(datums.get(this.datumId).matrix)
        dir = u
      }
      dir.normalize()
      const viewDir = cam.getWorldDirection(new THREE.Vector3())
      let side = new THREE.Vector3().crossVectors(dir, viewDir)
      if (side.lengthSq() < 1e-8) side = up.clone()
      side.normalize()
      // Off the part: on the side away from it, past its outline.
      const box = this.boxOf(picks)
      const away = box.getCenter(new THREE.Vector3()).sub(mid)
      if (Math.abs(away.dot(side)) > 1e-9 ? away.dot(side) > 0 : side.dot(up) < 0) side.negate()
      const label = mid.clone().add(side.clone().multiplyScalar(this.reach(box, mid, side) + 28 * this.perPx(mid)))
      return { type: 'distance', axis: this.axis, datumId: this.datumId, points: [arr(a), arr(b)], value, text, label: arr(label), nodeIds }
    }

    if (this.kind === 'ordinate') {
      const p = centreOf(items[0]) ?? picks[0].point.clone()
      const q = p.clone().applyMatrix4(datums.inverse(this.datumId))
      const axes = this.ord === 'all' ? (['x', 'y', 'z'] as const) : ([this.ord] as const)
      const text = axes.map((a) => `${a.toUpperCase()} ${fmt(q[a])}`).join('\n')
      const label = this.beside(p, up.clone().add(right), 45)
      return { type: 'ordinate', datumId: this.datumId, axis: this.ord === 'all' ? undefined : this.ord, points: [arr(p)], value: this.ord === 'all' ? 0 : q[this.ord], text, label: arr(label), nodeIds }
    }

    if (this.kind === 'size') {
      const d = items[0]
      if (!d) return 'Diameter / radius needs a CAD body (STEP, IGES, BREP or a shape made here).'
      const pick = picks[0]
      let centre: THREE.Vector3 | null = null
      let radius = 0
      let full = false
      if (d.curve === 'Circle' || d.curve === 'Arc') {
        centre = tv(d.center as V3)
        radius = d.radius as number
        full = d.curve === 'Circle' || holeSweep(pick, centre, tv(d.normal as V3).normalize(), radius, null) > 300
      } else if (d.surface === 'Cylinder') {
        const axis = tv(d.axis as V3).normalize()
        const o = tv(d.axisPoint as V3)
        centre = o.clone().add(axis.clone().multiplyScalar(pick.point.clone().sub(o).dot(axis)))
        radius = d.radius as number
        full = holeSweep(pick, centre, axis, radius, pick.index) > 300
      } else if (d.surface === 'Sphere') {
        centre = tv(d.center as V3)
        radius = d.radius as number
        full = true
      } else if (d.surface === 'Torus') {
        radius = d.minor as number
        const n = curvatureCentreDir(pick)
        centre = n ? pick.point.clone().add(n.multiplyScalar(radius)) : null
        full = false
      } else return 'Pick a circular edge, a cylindrical or spherical face, or a fillet.'
      if (!centre) return 'Could not place that one: try its edge instead.'
      const useDia = this.size === 'diameter' || (this.size === 'auto' && full)
      // The rim point on the side nearest the pointer.
      let rim = pick.point.clone()
      const off = rim.clone().sub(centre)
      if (off.lengthSq() < 1e-12) off.copy(right)
      rim = centre.clone().add(off.normalize().multiplyScalar(radius))
      const out = rim.clone().sub(centre)
      const view = cam.getWorldDirection(new THREE.Vector3())
      out.sub(view.clone().multiplyScalar(out.dot(view)))
      if (out.lengthSq() < 1e-12) out.copy(up).add(right)
      out.normalize()
      const label = rim.clone().add(out.clone().multiplyScalar(this.reach(this.boxOf(picks), rim, out) + 28 * this.perPx(rim)))
      const value = useDia ? radius * 2 : radius
      return { type: useDia ? 'diameter' : 'radius', points: [arr(centre), arr(rim)], value, text: `${useDia ? 'Ø' : 'R'}${fmt(value)}`, label: arr(label), nodeIds }
    }

    // Angle
    const [d1, d2] = items
    if (!d1 || !d2 || pair?.angle === undefined) return 'Angle needs two straight edges or two flat faces of CAD bodies.'
    const ok = (d: Info): boolean => d.curve === 'Line' || d.surface === 'Plane'
    if (!ok(d1) || !ok(d2)) return 'Angle needs two straight edges or two flat faces.'
    const value = pair.angle as number
    if (value < 0.01 || value > 179.99) return 'Those are parallel (0°): pick two that meet at an angle.'
    let apex: THREE.Vector3
    if (pair.p1 && pair.p2) apex = tv(pair.p1 as V3).add(tv(pair.p2 as V3)).multiplyScalar(0.5)
    else apex = picks[0].point.clone().add(picks[1].point).multiplyScalar(0.5)
    const armEnd = (d: Info, p: Pick): THREE.Vector3 => {
      if (d.curve === 'Line') {
        const s = tv(d.start as V3)
        const e = tv(d.end as V3)
        return s.distanceTo(apex) > e.distanceTo(apex) ? s : e
      }
      const c = tv(d.centroid as V3)
      return c.distanceTo(apex) > 1e-6 ? c : p.point.clone()
    }
    const e1 = armEnd(d1, picks[0])
    const e2 = armEnd(d2, picks[1])
    const r = Math.min(e1.distanceTo(apex), e2.distanceTo(apex)) * 0.6
    const b1 = e1.clone().sub(apex).normalize()
    const b2 = e2.clone().sub(apex).normalize()
    const bis = b1.clone().add(b2)
    if (bis.lengthSq() < 1e-8) bis.copy(up)
    const label = apex.clone().add(bis.normalize().multiplyScalar(Math.max(r, 40 * this.perPx(apex))))
    return { type: 'angle', points: [arr(apex), arr(e1), arr(e2)], value, text: `${fmt(value, 2)}°`, label: arr(label), nodeIds }
  }

  close(): void {
    if (active !== this) return
    active = null
    this.off.forEach((f) => f())
    this.hl.dispose()
    this.prompt.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.refreshRibbon()
    this.ctx.viewport.requestRender()
  }
}

/** Triangles (world positions) of the picked B-rep face. */
function faceTriangles(p: Pick, each: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ia: number, ib: number, ic: number) => void): void {
  const geo = (p.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  const tri = geo?.userData.triFace as Int32Array | undefined
  const pos = geo?.getAttribute('position')
  if (!geo || !tri || !pos) return
  const idx = geo.index
  const m = p.object.matrixWorld
  const at = (i: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m)
  for (let t = 0; t < tri.length; t++) {
    if (tri[t] !== p.index) continue
    const ia = idx ? idx.getX(t * 3) : t * 3
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
    each(at(ia), at(ib), at(ic), ia, ib, ic)
  }
}

/**
 * How far round an axis the body's surface at this radius goes, in degrees:
 * a hole split into two half faces still counts as a full hole. Only the
 * axial span of the picked face (or the plane of a picked circle) is looked at.
 */
function holeSweep(p: Pick, centre: THREE.Vector3, axis: THREE.Vector3, radius: number, face: number | null): number {
  const geo = (p.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  const pos = geo?.getAttribute('position')
  if (!geo || !pos || !(p.object as THREE.Mesh).isMesh) return 0
  p.object.updateMatrixWorld()
  const m = p.object.matrixWorld
  const tol = Math.max(radius * 1e-3, 1e-3)
  // Axial span: the picked face's, or just the circle's plane.
  let lo = -tol
  let hi = tol
  if (face !== null) {
    lo = Infinity
    hi = -Infinity
    faceTriangles(p, (a, b, c) => {
      for (const q of [a, b, c]) {
        const t = q.clone().sub(centre).dot(axis)
        lo = Math.min(lo, t)
        hi = Math.max(hi, t)
      }
    })
    if (lo > hi) return 0
    lo -= tol
    hi += tol
  }
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(u.dot(axis)) > 0.9) u.set(0, 1, 0)
  u.sub(axis.clone().multiplyScalar(u.dot(axis))).normalize()
  const w = new THREE.Vector3().crossVectors(axis, u)
  const bins = new Uint8Array(360)
  const q = new THREE.Vector3()
  const angle = (i: number): number | null => {
    q.fromBufferAttribute(pos, i).applyMatrix4(m).sub(centre)
    const t = q.dot(axis)
    if (t < lo || t > hi) return null
    const x = q.dot(u)
    const y = q.dot(w)
    if (Math.abs(Math.hypot(x, y) - radius) > tol * 5) return null
    return (Math.atan2(y, x) * 180) / Math.PI + 180
  }
  const idx = geo.index
  const tris = (idx ? idx.count : pos.count) / 3
  const vi = (k: number): number => (idx ? idx.getX(k) : k)
  // Mark the angular span of every segment of the mesh lying on the surface.
  for (let t = 0; t < tris; t++) {
    const as = [angle(vi(t * 3)), angle(vi(t * 3 + 1)), angle(vi(t * 3 + 2))]
    for (let e = 0; e < 3; e++) {
      const a0 = as[e]
      const a1 = as[(e + 1) % 3]
      if (a0 === null || a1 === null) continue
      let from = Math.min(a0, a1)
      let span = Math.abs(a1 - a0)
      if (span > 180) {
        from = Math.max(a0, a1)
        span = 360 - span
      }
      for (let k = Math.floor(from); k <= Math.ceil(from + span); k++) bins[((k % 360) + 360) % 360] = 1
    }
  }
  return bins.reduce((s2, x) => s2 + x, 0)
}

/** For a fillet: the direction from the picked point toward its centre of curvature. */
function curvatureCentreDir(p: Pick): THREE.Vector3 | null {
  const geo = (p.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  const nrm = geo?.getAttribute('normal')
  if (!nrm) return null
  const nm = new THREE.Matrix3().getNormalMatrix(p.object.matrixWorld)
  let best: { d: number; pos: THREE.Vector3; n: THREE.Vector3 }[] = []
  faceTriangles(p, (a, b, c, ia, ib, ic) => {
    for (const [q, i] of [[a, ia], [b, ib], [c, ic]] as const) {
      const d = q.distanceTo(p.point)
      best.push({ d, pos: q, n: new THREE.Vector3().fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize() })
    }
  })
  if (best.length < 2) return null
  best.sort((x, y) => x.d - y.d)
  const n0 = best[0].n
  // Normals spread apart on a convex round (centre inside), close together on a concave fillet.
  const other = best.find((x) => x.pos.distanceTo(best[0].pos) > 1e-6 && x.n.angleTo(n0) > 1e-3)
  if (!other) return n0.clone().negate()
  const spread = other.n.clone().sub(n0).dot(other.pos.clone().sub(best[0].pos))
  best = []
  return spread > 0 ? n0.clone().negate() : n0.clone()
}
