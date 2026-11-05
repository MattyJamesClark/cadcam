import * as THREE from 'three'
import { settings } from './settings'

/** Camera pose: where it looks, how it's turned, and how far back it sits. */
export interface CamPose {
  target: THREE.Vector3
  quat: THREE.Quaternion
  dist: number
}

type Op = 'rotate' | 'pan' | 'zoom' | 'roll'

export interface NavHost {
  dom: HTMLElement
  camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera
  /** Model point under the cursor, if any. */
  pick(ndc: THREE.Vector2): THREE.Vector3 | null
  fitAll(): void
  changed(): void
}

const ROT_SPEED = 0.007 // radians per pixel
const KEY_STEP = THREE.MathUtils.degToRad(15)

/**
 * CAD camera navigation. Free rotation (like SolidWorks, not a turntable), pan
 * that keeps the grabbed point under the cursor, and zoom about the cursor.
 *
 * SolidWorks style (default):
 *   middle drag          rotate (about the point under the cursor)
 *   Ctrl + middle drag   pan
 *   Shift + middle drag  zoom
 *   Alt + middle drag    roll
 *   wheel                zoom at cursor
 *   double middle click  zoom to fit
 *   arrows               rotate 15 deg (Shift: 90 deg), Alt+left/right roll,
 *                        Ctrl+arrows pan
 * Generic style: right drag rotate, middle drag (or Shift+right) pan.
 */
export class CadNavigation {
  readonly pose: CamPose = { target: new THREE.Vector3(), quat: new THREE.Quaternion(), dist: 500 }
  private drag: { op: Op; x: number; y: number; pivot: THREE.Vector3; zoomAt: THREE.Vector3 } | null = null
  private lastMiddleClick = 0
  private middleDownAt = { x: 0, y: 0 }
  private anim: { from: CamPose; to: CamPose; t0: number; ms: number } | null = null

