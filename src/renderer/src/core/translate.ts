import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { ModuleContext } from './types'
import type { DocNode } from './document'
import { showCmdBar } from './cmdbar'
import { dotMaterial, pickAt, type Pick } from './picking'
import { BoxRubber, boxSelect } from './boxselect'
import { selection } from './selection'
import { datums } from './datums'
import { showSideLayout, type SideHandle } from './sidebar'
import { icons } from './icons'
import { el } from './toolpanel'

/**
 * Translate: move the selection, or make copies of it, from one point to another.
 *
 * It starts straight away. Click a point on the model (snaps to corners,
 * centres, midpoints, edges, faces) and the set follows the pointer; click
 * the point to move it to (another snap point, a datum origin, or anywhere on
 * the plane through the first point) and it is done, one undo step. With
 * nothing selected, the body you click first is what moves. Drag a box or
 * Shift+click to add more to the set first (Ctrl+box takes items out), so
 * parts, wireframes and surfaces all move together.
 *
 * The side toolbar holds the options, in the same shape as every movement
 * command: Single move / Multiple copies on top, Incremental below (typed
 * X / Y / Z in a flyout, with an on-screen drag handle), then the point mode:
 * normal points, or the midpoint of two clicks.
 */

type Mode = 'move' | 'copy'
type SnapMode = 'point' | 'mid'

/** Remembered between uses (this session). */
const prefs = { mode: 'move' as Mode, incremental: false, snap: 'point' as SnapMode, count: 1 }

let active: TranslateTool | null = null

export function openTranslate(ctx: ModuleContext): void {
  if (active) return active.focus()
  active = new TranslateTool(ctx)
}

const GHOST_MESH = new THREE.MeshBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide })
const GHOST_LINE = new THREE.LineBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.8 })
const POINT_PICK = { vertex: true, edge: true, face: true }
const SNAP_PX = 10

const fmt = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return String(Object.is(r, -0) ? 0 : r)
}

interface Spot {
  point: THREE.Vector3
  /** What it snapped to, for the prompt. */
  label: string
  /** The body it is on, if any. */
  id?: string
}

class TranslateTool {
  private nodes: DocNode[] = []
  private start: { n: DocNode; pos: THREE.Vector3 }[] = []
  private from: THREE.Vector3 | null = null
  /** First click of a midpoint pair, and the body it was on. */
  private half: THREE.Vector3 | null = null
  private halfId: string | undefined
  private delta = new THREE.Vector3()
  private hover: Spot | null = null
  private ghosts = new THREE.Group()
  private marks: THREE.Points
  private hoverMark: THREE.Points
  private line: THREE.Line
  private prompt: HTMLElement
  private side: SideHandle
  private bar: ReturnType<typeof showCmdBar>
  private inputs: HTMLInputElement[] = []
  private countBox: HTMLInputElement | null = null
  private controls: TransformControls | null = null
  private helper: THREE.Object3D | null = null
  private pivot = new THREE.Object3D()
  private center = new THREE.Vector3()
  private off: (() => void)[] = []
  private applying = false
  private down: { x: number; y: number; shift: boolean; ctrl: boolean } | null = null
  private rubber: BoxRubber | null = null
  private queued: PointerEvent | null = null
  /** Objects that follow the pointer (and so must not be hit by it). */
  private unpickable: THREE.Object3D[] = []

