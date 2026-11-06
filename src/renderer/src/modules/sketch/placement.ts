import * as THREE from 'three'
import type { ModuleContext } from '@/core/types'
import { showCmdBar } from '@/core/cmdbar'
import { el, toolPanel } from '@/core/toolpanel'
import { Highlights, pickAt, pickKey, rowMajor, type Pick } from '@/core/picking'
import { measureCad } from '@/core/occt'
import { worldPerPixel } from '@/core/handles'
import { SketchIndex, type SketchData } from '@/sketch/model'
import { insidePoly, sample } from '@/sketch/geom'
import { findRegions } from '@/sketch/profiles'
import { disposeDrawing, drawSketch } from '@/sketch/render'

/**
 * Where a new sketch goes: the user picks a plane (Top, Front, Right or one
 * of their work planes), a flat face of a model, or an existing sketch (the
 * new sketch shares its plane). Nothing is placed until they pick.
 */

export interface Placement {
  /** Sketch plane to world. */
  matrix: THREE.Matrix4
  /** What it sits on, for the tree and the prompt. */
  name: string
  /** Where to look when the sketch opens (the picked face or sketch). */
  focus?: THREE.Vector3
}

interface PlaneItem {
  id: string
  name: string
  matrix: THREE.Matrix4
  color: number
  group: THREE.Group
  fill: THREE.Mesh
  border: THREE.LineSegments
  label: HTMLElement
  button: HTMLButtonElement
}

type Target =
  | { kind: 'plane'; item: PlaneItem; t: number }
  | { kind: 'face'; pick: Pick; t: number; flat: FaceFrame | null }
  | { kind: 'sketch'; sketch: SketchData; t: number; at: THREE.Vector3 }

interface FaceFrame {
  normal: THREE.Vector3
  point: THREE.Vector3
  centre: THREE.Vector3
}

const HOVER = 0xffb020
const FACE_OK = 0xfff1a8
const FACE_BAD = 0xff6b6b
/** Plane squares are this many pixels across whatever the zoom. */
const SQUARE_PX = 170

let active: PlacePicker | null = null
export const isPlacing = (): boolean => active !== null

export function pickPlacement(ctx: ModuleContext, done: (p: Placement) => void, onClose?: () => void): void {
  if (active) return
  active = new PlacePicker(ctx, done, onClose)
}
export const cancelPlacement = (): void => active?.close()

/** Frame with Z along n and X along the projection of ref. */
function frame(origin: THREE.Vector3, ref: THREE.Vector3, n: THREE.Vector3): THREE.Matrix4 {
  const z = n.clone().normalize()
  const x = ref.clone().sub(z.clone().multiplyScalar(ref.dot(z))).normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin)
}

/**
 * The sketch frame on a flat face: origin is the world origin dropped onto the
 * face's plane (so sketch coordinates line up with the model), X along world X
 * (world Y when the face looks along X).
 */
function faceMatrix(f: FaceFrame): THREE.Matrix4 {
  const n = f.normal
  const ref = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, f.point)
  const origin = pl.projectPoint(new THREE.Vector3(), new THREE.Vector3())
  return frame(origin, ref, n)
}

/** World triangles of a picked face. */
function faceTriangles(p: Pick): THREE.Vector3[] {
  const geo = (p.object as THREE.Mesh).geometry as THREE.BufferGeometry
  const tri = geo.userData.triFace as Int32Array | undefined
  const pos = geo.getAttribute('position')
  const idx = geo.index
  const out: THREE.Vector3[] = []
  p.object.updateMatrixWorld()
  const m = p.object.matrixWorld
  const count = (idx ? idx.count : pos.count) / 3
  for (let t = 0; t < count; t++) {
    if (tri ? tri[t] !== p.index : true) continue
    for (let k = 0; k < 3; k++) out.push(new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(t * 3 + k) : t * 3 + k).applyMatrix4(m))
  }
  return out
}

