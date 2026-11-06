import * as THREE from 'three'
import { CadDocument } from './document'
import { Emitter } from './events'
import { CadNavigation } from './navigation'
import { featureEdges } from './edges'
import { effectiveTheme, settings, type Settings } from './settings'
import { AxisTriad } from './triad'
import { ViewCube } from './viewcube'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

// Picking (selection, rotate-about-cursor) uses a bounding volume hierarchy per
// geometry, so it stays instant on models with millions of triangles.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

export type Projection = 'perspective' | 'orthographic'
export type DisplayMode = 'shaded' | 'shaded-edges' | 'hidden-removed' | 'wireframe'
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
 * continuous loop) so the app sits at ~0% GPU when idle. Mouse handling lives
 * in CadNavigation; left-click selection lives here.
 */
export class Viewport extends Emitter<ViewportEvents> {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly persp: THREE.PerspectiveCamera
  readonly ortho: THREE.OrthographicCamera
  readonly nav: CadNavigation
  readonly grid: THREE.Group
  readonly axes: THREE.Group
  readonly planes: THREE.Group
  private viewCube: ViewCube
  private triad: AxisTriad
  private headLight = new THREE.DirectionalLight(0xffffff, 1.6)
  private frameRequested = false
  private raycaster = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  /** Active workplane (frame to world). Grid, axes, cursor readout and standard views follow it. */
  readonly workplane = new THREE.Matrix4()
  private workInv = new THREE.Matrix4()
  private downAt: { x: number; y: number } | null = null
  private bgLight = false

  projection: Projection = 'orthographic'
  /** Set by tools with on-screen handles: true while the pointer is over one (no picking then). */
  blockPick: (() => boolean) | null = null
  /** Called after each frame (to place screen labels on 3D points). */
  readonly afterRender = new Set<() => void>()
  displayMode: DisplayMode = 'shaded-edges'

