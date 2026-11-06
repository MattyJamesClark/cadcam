import * as THREE from 'three'
import type { ModuleContext } from './types'
import type { DocNode } from './document'
import { isPickingPoints, pickPoints } from './pointpick'
import { showCmdBar } from './cmdbar'
import { el, fmt } from './toolpanel'
import { Handles, type RingSpec } from './handles'

/**
 * Rotate tool: turn the selection about an axis, or make rotated copies
 * (once or several times, each one a further step round, e.g. a bolt circle).
 * The axis is X, Y or Z of the active workplane through a centre point (the
 * selection's centre unless you click one), or an axis picked by two points.
 * Runs from a strip at the bottom of the view and the tick bar: nothing changes
 * in the document until OK, and OK is one undo step.
 */

let active: RotateTool | null = null

export function openRotate(ctx: ModuleContext): void {
  if (active) return
  if (!ctx.doc.selectedTopNodes().length) {
    ctx.status('Select what to rotate first', 'warn')
    return
  }
  active = new RotateTool(ctx)
}

const GHOST_MESH = new THREE.MeshBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide })
const GHOST_LINE = new THREE.LineBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.8 })

class RotateTool {
  private nodes: DocNode[] = []
  private start: { n: DocNode; local: THREE.Matrix4 }[] = []
  private centre = new THREE.Vector3()
  private axis = new THREE.Vector3(0, 0, 1)
  private axisName: 'X' | 'Y' | 'Z' | 'picked' = 'Z'
  private angle = 90
  private copy = false
  private count = 1
  private ghosts = new THREE.Group()
  private axisLine: THREE.Line
  private strip: HTMLElement
  private angleBox!: HTMLInputElement
  private countBox!: HTMLInputElement
  private axisBtns = new Map<string, HTMLButtonElement>()
  private centreText = el('span', 'vs-readout')
  private off: (() => void)[] = []
  private applying = false
  private handles: Handles
  private ring: RingSpec