/** Is the face flat? Every triangle's normal must match and lie on one plane. */
function flatFace(p: Pick): FaceFrame | null {
  const pts = faceTriangles(p)
  if (pts.length < 3) return null
  let n: THREE.Vector3 | null = null
  const box = new THREE.Box3()
  for (const q of pts) box.expandByPoint(q)
  const size = Math.max(1e-6, box.getSize(new THREE.Vector3()).length())
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const c = new THREE.Vector3().crossVectors(e1.subVectors(pts[i + 1], pts[i]), e2.subVectors(pts[i + 2], pts[i]))
    if (c.lengthSq() < 1e-20) continue
    c.normalize()
    if (!n) n = c
    else if (n.dot(c) < 0.9995) return null
  }
  if (!n) return null
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, pts[0])
  for (const q of pts) if (Math.abs(pl.distanceToPoint(q)) > size * 1e-5 + 1e-6) return null
  return { normal: n, point: pts[0].clone(), centre: box.getCenter(new THREE.Vector3()) }
}

class PlacePicker {
  private prompt = el('div', 'vp-prompt')
  private group = new THREE.Group()
  private items: PlaneItem[] = []
  private hl: Highlights
  private hover: Target | null = null
  private flatCache = new Map<string, FaceFrame | null>()
  private off: (() => void)[] = []
  private panel: HTMLElement
  private busy = false
  private sketchGlow: THREE.Object3D | null = null

  constructor(
    private ctx: ModuleContext,
    private done: (p: Placement) => void,
    private onClose?: () => void
  ) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    this.group.name = '__sketch-place'
    vp.scene.add(this.group)
    vp.host.append(this.prompt)
    vp.blockPick = () => true

    const { panel, body } = toolPanel('New sketch', () => this.close())
    this.panel = panel
    body.append(el('div', 'sk-place-hint', 'Click a plane, a flat face or a sketch in the view, or choose a plane here.'))
    const list = el('div', 'sk-place-list')
    body.append(list)
    vp.host.append(panel)

