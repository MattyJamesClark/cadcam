import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CadDocument } from './document'
import { Emitter } from './events'
import { ViewCube } from './viewcube'

export type Projection = 'perspective' | 'orthographic'
export type DisplayMode = 'shaded' | 'shaded-edges' | 'wireframe'
export type StandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'

/** Direction from target to camera for each standard view (Z up). */
export const VIEW_DIRS: Record<StandardView, THREE.Vector3> = {
  top: new THREE.Vector3(0, 0, 1),
  bottom: new THREE.Vector3(0, 0, -1),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  iso: new THREE.Vector3(1, -1, 1).normalize()
}

type ViewportEvents = {
  cursor: THREE.Vector3 | null
  pick: { id: string | null; additive: boolean }
  settings: void
}

const EDGE_TAG = '__edges'
const SELECT_COLOR = new THREE.Color('#ff9f1c')

/**
 * The 3D viewport. Z-up, millimetre units, renders on demand only (no
 * continuous loop) so the app sits at ~0% GPU when idle.
 *
 * Mouse: left = select, right drag = rotate, middle drag = pan,
 * wheel = zoom to cursor. Shift+right = pan as well.
 */
export class Viewport extends Emitter<ViewportEvents> {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly persp: THREE.PerspectiveCamera
  readonly ortho: THREE.OrthographicCamera
  readonly controls: OrbitControls
  readonly grid: THREE.Group
  readonly axes: THREE.Group
  private viewCube: ViewCube
  private headLight = new THREE.DirectionalLight(0xffffff, 1.6)
  private frameRequested = false
  private animation: { from: CamState; to: CamState; t0: number; ms: number } | null = null
  private raycaster = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  private downAt: { x: number; y: number } | null = null

  projection: Projection = 'perspective'
  displayMode: DisplayMode = 'shaded-edges'