  constructor(readonly host: HTMLElement, readonly doc: CadDocument) {
    super()
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

    // Opaque canvas with the background gradient drawn by WebGL itself: a
    // see-through canvas over a CSS background has to be blended by the
    // browser every frame, which can tear while orbiting on some GPUs.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(this.renderer.domElement)
    this.renderer.domElement.classList.add('viewport-canvas')

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6)
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6)

    this.nav = new CadNavigation({
      dom: this.renderer.domElement,
      camera: () => this.camera,
      pick: (ndc) => this.pickPoint(ndc),
      fitAll: () => this.fitAll(),
      changed: () => this.requestRender()
    })

    // Lighting: soft ambient sky/ground + a light that follows the camera.
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x3a3f47, 1.1))
    this.scene.add(this.headLight)
    this.scene.add(this.headLight.target)

    this.grid = makeGrid()
    this.axes = makeAxes(60)
    this.planes = makeOriginPlanes()
    this.planes.visible = false
    this.scene.add(this.grid, this.planes, this.axes, doc.root)
    for (const g of [this.grid, this.axes]) g.matrixAutoUpdate = false

    this.viewCube = new ViewCube(host, (dir) => this.lookNormalTo(dir))
    this.triad = new AxisTriad(host, (dir) => this.lookNormalTo(dir))

    doc.on('changed', () => {
      this.applyDisplayMode()
      this.updatePlaneSize()
      this.scheduleBoundsTrees()
      this.requestRender()
    })
    doc.on('selection', () => {
      this.applySelection()
      this.requestRender()
    })

    this.bindPointer()
    new ResizeObserver(() => this.resize()).observe(host)
    this.resize()
    this.nav.goTo(this.nav.poseLookingFrom(VIEW_DIRS.iso), false)
    this.fitAll(false)

    settings.on('changed', (s) => this.applySettings(s))
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => this.applySettings(settings.get()))
    this.applySettings(settings.get())
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
    if (this.nav.tick(time)) this.requestRender()
    const cam = this.camera
    this.nav.applyTo(cam)
    this.updateClipping()
    const target = this.nav.pose.target
    this.headLight.position.copy(cam.position)
    this.headLight.target.position.copy(target)
    this.grid.userData.update(cam, target.clone().applyMatrix4(this.workInv), this.nav.pose.dist)
    this.renderer.render(this.scene, cam)
    this.viewCube.render(cam)
    this.triad.render(cam)
    this.afterRender.forEach((f) => f())
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.persp.aspect = w / h
    this.persp.updateProjectionMatrix()
    this.requestRender()
  }

  /** Keep depth precision tight around what we're looking at; size the ortho frustum from distance. */
  private updateClipping(): void {
    const dist = this.nav.pose.dist
    this.persp.near = Math.max(0.01, dist / 500)
    this.persp.far = dist * 500
    this.persp.updateProjectionMatrix()
    const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))
    const aspect = this.persp.aspect
    this.ortho.left = (-h * aspect) / 2
    this.ortho.right = (h * aspect) / 2
    this.ortho.top = h / 2
    this.ortho.bottom = -h / 2
    this.ortho.near = -dist * 20
    this.ortho.far = dist * 20
    this.ortho.zoom = 1
    this.ortho.updateProjectionMatrix()
  }

  // ---- settings & theme --------------------------------------------------

  private bgTexture: THREE.CanvasTexture | null = null
  private setBackground(top: string, bottom: string): void {
    const c = document.createElement('canvas')
    c.width = 2
    c.height = 512
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 0, c.height)
    grad.addColorStop(0, top)
    grad.addColorStop(1, bottom)
    g.fillStyle = grad
    g.fillRect(0, 0, c.width, c.height)
    this.bgTexture?.dispose()
    this.bgTexture = new THREE.CanvasTexture(c)
    this.bgTexture.colorSpace = THREE.SRGBColorSpace
    this.scene.background = this.bgTexture
  }

  private applySettings(s: Settings): void {
    const dark = effectiveTheme(s) === 'dark'
    const top = s.viewportTop ?? (dark ? '#3b4350' : '#e8edf3')
    const bottom = s.viewportBottom ?? (dark ? '#1c2026' : '#c3ccd6')
    this.host.style.setProperty('--vp-top', top)
    this.host.style.setProperty('--vp-bottom', bottom)
    this.setBackground(top, bottom)
    // Grid contrasts with the background, not with the UI theme.
    const lum = (new THREE.Color(top).getHSL({ h: 0, s: 0, l: 0 }).l + new THREE.Color(bottom).getHSL({ h: 0, s: 0, l: 0 }).l) / 2
    this.bgLight = lum > 0.55
    this.grid.userData.setColor(lum > 0.55 ? 0x3d4651 : 0xaab4c0, lum > 0.55 ? 0.8 : 1)
    SELECT_COLOR.set(s.accent)
    this.viewCube.setVisible(s.showViewCube)
    this.triad.setVisible(s.showTriad)
    const part = new THREE.Color(s.partColor)
    this.doc.root.traverse((o) => {
      const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined
      for (const m of Array.isArray(mm) ? mm : mm ? [mm] : []) if (m.userData?.defaultColor) m.color.copy(part)
    })
    this.applySelection()
    this.requestRender()
  }

  // ---- view commands -----------------------------------------------------

  setProjection(p: Projection): void {
    if (p === this.projection) return
    this.projection = p
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

  setPlanesVisible(v: boolean): void {
    this.planes.visible = v
    this.updatePlaneSize()
    this.emit('settings', undefined)
    this.requestRender()
  }

  /** Orient the camera to look at the current target from `dir`. */
  lookFrom(dir: THREE.Vector3, animate = true): void {
    this.nav.goTo(this.nav.poseLookingFrom(dir), animate)
  }

  /**
   * Look straight at a view-cube face / along an axis, turning as little as
   * possible: the screen keeps its current "up" (snapped to the nearest 90°),
   * so a part viewed on its side stays on its side. Corners and edges of the
   * cube use the usual Z-up view.
   */
  lookNormalTo(dir: THREE.Vector3, animate = true): void {
    const d = dir.clone().normalize()
    const axis = Math.max(Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)) > 0.999
    if (!axis) return this.lookFrom(d, animate)
    const curUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.nav.pose.quat)
    let best: THREE.Vector3 | null = null
    let bestDot = -Infinity
    for (const c of [
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
    ]) {
      if (Math.abs(c.dot(d)) > 0.5) continue
      const dot = c.dot(curUp)
      if (dot > bestDot) {
        bestDot = dot
        best = c
      }
    }
    this.nav.goTo(this.nav.poseLookingFrom(d, best ?? undefined), animate)
  }

  setStandardView(v: StandardView): void {
    const rot = new THREE.Matrix4().extractRotation(this.workplane)
    const dir = VIEW_DIRS[v].clone().applyMatrix4(rot)
    const d = VIEW_DIRS[v]
    const up = Math.abs(d.z) > 0.999 ? new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1)
    this.nav.goTo(this.nav.poseLookingFrom(dir, up.applyMatrix4(rot)), true)
  }

  /** Make a frame the active workplane (identity = Absolute). */
  setWorkplane(m: THREE.Matrix4): void {
    this.workplane.copy(m)
    this.workInv.copy(m).invert()
    for (const g of [this.grid, this.axes]) g.matrix.copy(m)
    this.triad.setFrame(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m)))
    const n = new THREE.Vector3(0, 0, 1).transformDirection(m)
    this.groundPlane.setFromNormalAndCoplanarPoint(n, new THREE.Vector3().setFromMatrixPosition(m))
    this.emit('settings', undefined)
    this.requestRender()
  }

  /** Zoom so everything visible fits (or a default work area if empty). */
  fitAll(animate = true): void {
    const box = this.doc.bounds()
    if (box.isEmpty()) box.set(new THREE.Vector3(-100, -100, 0), new THREE.Vector3(100, 100, 50))
    this.fitBox(box, animate)
  }

  fitSelection(): void {
    const box = this.doc.bounds(this.doc.selectedTopNodes())
    if (box.isEmpty()) return this.fitAll()
    this.fitBox(box, true)
  }

  private fitBox(box: THREE.Box3, animate: boolean): void {
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const fov = THREE.MathUtils.degToRad(this.persp.fov)
    const aspect = this.persp.aspect
    const fitH = sphere.radius / Math.sin(fov / 2)
    const fitW = sphere.radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect))
    this.nav.goTo(
      { target: sphere.center.clone(), quat: this.nav.pose.quat.clone(), dist: Math.max(fitH, fitW) * 1.1 },
      animate
    )
  }

  // ---- display & selection ----------------------------------------------

  /**
   * Display modes, as in most CAD packages:
   *  shaded          surfaces only
   *  shaded-edges    surfaces + model edges
   *  hidden-removed  model edges only, back edges hidden (surfaces drawn into depth only)
   *  wireframe       model edges only, see-through
   */
  private applyDisplayMode(): void {
    const mode = this.displayMode
    const showEdges = mode !== 'shaded'
    const surfaces = mode === 'shaded' || mode === 'shaded-edges'
    this.doc.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || o.name === EDGE_TAG) return
      for (const m of materialsOf(mesh)) {
        m.wireframe = false
        m.visible = mode !== 'wireframe' // still pickable: raycasting ignores material visibility
        m.colorWrite = surfaces
        m.polygonOffset = true
        m.polygonOffsetFactor = 1
        m.polygonOffsetUnits = 1
      }
      let edgeObj = mesh.children.find((c) => c.name === EDGE_TAG) as THREE.LineSegments | undefined
      if (showEdges && !edgeObj) {
        edgeObj = new THREE.LineSegments(featureEdges(mesh), new THREE.LineBasicMaterial())
        edgeObj.name = EDGE_TAG
        edgeObj.userData.docId = mesh.userData.docId
        edgeObj.raycast = () => {}
        mesh.add(edgeObj)
      }
      if (edgeObj) edgeObj.visible = showEdges
    })
    this.applySelection()
  }

  private applySelection(): void {
    // Edge colour: dark on shaded parts; contrasting with the background when
    // the edges are all you see.
    const linesOnly = this.displayMode === 'wireframe' || this.displayMode === 'hidden-removed'
    const edgeColor = new THREE.Color(linesOnly ? (this.bgLight ? 0x1d232b : 0xdfe5ec) : 0x15181c)
    this.doc.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (o.name === EDGE_TAG) {
        const on = this.doc.isSelected(o.userData.docId)
        ;((o as THREE.LineSegments).material as THREE.LineBasicMaterial).color.copy(on ? SELECT_COLOR : edgeColor)
        return
      }
      if (o.userData.wireBody) {
        // Wireframe geometry from the CAD file: its own colour, accent when selected.
        const mat = (o as THREE.LineSegments).material as THREE.LineBasicMaterial
        if (!mat.userData.base) mat.userData.base = mat.color.clone()
        const on = this.doc.isSelected(o.userData.docId)
        mat.color.copy(on ? SELECT_COLOR : mat.userData.defaultColor ? edgeColor : mat.userData.base)
        return
      }
      if (!mesh.isMesh) return
      const on = this.doc.isSelected(mesh.userData.docId)
      for (const m of materialsOf(mesh)) {
        if (!('emissive' in m)) continue
        m.emissive.copy(on ? SELECT_COLOR : new THREE.Color(0))
        m.emissiveIntensity = on ? 0.45 : 0
      }
    })
  }

  private updatePlaneSize(): void {
    if (!this.planes.visible) return
    const box = this.doc.bounds()
    const size = box.isEmpty() ? 100 : Math.max(50, box.getSize(new THREE.Vector3()).length() * 0.6)
    this.planes.scale.setScalar(size)
  }

  // ---- picking -----------------------------------------------------------

  /** First visible model point under the given NDC position. */
  pickPoint(ndc: THREE.Vector2): THREE.Vector3 | null {
    return this.pickHit(ndc)?.point ?? null
  }

  /** Pointer event to normalised device coordinates. */
  ndcOf(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  /** Nearest visible model hit under a screen point. */
  hitTest(ndc: THREE.Vector2): THREE.Intersection | undefined {
    return this.pickHit(ndc)
  }

  /** World point to canvas pixels. */
  toScreen(p: THREE.Vector3): THREE.Vector2 {
    const v = p.clone().project(this.camera)
    const el = this.renderer.domElement
    return new THREE.Vector2(((v.x + 1) / 2) * el.clientWidth, ((1 - v.y) / 2) * el.clientHeight)
  }

  private pickHit(ndc: THREE.Vector2): THREE.Intersection | undefined {
    this.nav.applyTo(this.camera)
    this.raycaster.setFromCamera(ndc, this.camera)
    // Lines (wireframe geometry) are picked within a few pixels.
    this.raycaster.params.Line.threshold = this.nav.pose.dist * 0.006
    this.raycaster.firstHitOnly = true
    this.buildBoundsTrees()
    return this.raycaster
      .intersectObject(this.doc.root, true)
      .find((h) => isVisible(h.object) && h.object.name !== EDGE_TAG)
  }

  /** Build picking acceleration for any mesh that doesn't have it yet. */
  private buildBoundsTrees(): void {
    this.doc.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || o.name === EDGE_TAG) return
      const geo = mesh.geometry
      if (!geo.boundsTree && geo.index && geo.index.count >= 3) geo.computeBoundsTree({ indirect: true })
    })
  }

  private bvhTimer = 0
  /** After an import, build picking acceleration while the app is idle. */
  private scheduleBoundsTrees(): void {
    cancelIdleCallback(this.bvhTimer)
    this.bvhTimer = requestIdleCallback(() => this.buildBoundsTrees(), { timeout: 2000 })
  }

  private bindPointer(): void {
    const el = this.renderer.domElement
    el.addEventListener('contextmenu', (e) => e.preventDefault())

    el.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.downAt = this.blockPick?.() ? null : { x: e.clientX, y: e.clientY }
    })

    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.downAt) return
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y)
      this.downAt = null
      if (moved > 4) return
      this.setNdc(e)
      const hit = this.pickHit(this.ndc)
      const id = (hit?.object.userData.docId as string | undefined) ?? null
      this.emit('pick', { id, additive: e.ctrlKey || e.shiftKey })
    })

    el.addEventListener('pointermove', (e) => {
      this.setNdc(e)
      this.nav.applyTo(this.camera)
      this.raycaster.setFromCamera(this.ndc, this.camera)
      const p = new THREE.Vector3()
      // Reported in the active workplane's coordinates.
      this.emit('cursor', this.raycaster.ray.intersectPlane(this.groundPlane, p) ? p.applyMatrix4(this.workInv) : null)
    })
    el.addEventListener('pointerleave', () => this.emit('cursor', null))
  }

  private setNdc(e: PointerEvent): void {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }
}

