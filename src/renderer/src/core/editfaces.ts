import * as THREE from 'three'
import type { ModuleContext } from './types'
import { editFacesCad, solidsGeometry } from './occt'
import { Highlights, pickAt, pickKey, type Pick } from './picking'
import { selection } from './selection'
import { showCmdBar } from './cmdbar'
import { el, fmt } from './toolpanel'
import { Handles, type ArrowSpec } from './handles'

/**
 * Edit faces: push / pull faces of a solid by a typed distance along their
 * normals (positive = out, adds material; negative = in, removes it). Starts
 * with the faces already selected (or the one right-clicked); click faces of
 * the same body to add / remove them. The result previews live; the tick
 * applies it as one undo step.
 */

let active: EditFacesTool | null = null
export const isEditingFaces = (): boolean => active !== null

export function openEditFaces(ctx: ModuleContext, start: Pick[] = []): void {
  if (active) return
  const faces = (start.length ? start : selection.items).filter((p) => p.kind === 'face' && (p.object as THREE.Mesh).geometry?.userData.brep)
  active = new EditFacesTool(ctx, faces)
}

const PREVIEW = new THREE.MeshStandardMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })

class EditFacesTool {
  private faces: Pick[] = []
  private distance = 5
  private hl: Highlights
  private hover: Pick | null = null
  private prompt = el('div', 'vp-prompt above-strip')
  private strip = el('div', 'vp-strip editfaces-strip')
  private distBox = el('input')
  private preview: THREE.Mesh | null = null
  private result: THREE.BufferGeometry | null = null
  private runId = 0
  /** Per-vertex move direction for the instant preview (local space), for the current faces. */
  private dirs: { key: string; dir: Float32Array } | null = null
  private timer = 0
  private busy = false
  private off: (() => void)[] = []
  private handles: Handles
  private arrow: ArrowSpec | null = null