  constructor(private ctx: ModuleContext) {
    const vp = ctx.viewport
    this.ghosts.name = '__rotate-preview'
    this.axisLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xff9f1c, dashSize: 4, gapSize: 3, depthTest: false }))
    this.axisLine.renderOrder = 10
    vp.scene.add(this.ghosts, this.axisLine)
    this.nodes = ctx.doc.selectedTopNodes()
    ctx.doc.root.updateMatrixWorld(true)
    this.start = this.nodes.map((n) => ({ n, local: n.object.matrix.clone() }))
    ctx.doc.bounds(this.nodes).getCenter(this.centre)
    this.setAxis('Z')

    this.handles = new Handles(vp)
    this.ring = this.handles.ring({
      centre: this.centre.clone(),
      axis: this.axis.clone(),
      value: this.angle,
      tip: 'Drag round to set the angle (snaps to 5°, Shift: free)',
      onDrag: (v) => {
        this.angle = v
        this.angleBox.value = fmt(v)
        this.preview()
      }
    })
    this.off.push(() => this.handles.dispose())
    this.strip = this.build()
    vp.host.append(this.strip)
    const bar = showCmdBar(vp.host, { ok: () => this.ok(), cancel: () => this.cancel() })
    this.off.push(() => bar.dispose())
    // Anything else changing the document (undo, delete...) ends the tool.
    this.off.push(ctx.doc.history.on('changed', () => !this.applying && this.cancel()))
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
    this.rebuildGhosts()
    this.preview()
    this.angleBox.focus()
    this.angleBox.select()
  }

  private build(): HTMLElement {
    const strip = el('div', 'vp-strip rotate-strip')
    strip.addEventListener('pointerdown', (e) => e.stopPropagation())
    strip.append(el('b', 'vs-title', 'Rotate'), el('span', 'vs-label', this.nodes.length === 1 ? this.nodes[0].name : `${this.nodes.length} items`))

    // Axis: the active plane's X / Y / Z, or two clicked points.
    const axes = el('div', 'vs-group')
    axes.append(el('span', 'vs-label', 'Axis'))
    for (const a of ['X', 'Y', 'Z'] as const) {
      const b = el('button', `btn vs-text vs-axis axis-${a.toLowerCase()}`, a)
      b.title = `Turn about the active plane's ${a} axis, through the centre point`
      b.addEventListener('click', () => {
        this.setAxis(a)
        this.preview()
      })
      this.axisBtns.set(a, b)
      axes.append(b)
    }
    const pickAxis = el('button', 'btn vs-text', '2 points')
    pickAxis.title = 'Click two points on the axis (e.g. two hole centres); the first one is the centre'
    pickAxis.addEventListener('click', () =>
      void this.pick('Rotate axis', ['select the first point on the axis', 'select the second point on the axis'], (p) => {
        const d = p[1].clone().sub(p[0])
        if (d.lengthSq() < 1e-12) return
        this.axis.copy(d.normalize())
        this.centre.copy(p[0])
        this.axisName = 'picked'
      })
    )
    this.axisBtns.set('picked', pickAxis)
    axes.append(pickAxis)

    const centre = el('div', 'vs-group')
    const pickCentre = el('button', 'btn vs-text', 'Centre point')
    pickCentre.title = 'Click the point to turn about (a hole centre, a corner...)'
    pickCentre.addEventListener('click', () => void this.pick('Rotate centre', ['select the centre point'], (p) => this.centre.copy(p[0])))
    centre.append(pickCentre, this.centreText)

    const ang = el('div', 'vs-group')
    ang.append(el('span', 'vs-label', 'Angle °'))
    this.angleBox = el('input')
    this.angleBox.type = 'number'
    this.angleBox.value = String(this.angle)
    this.angleBox.className = 'vs-angle'
    this.angleBox.title = 'Degrees, anticlockwise looking down the axis (negative = clockwise)'
    this.angleBox.addEventListener('input', () => {
      const v = parseFloat(this.angleBox.value)
      this.angle = Number.isFinite(v) ? v : 0
      this.preview()
    })
    ang.append(this.angleBox)
    for (const v of [90, 180, -90]) {
      const b = el('button', 'btn vs-text', `${v}°`)
      b.addEventListener('click', () => {
        this.angle = v
        this.angleBox.value = String(v)
        this.preview()
      })
      ang.append(b)
    }

    const copyGroup = el('div', 'vs-group')
    const copyLabel = el('label', 'check vs-copy')
    const copyBox = el('input')
    copyBox.type = 'checkbox'
    copyLabel.append(copyBox, document.createTextNode(' Copy'))
    this.countBox = el('input')
    this.countBox.type = 'number'
    this.countBox.min = '1'
    this.countBox.max = '500'
    this.countBox.value = '1'
    this.countBox.disabled = true
    this.countBox.className = 'tool-count'
    this.countBox.title = 'Number of copies. Each copy is one more angle step round.'
    copyBox.addEventListener('change', () => {
      this.copy = copyBox.checked
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
    copyGroup.append(copyLabel, this.countBox, el('span', 'vs-label', 'copies'))

    const sep = (): HTMLElement => el('span', 'vs-sep')
    strip.append(sep(), axes, sep(), centre, sep(), ang, sep(), copyGroup)
    return strip
  }

  private setAxis(a: 'X' | 'Y' | 'Z'): void {
    const i = 'XYZ'.indexOf(a)
    this.axis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).transformDirection(this.ctx.viewport.workplane)
    this.axisName = a
  }

  private async pick(title: string, steps: string[], use: (p: THREE.Vector3[]) => void): Promise<void> {
    this.strip.classList.add('hidden')
    const p = await pickPoints(this.ctx, title, steps)
    this.strip.classList.remove('hidden')
    if (p) use(p)
    this.preview()
  }

  /** World rotation for k angle steps about the axis through the centre. */
  private step(k = 1): THREE.Matrix4 {
    const r = new THREE.Matrix4().makeRotationAxis(this.axis, THREE.MathUtils.degToRad(this.angle * k))
    return new THREE.Matrix4().makeTranslation(this.centre).multiply(r).multiply(new THREE.Matrix4().makeTranslation(this.centre.clone().negate()))
  }

  private restore(): void {
    for (const s of this.start) {
      s.local.decompose(s.n.object.position, s.n.object.quaternion, s.n.object.scale)
      s.n.object.updateMatrixWorld(true)
    }
  }

  private rebuildGhosts(): void {
    for (const g of [...this.ghosts.children]) this.ghosts.remove(g)
    if (!this.copy) return
    this.restore()
    this.ctx.doc.root.updateMatrixWorld(true)
    for (let k = 1; k <= this.count; k++)
      for (const n of this.nodes) {
        const g = n.object.clone(true)
        g.traverse((o) => {
          const m = o as THREE.Mesh
          if ((o as THREE.LineSegments).isLineSegments) m.material = GHOST_LINE
          else if (m.isMesh) m.material = GHOST_MESH
          o.raycast = () => {}
        })
        g.matrixAutoUpdate = false
        g.userData.base = n.object.matrixWorld.clone()
        g.userData.k = k
        this.ghosts.add(g)
      }
  }

  private preview(): void {
    this.restore()
    if (this.copy) {
      for (const g of this.ghosts.children) {
        g.matrix.multiplyMatrices(this.step(g.userData.k as number), g.userData.base as THREE.Matrix4)
        g.matrixWorldNeedsUpdate = true
      }
    } else {
      const m = this.step()
      for (const s of this.start) {
        const o = s.n.object
        o.updateMatrixWorld(true)
        const parentWorld = o.parent ? o.parent.matrixWorld.clone() : new THREE.Matrix4()
        parentWorld.invert().multiply(m).multiply(o.matrixWorld).decompose(o.position, o.quaternion, o.scale)
        o.updateMatrixWorld(true)
      }
    }
    // Axis line through the centre, a bit longer than the selection.
    const b = this.ctx.doc.bounds(this.nodes)
    const len = Math.max(20, b.isEmpty() ? 50 : b.getSize(new THREE.Vector3()).length() * 0.75)
    this.axisLine.geometry.dispose()
    this.axisLine.geometry = new THREE.BufferGeometry().setFromPoints([
      this.centre.clone().addScaledVector(this.axis, -len),
      this.centre.clone().addScaledVector(this.axis, len)
    ])
    this.axisLine.computeLineDistances()
    this.ring.centre.copy(this.centre)
    this.ring.axis.copy(this.axis)
    this.ring.value = this.angle
    this.axisBtns.forEach((btn, k) => btn.classList.toggle('on', k === this.axisName))
    const c = this.centre.clone().applyMatrix4(this.ctx.viewport.workplane.clone().invert())
    this.centreText.textContent = `${fmt(c.x)}, ${fmt(c.y)}, ${fmt(c.z)}`
    this.ctx.viewport.requestRender()
  }

  private ok(): void {
    const ids = this.nodes.map((n) => n.id)
    const m = this.step()
    this.applying = true
    this.restore()
    if (this.copy) {
      const made = this.ctx.doc.duplicateTransformed(ids, m, this.count)
      this.ctx.status(`Made ${made.length} rotated cop${made.length === 1 ? 'y' : 'ies'}`, 'success')
    } else if (this.angle % 360 !== 0) {
      this.ctx.doc.transformWorld(ids, m, 'Rotate')
      this.ctx.status(`Rotated ${fmt(this.angle)}°`, 'success')
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
    const vp = this.ctx.viewport
    vp.scene.remove(this.ghosts, this.axisLine)
    this.axisLine.geometry.dispose()
    this.strip.remove()
    this.ctx.refreshRibbon()
    vp.requestRender()
  }
}
