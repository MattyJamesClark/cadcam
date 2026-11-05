import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { ModuleContext } from './types'
import type { WorkPlane } from './document'
import { datums } from './datums'
import { icons } from './icons'
import { measureCad } from './occt'
import { Highlights, pickAt, pickKey, rowMajor, type Pick } from './picking'
import { addBottomButton } from './bottombar'
import { isPickingPoints, pickPoints } from './pointpick'
import { el, fmt, toolPanel } from './toolpanel'

/**
 * Work planes, the VISI way: one plane is active at a time (Absolute by
 * default) and the grid, axes, X/Y/Z readout and standard views follow it.
 * Planes are made from 3 points, a flat face (origin at its bottom-left
 * corner) or an origin point, and moved / rotated from a strip at the bottom
 * of the view: point to point, to a midpoint, or typed incremental values in
 * the plane's own axes. Listed in the Planes manager (bottom bar), saved in
 * the project, and usable as datums by measuring tools.
 */

const COLOR = 0x60a5fa
const AXES = [0xef4444, 0x22c55e, 0x3b82f6]

let mgr: PlaneManager | null = null
export function startPlanes(ctx: ModuleContext): void {
  if (mgr) return
  mgr = new PlaneManager(ctx)
  const btn = addBottomButton(icons.planes, 'Planes: create, move and rotate work planes', () => mgr!.toggle())
  mgr.button = btn
  const tag = el('span', 'vb-wp')
  tag.title = 'Active workplane (open Planes to change it)'
  tag.addEventListener('click', () => mgr!.toggle())
  btn.after(tag)
  mgr.tag = tag
  mgr.syncActive()
}

const toMatrix = (m: number[]): THREE.Matrix4 => new THREE.Matrix4().fromArray(m)

class PlaneManager {
  button: HTMLButtonElement | null = null
  tag: HTMLElement | null = null
  /** Active workplane id; null = Absolute. */
  active: string | null = null
  private group = new THREE.Group()
  private labels = new Map<string, HTMLElement>()
  private panel: HTMLElement | null = null
  private list: HTMLElement | null = null
  private tool: { close(): void } | null = null

  constructor(private ctx: ModuleContext) {
    this.group.name = '__planes'
    ctx.viewport.scene.add(this.group)
    ctx.doc.on('planes', () => this.changed())
    ctx.doc.on('changed', () => this.redraw())
    ctx.viewport.afterRender.add(() => this.placeLabels())
    this.changed()
  }

  private changed(): void {
    if (this.active && !this.ctx.doc.planes.some((p) => p.id === this.active)) this.active = null
    this.syncActive()
    datums.setUser(this.ctx.doc.planes.map((p) => ({ id: p.id, name: p.name, matrix: toMatrix(p.matrix) })))
    this.redraw()
    this.renderList()
  }

  setActive(id: string | null): void {
    this.active = id
    this.syncActive()
    this.redraw()
    this.renderList()
  }

  /** Push the active plane to the view (grid, axes, readout, views) and the bottom-bar tag. */
  syncActive(): void {
    const p = this.ctx.doc.planes.find((x) => x.id === this.active)
    this.ctx.viewport.setWorkplane(p ? toMatrix(p.matrix) : new THREE.Matrix4())
    if (this.tag) this.tag.textContent = p ? p.name : 'Absolute'
  }

  /** Plane drawing size: a share of the model, so it reads at any scale. */
  private size(): number {
    const b = this.ctx.doc.bounds()
    const d = b.isEmpty() ? 100 : b.getSize(new THREE.Vector3()).length()
    return Math.max(20, d * 0.25)
  }