  constructor(private host: NavHost) {
    const el = host.dom
    el.addEventListener('pointerdown', (e) => this.onDown(e))
    el.addEventListener('pointermove', (e) => this.onMove(e))
    el.addEventListener('pointerup', (e) => this.onUp(e))
    el.addEventListener('pointercancel', () => (this.drag = null))
    // Stop the browser's middle-click autoscroll.
    el.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault())
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    window.addEventListener('keydown', (e) => this.onKey(e))
  }

  // ---- applying the pose -------------------------------------------------

  /** Write the pose into a camera (both cameras share it). */
  applyTo(cam: THREE.Camera): void {
    cam.quaternion.copy(this.pose.quat)
    cam.position.copy(this.pose.target).add(new THREE.Vector3(0, 0, this.pose.dist).applyQuaternion(this.pose.quat))
    cam.up.set(0, 1, 0).applyQuaternion(this.pose.quat)
    cam.updateMatrixWorld()
  }

  /** Advance any running animation. Returns true while still animating. */
  tick(now: number): boolean {
    if (!this.anim) return false
    const a = this.anim
    const k = Math.min(1, (now - a.t0) / a.ms)
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    this.pose.target.lerpVectors(a.from.target, a.to.target, e)
    this.pose.quat.slerpQuaternions(a.from.quat, a.to.quat, e)
    this.pose.dist = Math.exp(THREE.MathUtils.lerp(Math.log(a.from.dist), Math.log(a.to.dist), e))
    if (k >= 1) this.anim = null
    return this.anim !== null
  }

  goTo(to: CamPose, animate = true): void {
    if (!animate) {
      this.anim = null
      this.pose.target.copy(to.target)
      this.pose.quat.copy(to.quat)
      this.pose.dist = to.dist
    } else {
      const from = { target: this.pose.target.clone(), quat: this.pose.quat.clone(), dist: this.pose.dist }
      this.anim = { from, to, t0: performance.now(), ms: 380 }
    }
    this.host.changed()
  }

  /** Pose that looks from `dir` towards the current target, with a sensible "up". */
  poseLookingFrom(dir: THREE.Vector3, up?: THREE.Vector3): CamPose {
    const d = dir.clone().normalize()
    const upVec = up ?? (Math.abs(d.z) > 0.999 ? new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1))
    const m = new THREE.Matrix4().lookAt(d, new THREE.Vector3(), upVec)
    return { target: this.pose.target.clone(), quat: new THREE.Quaternion().setFromRotationMatrix(m), dist: this.pose.dist }
  }

  // ---- primitive moves ---------------------------------------------------

  rotate(dx: number, dy: number, pivot: THREE.Vector3): void {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.pose.quat)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.pose.quat)
    const q = new THREE.Quaternion()
      .setFromAxisAngle(up, -dx)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy))
    this.rotateBy(q, pivot)
  }

  roll(angle: number): void {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.pose.quat)
    this.rotateBy(new THREE.Quaternion().setFromAxisAngle(fwd, angle), this.pose.target)
  }

  private rotateBy(q: THREE.Quaternion, pivotIn: THREE.Vector3): void {
    this.anim = null
    const pivot = pivotIn.clone() // may be pose.target itself
    // Rotate the camera position and the target around the pivot.
    const camPos = this.cameraPosition()
    camPos.sub(pivot).applyQuaternion(q).add(pivot)
    this.pose.target.sub(pivot).applyQuaternion(q).add(pivot)
    this.pose.quat.premultiply(q).normalize()
    // Re-derive distance so the camera stays exactly where it was rotated to.
    this.pose.dist = camPos.distanceTo(this.pose.target)
    this.host.changed()
  }

  /** Move the view by a screen-pixel delta. */
  pan(dxPx: number, dyPx: number): void {
    this.anim = null
    const wpp = this.worldPerPixel()
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.pose.quat)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.pose.quat)
    this.pose.target.addScaledVector(right, -dxPx * wpp).addScaledVector(up, dyPx * wpp)
    this.host.changed()
  }

  /** Scale the view about a world point (factor < 1 zooms in). */
  zoomAbout(point: THREE.Vector3, factor: number): void {
    this.anim = null
    const newDist = THREE.MathUtils.clamp(this.pose.dist * factor, 0.05, 5e5)
    const f = newDist / this.pose.dist
    // Scale the whole camera rig about `point`, so that point stays put on screen
    // (works for perspective, and for ortho because its frustum follows distance).
    this.pose.target.sub(point).multiplyScalar(f).add(point)
    this.pose.dist = newDist
    this.host.changed()
  }

  cameraPosition(): THREE.Vector3 {
    return this.pose.target.clone().add(new THREE.Vector3(0, 0, this.pose.dist).applyQuaternion(this.pose.quat))
  }

  private worldPerPixel(): number {
    const cam = this.host.camera()
    const h = this.host.dom.clientHeight || 1
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const o = cam as THREE.OrthographicCamera
      return (o.top - o.bottom) / o.zoom / h
    }
    const p = cam as THREE.PerspectiveCamera
    return (2 * this.pose.dist * Math.tan(THREE.MathUtils.degToRad(p.fov / 2))) / h
  }

  // ---- input -------------------------------------------------------------

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.host.dom.getBoundingClientRect()
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  /** Point on the plane through the target, facing the camera, under the cursor. */
  private pointOnTargetPlane(ndc: THREE.Vector2): THREE.Vector3 {
    const ray = new THREE.Raycaster()
    const cam = this.host.camera()
    this.applyTo(cam)
    ray.setFromCamera(ndc, cam)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.pose.quat)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, this.pose.target)
    return ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.pose.target.clone()
  }

  private opFor(e: PointerEvent): Op | null {
    const s = settings.get()
    if (s.navStyle === 'solidworks') {
      if (e.button !== 1) return null
      if (e.ctrlKey) return 'pan'
      if (e.shiftKey) return 'zoom'
      if (e.altKey) return 'roll'
      return 'rotate'
    }
    if (e.button === 1) return 'pan'
    if (e.button === 2) return e.shiftKey ? 'pan' : 'rotate'
    return null
  }

  private onDown(e: PointerEvent): void {
    const op = this.opFor(e)
    if (!op) return
    e.preventDefault()
    if (e.button === 1) {
      this.middleDownAt = { x: e.clientX, y: e.clientY }
      const plain = !e.ctrlKey && !e.shiftKey && !e.altKey
      if (plain && performance.now() - this.lastMiddleClick < 350 && settings.get().navStyle === 'solidworks') {
        this.lastMiddleClick = 0
        this.host.fitAll()
        return
      }
    }
    const ndc = this.ndc(e)
    const hit = this.host.pick(ndc)
    const pivot = settings.get().rotateAboutCursor && hit ? hit : this.pose.target.clone()
    this.drag = { op, x: e.clientX, y: e.clientY, pivot, zoomAt: hit ?? this.pointOnTargetPlane(ndc) }
    this.host.dom.setPointerCapture(e.pointerId)
    this.host.dom.style.cursor = op === 'pan' ? 'grabbing' : op === 'zoom' ? 'ns-resize' : 'move'
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return
    const dx = e.clientX - this.drag.x
    const dy = e.clientY - this.drag.y
    this.drag.x = e.clientX
    this.drag.y = e.clientY
    switch (this.drag.op) {
      case 'rotate':
        this.rotate(dx * ROT_SPEED, dy * ROT_SPEED, this.drag.pivot)
        break
      case 'pan':
        this.pan(dx, dy)
        break
      case 'zoom':
        this.zoomAbout(this.drag.zoomAt, Math.exp(dy * 0.006))
        break
      case 'roll':
        this.roll(dx * ROT_SPEED)
        break
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.button === 1) {
      // Only a click without movement counts towards a double-click.
      const still = Math.hypot(e.clientX - this.middleDownAt.x, e.clientY - this.middleDownAt.y) < 4
      this.lastMiddleClick = still && !e.ctrlKey && !e.shiftKey && !e.altKey ? performance.now() : 0
    }
    if (!this.drag) return
    this.drag = null
    this.host.dom.style.cursor = ''
    if (this.host.dom.hasPointerCapture(e.pointerId)) this.host.dom.releasePointerCapture(e.pointerId)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const ndc = this.ndc(e)
    const at = this.host.pick(ndc) ?? this.pointOnTargetPlane(ndc)
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
    const dir = settings.get().reverseWheel ? -1 : 1
    this.zoomAbout(at, Math.exp(THREE.MathUtils.clamp(px * dir, -200, 200) * 0.0015))
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement
    if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
    if (document.querySelector('.modal-backdrop')) return
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    }
    const a = arrows[e.key]
    if (!a) return
    e.preventDefault()
    if (e.ctrlKey) {
      const step = this.host.dom.clientHeight * 0.1
      this.pan(-a[0] * step, -a[1] * step)
    } else if (e.altKey) {
      if (a[0]) this.roll(a[0] * KEY_STEP)
    } else {
      const step = e.shiftKey ? Math.PI / 2 : KEY_STEP
      this.rotate(a[0] * step, a[1] * step, this.pose.target)
    }
  }
}