  constructor(private host: HTMLElement, readonly doc: CadDocument) {
    super()
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0x000000, 0)
    host.appendChild(this.renderer.domElement)
    this.renderer.domElement.classList.add('viewport-canvas')

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6)
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6)
    for (const cam of [this.persp, this.ortho]) cam.up.set(0, 0, 1)
    this.persp.position.set(300, -400, 280)

    this.controls = new OrbitControls(this.persp, this.renderer.domElement)
    this.controls.enableDamping = false
    this.controls.zoomToCursor = true
    this.controls.screenSpacePanning = true
    this.controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE
    }
    this.controls.addEventListener('change', () => this.onCameraChange())

    // Lighting: soft ambient sky/ground + a light that follows the camera.
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x3a3f47, 1.1))
    this.scene.add(this.headLight)
    this.scene.add(this.headLight.target)

    this.grid = makeGrid()
    this.axes = makeAxes(60)
    this.scene.add(this.grid, this.axes, doc.root)

    this.viewCube = new ViewCube(host, (dir) => this.lookFrom(dir))

    doc.on('changed', () => {
      this.applyDisplayMode()
      this.requestRender()
    })
    doc.on('selection', () => {
      this.applySelection()
      this.requestRender()
    })

    this.bindPointer()
    new ResizeObserver(() => this.resize()).observe(host)
    this.resize()
    this.lookFrom(VIEW_DIRS.iso, false)
    this.fitAll(false)
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.projection === 'perspective' ? this.persp : this.ortho
  }

  // ---- rendering ---------------------------------------------------------

  requestRender(): void {
    if (this.frameRequested) return
    this.frameRequested = true
    requestAnimationFrame((t) => this.frame(t))
  }

  private frame(time: number): void {
    this.frameRequested = false
    if (this.animation) {
      const a = this.animation
      const k = Math.min(1, (time - a.t0) / a.ms)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      applyCamState(this, lerpCamState(a.from, a.to, e))
      if (k >= 1) this.animation = null
      else this.requestRender()
    }
    const cam = this.camera
    this.headLight.position.copy(cam.position)
    this.headLight.target.position.copy(this.controls.target)
    this.grid.userData.update(cam, this.controls.target)
    this.renderer.render(this.scene, cam)
    this.viewCube.render(cam)
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.persp.aspect = w / h
    this.persp.updateProjectionMatrix()
    this.updateOrthoFrustum()
    this.requestRender()
  }

  private onCameraChange(): void {
    // Keep depth precision tight around whatever we're looking at.
    const dist = this.camera.position.distanceTo(this.controls.target)
    this.persp.near = Math.max(0.01, dist / 500)
    this.persp.far = dist * 500
    this.persp.updateProjectionMatrix()
    this.updateOrthoFrustum()
    this.requestRender()
  }

  /** Ortho frustum is sized from distance to target, so zooming feels like perspective. */
  private updateOrthoFrustum(): void {
    const dist = this.camera.position.distanceTo(this.controls.target)
    const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight)
    this.ortho.left = (-h * aspect) / 2
    this.ortho.right = (h * aspect) / 2
    this.ortho.top = h / 2
    this.ortho.bottom = -h / 2
    this.ortho.near = -dist * 20
    this.ortho.far = dist * 20
    this.ortho.zoom = 1
    this.ortho.updateProjectionMatrix()
  }

  // ---- view commands -----------------------------------------------------

  setProjection(p: Projection): void {
    if (p === this.projection) return
    const from = this.camera
    const to = p === 'perspective' ? this.persp : this.ortho
    to.position.copy(from.position)
    to.quaternion.copy(from.quaternion)
    this.projection = p
    this.controls.object = to
    this.updateOrthoFrustum()
    this.controls.update()
    this.emit('settings', undefined)
    this.requestRender()
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode
    this.applyDisplayMode()
    this.emit('settings', undefined)
    this.requestRender()
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v
    this.emit('settings', undefined)
    this.requestRender()
  }

  setAxesVisible(v: boolean): void {
    this.axes.visible = v
    this.emit('settings', undefined)
    this.requestRender()
  }

  /** Orient the camera to look at the current target from `dir`. */
  lookFrom(dir: THREE.Vector3, animate = true): void {
    const target = this.controls.target.clone()
    const dist = this.camera.position.distanceTo(target) || 500
    const d = dir.clone().normalize()
    // Z stays up at all times. Straight-down/up views get a tiny tilt toward
    // -Y so X reads left-to-right and Y points up the screen.
    if (Math.abs(d.z) > 0.9999) d.set(0, -1e-4, Math.sign(d.z)).normalize()
    this.animateTo({ position: target.clone().addScaledVector(d, dist), target }, animate)
  }

  setStandardView(v: StandardView): void {
    this.lookFrom(VIEW_DIRS[v])
  }

  /** Zoom so everything visible fits (or a default work area if empty). */
  fitAll(animate = true): void {
    const box = this.doc.bounds()
    if (box.isEmpty()) box.set(new THREE.Vector3(-100, -100, 0), new THREE.Vector3(100, 100, 50))
    this.fitBox(box, animate)
  }

  fitSelection(): void {
    const box = new THREE.Box3()
    for (const id of this.doc.selection()) {
      const item = this.doc.get(id)
      if (item) box.expandByObject(item.object)
    }
    if (box.isEmpty()) return this.fitAll()
    this.fitBox(box, true)
  }

  private fitBox(box: THREE.Box3, animate: boolean): void {
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    const fov = THREE.MathUtils.degToRad(this.persp.fov)
    const aspect = this.persp.aspect
    const fitH = sphere.radius / Math.sin(fov / 2)
    const fitW = sphere.radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect))
    const dist = Math.max(fitH, fitW) * 1.1
    this.animateTo(
      {
        position: sphere.center.clone().addScaledVector(dir, dist),
        target: sphere.center.clone()
      },
      animate
    )
  }

  private animateTo(to: CamState, animate: boolean): void {
    const from = readCamState(this)
    if (!animate) {
      applyCamState(this, to)
      this.requestRender()
      return
    }
    this.animation = { from, to, t0: performance.now(), ms: 350 }
    this.requestRender()
  }

  // ---- display & selection ----------------------------------------------

  private applyDisplayMode(): void {
    const wire = this.displayMode === 'wireframe'
    const edges = this.displayMode !== 'shaded'
    this.doc.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || o.name === EDGE_TAG) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial
        if ('wireframe' in sm) sm.wireframe = wire
        sm.polygonOffset = true
        sm.polygonOffsetFactor = 1
        sm.polygonOffsetUnits = 1
      }
      let edgeObj = mesh.children.find((c) => c.name === EDGE_TAG) as THREE.LineSegments | undefined
      if (edges && !wire && !edgeObj) {
        edgeObj = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry, 25),
          new THREE.LineBasicMaterial({ color: 0x15181c })
        )
        edgeObj.name = EDGE_TAG
        edgeObj.userData.docId = mesh.userData.docId
        edgeObj.raycast = () => {}
        mesh.add(edgeObj)
      }
      if (edgeObj) edgeObj.visible = edges && !wire
    })
  }

  private applySelection(): void {
    const sel = new Set(this.doc.selection())
    this.doc.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || o.name === EDGE_TAG) return
      const m = mesh.material as THREE.MeshStandardMaterial
      if (!m || !('emissive' in m)) return
      const on = sel.has(mesh.userData.docId)
      m.emissive.copy(on ? SELECT_COLOR : new THREE.Color(0))
      m.emissiveIntensity = on ? 0.45 : 0
    })
  }

  // ---- pointer -----------------------------------------------------------

  private bindPointer(): void {
    const el = this.renderer.domElement
    el.addEventListener('contextmenu', (e) => e.preventDefault())

    // Shift + right drag pans (common in CAD packages).
    el.addEventListener(
      'pointerdown',
      (e) => {
        this.controls.mouseButtons.RIGHT = e.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
        if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY }
      },
      { capture: true }
    )

    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.downAt) return
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y)
      this.downAt = null
      if (moved > 4) return
      this.setNdc(e)
      this.raycaster.setFromCamera(this.ndc, this.camera)
      const hit = this.raycaster
        .intersectObject(this.doc.root, true)
        .find((h) => h.object.visible && h.object.name !== EDGE_TAG)
      const id = (hit?.object.userData.docId as string | undefined) ?? null
      this.emit('pick', { id, additive: e.ctrlKey || e.shiftKey })
    })

    el.addEventListener('pointermove', (e) => {
      this.setNdc(e)
      this.raycaster.setFromCamera(this.ndc, this.camera)
      const p = new THREE.Vector3()
      this.emit('cursor', this.raycaster.ray.intersectPlane(this.groundPlane, p) ? p : null)
    })
    el.addEventListener('pointerleave', () => this.emit('cursor', null))
  }

  private setNdc(e: PointerEvent): void {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }
}