  redraw(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      ;(m.material as THREE.Material | undefined)?.dispose?.()
    })
    this.group.clear()
    const s = this.size()
    const keep = new Set<string>()
    for (const p of this.ctx.doc.planes) {
      if (!p.visible) continue
      keep.add(p.id)
      this.group.add(drawPlane(toMatrix(p.matrix), s, p.id === this.active))
      let lab = this.labels.get(p.id)
      if (!lab) {
        lab = el('div', 'plane-tag')
        this.ctx.viewport.host.append(lab)
        this.labels.set(p.id, lab)
      }
      lab.textContent = p.name
    }
    for (const [id, l] of this.labels)
      if (!keep.has(id)) {
        l.remove()
        this.labels.delete(id)
      }
    this.ctx.viewport.requestRender()
  }

  private placeLabels(): void {
    const s = this.size()
    for (const p of this.ctx.doc.planes) {
      const l = this.labels.get(p.id)
      if (!l) continue
      const at = new THREE.Vector3(s / 2, s / 2, 0).applyMatrix4(toMatrix(p.matrix))
      const q = this.ctx.viewport.toScreen(at)
      l.style.left = `${q.x}px`
      l.style.top = `${q.y}px`
    }
  }

  toggle(): void {
    if (this.panel) return this.closePanel()
    const { panel, body } = toolPanel('Planes', () => this.closePanel())
    panel.classList.add('planes-panel')
    const add = el('div', 'plane-add')
    const make = (label: string, title: string, fn: () => void): void => {
      const b = el('button', 'btn', label)
      b.title = title
      b.addEventListener('click', fn)
      add.append(b)
    }
    make('3 points', 'New plane: click the origin, a point along X, then a point in the plane', () => this.startTool(new ThreePointTool(this.ctx)))
    make('Face', 'New plane on a flat face, origin at its bottom-left corner', () => this.startTool(new FaceTool(this.ctx)))
    make('Origin', 'New plane at a clicked point, lined up with the active plane', () => this.startTool(new OriginTool(this.ctx)))
    this.list = el('div', 'plane-list')
    body.append(add, this.list, el('div', 'tool-empty plane-hint', 'Click a plane to make it active.'))
    this.ctx.viewport.host.append(panel)
    this.panel = panel
    this.button?.classList.add('narrowed')
    this.renderList()
  }

  private closePanel(): void {
    this.tool?.close()
    this.panel?.remove()
    this.panel = this.list = null
    this.button?.classList.remove('narrowed')
  }

  private startTool(t: { close(): void; onDone?: () => void }): void {
    this.tool?.close()
    this.tool = t
    t.onDone = () => {
      if (this.tool === t) this.tool = null
    }
  }

  private renderList(): void {
    const list = this.list
    if (!list) return
    list.replaceChildren()
    const activeRow = (id: string | null, row: HTMLElement): void => {
      row.classList.toggle('active', id === this.active)
      const dot = el('span', 'plane-dot')
      row.prepend(dot)
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return
        this.setActive(id)
      })
    }
    const world = el('div', 'plane-row fixed')
    world.append(el('span', 'plane-name', 'Absolute'))
    world.title = 'The absolute origin and XY plane'
    activeRow(null, world)
    list.append(world)
    for (const p of this.ctx.doc.planes) {
      const row = el('div', 'plane-row')
      activeRow(p.id, row)
      const name = el('span', 'plane-name', p.name)
      name.title = 'Double-click to rename'
      name.addEventListener('dblclick', () => {
        const n = prompt('Plane name', p.name)?.trim()
        if (n && n !== p.name) this.ctx.doc.updatePlane(p.id, { name: n }, 'Rename plane')
      })
      const btn = (icon: string, title: string, fn: () => void): HTMLButtonElement => {
        const b = el('button', 'icon-btn plane-btn')
        b.innerHTML = icon
        b.title = title
        b.addEventListener('click', fn)
        return b
      }
      row.append(
        name,
        btn(p.visible ? icons.eye : icons.eyeOff, p.visible ? 'Hide' : 'Show', () =>
          this.ctx.doc.updatePlane(p.id, { visible: !p.visible }, p.visible ? 'Hide plane' : 'Show plane')
        ),
        btn(icons.move, 'Move / rotate', () => {
          this.setActive(p.id)
          this.startTool(new EditTool(this.ctx, p))
        }),
        btn(icons.trash, 'Delete', () => this.ctx.doc.removePlane(p.id))
      )
      list.append(row)
    }
    if (!this.ctx.doc.planes.length) list.append(el('div', 'tool-empty', 'No planes yet. Make one from 3 points or a flat face.'))
  }
}

