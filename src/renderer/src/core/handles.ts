import * as THREE from 'three'
import type { Viewport } from './viewport'

/**
 * On-screen drag handles (VISI style) that any command can use to set its
 * values by dragging in the view, kept in step with the typed boxes:
 *
 *  - arrow: a distance along a direction (Edit faces, extrude, offset...)
 *  - ring:  an angle about an axis (Rotate...)
 *
 * Handles stay the same size on screen, draw on top of the model, light up
 * under the cursor and snap to tidy steps (hold Shift to drag freely).
 * Dragging a handle never turns the view or picks anything underneath.
 */

export interface ArrowSpec {
  /** Where the distance is measured from (world). */
  origin: THREE.Vector3
  /** Positive direction (world, any length). */
  dir: THREE.Vector3
  value: number
  color?: number
  /** Called while dragging with the new distance. */
  onDrag: (value: number) => void
  onEnd?: () => void
  tip?: string
}

export interface RingSpec {
  centre: THREE.Vector3
  /** Rotation axis (world); positive angles turn anticlockwise looking down it. */
  axis: THREE.Vector3
  /** Angle in degrees. */
  value: number
  /** Ring radius in world units; omit for a fixed size on screen. */
  radius?: number
  color?: number
  onDrag: (deg: number) => void
  onEnd?: () => void
  tip?: string
}

type Handle = (ArrowHandle | RingHandle) & { group: THREE.Group; pickables: THREE.Object3D[]; mats: THREE.Material[] }

const HOVER = 0xfff1a8

function mat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 })
}

/** World units per screen pixel at a point. */
export function worldPerPixel(vp: Viewport, cam: THREE.Camera, at: THREE.Vector3): number {
  const h = Math.max(1, vp.renderer.domElement.clientHeight)
  const o = cam as THREE.OrthographicCamera
  if (o.isOrthographicCamera) return (o.top - o.bottom) / o.zoom / h
  const p = cam as THREE.PerspectiveCamera
  const d = at.clone().applyMatrix4(cam.matrixWorldInverse).z
  return (2 * Math.abs(d) * Math.tan(THREE.MathUtils.degToRad(p.fov / 2))) / h
}

/** A tidy snap step for the current zoom (1, 2, 5 × 10^n, about 4 pixels). */
function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
}

class ArrowHandle {
  kind = 'arrow' as const
  constructor(public spec: ArrowSpec) {}
}
class RingHandle {
  kind = 'ring' as const
  constructor(public spec: RingSpec) {}
}

export class Handles {
  private root = new THREE.Group()
  private list: Handle[] = []
  private hover: Handle | null = null
  private drag: { h: Handle; start: number; grab: number; last: number; turns: number } | null = null
  private ray = new THREE.Raycaster()
  private off: (() => void)[] = []
  /** Live value shown next to the handle being dragged. */
  private label = Object.assign(document.createElement('div'), { className: 'dim-label handle-label' })
  private labelAt = new THREE.Vector3()