  constructor(private ctx: ModuleContext) {
    const vp = ctx.viewport
    // The set: bodies picked as faces / edges count as their bodies.
    const fromSubs = selection.items.map((p) => p.object.userData.docId as string | undefined).filter((id): id is string => !!id)
    if (fromSubs.length) {
      const ids = [...new Set([...ctx.doc.selection(), ...fromSubs])]
      selection.clear()
      ctx.doc.select(ids)
    }

    this.ghosts.name = '__translate-preview'
    this.marks = new THREE.Points(new THREE.BufferGeometry(), dotMaterial(0xff9f1c, 12))
    this.hoverMark = new THREE.Points(new THREE.BufferGeometry(), dotMaterial(0xfff1a8, 13))
    this.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xff9f1c, dashSize: 3, gapSize: 2, depthTest: false }))
    for (const o of [this.marks, this.hoverMark, this.line]) {
      o.renderOrder = 40
      o.frustumCulled = false
    }
    vp.scene.add(this.ghosts, this.marks, this.hoverMark, this.line, this.pivot)

    this.prompt = el('div', 'vp-prompt')
    vp.host.append(this.prompt)
    this.bar = showCmdBar(vp.host, { ok: () => this.ok(), cancel: () => this.cancel(), back: () => this.back() })
    this.side = showSideLayout(this.layout())

    const prevBlock = vp.blockPick
    // Plain selection stays out of the way: this tool reads the clicks itself.
    vp.blockPick = () => true
    this.off.push(() => (vp.blockPick = prevBlock))
    const canvas = vp.renderer.domElement
    const onDown = (e: PointerEvent): void => this.onDown(e)
    const onUp = (e: PointerEvent): void => this.onUp(e)
    const onMove = (e: PointerEvent): void => this.onMove(e)
    const onKey = (e: KeyboardEvent): void => this.onKey(e)
    // Capture phase: before the drag handle and plain selection.
    canvas.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey, true)
    })
    this.off.push(ctx.doc.on('selection', () => !this.applying && this.retarget()))
    // Anything else changing the document (undo, delete...) ends the tool.
    this.off.push(ctx.doc.history.on('changed', () => !this.applying && this.cancel()))
    this.off.push(vp.on('settings', () => this.controls && ((this.controls.camera = vp.camera), vp.requestRender())))

    this.retarget()
    this.syncOptions()
  }

  focus(): void {
    const box = this.inputs[0]
    if (box && prefs.incremental) {
      box.focus()
      box.select()
    }
  }

  // ---- side toolbar -------------------------------------------------------

  private layout(): Parameters<typeof showSideLayout>[0] {
    const set = (f: () => void) => () => {
      f()
      this.syncOptions()
    }
    return {
      title: 'Translate',
      rows: [
        [
          { icon: icons.moveSingle, label: 'Single move', hint: 'Move the set from one point to another', on: () => prefs.mode === 'move', run: set(() => (prefs.mode = 'move')) },
          { icon: icons.moveCopies, label: 'Multiple copies', hint: 'Leave the set where it is and make copies, each one a step further', on: () => prefs.mode === 'copy', run: set(() => (prefs.mode = 'copy')) }
        ],
        [{ icon: icons.incremental, label: 'Incremental', key: 'I', hint: 'Type X / Y / Z distances (or drag the handle) instead of moving on the second click', on: () => prefs.incremental, run: set(() => (prefs.incremental = !prefs.incremental)) }],
        [
          { icon: icons.snapPoint, label: 'Point', hint: 'Click points on the model: corners, centres, midpoints, edges, faces, datums', on: () => prefs.snap === 'point', run: set(() => (prefs.snap = 'point')) },
          { icon: icons.snapMid, label: 'Midpoint of two points', key: 'M', hint: 'Click two points; the point halfway between them is used', on: () => prefs.snap === 'mid', run: set(() => (prefs.snap = 'mid')) }
        ]
      ]
    }
  }

  /** After a toolbar option changes: flyout, handle, ghosts, prompt. */
  private syncOptions(): void {
    this.half = null
    this.side.refresh()
    this.side.flyout(prefs.incremental || prefs.mode === 'copy' ? this.buildFlyout() : null)
    this.setHandle(prefs.incremental)
    this.rebuildGhosts()
    this.preview()
    this.say()
  }

  private buildFlyout(): HTMLElement {
    const box = el('div')
    box.addEventListener('keydown', (e) => e.stopPropagation())
    box.append(el('div', 'fo-title', prefs.incremental ? 'Incremental' : 'Copies'))
    const grid = el('div', 'fo-grid')
    this.inputs = []
    if (prefs.incremental) {
      const { inv } = this.axes()
      const local = this.delta.clone().applyMatrix4(inv)
      ;(['X', 'Y', 'Z'] as const).forEach((axis, i) => {
        const input = el('input')
        input.type = 'number'
        input.step = '1'
        input.value = fmt(local.getComponent(i))
        input.title = `Distance along the active plane's ${axis} axis (mm)`
        input.addEventListener('focus', () => input.select())
        input.addEventListener('input', () => {
          const { rot, inv } = this.axes()
          const l = this.delta.clone().applyMatrix4(inv)
          const v = parseFloat(input.value)
          l.setComponent(i, Number.isFinite(v) ? v : 0)
          this.delta.copy(l.applyMatrix4(rot))
          this.preview(input)
        })
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            this.ok()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            this.cancel()
          }
        })
        this.inputs.push(input)
        grid.append(el('span', `ax ax-${axis.toLowerCase()}`, axis), input)
      })
    }
    this.countBox = null
    if (prefs.mode === 'copy') {
      const c = el('input')
      c.type = 'number'
      c.min = '1'
      c.max = '500'
      c.step = '1'
      c.value = String(prefs.count)
      c.title = 'Number of copies. Each copy is one step further along.'
      c.addEventListener('focus', () => c.select())
      c.addEventListener('input', () => {
        const v = Math.round(Number(c.value))
        prefs.count = Math.max(1, Math.min(500, Number.isFinite(v) ? v : 1))
        this.rebuildGhosts()
        this.preview()
      })
      c.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (prefs.incremental) this.ok()
          else c.blur()
        }
      })
      this.countBox = c
      grid.append(el('span', 'ax ax-n', 'N'), c)
    }
    box.append(grid)
    if (prefs.incremental) {
      const row = el('div', 'fo-row')
      const flip = el('button', 'btn')
      flip.innerHTML = `${icons.flip}<span>Reverse</span>`
      flip.title = 'Change direction: the same distance the other way'
      flip.addEventListener('click', () => {
        this.delta.negate()
        this.preview()
      })
      const apply = el('button', 'btn primary', 'Apply')
      apply.title = 'Move / copy by these distances (Enter)'
      apply.addEventListener('click', () => this.ok())
      row.append(flip, apply)
      box.append(row, el('div', 'fo-note', 'Two clicks on the model fill these in, then you can change them.'))
    }
    return box
  }

  /** Active workplane rotation: typed X / Y / Z are along its axes. */
  private axes(): { rot: THREE.Matrix4; inv: THREE.Matrix4 } {
    const rot = new THREE.Matrix4().extractRotation(this.ctx.viewport.workplane)
    return { rot, inv: rot.clone().transpose() }
  }

  /** The XYZ drag handle, in incremental mode (dragging changes the typed values). */
  private setHandle(on: boolean): void {
    const vp = this.ctx.viewport
    if (!on || !this.nodes.length) {
      if (this.controls) {
        this.controls.detach()
        this.controls.dispose()
        vp.scene.remove(this.helper!)
        this.controls = null
        this.helper = null
        vp.requestRender()
      }
      return
    }
    if (this.controls) return
    const controls = new TransformControls(vp.camera, vp.renderer.domElement)
    controls.setMode('translate')
    controls.setSpace('local')
    controls.size = 1.8
    this.pivot.quaternion.setFromRotationMatrix(this.axes().rot)
    this.pivot.position.copy(this.center).add(this.delta)
    controls.attach(this.pivot)
    const helper = controls.getHelper()
    helper.traverse((o) => {
      o.renderOrder = 30
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      for (const x of m ? (Array.isArray(m) ? m : [m]) : []) {
        x.depthTest = false
        x.depthWrite = false
      }
    })
    vp.scene.add(helper)
    let snap = 1
    controls.addEventListener('change', () => vp.requestRender())
    controls.addEventListener('mouseDown', () => (snap = this.snapStep()))
    controls.addEventListener('objectChange', () => {
      const d = this.pivot.position.clone().sub(this.center)
      const r = (v: number): number => +fmt(Math.round(v / snap) * snap)
      this.delta.set(r(d.x), r(d.y), r(d.z))
      this.preview()
    })
    this.controls = controls
    this.helper = helper
  }

  /** A round drag step that suits the zoom (1, 2, 5, 10... mm). */
  private snapStep(): number {
    const vp = this.ctx.viewport
    const cam = vp.camera as THREE.OrthographicCamera & THREE.PerspectiveCamera
    const h = cam.isOrthographicCamera ? (cam.top - cam.bottom) / cam.zoom : 2 * vp.nav.pose.dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))
    const raw = h / 150
    const p = Math.pow(10, Math.floor(Math.log10(raw)))
    const m = raw / p
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
  }

  // ---- the set --------------------------------------------------------------

  /** (Re)start on the current selection, keeping any typed values. */
  private retarget(): void {
    this.restore()
    this.setUnpickable(false)
    this.nodes = this.ctx.doc.selectedTopNodes()
    this.start = this.nodes.map((n) => ({ n, pos: n.object.position.clone() }))
    this.ctx.doc.root.updateMatrixWorld(true)
    if (this.nodes.length) this.ctx.doc.bounds(this.nodes).getCenter(this.center)
    if (!this.nodes.length) this.from = null
    if (this.controls && !this.nodes.length) this.setHandle(false)
    else if (!this.controls && prefs.incremental) this.setHandle(true)
    this.rebuildGhosts()
    this.preview()
    this.say()
  }

  private body(e: { clientX: number; clientY: number }): string | null {
    const vp = this.ctx.viewport
    const hit = vp.hitTest(vp.ndcOf(e))
    return (hit?.object.userData.docId as string | undefined) ?? null
  }

  // ---- pointer --------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return
    // Let the drag handle have its own arrows.
    if (this.controls && this.controls.axis !== null) return
    this.down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey }
    e.stopImmediatePropagation()
  }

  private onMove(e: PointerEvent): void {
    if (this.down && e.buttons & 1) {
      if (!this.rubber && BoxRubber.isDrag(e.clientX - this.down.x, e.clientY - this.down.y)) this.rubber = new BoxRubber(this.ctx.viewport, this.down.x, this.down.y)
      this.rubber?.update(e.clientX, e.clientY)
      return
    }
    if (e.target !== this.ctx.viewport.renderer.domElement) return
    const first = !this.queued
    this.queued = e
    if (first) requestAnimationFrame(() => this.hoverAt())
  }

  private onUp(e: PointerEvent): void {
    if (e.button !== 0 || !this.down) return
    const d = this.down
    this.down = null
    e.stopImmediatePropagation()
    if (this.rubber) {
      const { rect, crossing } = this.rubber.rect(e.clientX, e.clientY)
      this.rubber.dispose()
      this.rubber = null
      const got = boxSelect(this.ctx.viewport, this.ctx.doc, rect, crossing, { vertex: false, edge: false, face: false, surface: true, body: true })
      const have = this.ctx.doc.selection()
      // Building the set: a box adds to it, Ctrl+box takes out.
      this.ctx.doc.select(d.ctrl ? have.filter((id) => !got.bodies.includes(id)) : [...new Set([...have, ...got.bodies])])
      return
    }
    if (d.shift) {
      const id = this.body(e)
      if (id) this.ctx.doc.select([id], true)
      return
    }
    this.click(e)
  }

  private click(e: PointerEvent): void {
    const spot = this.spotAt(e)
    if (!spot) return
    let p = spot.point
    if (prefs.snap === 'mid') {
      if (!this.half) {
        this.half = p.clone()
        this.halfId = spot.id
        this.drawMarks()
        return this.say()
      }
      p = this.half.add(p).multiplyScalar(0.5)
      spot.id = this.halfId ?? spot.id
      this.half = null
    }
    if (!this.from) {
      // Nothing chosen yet: the body clicked is what moves.
      if (!this.nodes.length) {
        const id = spot.id ?? this.body(e)
        if (!id) return this.ctx.status('Click a point on the part to move, or select what to move first', 'warn')
        this.applying = true
        this.ctx.doc.select([id])
        this.applying = false
        this.retarget()
      }
      this.from = p.clone()
      this.setUnpickable(prefs.mode === 'move')
      this.drawMarks()
      this.say()
      return
    }
    this.delta.copy(p).sub(this.from)
    if (prefs.incremental) {
      // The two clicks fill the boxes; OK / Enter applies.
      this.from = null
      this.setUnpickable(false)
      this.preview()
      this.drawMarks()
      this.say()
      this.focus()
      return
    }
    this.ok()
  }

  private hoverAt(): void {
    const e = this.queued
    this.queued = null
    if (!e || this.rubber) return
    this.hover = this.spotAt(e)
    if (this.from && !prefs.incremental && !this.half) {
      this.delta.copy(this.hover?.point ?? this.from).sub(this.from)
      this.preview()
    }
    this.drawMarks()
    this.say()
  }

  /** Where a click here would land: a datum origin, a snap point on the model, or the plane through the first point. */
  private spotAt(e: { clientX: number; clientY: number }): Spot | null {
    const vp = this.ctx.viewport
    const rect = vp.renderer.domElement.getBoundingClientRect()
    const mouse = new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top)
    let best: Spot | null = null
    let bestD = SNAP_PX
    for (const d of datums.list()) {
      const o = new THREE.Vector3().setFromMatrixPosition(d.matrix)
      const dist = vp.toScreen(o).distanceTo(mouse)
      if (dist < bestD) {
        bestD = dist
        best = { point: o, label: d.id === 'world' ? 'datum (Absolute origin)' : `datum ${d.name}` }
      }
    }
    if (best) return best
    const pick = pickAt(vp, e, POINT_PICK)
    if (pick) return { point: pick.point.clone(), label: labelOf(pick), id: pick.object.userData.docId as string | undefined }
    // Off the model: anywhere on the plane through the first point, square to the work plane.
    const anchor = this.half ?? this.from
    if (!anchor) return null
    const n = new THREE.Vector3(0, 0, 1).applyMatrix4(this.axes().rot)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(vp.ndcOf(e), vp.camera)
    const hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, anchor), new THREE.Vector3())
    return hit ? { point: hit, label: 'free, on the plane' } : null
  }

  /** While the set follows the pointer, the pointer must see through it. */
  private setUnpickable(on: boolean): void {
    for (const o of this.unpickable) delete (o as { raycast?: unknown }).raycast
    this.unpickable = []
    if (!on) return
    for (const n of this.nodes)
      n.object.traverse((o) => {
        o.raycast = () => {}
        this.unpickable.push(o)
      })
  }

  // ---- keys -----------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    if (e.key === 'Escape') this.cancel()
    else if (e.key === 'Enter' && !typing) this.ok()
    else if (e.key === 'Backspace' && !typing) this.back()
    else if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'm') {
      prefs.snap = prefs.snap === 'mid' ? 'point' : 'mid'
      this.syncOptions()
    } else if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'i') {
      prefs.incremental = !prefs.incremental
      this.syncOptions()
      this.focus()
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  // ---- drawing ----------------------------------------------------------------

  private say(): void {
    const n = this.nodes.length
    const what = n === 0 ? '' : n === 1 ? this.nodes[0].name : `${n} items`
    const mid = prefs.snap === 'mid' ? (this.half ? ', second point of the pair' : ', first point of a pair (midpoint)') : ''
    let step: string
    if (!n) step = `click a point on the part to move${mid}, or drag a box around what to move`
    else if (!this.from && prefs.incremental) step = `type X / Y / Z or drag the handle, then Enter · or click two points${mid} to fill them in`
    else if (!this.from) step = `click the point to move ${prefs.mode === 'copy' ? 'copies ' : ''}from${mid} · box or Shift+click to add, Ctrl+box to take out`
    else step = `click where to ${prefs.mode === 'copy' ? 'copy' : 'move'} it to${mid}`
    const main = el('span')
    main.append(el('b', '', what ? `Translate ${what}` : 'Translate'), document.createTextNode(`: ${step}`))
    const parts: HTMLElement[] = [main]
    if (this.hover) parts.push(el('span', 'vp-prompt-note', `→ ${this.hover.label}`))
    if (this.delta.lengthSq() > 0) {
      const l = this.delta.clone().applyMatrix4(this.axes().inv)
      parts.push(el('span', 'vp-prompt-note', `${fmt(l.x)}, ${fmt(l.y)}, ${fmt(l.z)} mm`))
    }
    parts.push(el('span', 'vp-prompt-esc', 'Esc to cancel'))
    this.prompt.replaceChildren(...parts)
    this.bar.update({ ok: () => this.ok(), back: () => this.back() })
  }

  private drawMarks(): void {
    const fixed = [this.from, this.half].filter((p): p is THREE.Vector3 => !!p)
    this.marks.geometry.dispose()
    this.marks.geometry = new THREE.BufferGeometry().setFromPoints(fixed)
    this.hoverMark.geometry.dispose()
    this.hoverMark.geometry = new THREE.BufferGeometry().setFromPoints(this.hover ? [this.hover.point] : [])
    const a = this.half ?? this.from
    this.line.geometry.dispose()
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(a && this.hover ? [a, this.hover.point] : [])
    this.line.computeLineDistances()
    this.ctx.viewport.requestRender()
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
    if (prefs.mode !== 'copy') return
    this.restore()
    this.ctx.doc.root.updateMatrixWorld(true)
    for (let k = 1; k <= prefs.count; k++)
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

  private preview(typing?: HTMLInputElement): void {
    if (prefs.mode === 'copy') {
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
        const pw = parent?.matrixWorld ?? new THREE.Matrix4()
        const a = new THREE.Vector3().applyMatrix4(pw).applyMatrix4(inv)
        const b = new THREE.Vector3().applyMatrix4(pw).add(this.delta).applyMatrix4(inv)
        s.n.object.position.copy(s.pos).add(b.sub(a))
        s.n.object.updateMatrixWorld(true)
      }
    }
    if (this.controls && !this.controls.dragging) this.pivot.position.copy(this.center).add(this.delta)
    const local = this.delta.clone().applyMatrix4(this.axes().inv)
    this.inputs.forEach((input, i) => {
      if (input !== typing) input.value = fmt(local.getComponent(i))
    })
    this.ctx.viewport.requestRender()
  }

  // ---- finish -------------------------------------------------------------------

  /** Back a step: the half-picked midpoint, then the from point. */
  private back(): void {
    if (this.half) this.half = null
    else if (this.from) {
      this.from = null
      this.setUnpickable(false)
      if (!prefs.incremental) this.delta.set(0, 0, 0)
    } else return this.cancel()
    this.preview()
    this.drawMarks()
    this.say()
  }

  private ok(): void {
    if (!this.nodes.length) return this.cancel()
    const ids = this.nodes.map((n) => n.id)
    const delta = this.delta.clone()
    this.applying = true
    this.restore()
    if (delta.lengthSq() === 0) {
      this.ctx.status('Nothing moved: the two points are the same', 'warn')
    } else if (prefs.mode === 'copy') {
      const made = this.ctx.doc.duplicate(ids, delta, prefs.count)
      this.ctx.status(`Made ${made.length} cop${made.length === 1 ? 'y' : 'ies'}`, 'success')
    } else {
      this.ctx.doc.translate(ids, delta)
      this.ctx.status(`Moved ${ids.length === 1 ? this.nodes[0].name : `${ids.length} items`} ${fmt(delta.x)}, ${fmt(delta.y)}, ${fmt(delta.z)} mm`, 'success')
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
    this.setUnpickable(false)
    this.rubber?.dispose()
    this.off.forEach((f) => f())
    this.setHandle(false)
    const vp = this.ctx.viewport
    vp.scene.remove(this.ghosts, this.marks, this.hoverMark, this.line, this.pivot)
    for (const o of [this.marks, this.hoverMark, this.line]) o.geometry.dispose()
    this.prompt.remove()
    this.bar.dispose()
    this.side.dispose()
    this.ctx.refreshRibbon()
    vp.requestRender()
  }
}

function labelOf(p: Pick): string {
  if (p.kind === 'point') return p.snap === 'centre' ? 'centre' : p.snap === 'quadrant' ? 'quadrant' : p.snap === 'mid' ? 'midpoint' : 'corner'
  if (p.kind === 'vertex') return 'corner'
  if (p.kind === 'edge') return 'on edge'
  if (p.kind === 'face') return 'on face'
  return 'on body'
}