/** A square with a light fill, its outline and X / Y / Z axes from the origin. */
function drawPlane(m: THREE.Matrix4, s: number, active = false): THREE.Object3D {
  const g = new THREE.Group()
  g.matrixAutoUpdate = false
  g.matrix.copy(m)
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(s, s).translate(s / 2, s / 2, 0),
    new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: active ? 0.2 : 0.1, side: THREE.DoubleSide, depthWrite: false })
  )
  const edge = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, s, 0, 0, s, 0, 0, s, s, 0, s, s, 0, 0, s, 0, 0, s, 0, 0, 0, 0], 3)),
    new THREE.LineBasicMaterial({ color: active ? 0xfbbf24 : COLOR, transparent: true, opacity: 0.9 })
  )
  g.add(fill, edge)
  const a = s * 0.3
  ;[new THREE.Vector3(a, 0, 0), new THREE.Vector3(0, a, 0), new THREE.Vector3(0, 0, a)].forEach((v, i) => {
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v]),
      new THREE.LineBasicMaterial({ color: AXES[i], depthTest: false })
    )
    l.renderOrder = 9
    g.add(l)
  })
  g.renderOrder = 7
  return g
}

/** Frame from an origin and X / Z directions. */
function frame(origin: THREE.Vector3, x: THREE.Vector3, z: THREE.Vector3): THREE.Matrix4 {
  const X = x.clone().normalize()
  const Z = z.clone().sub(X.clone().multiplyScalar(z.dot(X))).normalize()
  const Y = new THREE.Vector3().crossVectors(Z, X)
  return new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(origin)
}

const nextName = (ctx: ModuleContext): string => {
  let i = ctx.doc.planes.length + 1
  while (ctx.doc.planes.some((p) => p.name === `Plane ${i}`)) i++
  return `Plane ${i}`
}

/** Add a plane and make it the active one (as VISI does). */
function newPlane(ctx: ModuleContext, m: THREE.Matrix4): void {
  const p = ctx.doc.addPlane({ name: nextName(ctx), matrix: m.toArray(), visible: true })
  mgr?.setActive(p.id)
}

/** Shared picking with a bottom prompt; Esc closes. */
abstract class PickTool {
  onDone?: () => void
  protected picks: Pick[] = []
  protected hover: Pick | null = null
  protected hl: Highlights
  protected prompt = el('div', 'vp-prompt')
  private off: (() => void)[] = []
  protected abstract filter: { vertex?: boolean; edge?: boolean; face?: boolean }

  constructor(protected ctx: ModuleContext) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    vp.host.append(this.prompt)
    vp.blockPick = () => true
    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    let queued: PointerEvent | null = null
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const p = pickAt(vp, e, this.filter)
      if (p) void this.pick(p)
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (first)
        requestAnimationFrame(() => {
          const ev = queued!
          queued = null
          const h = ev.buttons ? null : pickAt(vp, ev, this.filter)
          if ((h && pickKey(h)) !== (this.hover && pickKey(this.hover))) {
            this.hover = h
            this.draw()
          }
        })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      this.close()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey, true)
    })
  }

  protected say(title: string, step: string, note?: string): void {
    const main = el('span')
    main.append(el('b', '', title), document.createTextNode(`: ${step}`))
    this.prompt.replaceChildren(main)
    if (note) this.prompt.append(el('span', 'vp-prompt-note', note))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Esc to cancel'))
  }

  protected draw(): void {
    const list = this.picks.map((pick) => ({ pick, color: 0xff9f1c }))
    if (this.hover && !this.picks.some((p) => pickKey(p) === pickKey(this.hover!))) list.push({ pick: this.hover, color: 0xfff1a8 })
    this.hl.set(list)
  }

  protected abstract pick(p: Pick): Promise<void>

  close(): void {
    this.off.forEach((f) => f())
    this.off = []
    this.hl.dispose()
    this.prompt.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.viewport.requestRender()
    this.onDone?.()
  }
}