  constructor(private vp: Viewport) {
    this.root.name = '__handles'
    this.root.renderOrder = 20
    vp.scene.add(this.root)
    const size = (cam: THREE.Camera): void => this.layout(cam)
    vp.beforeRender.add(size)
    const place = (): void => {
      if (!this.drag) return void this.label.remove()
      const q = vp.toScreen(this.labelAt)
      this.label.style.left = `${q.x + 14}px`
      this.label.style.top = `${q.y - 14}px`
      if (!this.label.isConnected) vp.host.append(this.label)
    }
    vp.afterRender.add(place)
    const canvas = vp.renderer.domElement
    // Window capture: we see the press before navigation or the tools do.
    const down = (e: PointerEvent): void => {
      if (e.target !== canvas || e.button !== 0) return
      const h = this.hit(e)
      if (!h) return
      e.preventDefault()
      e.stopImmediatePropagation()
      this.startDrag(h, e)
    }
    const move = (e: PointerEvent): void => {
      if (this.drag) {
        e.stopImmediatePropagation()
        this.dragTo(e)
        return
      }
      if (e.target !== canvas || e.buttons) return
      const h = this.hit(e)
      if (h !== this.hover) {
        this.hover = h
        this.paint()
        canvas.style.cursor = h ? 'grab' : ''
        canvas.title = h ? (h.spec.tip ?? '') : ''
      }
    }
    const up = (e: PointerEvent): void => {
      if (!this.drag || e.button !== 0) return
      e.stopImmediatePropagation()
      const h = this.drag.h
      this.drag = null
      canvas.style.cursor = this.hover ? 'grab' : ''
      this.paint()
      h.spec.onEnd?.()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    this.off.push(() => {
      vp.beforeRender.delete(size)
      vp.afterRender.delete(place)
      this.label.remove()
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      canvas.style.cursor = ''
      canvas.title = ''
    })
  }

  /** True while a handle is being dragged (tools can ignore clicks then). */
  get dragging(): boolean {
    return this.drag !== null
  }

  arrow(spec: ArrowSpec): ArrowSpec {
    const h = new ArrowHandle(spec) as Handle
    const m = mat(spec.color ?? 0xff9f1c)
    const m2 = mat(spec.color ?? 0xff9f1c)
    m2.opacity = 0.6
    // Unit shapes, scaled to pixels in layout(): shaft from origin to the value, cone at the tip.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0), m2)
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 16).translate(0, 1.3, 0), m)
    const knob = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), m)
    shaft.name = 'shaft'
    cone.name = 'cone'
    knob.name = 'knob'
    h.group = new THREE.Group()
    h.group.add(shaft, cone, knob)
    h.pickables = [cone, knob]
    h.mats = [m, m2]
    this.add(h)
    return spec
  }

  ring(spec: RingSpec): RingSpec {
    const h = new RingHandle(spec) as Handle
    const m = mat(spec.color ?? 0xff9f1c)
    const m2 = mat(spec.color ?? 0xff9f1c)
    m2.opacity = 0.45
    const torus = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 96), m2)
    // Fat invisible ring so it is easy to grab.
    const grab = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 6, 64), new THREE.MeshBasicMaterial({ visible: false }))
    const knob = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), m)
    const arc = new THREE.Mesh(new THREE.BufferGeometry(), mat(spec.color ?? 0xff9f1c))
    ;(arc.material as THREE.MeshBasicMaterial).opacity = 0.25
    ;(arc.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide
    torus.name = 'torus'
    knob.name = 'knob'
    arc.name = 'arc'
    h.group = new THREE.Group()
    h.group.add(torus, grab, knob, arc)
    h.pickables = [grab, knob]
    h.mats = [m, m2]
    this.add(h)
    return spec
  }

  private add(h: Handle): void {
    h.group.traverse((o) => {
      o.renderOrder = 20
      o.raycast = (o as THREE.Mesh).isMesh && h.pickables.includes(o) ? THREE.Mesh.prototype.raycast : () => {}
    })
    this.list.push(h)
    this.root.add(h.group)
    this.vp.requestRender()
  }

  /** Call after changing a spec (value, origin, axis...) from outside. */
  update(): void {
    this.vp.requestRender()
  }

  remove(spec: ArrowSpec | RingSpec): void {
    const h = this.list.find((x) => x.spec === spec)
    if (!h) return
    this.root.remove(h.group)
    this.list = this.list.filter((x) => x !== h)
    if (this.hover === h) this.hover = null
    if (this.drag?.h === h) this.drag = null
    this.vp.requestRender()
  }

  dispose(): void {
    this.off.forEach((f) => f())
    this.vp.scene.remove(this.root)
    this.vp.requestRender()
  }

  // ---- drawing -------------------------------------------------------------

  private paint(): void {
    for (const h of this.list) {
      const on = h === this.hover || h === this.drag?.h
      const base = h.spec.color ?? 0xff9f1c
      for (const m of h.mats) (m as THREE.MeshBasicMaterial).color.setHex(on ? HOVER : base)
    }
    this.vp.requestRender()
  }

  private layout(cam: THREE.Camera): void {
    for (const h of this.list) {
      if (h.kind === 'arrow') this.layoutArrow(h as ArrowHandle & Handle, cam)
      else this.layoutRing(h as RingHandle & Handle, cam)
    }
  }

  private layoutArrow(h: ArrowHandle & Handle, cam: THREE.Camera): void {
    const s = h.spec
    const dir = s.dir.clone().normalize()
    const px = worldPerPixel(this.vp, cam, s.origin)
    // A zero distance still shows a short arrow so there is something to grab.
    const len = s.value
    const visLen = Math.abs(len) < 22 * px ? (len < 0 ? -22 : 22) * px : len
    const sign = visLen < 0 ? -1 : 1
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().multiplyScalar(sign))
    const shaft = h.group.getObjectByName('shaft')!
    const cone = h.group.getObjectByName('cone')!
    const knob = h.group.getObjectByName('knob')!
    shaft.position.copy(s.origin)
    shaft.quaternion.copy(q)
    shaft.scale.set(1.5 * px, Math.abs(visLen), 1.2 * px)
    const tip = s.origin.clone().addScaledVector(dir, visLen)
    if (this.drag?.h === h) {
      this.labelAt.copy(tip)
      this.label.textContent = `${+s.value.toFixed(3)} mm`
    }
    cone.position.copy(tip)
    cone.quaternion.copy(q)
    cone.scale.setScalar(8 * px)
    knob.position.copy(s.origin)
    knob.scale.setScalar(4 * px)
  }

  private ringRadius(h: RingHandle & Handle, cam: THREE.Camera): number {
    return h.spec.radius ?? 70 * worldPerPixel(this.vp, cam, h.spec.centre)
  }

  private layoutRing(h: RingHandle & Handle, cam: THREE.Camera): void {
    const s = h.spec
    const px = worldPerPixel(this.vp, cam, s.centre)
    const r = this.ringRadius(h, cam)
    const axis = s.axis.clone().normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis)
    const torus = h.group.children[0]
    const grab = h.group.children[1]
    for (const o of [torus, grab]) {
      o.position.copy(s.centre)
      o.quaternion.copy(q)
      o.scale.setScalar(r)
    }
    // Tube thickness in pixels, whatever the radius.
    const tube = (1.6 * px) / r
    if (Math.abs(((torus as THREE.Mesh).geometry as THREE.TorusGeometry).parameters.tube - tube) > tube * 0.2) {
      ;(torus as THREE.Mesh).geometry.dispose()
      ;(torus as THREE.Mesh).geometry = new THREE.TorusGeometry(1, tube, 6, 96)
      ;(grab as THREE.Mesh).geometry.dispose()
      ;(grab as THREE.Mesh).geometry = new THREE.TorusGeometry(1, tube * 5, 6, 64)
    }
    const [u, v] = this.ringBasis(s.axis)
    const a = THREE.MathUtils.degToRad(s.value)
    const knob = h.group.getObjectByName('knob')!
    knob.position.copy(s.centre).addScaledVector(u, r * Math.cos(a)).addScaledVector(v, r * Math.sin(a))
    knob.scale.setScalar(5 * px)
    if (this.drag?.h === h) {
      this.labelAt.copy(knob.position)
      this.label.textContent = `${+s.value.toFixed(3)}°`
    }
    // Shaded wedge from 0 to the angle.
    const arc = h.group.getObjectByName('arc') as THREE.Mesh
    const n = Math.max(2, Math.ceil(Math.abs(s.value) / 4))
    const pts: number[] = []
    for (let i = 0; i < n; i++) {
      const a0 = (a * i) / n
      const a1 = (a * (i + 1)) / n
      const p0 = s.centre.clone().addScaledVector(u, r * Math.cos(a0)).addScaledVector(v, r * Math.sin(a0))
      const p1 = s.centre.clone().addScaledVector(u, r * Math.cos(a1)).addScaledVector(v, r * Math.sin(a1))
      pts.push(s.centre.x, s.centre.y, s.centre.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z)
    }
    arc.geometry.dispose()
    arc.geometry = new THREE.BufferGeometry()
    arc.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  }

  /** Zero-angle direction u and the 90° direction v for a ring about `axis`. */
  private ringBasis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const n = axis.clone().normalize()
    const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
    const u = ref.clone().cross(n).normalize()
    if (Math.abs(n.z) >= 0.9) u.copy(new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize())
    const v = n.clone().cross(u).normalize()
    return [u, v]
  }

  // ---- dragging ------------------------------------------------------------

  private setRay(e: PointerEvent): void {
    const r = this.vp.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.vp.nav.applyTo(this.vp.camera)
    this.ray.setFromCamera(ndc, this.vp.camera)
  }

  private hit(e: PointerEvent): Handle | null {
    if (!this.list.length) return null
    this.setRay(e)
    this.root.updateMatrixWorld(true)
    const hits = this.ray.intersectObjects(this.list.flatMap((h) => h.pickables), false)
    if (!hits.length) return null
    return this.list.find((h) => h.pickables.includes(hits[0].object)) ?? null
  }

  /** Distance along the arrow's line closest to the pointer ray. */
  private along(h: ArrowHandle): number | null {
    const d = h.spec.dir.clone().normalize()
    const r = this.ray.ray
    const w = h.spec.origin.clone().sub(r.origin)
    const b = d.dot(r.direction)
    const den = 1 - b * b
    if (den < 1e-6) return null // looking straight down the arrow
    return (b * w.dot(r.direction) - w.dot(d)) / den
  }

  /** Angle (degrees) of the pointer round the ring's axis. */
  private around(h: RingHandle): number | null {
    const n = h.spec.axis.clone().normalize()
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, h.spec.centre)
    const p = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(plane, p)) return null
    const [u, v] = this.ringBasis(n)
    p.sub(h.spec.centre)
    return THREE.MathUtils.radToDeg(Math.atan2(p.dot(v), p.dot(u)))
  }

  private startDrag(h: Handle, e: PointerEvent): void {
    this.setRay(e)
    const g = h.kind === 'arrow' ? this.along(h as ArrowHandle) : this.around(h as RingHandle)
    if (g === null) return
    this.drag = { h, start: h.spec.value, grab: g, last: g, turns: 0 }
    this.vp.renderer.domElement.style.cursor = 'grabbing'
    this.paint()
  }

  private dragTo(e: PointerEvent): void {
    const d = this.drag!
    this.setRay(e)
    let value: number
    if (d.h.kind === 'arrow') {
      const t = this.along(d.h as ArrowHandle)
      if (t === null) return
      value = d.start + (t - d.grab)
      if (!e.shiftKey) {
        const step = niceStep(4 * worldPerPixel(this.vp, this.vp.camera, d.h.spec.origin))
        value = Math.round(value / step) * step
      }
    } else {
      const a = this.around(d.h as RingHandle)
      if (a === null) return
      // Unwrap so dragging past 180° keeps counting (and past 360° for copies).
      let delta = a - d.last
      if (delta > 180) d.turns -= 360
      else if (delta < -180) d.turns += 360
      d.last = a
      delta = a + d.turns - d.grab
      value = d.start + delta
      if (!e.shiftKey) value = Math.round(value / 5) * 5
    }
    value = Math.round(value * 1e6) / 1e6
    if (value === d.h.spec.value) return
    d.h.spec.value = value
    ;(d.h.spec.onDrag as (v: number) => void)(value)
    this.vp.requestRender()
  }
}
