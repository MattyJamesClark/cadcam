import * as THREE from 'three'

const SIZE = 120
const AXES: { dir: THREE.Vector3; color: number; label: string }[] = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xe5484d, label: 'X' },
  { dir: new THREE.Vector3(0, 1, 0), color: 0x46a758, label: 'Y' },
  { dir: new THREE.Vector3(0, 0, 1), color: 0x3e8ef7, label: 'Z' }
]

/**
 * Datum triad in the bottom-left corner: shows which way the absolute X, Y and
 * Z axes point in the current view. Click an axis letter to look straight
 * down that axis (Shift+click looks from the negative side).
 */
export class AxisTriad {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 10)
  private labels: THREE.Sprite[] = []
  private quat = new THREE.Quaternion()
  private raycaster = new THREE.Raycaster()
  readonly el: HTMLCanvasElement

  constructor(host: HTMLElement, private onPick: (dir: THREE.Vector3) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(SIZE, SIZE)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.el = this.renderer.domElement
    this.el.className = 'triad'
    this.el.title = 'Absolute axes. Click a letter to look along that axis.'
    host.appendChild(this.el)

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(2, 3, 4)
    this.camera.add(key)
    this.scene.add(this.camera)

    // Origin ball.
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 12), new THREE.MeshStandardMaterial({ color: 0xcfd6de })))

    for (const a of AXES) {
      const mat = new THREE.MeshStandardMaterial({ color: a.color, roughness: 0.5 })
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.8, 12), mat)
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.25, 16), mat)
      shaft.position.y = 0.4
      head.position.y = 0.9
      const arm = new THREE.Group()
      arm.add(shaft, head)
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.dir)
      this.scene.add(arm)

      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: letter(a.label, a.color), depthTest: false }))
      sprite.position.copy(a.dir).multiplyScalar(1.22)
      sprite.scale.setScalar(0.42)
      sprite.userData.dir = a.dir
      this.labels.push(sprite)
      this.scene.add(sprite)
    }

    this.el.addEventListener('click', (e) => {
      const r = this.el.getBoundingClientRect()
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      this.raycaster.setFromCamera(ndc, this.camera)
      const hit = this.raycaster.intersectObjects(this.labels)[0]
      if (!hit) return
      const dir = (hit.object.userData.dir as THREE.Vector3).clone()
      this.onPick(e.shiftKey ? dir.negate() : dir)
    })
    this.el.addEventListener('pointermove', (e) => {
      const r = this.el.getBoundingClientRect()
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      this.raycaster.setFromCamera(ndc, this.camera)
      this.el.style.cursor = this.raycaster.intersectObjects(this.labels).length ? 'pointer' : 'default'
    })
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? '' : 'none'
  }

  render(main: THREE.Camera): void {
    if (this.el.style.display === 'none') return
    this.quat.copy(main.quaternion)
    this.camera.position.set(0, 0, 5).applyQuaternion(this.quat)
    this.camera.quaternion.copy(this.quat)
    this.camera.updateMatrixWorld()
    this.renderer.render(this.scene, this.camera)
  }
}

function letter(text: string, color: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.font = '700 44px "Segoe UI", system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 6
  g.strokeStyle = 'rgba(0,0,0,.55)'
  g.strokeText(text, 32, 34)
  g.fillStyle = '#' + new THREE.Color(color).offsetHSL(0, 0, 0.12).getHexString()
  g.fillText(text, 32, 34)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