class ThreePointTool extends PickTool {
  protected filter = { vertex: true, edge: true, face: true }
  private steps = ['select the origin', 'select a point along X', 'select a point in the plane (sets Y)']

  constructor(ctx: ModuleContext) {
    super(ctx)
    this.say('Plane by 3 points', this.steps[0])
  }

  protected async pick(p: Pick): Promise<void> {
    this.picks.push(p)
    this.draw()
    if (this.picks.length < 3) return this.say('Plane by 3 points', this.steps[this.picks.length])
    const [o, a, b] = this.picks.map((x) => x.point.clone())
    const x = a.clone().sub(o)
    const z = new THREE.Vector3().crossVectors(x, b.clone().sub(o))
    if (x.lengthSq() < 1e-12 || z.lengthSq() < 1e-12) {
      this.picks = []
      this.draw()
      return this.say('Plane by 3 points', this.steps[0], 'Those points are in a line: try again.')
    }
    const m = frame(o, x, z)
    newPlane(this.ctx, m)
    this.close()
  }
}

class FaceTool extends PickTool {
  protected filter = { face: true }

  constructor(ctx: ModuleContext) {
    super(ctx)
    this.say('Plane on face', 'select a flat face')
  }

  protected async pick(p: Pick): Promise<void> {
    const geo = (p.object as THREE.Mesh).geometry
    p.object.updateMatrixWorld()
    // Face normal: exact from the kernel, else from the triangle hit.
    let n: THREE.Vector3 | null = null
    if (geo.userData.brep) {
      try {
        const r = await measureCad([{ brep: geo.userData.brep as Uint8Array, kind: 'face', index: p.index, matrix: rowMajor(p.object.matrixWorld) }])
        const d = r.items[0]
        if (d.surface !== 'Plane') return this.say('Plane on face', 'select a flat face', 'That face is curved.')
        n = new THREE.Vector3(...(d.normal as [number, number, number]))
      } catch {
        n = null
      }
    }
    const pts = facePoints(p)
    if (!n) {
      if (pts.length < 3) return
      n = new THREE.Vector3().crossVectors(pts[1].clone().sub(pts[0]), pts[2].clone().sub(pts[0])).normalize()
    }
    // X along world X (or Y when the face looks along X), Y = Z × X.
    const ref = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const m0 = frame(new THREE.Vector3(), ref.sub(n.clone().multiplyScalar(ref.dot(n))), n)
    const inv = m0.clone().invert()
    // Bottom-left corner: the face's lowest X and Y in that frame, on the face.
    let minX = Infinity
    let minY = Infinity
    let z = 0
    for (const q of pts) {
      const l = q.clone().applyMatrix4(inv)
      minX = Math.min(minX, l.x)
      minY = Math.min(minY, l.y)
      z = l.z
    }
    if (!isFinite(minX)) return
    const origin = new THREE.Vector3(minX, minY, z).applyMatrix4(m0)
    const m = m0.clone().setPosition(origin)
    newPlane(this.ctx, m)
    this.close()
  }
}

/** New plane at a clicked point, with the active plane's orientation. */
class OriginTool extends PickTool {
  protected filter = { vertex: true, edge: true, face: true }

  constructor(ctx: ModuleContext) {
    super(ctx)
    this.say('Plane at origin', 'select the new origin')
  }

  protected async pick(p: Pick): Promise<void> {
    const m = this.ctx.viewport.workplane.clone().setPosition(p.point)
    newPlane(this.ctx, m)
    this.close()
  }
}

