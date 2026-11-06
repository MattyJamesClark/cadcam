import { isPickingPoints, pointMoveButtons } from './pointpick'
import { showCmdBar } from './cmdbar'
import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { ModuleContext } from './types'
import type { DocNode } from './document'

/**
 * Translate tool: move the selection, or copy it (once or several times), by
 * dragging the on-screen XYZ handle, clicking points, or typing distances
 * (along the active workplane's axes) in the strip at the bottom of the view.
 * Nothing changes in the document until OK, so Cancel / Esc leaves it as it was,
 * and OK is one undo step.
 */

let active: TranslateTool | null = null

export function openTranslate(ctx: ModuleContext): void {
  if (active) {
    active.focus()
    return
  }
  if (!ctx.doc.selectedTopNodes().length) {
    ctx.status('Select what to move first', 'warn')
    return
  }
  active = new TranslateTool(ctx)
}

const GHOST_MESH = new THREE.MeshBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide })
const GHOST_LINE = new THREE.LineBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.8 })

const fmt = (v: number): string => String(Math.round(v * 1000) / 1000)

class TranslateTool {
  private nodes: DocNode[] = []
  private start: { n: DocNode; pos: THREE.Vector3 }[] = []
  private center = new THREE.Vector3()
  private delta = new THREE.Vector3()
  private copy = false
  private count = 1
  private pivot = new THREE.Object3D()
  private controls: TransformControls
  private helper: THREE.Object3D
  private ghosts = new THREE.Group()
  private panel: HTMLElement
  private inputs: HTMLInputElement[] = []
  private copyBox!: HTMLInputElement
  private countBox!: HTMLInputElement
  private title!: HTMLElement
  private off: (() => void)[] = []
  private applying = false
  private snap = 1

  constructor(private ctx: ModuleContext) {
    const vp = ctx.viewport
    this.ghosts.name = '__translate-preview'
    vp.scene.add(this.pivot, this.ghosts)

    this.controls = new TransformControls(vp.camera, vp.renderer.domElement)
    this.controls.setMode('translate')
    // Handle arrows along the active workplane's axes.
    this.controls.setSpace('local')
    this.pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(vp.workplane))
    this.controls.size = 1.1
    this.controls.attach(this.pivot)
    this.helper = this.controls.getHelper()
    vp.scene.add(this.helper)
    this.controls.addEventListener('change', () => vp.requestRender())
    // Dragging snaps to a round step that suits the zoom level (1, 2, 5, 10... mm).
    this.controls.addEventListener('mouseDown', () => (this.snap = this.snapStep()))
    this.controls.addEventListener('objectChange', () => {
      this.delta.copy(this.pivot.position).sub(this.center)
      const r = (v: number): number => +fmt(Math.round(v / this.snap) * this.snap)
      this.delta.set(r(this.delta.x), r(this.delta.y), r(this.delta.z))
      this.pivot.position.copy(this.center).add(this.delta)
      this.showValues()
      this.preview()
    })
    vp.blockPick = () => this.controls.axis !== null || this.controls.dragging
    this.off.push(vp.on('settings', () => ((this.controls.camera = vp.camera), vp.requestRender())))
    this.off.push(ctx.doc.on('selection', () => !this.applying && this.retarget()))
    // Anything else changing the document (undo, delete...) ends the tool.
    this.off.push(ctx.doc.history.on('changed', () => !this.applying && this.cancel()))

    this.panel = this.buildPanel()
    vp.host.appendChild(this.panel)
    const bar = showCmdBar(vp.host, { ok: () => this.ok(), cancel: () => this.cancel() })
    this.off.push(() => bar.dispose())
    const onKey = (e: KeyboardEvent): void => {
      if (isPickingPoints()) return
      if (e.key === 'Escape') this.cancel()
      else if (e.key === 'Enter') this.ok()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => window.removeEventListener('keydown', onKey, true))

