import * as THREE from 'three'

const SIZE = 120
// BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z (geometry is Y-up; the
// group is rotated so geometry +Y becomes world +Z).
const LABELS = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK']

/**
 * Orientation cube drawn in the corner of the viewport. Click a face to snap
 * the view to it. Renders into its own small canvas, only when the main view
 * renders or the hover state changes.
 */
export class ViewCube {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
  private cube: THREE.Mesh
  private mats: THREE.MeshBasicMaterial[]
  private group = new THREE.Group()
  private hovered = -1
  private lastQuat = new THREE.Quaternion()
  private raycaster = new THREE.Raycaster()

  constructor(host: HTMLElement, private onPick: (dir: THREE.Vector3) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(SIZE, SIZE)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const el = this.renderer.domElement
    el.className = 'viewcube'
    host.appendChild(el)

    this.mats = LABELS.map((l) => new THREE.MeshBasicMaterial({ map: labelTexture(l), color: 0xffffff }))
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.mats)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x0e1013 })
    )
    this.group.add(this.cube, edges)
    this.group.rotation.x = Math.PI / 2
    this.scene.add(this.group)

    el.addEventListener('pointermove', (e) => this.hover(this.faceAt(e)))
    el.addEventListener('pointerleave', () => this.hover(-1))
    el.addEventListener('click', (e) => {
      const hit = this.hitAt(e)
      if (!hit?.face) return
      const n = hit.face.normal.clone().transformDirection(this.cube.matrixWorld)
      this.onPick(n)
    })
  }

  render(main: THREE.Camera): void {
    this.lastQuat.copy(main.quaternion)
    this.draw()
  }

  private draw(): void {
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.lastQuat)
    this.camera.position.copy(dir.multiplyScalar(7))
    this.camera.quaternion.copy(this.lastQuat)
    this.renderer.render(this.scene, this.camera)
  }

  private hitAt(e: PointerEvent | MouseEvent): THREE.Intersection | undefined {
    const r = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    return this.raycaster.intersectObject(this.cube)[0]
  }

  private faceAt(e: PointerEvent): number {
    return this.hitAt(e)?.face?.materialIndex ?? -1
  }

  private hover(i: number): void {
    if (i === this.hovered) return
    this.hovered = i
    this.mats.forEach((m, j) => m.color.set(j === i ? 0xffc078 : 0xffffff))
    this.renderer.domElement.style.cursor = i >= 0 ? 'pointer' : 'default'
    this.draw()
  }
}

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#d5dbe3'
  g.fillRect(0, 0, 128, 128)
  g.fillStyle = '#20252b'
  g.font = '600 24px "Segoe UI", system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 64, 66)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}