/** World positions of the triangles of the picked face. */
function facePoints(p: Pick): THREE.Vector3[] {
  const geo = (p.object as THREE.Mesh).geometry as THREE.BufferGeometry
  const tri = geo.userData.triFace as Int32Array | undefined
  const pos = geo.getAttribute('position')
  const idx = geo.index
  const out: THREE.Vector3[] = []
  const m = p.object.matrixWorld
  const count = (idx ? idx.count : pos.count) / 3
  for (let t = 0; t < count; t++) {
    if (tri && tri[t] !== p.index) continue
    if (!tri && p.kind === 'face') continue
    for (let k = 0; k < 3; k++) out.push(new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(t * 3 + k) : t * 3 + k).applyMatrix4(m))
  }
  return out
}

/**
 * Move / rotate a plane from a strip at the bottom of the view (no side
 * panel): drag the handle, click point to point or to a midpoint, or type
 * incremental moves / turns in the plane's own axes (Enter applies).
 * Enter with nothing typed = OK, Esc = cancel.
 */
class EditTool {
  onDone?: () => void
  private proxy = new THREE.Object3D()
  private controls: TransformControls
  private helper: THREE.Object3D
  private strip: HTMLElement
  private readout = el('span', 'vs-readout')
  private off: (() => void)[] = []
  private start: THREE.Matrix4
  private preview: THREE.Object3D | null = null

  constructor(
    private ctx: ModuleContext,
    private plane: WorkPlane
  ) {
    const vp = ctx.viewport
    this.start = toMatrix(plane.matrix)
    this.start.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale)
    vp.scene.add(this.proxy)
    this.controls = new TransformControls(vp.camera, vp.renderer.domElement)
    this.controls.setSpace('local')
    this.controls.setRotationSnap(THREE.MathUtils.degToRad(5))
    this.controls.attach(this.proxy)
    this.helper = this.controls.getHelper()
    vp.scene.add(this.helper)
    this.controls.addEventListener('change', () => vp.requestRender())
    this.controls.addEventListener('objectChange', () => this.update())
    vp.blockPick = () => this.controls.axis !== null || this.controls.dragging

    const strip = el('div', 'vp-strip')
    this.strip = strip
    strip.append(el('b', 'vs-title', plane.name))

    const icon = (svg: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = el('button', 'icon-btn vs-btn')
      b.innerHTML = svg
      b.title = title
      b.addEventListener('click', fn)
      return b
    }
    // Handle mode: drag to move or to turn.
    const mMove = icon(icons.move, 'Drag handle: move', () => setMode('translate'))
    const mRot = icon(icons.rotate, 'Drag handle: rotate', () => setMode('rotate'))
    const setMode = (m: 'translate' | 'rotate'): void => {
      this.controls.setMode(m)
      mMove.classList.toggle('on', m === 'translate')
      mRot.classList.toggle('on', m === 'rotate')
    }
    setMode('translate')
    const pick = async (title: string, steps: string[], delta: (p: THREE.Vector3[]) => THREE.Vector3): Promise<void> => {
      strip.classList.add('hidden')
      const p = await pickPoints(ctx, title, steps)
      strip.classList.remove('hidden')
      if (!p) return
      this.proxy.position.add(delta(p))
      this.update()
    }
    const p2p = el('button', 'btn vs-text', 'Point to point')
    p2p.title = 'Click the point to move from, then the point to move to'
    p2p.addEventListener('click', () => void pick('Point to point', ['select the point to move from', 'select the point to move to'], (p) => p[1].sub(p[0])))
    const mid = el('button', 'btn vs-text', 'Midpoint')
    mid.title = 'Click the point to move from, then two points: it moves to halfway between them'
    mid.addEventListener('click', () =>
      void pick('Midpoint', ['select the point to move from', 'select the first point', 'select the second point'], (p) => p[1].add(p[2]).multiplyScalar(0.5).sub(p[0]))
    )
    const org = el('button', 'btn vs-text', 'Origin to point')
    org.title = "Click a point: the plane's origin moves there"
    org.addEventListener('click', () => void pick('Origin to point', ['select the new origin'], (p) => p[0].sub(this.proxy.position)))