// ---- camera state helpers -------------------------------------------------

interface CamState {
  position: THREE.Vector3
  target: THREE.Vector3
}

function readCamState(v: Viewport): CamState {
  return { position: v.camera.position.clone(), target: v.controls.target.clone() }
}

function applyCamState(v: Viewport, s: CamState): void {
  for (const cam of [v.persp, v.ortho]) cam.position.copy(s.position)
  v.controls.target.copy(s.target)
  v.camera.lookAt(s.target)
  v.controls.update()
}

function lerpCamState(a: CamState, b: CamState, t: number): CamState {
  // Interpolate the direction on a sphere so rotations don't cut through the target.
  const target = a.target.clone().lerp(b.target, t)
  const da = a.position.clone().sub(a.target)
  const db = b.position.clone().sub(b.target)
  const dist = THREE.MathUtils.lerp(da.length(), db.length(), t)
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion().setFromUnitVectors(da.clone().normalize(), db.clone().normalize())
  const dir = da.normalize().applyQuaternion(qa.slerp(qb, t))
  return { position: target.clone().addScaledVector(dir, dist), target }
}

// ---- scene furniture ------------------------------------------------------

/**
 * Shader grid on the XY plane. Drawn per-pixel (no line geometry), so it stays
 * crisp at any zoom, adapts its spacing to the view distance, and fades out
 * towards the horizon.
 */
function makeGrid(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'grid'
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uMinor: { value: 10 },
      uFade: { value: 2000 },
      uCam: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(0xaab4c0) }
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uMinor;
      uniform float uFade;
      uniform vec3 uCam;
      uniform vec3 uColor;
      varying vec3 vPos;
      float line(vec2 p, float s) {
        vec2 c = p / s;
        vec2 w = fwidth(c);
        vec2 g = abs(fract(c - 0.5) - 0.5) / w;
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float a = max(line(vPos.xy, uMinor) * 0.18, line(vPos.xy, uMinor * 10.0) * 0.42);
        float d = length(vPos - uCam);
        a *= 1.0 - smoothstep(uFade * 0.35, uFade, d);
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`
  })
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
  plane.renderOrder = -1
  plane.raycast = () => {}
  g.add(plane)
  g.userData.update = (cam: THREE.Camera, target: THREE.Vector3): void => {
    const dist = cam.position.distanceTo(target)
    // 1, 10, 100 mm ... spacing chosen so cells stay a comfortable size on screen.
    const minor = Math.pow(10, Math.max(-1, Math.floor(Math.log10(dist / 15))))
    const fade = Math.max(dist * 6, minor * 200)
    mat.uniforms.uMinor.value = minor
    mat.uniforms.uFade.value = fade
    mat.uniforms.uCam.value.copy(cam.position)
    plane.scale.set(fade * 2.2, fade * 2.2, 1)
    plane.position.set(target.x, target.y, 0)
  }
  return g
}

function makeAxes(len: number): THREE.Group {
  const g = new THREE.Group()
  g.name = 'axes'
  const axes: [THREE.Vector3, number][] = [
    [new THREE.Vector3(1, 0, 0), 0xe5484d],
    [new THREE.Vector3(0, 1, 0), 0x46a758],
    [new THREE.Vector3(0, 0, 1), 0x3e8ef7]
  ]
  for (const [dir, color] of axes) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(len)])
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }))
    g.add(line)
  }
  return g
}