    const std: [string, string, THREE.Matrix4, number][] = [
      ['top', 'Top (XY)', frame(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)), 0x3e8ef7],
      ['front', 'Front (XZ)', frame(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)), 0x46a758],
      ['right', 'Right (YZ)', frame(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)), 0xe5484d]
    ]
    for (const [id, name, m, c] of std) this.addItem(list, id, name, m, c)
    const user = ctx.doc.planes.filter((p) => !p.temp)
    if (user.length) {
      list.append(el('div', 'sk-place-head', 'Work planes'))
      for (const p of user) this.addItem(list, p.id, p.name, new THREE.Matrix4().fromArray(p.matrix), 0x60a5fa)
    }
    this.say()

    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    let queued: PointerEvent | null = null
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const t = this.targetAt(e)
      if (t) void this.choose(t)
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = queued!
        queued = null
        this.setHover(ev.buttons ? null : this.targetAt(ev))
      })
    }
    const onLeave = (): void => this.setHover(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      this.close()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    window.addEventListener('keydown', onKey, true)
    const size = (cam: THREE.Camera): void => {
      for (const it of this.items) {
        const o = new THREE.Vector3().setFromMatrixPosition(it.matrix)
        const s = SQUARE_PX * worldPerPixel(vp, cam, o)
        it.group.matrix.copy(it.matrix).multiply(new THREE.Matrix4().makeScale(s, s, 1))
      }
    }
    const place = (): void => {
      for (const it of this.items) {
        // Label at the square's far corner (+X +Y), so the three origin planes' labels don't meet.
        const q = vp.toScreen(new THREE.Vector3(0.5, 0.5, 0).applyMatrix4(it.group.matrix))
        it.label.style.left = `${q.x}px`
        it.label.style.top = `${q.y}px`
      }
    }
    vp.beforeRender.add(size)
    vp.afterRender.add(place)
    const bar = showCmdBar(vp.host, { cancel: () => this.close() })
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey, true)
      vp.beforeRender.delete(size)
      vp.afterRender.delete(place)
      bar.dispose()
    })
    vp.requestRender()
  }

  private addItem(list: HTMLElement, id: string, name: string, matrix: THREE.Matrix4, color: number): void {
    const group = new THREE.Group()
    group.matrixAutoUpdate = false
    const geo = new THREE.PlaneGeometry(1, 1)
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false, depthTest: false }))
    fill.raycast = () => {}
    fill.renderOrder = 20
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }))
    border.raycast = () => {}
    border.renderOrder = 21
    group.add(fill, border)
    this.group.add(group)
    const label = el('div', 'sk-place-label', name)
    label.style.setProperty('--c', `#${color.toString(16).padStart(6, '0')}`)
    this.ctx.viewport.host.append(label)
    const button = el('button', 'sk-place-btn')
    const sw = el('span', 'sk-place-swatch')
    sw.style.background = `#${color.toString(16).padStart(6, '0')}`
    button.append(sw, el('span', '', name))
    const item: PlaneItem = { id, name, matrix, color, group, fill, border, label, button }
    button.addEventListener('click', () => void this.choose({ kind: 'plane', item, t: 0 }))
    button.addEventListener('pointerenter', () => this.setHover({ kind: 'plane', item, t: 0 }))
    button.addEventListener('pointerleave', () => this.setHover(null))
    list.append(button)
    this.items.push(item)
  }

  private say(note?: string, bad = false): void {
    const main = el('span')
    main.append(el('b', '', 'New sketch'), document.createTextNode(': click a plane, a flat face or a sketch to draw on'))
    this.prompt.replaceChildren(main)
    if (note) this.prompt.append(el('span', bad ? 'vp-prompt-note sk-place-bad' : 'vp-prompt-note', note))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Esc to cancel'))
  }

  private ray(e: { clientX: number; clientY: number }): THREE.Ray {
    const vp = this.ctx.viewport
    const r = vp.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    const rc = new THREE.Raycaster()
    rc.setFromCamera(ndc, vp.camera)
    return rc.ray
  }

  /** The nearest thing under the cursor: a sketch, a model face or a plane square. */
  private targetAt(e: { clientX: number; clientY: number }): Target | null {
    const vp = this.ctx.viewport
    const ray = this.ray(e)
    const found: Target[] = []
    const wpp = worldPerPixel(vp, vp.camera, ray.origin.clone().addScaledVector(ray.direction, 100))

    // Plane squares.
    for (const it of this.items) {
      const inv = it.group.matrix.clone().invert()
      const local = ray.clone().applyMatrix4(inv)
      const hit = local.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3())
      if (!hit || Math.abs(hit.x) > 0.5 || Math.abs(hit.y) > 0.5) continue
      const w = hit.applyMatrix4(it.group.matrix)
      found.push({ kind: 'plane', item: it, t: ray.origin.distanceTo(w) })
    }

    // Model faces.
    const p = pickAt(vp, e, { face: true })
    if (p?.kind === 'face') {
      const key = pickKey({ ...p, point: new THREE.Vector3() })
      if (!this.flatCache.has(key)) this.flatCache.set(key, flatFace(p))
      found.push({ kind: 'face', pick: p, t: ray.origin.distanceTo(p.point), flat: this.flatCache.get(key)! })
    }

    // Sketches: near a curve (within 7 px) or inside a closed profile.
    for (const s of this.ctx.doc.sketches) {
      if (!s.visible) continue
      const m = new THREE.Matrix4().fromArray(s.plane)
      const local = ray.clone().applyMatrix4(m.clone().invert())
      const hit = local.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3())
      if (!hit) continue
      const w = hit.clone().applyMatrix4(m)
      const t = ray.origin.distanceTo(w)
      const px = worldPerPixel(vp, vp.camera, w) || wpp
      const q: [number, number] = [hit.x, hit.y]
      const ix = new SketchIndex(s)
      let near = false
      for (const c of s.curves) {
        const pts = sample(ix, c, px)
        for (let i = 0; i + 1 < pts.length && !near; i++) near = segDist(q, pts[i], pts[i + 1]) < 7 * px
        if (near) break
      }
      if (!near) near = findRegions(s).some((r) => insidePoly(r.outer.poly, q))
      // A sketch on a face wins over the face it sits on.
      if (near) found.push({ kind: 'sketch', sketch: s, t: t - 2 * px, at: w })
    }
    found.sort((a, b) => a.t - b.t)
    return found[0] ?? null
  }

  private setHover(t: Target | null): void {
    const same = (a: Target | null, b: Target | null): boolean => {
      if (!a || !b) return a === b
      if (a.kind !== b.kind) return false
      if (a.kind === 'plane') return a.item === (b as typeof a).item
      if (a.kind === 'sketch') return a.sketch.id === (b as typeof a).sketch.id
      return pickKey({ ...a.pick, point: new THREE.Vector3() }) === pickKey({ ...(b as typeof a).pick, point: new THREE.Vector3() })
    }
    if (same(t, this.hover)) return
    this.hover = t
    for (const it of this.items) {
      const on = t?.kind === 'plane' && t.item === it
      ;(it.fill.material as THREE.MeshBasicMaterial).color.setHex(on ? HOVER : it.color)
      ;(it.fill.material as THREE.MeshBasicMaterial).opacity = on ? 0.28 : 0.1
      ;(it.border.material as THREE.LineBasicMaterial).color.setHex(on ? HOVER : it.color)
      it.label.classList.toggle('on', on)
      it.button.classList.toggle('on', on)
    }
    this.glowSketch(t?.kind === 'sketch' ? t.sketch : null)
    this.hl.set(t?.kind === 'face' ? [{ pick: t.pick, color: t.flat ? FACE_OK : FACE_BAD }] : [])
    this.ctx.viewport.renderer.domElement.style.cursor = t && !(t.kind === 'face' && !t.flat) ? 'pointer' : ''
    if (!t) this.say()
    else if (t.kind === 'plane') this.say(t.item.name)
    else if (t.kind === 'sketch') this.say(`On the plane of ${t.sketch.name}`)
    else this.say(t.flat ? 'Flat face' : 'That face is curved: pick a flat one', !t.flat)
    this.ctx.viewport.requestRender()
  }

  /** Draw the hovered sketch over itself in the selection colour. */
  private glowSketch(s: SketchData | null): void {
    if (this.sketchGlow) {
      this.group.remove(this.sketchGlow)
      disposeDrawing(this.sketchGlow)
      this.sketchGlow = null
    }
    if (!s) return
    const vp = this.ctx.viewport
    const px = worldPerPixel(vp, vp.camera, new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(s.plane)))
    this.sketchGlow = drawSketch(s, { editing: false, px, selected: new Set([...s.curves.map((c) => c.id), ...s.points.map((p) => p.id)]) })
    this.group.add(this.sketchGlow)
  }

  private async choose(t: Target): Promise<void> {
    if (this.busy) return
    if (t.kind === 'plane') return this.finish({ matrix: t.item.matrix.clone(), name: t.item.name })
    if (t.kind === 'sketch') {
      return this.finish({ matrix: new THREE.Matrix4().fromArray(t.sketch.plane), name: t.sketch.planeName ?? t.sketch.name, focus: t.at })
    }
    if (!t.flat) return this.say('That face is curved: pick a flat one', true)
    const f = { ...t.flat, normal: t.flat.normal.clone() }
    // Exact normal from the kernel where the model has one.
    const geo = (t.pick.object as THREE.Mesh).geometry
    if (geo.userData.brep) {
      this.busy = true
      try {
        const r = await measureCad([{ brep: geo.userData.brep as Uint8Array, kind: 'face', index: t.pick.index, matrix: rowMajor(t.pick.object.matrixWorld) }])
        const d = r.items[0]
        if (d?.surface === 'Plane' && d.normal) {
          const n = new THREE.Vector3(...(d.normal as [number, number, number])).normalize()
          f.normal = n.dot(f.normal) < 0 ? n.negate() : n
        }
      } catch {
        /* keep the mesh normal */
      } finally {
        this.busy = false
      }
      if (active !== this) return
    }
    this.finish({ matrix: faceMatrix(f), name: 'Face', focus: f.centre })
  }

  private finish(p: Placement): void {
    this.close()
    this.done(p)
  }

  close(): void {
    if (active !== this) return
    active = null
    this.off.forEach((f) => f())
    for (const it of this.items) {
      it.label.remove()
      it.fill.geometry.dispose()
      it.border.geometry.dispose()
      ;(it.fill.material as THREE.Material).dispose()
      ;(it.border.material as THREE.Material).dispose()
    }
    this.glowSketch(null)
    const vp = this.ctx.viewport
    vp.scene.remove(this.group)
    this.hl.dispose()
    this.prompt.remove()
    this.panel.remove()
    vp.blockPick = null
    vp.renderer.domElement.style.cursor = ''
    vp.requestRender()
    this.onClose?.()
  }
}

function segDist(q: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l = dx * dx + dy * dy
  const t = l ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l)) : 0
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy)
}