function materialsOf(mesh: THREE.Mesh): THREE.MeshStandardMaterial[] {
  return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]
}

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
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
      uColor: { value: new THREE.Color(0xaab4c0) },
      uStrength: { value: 1 },
      uLocal: { value: new THREE.Matrix4() }
    },
    vertexShader: /* glsl */ `
      uniform mat4 uLocal;
      varying vec3 vPos;
      varying vec2 vLoc;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        vLoc = (uLocal * vec4(position, 1.0)).xy;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uMinor;
      uniform float uFade;
      uniform float uStrength;
      uniform vec3 uCam;
      uniform vec3 uColor;
      varying vec3 vPos;
      varying vec2 vLoc;
      float line(vec2 p, float s) {
        vec2 c = p / s;
        vec2 w = fwidth(c);
        vec2 g = abs(fract(c - 0.5) - 0.5) / w;
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float a = max(line(vLoc, uMinor) * 0.18, line(vLoc, uMinor * 10.0) * 0.42) * uStrength;
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
  g.userData.update = (cam: THREE.Camera, target: THREE.Vector3, dist: number): void => {
    // 1, 10, 100 mm ... spacing chosen so cells stay a comfortable size on screen.
    const minor = Math.pow(10, Math.max(-1, Math.floor(Math.log10(dist / 15))))
    const fade = Math.max(dist * 6, minor * 200)
    mat.uniforms.uMinor.value = minor
    mat.uniforms.uFade.value = fade
    mat.uniforms.uCam.value.copy(cam.position)
    plane.scale.set(fade * 2.2, fade * 2.2, 1)
    plane.position.set(target.x, target.y, 0)
    plane.updateMatrix()
    mat.uniforms.uLocal.value.copy(plane.matrix)
  }
  g.userData.setColor = (color: number, strength: number): void => {
    mat.uniforms.uColor.value.set(color)
    mat.uniforms.uStrength.value = strength
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
    g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })))
  }
  return g
}

/** The three origin datum planes (Top = XY, Front = XZ, Right = YZ), unit size, scaled to the model. */
function makeOriginPlanes(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'planes'
  const defs: [string, THREE.Euler, number][] = [
    ['Top (XY)', new THREE.Euler(0, 0, 0), 0x3e8ef7],
    ['Front (XZ)', new THREE.Euler(Math.PI / 2, 0, 0), 0x46a758],
    ['Right (YZ)', new THREE.Euler(0, Math.PI / 2, 0), 0xe5484d]
  ]
  for (const [name, rot, color] of defs) {
    const geo = new THREE.PlaneGeometry(1, 1)
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false })
    )
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
    )
    const p = new THREE.Group()
    p.name = name
    p.rotation.copy(rot)
    p.add(fill, border)
    fill.raycast = () => {}
    g.add(p)
  }
  return g
}