  constructor(
    private ctx: ModuleContext,
    start: Pick[]
  ) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    // Faces of one body only: the first one's.
    const body = start[0]?.object
    this.faces = start.filter((p) => p.object === body)
    vp.host.append(this.prompt, this.strip)
    vp.blockPick = () => true
    this.buildStrip()
    this.handles = new Handles(vp)
    this.off.push(() => this.handles.dispose())
    const bar = showCmdBar(vp.host, { ok: () => void this.ok(), cancel: () => this.close() })
    this.off.push(() => bar.dispose())

    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    let queued: PointerEvent | null = null
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || this.handles.dragging || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const p = pickAt(vp, e, { face: true })
      if (p?.kind === 'face') this.toggle(p)
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = queued!
        queued = null
        const h = ev.buttons ? null : pickAt(vp, ev, { face: true })
        if ((h && pickKey(h)) !== (this.hover && pickKey(this.hover))) {
          this.hover = h
          this.draw()
        }
      })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.close()
      else if (e.key === 'Enter') void this.ok()
      else return
      e.preventDefault()
      e.stopPropagation()
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
    this.placeArrow()
    this.draw()
    this.schedule()
    this.distBox.focus()
    this.distBox.select()
  }

  private buildStrip(): void {
    const s = this.strip
    s.addEventListener('pointerdown', (e) => e.stopPropagation())
    s.append(el('b', 'vs-title', 'Edit faces'))
    const g = el('div', 'vs-group')
    g.append(el('span', 'vs-label', 'Distance'))
    this.distBox.type = 'number'
    this.distBox.className = 'vs-angle'
    this.distBox.value = String(this.distance)
    this.distBox.title = 'mm along the face normal: positive pulls out (adds), negative pushes in (removes)'
    this.distBox.addEventListener('input', () => {
      const v = parseFloat(this.distBox.value)
      this.distance = Number.isFinite(v) ? v : 0
      this.placeArrow()
      this.schedule()
    })
    const flip = el('button', 'btn vs-text', 'Flip')
    flip.title = 'Swap out / in'
    flip.addEventListener('click', () => {
      this.distance = -this.distance
      this.distBox.value = String(this.distance)
      this.placeArrow()
      this.schedule()
    })
    g.append(this.distBox, el('span', 'vs-label', 'mm'), flip)
    s.append(g)
  }

  private say(note?: string): void {
    const main = el('span')
    const n = this.faces.length
    main.append(el('b', '', 'Edit faces'), document.createTextNode(n ? `: ${n} face${n === 1 ? '' : 's'}, click faces to add or remove` : ': select the faces to move'))
    this.prompt.replaceChildren(main)
    if (note) this.prompt.append(el('span', 'vp-prompt-note', note))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Enter / tick to apply, Esc to cancel'))
  }

  private toggle(p: Pick): void {
    if (this.faces.length && p.object !== this.faces[0].object) return this.say('Faces must be on the same body.')
    if (!(p.object as THREE.Mesh).geometry.userData.brep) return this.say('That body has no CAD faces (mesh only).')
    const k = pickKey(p)
    const i = this.faces.findIndex((f) => pickKey(f) === k)
    this.faces = i >= 0 ? this.faces.filter((_, j) => j !== i) : [...this.faces, p]
    this.placeArrow()
    this.draw()
    this.schedule()
  }

  /** The drag arrow sits on the first face, pointing out along its normal. */
  private placeArrow(): void {
    const f = this.faces[0]
    if (!f?.normal) {
      if (this.arrow) this.handles.remove(this.arrow)
      this.arrow = null
      return
    }
    if (!this.arrow)
      this.arrow = this.handles.arrow({
        origin: f.point.clone(),
        dir: f.normal.clone(),
        value: this.distance,
        tip: 'Drag to push / pull the faces (Shift: no snap)',
        onDrag: (v) => {
          this.distance = v
          this.distBox.value = fmt(v)
          this.schedule()
        },
        // Exact kernel result once the drag stops.
        onEnd: () => this.schedule()
      })
    this.arrow.origin.copy(f.point)
    this.arrow.dir.copy(f.normal)
    this.arrow.value = this.distance
    this.handles.update()
  }

  private draw(): void {
    const list = this.faces.map((pick) => ({ pick, color: 0xff9f1c }))
    if (this.hover && !this.faces.some((f) => pickKey(f) === pickKey(this.hover!))) list.push({ pick: this.hover, color: 0xfff1a8 })
    this.hl.set(list)
  }

  /** Recompute the preview shortly after the last change. */
  private schedule(): void {
    window.clearTimeout(this.timer)
    this.result = null
    this.runId++
    this.busy = false
    this.say()
    // Instant mesh preview that follows the cursor; the exact solid comes after.
    this.fastPreview()
    if (!this.handles.dragging) this.timer = window.setTimeout(() => void this.compute(), 120)
  }

  /**
   * Quick preview without the kernel: every mesh vertex on a chosen face's
   * outline or inside it moves along that face's normal (side walls stretch
   * with it). Close enough to drag against; the exact result replaces it.
   */
  private fastPreview(): void {
    if (!this.faces.length || !this.distance) return this.clearPreview()
    const mesh = this.faces[0].object as THREE.Mesh
    const geo = mesh.geometry
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const index = geo.index
    const triFace = geo.userData.triFace as Int32Array | undefined
    if (!index || !triFace) return
    const key = this.faces.map(pickKey).sort().join('|')
    if (this.dirs?.key !== key) this.dirs = { key, dir: this.moveDirs(geo, new Set(this.faces.map((f) => f.index))) }
    const dir = this.dirs.dir
    const base = pos.array as ArrayLike<number>
    const out = new Float32Array(base.length)
    const d = this.distance
    for (let i = 0; i < out.length; i++) out[i] = base[i] + dir[i] * d
    let g = this.preview?.userData.fast ? this.preview.geometry : null
    if (!g || (g.getAttribute('position') as THREE.BufferAttribute).count !== pos.count) {
      g = new THREE.BufferGeometry()
      g.setIndex(index)
      if (geo.getAttribute('normal')) g.setAttribute('normal', geo.getAttribute('normal'))
      g.setAttribute('position', new THREE.BufferAttribute(out, 3))
      this.showPreview(g, mesh)
      this.preview!.userData.fast = true
    } else {
      ;(g.getAttribute('position') as THREE.BufferAttribute).copyArray(out).needsUpdate = true
      g.computeBoundingSphere()
      this.ctx.viewport.requestRender()
    }
  }

  private moveDirs(geo: THREE.BufferGeometry, faces: Set<number>): Float32Array {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const index = geo.index!
    const triFace = geo.userData.triFace as Int32Array
    const k = (i: number): string => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`
    // Normals of the chosen faces met at each vertex position.
    const at = new Map<string, THREE.Vector3[]>()
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const faceN = new Map<number, THREE.Vector3>()
    for (let t = 0; t < triFace.length; t++) {
      if (!faces.has(triFace[t])) continue
      a.fromBufferAttribute(pos, index.getX(t * 3))
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1))
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2))
      const n = b.clone().sub(a).cross(c.clone().sub(a))
      const acc = faceN.get(triFace[t]) ?? new THREE.Vector3()
      faceN.set(triFace[t], acc.add(n))
    }
    faceN.forEach((n) => n.normalize())
    for (let t = 0; t < triFace.length; t++) {
      const f = triFace[t]
      if (!faces.has(f)) continue
      for (let j = 0; j < 3; j++) {
        const v = index.getX(t * 3 + j)
        // Flat faces move along the face normal; curved ones along each vertex's own normal.
        const nAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
        const vn = nAttr ? new THREE.Vector3().fromBufferAttribute(nAttr, v) : faceN.get(f)!
        const n = faceN.get(f)!.dot(vn) > 0.999 ? faceN.get(f)! : vn.clone().normalize()
        const list = at.get(k(v)) ?? []
        if (!list.some((m) => m.dot(n) > 0.999)) list.push(n)
        at.set(k(v), list)
      }
    }
    const dir = new Float32Array(pos.count * 3)
    const o = new THREE.Vector3()
    for (let v = 0; v < pos.count; v++) {
      const list = at.get(k(v))
      if (!list) continue
      // Offset that lands on every moved face's plane (corners where two meet).
      o.set(0, 0, 0)
      for (let it = 0; it < 12; it++) for (const n of list) o.addScaledVector(n, 1 - n.dot(o))
      dir[v * 3] = o.x
      dir[v * 3 + 1] = o.y
      dir[v * 3 + 2] = o.z
    }
    return dir
  }

  private showPreview(geo: THREE.BufferGeometry, mesh: THREE.Mesh): void {
    this.clearPreview()
    mesh.updateMatrixWorld()
    this.preview = new THREE.Mesh(geo, PREVIEW)
    this.preview.matrixAutoUpdate = false
    this.preview.matrix.copy(mesh.matrixWorld)
    this.preview.raycast = () => {}
    this.preview.renderOrder = 5
    this.ctx.viewport.scene.add(this.preview)
    this.ctx.viewport.requestRender()
  }

  private async compute(): Promise<THREE.BufferGeometry | null> {
    const id = ++this.runId
    if (!this.faces.length || !this.distance) {
      this.clearPreview()
      return null
    }
    const mesh = this.faces[0].object as THREE.Mesh
    this.busy = true
    this.say('Working…')
    try {
      const bytes = await editFacesCad(mesh.geometry.userData.brep as Uint8Array, [...new Set(this.faces.map((f) => f.index))], this.distance)
      const geo = await solidsGeometry(bytes)
      if (id !== this.runId) return null
      geo.computeBoundingBox()
      this.result = geo
      this.showPreview(geo, mesh)
      this.say(`${this.distance > 0 ? 'Out' : 'In'} ${fmt(Math.abs(this.distance))} mm`)
      this.ctx.viewport.requestRender()
      return geo
    } catch (e) {
      if (id === this.runId) this.say((e as Error).message)
      return null
    } finally {
      if (id === this.runId) this.busy = false
    }
  }

  private clearPreview(): void {
    if (this.preview) this.ctx.viewport.scene.remove(this.preview)
    this.preview = null
    this.ctx.viewport.requestRender()
  }

  private async ok(): Promise<void> {
    if (!this.faces.length) return this.say('Select at least one face.')
    window.clearTimeout(this.timer)
    const geo = this.result ?? (this.busy ? null : await this.compute())
    if (!geo) {
      if (this.busy) this.say('Still working, try again in a moment.')
      return
    }
    const mesh = this.faces[0].object as THREE.Mesh
    const id = mesh.userData.docId as string
    // The edited shape: keep the material and the body's place in the tree.
    const g = geo
    delete g.userData.prim
    this.close()
    selection.clear()
    this.ctx.doc.replaceGeometry(id, g, 'Edit faces of')
    this.ctx.status(`Faces moved ${fmt(this.distance)} mm`, 'success')
  }

  close(): void {
    if (active !== this) return
    active = null
    window.clearTimeout(this.timer)
    this.runId++
    this.off.forEach((f) => f())
    this.clearPreview()
    this.hl.dispose()
    this.prompt.remove()
    this.strip.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.refreshRibbon()
  }
}