    this.retarget()
    this.focus()
  }

  private snapStep(): number {
    const vp = this.ctx.viewport
    const cam = vp.camera
    const h =
      (cam as THREE.OrthographicCamera).isOrthographicCamera
        ? ((cam as THREE.OrthographicCamera).top - (cam as THREE.OrthographicCamera).bottom) / (cam as THREE.OrthographicCamera).zoom
        : 2 * vp.nav.pose.dist * Math.tan(THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov / 2))
    const raw = h / 150
    const p = Math.pow(10, Math.floor(Math.log10(raw)))
    const m = raw / p
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
  }

  focus(): void {
    this.inputs[0].focus()
    this.inputs[0].select()
  }

  /** Active workplane rotation: typed X / Y / Z are along its axes (VISI). */
  private axes(): { rot: THREE.Matrix4; inv: THREE.Matrix4 } {
    const rot = new THREE.Matrix4().extractRotation(this.ctx.viewport.workplane)
    return { rot, inv: rot.clone().transpose() }
  }

  /** A strip along the bottom of the view (no side panel); OK / Cancel are on the tick bar. */
  private buildPanel(): HTMLElement {
    const el = (tag: string, cls?: string, text?: string): HTMLElement => {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      if (text) e.textContent = text
      return e
    }
    const panel = el('div', 'vp-strip translate-strip')
    panel.append(el('b', 'vs-title', 'Translate'), (this.title = el('span', 'vs-label')))
    panel.append(
      pointMoveButtons(
        this.ctx,
        () => {
          this.delta.set(0, 0, 0)
          this.preview()
          panel.classList.add('hidden')
        },
        (d) => {
          this.delta.copy(d)
          this.preview()
        },
        () => panel.classList.remove('hidden')
      )
    )
    const grid = el('div', 'vs-group')
    grid.append(el('span', 'vs-label', 'Move'))
    ;(['X', 'Y', 'Z'] as const).forEach((axis, i) => {
      const wrap = el('label', `vs-field axis-${axis.toLowerCase()}`)
      const input = document.createElement('input')
      input.type = 'number'
      input.step = '1'
      input.value = '0'
      input.title = `Distance along the active plane's ${axis} axis (mm)`
      input.addEventListener('input', () => {
        const { rot, inv } = this.axes()
        const local = this.delta.clone().applyMatrix4(inv)
        const v = parseFloat(input.value)
        local.setComponent(i, Number.isFinite(v) ? v : 0)
        this.delta.copy(local.applyMatrix4(rot))
        this.preview()
      })
      input.addEventListener('focus', () => input.select())
      this.inputs.push(input)
      wrap.append(el('span', '', axis), input)
      grid.append(wrap)
    })
    panel.append(el('span', 'vs-sep'), grid, el('span', 'vs-sep'))

    const copyLabel = el('label', 'check vs-copy')
    this.copyBox = document.createElement('input')
    this.copyBox.type = 'checkbox'
    copyLabel.append(this.copyBox, document.createTextNode(' Copy'))
    this.countBox = document.createElement('input')
    this.countBox.type = 'number'
    this.countBox.min = '1'
    this.countBox.max = '500'
    this.countBox.step = '1'
    this.countBox.value = '1'
    this.countBox.disabled = true
    this.countBox.className = 'tool-count'
    this.countBox.title = 'Number of copies. Each copy is one step further along.'
    this.copyBox.addEventListener('change', () => {
      this.copy = this.copyBox.checked
      this.countBox.disabled = !this.copy
      this.rebuildGhosts()
      this.preview()
    })
    this.countBox.addEventListener('input', () => {
      const v = Math.round(Number(this.countBox.value))
      this.count = Math.max(1, Math.min(500, Number.isFinite(v) ? v : 1))
      this.rebuildGhosts()
      this.preview()
    })
    const copyGroup = el('div', 'vs-group')
    copyGroup.append(copyLabel, this.countBox, el('span', 'vs-label', 'copies'))
    panel.append(copyGroup)
    // Keep clicks in the strip from reaching the viewport.
    panel.addEventListener('pointerdown', (e) => e.stopPropagation())
    return panel
  }

  /** (Re)start on the current selection, keeping the typed values. */
  private retarget(): void {
    this.restore()
    this.nodes = this.ctx.doc.selectedTopNodes()
    if (!this.nodes.length) {
      this.cancel()
      return
    }
    this.start = this.nodes.map((n) => ({ n, pos: n.object.position.clone() }))
    this.ctx.doc.root.updateMatrixWorld(true)
    this.ctx.doc.bounds(this.nodes).getCenter(this.center)
    this.title.textContent = this.nodes.length === 1 ? this.nodes[0].name : `${this.nodes.length} items`
    this.rebuildGhosts()
    this.preview()
  }

  private showValues(): void {
    const local = this.delta.clone().applyMatrix4(this.axes().inv)
    this.inputs.forEach((input, i) => {
      if (document.activeElement !== input || this.controls.dragging) input.value = fmt(local.getComponent(i))
    })
  }

  /** Put the originals back where they were. */
  private restore(): void {
    for (const s of this.start) {
      s.n.object.position.copy(s.pos)
      s.n.object.updateMatrixWorld(true)
    }
  }

  private rebuildGhosts(): void {
    for (const g of [...this.ghosts.children]) this.ghosts.remove(g)
    if (!this.copy) return
    this.ctx.doc.root.updateMatrixWorld(true)
    for (let k = 1; k <= this.count; k++)
      for (const n of this.nodes) {
        const g = n.object.clone(true)
        g.traverse((o) => {
          const m = o as THREE.Mesh
          if ((o as THREE.LineSegments).isLineSegments) m.material = GHOST_LINE
          else if (m.isMesh) m.material = GHOST_MESH
          o.raycast = () => {} // not pickable
        })
        g.matrixAutoUpdate = false
        g.userData.base = n.object.matrixWorld.clone()
        g.userData.k = k
        this.ghosts.add(g)
      }
  }

  private preview(): void {
    if (this.copy) {
      this.restore()
      for (const g of this.ghosts.children) {
        const t = new THREE.Matrix4().makeTranslation(this.delta.clone().multiplyScalar(g.userData.k as number))
        g.matrix.multiplyMatrices(t, g.userData.base as THREE.Matrix4)
        g.matrixWorldNeedsUpdate = true
      }
    } else {
      // Moving: show the real thing where it will end up.
      for (const s of this.start) {
        const parent = s.n.object.parent
        const inv = parent ? parent.matrixWorld.clone().invert() : new THREE.Matrix4()
        const a = new THREE.Vector3().applyMatrix4(parent?.matrixWorld ?? new THREE.Matrix4()).applyMatrix4(inv)
        const b = new THREE.Vector3().applyMatrix4(parent?.matrixWorld ?? new THREE.Matrix4()).add(this.delta).applyMatrix4(inv)
        s.n.object.position.copy(s.pos).add(b.sub(a))
        s.n.object.updateMatrixWorld(true)
      }
    }
    if (!this.controls.dragging) this.pivot.position.copy(this.center).add(this.delta)
    this.showValues()
    this.ctx.viewport.requestRender()
  }

  private ok(): void {
    const ids = this.nodes.map((n) => n.id)
    const delta = this.delta.clone()
    const copy = this.copy
    const count = this.count
    this.applying = true
    this.restore()
    if (copy) {
      const made = this.ctx.doc.duplicate(ids, delta, count)
      this.ctx.status(`Made ${made.length} cop${made.length === 1 ? 'y' : 'ies'}`, 'success')
    } else if (delta.lengthSq() > 0) {
      this.ctx.doc.translate(ids, delta)
      this.ctx.status(`Moved ${fmt(delta.x)}, ${fmt(delta.y)}, ${fmt(delta.z)} mm`, 'success')
    }
    this.close()
  }

  private cancel(): void {
    this.restore()
    this.close()
  }

  private close(): void {
    if (active !== this) return
    active = null
    this.off.forEach((f) => f())
    this.controls.detach()
    this.controls.dispose()
    const vp = this.ctx.viewport
    vp.scene.remove(this.helper, this.pivot, this.ghosts)
    vp.blockPick = null
    this.panel.remove()
    this.ctx.refreshRibbon()
    vp.requestRender()
  }
}