    // Incremental, in the plane's own axes.
    const field = (label: string, cls: string, title: string, apply: (v: number) => void): HTMLElement => {
      const wrap = el('label', `vs-field ${cls}`)
      const input = el('input')
      input.type = 'number'
      input.placeholder = '0'
      input.title = title
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.stopPropagation()
        e.preventDefault()
        const v = parseFloat(input.value)
        input.value = ''
        if (!Number.isFinite(v) || !v) return this.ok()
        apply(v)
        this.update()
      })
      wrap.append(el('span', '', label), input)
      return wrap
    }
    const axis = (i: number): THREE.Vector3 => new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
    const inc = el('div', 'vs-group')
    inc.append(el('span', 'vs-label', 'Move'))
    ;['X', 'Y', 'Z'].forEach((a, i) =>
      inc.append(
        field(a, `axis-${a.toLowerCase()}`, `Move along the plane's ${a} axis by this much (Enter)`, (v) =>
          this.proxy.position.add(axis(i).applyQuaternion(this.proxy.quaternion).multiplyScalar(v))
        )
      )
    )
    const rot = el('div', 'vs-group')
    rot.append(el('span', 'vs-label', 'Turn °'))
    ;['X', 'Y', 'Z'].forEach((a, i) =>
      rot.append(
        field(a, `axis-${a.toLowerCase()}`, `Turn about the plane's ${a} axis by this many degrees (Enter)`, (v) =>
          this.proxy.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis(i), THREE.MathUtils.degToRad(v)))
        )
      )
    )
    const reset = icon(icons.selPrev, 'Undo these changes (back to where it started)', () => {
      this.start.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale)
      this.update()
    })
    const ok = el('button', 'btn primary vs-text', 'OK')
    ok.addEventListener('click', () => this.ok())
    const cancel = el('button', 'btn vs-text', 'Cancel')
    cancel.addEventListener('click', () => this.cancel())
    const sep = (): HTMLElement => el('span', 'vs-sep')
    strip.append(mMove, mRot, sep(), p2p, mid, org, sep(), inc, rot, sep(), this.readout, reset, cancel, ok)
    vp.host.append(strip)

    const onKey = (e: KeyboardEvent): void => {
      if (isPickingPoints()) return
      if ((e.target as HTMLElement).closest?.('input')) {
        if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
        else return
      } else if (e.key === 'Escape') this.cancel()
      else if (e.key === 'Enter') this.ok()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => window.removeEventListener('keydown', onKey, true))
    this.update()
  }

  private matrix(): THREE.Matrix4 {
    this.proxy.updateMatrix()
    return this.proxy.matrix.clone()
  }

  private update(): void {
    const p = this.proxy.position
    this.readout.textContent = `Origin ${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}`
    if (this.preview) {
      this.ctx.viewport.scene.remove(this.preview)
      this.preview.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    }
    const b = this.ctx.doc.bounds()
    const s = Math.max(20, (b.isEmpty() ? 100 : b.getSize(new THREE.Vector3()).length()) * 0.25)
    this.preview = drawPlane(this.matrix(), s, true)
    this.ctx.viewport.scene.add(this.preview)
    this.ctx.viewport.requestRender()
  }

  private ok(): void {
    const m = this.matrix()
    const changed = !m.equals(this.start)
    const id = this.plane.id
    this.close()
    if (changed) this.ctx.doc.updatePlane(id, { matrix: m.toArray() }, 'Move plane')
  }

  private cancel(): void {
    this.close()
  }

  close(): void {
    this.off.forEach((f) => f())
    this.off = []
    this.controls.detach()
    this.controls.dispose()
    const vp = this.ctx.viewport
    vp.scene.remove(this.helper, this.proxy)
    if (this.preview) vp.scene.remove(this.preview)
    this.strip.remove()
    vp.blockPick = null
    vp.requestRender()
    this.onDone?.()
  }
}
